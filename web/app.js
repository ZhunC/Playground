// studydeck frontend — vanilla ESM.

import * as pdfjsLib from "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/4.0.379/pdf.min.mjs";
pdfjsLib.GlobalWorkerOptions.workerSrc =
  "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/4.0.379/pdf.worker.min.mjs";

const VAULT_NAME = "ZhunCollection";

const state = {
  library: [],
  profile: [],
  catalog: [],
  wishlist: [],
  reading: [],
  read: [], // "finished" archive
  activeTags: new Set(),
  view: "store",
  prevView: "store",
  searchQuery: "",
  searchResults: null, // { papers, authors }
};

const coverCache = new Map(); // id -> dataURL
const FALLBACK_COLORS = [
  "#2f4a6b", "#3d3a6b", "#4a3560", "#2f5c4a",
  "#5c4a2f", "#4a2f3d", "#35505c", "#503a2f", "#2f5c5c",
];

const $ = (s, r = document) => r.querySelector(s);
const main = $("#main");

// ---------------------------------------------------------------------------
// utils
// ---------------------------------------------------------------------------
function el(tag, cls, html) {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (html != null) n.innerHTML = html;
  return n;
}
function esc(s) {
  return String(s ?? "").replace(/[&<>"]/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c])
  );
}
// [[Note]] and [[Note|alias]] -> styled span
function wikilinks(s) {
  return esc(s).replace(/\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/g, (_, a, b) =>
    `<span class="wl">${esc(b || a)}</span>`
  );
}
function colorFor(id) {
  let h = 0;
  for (const c of String(id)) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return FALLBACK_COLORS[h % FALLBACK_COLORS.length];
}
function obsidianURI(path) {
  return `obsidian://open?vault=${encodeURIComponent(VAULT_NAME)}&file=${encodeURIComponent(path)}`;
}
function inWishlist(id) { return state.wishlist.some((w) => w.id === id); }
function inReading(id) { return state.reading.some((r) => r.id === id); }
function isFinished(id) { return state.read.some((r) => r.id === id); }
function typeLabel(t) { return { paper: "paper", topic: "topic", author: "researcher", lab: "lab" }[t] || t; }

// ---------------------------------------------------------------------------
// cover rendering (PDF page 1 for papers, monogram capsule otherwise)
// ---------------------------------------------------------------------------
const io = new IntersectionObserver(
  (entries) => {
    for (const e of entries) {
      if (e.isIntersecting) {
        io.unobserve(e.target);
        renderCover(e.target);
      }
    }
  },
  { rootMargin: "250px" }
);

let active = 0;
const queueRender = [];
function scheduleRender(fn) {
  queueRender.push(fn);
  pump();
}
function pump() {
  while (active < 3 && queueRender.length) {
    const fn = queueRender.shift();
    active++;
    fn().finally(() => {
      active--;
      pump();
    });
  }
}

function buildCap(item, opts = {}) {
  const cap = el("div", "cap");
  const bg = item.accent || colorFor(item.id);
  const monogram = (item.title || "?").trim()[0] || "?";
  const fb = el("div", "cap-fallback");
  fb.style.background = bg;
  fb.innerHTML =
    `<span class="ficon">${esc(monogram)}</span>` +
    `<span class="ftitle">${esc(item.title || "")}</span>`;
  cap.appendChild(fb);

  if (opts.showType !== false) {
    cap.appendChild(el("span", "cap-type", typeLabel(item.type)));
  }
  if (opts.showMatch !== false && typeof item.match === "number") {
    const m = el("span", "cap-match" + (item.newLane ? " lane" : ""), item.match + "%");
    cap.appendChild(m);
  }
  if (opts.wishFlag) {
    if (isFinished(item.id)) cap.appendChild(el("span", "cap-wish-flag cap-finished", "✓"));
    else if (inReading(item.id)) cap.appendChild(el("span", "cap-wish-flag cap-reading", "▶"));
    else if (inWishlist(item.id)) cap.appendChild(el("span", "cap-wish-flag", "★"));
  }

  if (item.photo) {
    // researchers & labs: use their real photo instead of a monogram capsule.
    applyCover(cap, item.photo);
  } else if (item.arxivId) {
    cap.dataset.id = item.id;
    cap.dataset.arxiv = item.arxivId;
    if (opts.eager) scheduleRender(() => renderCover(cap));
    else io.observe(cap);
  }
  return cap;
}

async function renderCover(cap) {
  const id = cap.dataset.id;
  const arxiv = cap.dataset.arxiv;
  if (!arxiv) return;
  if (coverCache.has(id)) return applyCover(cap, coverCache.get(id));
  await new Promise((res) =>
    scheduleRenderInline(async () => {
      try {
        const doc = await pdfjsLib.getDocument({ url: `/pdf?id=${encodeURIComponent(arxiv)}` }).promise;
        const url = await renderFigureSnippet(doc);
        coverCache.set(id, url);
        applyCover(cap, url);
      } catch (_) {
        /* keep monogram fallback */
      } finally {
        res();
      }
    })
  );
}
// small wrapper so both IO and eager paths share the concurrency pump
function scheduleRenderInline(fn) { scheduleRender(fn); }

// Cover art = figure 1 (best-effort) or a cropped snippet of the cover page —
// never the whole page shrunk to fit the capsule.
async function renderFigureSnippet(doc) {
  for (const pageNum of [1, 2]) {
    if (pageNum > doc.numPages) break;
    const page = await doc.getPage(pageNum);
    const region = await findLargestImageRegion(page);
    if (region) {
      const url = await renderCroppedRegion(page, region);
      if (url) return url;
    }
  }
  return renderPageSnippet(await doc.getPage(1));
}

// Walk page 1/2's operator list, tracking the CTM through save/restore/
// transform, and return the page-space bounding box of the largest painted
// image — a stand-in for "figure 1" without needing to parse PDF structure.
async function findLargestImageRegion(page) {
  const opList = await page.getOperatorList();
  const OPS = pdfjsLib.OPS;
  const viewport = page.getViewport({ scale: 1 });
  const pageArea = viewport.width * viewport.height;
  const stack = [];
  let ctm = [1, 0, 0, 1, 0, 0];
  const mul = (a, b) => [
    a[0] * b[0] + a[2] * b[1], a[1] * b[0] + a[3] * b[1],
    a[0] * b[2] + a[2] * b[3], a[1] * b[2] + a[3] * b[3],
    a[0] * b[4] + a[2] * b[5] + a[4], a[1] * b[4] + a[3] * b[5] + a[5],
  ];
  const paintOps = new Set([OPS.paintImageXObject, OPS.paintJpegXObject]);
  let best = null;
  for (let i = 0; i < opList.fnArray.length; i++) {
    const fn = opList.fnArray[i];
    if (fn === OPS.save) stack.push(ctm);
    else if (fn === OPS.restore) ctm = stack.pop() || ctm;
    else if (fn === OPS.transform) ctm = mul(ctm, opList.argsArray[i]);
    else if (paintOps.has(fn)) {
      const corners = [[0, 0], [1, 0], [0, 1], [1, 1]].map(([x, y]) => [
        ctm[0] * x + ctm[2] * y + ctm[4],
        ctm[1] * x + ctm[3] * y + ctm[5],
      ]);
      const xs = corners.map((c) => c[0]);
      const ys = corners.map((c) => c[1]);
      const x0 = Math.min(...xs), x1 = Math.max(...xs);
      const y0 = Math.min(...ys), y1 = Math.max(...ys);
      const area = (x1 - x0) * (y1 - y0);
      // Skip specks (icons/rules) and near-full-page backgrounds/scans.
      if (area < pageArea * 0.02 || area > pageArea * 0.8) continue;
      if (!best || area > best.area) best = { x0, x1, y0, y1, w: x1 - x0, h: y1 - y0, area };
    }
  }
  return best;
}

// Render just enough of the page to crop the given page-space region at good
// resolution, with a small margin so a caption isn't cut off.
async function renderCroppedRegion(page, region) {
  const pad = 0.06;
  const mx = region.w * pad, my = region.h * pad;
  const x0 = region.x0 - mx, x1 = region.x1 + mx;
  const y0 = region.y0 - my, y1 = region.y1 + my;
  const scale = Math.min(6, Math.max(1.2, 640 / Math.max(1, x1 - x0)));
  const vp = page.getViewport({ scale });

  const full = el("canvas");
  full.width = vp.width;
  full.height = vp.height;
  await page.render({ canvasContext: full.getContext("2d"), viewport: vp }).promise;

  const p0 = vp.convertToViewportPoint(x0, y0);
  const p1 = vp.convertToViewportPoint(x1, y1);
  const sx = Math.max(0, Math.min(p0[0], p1[0]));
  const sy = Math.max(0, Math.min(p0[1], p1[1]));
  const sw = Math.min(vp.width - sx, Math.abs(p1[0] - p0[0]));
  const sh = Math.min(vp.height - sy, Math.abs(p1[1] - p0[1]));
  if (sw < 40 || sh < 40) return null;

  const crop = el("canvas");
  crop.width = sw;
  crop.height = sh;
  crop.getContext("2d").drawImage(full, sx, sy, sw, sh, 0, 0, sw, sh);
  return crop.toDataURL("image/jpeg", 0.85);
}

// No figure found on page 1/2 — crop a snippet of the cover page (title
// through abstract) instead of shrinking the whole page into the capsule.
async function renderPageSnippet(page) {
  const base = page.getViewport({ scale: 1 });
  const vp = page.getViewport({ scale: 640 / base.width });
  const full = el("canvas");
  full.width = vp.width;
  full.height = vp.height;
  await page.render({ canvasContext: full.getContext("2d"), viewport: vp }).promise;

  const sy = vp.height * 0.08;
  const sh = Math.min(vp.height - sy, vp.width * 0.68);
  const crop = el("canvas");
  crop.width = vp.width;
  crop.height = sh;
  crop.getContext("2d").drawImage(full, 0, sy, vp.width, sh, 0, 0, vp.width, sh);
  return crop.toDataURL("image/jpeg", 0.85);
}

function applyCover(cap, url) {
  if (cap.querySelector("img.cover-img")) return;
  const img = el("img", "cover-img");
  img.src = url;
  img.alt = "";
  img.style.position = "absolute";
  img.style.inset = "0";
  cap.insertBefore(img, cap.firstChild);
  const fb = cap.querySelector(".cap-fallback");
  if (fb) fb.style.display = "none";
}

// ---------------------------------------------------------------------------
// cards
// ---------------------------------------------------------------------------
function subtitle(item) {
  if (item.type === "paper")
    return [item.authors?.[0], item.year].filter(Boolean).join(" · ");
  if (item.affiliation) return item.affiliation;
  return item.matchedTags?.[0] || item.tags?.[0] || "";
}

function card(item) {
  const c = el("div", "card");
  c.appendChild(buildCap(item, { wishFlag: true }));
  const meta = el("div", "card-meta");
  meta.appendChild(el("p", "card-title", esc(item.title)));
  meta.appendChild(el("p", "card-sub", esc(subtitle(item))));
  c.appendChild(meta);
  c.addEventListener("click", () => openDetail(item));
  return c;
}

// ---------------------------------------------------------------------------
// STORE view
// ---------------------------------------------------------------------------
function renderStore() {
  main.innerHTML = "";

  // profile / filter bar
  const bar = el("div", "profilebar");
  bar.appendChild(el("span", "lbl", "Your tags:"));
  const top = state.profile.slice(0, 12);
  for (const p of top) {
    const t = el("button", "tag tag-btn" + (state.activeTags.has(p.tag) ? " on" : ""),
      `${esc(p.tag)} <span style="opacity:.6">×${p.count}</span>`);
    t.addEventListener("click", () => {
      state.activeTags.has(p.tag) ? state.activeTags.delete(p.tag) : state.activeTags.add(p.tag);
      renderStore();
    });
    bar.appendChild(t);
  }
  if (state.activeTags.size) {
    const clr = el("button", "tag tag-btn", "clear ✕");
    clr.addEventListener("click", () => { state.activeTags.clear(); renderStore(); });
    bar.appendChild(clr);
  }
  main.appendChild(bar);

  const recs = state.catalog.filter((i) => !i.owned);

  if (state.activeTags.size) {
    const wanted = [...state.activeTags];
    const filtered = recs
      .filter((i) => wanted.some((t) => i.tags.includes(t)))
      .sort((a, b) => b.match - a.match);
    main.appendChild(el("h2", "view-head", "Filtered"));
    main.appendChild(el("p", "view-sub",
      `${filtered.length} matching ${wanted.map((t) => `#${t}`).join(" · ")}`));
    const grid = el("div", "grid");
    filtered.forEach((i) => grid.appendChild(card(i)));
    main.appendChild(filtered.length ? grid : el("div", "empty", "Nothing tagged that yet."));
    return;
  }

  // hero = highest-match paper not owned
  const hero = [...recs].filter((i) => i.type === "paper").sort((a, b) => b.match - a.match)[0];
  if (hero) main.appendChild(buildHero(hero));

  // "Because you learned X" shelves
  const used = new Set();
  for (const p of state.profile) {
    if (p.count < 2) continue;
    const items = recs
      .filter((i) => i.tags.includes(p.tag) && i.id !== hero?.id)
      .sort((a, b) => b.match - a.match);
    if (items.length < 3) continue;
    main.appendChild(shelf(
      `Because you learned <span class="hi">${esc(p.tag)}</span>`,
      `${p.count} notes in your library`, items.slice(0, 12)));
    used.add(p.tag);
    if (used.size >= 5) break;
  }

  // New lanes
  const lanes = recs.filter((i) => i.newLane);
  if (lanes.length)
    main.appendChild(shelf(
      `New lanes <span class="hi lane">you haven't explored</span>`,
      "adjacent to your notes", lanes));

  // People & labs
  const people = recs.filter((i) => i.type === "author" || i.type === "lab");
  if (people.length)
    main.appendChild(shelf("Researchers &amp; labs to follow", "curated for your topics", people));
}

function buildHero(item) {
  const h = el("div", "hero");
  const cap = buildCap(item, { showType: true, showMatch: true, eager: true });
  cap.classList.add("hero-cap-inner");
  const capWrap = el("div", "hero-cap");
  capWrap.appendChild(cap);
  cap.style.height = "100%";
  h.appendChild(capWrap);

  const body = el("div", "hero-body");
  const because = (item.because || [])[0];
  body.appendChild(el("div", "hero-kicker",
    `Featured${because ? ` · because you wrote <b>${esc(trunc(because.title, 42))}</b>` : ""}`));
  body.appendChild(el("h1", "hero-title", esc(item.title)));
  body.appendChild(el("div", "hero-meta",
    [item.authors?.slice(0, 3).join(", "), item.year].filter(Boolean).join(" · ")));
  body.appendChild(el("div", "hero-blurb", wikilinks(item.blurb || "")));
  const foot = el("div", "hero-foot");
  const m = el("span", "tag pill-match" + (item.newLane ? " lane" : ""), item.match + "% match");
  foot.appendChild(m);
  (item.tags || []).slice(0, 4).forEach((t) => foot.appendChild(el("span", "tag", "#" + esc(t))));
  const btn = el("button", "btn btn-primary", (inWishlist(item.id) ? "★ On wishlist" : "＋ Wishlist"));
  btn.addEventListener("click", (e) => { e.stopPropagation(); toggleWishlist(item); });
  foot.appendChild(btn);
  body.appendChild(foot);
  h.appendChild(body);
  h.addEventListener("click", () => openDetail(item));
  return h;
}

function shelf(titleHTML, sub, items) {
  const s = el("div", "shelf");
  const head = el("div", "shelf-head");
  head.appendChild(el("h3", "shelf-title", titleHTML));
  head.appendChild(el("span", "shelf-sub", sub));
  s.appendChild(head);
  const row = el("div", "row");
  items.forEach((i) => row.appendChild(card(i)));
  s.appendChild(row);
  return s;
}

// ---------------------------------------------------------------------------
// LIBRARY view
// ---------------------------------------------------------------------------
function renderLibrary() {
  main.innerHTML = "";
  main.appendChild(el("h2", "view-head", "Your library"));
  main.appendChild(el("p", "view-sub",
    `${state.library.length} notes you've written — the games you already own.`));
  const grid = el("div", "grid");
  const sorted = [...state.library].sort((a, b) => a.title.localeCompare(b.title));
  for (const n of sorted) {
    const c = el("div", "card");
    const cap = el("div", "cap");
    if (n.image) {
      const img = el("img", "cover-img");
      img.src = n.image; img.alt = ""; img.style.position = "absolute"; img.style.inset = "0";
      cap.appendChild(img);
    } else {
      const fb = el("div", "cap-fallback");
      fb.style.background = colorFor(n.id);
      fb.innerHTML = `<span class="ficon">${esc(n.title[0] || "?")}</span>` +
        `<span class="ftitle">${esc(n.title)}</span>`;
      cap.appendChild(fb);
    }
    cap.appendChild(el("span", "cap-type", n.section));
    c.appendChild(cap);
    const meta = el("div", "card-meta");
    meta.appendChild(el("p", "card-title", esc(n.title)));
    meta.appendChild(el("p", "card-sub", (n.tags.slice(0, 3).map((t) => "#" + t).join(" ")) || ""));
    c.appendChild(meta);
    c.addEventListener("click", () => openNoteDetail(n));
    grid.appendChild(c);
  }
  main.appendChild(grid);
}

// ---------------------------------------------------------------------------
// WISHLIST / READ views
// ---------------------------------------------------------------------------
function renderCollection(list, title, sub, emptyMsg) {
  main.innerHTML = "";
  main.appendChild(el("h2", "view-head", title));
  main.appendChild(el("p", "view-sub", sub));
  if (!list.length) { main.appendChild(el("div", "empty", emptyMsg)); return; }
  const grid = el("div", "grid");
  // enrich stored items with catalog data when available
  for (const stored of list) {
    const item = state.catalog.find((c) => c.id === stored.id) || stored;
    grid.appendChild(card(item));
  }
  main.appendChild(grid);
}
function renderWishlist() {
  renderCollection(state.wishlist, "Wishlist",
    "Papers, topics, researchers, and labs you want to get to. Start reading one to move it along.",
    "Your wishlist is empty. Browse the store or search to add something.");
}
function renderReading() {
  renderCollection(state.reading, "Reading",
    "What you're currently working through.",
    "Nothing in progress. Start reading something from your wishlist.");
}
function renderFinished() {
  renderCollection(state.read, "Finished",
    "Everything you've completed — this history also feeds my next round of picks.",
    "Nothing finished yet.");
}

// ---------------------------------------------------------------------------
// SEARCH — papers via arXiv, researchers derived from their authorships
// ---------------------------------------------------------------------------
let searchAbort = null;
async function runSearch(q) {
  state.searchQuery = q;
  if (!q.trim()) { clearSearch(); setView(state.prevView); return; }
  setView("search");
  state.searchResults = "loading";
  refresh();
  if (searchAbort) searchAbort.abort();
  searchAbort = new AbortController();
  try {
    const r = await fetch(`/api/search?q=${encodeURIComponent(q)}`, { signal: searchAbort.signal });
    state.searchResults = await r.json();
  } catch (e) {
    if (e.name !== "AbortError") state.searchResults = { papers: [], authors: [], error: true };
  }
  if (state.view === "search") refresh();
}
function clearSearch() {
  state.searchQuery = "";
  state.searchResults = null;
  $("#search-input").value = "";
}
function renderSearch() {
  main.innerHTML = "";
  main.appendChild(el("h2", "view-head", `Search results for "${esc(state.searchQuery)}"`));
  if (state.searchResults === "loading") {
    main.appendChild(el("div", "empty", "Searching arXiv…"));
    return;
  }
  const res = state.searchResults || { papers: [], authors: [] };
  if (res.error) {
    main.appendChild(el("div", "empty", "Search failed — arXiv may be unreachable. Try again."));
    return;
  }
  if (!res.papers.length && !res.authors.length) {
    main.appendChild(el("div", "empty", "No matches. Try a different query."));
    return;
  }
  if (res.authors.length) {
    main.appendChild(el("h3", "shelf-title", "Researchers"));
    const grid = el("div", "grid");
    res.authors.forEach((a) => grid.appendChild(card(a)));
    main.appendChild(grid);
  }
  if (res.papers.length) {
    main.appendChild(el("h3", "shelf-title", "Papers"));
    const grid = el("div", "grid");
    res.papers.forEach((p) => grid.appendChild(card(p)));
    main.appendChild(grid);
  }
}

// ---------------------------------------------------------------------------
// detail modal
// ---------------------------------------------------------------------------
const modal = $("#modal");
const modalBody = $("#modal-body");
function closeModal() { modal.hidden = true; modalBody.innerHTML = ""; }
modal.addEventListener("click", (e) => { if (e.target === modal) closeModal(); });

function openDetail(item) {
  modalBody.innerHTML = "";
  const capWrap = el("div", "modal-cap");
  const cap = buildCap(item, { showType: false, showMatch: false, eager: true });
  cap.style.height = "100%";
  capWrap.appendChild(cap);
  const x = el("button", "modal-x", "✕");
  x.addEventListener("click", closeModal);
  capWrap.appendChild(x);
  modalBody.appendChild(capWrap);

  const inw = el("div", "modal-in");
  inw.appendChild(el("div", "modal-type", typeLabel(item.type)));
  inw.appendChild(el("h2", "modal-title", esc(item.title)));
  inw.appendChild(el("div", "modal-meta",
    [item.authors?.join(", ") || item.affiliation, item.year].filter(Boolean).join(" · ")));
  inw.appendChild(el("div", "modal-blurb", wikilinks(item.blurb || "")));

  // tags
  const tsec = el("div");
  const tags = el("div", "modal-tags");
  if (typeof item.match === "number") {
    tags.appendChild(el("span", "tag pill-match" + (item.newLane ? " lane" : ""), item.match + "% match"));
  }
  (item.tags || []).forEach((t) => tags.appendChild(el("span", "tag", "#" + esc(t))));
  tsec.appendChild(tags);
  inw.appendChild(tsec);

  // abstract (papers, fetched live)
  if (item.arxivId) {
    inw.appendChild(el("div", "modal-sec-t", "Abstract"));
    const ab = el("div", "modal-abstract spinner", "Fetching from arXiv…");
    inw.appendChild(ab);
    fetch(`/api/arxiv?id=${encodeURIComponent(item.arxivId)}`)
      .then((r) => r.json())
      .then((d) => {
        ab.classList.remove("spinner");
        ab.textContent = d.summary || "No abstract available.";
      })
      .catch(() => { ab.classList.remove("spinner"); ab.textContent = "Couldn't reach arXiv."; });
  }

  // because
  if (item.because?.length) {
    inw.appendChild(el("div", "modal-sec-t", "Because you wrote"));
    const bwrap = el("div", "modal-because");
    for (const b of item.because) {
      const a = el("a", "because-item",
        `<span class="bdot">◆</span> ${esc(b.title)}`);
      a.href = obsidianURI(b.path);
      bwrap.appendChild(a);
    }
    inw.appendChild(bwrap);
  }

  // actions — wishlist -> reading -> finished
  const actions = el("div", "modal-actions");
  const finished = isFinished(item.id);

  const wbtn = el("button", "btn " + (inWishlist(item.id) ? "on" : "btn-primary"),
    inWishlist(item.id) ? "★ On wishlist" : "＋ Add to wishlist");
  wbtn.addEventListener("click", () => { toggleWishlist(item); closeModal(); });
  actions.appendChild(wbtn);

  if (!finished) {
    const readingNow = inReading(item.id);
    const rbtn = el("button", "btn " + (readingNow ? "on" : "btn-accent"),
      readingNow ? "▶ Reading now" : "▶ Start reading");
    rbtn.addEventListener("click", () => { toggleReading(item); closeModal(); });
    actions.appendChild(rbtn);
  }

  const fbtn = el("button", "btn " + (finished ? "on" : "btn-accent"),
    finished ? "✓ Finished" : "✓ Mark finished");
  if (!finished) fbtn.addEventListener("click", () => { markFinished(item); closeModal(); });
  else fbtn.disabled = true;
  actions.appendChild(fbtn);

  if (item.link) {
    const open = el("a", "btn btn-ghost", (item.type === "paper" ? "Open on arXiv ↗" : "Visit ↗"));
    open.href = item.link; open.target = "_blank"; open.rel = "noopener noreferrer";
    open.addEventListener("click", (e) => {
      e.preventDefault();
      window.open(item.link, "_blank", "noopener,noreferrer");
    });
    actions.appendChild(open);
  }
  inw.appendChild(actions);
  modalBody.appendChild(inw);
  modal.hidden = false;
}

function openNoteDetail(n) {
  modalBody.innerHTML = "";
  const capWrap = el("div", "modal-cap");
  if (n.image) {
    const img = el("img"); img.src = n.image; img.alt = "";
    capWrap.appendChild(img);
  } else {
    const fb = el("div", "cap-fallback");
    fb.style.background = colorFor(n.id); fb.style.height = "100%";
    fb.innerHTML = `<span class="ficon">${esc(n.title[0] || "?")}</span>`;
    capWrap.appendChild(fb);
  }
  const x = el("button", "modal-x", "✕"); x.addEventListener("click", closeModal);
  capWrap.appendChild(x);
  modalBody.appendChild(capWrap);

  const inw = el("div", "modal-in");
  inw.appendChild(el("div", "modal-type", "your note · " + n.section));
  inw.appendChild(el("h2", "modal-title", esc(n.title)));
  const tags = el("div", "modal-tags");
  n.tags.forEach((t) => tags.appendChild(el("span", "tag", "#" + esc(t))));
  inw.appendChild(tags);
  if (n.excerpt) {
    inw.appendChild(el("div", "modal-sec-t", "Excerpt"));
    inw.appendChild(el("div", "modal-abstract", esc(n.excerpt) + "…"));
  }
  const actions = el("div", "modal-actions");
  const open = el("a", "btn btn-primary", "Open in Obsidian ↗");
  open.href = obsidianURI(n.path);
  actions.appendChild(open);
  inw.appendChild(actions);
  modalBody.appendChild(inw);
  modal.hidden = false;
}

// ---------------------------------------------------------------------------
// wishlist / read actions
// ---------------------------------------------------------------------------
function toItem(item) {
  return {
    id: item.id, type: item.type, title: item.title,
    arxivId: item.arxivId || null, link: item.link || null, tags: item.tags || [],
  };
}
async function post(url, body) {
  const r = await fetch(url, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return r.json();
}
async function toggleWishlist(item) {
  const action = inWishlist(item.id) ? "remove" : "add";
  const res = await post("/api/wishlist", { action, item: toItem(item) });
  state.wishlist = res.wishlist;
  refresh();
}
async function toggleReading(item) {
  const action = inReading(item.id) ? "remove" : "start";
  const res = await post("/api/reading", { action, item: toItem(item) });
  state.wishlist = res.wishlist;
  state.reading = res.reading;
  refresh();
}
async function markFinished(item) {
  const res = await post("/api/read", { action: "add", item: toItem(item) });
  state.wishlist = res.wishlist;
  state.reading = res.reading;
  state.read = res.read;
  refresh();
}

// ---------------------------------------------------------------------------
// nav / refresh
// ---------------------------------------------------------------------------
function refresh() {
  $("#wishlist-badge").textContent = state.wishlist.length;
  $("#reading-badge").textContent = state.reading.length;
  const v = state.view;
  if (v === "store") renderStore();
  else if (v === "library") renderLibrary();
  else if (v === "wishlist") renderWishlist();
  else if (v === "reading") renderReading();
  else if (v === "finished") renderFinished();
  else if (v === "search") renderSearch();
}
function setView(v) {
  if (v !== "search") state.prevView = v;
  state.view = v;
  document.querySelectorAll(".nav-btn").forEach((b) =>
    b.classList.toggle("active", b.dataset.view === v));
  refresh();
}
document.querySelectorAll(".nav-btn").forEach((b) =>
  b.addEventListener("click", () => { clearSearch(); setView(b.dataset.view); }));

const searchForm = $("#searchbar");
const searchInput = $("#search-input");
searchForm.addEventListener("submit", (e) => { e.preventDefault(); runSearch(searchInput.value); });
let searchDebounce;
searchInput.addEventListener("input", () => {
  clearTimeout(searchDebounce);
  const v = searchInput.value;
  if (!v.trim()) {
    state.searchQuery = ""; state.searchResults = null;
    if (state.view === "search") setView(state.prevView);
    return;
  }
  searchDebounce = setTimeout(() => runSearch(v), 450);
});

document.addEventListener("keydown", (e) => {
  if (!modal.hidden && e.key === "Escape") {
    closeModal();
  }
});

function trunc(s, n) { return s && s.length > n ? s.slice(0, n - 1) + "…" : s; }

// ---------------------------------------------------------------------------
// boot
// ---------------------------------------------------------------------------
async function boot() {
  try {
    const d = await (await fetch("/api/data")).json();
    Object.assign(state, {
      library: d.library || [], profile: d.profile || [],
      catalog: d.catalog || [], wishlist: d.wishlist || [],
      reading: d.reading || [], read: d.read || [],
    });
    refresh();
  } catch (e) {
    main.innerHTML = `<div class="empty">Couldn't load data: ${esc(e.message)}</div>`;
  }
}
boot();
