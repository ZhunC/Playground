// Shared frontend state + primitives.
// Lives in its own module so app.js (store/library/search) and reel.js (feed)
// can both use them without importing each other.

export const VAULT_NAME = "ZhunCollection";

export const state = {
  library: [],
  profile: [],
  catalog: [],
  wishlist: [],
  reading: [],
  read: [], // "finished" archive
  feed: [],
  activeTags: new Set(),
  view: "feed",
  prevView: "feed",
  searchQuery: "",
  searchResults: null, // { papers, authors }
};

const FALLBACK_COLORS = [
  "#2f4a6b", "#3d3a6b", "#4a3560", "#2f5c4a",
  "#5c4a2f", "#4a2f3d", "#35505c", "#503a2f", "#2f5c5c",
];

export const $ = (s, r = document) => r.querySelector(s);

// ---------------------------------------------------------------------------
// DOM / text
// ---------------------------------------------------------------------------
export function el(tag, cls, html) {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (html != null) n.innerHTML = html;
  return n;
}
export function esc(s) {
  return String(s ?? "").replace(/[&<>"]/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c])
  );
}
// [[Note]] and [[Note|alias]] -> styled span
export function wikilinks(s) {
  return esc(s).replace(/\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/g, (_, a, b) =>
    `<span class="wl">${esc(b || a)}</span>`
  );
}
export function colorFor(id) {
  let h = 0;
  for (const c of String(id)) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return FALLBACK_COLORS[h % FALLBACK_COLORS.length];
}
export function obsidianURI(p) {
  return `obsidian://open?vault=${encodeURIComponent(VAULT_NAME)}&file=${encodeURIComponent(p)}`;
}
export function typeLabel(t) {
  return { paper: "paper", topic: "topic", author: "researcher", lab: "lab" }[t] || t;
}
export function trunc(s, n) {
  return s && s.length > n ? s.slice(0, n - 1) + "…" : s;
}
export function clamp(v, lo, hi) {
  return Math.min(hi, Math.max(lo, v));
}

// ---------------------------------------------------------------------------
// collection membership
// ---------------------------------------------------------------------------
export function inWishlist(id) { return state.wishlist.some((w) => w.id === id); }
export function inReading(id) { return state.reading.some((r) => r.id === id); }
export function isFinished(id) { return state.read.some((r) => r.id === id); }

export function toItem(item) {
  return {
    id: item.id, type: item.type, title: item.title,
    arxivId: item.arxivId || null, link: item.link || null, tags: item.tags || [],
  };
}

export async function post(url, body) {
  const r = await fetch(url, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return r.json();
}

// ---------------------------------------------------------------------------
// PDF work queue — rendering a PDF page is heavy, so never run more than three
// at once. Cover art, reel building and reel prefetch all share this queue.
// ---------------------------------------------------------------------------
let active = 0;
const queue = [];
export function scheduleRender(fn) {
  return new Promise((resolve, reject) => {
    queue.push({ fn, resolve, reject });
    pump();
  });
}
function pump() {
  while (active < 3 && queue.length) {
    const { fn, resolve, reject } = queue.shift();
    active++;
    Promise.resolve()
      .then(fn)
      .then(resolve, reject)
      .finally(() => {
        active--;
        pump();
      });
  }
}
