# figure-probe

Exercises the real figure/caption logic in [`web/figures.js`](../../web/figures.js)
headlessly, against real arXiv PDFs, so the reel extractor can be tuned without
clicking through a browser. `web/figures.js` imports nothing and touches no DOM
precisely so this is possible — the probe loads the same module the browser does.

## Use it

No `npm install`, no admin rights. pdf.js is fetched as two plain files next to
the script (both are needed: `pdf.mjs` imports `pdf.worker.mjs` to set up its
main-thread worker under Node). They are gitignored.

```bash
node tools/figure-probe/fetch-pdfjs.mjs          # one time, ~2.7 MB
node server.mjs                                   # the probe fetches PDFs through /pdf
node tools/figure-probe/probe.mjs 2205.04422 1708.03852 2303.04137
```

It prints, per paper, how many captions were found, how many became beats, the
artwork size in points, whether each caption was matched by geometry or reading
order, and the caption text — plus a warning if one box were handed to two
captions.

To re-measure the whole catalog:

```bash
node -e "console.log(require('./catalog.json').filter(i=>i.arxivId).map(i=>i.arxivId).join(' '))" \
  | xargs node tools/figure-probe/probe.mjs
```

## Baseline, 2026-10-15

All 28 `type: "paper"` entries in `catalog.json`:

```
125/132 beats across 28 papers; problems: 2607.18174 (no artwork)
17 papers yield a full 5-figure reel · 0 duplicate boxes
worst caption pass 4.0s (cached server-side afterwards)
```

`2607.18174` contains no figures at all — no line in it mentions "fig" — so a
2-beat reel is the correct outcome, not a bug.

## Defects this found

Each was invisible from the browser, which is the reason the harness exists.

- Figure 1 of Marcucci 2022 is on **page 8** of 32 and drawn with 160 vector
  paths. Scanning pages 1-6 for raster images found nothing at all. Fixed by
  searching vector path boxes and letting caption lines choose the pages.
- `Figure 7.2` in Halko 2009 parsed as figure number `7`, collapsing 7.1/7.2/7.3
  into one figure, and the `.` of `7.2` made body prose look like a caption.
- Its first caption is on page 39, past the original 26-page scan window.
- Two captions on the same page were handed the same artwork box.
- Caption text ran on into the next column (`"…ORB-SLAM [179]. vironment(e.g."`).
- Vector path boxes bled past the artwork into the caption and the body text
  below it, so the caption appeared twice — once inside the still, once in the
  plate. `trimAtCaption` now pulls the crop's lower edge above the caption
  line, which cut VINS-Mono's Figure 2 from 535pt (nearly a full page) to 272pt.
- TeX output often encodes no space between text runs, so concatenating them
  gave `"Fig. 3:SLAMasafactorgraph"`. Runs are now joined by measuring the
  horizontal gap between them.
- A fixed 14pt line-spacing threshold truncated captions mid-sentence on papers
  whose fonts report a text height of 0; the leading is now derived per page.

## Known residual

In tight two-column layouts a caption's **tail** can still pick up a fragment
from the neighbouring column (`"…for high-speed loco- duce the reality g"`).
Tightening `FIG.CAPTION_COLUMN_PT` below 40 would fix it but truncate
centre-aligned multi-line captions, where every line legitimately starts at a
different x. The informative opening of the caption — all that fits on screen —
was correct in every sample. Left as is deliberately.
