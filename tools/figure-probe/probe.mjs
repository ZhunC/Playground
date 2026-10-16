// Headless check of the real figure/caption logic in web/figures.js against
// real arXiv PDFs, fetched through the running studydeck /pdf proxy.
// Mirrors the orchestration in web/pdfreel.js: captions drive the page search.
//   node probe.mjs 2205.04422 1708.03852 ...
import {
  FIG, pageRegions, textLines, pageCaptions, assignFigures,
} from "../../web/figures.js";

// pdf.js is downloaded beside this script rather than installed, so the probe
// needs no npm and no admin rights.
let pdfjsLib;
try {
  pdfjsLib = await import("./pdf.mjs");
} catch (e) {
  console.error(
    "pdf.js not found next to probe.mjs.\n" +
    "Run:  node tools/figure-probe/fetch-pdfjs.mjs\n" +
    `(${e.message})`
  );
  process.exit(1);
}

let totalWant = 0, totalGot = 0, totalPapers = 0, failedPapers = [];

for (const id of process.argv.slice(2)) {
  let doc;
  const t0 = Date.now();
  try {
    const r = await fetch(`http://localhost:4173/pdf?id=${encodeURIComponent(id)}`);
    if (!r.ok) throw new Error("proxy " + r.status);
    doc = await pdfjsLib.getDocument({
      data: new Uint8Array(await r.arrayBuffer()),
      isEvalSupported: false,
      useSystemFonts: false,
    }).promise;
  } catch (e) {
    console.log(`\n### ${id}  FETCH FAILED: ${e.message}`);
    failedPapers.push(id + " (fetch)");
    continue;
  }
  totalPapers++;

  // Pass 1 — captions (text only, cheap).
  const scan = Math.min(doc.numPages, FIG.CAPTION_SCAN_PAGES);
  const byPage = new Map();
  const seenNum = new Set();
  let captionCount = 0;
  for (let p = 1; p <= scan; p++) {
    const page = await doc.getPage(p);
    const lines = textLines((await page.getTextContent()).items);
    const caps = [];
    for (const c of pageCaptions(lines)) {
      captionCount++;
      if (seenNum.has(c.number)) continue; // first mention of each figure wins
      seenNum.add(c.number);
      caps.push(c);
    }
    if (caps.length) byPage.set(p, caps);
    if (seenNum.size >= FIG.MAX_FIGURES) break;
  }
  const tCap = Date.now() - t0;

  // Pass 2 — artwork, only on pages that have a caption.
  const beats = [];
  for (const [p, caps] of byPage) {
    const page = await doc.getPage(p);
    const vp = page.getViewport({ scale: 1 });
    const op = await page.getOperatorList();
    const regions = pageRegions(op.fnArray, op.argsArray, pdfjsLib.OPS, vp.width, vp.height);
    const got = assignFigures(regions, caps, vp.height);
    for (const g of got) beats.push({ p, ...g, nR: regions.raster.length, nV: regions.vector.length });
    for (const c of caps) if (!got.some((g) => g.caption === c)) beats.push({ p, caption: c, box: null, nR: regions.raster.length, nV: regions.vector.length });
  }
  const want = [...byPage.values()].reduce((n, c) => n + c.length, 0);
  const ok = beats.filter((b) => b.box).length;
  totalWant += want; totalGot += ok;
  if (!ok) failedPapers.push(id + " (no artwork)");

  console.log(
    `\n### ${id}  pages=${doc.numPages}  captions=${captionCount}  beats=${ok}/${want}` +
    `  (captions ${tCap}ms, total ${Date.now() - t0}ms)`
  );
  const boxes = beats.filter((b) => b.box).map((b) => `${b.p}:${Math.round(b.box.x0)},${Math.round(b.box.y0)}`);
  if (new Set(boxes).size !== boxes.length) console.log("  !! DUPLICATE BOX REUSED");
  for (const b of beats) {
    const g = b.box ? `${Math.round(b.box.w)}x${Math.round(b.box.h)}pt` : "NO ARTWORK";
    console.log(`  p${String(b.p).padStart(2)} [${g.padEnd(11)}] r=${b.nR} v=${b.nV}  ${b.caption.text.slice(0, 80)}`);
  }
  await doc.destroy();
}

console.log(`\n==== ${totalGot}/${totalWant} beats across ${totalPapers} papers` +
  (failedPapers.length ? `; problems: ${failedPapers.join(", ")}` : "; no failures") + " ====");
