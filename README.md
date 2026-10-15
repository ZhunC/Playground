# studydeck

A "Steam store, but for study." It reads your Obsidian vault, builds a tag
profile from what you've already written, and presents **curated papers,
topics, researchers, and labs** as an image-first, browse-when-your-brain-is-off
store — cover art, "because you learned X" shelves, and a wishlist that links
back into your vault.

## Run it

```bash
node "C:\Users\Gaming pc\Documents\ws\studydeck\server.mjs"
```

Then open http://localhost:4173. No `npm install` — it uses only Node 22
built-ins (`http`, `fs`, `fetch`). Requires internet (fetches arXiv covers +
abstracts live). In Claude Code you can also launch it from the `studydeck`
entry in the vault's `.claude/launch.json`.

## How it works

```
content/**.md ──parse──▶ library + tag profile ─┐
                                                 ├─score─▶ store UI
studydeck/catalog.json (my curated picks) ──────┘
```

- **`server.mjs`** — zero-dep backend. Parses `content/notes` + `content/reflections`
  into your "library", aggregates tags into a profile, scores the catalog against
  it, proxies arXiv (`/pdf` for cover art, `/api/arxiv` for abstracts), and
  persists wishlist/read to `data/*.json`.
- **`web/`** — vanilla HTML/CSS/JS frontend. Cover art is the arXiv PDF's first
  page rendered live in-browser with PDF.js (lazy, cached), falling back to a
  monogram capsule for topics/authors/labs.
- **`catalog.json`** — the recommendations, **curated by Claude**, spanning
  math, physics, CS, embedded/EE, robotics, controls, sensors, and comp-bio.
  Each item is grounded to specific notes via `[[wikilinks]]` in its blurb.

### Cover art precedence
1. arXiv paper → best-effort crop of **figure 1** (largest embedded image found
   on page 1, falling back to page 2), detected by walking the PDF's operator
   list in-browser. If no figure is found, falls back to a cropped snippet of
   the cover page (title through abstract) — never the whole page shrunk down.
2. author / lab → their real **photo**, from the `photo` field in `catalog.json`
3. topic (no photo) → colored monogram capsule with the title
4. library note → its first embedded image, else a monogram capsule

## Search

The top bar has a live search box. It queries arXiv for matching **papers**,
and derives **researcher** matches from the authors of those results (arXiv has
no standalone author index). Click a result to open its detail panel and add it
to your wishlist.

## Wishlist → reading → finished

Catalog items (paper / topic / author / lab) move through three stages you
control from the detail panel: **Wishlist** (want to get to) → **Reading**
(in progress) → **Finished** (done — archived to `data/read.json` with a
timestamp, feeding the next curation pass). The **Library** tab is separate and
unaffected — it's always your own vault notes, since not every finished paper
becomes one. State lives in `data/wishlist.json`, `data/reading.json`, and
`data/read.json`, all plain JSON.

## Refreshing the picks (curated by Claude)

The catalog is meant to be regrown, like an expanded `robotics-digest`. To
refresh, ask Claude:

> "refresh my studydeck catalog"

Claude re-reads the vault + `data/read.json` (what you've already consumed) and
rewrites `studydeck/catalog.json` with new cross-disciplinary picks, each tagged
with your vault's tags and blurbed with `[[wikilink]]` grounding. Reload the
page to see them. (A scheduled weekly refresh can be wired up on request.)

## Catalog item schema

```jsonc
{
  "id": "2205.04422",              // arXiv id for papers; slug otherwise
  "type": "paper",                  // paper | topic | author | lab
  "arxivId": "2205.04422",          // papers only → drives cover + abstract
  "title": "…",
  "authors": ["…"],                 // papers
  "affiliation": "…",               // authors / labs
  "year": 2022,
  "tags": ["motion-planning", …],   // lowercase; match your vault tags
  "blurb": "… [[Your Note Title]] …", // why it matches you; wikilinks render
  "link": "https://…",              // canonical URL
  "newLane": true,                   // optional: adjacent/unexplored topic
  "photo": "https://…",              // authors/labs: real photo, used as cover
  "icon": "wave-sine",               // optional (non-papers without a photo)
  "accent": "#1D9E75"                // optional capsule color (non-papers)
}
```
