# studydeck: fix refresh + GenAI-tailored paper search

> **Scope note.** This plan originally had a Part 2 that added real accounts
> with sign-up and login. **Accounts are dropped.** studydeck is single-user by
> design — one owner, no login, no per-user state — so everything that existed
> only to separate one user from another is gone: the `users` / `sessions` /
> `llm_usage` tables, password hashing, session cookies, the auth middleware,
> `lib/db.mjs`, `lib/auth.mjs`, `web/login.html`, the JSON→per-user migration
> script, the per-user token cap, and the owner-vs-other-user split on `/asset`
> and the vault profile. See "Single user, by design" in the README.
>
> What survives is Part 1 (unattended refresh) and Part 3 (turning a plain
> language request into arXiv searches), both of which are useful for one
> person. Part 0 is done.

## Context

studydeck is a zero-dep Node 22 server (`server.mjs`) plus a vanilla frontend
(`web/app.js`). It reads the ZhunCollection vault, builds a tag profile, scores
a hand-curated `catalog.json`, proxies arXiv, and serves the reel feed.

**Why refresh is broken (diagnosed):**
- `refresh-log.txt` (last run Mon 2026-10-12 00:05): `Failed to authenticate: OAuth session expired and could not be refreshed`. The run dies 2 s after start.
- `refresh-catalog.cmd` calls the MSIX-sandboxed CLI copy at `AppData\Local\Packages\Claude_pzs8sxrjxfjjc\LocalCache\Roaming\npm\claude.cmd`. That copy holds its own OAuth session, which expired and cannot refresh headlessly. The interactive CLI is a different install (`AppData\Roaming\npm\claude.ps1`).
- `catalog.json` was last written 2026-09-21. Every weekly run since has failed silently.
- The scheduled task reports `Last Result: 0` because `wscript` → `cmd` swallows the CLI's exit code, so there is no failure signal.
- `--model claude-sonnet-5` is not a current model id (current: `claude-sonnet-5-5`).
- `refresh-catalog.cmd` truncates the log with `>` each run, so failure history is lost.
- The refresh prompt bans web access, so new arXiv ids are never verified. Hallucinated ids are possible.

**Goal:** (1) a refresh that works unattended and reports failure, and (2) a
box where you describe what you want in plain language and an LLM turns it into
arXiv searches and a ranked, explained shelf.

Decision made: the Anthropic API key is called directly from `server.mjs`, with
no CLI spawn.

## Architecture

One new server module path replaces the CLI job:

```
your text / vault profile ──▶ LLM "planner" (structured JSON: arXiv queries + intent)
                                │
                                ▼
                       arXiv search (existing search logic, refactored to return data)
                                │
                                ▼
                       LLM "ranker" (scores + 1-line why-this-for-you per paper)
                                │
                                ▼
                       stored shelf ──▶ existing card UI
```

The weekly refresh becomes the same pipeline, run with your stored profile as
input. Every paper id in the output comes from a real arXiv response, so ids
cannot be hallucinated.

## Part 0: Move to the company remote — DONE

Target: `https://github.com/ZhunC/Playground.git`.

1. ~~`git init -b main`, add `.gitignore`.~~ Done.
2. ~~Make the vault path configurable via `STUDYDECK_VAULT`.~~ Done
   ([server.mjs:31](../server.mjs#L31)); the server degrades to an empty library
   when `content/` is missing, since `walk()` catches readdir errors.
3. ~~Add `.env.example`.~~ Done. `STUDYDECK_OWNER_EMAIL` was removed with the
   accounts work — nothing in a single-user app identifies a user.
4. ~~Initial commit and push.~~ Done.
5. `catalog.json` + `.bak` are committed. Their blurbs contain `[[wikilinks]]`
   naming your personal vault notes, visible to anyone with repo access. Still
   true — worth remembering if the repo is ever made public.
6. Later work happens as commits on a branch, so it can continue from another
   machine with `git clone`.

## Part 1: Fix refresh

1. **Back up first** (CLAUDE.md rule): copy `refresh-catalog.cmd` →
   `refresh-catalog__catalog.cmd`, `refresh-prompt.txt` →
   `refresh-prompt__catalog.txt`, `server.mjs` → `server__catalog.mjs`.
   Because the Windows scheduler scripts are gitignored, the scheduled-task fix
   (step 5) stays local to the home PC; elsewhere run `node refresh.mjs` from
   that machine's scheduler.
2. Add `lib/llm.mjs`: a `callClaude({system, messages, schema})` helper using
   `fetch("https://api.anthropic.com/v1/messages")`, `ANTHROPIC_API_KEY` from
   env, tool-use/structured output for JSON, prompt caching on the static
   system prompt, retries on 429/529.
3. Add `lib/pipeline.mjs` with `planQueries(profile, request)`,
   `searchArxiv(queries)` (reuse [lib/arxiv.mjs](../lib/arxiv.mjs), already
   extracted), and `rankResults(profile, candidates)`.
4. Add `refresh.mjs` (CLI entry): builds the profile from the vault via
   `buildLibrary()` / `buildProfile()` (already in
   [lib/vault.mjs](../lib/vault.mjs)), runs the pipeline, writes the shelf.
   Exits non-zero on any failure.
5. Replace `refresh-catalog.cmd` body with
   `node refresh.mjs >> refresh-log.txt 2>&1` (append, timestamped) and
   propagate `%ERRORLEVEL%`. Set `refresh-hidden.vbs` to `WScript.Quit` with
   that code, so Task Scheduler shows a real Last Result.
6. Add a `POST /api/refresh` endpoint + "Refresh now" button, so failures are
   visible in the UI instead of only in a log file.
7. Keep `catalog.json` as the hand-curated base shelf. Move the old prompt to
   `archive/refresh-prompt.txt` with a one-line "retired: replaced by
   refresh.mjs API pipeline" note.

## Part 2: GenAI request tailoring

- **A stored profile you can edit:** free-text "what are you trying to learn /
  why", background level, optional seed topics. The planner LLM turns this into
  `{interests[], background, depth, avoid[], goals}`, kept in `data/` as plain
  JSON like every other piece of state. No onboarding flow is needed — there is
  no sign-up to hang it off.
- **"Ask" box** beside the keyword search in `web/index.html`: you type
  something vague ("I keep getting lost when people talk about Lie groups in
  state estimation"). `POST /api/ask` runs planner → arXiv → ranker with the
  stored profile as context and returns cards with a per-paper "why this for
  you" line, rendered through the existing card/detail code in `web/app.js`.
- **Clarify loop:** if the planner returns `needsClarification`, the UI shows
  one follow-up question instead of results.
- **Feedback:** wishlist / finished / dismiss actions feed back into the
  profile for the next refresh.
- The vault tag profile is merged into the planner context, so results stay
  grounded in your notes.

## Files

- New: `lib/llm.mjs`, `lib/pipeline.mjs`, `refresh.mjs`
- Already extracted: `lib/vault.mjs`, `lib/arxiv.mjs`, `lib/feed.mjs`
- Modified: `server.mjs` (new endpoints), `web/app.js` (Ask box, refresh
  button), `web/index.html`, `refresh-catalog.cmd`, `refresh-hidden.vbs`,
  `README.md`
- Added per the reproducibility rules: `MANIFEST.md` mapping `catalog.json` /
  shelves / `refresh-log.txt` to the producing script; model id and arXiv
  `max_results` as named constants.

## Verification

1. `node refresh.mjs` with a valid key → shelf written, log appended, exit 0.
   With `ANTHROPIC_API_KEY` unset → exit non-zero, clear error in the log.
2. `schtasks /run /tn StudyDeckRefresh` → `Last Result` reflects the real exit
   code.
3. Ask box: an ambiguous request returns arXiv-backed cards with explanations;
   every `arxivId` resolves via `/api/arxiv`.
4. Rate-limit behaviour: the LLM path and the arXiv path both survive a 429
   without losing the run (arXiv already backs off and resumes — see the README).

## Open items you still need to decide (improvised defaults in this plan)

- Model ids: planner `claude-sonnet-5-5`, ranker `claude-haiku-5-5` (cost).
  Not chosen by you.
- A daily token cap for your own use, to bound cost. No value set. This is the
  one piece of the dropped accounts work that may still be worth keeping, since
  it limits spend rather than separating users.
- Whether the Ask box replaces the keyword search or sits beside it.
- Whether your company allows a personal GitHub repo (`ZhunC/...`) and a
  personal API key on company machines. Check before cloning there.
