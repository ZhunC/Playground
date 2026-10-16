// Download the two pdf.js files the probe needs, next to this script.
// Avoids npm entirely — these are plain file downloads, no install step and no
// admin rights. Both files are required: pdf.mjs imports pdf.worker.mjs to set
// up its main-thread "fake worker" under Node.
//
//   node tools/figure-probe/fetch-pdfjs.mjs

import { writeFile, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const VERSION = "4.0.379"; // keep in step with the CDN version web/pdfreel.js imports
const BASE = `https://cdn.jsdelivr.net/npm/pdfjs-dist@${VERSION}/legacy/build`;
const FILES = ["pdf.mjs", "pdf.worker.mjs"];
const here = path.dirname(fileURLToPath(import.meta.url));

for (const f of FILES) {
  const dest = path.join(here, f);
  try {
    const s = await stat(dest);
    console.log(`${f} already present (${(s.size / 1024).toFixed(0)} KB)`);
    continue;
  } catch {
    /* not downloaded yet */
  }
  const r = await fetch(`${BASE}/${f}`);
  if (!r.ok) {
    console.error(`${f}: HTTP ${r.status}`);
    process.exit(1);
  }
  const buf = Buffer.from(await r.arrayBuffer());
  await writeFile(dest, buf);
  console.log(`${f} downloaded (${(buf.length / 1024).toFixed(0)} KB)`);
}
console.log("ready — node tools/figure-probe/probe.mjs 2205.04422");
