// PDF → reel beats. All pdf.js and canvas use lives here: cover art for cards
// and the figure sequence behind each reel in the feed.
//
// Generalized from the original single-cover extractor, which kept only the
// largest painted image on page 1/2. Here every painted image across the first
// few pages is kept, panels belonging to one figure are merged, and each figure
// is paired with its real "Figure N:" caption from the text layer. The geometry
// itself lives in figures.js so it can be tested without a browser.

import * as pdfjsLib from "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/4.0.379/pdf.min.mjs";
import { el, scheduleRender } from "./shared.js";
import {
  FIG, pageRegions, textLines, pageCaptions, assignFigures,
} from "./figures.js";

pdfjsLib.GlobalWorkerOptions.workerSrc =
  "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/4.0.379/pdf.worker.min.mjs";

// Reel figures fill the viewport; cover capsules are only 150px tall.
const REEL_TARGET_PX = 900;
const COVER_TARGET_PX = 640;

export function loadPdf(arxivId) {
  return pdfjsLib.getDocument({ url: `/pdf?id=${encodeURIComponent(arxivId)}` }).promise;
}

// ---------------------------------------------------------------------------
// page → figures + captions
// ---------------------------------------------------------------------------

async function regionsOf(page) {
  const opList = await page.getOperatorList();
  const vp = page.getViewport({ scale: 1 });
  return pageRegions(opList.fnArray, opList.argsArray, pdfjsLib.OPS, vp.width, vp.height);
}

async function linesOf(page) {
  try {
    return textLines((await page.getTextContent()).items);
  } catch {
    return [];
  }
}

// Artwork on a page, largest first — used for card cover art.
export async function findFigures(page) {
  const r = await regionsOf(page);
  return [...r.raster, ...r.vector].sort((a, b) => b.area - a.area);
}

// ---------------------------------------------------------------------------
// rasterizing
// ---------------------------------------------------------------------------

// Render just enough of the page to crop the given page-space region at good
// resolution, with a small margin so a caption isn't cut off.
export async function renderCroppedRegion(page, region, targetPx = COVER_TARGET_PX) {
  const pad = 0.06;
  const mx = region.w * pad, my = region.h * pad;
  const x0 = region.x0 - mx, x1 = region.x1 + mx;
  const y0 = region.y0 - my, y1 = region.y1 + my;
  const scale = Math.min(6, Math.max(1.2, targetPx / Math.max(1, x1 - x0)));
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

// No figure found — crop a snippet of the cover page (title through abstract)
// instead of shrinking the whole page into the capsule.
export async function renderPageSnippet(page, targetPx = COVER_TARGET_PX) {
  const base = page.getViewport({ scale: 1 });
  const vp = page.getViewport({ scale: targetPx / base.width });
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

// Cover art for cards: figure 1 if we can find it, else a cover-page snippet.
export async function renderFigureSnippet(doc) {
  for (const pageNum of [1, 2]) {
    if (pageNum > doc.numPages) break;
    const page = await doc.getPage(pageNum);
    const figures = await findFigures(page);
    if (figures.length) {
      const url = await renderCroppedRegion(page, figures[0]);
      if (url) return url;
    }
  }
  return renderPageSnippet(await doc.getPage(1));
}

// ---------------------------------------------------------------------------
// reel assembly
// ---------------------------------------------------------------------------

function sentences(text) {
  return String(text || "")
    .replace(/\s+/g, " ")
    .split(/(?<=[.!?])\s+(?=[A-Z(])/)
    .map((s) => s.trim())
    .filter((s) => s.length > 30);
}

/**
 * Captions drive the search. Pass 1 reads the text layer (cheap) to find which
 * pages carry a "Figure N:" line; pass 2 pulls the operator list only for
 * those pages and matches artwork to each caption. Scanning pages 1..6 instead
 * would miss Figure 1 of a 32-page paper sitting on page 8.
 */
async function extractFigureBeats(doc) {
  // Pass 1 — captions, first mention of each figure number wins.
  const scan = Math.min(doc.numPages, FIG.CAPTION_SCAN_PAGES);
  const byPage = new Map();
  const seen = new Set();
  for (let p = 1; p <= scan; p++) {
    const page = await doc.getPage(p);
    const caps = [];
    for (const c of pageCaptions(await linesOf(page))) {
      if (seen.has(c.number)) continue;
      seen.add(c.number);
      caps.push(c);
    }
    if (caps.length) byPage.set(p, caps);
    if (seen.size >= FIG.MAX_FIGURES) break;
  }

  // Pass 2 — artwork on those pages only.
  const beats = [];
  for (const [p, caps] of byPage) {
    const page = await doc.getPage(p);
    const vp = page.getViewport({ scale: 1 });
    const assigned = assignFigures(await regionsOf(page), caps, vp.height);
    for (const { caption, box } of assigned) {
      const img = await renderCroppedRegion(page, box, REEL_TARGET_PX);
      if (!img) continue;
      beats.push({
        kind: "figure",
        img,
        caption: caption.text,
        label: caption.label,
        page: p,
        captionSource: "pdf",
      });
    }
  }
  return beats;
}

async function fetchAbstract(arxivId) {
  try {
    const r = await fetch(`/api/arxiv?id=${encodeURIComponent(arxivId)}`);
    return (await r.json())?.summary || "";
  } catch {
    return "";
  }
}

// Fill in captions the PDF didn't give us: abstract sentences, then a label.
async function fillCaptions(beats, desc) {
  if (!beats.some((b) => !b.caption)) return beats;
  const pool = sentences(desc.blurb || (await fetchAbstract(desc.arxivId)));
  let n = 0;
  beats.forEach((b, i) => {
    if (b.caption) return;
    b.caption = pool[n] || `Figure ${i + 1} of ${beats.length} — ${desc.title}`;
    b.captionSource = pool[n] ? "abstract" : "generated";
    if (pool[n]) n++;
  });
  return beats;
}

async function cachedReel(arxivId) {
  try {
    const r = await fetch(`/api/reel?id=${encodeURIComponent(arxivId)}`);
    if (!r.ok) return null;
    const reel = await r.json();
    return Array.isArray(reel?.beats) && reel.beats.length ? reel : null;
  } catch {
    return null;
  }
}

async function saveReel(desc, beats) {
  try {
    await fetch(`/api/reel?id=${encodeURIComponent(desc.arxivId)}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: desc.id, beats }),
    });
  } catch {
    /* the cache is an optimization; failing to warm it is not an error */
  }
}

const inflight = new Map();

/**
 * Figure beats for one paper. Served from the server-side cache when warm,
 * otherwise extracted from the PDF here and pushed back to warm it.
 * Returns { beats, fromCache }.
 */
export function buildPaperReel(desc) {
  if (!desc?.arxivId) return Promise.resolve({ beats: [], fromCache: false });
  if (inflight.has(desc.arxivId)) return inflight.get(desc.arxivId);

  const job = (async () => {
    const hit = await cachedReel(desc.arxivId);
    if (hit) return { beats: hit.beats, fromCache: true };

    const beats = await scheduleRender(async () => {
      const doc = await loadPdf(desc.arxivId);
      try {
        return await extractFigureBeats(doc);
      } finally {
        doc.destroy?.();
      }
    });
    await fillCaptions(beats, desc);
    if (beats.length) saveReel(desc, beats);
    return { beats, fromCache: false };
  })();

  inflight.set(desc.arxivId, job);
  job.catch(() => inflight.delete(desc.arxivId));
  return job;
}
