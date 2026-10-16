// Feed builder — produces the ordered list of reel descriptors for the home
// page. Keyless and deterministic.
//
// New material comes from arXiv's daily category listings, the API equivalent
// of the arXiv digest emails: every subscribed category is listed every day,
// newest first, with no relevance filtering. Vault tags are no longer used to
// find papers — categories are far wider in scope — but the curated catalog is
// still scored against the vault, which is what keeps the older half personal.

import { scoreCatalog } from "./vault.mjs";
import { fetchCategoryListing } from "./arxiv.mjs";

export const FEED = {
  // Pull papers from arXiv so the rotation outlasts the 28 curated ones.
  // Set false to restrict the feed to catalog.json.
  ARXIV_DISCOVERY: true,

  // The digest subscription: every category is listed every day, as an email
  // digest would. 14 categories at one request each, spaced 3s, is ~42s of
  // background work.
  DIGEST_CATEGORIES: [
    "cs.RO", "eess.SY", "math.OC", "math.DS", // robotics & control
    "cs.LG", "cs.CV", "cs.AI", "stat.ML", // machine learning & vision
    "eess.SP", "eess.IV", "cs.AR", // signal processing & hardware
    "physics.flu-dyn", "cond-mat.stat-mech", "physics.app-ph", // thermo & fluids
  ],

  // Dropped even when cross-listed into a subscribed category. Philosophy and
  // history-of-science papers cross-list into cond-mat.stat-mech constantly,
  // which is how they would otherwise reach a thermodynamics subscription.
  EXCLUDE_CATEGORIES: new Set(["physics.hist-ph", "math.HO", "physics.soc-ph"]),

  // Categories listed per day, rotating. Listing all 14 daily tripped arXiv's
  // traffic guard; 5 a day covers the whole subscription every three days,
  // which is well inside the 14-day retention, so nothing is missed.
  CATEGORIES_PER_DAY: 5,
  RESULTS_PER_CATEGORY: 8,
  // Window for a listing request. Wider than a literal daily email so a feed
  // built on a quiet Monday still fills.
  DIGEST_DAYS: 30,

  // Age tiers, used for the badge and for the recent/classic mix.
  RECENT_DAYS: 30,
  YEAR_DAYS: 365,
  // Share of feed slots given to recent-tier papers; the rest go to the
  // curated classics.
  RECENT_SHARE: 0.7,

  // Listings are kept this long, so a paper you scrolled past yesterday is
  // still reachable rather than dropped overnight.
  RETENTION_DAYS: 14,
  MAX_FEED: 60,
  // Each full watch pushes a reel this far down the ranking next time.
  SEEN_PENALTY: 18,
};

// Shown in place of "because you wrote" on a discovered paper's closer beat.
// Unlisted codes fall back to the raw category.
export const CATEGORY_LABELS = {
  "cs.RO": "Robotics",
  "eess.SY": "Systems & Control",
  "math.OC": "Optimization & Control",
  "math.DS": "Dynamical Systems",
  "cs.LG": "Machine Learning",
  "cs.CV": "Computer Vision",
  "cs.AI": "Artificial Intelligence",
  "stat.ML": "Statistics · Machine Learning",
  "eess.SP": "Signal Processing",
  "eess.IV": "Image & Video Processing",
  "cs.AR": "Hardware Architecture",
  "physics.flu-dyn": "Fluid Dynamics",
  "cond-mat.stat-mech": "Statistical Mechanics",
  "physics.app-ph": "Applied Physics",
  "cs.CL": "Computation & Language",
  "cs.NE": "Neural & Evolutionary Computing",
  "math.NA": "Numerical Analysis",
  "math.PR": "Probability",
  "cs.SY": "Systems & Control",
  "cs.MA": "Multiagent Systems",
  "cs.CE": "Computational Engineering",
};

export function categoryLabel(code) {
  return CATEGORY_LABELS[code] || code;
}

export function dayKey(now = new Date()) {
  return now.toISOString().slice(0, 10);
}

function dayIndex(now = new Date()) {
  return Math.floor(now.getTime() / 86400000);
}

/**
 * Today's slice of the subscription. Contiguous blocks that advance each day,
 * so three consecutive days cover all 14 categories and no category can be
 * starved by a rotation that keeps landing on the same offset.
 */
export function pickCategories(now = new Date()) {
  const cats = FEED.DIGEST_CATEGORIES;
  const n = Math.min(FEED.CATEGORIES_PER_DAY, cats.length);
  const start = (dayIndex(now) * n) % cats.length;
  return Array.from({ length: n }, (_, i) => cats[(start + i) % cats.length]);
}

function hashStr(s) {
  let h = 2166136261;
  for (const c of String(s)) h = Math.imul(h ^ c.charCodeAt(0), 16777619) >>> 0;
  return h >>> 0;
}

// Small seeded PRNG so a day's ordering is stable across reloads.
function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Age tier from the paper's own submission date — never from which request
 * found it. Retention means a paper fetched inside the 30-day window is still
 * in the cache two weeks later, by which point it is no longer "new".
 */
export function ageTier(published, now = new Date()) {
  if (!published) return "classic";
  const age = (now.getTime() - new Date(published).getTime()) / 86400000;
  if (age <= FEED.RECENT_DAYS) return "recent";
  if (age <= FEED.YEAR_DAYS) return "year";
  return "classic";
}

export const TIER_LABELS = {
  recent: "new this month",
  year: "this year",
  classic: "classic",
};

// A paper is excluded if any of its categories is on the blocklist, not just
// its primary one: philosophy papers reach a physics subscription by
// cross-listing, so the primary category alone would not catch them.
export function isExcluded(categories) {
  return (categories || []).some((c) => FEED.EXCLUDE_CATEGORIES.has(c));
}

/**
 * Put subscribed categories first. A paper returned by the cs.RO listing often
 * has a different primary category, and leading with that would show
 * "Computation & Language" on a paper that is in the feed because it is
 * cross-listed into robotics. arXiv's own order is kept within each group.
 */
export function orderCategories(cats) {
  const subscribed = new Set(FEED.DIGEST_CATEGORIES);
  return [
    ...(cats || []).filter((c) => subscribed.has(c)),
    ...(cats || []).filter((c) => !subscribed.has(c)),
  ];
}

function entryToItem(entry, now = new Date()) {
  const cats = orderCategories(entry.categories);
  const year = entry.published ? new Date(entry.published).getFullYear() : null;
  return {
    id: entry.arxivId,
    type: "paper",
    arxivId: entry.arxivId,
    title: entry.title,
    authors: entry.authors,
    year,
    published: entry.published || null,
    // arXiv categories, not vault tags. These never match the vault profile,
    // so a discovered paper carries no match% — by design, since the feed no
    // longer claims relevance it has not measured.
    categories: cats,
    categoryLabels: cats.slice(0, 3).map(categoryLabel),
    tags: cats.map((c) => c.toLowerCase()),
    blurb: entry.summary ? entry.summary.slice(0, 400) : "",
    link: `https://arxiv.org/abs/${entry.arxivId}`,
    source: "arxiv",
    tier: ageTier(entry.published, now),
  };
}

/**
 * Fetch today's listings for every subscribed category, reusing anything
 * already cached. Returns { items, cache } — the caller persists the cache.
 */
export async function discover(profile, cache = {}, now = new Date()) {
  if (!FEED.ARXIV_DISCOVERY) return { items: [], cache, errors: [] };
  const key = dayKey(now);
  const next = pruneCache(cache, now);
  const today = next[key] || (next[key] = {});
  const errors = [];

  for (const cat of pickCategories(now)) {
    if (today[cat]) continue;
    try {
      const entries = await fetchCategoryListing(cat, {
        max: FEED.RESULTS_PER_CATEGORY,
        days: FEED.DIGEST_DAYS,
        now,
      });
      const kept = entries.filter((e) => !isExcluded(e.categories));
      today[cat] = kept;
      console.log(`  digest ${cat}: ${kept.length} papers` +
        (entries.length - kept.length ? ` (${entries.length - kept.length} excluded)` : ""));
    } catch (e) {
      errors.push(`${cat}: ${e.message}`);
      // Still rate-limited after the backoff ladder: the remaining categories
      // would each pay the same penalty, so stop and keep what we have. The
      // partial day is cached, so the next attempt resumes where this left off.
      if (/\b(429|503)\b/.test(e.message)) {
        errors.push(`sweep aborted at ${cat}: arXiv unavailable — resumes on next load`);
        break;
      }
    }
  }

  return { items: itemsFromCache(next, now), cache: next, errors };
}

// Drop buckets older than RETENTION_DAYS so the file stays bounded.
function pruneCache(cache, now) {
  const cutoff = dayKey(new Date(now.getTime() - FEED.RETENTION_DAYS * 86400000));
  const out = {};
  for (const [day, bucket] of Object.entries(cache || {})) {
    if (day >= cutoff) out[day] = bucket;
  }
  return out;
}

/**
 * Flatten every retained day into feed items, newest day first.
 *
 * The bucket key is ignored: it is a category now but was a vault tag in
 * caches written before this change, and provenance is read off the entry's
 * own `categories` either way. Both bucket shapes are accepted so an existing
 * cache file keeps working instead of being silently dropped.
 */
export function itemsFromCache(cache, now = new Date()) {
  const items = [];
  const seen = new Set();
  for (const day of Object.keys(cache || {}).sort().reverse()) {
    for (const bucket of Object.values(cache[day] || {})) {
      const entries = Array.isArray(bucket)
        ? bucket
        : [...(bucket?.recent || []), ...(bucket?.allTime || [])];
      for (const e of entries) {
        if (!e?.arxivId || seen.has(e.arxivId)) continue;
        if (isExcluded(e.categories)) continue;
        seen.add(e.arxivId);
        items.push(entryToItem(e, now));
      }
    }
  }
  return items;
}

// Is today's discovery still outstanding?
export function discoveryComplete(profile, cache, now = new Date()) {
  if (!FEED.ARXIV_DISCOVERY) return true;
  const today = cache?.[dayKey(now)] || {};
  return pickCategories(now).every((c) => today[c]);
}

// Reorder so neighbouring reels don't share their leading category — otherwise
// a high-volume category like cs.LG produces a monotonous run.
function spaceByTopTag(items) {
  const out = [];
  const held = [];
  const topTag = (i) => i.categories?.[0] || i.matchedTags?.[0] || i.tags?.[0] || "";
  for (const item of items) {
    if (out.length && topTag(out[out.length - 1]) === topTag(item)) {
      held.push(item);
      continue;
    }
    out.push(item);
    // Re-admit the earliest held item that no longer clashes.
    for (let k = 0; k < held.length; k++) {
      if (topTag(held[k]) !== topTag(out[out.length - 1])) {
        out.push(held.splice(k, 1)[0]);
        break;
      }
    }
  }
  return out.concat(held);
}

/**
 * Interleave the fresh digest with the older curated papers at RECENT_SHARE.
 * Each pool keeps its own ordering; a pool that runs out yields its slots.
 */
export function interleaveByShare(fresh, older, share = FEED.RECENT_SHARE) {
  const out = [];
  let f = 0;
  let o = 0;
  while (f < fresh.length || o < older.length) {
    // Emit an older paper whenever we are behind its running quota.
    const owedOld = Math.round((out.length + 1) * (1 - share)) > o;
    if ((owedOld || f >= fresh.length) && o < older.length) out.push(older[o++]);
    else if (f < fresh.length) out.push(fresh[f++]);
    else out.push(older[o++]);
  }
  return out;
}

/**
 * Build the feed.
 * @param catalog   raw catalog.json
 * @param library   vault notes (from buildLibrary)
 * @param profile   tag profile (from buildProfile)
 * @param finished  array of finished items ({id}) — excluded from the feed
 * @param seen      { [reelId]: { count, lastSeenAt } }
 * @param cache     discovery cache (persisted by the caller)
 */
export async function buildFeed({
  catalog = [],
  library = [],
  profile = [],
  finished = [],
  seen = {},
  cache = {},
  now = new Date(),
  // false => build from the cache alone and make no network calls, so the page
  // can render immediately while discovery runs in the background.
  fetchNew = true,
} = {}) {
  const { items: discovered, cache: nextCache, errors } = fetchNew
    ? await discover(profile, cache, now)
    : { items: itemsFromCache(cache, now), cache, errors: [] };

  const finishedIds = new Set(finished.map((f) => f.id));
  const byId = new Map();
  // Catalog papers first so their curated blurbs win over an arXiv abstract.
  for (const item of catalog) {
    if (item.type !== "paper" || !item.arxivId) continue;
    byId.set(item.arxivId, { ...item, source: "catalog" });
  }
  for (const item of discovered) {
    if (!byId.has(item.arxivId)) byId.set(item.arxivId, item);
  }

  const scored = scoreCatalog([...byId.values()], library, profile)
    .filter((i) => !i.owned && !finishedIds.has(i.id))
    .map((item) => ({
      ...item,
      // Catalog entries have no `published`; their year is enough to tier them.
      tier: item.tier || ageTier(item.year ? `${item.year}-07-01` : null, now),
    }));

  const rand = mulberry32(hashStr(dayKey(now)));
  const withSeen = scored.map((item) => {
    const s = seen[item.id] || { count: 0 };
    return { ...item, seenCount: s.count || 0, lastSeenAt: s.lastSeenAt || null };
  });

  const unseen = withSeen.filter((i) => !i.seenCount);
  const seenAgain = withSeen
    .filter((i) => i.seenCount)
    .sort((a, b) => String(a.lastSeenAt).localeCompare(String(b.lastSeenAt)));

  // Discovered papers are shown as a digest: strictly newest first, no
  // relevance cut. Curated papers keep a match-weighted order, jittered by a
  // date seed so the classics rotate day to day.
  const byDate = (a, b) => String(b.published || "").localeCompare(String(a.published || ""));
  const fresh = unseen.filter((i) => i.source === "arxiv" && i.tier === "recent").sort(byDate);
  const curated = unseen
    .filter((i) => i.source === "catalog")
    .map((i) => ({ ...i, _rank: Math.max(1, i.match) * (0.6 + 0.8 * rand()) }))
    .sort((a, b) => b._rank - a._rank);
  // Discovered papers that have aged past "recent" while sitting in the cache.
  const aged = unseen
    .filter((i) => i.source === "arxiv" && i.tier !== "recent")
    .sort(byDate);

  const feed = spaceByTopTag(interleaveByShare(fresh, [...curated, ...aged]))
    .concat(seenAgain)
    .slice(0, FEED.MAX_FEED)
    .map(({ _rank, ...item }) => item);

  const tiers = { recent: 0, year: 0, classic: 0 };
  for (const i of feed) tiers[i.tier] = (tiers[i.tier] || 0) + 1;
  const arxiv = feed.filter((i) => i.source === "arxiv").length;
  const mix = {
    total: feed.length,
    curated: feed.length - arxiv,
    discovered: arxiv,
    ...tiers,
    recentShare: feed.length ? Math.round((tiers.recent / feed.length) * 100) : null,
    targetShare: Math.round(FEED.RECENT_SHARE * 100),
    recentDays: FEED.RECENT_DAYS,
    categories: FEED.DIGEST_CATEGORIES.length,
  };

  return { feed, cache: nextCache, errors, mix, discovery: FEED.ARXIV_DISCOVERY };
}
