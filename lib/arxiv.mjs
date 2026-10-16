// arXiv access — Atom parsing + search, extracted from server.mjs so the feed
// builder can call it without going through HTTP.

export const UA = "studydeck/1.0 (personal study app)";
export const ARXIV_SEARCH_MAX = 15;

// arXiv asks for <= 1 request every 3s. We use 6s: their guard is stricter in
// practice than the documented figure, and a sustained 429/503 block costs far
// more than a slower sweep. Nothing here is latency-sensitive — discovery runs
// in the background and the page renders from cache.
const MIN_GAP_MS = 6000;
// The gap is per-process, so anything else querying arXiv at the same time can
// still earn a 429 ("Rate exceeded.", a 14-byte body — not valid Atom, so it
// would otherwise parse as zero results and look like an empty category).
// Observed to outlast several minutes, hence the long backoff.
// Bounded on purpose: a long ladder here multiplies by the number of
// categories in a sweep, so a rate-limited sweep would grind for an hour.
// Give up quickly and let the next page load retry.
const RETRY_BACKOFF = [20000, 60000];
// 429 is the documented rate limit; 503 is what arXiv actually serves when it
// sheds load or extends a block, and its body is HTML, not Atom.
const RETRY_STATUS = new Set([429, 503]);
let lastCall = 0;
let chain = Promise.resolve();

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function politeFetch(url) {
  const run = async () => {
    for (let attempt = 0; ; attempt++) {
      const wait = MIN_GAP_MS - (Date.now() - lastCall);
      if (wait > 0) await sleep(wait);
      lastCall = Date.now();
      const r = await fetch(url, { headers: { "User-Agent": UA } });
      if (!RETRY_STATUS.has(r.status) || attempt >= RETRY_BACKOFF.length) return r;
      await sleep(RETRY_BACKOFF[attempt]);
    }
  };
  // Serialized: a backoff correctly stalls every queued call behind it.
  chain = chain.then(run, run);
  return chain;
}

// Only characters that can legitimately appear in an arXiv id.
export function cleanArxivId(id) {
  return String(id ?? "").replace(/[^0-9a-zA-Z.\/v_-]/g, "");
}

export function parseArxivAtom(xml) {
  const entry = xml.match(/<entry>([\s\S]*?)<\/entry>/);
  if (!entry) return null;
  const e = entry[1];
  const grab = (tag) => {
    const m = e.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`));
    return m ? m[1].replace(/\s+/g, " ").trim() : null;
  };
  const authors = [...e.matchAll(/<author>\s*<name>([\s\S]*?)<\/name>/g)].map((m) => m[1].trim());
  const cats = [...e.matchAll(/<category[^>]*term="([^"]+)"/g)].map((m) => m[1]);
  return {
    title: grab("title"),
    summary: grab("summary"),
    published: grab("published"),
    authors,
    categories: cats,
  };
}

// Parse every <entry> in an arXiv Atom feed (search results can hold many).
export function parseArxivFeed(xml) {
  const entries = [...xml.matchAll(/<entry>([\s\S]*?)<\/entry>/g)];
  return entries.map(([, e]) => {
    const grab = (tag) => {
      const m = e.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`));
      return m ? m[1].replace(/\s+/g, " ").trim() : null;
    };
    const idUrl = grab("id") || "";
    const arxivId = (idUrl.match(/abs\/([^v]+)/) || [])[1] || null;
    const authors = [...e.matchAll(/<author>\s*<name>([\s\S]*?)<\/name>/g)].map((m) => m[1].trim());
    const cats = [...e.matchAll(/<category[^>]*term="([^"]+)"/g)].map((m) => m[1]);
    return {
      arxivId,
      title: grab("title"),
      summary: grab("summary"),
      published: grab("published"),
      authors,
      categories: cats,
    };
  });
}

// https, not http: export.arxiv.org answers http with a 301, which fetch
// follows silently but at the cost of a wasted round trip per query.
const API = "https://export.arxiv.org/api/query";

export async function fetchArxivMeta(id) {
  const r = await politeFetch(`${API}?id_list=${cleanArxivId(id)}`);
  return parseArxivAtom(await r.text());
}

export async function fetchArxivPdf(id) {
  return politeFetch(`https://arxiv.org/pdf/${cleanArxivId(id)}`);
}

// arXiv's submittedDate filter wants YYYYMMDDHHMM.
export function arxivDateStamp(d) {
  const p = (n, w = 2) => String(n).padStart(w, "0");
  return (
    `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}` +
    `${p(d.getUTCHours())}${p(d.getUTCMinutes())}`
  );
}

/**
 * Raw entries for a free-text query.
 *
 * Default is all-time, relevance-ranked — the canonical papers for a term,
 * which are stable over time. Pass `sinceDays` to restrict to recent
 * submissions instead, which switches the sort to newest-first; that is the
 * only way to surface work that did not exist last time you asked.
 */
export async function searchArxiv(query, { max = ARXIV_SEARCH_MAX, sinceDays = null, now = new Date() } = {}) {
  const q = String(query || "").trim();
  if (!q) return [];
  let search = `all:"${q}"`;
  let sortBy = "relevance";
  if (sinceDays) {
    search += ` AND ${submittedWithin(sinceDays, now)}`;
    sortBy = "submittedDate";
  }
  return runQuery(search, { max, sortBy });
}

// `submittedDate:[A TO B]`, the only filter arXiv offers for "new since".
export function submittedWithin(days, now = new Date()) {
  const from = new Date(now.getTime() - days * 86400000);
  return `submittedDate:[${arxivDateStamp(from)} TO ${arxivDateStamp(now)}]`;
}

/**
 * One category's recent submissions, newest first — the API equivalent of an
 * arXiv daily-listing email for that category.
 *
 * The parentheses around the category clause are load-bearing. arXiv binds AND
 * tighter than OR, so `cat:a OR cat:b AND submittedDate:[...]` applies the date
 * window to the `cat:b` term alone: measured 448 results instead of 9. Any
 * OR-ed clause must be wrapped before being AND-ed with the window.
 */
export async function fetchCategoryListing(categories, { max = 10, days = 30, now = new Date() } = {}) {
  const cats = (Array.isArray(categories) ? categories : [categories]).filter(Boolean);
  if (!cats.length) return [];
  const clause = cats.length === 1 ? `cat:${cats[0]}` : `(${cats.map((c) => `cat:${c}`).join(" OR ")})`;
  const search = `${clause} AND ${submittedWithin(days, now)}`;
  return runQuery(search, { max, sortBy: "submittedDate" });
}

async function runQuery(search, { max, sortBy }) {
  const url =
    `${API}?search_query=${encodeURIComponent(search)}` +
    `&start=0&max_results=${max}&sortBy=${sortBy}&sortOrder=descending`;
  const r = await politeFetch(url);
  if (!r.ok) throw new Error(`arxiv search ${r.status}`);
  return parseArxivFeed(await r.text()).filter((e) => e.arxivId);
}

export function slug(s) {
  return String(s)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

// Papers + researchers for the search box. Researchers are derived from the
// authors of matching papers (arXiv has no standalone author index).
export async function searchPapersAndAuthors(query) {
  const q = String(query || "").trim();
  if (!q) return { papers: [], authors: [] };
  const entries = await searchArxiv(q);

  const papers = entries.map((e) => ({
    id: e.arxivId,
    type: "paper",
    arxivId: e.arxivId,
    title: e.title,
    authors: e.authors,
    year: e.published ? new Date(e.published).getFullYear() : null,
    tags: e.categories.slice(0, 4).map((c) => c.toLowerCase()),
    blurb: e.summary ? e.summary.slice(0, 260) : "",
    link: `https://arxiv.org/abs/${e.arxivId}`,
  }));

  const qLower = q.toLowerCase();
  const seen = new Set();
  const authors = [];
  for (const e of entries) {
    for (const a of e.authors) {
      const key = a.toLowerCase();
      if (!key.includes(qLower) || seen.has(key)) continue;
      seen.add(key);
      authors.push({
        id: "author-" + slug(a),
        type: "author",
        title: a,
        affiliation: "",
        tags: e.categories.slice(0, 4).map((c) => c.toLowerCase()),
        blurb: `Author of "${e.title}" and other papers matching "${q}".`,
        link: `https://scholar.google.com/scholar?q=${encodeURIComponent(a)}`,
      });
    }
  }
  return { papers, authors: authors.slice(0, 8) };
}
