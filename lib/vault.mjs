// Obsidian vault parsing + catalog scoring.
// Extracted verbatim from server.mjs so both the HTTP router and the feed
// builder can use it. Paths are passed in rather than read from env, so this
// module stays importable from scripts.

import { readFile, readdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";

// Folders under content/ that count as your "library" (notes you own).
export const LIBRARY_DIRS = ["notes", "reflections"];

export function contentDir(vaultRoot) {
  return path.join(vaultRoot, "content");
}

// ---------------------------------------------------------------------------
// Vault parsing
// ---------------------------------------------------------------------------

export async function walk(dir) {
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

export function splitFrontmatter(raw) {
  if (!raw.startsWith("---")) return { fm: "", body: raw };
  const end = raw.indexOf("\n---", 3);
  if (end === -1) return { fm: "", body: raw };
  const fm = raw.slice(3, end).trim();
  const body = raw.slice(end + 4).replace(/^\s*\n/, "");
  return { fm, body };
}

// Minimal, forgiving YAML-frontmatter reader for the fields we care about.
export function parseFrontmatter(fm) {
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

export function cleanTag(t) {
  return t
    .trim()
    .replace(/^["']|["']$/g, "")
    .replace(/^#/, "")
    .replace(/^-+/, "") // strip stray leading dashes (e.g. "-sw_dev")
    .replace(/\/.*$/, "") // collapse nested tags: embedded/simulink -> embedded
    .toLowerCase()
    .trim();
}

export function firstImage(body) {
  const wiki = body.match(/!\[\[([^\]]+?)\]\]/);
  if (wiki) return { kind: "wiki", ref: wiki[1].split("|")[0].trim() };
  const md = body.match(/!\[[^\]]*\]\(([^)]+)\)/);
  if (md) return { kind: "md", ref: md[1].trim() };
  return null;
}

export function excerpt(body, n = 240) {
  const text = body
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/!\[\[[^\]]*\]\]/g, " ")
    .replace(/\[\[([^\]|]+)(\|[^\]]+)?\]\]/g, "$1")
    .replace(/[#>*_`$]/g, "")
    .replace(/\s+/g, " ")
    .trim();
  return text.slice(0, n);
}

export async function resolveAsset(vaultRoot, ref) {
  // Try common Obsidian asset locations; return a URL the frontend can load.
  const dir = contentDir(vaultRoot);
  const candidates = [path.join(dir, "assets", ref), path.join(dir, ref), path.join(vaultRoot, ref)];
  for (const c of candidates) {
    if (existsSync(c)) {
      return "/asset?p=" + encodeURIComponent(path.relative(vaultRoot, c));
    }
  }
  return null;
}

export async function buildLibrary(vaultRoot) {
  const dir = contentDir(vaultRoot);
  const files = [];
  for (const d of LIBRARY_DIRS) files.push(...(await walk(path.join(dir, d))));

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
    if (img && img.kind === "wiki") image = await resolveAsset(vaultRoot, img.ref);
    else if (img && img.kind === "md" && !/^https?:/.test(img.ref))
      image = await resolveAsset(vaultRoot, img.ref);
    else if (img && img.kind === "md") image = img.ref;

    const rel = path.relative(vaultRoot, f).split(path.sep).join("/");
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

export function buildProfile(library) {
  const counts = {};
  for (const n of library) for (const t of n.tags) counts[t] = (counts[t] || 0) + 1;
  return Object.entries(counts)
    .map(([tag, count]) => ({ tag, count }))
    .sort((a, b) => b.count - a.count);
}

// ---------------------------------------------------------------------------
// Catalog scoring — works on any array of {tags, title} items, so the feed
// reuses it for arXiv-discovered papers too.
// ---------------------------------------------------------------------------

export function scoreCatalog(catalog, library, profile) {
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
