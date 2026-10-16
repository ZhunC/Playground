// Feed builder — produces the ordered list of reel descriptors for the home
// page. Keyless and deterministic: ranking reuses scoreCatalog() against the
// vault tag profile, and new material comes from arXiv searches seeded by that
// same profile. No LLM involved.

import { scoreCatalog } from "./vault.mjs";
import { searchArxiv } from "./arxiv.mjs";

export const FEED = {
  // Pull extra papers from arXiv so the rotation outlasts the 28 curated ones.
  // Set false to restrict the feed to catalog.json.
  ARXIV_DISCOVERY: true,
  // Tags queried per day. Each one costs two requests (recent + all-time).
  QUERIES_PER_DAY: 3,
  RESULTS_PER_QUERY: 12,
  // Split between brand-new work and the canonical papers for a tag.
  // 0.7 => 70% of each tag's results come from the last RECENT_DAYS.
  RECENT_SHARE: 0.7,
  RECENT_DAYS: 30,
  // A niche tag can have nothing at all in 30 days (`mgda` returns zero), so
  // widen the window once before giving up and falling back to all-time
  // classics. Sampled 10 tags: 8 fill the 30-day quota outright.
  RECENT_FALLBACK_DAYS: 180,
  // Discovery results are kept this long, so a paper you scrolled past
  // yesterday is still reachable rather than dropped overnight.
  RETENTION_DAYS: 14,
  MAX_FEED: 60,
  // Each full watch pushes a reel this far down the ranking next time.
  SEEN_PENALTY: 18,
  // Tags that describe the note rather than its subject — useless as queries.
  TAG_STOPWORDS: new Set(["paper", "papers", "note", "notes", "misc", "todo", "wip", "draft", "reading", "study"]),
  MIN_TAG_LEN: 3,
};

export function recentWanted() {
  return Math.max(1, Math.round(FEED.RESULTS_PER_QUERY * FEED.RECENT_SHARE));
}
export function allTimeWanted() {
  return Math.max(1, FEED.RESULTS_PER_QUERY - recentWanted());
}

export function dayKey(now = new Date()) {
  return now.toISOString().slice(0, 10);
}

function dayIndex(now = new Date()) {
  return Math.floor(now.getTime() / 86400000);
}

function hashStr(s) {
  let h = 2166136261;
  for (const c of String(s)) h = (Math.imul(h ^ c.charCodeAt(0), 16777619) >>> 0);
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

// Choose today's query tags. The profile is count-descending, so sampling at a
// stride spanning the whole list means head, middle and long-tail tags all get
// their turn — without this, single-note tags like `thermodynamics` would never
// be queried.
export function pickDiscoveryTags(profile, n = FEED.QUERIES_PER_DAY, now = new Date()) {
  const tags = profile
    .map((p) => p.tag)
    .filter((t) => t.length >= FEED.MIN_TAG_LEN && !FEED.TAG_STOPWORDS.has(t));
  if (!tags.length) return [];
  const count = Math.min(n, tags.length);
  const stride = Math.max(1, Math.floor(tags.length / count));
  const offset = dayIndex(now) * count;
  const out = [];
  for (let i = 0; i < count; i++) {
    const idx = (offset + i * stride) % tags.length;
    const tag = tags[idx];
    if (!out.includes(tag)) out.push(tag);
  }
  return out;
}

// arXiv categories ("cs.RO") never match vault tags, so the tag that found the
// paper is prepended — that is what gives a discovered paper a real match score
// and a "because you wrote" list.
// `window` is derived from the paper's own submission date, not from which
// query found it: the fallback window can return a four-month-old paper, and
// calling that "new this month" would be a lie.
export function windowOf(published, now = new Date()) {
  if (!published) return "all-time";
  const age = (now.getTime() - new Date(published).getTime()) / 86400000;
  return age <= FEED.RECENT_DAYS ? "recent" : "all-time";
}

function entryToItem(entry, tag, now = new Date()) {
  return {
    id: entry.arxivId,
    type: "paper",
    arxivId: entry.arxivId,
    title: entry.title,
    authors: entry.authors,
    year: entry.published ? new Date(entry.published).getFullYear() : null,
    published: entry.published || null,
    tags: [tag, ...entry.categories.slice(0, 3).map((c) => c.toLowerCase())],
    blurb: entry.summary ? entry.summary.slice(0, 400) : "",
    link: `https://arxiv.org/abs/${entry.arxivId}`,
    source: "arxiv",
    foundVia: tag,
    window: windowOf(entry.published, now),
  };
}

/**
 * Query one tag twice: the last RECENT_DAYS newest-first, and all-time
 * relevance-ranked. Shortfalls backfill from the other window, because a niche
 * tag can legitimately have nothing recent at all — `mgda` returns zero papers
 * for a 30-day window — and the feed should not shrink because of that.
 */
async function discoverTag(tag, now) {
  const q = tag.replace(/-/g, " ");
  const out = { recent: [], allTime: [], errors: [] };
  const seen = new Set();
  const take = (entries, n) => {
    const kept = [];
    for (const e of entries) {
      if (kept.length >= n) break;
      if (seen.has(e.arxivId)) continue;
      seen.add(e.arxivId);
      kept.push(e);
    }
    return kept;
  };

  // Newest first, last 30 days.
  try {
    out.recent = take(
      await searchArxiv(q, { max: recentWanted(), sinceDays: FEED.RECENT_DAYS, now }),
      recentWanted()
    );
  } catch (e) {
    out.errors.push(`${tag} (recent): ${e.message}`);
  }

  // Short? Widen the window before resorting to all-time classics.
  let short = recentWanted() - out.recent.length;
  if (short > 0) {
    try {
      out.recent.push(
        ...take(
          await searchArxiv(q, {
            max: short + seen.size,
            sinceDays: FEED.RECENT_FALLBACK_DAYS,
            now,
          }),
          short
        )
      );
    } catch (e) {
      out.errors.push(`${tag} (fallback): ${e.message}`);
    }
    short = recentWanted() - out.recent.length;
  }

  // All-time relevance fills its own share plus anything still missing.
  try {
    const want = allTimeWanted() + Math.max(0, short);
    out.allTime = take(await searchArxiv(q, { max: want + seen.size, now }), want);
  } catch (e) {
    out.errors.push(`${tag} (all-time): ${e.message}`);
  }
  return out;
}

// Fetch today's discovery entries, reusing anything already cached.
// Returns { items, cache } — the caller persists the cache.
export async function discover(profile, cache = {}, now = new Date()) {
  if (!FEED.ARXIV_DISCOVERY) return { items: [], cache, errors: [] };
  const key = dayKey(now);
  const next = pruneCache(cache, now);
  const today = next[key] || (next[key] = {});
  const errors = [];

  for (const tag of pickDiscoveryTags(profile, FEED.QUERIES_PER_DAY, now)) {
    if (today[tag]) continue;
    const got = await discoverTag(tag, now);
    errors.push(...got.errors);
    today[tag] = { recent: got.recent, allTime: got.allTime };
  }

  return { items: itemsFromCache(next), cache: next, errors };
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

// Flatten every retained day into feed items, newest day first.
export function itemsFromCache(cache, now = new Date()) {
  const items = [];
  for (const day of Object.keys(cache || {}).sort().reverse()) {
    for (const [tag, bucket] of Object.entries(cache[day] || {})) {
      // Older cache files stored a bare array before the window split.
      const entries = Array.isArray(bucket)
        ? bucket
        : [...(bucket?.recent || []), ...(bucket?.allTime || [])];
      for (const e of entries) if (e?.arxivId) items.push(entryToItem(e, tag, now));
    }
  }
  return items;
}

// Is today's discovery still outstanding?
export function discoveryComplete(profile, cache, now = new Date()) {
  if (!FEED.ARXIV_DISCOVERY) return true;
  const today = cache?.[dayKey(now)] || {};
  return pickDiscoveryTags(profile, FEED.QUERIES_PER_DAY, now).every((t) => today[t]);
}

// Reorder so neighbouring reels don't share their strongest tag — otherwise a
// single dominant tag like `robotics` produces a monotonous run.
function spaceByTopTag(items) {
  const out = [];
  const held = [];
  const topTag = (i) => i.matchedTags?.[0] || i.tags?.[0] || "";
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
 * Hold the discovered papers to the RECENT_SHARE split while keeping each
 * group's own ranking. Fetching 70/30 is not enough on its own: ranking mixes
 * the two groups back together and the recency bonus would let old canonical
 * papers dominate, so the ratio is enforced again here on what actually gets
 * shown. Curated catalog papers sit outside the quota — they are always
 * eligible — and a group that runs out simply yields its slots.
 */
export function applyWindowQuota(ranked, share = FEED.RECENT_SHARE) {
  const recent = ranked.filter((i) => i.source === "arxiv" && i.window === "recent");
  const older = ranked.filter((i) => i.source === "arxiv" && i.window !== "recent");
  if (!recent.length || !older.length) return ranked;

  let r = 0, o = 0, slot = 0;
  return ranked.map((item) => {
    if (item.source !== "arxiv") return item; // curated keeps its ranked place
    slot++;
    // Emit an older paper whenever we are behind the running quota for it.
    const owedOld = Math.round(slot * (1 - share)) > o;
    if ((owedOld || r >= recent.length) && o < older.length) return older[o++];
    return recent[r++] ?? older[o++];
  });
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
    : { items: itemsFromCache(cache), cache, errors: [] };

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

  const scored = scoreCatalog([...byId.values()], library, profile).filter(
    (i) => !i.owned && !finishedIds.has(i.id)
  );

  const yearNow = now.getFullYear();
  const rand = mulberry32(hashStr(dayKey(now)));
  const ranked = scored
    .map((item) => {
      const s = seen[item.id] || { count: 0 };
      const recency = item.year ? Math.max(0, 8 - (yearNow - item.year)) : 0;
      const base = item.match + recency - FEED.SEEN_PENALTY * (s.count || 0);
      return {
        ...item,
        seenCount: s.count || 0,
        lastSeenAt: s.lastSeenAt || null,
        // Jitter keeps the order fresh without letting a weak paper lead.
        _rank: Math.max(1, base) * (0.6 + 0.8 * rand()),
      };
    })
    .sort((a, b) => b._rank - a._rank);

  // Unseen material always leads; seen reels come back least-recently-first.
  const unseen = ranked.filter((i) => !i.seenCount);
  const seenAgain = ranked
    .filter((i) => i.seenCount)
    .sort((a, b) => String(a.lastSeenAt).localeCompare(String(b.lastSeenAt)));

  const feed = spaceByTopTag(applyWindowQuota([...unseen, ...seenAgain]))
    .slice(0, FEED.MAX_FEED)
    .map(({ _rank, ...item }) => item);

  // The realized split can fall short of RECENT_SHARE when a tag has little or
  // nothing recent; reported so it is visible rather than guessed at.
  const arxiv = feed.filter((i) => i.source === "arxiv");
  const recent = arxiv.filter((i) => i.window === "recent").length;
  const mix = {
    total: feed.length,
    curated: feed.length - arxiv.length,
    discovered: arxiv.length,
    recent,
    allTime: arxiv.length - recent,
    recentShare: arxiv.length ? Math.round((recent / arxiv.length) * 100) : null,
    targetShare: Math.round(FEED.RECENT_SHARE * 100),
    recentDays: FEED.RECENT_DAYS,
  };

  return { feed, cache: nextCache, errors, mix, discovery: FEED.ARXIV_DISCOVERY };
}
