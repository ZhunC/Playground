// studydeck — zero-dependency Node backend.
// Node 22+: uses built-in fetch / http / fs. No npm install required.
//
//   node studydeck/server.mjs         (run from the vault root)
//   PORT=4173 node studydeck/server.mjs
//
// Responsibilities:
//   - parse the Obsidian vault into a "library" + tag profile          (lib/vault.mjs)
//   - serve the curated catalog.json, scored against the profile       (lib/vault.mjs)
//   - build the home-page reel feed from the catalog + arXiv           (lib/feed.mjs)
//   - proxy arXiv (PDF for cover art + reel figures, export API)       (lib/arxiv.mjs)
//   - cache reels the browser builds, so later visits are instant
//   - persist wishlist / read history to studydeck/data/*.json

import http from "node:http";
import { readFile, writeFile, mkdir, rm } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { buildLibrary, buildProfile, scoreCatalog } from "./lib/vault.mjs";
import {
  cleanArxivId,
  fetchArxivMeta,
  fetchArxivPdf,
  searchPapersAndAuthors,
} from "./lib/arxiv.mjs";
import { buildFeed, discover, discoveryComplete } from "./lib/feed.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// Vault location: STUDYDECK_VAULT overrides; default assumes ws/studydeck sits beside ZhunCollection.
const VAULT_ROOT = process.env.STUDYDECK_VAULT
  ? path.resolve(process.env.STUDYDECK_VAULT)
  : path.resolve(__dirname, "..", "..", "ZhunCollection");
const WEB_DIR = path.join(__dirname, "web");
const DATA_DIR = path.join(__dirname, "data");
const CATALOG_PATH = path.join(__dirname, "catalog.json");
const WISHLIST_PATH = path.join(DATA_DIR, "wishlist.json");
const READING_PATH = path.join(DATA_DIR, "reading.json");
const READ_PATH = path.join(DATA_DIR, "read.json"); // "finished" archive
const FEED_STATE_PATH = path.join(DATA_DIR, "feed-state.json");
const DISCOVERY_PATH = path.join(DATA_DIR, "feed-discovery.json");
const REELS_DIR = path.join(DATA_DIR, "reels");
const PORT = Number(process.env.PORT) || 4173;

// Reel cache limits. A reel is at most a title card, 5 figures and a closer;
// each figure is a ~900px JPEG, so 400 KB is generous.
const MAX_BEATS = 8;
const MAX_BEAT_BYTES = 400 * 1024;
const MAX_BODY_BYTES = 4 * 1024 * 1024;

// ---------------------------------------------------------------------------
// Persistence
// ---------------------------------------------------------------------------

async function readJson(p, fallback) {
  try {
    return JSON.parse(await readFile(p, "utf8"));
  } catch {
    return fallback;
  }
}

async function writeJson(p, data) {
  await mkdir(path.dirname(p), { recursive: true });
  await writeFile(p, JSON.stringify(data, null, 2));
}

// ---------------------------------------------------------------------------
// HTTP helpers + static files
// ---------------------------------------------------------------------------

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".svg": "image/svg+xml",
  ".webp": "image/webp",
};

function sendJson(res, data, status = 200) {
  // Deliberately no Access-Control-Allow-Origin: the frontend is same-origin,
  // and a wildcard would let any page you browse read/alter your library.
  const body = JSON.stringify(data);
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(body);
}

function sendError(res, status, msg) {
  sendJson(res, { error: msg }, status);
}

// Reject state-changing requests coming from another origin. Browsers always
// reveal cross-origin intent through Origin / Sec-Fetch-Site; non-browser
// clients (curl) send neither and are allowed through.
function sameOrigin(req) {
  const site = req.headers["sec-fetch-site"];
  if (site && site !== "same-origin" && site !== "none") return false;
  const origin = req.headers.origin;
  if (origin) {
    try {
      if (new URL(origin).host !== req.headers.host) return false;
    } catch {
      return false;
    }
  }
  return true;
}

async function serveStatic(res, filePath, cache = "no-store, must-revalidate") {
  try {
    const data = await readFile(filePath);
    const ext = path.extname(filePath).toLowerCase();
    res.writeHead(200, {
      "Content-Type": MIME[ext] || "application/octet-stream",
      "Cache-Control": cache,
    });
    res.end(data);
  } catch {
    res.writeHead(404, { "Content-Type": "text/plain" });
    res.end("Not found");
  }
}

async function readBody(req, limit = MAX_BODY_BYTES) {
  const chunks = [];
  let size = 0;
  for await (const c of req) {
    size += c.length;
    if (size > limit) throw new Error("payload too large");
    chunks.push(c);
  }
  if (!chunks.length) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    return {};
  }
}

// ---------------------------------------------------------------------------
// arXiv proxy
// ---------------------------------------------------------------------------

async function proxyPdf(id, res) {
  try {
    const r = await fetchArxivPdf(id);
    if (!r.ok) return sendError(res, 502, `arxiv pdf ${r.status}`);
    const buf = Buffer.from(await r.arrayBuffer());
    res.writeHead(200, {
      "Content-Type": "application/pdf",
      "Cache-Control": "public, max-age=86400",
    });
    res.end(buf);
  } catch (e) {
    sendError(res, 502, "arxiv pdf fetch failed: " + e.message);
  }
}

async function proxyMeta(id, res) {
  try {
    sendJson(res, (await fetchArxivMeta(id)) || {});
  } catch (e) {
    sendError(res, 502, "arxiv meta failed: " + e.message);
  }
}

async function proxySearch(q, res) {
  try {
    sendJson(res, await searchPapersAndAuthors(q));
  } catch (e) {
    sendError(res, 502, "search failed: " + e.message);
  }
}

// ---------------------------------------------------------------------------
// Reel cache — the browser does the PDF work (the server cannot read PDFs),
// then hands the result back here so the next visit skips it.
// ---------------------------------------------------------------------------

// arXiv ids can contain "/" (math/0211159); keep them on one directory level.
function reelKey(id) {
  const clean = cleanArxivId(id);
  return clean ? clean.replace(/\//g, "__") : null;
}

async function getReel(id, res) {
  const key = reelKey(id);
  if (!key) return sendError(res, 400, "bad id");
  const reel = await readJson(path.join(REELS_DIR, key, "reel.json"), null);
  if (!reel) return sendError(res, 404, "not cached");
  return sendJson(res, reel);
}

async function putReel(id, req, res) {
  const key = reelKey(id);
  if (!key) return sendError(res, 400, "bad id");
  let body;
  try {
    body = await readBody(req);
  } catch (e) {
    return sendError(res, 413, e.message);
  }
  const beats = Array.isArray(body?.beats) ? body.beats : null;
  if (!beats || !beats.length) return sendError(res, 400, "no beats");
  if (beats.length > MAX_BEATS) return sendError(res, 400, `too many beats (max ${MAX_BEATS})`);

  const dir = path.join(REELS_DIR, key);
  await mkdir(dir, { recursive: true });
  const stored = [];
  let n = 0;
  for (const beat of beats) {
    const out = { ...beat };
    delete out.img;
    if (typeof beat.img === "string" && beat.img.startsWith("data:image/jpeg;base64,")) {
      const buf = Buffer.from(beat.img.slice("data:image/jpeg;base64,".length), "base64");
      // Validate it really is a JPEG rather than trusting the data URL label.
      if (buf.length > MAX_BEAT_BYTES)
        return sendError(res, 413, `beat ${n} over ${MAX_BEAT_BYTES} bytes`);
      if (!(buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff))
        return sendError(res, 400, `beat ${n} is not a JPEG`);
      const file = `beat-${n}.jpg`;
      await writeFile(path.join(dir, file), buf);
      out.img = `/reel-asset?p=${encodeURIComponent(`${key}/${file}`)}`;
    } else if (beat.img != null) {
      return sendError(res, 400, `beat ${n} image must be a base64 JPEG data URL`);
    }
    stored.push(out);
    n++;
  }

  const reel = {
    id: body.id ?? id,
    arxivId: cleanArxivId(id),
    beats: stored,
    builtAt: new Date().toISOString(),
    figureCount: stored.filter((b) => b.kind === "figure").length,
  };
  await writeJson(path.join(dir, "reel.json"), reel);
  return sendJson(res, reel);
}

async function dropReel(id, res) {
  const key = reelKey(id);
  if (!key) return sendError(res, 400, "bad id");
  await rm(path.join(REELS_DIR, key), { recursive: true, force: true });
  return sendJson(res, { dropped: key });
}

// ---------------------------------------------------------------------------
// Background discovery
//
// Each tag costs two arXiv queries (recent + all-time) and arXiv asks for a
// 3s gap, so a day's discovery takes ~20s. That is far too long to block the
// first page load on, and it only has to happen once a day.
// ---------------------------------------------------------------------------

let discoveryRun = null;
let discoveryErrors = [];

function startDiscovery(profile, cache) {
  if (discoveryRun) return discoveryRun; // never run two at once
  discoveryRun = (async () => {
    try {
      const out = await discover(profile, cache);
      await writeJson(DISCOVERY_PATH, out.cache);
      discoveryErrors = out.errors;
      const n = out.items.length;
      console.log(`discovery done: ${n} papers in cache` + (out.errors.length ? ` (${out.errors.length} errors)` : ""));
    } catch (e) {
      discoveryErrors = [e.message];
      console.error("discovery failed:", e.message);
    } finally {
      discoveryRun = null;
    }
  })();
  return discoveryRun;
}

// ---------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------

const MUTATING = new Set(["POST", "PUT", "DELETE", "PATCH"]);

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  const { pathname } = url;

  try {
    if (MUTATING.has(req.method) && !sameOrigin(req))
      return sendError(res, 403, "cross-origin request refused");

    if (pathname === "/api/data") {
      const catalog = await readJson(CATALOG_PATH, []);
      const library = await buildLibrary(VAULT_ROOT);
      const profile = buildProfile(library);
      const scored = scoreCatalog(catalog, library, profile);
      const wishlist = await readJson(WISHLIST_PATH, []);
      const reading = await readJson(READING_PATH, []);
      const read = await readJson(READ_PATH, []);
      return sendJson(res, { library, profile, catalog: scored, wishlist, reading, read });
    }

    // Home-page reel playlist. Always answered from the cache so the page
    // renders at once; today's arXiv queries run in the background and the
    // frontend picks them up on its next poll.
    if (pathname === "/api/feed") {
      const catalog = await readJson(CATALOG_PATH, []);
      const library = await buildLibrary(VAULT_ROOT);
      const profile = buildProfile(library);
      const read = await readJson(READ_PATH, []);
      const seen = await readJson(FEED_STATE_PATH, {});
      const cache = await readJson(DISCOVERY_PATH, {});
      const built = await buildFeed({
        catalog, library, profile, finished: read, seen, cache, fetchNew: false,
      });
      const pending = !discoveryComplete(profile, cache);
      if (pending) startDiscovery(profile, cache);
      return sendJson(res, {
        feed: built.feed,
        errors: [...built.errors, ...discoveryErrors],
        discovery: built.discovery,
        discovering: pending,
        mix: built.mix,
      });
    }

    if (pathname === "/api/feed-seen" && req.method === "POST") {
      const { id } = await readBody(req);
      const seen = await readJson(FEED_STATE_PATH, {});
      if (id) {
        const prev = seen[id] || { count: 0 };
        seen[id] = { count: (prev.count || 0) + 1, lastSeenAt: new Date().toISOString() };
        await writeJson(FEED_STATE_PATH, seen);
      }
      return sendJson(res, { seen: id ? seen[id] : null });
    }

    if (pathname === "/api/reel") {
      const id = url.searchParams.get("id");
      if (req.method === "GET") return getReel(id, res);
      if (req.method === "PUT") return putReel(id, req, res);
      if (req.method === "DELETE") return dropReel(id, res);
      return sendError(res, 405, "method not allowed");
    }

    if (pathname === "/reel-asset") {
      const rel = url.searchParams.get("p") || "";
      const abs = path.resolve(REELS_DIR, rel);
      if (!abs.startsWith(REELS_DIR + path.sep)) return sendError(res, 403, "forbidden");
      return serveStatic(res, abs, "public, max-age=86400");
    }

    if (pathname === "/api/wishlist" && req.method === "POST") {
      const { action, item } = await readBody(req);
      let wishlist = await readJson(WISHLIST_PATH, []);
      if (action === "add" && item?.id) {
        if (!wishlist.some((w) => w.id === item.id))
          wishlist.push({ ...item, addedAt: new Date().toISOString() });
      } else if (action === "remove" && item?.id) {
        wishlist = wishlist.filter((w) => w.id !== item.id);
      }
      await writeJson(WISHLIST_PATH, wishlist);
      return sendJson(res, { wishlist });
    }

    if (pathname === "/api/reading" && req.method === "POST") {
      const { action, item } = await readBody(req);
      let wishlist = await readJson(WISHLIST_PATH, []);
      let reading = await readJson(READING_PATH, []);
      if (action === "start" && item?.id) {
        // Start reading: move out of the wishlist, into in-progress.
        if (!reading.some((r) => r.id === item.id))
          reading.push({ ...item, startedAt: new Date().toISOString() });
        wishlist = wishlist.filter((w) => w.id !== item.id);
      } else if (action === "remove" && item?.id) {
        reading = reading.filter((r) => r.id !== item.id);
      }
      await writeJson(WISHLIST_PATH, wishlist);
      await writeJson(READING_PATH, reading);
      return sendJson(res, { wishlist, reading });
    }

    if (pathname === "/api/read" && req.method === "POST") {
      const { action, item } = await readBody(req);
      let wishlist = await readJson(WISHLIST_PATH, []);
      let reading = await readJson(READING_PATH, []);
      let read = await readJson(READ_PATH, []);
      if (action === "add" && item?.id) {
        // Mark finished: archive to read history, drop from wishlist + reading.
        if (!read.some((r) => r.id === item.id))
          read.push({ ...item, readAt: new Date().toISOString() });
        wishlist = wishlist.filter((w) => w.id !== item.id);
        reading = reading.filter((r) => r.id !== item.id);
      } else if (action === "remove" && item?.id) {
        read = read.filter((r) => r.id !== item.id);
      }
      await writeJson(WISHLIST_PATH, wishlist);
      await writeJson(READING_PATH, reading);
      await writeJson(READ_PATH, read);
      return sendJson(res, { wishlist, reading, read });
    }

    if (pathname === "/pdf") return proxyPdf(url.searchParams.get("id"), res);
    if (pathname === "/api/arxiv") return proxyMeta(url.searchParams.get("id"), res);
    if (pathname === "/api/search") return proxySearch(url.searchParams.get("q"), res);

    if (pathname === "/asset") {
      const rel = url.searchParams.get("p") || "";
      const abs = path.resolve(VAULT_ROOT, rel);
      if (!abs.startsWith(VAULT_ROOT)) return sendError(res, 403, "forbidden");
      return serveStatic(res, abs);
    }

    // Static frontend
    let file = pathname === "/" ? "/index.html" : pathname;
    const abs = path.join(WEB_DIR, file);
    if (!abs.startsWith(WEB_DIR)) return sendError(res, 403, "forbidden");
    return serveStatic(res, abs);
  } catch (e) {
    sendError(res, 500, e.message);
  }
});

server.listen(PORT, () => {
  console.log(`studydeck running → http://localhost:${PORT}`);
  console.log(`vault: ${VAULT_ROOT}`);
});
