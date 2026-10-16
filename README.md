# studydeck

A short-video feed for papers. The home page is a **vertical reel rotation**:
each paper becomes a silent, auto-advancing sequence of its own figures, with
each figure's real caption lifted out of the PDF. Swipe for the next paper, tap
to step through beats, and save/start/finish from the rail. What's new comes
from your arXiv category digest; the classics are curated picks scored against
the tag profile studydeck builds from your Obsidian vault.

Behind it sits the original "Steam store, but for study": the **Papers** tab
still has the hero card and the "because you learned X" shelves.

## Single user, by design

studydeck is a **personal tool for one person — its owner.** There are no
accounts, no login, no per-user state, and none are planned. Everything it
knows is yours: one vault, one `catalog.json`, one wishlist, one reel cache.

This is a deliberate constraint, not a missing feature, and a few things follow
from it:

- **Run it on `localhost`.** `/asset?p=` serves files from your vault root and
  the API has no authentication, so anyone who can reach the port can read your
  notes and alter your library. The same-origin check on mutating requests
  stops a web page you happen to be visiting from poking the API; it is not a
  substitute for auth.
- **To reach it from a phone or TV, use a tunnel** (Cloudflare Tunnel,
  Tailscale) rather than hosting it. Your machine stays the server and nothing
  is publicly exposed.
- **It cannot be shared.** Wishlist, reading and finished state live in single
  global JSON files under `data/`; a second person would overwrite yours.
- **arXiv access assumes one user.** The discovery budget is 5 requests a day
  from a single IP. Several people behind one server would trip arXiv's traffic
  guard, which blocks for tens of minutes.

## Run it

```bash
STUDYDECK_VAULT="/path/to/ZhunCollection" node server.mjs
```

Then open http://localhost:4173. No `npm install` — it uses only Node 22
built-ins (`http`, `fs`, `fetch`). Requires internet (fetches arXiv PDFs,
abstracts and search results live). In Claude Code you can also launch it from
the `studydeck` entry in `.claude/launch.json`.

Without `STUDYDECK_VAULT` the server still runs: the feed works, but every
match score floors out and "because you wrote …" is empty, since there is no
vault to profile.

## How it works

```
content/**.md ──parse──▶ library + tag profile ─┬─score─▶ Papers tab
                                                 │
catalog.json (curated picks) ───────────────────┼─────────▶ /api/feed ──▶ reel feed
                                                 │          (classics)
arXiv daily category listings ───────────────────┘          (what's new)
```

- **`server.mjs`** — zero-dep router. Serves `/api/data` (store), `/api/feed`
  (the reel playlist), proxies arXiv, caches built reels, and persists
  wishlist/reading/read to `data/*.json`.
- **`lib/vault.mjs`** — vault parsing, tag profile, catalog scoring.
- **`lib/feed.mjs`** — the playlist: curated catalog papers interleaved with
  arXiv's daily category listings, age-tiered, de-duplicated and rotated.
- **`lib/arxiv.mjs`** — Atom parsing, search and category listings,
  rate-limited to one request every 3s as arXiv asks, with backoff on 429.
- **`web/figures.js`** — figure and caption geometry. Pure functions, no DOM,
  so it can be tested headlessly (see `tools/figure-probe`).
- **`web/pdfreel.js`** — PDF.js + canvas: turns a paper into figure beats.
- **`web/reel.js`** — the player: scroll-snap sections, beat timing, rail.
- **`catalog.json`** — the curated recommendations, spanning math, physics, CS,
  embedded/EE, robotics, controls, sensors, and comp-bio. Each item is grounded
  to specific notes via `[[wikilinks]]` in its blurb.

## The feed

Each reel is **a title card → up to 5 figures → a closer**. The closer ties a
curated paper back to the notes that earned it a place, and shows a digest
paper the arXiv categories it was filed under. Beats advance on a dwell time
scaled to caption length (3-9s); the last beat rolls into the next reel on its
own.

| input | effect |
|---|---|
| scroll / swipe / ↑ ↓ / j k | previous / next reel |
| click left or right half, ← → | previous / next beat |
| space | pause |
| rail ★ ▶ ✓ | wishlist / reading / finished |
| ⓘ ↗ | detail panel / open on arXiv |
| esc | leave the feed for the Papers tab |

### How a figure is found

Captions drive the search, not page order. Pass 1 reads the text layer to find
pages carrying a `Figure N:` line; pass 2 pulls the operator list only for those
pages and matches artwork to each caption. **Most figures in these papers are
vector art, not images** — Figure 1 of Marcucci 2022 is on page 8 of 32 and is
drawn with 160 paths — so path bounding boxes count as artwork alongside painted
images. Measured over the 28 catalog papers: 125 of 132 captions got a figure.

Reels are cached: the browser does the PDF work (the server cannot read PDFs)
and `PUT /api/reel` stores the JPEGs under `data/reels/`, so the second visit is
instant.

### Where new papers come from

New material is the **arXiv daily category listing** — the API equivalent of the
arXiv digest emails. Every subscribed category is listed every day, newest
first, with **no relevance filtering**: a digest is a digest. Vault tags are not
used to find papers, because categories are far wider in scope.

`FEED.DIGEST_CATEGORIES` holds the subscription — 14 categories:

| group | categories |
|---|---|
| Robotics & control | `cs.RO` `eess.SY` `math.OC` `math.DS` |
| Machine learning & vision | `cs.LG` `cs.CV` `cs.AI` `stat.ML` |
| Signal processing & hardware | `eess.SP` `eess.IV` `cs.AR` |
| Thermo, fluids & applied physics | `physics.flu-dyn` `cond-mat.stat-mech` `physics.app-ph` |

That last group is the only route to the thermodynamics material the catalog
never covered.

`FEED.EXCLUDE_CATEGORIES` drops philosophy and history-of-science papers
(`physics.hist-ph`, `math.HO`, `physics.soc-ph`). The check looks at **every**
category on a paper, not just its primary one — philosophy of statistical
mechanics reaches a thermodynamics subscription by cross-listing, so filtering
on the primary category alone would miss it.

### Classic vs recent

Every reel carries an age badge, derived from the paper's **own submission
date** — never from which request found it, since retention keeps a paper in
the cache for two weeks after it stops being new.

| tier | age | badge |
|---|---|---|
| `recent` | ≤ `RECENT_DAYS` = 30 days | **new this month** |
| `year` | ≤ `YEAR_DAYS` = 365 days | this year |
| `classic` | older | **classic · 2017** |

The two halves of the feed are different in kind, so they are presented
differently:

| | curated catalog | arXiv digest |
|---|---|---|
| found by | hand, scored against your vault | category listing |
| shows | `match%`, "because you wrote …" | its arXiv categories, "filed under …" |
| typically | `classic` | `new this month` |

A digest paper shows **no `match%`**. It came from a category listing rather
than a relevance query, so there is no measured match against your vault to
report, and printing one would be inventing a number.

`interleaveByShare` gives `RECENT_SHARE` = 70% of slots to recent-tier papers
and the rest to the curated classics. `GET /api/feed` reports the realized split
in `mix`; it falls short of the target once you have watched many of the fresh
papers, since seen reels are demoted to the end.

Discovery runs **in the background** and is deliberately slow. The whole
subscription is not listed daily — `CATEGORIES_PER_DAY` = 5 of the 14 rotate,
so a full sweep takes three days, well inside the 14-day retention. That is
**5 requests a day**, spaced 6s, about 30s of work. `/api/feed` answers from
the cache immediately (~0.7s) and the frontend appends new reels when they
land, without interrupting whatever is playing. Listings are retained for
`RETENTION_DAYS` = 14 in `data/feed-discovery.json`.

**On rate limits:** arXiv's traffic guard is stricter than its documented
1-request-per-3s, and a tripped block lasts a long time — tens of minutes,
alternating `429 Rate exceeded.` (a 14-byte plain-text body, not Atom, which
would otherwise parse as an empty category) with a `503` HTML page. The gap is
also per-process, so a second process querying arXiv at the same time defeats
it. Hence the conservative budget above. The fetcher backs off twice on either
status and then abandons the sweep rather than paying the penalty once per
remaining category; the partial day is cached, so the next page load resumes
where it stopped.

Set `FEED.ARXIV_DISCOVERY = false` in `lib/feed.mjs` to restrict the feed to
`catalog.json`.

### Cover art precedence
1. arXiv paper → best-effort crop of the largest piece of artwork (image or
   vector) on page 1, falling back to page 2, detected by walking the PDF's
   operator list in-browser. If no figure is found, falls back to a cropped
   snippet of the cover page (title through abstract) — never the whole page
   shrunk down. Card covers only look at the first two pages; reels search the
   whole paper by caption.
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
control from the detail panel or the feed's rail: **Wishlist** (want to get to)
→ **Reading** (in progress) → **Finished** (done — archived to `data/read.json`
with a timestamp, feeding the next curation pass; finished papers drop out of
the feed). The **Library** tab is separate and
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
