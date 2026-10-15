# studydeck: fix refresh + accounts + GenAI-tailored paper search

## Context

studydeck (`C:\Users\Gaming pc\Documents\ws\studydeck`, not a git repo) is a zero-dep Node 22 server (`server.mjs`, 539 lines) plus a vanilla frontend (`web/app.js`). It reads the ZhunCollection vault, builds a tag profile, scores a hand-curated `catalog.json`, and proxies arXiv.

**Why refresh is broken (diagnosed):**
- `refresh-log.txt` (last run Mon 2026-10-12 00:05): `Failed to authenticate: OAuth session expired and could not be refreshed`. The run dies 2 s after start.
- `refresh-catalog.cmd` calls the MSIX-sandboxed CLI copy at `AppData\Local\Packages\Claude_pzs8sxrjxfjjc\LocalCache\Roaming\npm\claude.cmd`. That copy holds its own OAuth session, which expired and cannot refresh headlessly. Your interactive CLI is a different install (`AppData\Roaming\npm\claude.ps1`).
- `catalog.json` was last written 2026-09-21. Every weekly run since has failed silently.
- The scheduled task reports `Last Result: 0` because `wscript` → `cmd` swallows the CLI's exit code. You get no failure signal.
- `--model claude-sonnet-5` is not a current model id (current: `claude-sonnet-5-5`).
- `refresh-catalog.cmd` truncates the log with `>` each run, so failure history is lost.
- The refresh prompt bans web access, so new arXiv ids are never verified. Hallucinated ids are possible.

**Goal:** You get (1) a refresh that works unattended and reports failure, and (2) real user accounts where each user describes what they want in plain language and an LLM turns that into arXiv searches and a ranked, explained shelf.

Decisions you made: Anthropic API key called directly from `server.mjs` (no CLI spawn); real accounts with sign-up/login.

## Architecture

One new server module path replaces the CLI job:

```
user text / profile ──▶ LLM "planner" (structured JSON: arXiv queries + intent)
                          │
                          ▼
                 arXiv search (existing proxySearch logic, refactored to return data)
                          │
                          ▼
                 LLM "ranker" (scores + 1-line why-this-for-you per paper)
                          │
                          ▼
                 per-user shelf (stored) ──▶ existing card UI
```

The weekly refresh becomes the same pipeline run per user with their stored profile as input. Every paper id in output comes from a real arXiv response, so ids cannot be hallucinated.

## Part 0: Move to the company remote (do first, before any code edits)

Target: `https://github.com/ZhunC/Playground.git`. `git ls-remote` returned no refs, so the repo is empty.

1. In `ws/studydeck`: `git init -b main`, add `.gitignore` with `data/`, `refresh-log.txt`, `*.db`, `refresh-catalog.cmd`, `refresh-hidden.vbs`, `start-hidden.vbs`, `.env`.
2. Make the vault path configurable: `VAULT_ROOT = process.env.STUDYDECK_VAULT || <current relative path>` (`server.mjs:20`). Without this, the server breaks on any machine without `../../ZhunCollection`. The server already degrades to an empty library when `content/` is missing (`walk()` catches readdir errors).
3. Add `.env.example` (`ANTHROPIC_API_KEY=`, `STUDYDECK_VAULT=`, `STUDYDECK_OWNER_EMAIL=`). No secrets get committed.
4. Initial commit of the current (pre-change) state, `git remote add origin https://github.com/ZhunC/Playground.git`, `git push -u origin main`. I confirm with you right before the push.
5. `catalog.json` + `.bak` are committed (you did not exclude them). Their blurbs contain `[[wikilinks]]` naming your personal vault notes, visible to anyone with repo access.
6. All later parts happen as commits on a branch in this repo, so work continues from the company machine with `git clone`.

## Part 1: Fix refresh

1. **Back up first** (CLAUDE.md rule): copy `refresh-catalog.cmd` → `refresh-catalog__catalog.cmd` and `refresh-prompt.txt` → `refresh-prompt__catalog.txt`, `server.mjs` → `server__catalog.mjs`. The Part 0 commit also preserves the pre-change state.
   Because the Windows scheduler scripts are gitignored, the scheduled-task fix (steps 5) stays local to your home PC. On the company machine you run `node refresh.mjs` from cron or Task Scheduler there.
2. Add `lib/llm.mjs`: a `callClaude({system, messages, schema})` helper using `fetch("https://api.anthropic.com/v1/messages")`, `ANTHROPIC_API_KEY` from env, tool-use/structured output for JSON, prompt caching on the static system prompt, retries on 429/529.
3. Add `lib/pipeline.mjs` with `planQueries(profile, request)`, `searchArxiv(queries)` (refactor of `proxySearch` at `server.mjs:337` into a pure function), `rankResults(profile, candidates)`.
4. Add `refresh.mjs` (CLI entry): for the owner account, builds the profile from the vault via existing `buildLibrary()` / `buildProfile()` (`server.mjs:~145`, `:183`; move into `lib/vault.mjs`), runs the pipeline, writes the shelf. Exits non-zero on any failure.
5. Replace `refresh-catalog.cmd` body with `node refresh.mjs >> refresh-log.txt 2>&1` (append, timestamped) and propagate `%ERRORLEVEL%`. Set `refresh-hidden.vbs` to `WScript.Quit` with that code, so Task Scheduler shows a non-zero Last Result.
6. Add a `POST /api/refresh` endpoint + "Refresh now" button so you can trigger and see errors in the UI.
7. Keep `catalog.json` as the hand-curated base shelf. Move the old prompt to `archive/refresh-prompt.txt` with a one-line "retired: replaced by refresh.mjs API pipeline" note.

## Part 2: Accounts

Zero-dep stays possible with Node 22.19 built-ins:
- **Storage:** `node:sqlite` (`DatabaseSync`, present in your Node; prints an experimental warning). Tables: `users(id, email, pw_hash, created_at)`, `sessions(token_hash, user_id, expires_at)`, `profiles(user_id, json)`, `items(user_id, item_id, stage, json, ts)` replacing `data/wishlist|reading|read.json`, `shelves(user_id, json, generated_at)`, `llm_usage(user_id, day, tokens)`.
- **Passwords:** `crypto.scrypt` with per-user salt; `crypto.timingSafeEqual` on verify.
- **Sessions:** random 32-byte token in an `HttpOnly; SameSite=Lax; Secure` cookie (Secure only when served over HTTPS); store its SHA-256 only.
- **Routes:** `POST /api/auth/signup|login|logout`, `GET /api/me`. Middleware resolves the user on every `/api/*` call; existing wishlist/reading/read routes switch from JSON files to per-user rows.
- **Migration:** a one-shot script imports current `data/*.json` into your (owner) account.
- **Owner-only vault:** `/asset` and the vault-derived library/profile are served only to the owner account (env `STUDYDECK_OWNER_EMAIL`). Other users have no vault; their library tab is empty or hidden.
- **Hardening needed before exposing to others:** login rate limit, per-user daily LLM token cap (reads `llm_usage`), remove `Access-Control-Allow-Origin: *` from `sendJson` (`server.mjs:~407`), HTTPS via a reverse proxy (Caddy) or a tunnel. Email verification and password reset are out of scope for v1.

## Part 3: GenAI request tailoring

- **Onboarding page** after signup: free-text "what are you trying to learn / why", background level, and optional seed topics. The planner LLM turns this into a stored structured profile `{interests[], background, depth, avoid[], goals}` that the user can view and edit.
- **"Ask" box** (replaces or sits beside the keyword search in `web/index.html`): the user types something vague ("I keep getting lost when people talk about Lie groups in state estimation"). `POST /api/ask` runs planner → arXiv → ranker with the stored profile as context and returns cards with a per-paper "why this for you" line, rendered through the existing card/detail code in `web/app.js`.
- **Clarify loop:** if the planner returns `needsClarification`, the UI shows one follow-up question instead of results.
- **Feedback:** wishlist / finished / dismiss actions feed back into the profile for the next refresh.
- For the owner, the vault tag profile is merged into the planner context, so your results stay grounded in your notes; `[[wikilink]]` blurbs stay owner-only.

## Files

- New: `lib/llm.mjs`, `lib/pipeline.mjs`, `lib/vault.mjs`, `lib/db.mjs`, `lib/auth.mjs`, `refresh.mjs`, `scripts/migrate-json.mjs`, `web/login.html`, `web/onboard.html`
- Modified: `server.mjs` (router, auth middleware, new endpoints), `web/app.js` (auth state, Ask box, refresh button), `web/index.html`, `refresh-catalog.cmd`, `refresh-hidden.vbs`, `README.md`
- Added per your reproducibility rules: `MANIFEST.md` mapping `catalog.json` / shelves / `refresh-log.txt` to the producing script; model id and arXiv `max_results` as named constants.

## Verification

1. `node refresh.mjs` with a valid key → shelf written, log appended, exit 0. With `ANTHROPIC_API_KEY` unset → exit non-zero, clear error in log.
2. `schtasks /run /tn StudyDeckRefresh` → `Last Result` reflects real exit code.
3. Start via `.claude/launch.json` (`studydeck`, port 4173) in the browser pane: sign up a second test account, confirm it cannot reach `/asset` or the owner's items; log in as owner, confirm migrated wishlist/reading/read.
4. Ask box: an ambiguous request returns arXiv-backed cards with explanations; every `arxivId` resolves via `/api/arxiv`.
5. Exceed the daily token cap on the test account → 429 with a readable message.

## Open items you still need to decide (improvised defaults in this plan)

- Model ids: planner `claude-sonnet-5-5`, ranker `claude-haiku-5-5` (cost). Not chosen by you.
- Per-user daily token cap: no value set yet.
- Where it gets hosted (local LAN, tunnel, VPS). This decides the HTTPS approach.
- Whether other users see your curated `catalog.json` shelf or only their own generated one.
- Repo layout: studydeck goes at the root of `Playground` (improvised; Playground could instead hold it under `studydeck/`).
- Branch name `main` for the initial push (improvised).
- Whether your company allows a personal GitHub repo (`ZhunC/...`) and a personal API key on company machines. Check this before you clone it there.
