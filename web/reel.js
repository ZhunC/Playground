// The home feed: one full-viewport "reel" per paper, swiped vertically.
//
// A reel is a silent, auto-advancing sequence of beats — a title card, the
// paper's real figures with their real captions, and a closer tying it back to
// your notes. Beats advance on a dwell time scaled to caption length; reels
// advance on scroll/arrow/swipe, or on their own when the last beat ends.

import {
  state, el, esc, wikilinks, colorFor, clamp, trunc,
  inWishlist, inReading, isFinished, post,
} from "./shared.js";
import { buildPaperReel } from "./pdfreel.js";

const TIMING = {
  // dwell = BASE + PER_CHAR * caption length, clamped
  BASE_MS: 2600,
  PER_CHAR_MS: 42,
  MIN_MS: 3000,
  MAX_MS: 9000,
  TITLE_MS: 4200,
  CLOSER_MS: 5200,
};
const PREFETCH_AHEAD = 2;

let root = null; // persistent feed DOM — rebuilding it would restart playback
let hooks = {};
let reels = []; // one controller per descriptor
let activeIdx = -1;
let io = null;

function dwellFor(beat) {
  if (beat.kind === "title") return TIMING.TITLE_MS;
  if (beat.kind === "closer") return TIMING.CLOSER_MS;
  const n = (beat.caption || "").length;
  return clamp(TIMING.BASE_MS + TIMING.PER_CHAR_MS * n, TIMING.MIN_MS, TIMING.MAX_MS);
}

function titleBeat(d) {
  return { kind: "title", caption: "" , item: d };
}
function closerBeat(d) {
  return { kind: "closer", caption: "", item: d };
}

// ---------------------------------------------------------------------------
// one reel
// ---------------------------------------------------------------------------
function createReel(desc, index) {
  const section = el("section", "reel");
  section.dataset.index = String(index);

  const stage = el("div", "reel-stage");
  const art = el("div", "reel-art");
  stage.appendChild(art);
  section.appendChild(stage);

  const progress = el("div", "reel-progress");
  section.appendChild(progress);

  const plate = el("div", "reel-plate");
  const kicker = el("div", "reel-kicker");
  const title = el("h2", "reel-title", esc(desc.title || ""));
  const meta = el("div", "reel-meta",
    [desc.authors?.slice(0, 3).join(", "), desc.year].filter(Boolean).map(esc).join(" · "));
  const caption = el("p", "reel-caption");
  const tags = el("div", "reel-tags");
  plate.append(kicker, title, meta, caption, tags);
  section.appendChild(plate);

  const rail = el("div", "reel-rail");
  section.appendChild(rail);

  const hint = el("div", "reel-hint", "↓ next · ← → beats · space pause");
  section.appendChild(hint);

  const ctl = {
    desc, index, section, art, progress, kicker, title, meta, caption, tags, rail,
    beats: [titleBeat(desc)],
    beat: 0,
    timer: null,
    raf: null,
    paused: false,
    built: false,
    seenSent: false,
    elapsed: 0,
  };

  buildRail(ctl);
  paintTags(ctl);
  paintProgress(ctl);
  wireGestures(ctl);
  return ctl;
}

const TIER_LABELS = { recent: "new this month", year: "this year", classic: "classic" };

function tierBadge(d) {
  const tier = d.tier || "classic";
  // The year earns its place only on a classic, where "how old" is the point.
  const text = tier === "classic" && d.year ? `classic · ${d.year}` : TIER_LABELS[tier];
  return el("span", "tag tier-" + tier, esc(text));
}

function paintTags(ctl) {
  const d = ctl.desc;
  ctl.tags.innerHTML = "";
  // A discovered paper carries no match%. It came from a category listing, not
  // a relevance query, so there is no measured match against your vault to
  // report — printing one would be inventing a number.
  if (d.source === "catalog" && typeof d.match === "number")
    ctl.tags.appendChild(el("span", "tag pill-match" + (d.newLane ? " lane" : ""), d.match + "% match"));

  ctl.tags.appendChild(tierBadge(d));

  if (d.source === "arxiv") {
    (d.categoryLabels || []).slice(0, 3)
      .forEach((c) => ctl.tags.appendChild(el("span", "tag tag-cat", esc(c))));
  } else {
    (d.matchedTags?.length ? d.matchedTags : d.tags || [])
      .slice(0, 4)
      .forEach((t) => ctl.tags.appendChild(el("span", "tag", "#" + esc(t))));
  }
}

function buildRail(ctl) {
  const d = ctl.desc;
  ctl.rail.innerHTML = "";
  const mk = (cls, glyph, label, fn) => {
    const b = el("button", "rail-btn " + cls, glyph);
    b.title = label;
    b.setAttribute("aria-label", label);
    b.addEventListener("click", (e) => {
      e.stopPropagation();
      fn();
    });
    ctl.rail.appendChild(b);
    return b;
  };
  mk(inWishlist(d.id) ? "on wish" : "", "★", inWishlist(d.id) ? "On wishlist" : "Add to wishlist",
    () => hooks.toggleWishlist?.(d));
  mk(inReading(d.id) ? "on read" : "", "▶", inReading(d.id) ? "Reading now" : "Start reading",
    () => hooks.toggleReading?.(d));
  mk(isFinished(d.id) ? "on done" : "", "✓", isFinished(d.id) ? "Finished" : "Mark finished",
    () => hooks.markFinished?.(d));
  mk("", "ⓘ", "Details", () => {
    pause(ctl);
    hooks.openDetail?.(d);
  });
  if (d.link)
    mk("", "↗", "Open on arXiv", () => window.open(d.link, "_blank", "noopener,noreferrer"));
}

function paintProgress(ctl) {
  ctl.progress.innerHTML = "";
  for (let i = 0; i < ctl.beats.length; i++) {
    const seg = el("div", "seg");
    seg.appendChild(el("div", "seg-fill"));
    ctl.progress.appendChild(seg);
  }
  syncProgress(ctl);
}

function syncProgress(ctl) {
  [...ctl.progress.children].forEach((seg, i) => {
    const fill = seg.firstChild;
    fill.style.width = i < ctl.beat ? "100%" : i === ctl.beat ? "0%" : "0%";
  });
}

// ---------------------------------------------------------------------------
// playback
// ---------------------------------------------------------------------------
function showBeat(ctl, i) {
  ctl.beat = clamp(i, 0, ctl.beats.length - 1);
  const beat = ctl.beats[ctl.beat];
  const d = ctl.desc;

  ctl.art.innerHTML = "";
  if (beat.kind === "figure" && beat.img) {
    const img = el("img", "reel-img");
    img.src = beat.img;
    img.alt = beat.caption || "figure";
    ctl.art.appendChild(img);
    ctl.art.classList.remove("reel-art-text");
  } else {
    ctl.art.classList.add("reel-art-text");
    const wash = el("div", "reel-wash");
    wash.style.background =
      `radial-gradient(120% 90% at 30% 20%, ${colorFor(d.id)} 0%, #0d0f13 75%)`;
    const big = el("div", "reel-bigtext");
    if (beat.kind === "title") {
      big.appendChild(el("div", "reel-eyebrow",
        esc((d.categoryLabels || [])[0] || (d.tags || [])[0] || "paper")));
      big.appendChild(el("div", "reel-bigtitle", esc(d.title || "")));
      if (d.blurb) big.appendChild(el("div", "reel-bigblurb", wikilinks(trunc(d.blurb, 320))));
    } else if (beat.kind === "closer") {
      // Curated papers can say which of your notes earned them a place.
      // Digest papers cannot — nothing in the vault selected them — so they
      // show the arXiv categories they were filed under instead.
      const because = d.because || [];
      const cats = d.categoryLabels || [];
      if (because.length) {
        big.appendChild(el("div", "reel-eyebrow", "because you wrote"));
        const list = el("div", "reel-because");
        because.slice(0, 3).forEach((b) => list.appendChild(el("div", "reel-because-item", "◆ " + esc(b.title))));
        big.appendChild(list);
      } else if (cats.length) {
        big.appendChild(el("div", "reel-eyebrow", "filed under"));
        const list = el("div", "reel-because");
        cats.forEach((c) => list.appendChild(el("div", "reel-because-item", "◆ " + esc(c))));
        big.appendChild(list);
      } else {
        big.appendChild(el("div", "reel-eyebrow", "up next"));
        big.appendChild(el("div", "reel-bigtitle", esc(d.title || "")));
      }
      big.appendChild(el("div", "reel-bigblurb", beat.note ? esc(beat.note) : "Scroll for the next one."));
    }
    ctl.art.append(wash, big);
  }

  const total = ctl.beats.length;
  if (beat.kind === "figure") {
    ctl.kicker.textContent =
      `${beat.label || "figure"} · p${beat.page || "?"} · ${ctl.beat} of ${total - 2 || 1}` +
      (beat.captionSource === "abstract" ? " · caption from abstract" : "");
    ctl.caption.textContent = beat.caption || "";
  } else {
    ctl.kicker.textContent =
      beat.kind === "title" ? (d.source === "catalog" ? "curated pick" : "from your arXiv digest") : "";
    ctl.caption.textContent = "";
  }
  ctl.section.classList.toggle("text-beat", beat.kind !== "figure");
  // The title beat already shows the title at full size, so the plate below
  // hides its copy (see .reel[data-beat-kind="title"] in styles.css).
  ctl.section.dataset.beatKind = beat.kind;
  syncProgress(ctl);
}

function runTimer(ctl) {
  stopTimer(ctl);
  const beat = ctl.beats[ctl.beat];
  const dwell = dwellFor(beat);
  const fill = ctl.progress.children[ctl.beat]?.firstChild;
  let last = performance.now();
  ctl.elapsed = 0;

  const step = (now) => {
    if (ctl.paused) {
      last = now;
      ctl.raf = requestAnimationFrame(step);
      return;
    }
    ctl.elapsed += now - last;
    last = now;
    if (fill) fill.style.width = Math.min(100, (ctl.elapsed / dwell) * 100) + "%";
    if (ctl.elapsed >= dwell) {
      ctl.raf = null;
      nextBeat(ctl, true);
      return;
    }
    ctl.raf = requestAnimationFrame(step);
  };
  ctl.raf = requestAnimationFrame(step);
}

function stopTimer(ctl) {
  if (ctl.raf) cancelAnimationFrame(ctl.raf);
  ctl.raf = null;
}

function nextBeat(ctl, auto = false) {
  if (ctl.beat >= ctl.beats.length - 1) {
    markSeen(ctl);
    if (auto) advanceReel(1);
    return;
  }
  showBeat(ctl, ctl.beat + 1);
  runTimer(ctl);
}

function prevBeat(ctl) {
  if (ctl.beat <= 0) return;
  showBeat(ctl, ctl.beat - 1);
  runTimer(ctl);
}

function pause(ctl) {
  ctl.paused = true;
  ctl.section.classList.add("paused");
}
function resume(ctl) {
  ctl.paused = false;
  ctl.section.classList.remove("paused");
}
function togglePause(ctl) {
  ctl.paused ? resume(ctl) : pause(ctl);
}

function reset(ctl) {
  stopTimer(ctl);
  resume(ctl);
  showBeat(ctl, 0);
}

async function markSeen(ctl) {
  if (ctl.seenSent) return;
  ctl.seenSent = true;
  try {
    await post("/api/feed-seen", { id: ctl.desc.id });
  } catch {
    /* seen tracking is best-effort */
  }
}

// ---------------------------------------------------------------------------
// building figures
// ---------------------------------------------------------------------------
async function ensureBuilt(ctl) {
  if (ctl.built || ctl.building) return;
  ctl.building = true;
  ctl.section.classList.add("loading");
  let beats = [];
  let note = null;
  try {
    const out = await buildPaperReel(ctl.desc);
    beats = out.beats || [];
    ctl.fromCache = out.fromCache;
  } catch (e) {
    note = "Couldn't read this paper's PDF.";
  }
  if (!beats.length && !note) note = "No figures found in the first pages of this paper.";

  const closer = closerBeat(ctl.desc);
  closer.note = note || "Scroll for the next one.";
  const wasAt = ctl.beat;
  ctl.beats = [titleBeat(ctl.desc), ...beats, closer];
  ctl.built = true;
  ctl.building = false;
  ctl.section.classList.remove("loading");
  paintProgress(ctl);
  // If still on the title card, carry on into the figures we just added.
  if (wasAt === 0 && activeIdx === ctl.index) {
    showBeat(ctl, 0);
    if (!ctl.raf) runTimer(ctl);
  } else {
    showBeat(ctl, Math.min(wasAt, ctl.beats.length - 1));
  }
}

function prefetch(from) {
  for (let k = 1; k <= PREFETCH_AHEAD; k++) {
    const ctl = reels[from + k];
    if (ctl && !ctl.built && !ctl.building) ensureBuilt(ctl);
  }
}

// ---------------------------------------------------------------------------
// activation + navigation
// ---------------------------------------------------------------------------
function setActive(index) {
  if (index === activeIdx) return;
  const prev = reels[activeIdx];
  if (prev) {
    stopTimer(prev);
    reset(prev);
    prev.section.classList.remove("active");
  }
  activeIdx = index;
  const ctl = reels[index];
  if (!ctl) return;
  ctl.section.classList.add("active");
  showBeat(ctl, 0);
  runTimer(ctl);
  ensureBuilt(ctl);
  prefetch(index);
}

function advanceReel(delta) {
  const target = reels[activeIdx + delta];
  if (!target) return;
  target.section.scrollIntoView({ behavior: "smooth", block: "start" });
}

function wireGestures(ctl) {
  // Click the right half for the next beat, the left half for the previous.
  ctl.section.addEventListener("click", (e) => {
    if (e.target.closest(".rail-btn")) return;
    const x = e.clientX - ctl.section.getBoundingClientRect().left;
    if (x > ctl.section.clientWidth * 0.5) nextBeat(ctl);
    else prevBeat(ctl);
  });
}

// ---------------------------------------------------------------------------
// public entry
// ---------------------------------------------------------------------------

// Reflect wishlist/reading/finished changes without rebuilding the feed.
export function syncFeedRails() {
  for (const ctl of reels) buildRail(ctl);
}

/**
 * Add reels discovered after the page loaded, without touching what is already
 * on screen — rebuilding would restart whatever you are watching. Returns how
 * many were added.
 */
export function appendFeed(descriptors) {
  if (!root || !descriptors?.length) return 0;
  const have = new Set(reels.map((r) => r.desc.id));
  let added = 0;
  for (const desc of descriptors) {
    if (have.has(desc.id)) continue;
    const ctl = createReel(desc, reels.length);
    reels.push(ctl);
    root.appendChild(ctl.section);
    io?.observe(ctl.section);
    have.add(desc.id);
    added++;
  }
  if (added) {
    root.dataset.count = String(reels.length);
    state.feed = reels.map((r) => r.desc);
    const empty = root.querySelector(":scope > .empty");
    if (empty) empty.remove();
    // The feed may have been empty, in which case nothing is playing yet.
    if (activeIdx < 0) setActive(0);
  }
  return added;
}

export function pauseFeed() {
  const ctl = reels[activeIdx];
  if (ctl) pause(ctl);
}
export function resumeFeed() {
  const ctl = reels[activeIdx];
  if (ctl) resume(ctl);
}

export function renderFeed(main, h) {
  hooks = h || hooks;

  if (root && root.dataset.count === String(state.feed.length)) {
    // Detaching and re-inserting the container would reset its scrollTop and
    // throw you back to the first reel, so only move it if it isn't here.
    if (root.parentNode !== main) {
      main.innerHTML = "";
      main.appendChild(root);
    }
    syncFeedRails();
    const ctl = reels[activeIdx];
    if (ctl && !ctl.raf) runTimer(ctl);
    return;
  }

  root = el("div", "feed");
  root.dataset.count = String(state.feed.length);
  reels = [];
  activeIdx = -1;

  if (!state.feed.length) {
    root.appendChild(
      el("div", "empty",
        "No reels yet. The feed is built from the papers in catalog.json plus arXiv results for your vault tags — check the server log for errors.")
    );
    main.innerHTML = "";
    main.appendChild(root);
    return;
  }

  state.feed.forEach((desc, i) => {
    const ctl = createReel(desc, i);
    reels.push(ctl);
    root.appendChild(ctl.section);
  });

  main.innerHTML = "";
  main.appendChild(root);

  io?.disconnect();
  io = new IntersectionObserver(
    (entries) => {
      for (const e of entries) {
        if (e.isIntersecting && e.intersectionRatio >= 0.6)
          setActive(Number(e.target.dataset.index));
      }
    },
    { root, threshold: [0.6] }
  );
  for (const ctl of reels) io.observe(ctl.section);

  setActive(0);
}

// Keyboard: beats left/right, reels up/down, space pauses.
export function handleFeedKey(e) {
  const ctl = reels[activeIdx];
  if (!ctl) return false;
  switch (e.key) {
    case "ArrowRight": nextBeat(ctl); return true;
    case "ArrowLeft": prevBeat(ctl); return true;
    case "ArrowDown": case "PageDown": case "j": advanceReel(1); return true;
    case "ArrowUp": case "PageUp": case "k": advanceReel(-1); return true;
    case " ": togglePause(ctl); return true;
    default: return false;
  }
}
