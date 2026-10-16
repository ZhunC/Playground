// Figure + caption geometry. Pure functions over the data pdf.js hands us —
// no DOM, no canvas, no pdf.js import — so this logic can be exercised
// headlessly in Node against real PDFs (tools/figure-probe).
//
// Two things this had to learn from real arXiv papers:
//
//  1. Figures are mostly NOT raster images. In Marcucci 2022 (GCS) pages 1-7
//     hold no image at all and Figure 1 is on page 8, drawn with 160 vector
//     paths. So path bounding boxes count as figures, not just painted images.
//  2. Scanning the first N pages misses those figures entirely. Instead the
//     caption lines drive the search: find the pages carrying a "Figure N:"
//     line (cheap — text only), then look for artwork on those pages. Every
//     beat then has a real caption by construction.

export const FIG = {
  // Pages examined for caption lines, when the early figures are sparse. The
  // scan stops as soon as MAX_FIGURES captions are in hand, so a normal paper
  // only pays for its first few pages — but Halko 2009 puts Figure 7.1 on page
  // 39 of 74, and a 26-page window found nothing there at all.
  CAPTION_SCAN_PAGES: 44,
  MAX_FIGURES: 5,
  // Artwork smaller than this share of the page is a rule/logo/inline glyph;
  // larger than the max is a full-page scan or background wash.
  MIN_AREA_FRAC: 0.015,
  MAX_AREA_FRAC: 0.85,
  MIN_SIDE_PT: 55,
  // Panels and plot elements belonging to one figure sit close together.
  MERGE_GAP_PT: 18,
  // A path box thinner than this is a table rule or underline, not artwork.
  MIN_STROKE_PT: 3,
  // A figure sits within this distance above its caption.
  FIG_ABOVE_CAPTION_PT: 460,
  CAPTION_CHARS: 320,
  // How far a continuation line may sit from the caption's left edge before it
  // counts as a different column.
  CAPTION_COLUMN_PT: 40,
};

// The number has to allow sectioned and lettered forms ("7.1", "2b"). Matching
// only \d+ made the "." of "Figure 7.2 tracks …" look like a caption separator,
// so body prose was read as a caption and figures 7.1/7.2/7.3 all collapsed
// onto the number 7.
export const CAPTION_RE = /^\s*(fig(?:ure)?s?\.?\s*\.?\s*(\d+(?:\.\d+)*[a-z]?))/i;

function mul(a, b) {
  return [
    a[0] * b[0] + a[2] * b[1], a[1] * b[0] + a[3] * b[1],
    a[0] * b[2] + a[2] * b[3], a[1] * b[2] + a[3] * b[3],
    a[0] * b[4] + a[2] * b[5] + a[4], a[1] * b[4] + a[3] * b[5] + a[5],
  ];
}

function apply(m, x, y) {
  return [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]];
}

// The unit square mapped through the CTM: where this image lands on the page.
function imageBox(ctm) {
  const corners = [[0, 0], [1, 0], [0, 1], [1, 1]].map(([x, y]) => apply(ctm, x, y));
  const xs = corners.map((c) => c[0]);
  const ys = corners.map((c) => c[1]);
  return { x0: Math.min(...xs), x1: Math.max(...xs), y0: Math.min(...ys), y1: Math.max(...ys) };
}

export function withSize(b) {
  return { ...b, w: b.x1 - b.x0, h: b.y1 - b.y0, area: (b.x1 - b.x0) * (b.y1 - b.y0) };
}

// A multi-panel figure is painted as several images, and a vector plot as
// hundreds of paths. Without merging you get one crop per panel or per stroke.
export function mergeBoxes(boxes, gap = FIG.MERGE_GAP_PT) {
  const out = boxes.map((b) => ({ ...b }));
  let merged = true;
  while (merged) {
    merged = false;
    for (let i = 0; i < out.length && !merged; i++) {
      for (let j = i + 1; j < out.length; j++) {
        const a = out[i], b = out[j];
        if (!(a.x0 - gap < b.x1 && b.x0 - gap < a.x1)) continue;
        if (!(a.y0 - gap < b.y1 && b.y0 - gap < a.y1)) continue;
        out[i] = {
          x0: Math.min(a.x0, b.x0), x1: Math.max(a.x1, b.x1),
          y0: Math.min(a.y0, b.y0), y1: Math.max(a.y1, b.y1),
        };
        out.splice(j, 1);
        merged = true;
        break;
      }
    }
  }
  return out.map(withSize);
}

function plausible(b, pageArea) {
  return (
    b.area >= pageArea * FIG.MIN_AREA_FRAC &&
    b.area <= pageArea * FIG.MAX_AREA_FRAC &&
    Math.min(b.w, b.h) >= FIG.MIN_SIDE_PT
  );
}

/**
 * Walk a page's operator list tracking the CTM through save/restore/transform.
 * Returns candidate artwork boxes in page space, reading order (top first):
 *   { raster: [...], vector: [...] }
 * `ops` is pdfjsLib.OPS, injected so this file needs no pdf.js import.
 */
export function pageRegions(fnArray, argsArray, ops, pageW, pageH) {
  const paintOps = new Set(
    [ops.paintImageXObject, ops.paintJpegXObject, ops.paintInlineImageXObject].filter(
      (v) => v !== undefined
    )
  );
  const pageArea = pageW * pageH;
  const stack = [];
  let ctm = [1, 0, 0, 1, 0, 0];
  const rasterRaw = [];
  const vectorRaw = [];

  for (let i = 0; i < fnArray.length; i++) {
    const fn = fnArray[i];
    if (fn === ops.save) stack.push(ctm);
    else if (fn === ops.restore) ctm = stack.pop() || ctm;
    else if (fn === ops.transform) ctm = mul(ctm, argsArray[i]);
    else if (paintOps.has(fn)) rasterRaw.push(imageBox(ctm));
    else if (fn === ops.constructPath) {
      // pdf.js gives constructPath args as [pathOps, coords, minMax].
      const mm = argsArray[i]?.[2];
      if (!mm || mm.length < 4) continue;
      const a = apply(ctm, mm[0], mm[1]);
      const b = apply(ctm, mm[2], mm[3]);
      const box = {
        x0: Math.min(a[0], b[0]), x1: Math.max(a[0], b[0]),
        y0: Math.min(a[1], b[1]), y1: Math.max(a[1], b[1]),
      };
      if (![box.x0, box.x1, box.y0, box.y1].every(Number.isFinite)) continue;
      // Drop page-wide hairlines (table rules, header underlines).
      const w = box.x1 - box.x0, h = box.y1 - box.y0;
      if (Math.min(w, h) < FIG.MIN_STROKE_PT && Math.max(w, h) > pageW * 0.3) continue;
      vectorRaw.push(box);
    }
  }

  // Clipped vector art can report a box bigger than the page; clamp so the
  // area filters below mean what they say.
  const clip = (b) =>
    withSize({
      x0: Math.max(0, Math.min(b.x0, pageW)), x1: Math.max(0, Math.min(b.x1, pageW)),
      y0: Math.max(0, Math.min(b.y0, pageH)), y1: Math.max(0, Math.min(b.y1, pageH)),
    });
  const order = (a, b) => b.y1 - a.y1; // PDF y grows upward
  const finish = (raw) => mergeBoxes(raw).map(clip).filter((b) => plausible(b, pageArea)).sort(order);
  return { raster: finish(rasterRaw), vector: finish(vectorRaw) };
}

// Group text items into lines. pdf.js item transforms are [a,b,c,d,x,y].
//
// Runs are joined by measuring the horizontal gap between them, not by simple
// concatenation: TeX output often encodes no space character at all between
// runs, which concatenated reads "SLAMasafactorgraph".
export function textLines(items) {
  const rows = new Map();
  for (const it of items || []) {
    if (!it || typeof it.str !== "string" || !it.transform) continue;
    if (!it.str.trim()) continue;
    const x = it.transform[4];
    const y = it.transform[5];
    const key = Math.round(y / 2) * 2; // tolerate sub-point baseline drift
    const row = rows.get(key) || { y, x0: x, x1: x, h: it.height || 10, parts: [] };
    row.x0 = Math.min(row.x0, x);
    row.x1 = Math.max(row.x1, x + (it.width || 0));
    row.h = Math.max(row.h, it.height || 0);
    row.parts.push({ x, w: it.width || 0, str: it.str });
    rows.set(key, row);
  }
  return [...rows.values()]
    .map((r) => {
      const parts = r.parts.sort((a, b) => a.x - b.x);
      let text = "";
      let endX = null;
      for (const p of parts) {
        const needsSpace =
          endX !== null && !/\s$/.test(text) && !/^\s/.test(p.str) && p.x - endX > 0.8;
        text += (needsSpace ? " " : "") + p.str;
        endX = p.x + p.w;
      }
      return {
        y: r.y,
        x0: r.x0,
        x1: r.x1,
        h: r.h || 10,
        text: text.replace(/\s+/g, " ").trim(),
      };
    })
    .filter((r) => r.text)
    .sort((a, b) => b.y - a.y); // top of page first
}

// Typical line spacing on a page, used to decide whether the next line still
// belongs to a caption. Derived rather than assumed, because some fonts report
// a text height of 0 and a fixed threshold then cuts captions mid-sentence.
export function medianLeading(lines) {
  const gaps = [];
  for (let i = 1; i < lines.length; i++) {
    const g = lines[i - 1].y - lines[i].y;
    if (g > 1 && g < 60) gaps.push(g);
  }
  if (!gaps.length) return 12;
  gaps.sort((a, b) => a - b);
  return gaps[Math.floor(gaps.length / 2)];
}

// Caption block = the "Figure N" line plus the lines that continue it.
// Continuation lines of a caption are block-justified under its first line, so
// a line starting far off that left edge belongs to another column and must not
// be swallowed (that is how "…ORB-SLAM [179]. vironment(e.g." happens).
export function captionFrom(lines, startIdx, leading = medianLeading(lines)) {
  const first = lines[startIdx];
  let text = first.text;
  for (let k = startIdx + 1; k < lines.length; k++) {
    if (text.length >= FIG.CAPTION_CHARS) break;
    const gap = lines[k - 1].y - lines[k].y;
    if (gap < 0 || gap > leading * 1.8) break;
    if (CAPTION_RE.test(lines[k].text)) break;
    if (Math.abs(lines[k].x0 - first.x0) > FIG.CAPTION_COLUMN_PT) break;
    text += " " + lines[k].text;
  }
  return text.replace(/\s+/g, " ").trim().slice(0, FIG.CAPTION_CHARS);
}

/**
 * The figure captions on a page, in reading order. A continuation line such as
 * "Figure 1c shows ..." mid-paragraph is rejected: a real caption either starts
 * its line with the label followed by a separator, or is the only such line.
 */
export function pageCaptions(lines) {
  const out = [];
  const leading = medianLeading(lines);
  for (let i = 0; i < lines.length; i++) {
    const m = CAPTION_RE.exec(lines[i].text);
    if (!m) continue;
    const after = lines[i].text.slice(m[0].length);
    // "Figure 1:" / "Fig. 1." / "Figure 5Solutions" (separator eaten by the
    // text layer) are captions; "Figure 1c shows the graph" is prose.
    if (!/^\s*[:.—–-]|^[A-Z(]/.test(after) && after.trim()) continue;
    out.push({
      index: i,
      // Kept as a string: "7.1" and "7.2" are different figures.
      number: m[2],
      label: m[1].replace(/\s+/g, " ").trim(),
      y: lines[i].y,
      x0: lines[i].x0,
      x1: lines[i].x1,
      h: lines[i].h,
      leading,
      text: captionFrom(lines, i, leading),
    });
  }
  return out;
}

/**
 * Given the artwork boxes on a page and one caption, pick the box that caption
 * belongs to: the artwork sitting directly above it, preferring horizontal
 * overlap and proximity. Raster artwork wins over vector when both qualify,
 * since a photo is a better still than the axes around it.
 *
 * pdf.js text-layer and operator-list coordinates are not guaranteed to share
 * an origin, so if nothing is found above the caption we fall back to the
 * largest box on the page.
 */
export function figureForCaption(regions, caption, pageH, used = new Set()) {
  const pools = [regions.raster || [], regions.vector || []];
  for (const pool of pools) {
    let best = null;
    for (const b of pool) {
      if (used.has(b)) continue;
      const gap = b.y0 - caption.y; // caption below the artwork
      if (gap < -b.h * 0.25 || gap > FIG.FIG_ABOVE_CAPTION_PT) continue;
      const overlapX = b.x0 < caption.x1 && caption.x0 < b.x1;
      const score = gap - (overlapX ? 120 : 0) - b.area / (pageH * pageH);
      if (!best || score < best.score) best = { box: b, score };
    }
    if (best) return best.box;
  }
  const spare = [...pools[0], ...pools[1]]
    .filter((b) => !used.has(b))
    .sort((a, b) => b.area - a.area);
  return spare[0] || null;
}

/**
 * Assign the artwork on one page to that page's captions, in reading order,
 * never handing the same box to two captions — otherwise a page with
 * "Figure 3" and "Figure 4" on it yields the same still twice.
 * Returns [{ caption, box }] for the captions that got artwork.
 */
export function assignFigures(regions, captions, pageH) {
  const used = new Set();
  const out = [];
  for (const caption of captions) {
    const box = figureForCaption(regions, caption, pageH, used);
    if (!box) continue;
    used.add(box);
    out.push({ caption, box: trimAtCaption(box, caption) });
  }
  return out;
}

/**
 * Pull the crop's lower edge up to just above the caption line. A vector path
 * cluster often bleeds past the artwork into the caption and the body text
 * under it, which then appears inside the still — with the caption rendered
 * twice, once in the image and once in the plate.
 *
 * Only applied when the caption really does sit below the box, which is also
 * the case where we know the text and path coordinate spaces agree.
 */
export function trimAtCaption(box, caption) {
  // caption.y is a baseline and glyphs rise above it, so clear a full line.
  // Some fonts report height 0 through the text layer, hence the floor —
  // without it a whole line of caption stayed inside the still.
  const lead = Math.max(caption.h || 0, caption.leading || 0, 9) * 1.35;
  const top = caption.y + lead;
  if (!(top > box.y0) || top >= box.y1 - FIG.MIN_SIDE_PT) return box;
  return withSize({ ...box, y0: top });
}
