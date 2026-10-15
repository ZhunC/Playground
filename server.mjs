// studydeck — zero-dependency Node backend.
// Node 22+: uses built-in fetch / http / fs. No npm install required.
//
//   node studydeck/server.mjs         (run from the vault root)
//   PORT=4173 node studydeck/server.mjs
//
// Responsibilities:
//   - parse the Obsidian vault into a "library" + tag profile
//   - serve the curated catalog.json (my recommendations), scored against the profile
//   - proxy arXiv (PDF for cover art, export API for detail panels) — CORS-safe
//   - persist wishlist / read history to studydeck/data/*.json

import http from "node:http";
import { readFile, readdir, stat, writeFile, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// Vault location: STUDYDECK_VAULT overrides; default assumes ws/studydeck sits beside ZhunCollection.
const VAULT_ROOT = process.env.STUDYDECK_VAULT
  ? path.resolve(process.env.STUDYDECK_VAULT)
  : path.resolve(__dirname, "..", "..", "ZhunCollection");
const CONTENT_DIR = path.join(VAULT_ROOT, "content");
const WEB_DIR = path.join(__dirname, "web");
const DATA_DIR = path.join(__dirname, "data");
const CATALOG_PATH = path.join(__dirname, "catalog.json");
const WISHLIST_PATH = path.join(DATA_DIR, "wishlist.json");
const READING_PATH = path.join(DATA_DIR, "reading.json");
const READ_PATH = path.join(DATA_DIR, "read.json"); // "finished" archive
const PORT = Number(process.env.PORT) || 4173;

// Folders under content/ that count as your "library" (notes you own).
const LIBRARY_DIRS = ["notes", "reflections"];

// ---------------------------------------------------------------------------
// Vault parsing
// ---------------------------------------------------------------------------

async function walk(dir) {
  const out = [];
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...(await walk(full)));
    else if (e.isFile() && e.name.toLowerCase().endsWith(".md")) out.push(full);
  }
  return out;
}

function splitFrontmatter(raw) {
  if (!raw.startsWith("---")) return { fm: "", body: raw };
  const end = raw.indexOf("\n---", 3);
  if (end === -1) return { fm: "", body: raw };
  const fm = raw.slice(3, end).trim();
  const body = raw.slice(end + 4).replace(/^\s*\n/, "");
  return { fm, body };
}

// Minimal, forgiving YAML-frontmatter reader for the fields we care about.
function parseFrontmatter(fm) {
  const out = { title: null, tags: [] };
  const lines = fm.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const titleM = line.match(/^title:\s*(.+)$/);
    if (titleM) out.title = titleM[1].trim().replace(/^["']|["']$/g, "");

    const tagsM = line.match(/^tags:\s*(.*)$/);
    if (tagsM) {
      const rest = tagsM[1].trim();
      if (rest.startsWith("[")) {
        // inline list: [a, b, c]
        out.tags = rest
          .replace(/^\[|\]$/g, "")
          .split(",")
          .map((t) => cleanTag(t))
          .filter(Boolean);
      } else if (rest) {
        // single value on same line, e.g. `tags: -embedded/simulink`
        const t = cleanTag(rest);
        if (t) out.tags.push(t);
      } else {
        // block list on following lines
        for (let j = i + 1; j < lines.length; j++) {
          const bm = lines[j].match(/^\s*-\s*(.+)$/);
          if (!bm) break;
          const t = cleanTag(bm[1]);
          if (t) out.tags.push(t);
        }
      }
    }
  }
  return out;
}

function cleanTag(t) {
  return t
    .trim()
    .replace(/^["']|["']$/g, "")
    .replace(/^#/, "")
    .replace(/^-+/, "") // strip stray leading dashes (e.g. "-sw_dev")
    .replace(/\/.*$/, "") // collapse nested tags: embedded/simulink -> embedded
    .toLowerCase()
    .trim();
}

function firstImage(body) {
  const wiki = body.match(/!\[\[([^\]]+?)\]\]/);
  if (wiki) return { kind: "wiki", ref: wiki[1].split("|")[0].trim() };
  const md = body.match(/!\[[^\]]*\]\(([^)]+)\)/);
  if (md) return { kind: "md", ref: md[1].trim() };
  return null;
}

function excerpt(body, n = 240) {
  const text = body
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/!\[\[[^\]]*\]\]/g, " ")
    .replace(/\[\[([^\]|]+)(\|[^\]]+)?\]\]/g, "$1")
    .replace(/[#>*_`$]/g, "")
    .replace(/\s+/g, " ")
    .trim();
  return text.slice(0, n);
}

async function resolveAsset(ref) {
  // Try common Obsidian asset locations; return a URL the frontend can load.
  const candidates = [
    path.join(CONTENT_DIR, "assets", ref),
    path.join(CONTENT_DIR, ref),
    path.join(VAULT_ROOT, ref),
  ];
  for (const c of candidates) {
    if (existsSync(c)) {
      return "/asset?p=" + encodeURIComponent(path.relative(VAULT_ROOT, c));
    }
  }
  return null;
}

async function buildLibrary() {
  const files = [];
  for (const d of LIBRARY_DIRS) files.push(...(await walk(path.join(CONTENT_DIR, d))));

  const library = [];
  for (const f of files) {
    let raw;
    try {
      raw = await readFile(f, "utf8");
    } catch {
      continue;
    }
    const { fm, body } = splitFrontmatter(raw);
    const meta = parseFrontmatter(fm);
    const base = path.basename(f, ".md");
    const title = meta.title || base;
    // Skip auto-generated index/section stubs with no tags and short bodies.
    if (meta.tags.length === 0 && body.trim().length < 200) continue;

    const img = firstImage(body);
    let image = null;
    if (img && img.kind === "wiki") image = await resolveAsset(img.ref);
    else if (img && img.kind === "md" && !/^https?:/.test(img.ref)) image = await resolveAsset(img.ref);
    else if (img && img.kind === "md") image = img.ref;

    const rel = path.relative(VAULT_ROOT, f).split(path.sep).join("/");
    library.push({
      id: rel,
      title,
      tags: meta.tags,
      excerpt: excerpt(body),
      image,
      path: rel,
      section: rel.split("/")[1] || "notes", // application / theory / projects
    });
  }
  return library;
}

function buildProfile(library) {
  const counts = {};
  for (const n of library) for (const t of n.tags) counts[t] = (counts[t] || 0) + 1;
  const profile = Object.entries(counts)
    .map(([tag, count]) => ({ tag, count }))
    .sort((a, b) => b.count - a.count);
  return profile;
}

// ---------------------------------------------------------------------------
// Catalog scoring
// ---------------------------------------------------------------------------

function scoreCatalog(catalog, library, profile) {
  const weight = Object.fromEntries(profile.map((p) => [p.tag, p.count]));
  const maxW = profile.length ? profile[0].count : 1;
  const ownedTitles = new Set(library.map((n) => n.title.toLowerCase()));

  return catalog.map((item) => {
    const tags = (item.tags || []).map((t) => t.toLowerCase());
    let raw = 0;
    const matched = [];
    for (const t of tags) {
      if (weight[t]) {
        raw += weight[t];
        matched.push(t);
      }
    }
    // Normalize to a friendly 0-99 "match %". New lanes get a modest floor.
    const denom = maxW * Math.min(3, tags.length || 1);
    let match = denom ? Math.round((raw / denom) * 100) : 0;
    if (item.newLane) match = Math.max(match, 40);
    match = Math.min(99, Math.max(item.newLane ? 35 : 5, match));

    // "Because you learned X": notes sharing tags with this item.
    const because = library
      .filter((n) => n.tags.some((t) => tags.includes(t)))
      .map((n) => ({ title: n.title, path: n.path }))
      .slice(0, 4);

    return {
      ...item,
      tags,
      match,
      matchedTags: matched,
      because: item.because?.length ? item.because : because,
      owned: item.title ? ownedTitles.has(item.title.toLowerCase()) : false,
    };
  });
}

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
// arXiv proxy
// ---------------------------------------------------------------------------

const UA = "studydeck/1.0 (personal study app)";

async function proxyPdf(id, res) {
  const clean = String(id).replace(/[^0-9a-zA-Z.\/v_-]/g, "");
  const url = `https://arxiv.org/pdf/${clean}`;
  try {
    const r = await fetch(url, { headers: { "User-Agent": UA } });
    if (!r.ok) return sendError(res, 502, `arxiv pdf ${r.status}`);
    const buf = Buffer.from(await r.arrayBuffer());
    res.writeHead(200, {
      "Content-Type": "application/pdf",
      "Access-Control-Allow-Origin": "*",
      "Cache-Control": "public, max-age=86400",
    });
    res.end(buf);
  } catch (e) {
    sendError(res, 502, "arxiv pdf fetch failed: " + e.message);
  }
}

function parseArxivAtom(xml) {
  const entry = xml.match(/<entry>([\s\S]*?)<\/entry>/);
  if (!entry) return null;
  const e = entry[1];
  const grab = (tag) => {
    const m = e.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`));
    return m ? m[1].replace(/\s+/g, " ").trim() : null;
  };
  const authors = [...e.matchAll(/<author>\s*<name>([\s\S]*?)<\/name>/g)].map((m) =>
    m[1].trim()
  );
  const cats = [...e.matchAll(/<category[^>]*term="([^"]+)"/g)].map((m) => m[1]);
  return {
    title: grab("title"),
    summary: grab("summary"),
    published: grab("published"),
    authors,
    categories: cats,
  };
}

async function proxyMeta(id, res) {
  const clean = String(id).replace(/[^0-9a-zA-Z.\/v_-]/g, "");
  const url = `http://export.arxiv.org/api/query?id_list=${clean}`;
  try {
    const r = await fetch(url, { headers: { "User-Agent": UA } });
    const xml = await r.text();
    sendJson(res, parseArxivAtom(xml) || {});
  } catch (e) {
    sendError(res, 502, "arxiv meta failed: " + e.message);
  }
}

// Parse every <entry> in an arXiv Atom feed (search results can hold many).
function parseArxivFeed(xml) {
  const entries = [...xml.matchAll(/<entry>([\s\S]*?)<\/entry>/g)];
  return entries.map(([, e]) => {
    const grab = (tag) => {
      const m = e.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`));
      return m ? m[1].replace(/\s+/g, " ").trim() : null;
    };
    const idUrl = grab("id") || "";
    const arxivId = (idUrl.match(/abs\/([^v]+)/) || [])[1] || null;
    const authors = [...e.matchAll(/<author>\s*<name>([\s\S]*?)<\/name>/g)].map((m) => m[1].trim());
    const cats = [...e.matchAll(/<category[^>]*term="([^"]+)"/g)].map((m) => m[1]);
    return {
      arxivId,
      title: grab("title"),
      summary: grab("summary"),
      published: grab("published"),
      authors,
      categories: cats,
    };
  });
}

function slug(s) {
  return String(s).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
}

// Search arXiv for papers matching the query, and derive researcher matches
// from the authors of those results (arXiv has no standalone author index).
async function proxySearch(q, res) {
  const query = String(q || "").trim();
  if (!query) return sendJson(res, { papers: [], authors: [] });
  const url = `http://export.arxiv.org/api/query?search_query=${encodeURIComponent(
    `all:"${query}"`
  )}&start=0&max_results=15&sortBy=relevance&sortOrder=descending`;
  try {
    const r = await fetch(url, { headers: { "User-Agent": UA } });
    if (!r.ok) return sendError(res, 502, `arxiv search ${r.status}`);
    const xml = await r.text();
    const entries = parseArxivFeed(xml).filter((e) => e.arxivId);

    const papers = entries.map((e) => ({
      id: e.arxivId,
      type: "paper",
      arxivId: e.arxivId,
      title: e.title,
      authors: e.authors,
      year: e.published ? new Date(e.published).getFullYear() : null,
      tags: e.categories.slice(0, 4).map((c) => c.toLowerCase()),
      blurb: e.summary ? e.summary.slice(0, 260) : "",
      link: `https://arxiv.org/abs/${e.arxivId}`,
    }));

    const qLower = query.toLowerCase();
    const seen = new Set();
    const authors = [];
    for (const e of entries) {
      for (const a of e.authors) {
        const key = a.toLowerCase();
        if (!key.includes(qLower) || seen.has(key)) continue;
        seen.add(key);
        authors.push({
          id: "author-" + slug(a),
          type: "author",
          title: a,
          affiliation: "",
          tags: e.categories.slice(0, 4).map((c) => c.toLowerCase()),
          blurb: `Author of "${e.title}" and other papers matching "${query}".`,
          link: `https://scholar.google.com/scholar?q=${encodeURIComponent(a)}`,
        });
      }
    }

    sendJson(res, { papers, authors: authors.slice(0, 8) });
  } catch (e) {
    sendError(res, 502, "search failed: " + e.message);
  }
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
  const body = JSON.stringify(data);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Access-Control-Allow-Origin": "*",
  });
  res.end(body);
}

function sendError(res, status, msg) {
  sendJson(res, { error: msg }, status);
}

async function serveStatic(res, filePath) {
  try {
    const data = await readFile(filePath);
    const ext = path.extname(filePath).toLowerCase();
    res.writeHead(200, {
      "Content-Type": MIME[ext] || "application/octet-stream",
      // Never cache the app shell — always pick up the latest frontend on reload.
      "Cache-Control": "no-store, must-revalidate",
    });
    res.end(data);
  } catch {
    res.writeHead(404, { "Content-Type": "text/plain" });
    res.end("Not found");
  }
}

async function readBody(req) {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  if (!chunks.length) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    return {};
  }
}

// ---------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  const { pathname } = url;

  try {
    if (pathname === "/api/data") {
      const catalog = await readJson(CATALOG_PATH, []);
      const library = await buildLibrary();
      const profile = buildProfile(library);
      const scored = scoreCatalog(catalog, library, profile);
      const wishlist = await readJson(WISHLIST_PATH, []);
      const reading = await readJson(READING_PATH, []);
      const read = await readJson(READ_PATH, []);
      return sendJson(res, { library, profile, catalog: scored, wishlist, reading, read });
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
