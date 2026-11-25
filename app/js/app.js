// uberdesigner clips, in the browser. One state object, a few draw functions (layers, timeline, inspector), and the
// stage on a canvas. Everything happens in this tab: the clip and its files are kept in the browser's own storage,
// and the video file is built here too.

import {
  actionsDuration, blankClip, duplicateScene, EASES, findLayer, findScene, FITS, FORMATS, frameSize, freshId, layerSpan, mediaUsed, MOTIONS, resolveLayer, round, sceneAt,
  sceneDuration, sceneStarts, setPlaced, SHAPES, siteKey, splitScene, TEXT_MOTIONS, TEXT_UNITS, totalDuration, TRANSITIONS, validate,
} from "./model.mjs";
import { canExport, exportFormat } from "./export.js";
import { canRecordTab, detectCuts, inspect, kindOf, recordTab, refineCut, safeName } from "./media.js";
import { loadFonts, Stage } from "./renderer.js";
import { pickBackend } from "./backend.js";

const B = pickBackend();
const PROJECT = B.mode === "project";

const $ = (id) => document.getElementById(id);

// ---------- small helpers ----------

function h(tag, attrs, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs ?? {})) {
    if (v == null || v === false) continue;
    if (k === "class") el.className = v;
    else if (k === "style") el.style.cssText = v;
    else if (k.startsWith("on")) el.addEventListener(k.slice(2), v);
    else if (k === "value") el.value = v;
    else if (k === "checked" || k === "disabled" || k === "selected" || k === "hidden") el[k] = !!v;
    else el.setAttribute(k, v === true ? "" : v);
  }
  for (const kid of kids.flat(3)) if (kid != null && kid !== false) el.append(kid);
  return el;
}

const fmtTime = (t, fps = 30) => {
  t = Math.max(0, t);
  const m = Math.floor(t / 60);
  const s = Math.floor(t % 60);
  const f = Math.floor((t % 1) * fps + 1e-6);
  return `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}.${String(f).padStart(2, "0")}`;
};
const secs = (n) => `${round(n, 2)} s`;
const KIND_NAME = { video: "Video", image: "Image", text: "Text", shape: "Shape", site: "Site", audio: "Audio" };
const MOTION_NAME = { none: "None", fade: "Fade", up: "From below", down: "From above", left: "From right", right: "From left", scale: "Scale", blur: "Blur", "grow-x": "Reveal from left", "grow-y": "Grow from bottom" };
const UNIT_NAME = { line: "By line", word: "By word", letter: "By letter" };
const ACTION_NAME = { wait: "Wait", scroll: "Scroll", wheel: "Wheel", move: "Pointer to", click: "Click", type: "Type text", key: "Key" };
const TRANSITION_NAME = { cut: "Cut", fade: "Dissolve", "slide-left": "Slide left", "slide-up": "Slide up", zoom: "Zoom", wipe: "Wipe" };
const EASE_NAME = { linear: "Linear", in: "Ease in", out: "Ease out", inOut: "Ease in-out", expoOut: "Sharp ease-out", backOut: "Overshoot" };

// ---------- state ----------

const S = {
  clipId: null,
  clips: [], // every clip kept in this browser: { id, name, updatedAt }
  clip: null,
  media: [], // this clip's files: { path, name, kind, width, height, duration, audio, thumb }
  urls: {}, // path → an address the page can play it from
  // only in a project: what the skill's server reports
  cards: [],
  sjobs: [],
  tools: {},
  rev: -1,
  rightTab: "props",
  wholeClip: false,
  problems: [],
  format: "16:9",
  sel: null, // { type: "scene" | "layer" | "audio", id }
  sceneId: null, // the scene whose layers the timeline shows
  t: 0,
  playing: false,
  muted: false,
  zoom: 80, // pixels per second
  leftTab: "layers",
  jobs: [],
  history: [],
  undo: [],
  redo: [],
  dragging: false,
  recording: null,
  seenJobs: new Set(),
};
let stage = null;

const curScene = () => findScene(S.clip, S.sceneId) ?? S.clip.scenes[0];
const selLayer = () => (S.sel?.type === "layer" ? findLayer(S.clip, S.sel.id) : null);
const snap = (t) => round(Math.round(t * S.clip.fps) / S.clip.fps, 3);

// ---------- editing: change, show, save ----------

let saveTimer = null;
let saveLabel = "Edit";
let saving = Promise.resolve();
let before = null;

function showStage() {
  if (!stage) return;
  stage.load(S.clip, { format: S.format, urls: S.urls });
  stage.setMuted(S.muted);
  seek(Math.min(S.t, totalDuration(S.clip)), true);
  refreshFonts();
}

// Canvas text is drawn in a fallback until its face has loaded: load what the clip names, then draw again
let fontsFor = "";
function refreshFonts() {
  const key = JSON.stringify([S.clip.fonts, S.clip.scenes.flatMap((s) => s.layers).filter((l) => l.kind === "text").map((l) => [l.font, l.weight])]);
  if (key === fontsFor) return;
  fontsFor = key;
  loadFonts(S.clip, S.urls).then(() => !S.playing && seek(S.t, true));
}

// Everything wrong with the clip: its format, and files it names that aren't in it
function problemsOf(clip) {
  const errors = validate(clip);
  if (errors.length) return errors;
  for (const [path, who] of mediaUsed(clip)) if (!S.urls[path]) errors.push(`${who.map((w) => `"${w}"`).join(", ")}: the file ${path.split("/").pop()} is not in the clip`);
  return errors;
}

function scheduleSave(label) {
  saveLabel = label ?? saveLabel;
  $("saved").textContent = "Saving…";
  clearTimeout(saveTimer);
  saveTimer = setTimeout(saveNow, 450);
}
function saveNow() {
  clearTimeout(saveTimer);
  saveTimer = null;
  const clip = structuredClone(S.clip);
  const id = S.clipId;
  const label = saveLabel;
  saving = saving.then(async () => {
    try {
      // a clip is kept even while something in it is wrong: the work must not be lost. The export is what waits.
      S.problems = id === S.clipId ? problemsOf(S.clip) : S.problems;
      // a project's clip.json is what Claude and the render read: it is written only while it is whole
      if (PROJECT && S.problems.length) throw new Error("something in the clip is wrong");
      await B.save(id, clip, label);
      $("saved").textContent = B.savedNote();
      const mine = S.clips.find((c) => c.id === id);
      if (mine && mine.name !== clip.name) {
        mine.name = clip.name;
        drawClips();
      }
    } catch (err) {
      $("saved").textContent = `Not saved: ${err?.name === "QuotaExceededError" ? "the browser is out of storage space" : (err?.message ?? err)}`;
    }
    drawNotice();
  });
}

// One edit: fn changes S.clip. `quiet` keeps the inspector as it is (the person is typing in it).
function edit(label, fn, { quiet = false, live = false } = {}) {
  if (!live || !before) before = JSON.stringify(S.clip);
  fn(S.clip);
  if (!live) pushUndo();
  showStage();
  drawLeft();
  drawTimeline();
  if (!quiet) drawRight();
  drawTop();
  scheduleSave(label);
}
function pushUndo() {
  if (before && before !== JSON.stringify(S.clip)) {
    S.undo.push(before);
    if (S.undo.length > 120) S.undo.shift();
    S.redo.length = 0;
  }
  before = null;
}
// A drag or a run of typing: many live edits, one step back
const endLive = () => pushUndo();

function undo(redo = false) {
  const from = redo ? S.redo : S.undo;
  const to = redo ? S.undo : S.redo;
  if (!from.length) return;
  to.push(JSON.stringify(S.clip));
  S.clip = JSON.parse(from.pop());
  fixSelection();
  showStage();
  drawAll();
  scheduleSave(redo ? "Redo" : "Step back");
}

function fixSelection() {
  if (!findScene(S.clip, S.sceneId)) S.sceneId = S.clip.scenes[0].id;
  if (S.sel?.type === "scene" && !findScene(S.clip, S.sel.id)) S.sel = null;
  if (S.sel?.type === "layer" && !findLayer(S.clip, S.sel.id)) S.sel = null;
  if (S.sel?.type === "audio" && !(S.clip.audio ?? []).some((a) => a.id === S.sel.id)) S.sel = null;
  if (!S.clip.formats?.includes(S.format) && S.format !== S.clip.format) S.format = S.clip.format;
}

function select(sel) {
  S.sel = sel;
  if (sel?.type === "scene") S.sceneId = sel.id;
  if (sel?.type === "layer") S.sceneId = findLayer(S.clip, sel.id)?.scene.id ?? S.sceneId;
  if (sel) S.wholeClip = false;
  if (sel && S.rightTab !== "props") S.rightTab = "props";
  drawLeft();
  drawTimeline();
  drawRight();
  drawChip();
  drawSelBox();
}

// ---------- time ----------

let seekBusy = false;
let seekNext = null;
function seek(t, force = false) {
  S.t = Math.max(0, Math.min(t, totalDuration(S.clip)));
  drawPlayhead();
  if (!stage) return;
  if (S.playing && !force) return;
  if (seekBusy) {
    seekNext = S.t;
    return;
  }
  seekBusy = true;
  stage.seek(S.t).finally(() => {
    seekBusy = false;
    drawSelBox();
    if (seekNext != null) {
      const n = seekNext;
      seekNext = null;
      seek(n, true);
    }
  });
}

let lastTick = 0;
function play(on) {
  if (on === S.playing) return;
  S.playing = on;
  $("play").textContent = on ? "❚❚" : "▶";
  if (!on) {
    stage?.stop();
    seek(S.t, true);
    return;
  }
  if (S.t >= totalDuration(S.clip) - 0.02) S.t = 0;
  lastTick = performance.now();
  const loop = (now) => {
    if (!S.playing) return;
    S.t += (now - lastTick) / 1000;
    lastTick = now;
    const total = totalDuration(S.clip);
    if (S.t >= total) {
      S.t = total;
      play(false);
      return;
    }
    stage.tick(S.t);
    drawPlayhead();
    const at = sceneAt(S.clip, S.t).scene.id;
    if (at !== S.sceneId && !S.dragging) {
      S.sceneId = at;
      drawLeft();
      drawTimeline();
    }
    requestAnimationFrame(loop);
  };
  requestAnimationFrame(loop);
}

// ---------- top bar ----------

function drawTop() {
  if (document.activeElement !== $("clipName")) $("clipName").value = S.clip.name;
  document.title = `${S.clip.name} · uberdesigner clips`;
  const made = new Set([S.clip.format, ...(S.clip.formats ?? [])]);
  $("formats").replaceChildren(
    ...Object.keys(FORMATS).map((f) =>
      h("button", { class: `${f === S.format ? "on" : ""} ${made.has(f) ? "" : "off"}`, title: `${FORMATS[f].hint}${f === S.clip.format ? " · main format" : made.has(f) ? "" : " · not built (turn it on in the clip's properties)"}`, onclick: () => setFormat(f) }, f),
    ),
  );
  $("total").textContent = fmtTime(totalDuration(S.clip), S.clip.fps);
}

function drawClips() {
  $("clips").hidden = PROJECT; // a project is one clip: its folder
  if (PROJECT) return;
  $("clips").replaceChildren(
    ...S.clips.map((c) => h("option", { value: c.id, selected: c.id === S.clipId }, c.name || "Clip")),
    h("option", { value: "+new" }, "＋ New clip"),
    S.clips.length > 1 ? h("option", { value: "-delete" }, "Delete this clip…") : null,
  );
}

function setFormat(f) {
  S.format = f;
  showStage();
  layoutFrame();
  drawTop();
  drawRight();
  drawLeft();
  drawTimeline();
}

function drawNotice() {
  const lines = [];
  if (S.problems.length) lines.push(`Something in the clip is wrong, so the video can't be built yet:\n${S.problems.slice(0, 4).join("\n")}`);
  if (!canExport()) lines.push("This browser can't build videos. You can edit here; to build, open the editor in Chrome or Edge.");
  if (!B.persistent()) lines.push("The browser gave no storage (a private window?). The clip will be gone when you close the tab.");
  $("notice").hidden = !lines.length;
  $("notice").textContent = lines.join("\n");
  layoutFrame();
}

// ---------- the frame ----------

let frameScale = 1;
function layoutFrame() {
  const box = $("canvas").getBoundingClientRect();
  const size = frameSize(S.format);
  const pad = 28;
  frameScale = Math.max(0.05, Math.min((box.width - pad * 2) / size.width, (box.height - pad * 2) / size.height));
  const w = size.width * frameScale;
  const hh = size.height * frameScale;
  const wrap = $("frameWrap");
  wrap.style.width = `${w}px`;
  wrap.style.height = `${hh}px`;
  wrap.style.left = `${(box.width - w) / 2}px`;
  wrap.style.top = `${(box.height - hh) / 2}px`;
  const f = $("stage");
  f.style.width = `${w}px`;
  f.style.height = `${hh}px`;
  drawSelBox();
}

function drawSelBox() {
  const box = $("selBox");
  const r = S.sel?.type === "layer" && stage ? stage.rect(S.sel.id) : null;
  box.hidden = !r;
  if (!r) return;
  box.style.left = `${r.x * frameScale}px`;
  box.style.top = `${r.y * frameScale}px`;
  box.style.width = `${r.width * frameScale}px`;
  box.style.height = `${r.height * frameScale}px`;
}

// Picking and moving a layer right on the frame
function frameDown(e) {
  if (e.button !== 0 || !stage) return;
  const rect = $("overlay").getBoundingClientRect();
  const px = (e.clientX - rect.left) / frameScale;
  const py = (e.clientY - rect.top) / frameScale;
  const scaling = e.target.dataset?.h === "scale";
  const id = scaling ? S.sel?.id : stage.hit(px, py);
  if (!id) return select({ type: "scene", id: curScene().id });
  if (S.sel?.id !== id) select({ type: "layer", id });
  play(false);
  const found = findLayer(S.clip, id);
  if (!found) return;
  const size = frameSize(S.format);
  const L = resolveLayer(found.layer, S.format);
  const start = { x: L.x ?? 0, y: L.y ?? 0, scale: L.scale ?? 1 };
  const r0 = stage.rect(id);
  const cx = r0 ? r0.x + r0.width / 2 : size.width / 2;
  const cy = r0 ? r0.y + r0.height / 2 : size.height / 2;
  const d0 = Math.hypot(px - cx, py - cy) || 1;
  let moved = false;
  S.dragging = true;
  const move = (ev) => {
    const dx = (ev.clientX - e.clientX) / frameScale;
    const dy = (ev.clientY - e.clientY) / frameScale;
    if (!moved && Math.hypot(dx, dy) < 3) return;
    moved = true;
    edit(
      scaling ? "Layer size" : "Layer position",
      () => {
        if (scaling) {
          const d = Math.hypot((ev.clientX - rect.left) / frameScale - cx, (ev.clientY - rect.top) / frameScale - cy);
          setPlaced(S.clip, found.layer, S.format, "scale", round(Math.max(0.05, start.scale * (d / d0)), 3));
        } else {
          let x = start.x + (dx / size.width) * 100;
          let y = start.y + (dy / size.height) * 100;
          if (!ev.shiftKey) {
            if (Math.abs(x) < 0.8) x = 0; // the center holds on to a layer that comes near it
            if (Math.abs(y) < 0.8) y = 0;
          }
          setPlaced(S.clip, found.layer, S.format, "x", round(x, 2));
          setPlaced(S.clip, found.layer, S.format, "y", round(y, 2));
        }
      },
      { live: true },
    );
  };
  const up = () => {
    removeEventListener("pointermove", move);
    removeEventListener("pointerup", up);
    S.dragging = false;
    if (moved) endLive();
  };
  addEventListener("pointermove", move);
  addEventListener("pointerup", up);
}

// ---------- left column ----------

function drawLeft() {
  for (const b of $("leftTabs").children) b.classList.toggle("on", b.dataset.tab === S.leftTab);
  const body = $("leftBody");
  if (S.leftTab === "layers") body.replaceChildren(...layersView());
  else if (S.leftTab === "media") body.replaceChildren(...mediaView());
  else body.replaceChildren(...historyView());
}

function layersView() {
  const out = [
    h(
      "div",
      { class: "addRow" },
      h("button", { class: "line", onclick: () => addLayer("text") }, "+ Text"),
      h("button", { class: "line", onclick: () => addLayer("shape") }, "+ Shape"),
      PROJECT && S.tools.chrome && S.tools.ffmpeg ? h("button", { class: "line", onclick: () => addLayer("site") }, "+ Site") : null,
      h("button", { class: "line", onclick: addScene }, "+ Scene"),
    ),
  ];
  const starts = sceneStarts(S.clip);
  S.clip.scenes.forEach((scene, i) => {
    out.push(
      h(
        "div",
        { class: `sceneRow ${S.sel?.type === "scene" && S.sel.id === scene.id ? "on" : ""} ${scene.id === S.sceneId ? "cur" : ""}`, onclick: () => (select({ type: "scene", id: scene.id }), seekInto(starts[i], scene)) },
        h("span", { class: "rowName" }, `${i + 1}. ${scene.label ?? scene.id}`),
        h("span", { class: "rowMeta" }, secs(sceneDuration(scene))),
      ),
    );
    if (scene.id !== S.sceneId) return;
    for (const layer of [...scene.layers].reverse()) {
      const L = resolveLayer(layer, S.format);
      out.push(
        h(
          "div",
          { class: `layerRow ${S.sel?.type === "layer" && S.sel.id === layer.id ? "on" : ""} ${L.hidden ? "off" : ""}`, onclick: () => select({ type: "layer", id: layer.id }) },
          h("i", { class: `kind ${layer.kind}` }),
          h("span", { class: "rowName" }, layer.label ?? layer.id),
          h("button", { class: "eye", title: L.hidden ? `Show in ${S.format}` : `Hide in ${S.format}`, onclick: (e) => (e.stopPropagation(), edit("Layer visibility", () => setPlaced(S.clip, layer, S.format, "hidden", !L.hidden))) }, L.hidden ? "○" : "●"),
        ),
      );
    }
    if (!scene.layers.length) out.push(h("div", { class: "hint small", style: "padding-left:22px" }, "Empty. Add a layer from Media or with the buttons above."));
  });
  if (S.clip.audio?.length) {
    out.push(h("div", { class: "sub" }, "Audio"));
    for (const a of S.clip.audio)
      out.push(h("div", { class: `layerRow ${S.sel?.type === "audio" && S.sel.id === a.id ? "on" : ""}`, style: "padding-left:8px", onclick: () => select({ type: "audio", id: a.id }) }, h("i", { class: "kind audio" }), h("span", { class: "rowName" }, a.label ?? a.src.split("/").pop())));
  }
  return out;
}

// Keep the playhead where it is when it's already inside the picked scene
function seekInto(start, scene) {
  if (S.t < start || S.t >= start + sceneDuration(scene)) seek(start + 0.001, true);
}

function mediaView() {
  const pick = h("input", { type: "file", multiple: true, hidden: true, accept: "video/*,image/*,audio/*,.woff2,.woff,.ttf,.otf", onchange: (e) => upload([...e.target.files]) });
  const out = [
    pick,
    h("button", { class: "upload", onclick: () => pick.click() }, "Add files…"),
    canRecordTab() ? h("button", { class: "upload rec", disabled: !!S.recording, onclick: startTabRecording }, "● Record a tab with your site") : null,
  ];
  if (!S.media.length) out.push(h("div", { class: "hint" }, "Drop videos, pictures and music here. Screen recordings, MP4s from Cinema 4D and frames from Figma work as they are. The files stay on this computer."));
  const used = mediaUsed(S.clip);
  const grid = h("div", { class: "mediaGrid" });
  for (const m of S.media) {
    if (m.kind === "font") continue;
    const meta = [m.duration ? secs(m.duration) : null, m.width ? `${m.width}×${m.height}` : null].filter(Boolean).join(" · ");
    grid.append(
      h(
        "div",
        { class: "mediaItem", title: m.name },
        h("div", { class: "thumb", style: m.thumb ? `background-image:url("${m.thumb}")` : "" }, m.kind === "audio" ? "♪" : ""),
        h("div", { class: "acts" }, m.kind === "audio" ? h("button", { onclick: () => addAudio(m) }, "+ Audio track") : [h("button", { onclick: () => addMediaScene(m) }, "+ As a new scene"), h("button", { onclick: () => addMediaLayer(m) }, "+ Into this scene"), m.kind === "video" && m.duration > 2 ? h("button", { onclick: () => splitIntoScenes(m) }, "✂ Split into scenes") : null], used.has(m.path) ? null : h("button", { class: "rm", title: "Remove the file from the clip", onclick: () => removeMedia(m) }, "Remove file")),
        h("div", { class: "cap" }, h("b", {}, m.name), h("span", {}, meta || KIND_NAME[m.kind])),
      ),
    );
  }
  out.push(grid);
  const fonts = S.media.filter((m) => m.kind === "font");
  if (fonts.length) out.push(h("div", { class: "sub" }, "Fonts"), ...fonts.map((m) => h("div", { class: "layerRow", style: "padding-left:8px" }, h("span", { class: "rowName" }, m.name))));
  return out;
}

function historyView() {
  if (!S.history.length) return [h("div", { class: "hint" }, "Points you can go back to will show up here. They are kept in this browser with the clip.")];
  return S.history.map((v, i) =>
    h(
      "div",
      { class: "ver" },
      h("div", {}, h("b", {}, v.label || "Edit"), h("span", {}, `${new Date(v.at).toLocaleString("en-US", { day: "numeric", month: "short", hour: "numeric", minute: "2-digit" })}${i === 0 ? " · now" : ""}`)),
      i === 0 ? null : h("button", { class: "line", onclick: () => restore(v.key) }, "Go back"),
    ),
  );
}

async function loadHistory() {
  S.history = await B.history(S.clipId);
  if (S.leftTab === "history") drawLeft();
}
async function restore(key) {
  await flush();
  const clip = await B.historyClip(S.clipId, key);
  if (!clip) return;
  const entry = S.history.find((v) => v.key === key);
  edit(`Back to: ${entry?.label || "an earlier point"}`, () => (S.clip = clip));
  fixSelection();
  drawAll();
  await flush();
  loadHistory();
}

// ---------- adding things ----------

function addScene() {
  edit("New scene", (clip) => {
    const id = freshId(clip, "scene");
    const i = clip.scenes.findIndex((s) => s.id === S.sceneId);
    clip.scenes.splice(i + 1, 0, { id, label: "New scene", duration: 3, background: clip.background ?? "#080808", layers: [] });
    S.sceneId = id;
    S.sel = { type: "scene", id };
  });
  seek(sceneStarts(S.clip)[S.clip.scenes.findIndex((s) => s.id === S.sceneId)] + 0.001, true);
}

function addLayer(kind) {
  const scene = curScene();
  const local = Math.max(0, Math.min(S.t - sceneStarts(S.clip)[S.clip.scenes.indexOf(scene)], sceneDuration(scene) - 0.2));
  edit("New layer", (clip) => {
    const id = freshId(clip, `${scene.id}-${kind}`);
    const base = { id, kind, label: KIND_NAME[kind] };
    if (local > 0.3) base.start = snap(local);
    if (kind === "text") Object.assign(base, { text: "Text", size: 72, weight: 600, color: "#ffffff", enter: { type: "up", duration: 0.5 } });
    if (kind === "shape") Object.assign(base, { fill: "#7548d9", box: { w: 30, h: 30 }, radius: 24 });
    if (kind === "site") Object.assign(base, { url: "http://localhost:5173", viewport: { width: 1920, height: 1080 }, actions: [{ do: "wait", for: 1 }, { do: "scroll", to: "bottom", for: 5, ease: "inOut" }, { do: "wait", for: 1 }] });
    scene.layers.push(base);
    S.sel = { type: "layer", id };
  });
}

const mediaLayer = (clip, m, stem) => {
  const id = freshId(clip, stem ?? m.name);
  const layer = { id, kind: m.kind, label: m.name.replace(/\.[a-z0-9]+$/i, ""), src: m.path };
  // a picture or a video that isn't the frame's shape is shown whole, not cropped
  const size = frameSize(clip.format);
  if (m.width && Math.abs(m.width / m.height - size.width / size.height) > 0.02) layer.fit = "contain";
  return layer;
};
function addMediaScene(m) {
  edit("New scene from a file", (clip) => {
    const layer = mediaLayer(clip, m);
    const scene = { id: freshId(clip, `scene-${layer.id}`), label: layer.label, duration: round(Math.min(m.kind === "video" ? (m.duration ?? 4) : 3, 600), 2), background: clip.background ?? "#080808", layers: [layer] };
    const i = clip.scenes.findIndex((s) => s.id === S.sceneId);
    clip.scenes.splice(i + 1, 0, scene);
    S.sceneId = scene.id;
    S.sel = { type: "layer", id: layer.id };
  });
  seek(sceneStarts(S.clip)[S.clip.scenes.findIndex((s) => s.id === S.sceneId)] + 0.001, true);
}
function addMediaLayer(m) {
  edit("Layer from a file", (clip) => {
    const scene = curScene();
    const layer = mediaLayer(clip, m);
    scene.layers.push(layer);
    S.sel = { type: "layer", id: layer.id };
  });
}
function addAudio(m) {
  edit("Audio track", (clip) => {
    clip.audio ??= [];
    const id = freshId(clip, m.name);
    clip.audio.push({ id, label: m.name.replace(/\.[a-z0-9]+$/i, ""), src: m.path, start: 0, volume: 0.8, fadeIn: 0.3, fadeOut: 1 });
    S.sel = { type: "audio", id };
  });
}

// A file comes into the clip: looked at, kept in the browser's storage, and given an address the stage can play
async function ingest(file, name = file.name) {
  const kind = kindOf({ type: file.type, name });
  if (!kind) throw new Error("a clip can't use this kind of file (it takes video, pictures, sound and fonts)");
  let info;
  try {
    info = await inspect(file, kind);
  } catch {
    throw new Error(kind === "video" ? "the browser can't play this video (that happens with ProRes and HEVC). Save it again as an MP4 (H.264)" : "the browser can't open this file");
  }
  const item = await B.addMedia(S.clipId, file, safeName(name), { kind, ...info });
  S.urls[item.path] = item.url;
  S.media.push(item);
  return item;
}

async function upload(files) {
  let last = null;
  const added = [];
  for (const file of files) {
    toast(`Adding ${file.name}…`);
    try {
      last = await ingest(file);
      added.push(last);
    } catch (err) {
      toast(`${file.name}: ${err?.name === "QuotaExceededError" ? "the browser is out of storage space for files" : err.message}`, true);
      await new Promise((r) => setTimeout(r, 2500));
    }
  }
  if (last) toast("");
  S.problems = problemsOf(S.clip);
  // the first files of an empty clip go straight onto the timeline: that is what the person came to do
  const fresh = S.clip.scenes.length === 1 && S.clip.scenes[0].layers.every((l) => l.kind === "text" && l.id === "title-text");
  const visual = added.filter((m) => m.kind === "video" || m.kind === "image");
  if (fresh && visual.length) {
    edit("First files", (clip) => {
      clip.scenes = visual.map((m) => {
        const layer = mediaLayer(clip, m);
        return { id: freshId({ scenes: [], audio: [] }, `scene-${layer.id}`), label: layer.label, duration: round(Math.min(m.kind === "video" ? (m.duration ?? 4) : 3, 600), 2), background: clip.background ?? "#080808", layers: [layer] };
      });
      // ids are unique across the clip: scenes made in one go must not collide
      const seen = new Set();
      for (const sc of clip.scenes) {
        let id = sc.id;
        for (let n = 2; seen.has(id) || clip.scenes.some((o) => o !== sc && o.layers.some((l) => l.id === id)); n++) id = `${sc.id}-${n}`;
        sc.id = id;
        seen.add(id);
      }
      clip.scenes.forEach((sc, i) => i > 0 && (sc.transition = { type: "fade", duration: 0.4 }));
      S.sceneId = clip.scenes[0].id;
      S.sel = null;
    });
    S.leftTab = "layers";
    fitZoom();
  } else S.leftTab = "media";
  drawWelcome();
  drawLeft();
  drawNotice();
  showStage();
}

async function removeMedia(m) {
  await B.removeMedia(S.clipId, m.path);
  delete S.urls[m.path];
  S.media = S.media.filter((x) => x !== m);
  drawLeft();
}

// A finished video becomes scenes: one for each shot found in it
async function splitIntoScenes(m) {
  const job = { id: ++jobId, label: `Finding cuts: ${m.name}`, state: "running", progress: 0, note: "Looking at the video…", files: [], stopped: false };
  S.jobs.push(job);
  drawJobs();
  try {
    const { cuts, duration } = await detectCuts(S.urls[m.path], { onProgress: (f) => ((job.progress = f * 0.8), drawJobs()), shouldStop: () => job.stopped });
    if (job.stopped) throw new Error("Stopped.");
    const exact = [];
    for (const [i, c] of cuts.entries()) {
      job.note = `Refining cut ${i + 1} of ${cuts.length}…`;
      job.progress = 0.8 + (0.2 * i) / cuts.length;
      drawJobs();
      exact.push(await refineCut(S.urls[m.path], c, { fps: S.clip.fps }));
    }
    const marks = [0, ...exact, duration];
    edit(`Split into scenes: ${m.name}`, (clip) => {
      const fresh = clip.scenes.length === 1 && clip.scenes[0].layers.every((l) => l.kind === "text" && l.id === "title-text");
      const made = [];
      for (let i = 0; i < marks.length - 1; i++) {
        const layer = mediaLayer({ ...clip, scenes: [...clip.scenes, ...made] }, m, `${m.name.replace(/\.[a-z0-9]+$/i, "")}-${i + 1}`);
        layer.label = `${m.name.replace(/\.[a-z0-9]+$/i, "")} · ${i + 1}`;
        if (marks[i] > 0) layer.trim = { in: round(marks[i]) };
        if (m.audio) layer.volume = 1;
        made.push({ id: freshId({ ...clip, scenes: [...clip.scenes, ...made] }, `shot-${i + 1}`), label: `Scene ${i + 1}`, duration: Math.max(0.1, round(marks[i + 1] - marks[i], 2)), background: clip.background ?? "#080808", layers: [layer] });
      }
      if (fresh) clip.scenes = made;
      else clip.scenes.splice(clip.scenes.findIndex((sc) => sc.id === S.sceneId) + 1, 0, ...made);
      S.sceneId = made[0].id;
      S.sel = null;
    });
    job.state = "done";
    job.progress = 1;
    job.note = cuts.length ? `Found ${cuts.length} ${cuts.length === 1 ? "cut" : "cuts"}: the video is now ${cuts.length + 1} scenes.` : "No cuts found: the video was added as one scene. Press S to split it by hand.";
    job.doneNote = job.note;
    S.leftTab = "layers";
    drawWelcome();
    drawLeft();
    fitZoom();
  } catch (err) {
    job.state = job.stopped ? "stopped" : "failed";
    job.error = job.stopped ? "Stopped." : `That didn't work: ${err?.message ?? err}`;
  }
  drawJobs();
}

// Recording a tab: the browser asks which one, the person shows their site there, and the take becomes a scene
async function startTabRecording() {
  if (S.recording) return;
  const finish = async () => {
    const rec = S.recording;
    if (!rec) return;
    S.recording = null;
    clearInterval(rec.timer);
    toast("Saving the recording…");
    try {
      const blob = await rec.stop();
      if (blob.size < 2000) throw new Error("the recording is empty");
      const d = new Date();
      const name = `Recording-${String(d.getHours()).padStart(2, "0")}-${String(d.getMinutes()).padStart(2, "0")}-${String(d.getSeconds()).padStart(2, "0")}.${blob.type.includes("mp4") ? "mp4" : "webm"}`;
      const item = await ingest(new File([blob], name, { type: blob.type }), name);
      toast("");
      addMediaScene(item);
      S.leftTab = "layers";
      drawLeft();
    } catch (err) {
      toast(`The recording wasn't saved: ${err.message}`, true);
    }
    drawJobs();
  };
  try {
    toast("In the browser's dialog, choose Tab and the site you want to show.");
    const rec = await recordTab({ fps: Math.max(30, S.clip.fps), onEnd: finish });
    toast("");
    S.recording = { ...rec, finish, timer: setInterval(drawJobs, 500) };
    drawWelcome();
    drawLeft();
    drawJobs();
  } catch (err) {
    toast(err?.name === "NotAllowedError" ? "" : `The recording didn't start: ${err.message}`, true);
  }
}

let toastEl = null;
function toast(text, bad = false) {
  toastEl?.remove();
  toastEl = null;
  if (!text) return;
  toastEl = h("div", { class: `job ${bad ? "failed" : ""}` }, h("div", { class: "note" }, text));
  $("jobs").prepend(toastEl);
  if (bad) setTimeout(() => toastEl?.remove(), 6000);
}

// ---------- timeline ----------

const TL_PAD = 12;
const x2t = (x) => (x - TL_PAD) / S.zoom;
const t2x = (t) => TL_PAD + t * S.zoom;

function drawTimeline() {
  const inner = $("tlInner");
  const total = totalDuration(S.clip);
  const starts = sceneStarts(S.clip);
  const width = t2x(total) + 240;
  inner.style.width = `${width}px`;
  const kids = [];

  const step = [0.1, 0.25, 0.5, 1, 2, 5, 10, 15, 30, 60].find((s) => s * S.zoom >= 64) ?? 60;
  const ruler = h("div", { class: "ruler", onpointerdown: scrubDown });
  for (let t = 0; t <= total + step; t += step) ruler.append(h("span", { style: `left:${t2x(t)}px` }, step < 1 ? `${round(t, 2)}` : fmtTime(t, S.clip.fps).slice(0, 5)));
  kids.push(ruler);

  const sceneTrack = h("div", { class: "track scenes" });
  S.clip.scenes.forEach((scene, i) => {
    const w = sceneDuration(scene) * S.zoom;
    const tr = i > 0 && scene.transition && scene.transition.type !== "cut" ? Math.min(scene.transition.duration ?? 0.5, sceneDuration(scene)) : 0;
    sceneTrack.append(
      h(
        "div",
        { class: `sceneBlock ${scene.id === S.sceneId ? "on" : ""}`, style: `left:${t2x(starts[i])}px;width:${Math.max(6, w - 2)}px`, title: `${scene.label ?? scene.id} · ${secs(sceneDuration(scene))}`, onpointerdown: (e) => sceneDown(e, scene, i) },
        tr ? h("div", { class: "tr", style: `width:${tr * S.zoom}px`, title: TRANSITION_NAME[scene.transition.type] }) : null,
        h("div", { class: "lbl" }, scene.label ?? scene.id),
        h("div", { class: "dur" }, secs(sceneDuration(scene))),
        h("div", { class: "grip r", "data-grip": "r" }),
      ),
    );
  });
  kids.push(sceneTrack);

  const scene = curScene();
  const si = S.clip.scenes.indexOf(scene);
  const s0 = starts[si];
  kids.push(h("div", { class: "sceneShade", style: `left:${t2x(s0)}px;width:${sceneDuration(scene) * S.zoom}px` }));
  for (const layer of [...scene.layers].reverse()) {
    const L = resolveLayer(layer, S.format);
    const span = layerSpan(layer, scene);
    const len = Math.min(span.duration, sceneDuration(scene) - span.start);
    kids.push(
      h(
        "div",
        { class: "track" },
        h(
          "div",
          { class: `bar2 ${layer.kind} ${S.sel?.id === layer.id ? "on" : ""} ${L.hidden ? "off" : ""}`, style: `left:${t2x(s0 + span.start)}px;width:${Math.max(8, len * S.zoom - 1)}px`, title: `${layer.label ?? layer.id} · ${secs(len)}`, onpointerdown: (e) => layerDown(e, layer, scene) },
          h("div", { class: "grip l", "data-grip": "l" }),
          h("div", { class: "lbl" }, layer.label ?? layer.id),
          h("div", { class: "grip r", "data-grip": "r" }),
        ),
      ),
    );
  }
  for (const a of S.clip.audio ?? []) {
    const start = a.start ?? 0;
    const len = Math.max(0.1, Math.min(a.duration ?? total - start, total - start));
    kids.push(
      h(
        "div",
        { class: "track" },
        h("div", { class: `bar2 audio ${S.sel?.id === a.id ? "on" : ""}`, style: `left:${t2x(start)}px;width:${Math.max(8, len * S.zoom - 1)}px`, onpointerdown: (e) => audioDown(e, a) }, h("div", { class: "lbl" }, `♪ ${a.label ?? a.src.split("/").pop()}`), h("div", { class: "grip r", "data-grip": "r" })),
      ),
    );
  }
  kids.push(h("div", { class: "playhead", id: "playhead" }));
  inner.replaceChildren(...kids);
  drawPlayhead();
}

function drawPlayhead() {
  const ph = $("playhead");
  if (ph) ph.style.left = `${t2x(S.t)}px`;
  $("time").textContent = fmtTime(S.t, S.clip.fps);
  if (S.playing) {
    const tl = $("timeline");
    const x = t2x(S.t);
    if (x > tl.scrollLeft + tl.clientWidth - 40 || x < tl.scrollLeft) tl.scrollLeft = Math.max(0, x - 80);
  }
}

// One pointer drag on the timeline: `on(dt, event)` gets the time moved since the press
function drag(e, on, done) {
  e.preventDefault();
  let moved = false;
  S.dragging = true;
  const move = (ev) => {
    const dx = ev.clientX - e.clientX;
    if (!moved && Math.abs(dx) < 3) return;
    moved = true;
    on(dx / S.zoom, ev);
  };
  const up = (ev) => {
    removeEventListener("pointermove", move);
    removeEventListener("pointerup", up);
    S.dragging = false;
    done?.(moved, ev);
  };
  addEventListener("pointermove", move);
  addEventListener("pointerup", up);
}

function scrubDown(e) {
  play(false);
  const tl = $("timeline");
  const at = (ev) => x2t(ev.clientX - $("tlInner").getBoundingClientRect().left);
  seek(at(e));
  const move = (ev) => seek(at(ev));
  const up = () => {
    removeEventListener("pointermove", move);
    removeEventListener("pointerup", up);
    const s = sceneAt(S.clip, S.t).scene;
    if (s.id !== S.sceneId) {
      S.sceneId = s.id;
      drawLeft();
      drawTimeline();
    }
  };
  addEventListener("pointermove", move);
  addEventListener("pointerup", up);
  void tl;
}

function sceneDown(e, scene, index) {
  if (e.button !== 0) return;
  const grip = e.target.dataset?.grip;
  const d0 = sceneDuration(scene);
  const starts = sceneStarts(S.clip);
  if (grip === "r") {
    return drag(
      e,
      (dt) => edit("Scene duration", () => (scene.duration = Math.max(0.2, snap(d0 + dt))), { live: true }),
      (moved) => (moved ? endLive() : select({ type: "scene", id: scene.id })),
    );
  }
  let target = index;
  drag(
    e,
    (dt) => {
      // where the block's middle now falls among the other scenes
      const mid = starts[index] + d0 / 2 + dt;
      let acc = 0;
      target = S.clip.scenes.length - 1;
      const others = S.clip.scenes.filter((s) => s !== scene);
      for (let i = 0; i < others.length; i++) {
        if (mid < acc + sceneDuration(others[i]) / 2) {
          target = i;
          break;
        }
        acc += sceneDuration(others[i]);
      }
      e.target.closest(".sceneBlock").style.transform = `translateX(${dt * S.zoom}px)`;
    },
    (moved) => {
      if (!moved) {
        select({ type: "scene", id: scene.id });
        return seekInto(starts[index], scene);
      }
      if (target === index) return drawTimeline();
      edit("Scene order", (clip) => {
        clip.scenes.splice(index, 1);
        clip.scenes.splice(target, 0, scene);
        // the scene that opens the clip has nothing to come in over
        S.sceneId = scene.id;
      });
    },
  );
}

function layerDown(e, layer, scene) {
  if (e.button !== 0) return;
  const grip = e.target.dataset?.grip;
  const span = layerSpan(layer, scene);
  const total = sceneDuration(scene);
  const trim0 = layer.trim?.in ?? 0;
  const speed = layer.speed ?? 1;
  const moving = layer.kind === "video" || (layer.kind === "site" && layer.recording);
  if (S.sel?.id !== layer.id) select({ type: "layer", id: layer.id });
  drag(
    e,
    (dt) =>
      edit(
        "Layer timing",
        () => {
          if (grip === "r") {
            const end = Math.max(span.start + 0.1, Math.min(total, snap(span.end + dt)));
            if (end >= total - 1e-3) delete layer.duration;
            else layer.duration = round(end - span.start);
          } else if (grip === "l") {
            // the left edge moves; the right one stays, and a video starts later in its file
            let start = Math.max(0, Math.min(span.end - 0.1, snap(span.start + dt)));
            if (moving) start = Math.max(start, span.start - trim0 / speed);
            if (start < 0.001) delete layer.start;
            else layer.start = start;
            if (!span.open) layer.duration = round(span.end - start);
            if (moving) {
              const t = round(Math.max(0, trim0 + (start - span.start) * speed));
              if (t > 0.001) layer.trim = { ...(layer.trim ?? {}), in: t };
              else delete layer.trim;
            }
          } else {
            const len = Math.min(span.duration, total - span.start);
            const start = Math.max(0, Math.min(total - 0.1, snap(span.start + dt)));
            if (start < 0.001) delete layer.start;
            else layer.start = start;
            if (span.open && start + len < total - 1e-3) layer.duration = round(len);
          }
        },
        { live: true },
      ),
    (moved) => moved && endLive(),
  );
}

function audioDown(e, a) {
  if (e.button !== 0) return;
  const grip = e.target.dataset?.grip;
  const total = totalDuration(S.clip);
  const start0 = a.start ?? 0;
  const len0 = a.duration ?? total - start0;
  if (S.sel?.id !== a.id) select({ type: "audio", id: a.id });
  drag(
    e,
    (dt) =>
      edit(
        "Audio timing",
        () => {
          if (grip === "r") {
            const len = Math.max(0.2, snap(len0 + dt));
            if (start0 + len >= total - 1e-3) delete a.duration;
            else a.duration = len;
          } else a.start = Math.max(0, Math.min(total - 0.2, snap(start0 + dt)));
        },
        { live: true },
      ),
    (moved) => moved && endLive(),
  );
}

function splitAtPlayhead() {
  const at = sceneAt(S.clip, S.t);
  const local = snap(at.local);
  let done = null;
  edit("Scene split", (clip) => {
    done = splitScene(clip, at.scene.id, local);
    if (done) {
      S.sceneId = done.second;
      S.sel = { type: "scene", id: done.second };
    }
  });
  if (!done) toast("A split has to be at least 0.1 s from the scene's edge.", true);
}

function removeSelected() {
  if (!S.sel) return;
  if (S.sel.type === "scene") {
    if (S.clip.scenes.length < 2) return toast("A clip needs at least one scene.", true);
    edit("Scene deleted", (clip) => {
      const i = clip.scenes.findIndex((s) => s.id === S.sel.id);
      clip.scenes.splice(i, 1);
      S.sceneId = clip.scenes[Math.max(0, i - 1)].id;
      S.sel = null;
    });
  } else if (S.sel.type === "layer") {
    edit("Layer deleted", (clip) => {
      const f = findLayer(clip, S.sel.id);
      f.scene.layers.splice(f.scene.layers.indexOf(f.layer), 1);
      S.sel = { type: "scene", id: f.scene.id };
    });
  } else
    edit("Audio deleted", (clip) => {
      clip.audio = clip.audio.filter((a) => a.id !== S.sel.id);
      S.sel = null;
    });
  seek(S.t, true);
}

// ---------- inspector ----------

function drawRight() {
  const body = $("rightBody");
  $("rightTabs").hidden = !PROJECT;
  for (const b of $("rightTabs").children) b.classList.toggle("on", b.dataset.tab === S.rightTab);
  $("aiDot").hidden = !S.cards.some((c) => c.state === "running" || c.state === "ready" || c.state === "question");
  if (PROJECT && S.rightTab === "ai") return void body.replaceChildren(...cardsView());
  const f = selLayer();
  if (f) body.replaceChildren(...layerProps(f.layer, f.scene));
  else if (S.sel?.type === "scene") body.replaceChildren(...sceneProps(findScene(S.clip, S.sel.id)));
  else if (S.sel?.type === "audio") body.replaceChildren(...audioProps(S.clip.audio.find((a) => a.id === S.sel.id)));
  else body.replaceChildren(...clipProps());
}

// Fields. Each writes through `set`, live while the person types or drags, and is one step back when they stop.
const field = (label, ...control) => h("div", { class: "field" }, h("label", {}, label), h("div", { class: "row" }, ...control));
const liveEdit = (label, fn) => edit(label, fn, { live: true, quiet: true });

function num(label, get, set, { min, max, step = 1, unit, slider = false, empty } = {}) {
  const apply = (raw) => {
    if (raw === "" && empty !== undefined) return liveEdit(label, () => set(undefined));
    let v = Number(raw);
    if (!Number.isFinite(v)) return;
    if (min != null) v = Math.max(min, v);
    if (max != null) v = Math.min(max, v);
    liveEdit(label, () => set(v));
  };
  const v = get();
  const box = h("input", { type: "number", value: v ?? "", placeholder: empty, min, max, step, oninput: (e) => (apply(e.target.value), range && e.target.value !== "" && (range.value = e.target.value)), onchange: endLive });
  const range = slider ? h("input", { type: "range", min, max, step, value: v ?? min, oninput: (e) => ((box.value = e.target.value), apply(e.target.value)), onchange: endLive }) : null;
  if (slider) box.style.width = "64px";
  return field(label, range, box, unit ? h("span", { class: "unit" }, unit) : null);
}
function text(label, get, set, { area = false, type = "text", placeholder } = {}) {
  const el = h(area ? "textarea" : "input", { type: area ? null : type, value: get() ?? "", placeholder, spellcheck: "false", oninput: (e) => liveEdit(label, () => set(e.target.value)), onchange: endLive });
  const f = field(label, el);
  if (area) f.classList.add("tall");
  return f;
}
function choice(label, get, set, options, names = {}) {
  return field(label, h("select", { onchange: (e) => edit(label, () => set(e.target.value)) }, options.map((o) => h("option", { value: o, selected: o === get() }, names[o] ?? o))));
}
function color(label, get, set) {
  const v = get() ?? "#000000";
  const hex = h("input", { type: "text", value: v, spellcheck: "false", oninput: (e) => /^#[0-9a-f]{3,8}$/i.test(e.target.value) && (liveEdit(label, () => set(e.target.value)), (sw.value = e.target.value.slice(0, 7))), onchange: endLive });
  const sw = h("input", { type: "color", value: /^#[0-9a-f]{6}/i.test(v) ? v.slice(0, 7) : "#000000", oninput: (e) => ((hex.value = e.target.value), liveEdit(label, () => set(e.target.value))), onchange: endLive });
  return field(label, sw, hex);
}
const check = (label, get, set) => h("label", { class: "check" }, h("input", { type: "checkbox", checked: !!get(), onchange: (e) => edit(label, () => set(e.target.checked)) }), label);
const group = (title, ...kids) => h("div", { class: "group" }, h("h3", {}, title), ...kids);

function motionFields(label, layer, key) {
  const m = () => layer[key] ?? {};
  const put = (patch) => {
    const next = { ...m(), ...patch };
    if (!next.type || next.type === "none") delete layer[key];
    else layer[key] = next;
  };
  const out = [choice(label, () => m().type ?? "none", (v) => put({ type: v, duration: m().duration ?? (key === "enter" ? 0.5 : 0.4) }), MOTIONS, MOTION_NAME)];
  if (m().type && m().type !== "none") {
    out.push(num("Duration", () => m().duration ?? 0.5, (v) => put({ duration: v }), { min: 0, max: 10, step: 0.05, unit: "s" }));
    out.push(choice("Easing", () => m().ease ?? (key === "enter" ? "out" : "in"), (v) => put({ ease: v }), EASES, EASE_NAME));
  }
  return out;
}

function layerProps(layer, scene) {
  const fmt = S.format;
  const other = fmt !== S.clip.format;
  const L = () => resolveLayer(layer, fmt);
  const place = (key) => (v) => setPlaced(S.clip, layer, fmt, key, v);
  const span = layerSpan(layer, scene);
  const out = [h("div", { class: "head" }, h("i", { class: `kind ${layer.kind}` }), h("input", { value: layer.label ?? layer.id, "aria-label": "Layer name", oninput: (e) => liveEdit("Layer name", () => (layer.label = e.target.value)), onchange: endLive }), h("span", { class: "dim" }, KIND_NAME[layer.kind]))];

  if (layer.kind === "text") {
    out.push(
      group(
        "Text",
        text("Words", () => layer.text, (v) => (layer.text = v), { area: true }),
        text("Font", () => layer.font ?? "", (v) => (v.trim() ? (layer.font = v.trim()) : delete layer.font), { placeholder: "Instrument Sans" }),
        num("Size", () => L().size ?? 64, place("size"), { min: 8, max: 600, step: 1, slider: true }),
        num("Weight", () => layer.weight ?? 500, (v) => (layer.weight = v), { min: 100, max: 900, step: 100, slider: true }),
        color("Color", () => layer.color ?? "#ffffff", (v) => (layer.color = v)),
        choice("Align", () => L().align ?? "center", place("align"), ["left", "center", "right"], { left: "Left", center: "Center", right: "Right" }),
        num("Width", () => L().maxWidth ?? 84, place("maxWidth"), { min: 10, max: 100, step: 1, unit: "%", slider: true }),
        num("Tracking", () => layer.letterSpacing ?? -0.02, (v) => (layer.letterSpacing = v), { min: -0.1, max: 0.5, step: 0.005, unit: "em" }),
        num("Line height", () => layer.lineHeight ?? 1.05, (v) => (layer.lineHeight = v), { min: 0.7, max: 2.5, step: 0.05 }),
        check("Uppercase", () => layer.uppercase, (v) => (v ? (layer.uppercase = true) : delete layer.uppercase)),
      ),
    );
    const an = () => layer.animate ?? {};
    out.push(
      group(
        "Piece-by-piece entrance",
        choice("Split by", () => layer.animate?.by ?? "none", (v) => (v === "none" ? delete layer.animate : (layer.animate = { type: "up", ...an(), by: v })), ["none", ...TEXT_UNITS], { none: "All at once", ...UNIT_NAME }),
        ...(layer.animate
          ? [
              choice("How", () => an().type ?? "up", (v) => (layer.animate = { ...an(), type: v }), TEXT_MOTIONS, MOTION_NAME),
              num("Stagger", () => an().stagger ?? (an().by === "letter" ? 0.03 : an().by === "word" ? 0.08 : 0.14), (v) => (layer.animate = { ...an(), stagger: v }), { min: 0, max: 2, step: 0.01, unit: "s" }),
              num("Each takes", () => an().duration ?? 0.5, (v) => (layer.animate = { ...an(), duration: v }), { min: 0.05, max: 5, step: 0.05, unit: "s" }),
            ]
          : []),
      ),
    );
    const cn = () => layer.count ?? {};
    out.push(
      group(
        "Counting number",
        check("Count the number in the text", () => !!layer.count, (v) => { if (v) { layer.count = { from: 0, to: 100 }; if (!layer.text.includes("{n}")) layer.text = "{n}"; } else { layer.text = layer.text.replace("{n}", String(layer.count?.to ?? "")); delete layer.count; } }),
        ...(layer.count
          ? [
              field("From, to", h("div", { class: "pair" }, h("input", { type: "number", step: "any", value: cn().from ?? 0, oninput: (e) => liveEdit("Counter", () => (layer.count = { ...cn(), from: Number(e.target.value) || 0 })), onchange: endLive }), h("input", { type: "number", step: "any", value: cn().to, oninput: (e) => liveEdit("Counter", () => (layer.count = { ...cn(), to: Number(e.target.value) || 0 })), onchange: endLive }))),
              num("Decimals", () => cn().decimals ?? 0, (v) => (layer.count = { ...cn(), decimals: Math.round(v) }), { min: 0, max: 4, step: 1 }),
              num("Counts for", () => cn().duration ?? Math.min(span.duration, 1.5), (v) => (layer.count = { ...cn(), duration: v }), { min: 0.1, max: 30, step: 0.1, unit: "s" }),
              h("div", { class: "hint small" }, "The number goes where {n} is in the text: “{n}%”, “+{n} clients”."),
            ]
          : []),
      ),
    );
    if (layer.font && !["Instrument Sans"].includes(layer.font) && !(S.clip.fonts ?? []).some((f) => (typeof f === "string" ? f : f.family) === layer.font))
      out.push(h("div", { class: "status warn" }, `The font “${layer.font}” is not in the clip. `, h("button", { class: "ghost", onclick: () => edit("Font added", (clip) => (clip.fonts = [...(clip.fonts ?? []), layer.font])) }, "Add from Google Fonts")));
  }
  if (layer.kind === "video" || (layer.kind === "site" && layer.recording)) {
    const m = S.media.find((x) => x.path === (layer.kind === "site" ? layer.recording : layer.src));
    out.push(
      group(
        "Video",
        num("Start at", () => layer.trim?.in ?? 0, (v) => (v > 0 ? (layer.trim = { ...(layer.trim ?? {}), in: v }) : delete layer.trim), { min: 0, max: m?.duration ?? 3600, step: 0.05, unit: "s" }),
        num("Speed", () => layer.speed ?? 1, (v) => (v === 1 ? delete layer.speed : (layer.speed = v)), { min: 0.1, max: 8, step: 0.05, unit: "×", slider: true }),
        layer.kind === "video" && m?.audio ? num("Sound", () => layer.volume ?? 0, (v) => (v > 0 ? (layer.volume = v) : delete layer.volume), { min: 0, max: 1, step: 0.05, slider: true }) : null,
        m?.duration ? h("div", { class: "hint small" }, `The file is ${secs(m.duration)} long${m.width ? `, ${m.width}×${m.height}` : ""}.`) : null,
      ),
    );
  }
  if (layer.kind === "shape") out.push(group("Shape", choice("Shape", () => layer.shape ?? "rect", (v) => (v === "rect" ? delete layer.shape : (layer.shape = v)), SHAPES, { rect: "Rectangle", ellipse: "Circle or oval" }), color("Color", () => layer.fill ?? "#7548d9", (v) => (layer.fill = v))));
  if (layer.kind === "site" && PROJECT) out.push(siteGroup(layer));

  const placing = [];
  if (layer.kind !== "text") {
    if (layer.kind !== "shape") {
      placing.push(choice("Fit", () => L().fit ?? "cover", place("fit"), FITS, { cover: "Fill (crops)", contain: "Fit whole" }));
      if ((L().fit ?? "cover") === "cover")
        placing.push(field("Focus point", h("div", { class: "pair" }, h("input", { type: "number", min: 0, max: 100, step: 1, value: L().focus?.x ?? 50, title: "Horizontal, %", oninput: (e) => liveEdit("Focus", () => place("focus")({ x: Number(e.target.value), y: L().focus?.y ?? 50 })), onchange: endLive }), h("input", { type: "number", min: 0, max: 100, step: 1, value: L().focus?.y ?? 50, title: "Vertical, %", oninput: (e) => liveEdit("Focus", () => place("focus")({ x: L().focus?.x ?? 50, y: Number(e.target.value) })), onchange: endLive }))));
    }
    placing.push(field("Box, %", h("div", { class: "pair" }, h("input", { type: "number", min: 1, max: 300, step: 1, value: L().box?.w ?? 100, title: "Width, % of the frame", oninput: (e) => liveEdit("Box", () => place("box")({ w: Math.max(1, Number(e.target.value) || 100), h: L().box?.h ?? 100 })), onchange: endLive }), h("input", { type: "number", min: 1, max: 300, step: 1, value: L().box?.h ?? 100, title: "Height, % of the frame", oninput: (e) => liveEdit("Box", () => place("box")({ w: L().box?.w ?? 100, h: Math.max(1, Number(e.target.value) || 100) })), onchange: endLive }))));
  }
  placing.push(
    field("Position", h("div", { class: "pair" }, h("input", { type: "number", step: 0.5, value: L().x ?? 0, title: "X, % of the frame from the center", oninput: (e) => liveEdit("Position", () => place("x")(Number(e.target.value) || 0)), onchange: endLive }), h("input", { type: "number", step: 0.5, value: L().y ?? 0, title: "Y, % of the frame from the center", oninput: (e) => liveEdit("Position", () => place("y")(Number(e.target.value) || 0)), onchange: endLive }))),
    num("Scale", () => L().scale ?? 1, place("scale"), { min: 0.05, max: 5, step: 0.01, slider: true }),
    num("Rotation", () => L().rotate ?? 0, place("rotate"), { min: -180, max: 180, step: 1, unit: "°" }),
    num("Opacity", () => layer.opacity ?? 1, (v) => (v >= 1 ? delete layer.opacity : (layer.opacity = v)), { min: 0, max: 1, step: 0.01, slider: true }),
  );
  if (layer.kind !== "text") placing.push(num("Corner radius", () => layer.radius ?? 0, (v) => (v > 0 ? (layer.radius = v) : delete layer.radius), { min: 0, max: 540, step: 1 }));
  const g = group("Position", ...placing);
  if (other) {
    g.firstChild.append(h("small", {}, `${fmt} only`));
    if (layer.formats?.[fmt]) g.append(h("div", { class: "btnRow" }, h("button", { class: "line", onclick: () => edit("Format reset", () => (delete layer.formats[fmt], Object.keys(layer.formats).length || delete layer.formats)) }, `Same as ${S.clip.format}`)));
  }
  out.push(g);

  out.push(
    group(
      "Timing",
      num("Start", () => span.start, (v) => (v > 0 ? (layer.start = Math.min(v, sceneDuration(scene) - 0.1)) : delete layer.start), { min: 0, max: sceneDuration(scene), step: 0.05, unit: "s" }),
      num("Duration", () => (span.open ? undefined : span.duration), (v) => (v == null ? delete layer.duration : (layer.duration = Math.max(0.05, v))), { min: 0.05, step: 0.05, unit: "s", empty: "to the scene's end" }),
    ),
  );
  out.push(group("Animation", ...motionFields("Entrance", layer, "enter"), ...motionFields("Exit", layer, "exit"), ...moveFields(layer)));
  const idx = scene.layers.indexOf(layer);
  out.push(
    h(
      "div",
      { class: "btnRow" },
      h("button", { class: "line", disabled: idx >= scene.layers.length - 1, onclick: () => edit("Layer order", () => (scene.layers.splice(idx, 1), scene.layers.splice(idx + 1, 0, layer))) }, "Forward"),
      h("button", { class: "line", disabled: idx <= 0, onclick: () => edit("Layer order", () => (scene.layers.splice(idx, 1), scene.layers.splice(idx - 1, 0, layer))) }, "Backward"),
      h("button", { class: "line", onclick: () => edit("Layer copy", (clip) => { const copy = structuredClone(layer); copy.id = freshId(clip, `${layer.id}-copy`); copy.label = `${layer.label ?? layer.id} (copy)`; scene.layers.splice(idx + 1, 0, copy); S.sel = { type: "layer", id: copy.id }; }) }, "Copy"),
      h("button", { class: "line danger", onclick: removeSelected }, "Delete"),
    ),
  );
  return out;
}

function moveFields(layer) {
  const on = !!layer.move;
  const out = [check("Slow zoom or pan", () => on, (v) => (v ? (layer.move = { from: { scale: 1 }, to: { scale: 1.12 }, ease: "inOut" }) : delete layer.move))];
  if (!on) return out;
  const part = (side, key, dflt) => h("input", { type: "number", step: key === "scale" ? 0.01 : 0.5, value: layer.move[side]?.[key] ?? dflt, title: `${side === "from" ? "At the start" : "At the end"}: ${key === "scale" ? "scale" : key.toUpperCase() + ", %"}`, oninput: (e) => liveEdit("Zoom", () => (layer.move[side] = { ...(layer.move[side] ?? {}), [key]: Number(e.target.value) || 0 })), onchange: endLive });
  out.push(field("Scale", h("div", { class: "pair" }, part("from", "scale", 1), part("to", "scale", 1))), field("Shift X", h("div", { class: "pair" }, part("from", "x", 0), part("to", "x", 0))), field("Shift Y", h("div", { class: "pair" }, part("from", "y", 0), part("to", "y", 0))), choice("Easing", () => layer.move.ease ?? "inOut", (v) => (layer.move.ease = v), EASES, EASE_NAME), h("div", { class: "hint small" }, "Left: at the layer's start. Right: at its end."));
  return out;
}

const VIEWPORTS = { "1920×1080": { width: 1920, height: 1080 }, "1440×900": { width: 1440, height: 900 }, "1280×800": { width: 1280, height: 800 }, "Tablet 834×1194": { width: 834, height: 1194, scale: 2 }, "Phone 390×844": { width: 390, height: 844, scale: 3 } };

function siteGroup(layer) {
  const job = S.sjobs.find((j) => j.kind === "record" && j.layerId === layer.id && j.state === "running");
  const vpName = Object.entries(VIEWPORTS).find(([, v]) => v.width === (layer.viewport?.width ?? 1920) && v.height === (layer.viewport?.height ?? 1080))?.[0] ?? "1920×1080";
  const actions = layer.actions ?? [];
  const setAct = (i, patch) => liveEdit("Recording script", () => (layer.actions[i] = { ...layer.actions[i], ...patch }));
  const rows = actions.map((a, i) => {
    let param = h("span", {});
    if (a.do === "scroll") param = h("input", { value: a.to ?? "", placeholder: "bottom, 1200, #section", title: "Where to: pixels, bottom, top or a CSS selector", oninput: (e) => setAct(i, { to: /^\d+(\.\d+)?$/.test(e.target.value.trim()) ? Number(e.target.value) : e.target.value.trim() }), onchange: endLive });
    else if (a.do === "wheel") param = h("input", { type: "number", value: a.by ?? 1000, title: "By how many pixels", oninput: (e) => setAct(i, { by: Number(e.target.value) || 0 }), onchange: endLive });
    else if (a.do === "move" || a.do === "click") param = h("input", { value: Array.isArray(a.to) ? a.to.join(", ") : (a.to ?? ""), placeholder: a.do === "click" ? "selector (or where the pointer is)" : "selector or x, y", oninput: (e) => { const v = e.target.value.trim(); const xy = /^(-?\d+(\.\d+)?)\s*,\s*(-?\d+(\.\d+)?)$/.exec(v); setAct(i, { to: xy ? [Number(xy[1]), Number(xy[3])] : v || undefined }); }, onchange: endLive });
    else if (a.do === "type") param = h("input", { value: a.text ?? "", placeholder: "what to type", oninput: (e) => setAct(i, { text: e.target.value }), onchange: endLive });
    else if (a.do === "key") param = h("input", { value: a.key ?? "", placeholder: "Enter", oninput: (e) => setAct(i, { key: e.target.value.trim() }), onchange: endLive });
    return h(
      "div",
      { class: "act" },
      h("select", { onchange: (e) => edit("Recording script", () => { const d = e.target.value; layer.actions[i] = { do: d, for: a.for ?? 1, ...(d === "scroll" ? { to: "bottom" } : d === "wheel" ? { by: 1200 } : d === "move" ? { to: [960, 540] } : d === "type" ? { text: "" } : d === "key" ? { key: "Enter" } : {}) }; }) }, Object.keys(ACTION_NAME).map((k) => h("option", { value: k, selected: k === a.do }, ACTION_NAME[k]))),
      param,
      h("input", { type: "number", min: 0, max: 120, step: 0.1, value: a.for ?? 0, title: "How many seconds", oninput: (e) => setAct(i, { for: Math.max(0, Number(e.target.value) || 0) }), onchange: endLive }),
      h("button", { title: "Remove the action", onclick: () => edit("Recording script", () => layer.actions.splice(i, 1)) }, "×"),
    );
  });
  const stale = layer.recording && layer.recorded && layer.recorded !== siteKey(layer);
  const status = job
    ? h("div", { class: "status" }, job.note || "Getting ready to record…")
    : !layer.recording
      ? h("div", { class: "status warn" }, "Not recorded yet. The site gets into the video only once it is recorded.")
      : stale
        ? h("div", { class: "status warn" }, "The address or the script changed after the recording. Record again so the video matches them.")
        : h("div", { class: "status ok" }, "Recorded. From here the layer behaves like any video: you can trim it, speed it up and crop it.");
  return group(
    "Site",
    text("Address", () => layer.url, (v) => (layer.url = v.trim()), { type: "url", placeholder: "http://localhost:5173" }),
    choice("Window", () => vpName, (v) => (layer.viewport = { ...VIEWPORTS[v] }), Object.keys(VIEWPORTS)),
    check("Show the pointer", () => layer.cursor, (v) => (v ? (layer.cursor = true) : delete layer.cursor)),
    h("div", { class: "sub", style: "margin:10px 0 4px" }, `Script · ${secs(actionsDuration(actions))}`),
    ...rows,
    h("div", { class: "btnRow" }, h("button", { class: "line", onclick: () => edit("Recording script", () => (layer.actions = [...actions, { do: "wait", for: 1 }])) }, "+ Action")),
    status,
    h("div", { class: "btnRow" }, job ? h("button", { class: "line danger", onclick: () => B.stopJob(job.id) }, "Stop") : h("button", { class: "primary", disabled: !S.tools.chrome || !S.tools.ffmpeg, onclick: () => record(layer.id) }, layer.recording ? "Record again" : "Record")),
    h("div", { class: "hint small" }, "The site is recorded frame by frame: the page's clock follows the editor, so even a heavy WebGL scene comes out smooth. Use Wheel for sites with no real scroll."),
  );
}

async function record(layerId) {
  try {
    await flush();
    await B.record(layerId);
    poll();
  } catch (err) {
    toast(err.message, true);
  }
}

function sceneProps(scene) {
  const i = S.clip.scenes.indexOf(scene);
  const tr = () => scene.transition ?? { type: "cut" };
  const out = [
    h("div", { class: "head" }, h("input", { value: scene.label ?? scene.id, "aria-label": "Scene name", oninput: (e) => liveEdit("Scene name", () => (scene.label = e.target.value)), onchange: endLive }), h("span", { class: "dim" }, `Scene ${i + 1}`)),
    group("Scene", num("Duration", () => sceneDuration(scene), (v) => (scene.duration = v), { min: 0.2, max: 600, step: 0.05, unit: "s" }), color("Background", () => scene.background ?? S.clip.background ?? "#000000", (v) => (scene.background = v))),
  ];
  if (i > 0)
    out.push(
      group(
        "Transition from the previous scene",
        choice("Type", () => tr().type, (v) => (v === "cut" ? delete scene.transition : (scene.transition = { type: v, duration: tr().duration ?? 0.5 })), TRANSITIONS, TRANSITION_NAME),
        tr().type !== "cut" ? num("Duration", () => tr().duration ?? 0.5, (v) => (scene.transition = { ...tr(), duration: v }), { min: 0, max: 5, step: 0.05, unit: "s" }) : null,
      ),
    );
  out.push(
    h(
      "div",
      { class: "btnRow" },
      h("button", { class: "line", disabled: i <= 0, onclick: () => edit("Scene order", (clip) => (clip.scenes.splice(i, 1), clip.scenes.splice(i - 1, 0, scene))) }, "← Earlier"),
      h("button", { class: "line", disabled: i >= S.clip.scenes.length - 1, onclick: () => edit("Scene order", (clip) => (clip.scenes.splice(i, 1), clip.scenes.splice(i + 1, 0, scene))) }, "Later →"),
      h("button", { class: "line", onclick: () => edit("Scene copy", (clip) => { const id = duplicateScene(clip, scene.id); S.sceneId = id; S.sel = { type: "scene", id }; }) }, "Copy"),
      h("button", { class: "line", onclick: splitAtPlayhead }, "Split"),
      h("button", { class: "line danger", onclick: removeSelected }, "Delete"),
    ),
  );
  return out;
}

function audioProps(a) {
  const total = totalDuration(S.clip);
  return [
    h("div", { class: "head" }, h("i", { class: "kind audio" }), h("input", { value: a.label ?? a.src.split("/").pop(), "aria-label": "Track name", oninput: (e) => liveEdit("Name", () => (a.label = e.target.value)), onchange: endLive }), h("span", { class: "dim" }, "Audio")),
    group(
      "Track",
      num("Start", () => a.start ?? 0, (v) => (a.start = v), { min: 0, max: total, step: 0.05, unit: "s" }),
      num("Start at", () => a.trimIn ?? 0, (v) => (v > 0 ? (a.trimIn = v) : delete a.trimIn), { min: 0, step: 0.1, unit: "s" }),
      num("Duration", () => a.duration, (v) => (v == null ? delete a.duration : (a.duration = v)), { min: 0.2, step: 0.1, unit: "s", empty: "to the clip's end" }),
      num("Volume", () => a.volume ?? 1, (v) => (a.volume = v), { min: 0, max: 1.5, step: 0.05, slider: true }),
      num("Fade in", () => a.fadeIn ?? 0, (v) => (a.fadeIn = v), { min: 0, max: 20, step: 0.1, unit: "s" }),
      num("Fade out", () => a.fadeOut ?? 0, (v) => (a.fadeOut = v), { min: 0, max: 20, step: 0.1, unit: "s" }),
    ),
    h("div", { class: "btnRow" }, h("button", { class: "line danger", onclick: removeSelected }, "Delete")),
  ];
}

function clipProps() {
  const clip = S.clip;
  const made = new Set([clip.format, ...(clip.formats ?? [])]);
  return [
    h("div", { class: "head" }, h("b", { style: "font-size:14px;padding:0 8px" }, "Clip")),
    group(
      "Frame",
      choice("Format", () => clip.format, (v) => ((clip.format = v), (clip.formats = [...new Set([v, ...(clip.formats ?? [])])]), (S.format = v)), Object.keys(FORMATS)),
      h("div", { class: "field tall" }, h("label", {}, "Build in"), h("div", {}, Object.keys(FORMATS).map((f) => h("label", { class: "check" }, h("input", { type: "checkbox", checked: made.has(f), disabled: f === clip.format, onchange: (e) => edit("Clip formats", () => (clip.formats = Object.keys(FORMATS).filter((x) => x === clip.format || (x === f ? e.target.checked : made.has(x))))) }), `${f} · ${FORMATS[f].hint}`)))),
      choice("Frame rate", () => String(clip.fps), (v) => (clip.fps = Number(v)), ["24", "25", "30", "50", "60"]),
      color("Background", () => clip.background ?? "#080808", (v) => (clip.background = v)),
    ),
    group("Fonts", text("Google Fonts", () => (clip.fonts ?? []).filter((f) => typeof f === "string").join(", "), (v) => (clip.fonts = [...(clip.fonts ?? []).filter((f) => typeof f !== "string"), ...v.split(",").map((s) => s.trim()).filter(Boolean)]), { placeholder: "Inter, Unbounded" }), h("div", { class: "hint small" }, "Family names, separated by commas. Instrument Sans is always there.")),
    h("div", { class: "hint" }, "Pick a scene or a layer to see its properties. Space plays, S splits, ⌘Z steps back, arrow keys move by a frame."),
  ];
}

// ---------- only in a project: Claude, the chat bar and the cards ----------

function drawChip() {
  const chip = $("chip");
  const scene = curScene();
  if (S.wholeClip) {
    chip.className = "chip all";
    chip.replaceChildren(h("span", {}, "Whole clip"));
    chip.title = "The request is about the whole clip. Pick a scene to change only that scene.";
  } else {
    chip.className = "chip";
    chip.title = "Claude gets only this scene";
    chip.replaceChildren(h("span", {}, scene.label ?? scene.id), h("button", { type: "button", title: "Ask about the whole clip", onclick: () => ((S.wholeClip = true), drawChip()) }, "×"));
  }
}

async function sendChange(request, cardId, sceneId) {
  try {
    await flush();
    await B.change({ sceneId: sceneId === undefined ? (S.wholeClip ? null : curScene().id) : sceneId, layerId: S.sel?.type === "layer" ? S.sel.id : null, request, format: S.format, cardId });
    S.rightTab = "ai";
    poll();
    return true;
  } catch (err) {
    toast(err.message, true);
    return false;
  }
}

const STATE_NAME = { running: "Claude is working…", ready: "Ready to review", kept: "Kept", undone: "Undone", failed: "Didn't work", question: "Needs an answer" };

function cardsView() {
  const out = [];
  if (!S.tools.claude) out.push(h("div", { class: "status warn", style: "margin-bottom:10px" }, "Claude Code wasn't found in this computer's terminal. Editing by hand, recording and building work without it. To connect it, ask in the chat: “connect uberdesigner clips to Claude Code”."));
  if (!S.cards.length) out.push(h("div", { class: "hint" }, "Type what to change in the bar under the frame. Claude gets only the scene you picked, so the request is small and fast. The result shows up here as a card you can keep, undo or refine."));
  for (const c of [...S.cards].reverse()) {
    const job = S.sjobs.find((j) => j.kind === "change" && j.cardId === c.id && j.state === "running");
    const refine = h("input", { placeholder: c.state === "question" || c.state === "failed" ? "Answer, or ask another way…" : "Not quite? Say what to fix…", onkeydown: (e) => e.key === "Enter" && e.target.value.trim() && sendChange(e.target.value.trim(), c.id, c.sceneId) });
    out.push(
      h(
        "div",
        { class: `cardA ${c.state}` },
        h("div", { class: "ct", style: c.sceneId ? "cursor:pointer" : "", onclick: () => { if (c.sceneId && findScene(S.clip, c.sceneId)) { select({ type: "scene", id: c.sceneId }); S.rightTab = "ai"; drawRight(); } } }, c.state === "running" ? h("i", { class: "spin" }) : h("span", { class: "num" }, String(c.n)), h("b", {}, c.label), h("span", { class: `state ${c.state}` }, STATE_NAME[c.state] ?? "")),
        c.tries.map((t) => h("div", { class: `try ${t.takenBack ? "back" : ""}` }, h("q", {}, t.request), h("p", {}, t.summary || "Changed."), t.usage ? h("div", { class: "hint small" }, `${t.usage.seconds} s · ${Math.round((t.usage.input + t.usage.output) / 100) / 10}k tokens${t.takenBack ? " · undone" : ""}`) : null)),
        c.pending ? h("div", { class: "try" }, h("q", {}, c.pending), h("p", { class: "dim" }, job?.note || "Queued…")) : null,
        c.question ? h("div", { class: "quest" }, c.question) : null,
        c.error ? h("div", { class: "err" }, c.error) : null,
        c.state === "running" ? h("div", { class: "btnRow" }, job ? h("button", { class: "line", onclick: () => B.stopJob(job.id) }, "Stop") : null) : null,
        c.state === "ready" ? [h("div", { class: "refine" }, refine), h("div", { class: "btnRow" }, h("button", { class: "keep", onclick: () => cardAct("keep", c.id) }, "Keep"), h("button", { class: "line", onclick: () => cardAct("undo", c.id) }, "Undo"))] : null,
        c.state === "kept" ? h("div", { class: "btnRow" }, h("button", { class: "line", onclick: () => cardAct("undo", c.id) }, "Undo after all")) : null,
        c.state === "question" || c.state === "failed" ? [h("div", { class: "refine" }, refine), h("div", { class: "btnRow" }, h("button", { class: "line", onclick: () => cardAct("close", c.id) }, "Close"))] : null,
      ),
    );
  }
  return out;
}

async function cardAct(what, id) {
  try {
    await flush();
    await B.cardAct(what, id);
    poll();
  } catch (err) {
    toast(err.message, true);
  }
}

// What the skill's server reports: Claude's cards, recordings, and a clip changed from outside the editor
let polling = false;
async function poll() {
  if (polling || !PROJECT) return;
  polling = true;
  try {
    const st = await B.state();
    if (st.rev !== S.rev) {
      S.rev = st.rev;
      const was = JSON.stringify([S.sjobs, S.cards]);
      S.sjobs = st.jobs;
      S.cards = st.cards;
      S.tools = st.tools;
      if (st.clipRev > B.clipRev && !S.dragging && !saveTimer) {
        await saving;
        // Claude (in the editor or in the chat) changed the clip: take it as it is now, where the person was
        if (st.clipRev > B.clipRev) await openClip(S.clipId, { keep: true });
      }
      if (was !== JSON.stringify([S.sjobs, S.cards])) {
        drawJobs();
        if (S.rightTab === "ai" || !document.activeElement?.closest?.("#rightBody")) drawRight();
      }
    }
  } catch {
    $("saved").textContent = "Lost connection to the editor's server";
  } finally {
    polling = false;
  }
}

// ---------- building the video ----------

function openRender() {
  const clip = S.clip;
  const picked = new Set([clip.format, ...(clip.formats ?? [])]);
  let quality = "high";
  const errors = problemsOf(clip);
  const pop = $("pop");
  const close = () => ((pop.hidden = true), pop.replaceChildren());
  pop.replaceChildren(
    h(
      "div",
      { class: "sheet", onclick: (e) => e.stopPropagation() },
      h("h2", {}, "Build video"),
      Object.keys(FORMATS).map((f) => h("label", { class: "fmt" }, h("input", { type: "checkbox", checked: picked.has(f), onchange: (e) => (e.target.checked ? picked.add(f) : picked.delete(f)) }), h("b", {}, f), h("span", {}, `${FORMATS[f].width}×${FORMATS[f].height} · ${FORMATS[f].hint}`))),
      h("div", { class: "field", style: "margin-top:10px" }, h("label", {}, "Quality"), h("select", { onchange: (e) => (quality = e.target.value) }, h("option", { value: "draft" }, "Draft (smaller file)"), h("option", { value: "high", selected: true }, "High"), h("option", { value: "max" }, "Maximum"))),
      h("div", { class: "hint small" }, `${secs(totalDuration(clip))} · ${clip.fps} fps · MP4 (H.264). The video is built right in this tab: keep the tab open and in front until it is done.`),
      errors.length ? h("div", { class: "status warn" }, `Fix this first: ${errors[0]}`) : null,
      !canExport() ? h("div", { class: "status warn" }, "This browser can't build videos. Open the editor in Chrome or Edge.") : null,
      h("div", { class: "btnRow" }, h("button", { class: "primary", disabled: !!errors.length || !canExport() || S.jobs.some((j) => j.state === "running"), onclick: () => (close(), startExport([...picked], quality)) }, "Build"), h("button", { class: "line", onclick: close }, "Cancel")),
    ),
  );
  pop.hidden = false;
  pop.onclick = close;
}

let jobId = 0;
async function startExport(formats, quality) {
  if (!formats.length) return toast("No format is selected.", true);
  await flush();
  play(false);
  const clip = structuredClone(S.clip);
  const job = { id: ++jobId, label: `Building: ${formats.join(", ")}`, state: "running", progress: 0, note: "Getting ready…", files: [], stopped: false };
  S.jobs.push(job);
  drawJobs();
  try {
    await loadFonts(clip, S.urls);
    for (const [i, format] of formats.entries()) {
      const r = await exportFormat(clip, format, {
        urls: S.urls,
        getBlob: (path) => B.blob(S.clipId, path),
        quality,
        job: { get stopped() { return job.stopped; }, progress: (f, note) => ((job.progress = (i + f) / formats.length), (job.note = note), drawJobs()) },
      });
      const name = `${safeName(clip.name).replace(/[.-]+$/, "").replace(/-{2,}/g, "-") || "clip"}-${format.replace(":", "x")}.mp4`;
      const saved = await B.saveRender(name, r.blob);
      job.files.push({ format, name: saved.name, url: saved.url, path: saved.path, download: saved.download, size: r.blob.size, note: r.wantedSound && !r.sound ? "no sound: this browser can't encode audio" : r.sound === "opus" ? "sound is Opus: QuickTime may play it silent" : "" });
      drawJobs();
    }
    job.state = "done";
    job.progress = 1;
  } catch (err) {
    job.state = job.stopped ? "stopped" : "failed";
    job.error = job.stopped ? "Stopped." : `That didn't work: ${err?.message ?? err}`;
  }
  drawJobs();
}

function drawJobs() {
  const box = $("jobs");
  const kids = [];
  if (toastEl) kids.push(toastEl);
  if (S.recording)
    kids.push(
      h(
        "div",
        { class: "job" },
        h("div", { class: "jt" }, h("i", { class: "recDot" }), h("b", {}, `Recording the tab · ${fmtTime(S.recording.seconds(), 30).slice(0, 5)}`), h("button", { class: "line danger", onclick: () => S.recording?.finish() }, "Stop")),
        h("div", { class: "note" }, "Switch to the tab with your site and show it: scroll, hover, click. Then come back here and stop the recording. You can trim the start and the end on the timeline."),
      ),
    );
  for (const j of S.sjobs.filter((x) => x.kind === "record" && (x.state === "running" || !S.seenJobs.has(x.id))))
    kids.push(
      h(
        "div",
        { class: `job ${j.state}` },
        h("div", { class: "jt" }, j.state === "running" ? h("i", { class: "spin" }) : null, h("b", {}, j.label), j.state === "running" ? h("button", { class: "ghost", onclick: () => B.stopJob(j.id) }, "Stop") : h("button", { class: "icon", title: "Close", onclick: () => (S.seenJobs.add(j.id), drawJobs()) }, "×")),
        j.state === "running" ? h("div", { class: "bar" }, h("i", { style: `width:${Math.round((j.progress ?? 0) * 100)}%` })) : null,
        h("div", { class: "note" }, j.state === "failed" || j.state === "stopped" ? j.error : j.state === "done" ? "Site recorded." : j.note || "Waiting in line…"),
      ),
    );
  for (const j of S.jobs.filter((x) => !x.closed))
    kids.push(
      h(
        "div",
        { class: `job ${j.state}` },
        h("div", { class: "jt" }, j.state === "running" ? h("i", { class: "spin" }) : null, h("b", {}, j.label), j.state === "running" ? h("button", { class: "ghost", onclick: () => ((j.stopped = true), (j.note = "Stopping…"), drawJobs()) }, "Stop") : h("button", { class: "icon", title: "Close", onclick: () => ((j.closed = true), drawJobs()) }, "×")),
        j.state === "running" ? h("div", { class: "bar" }, h("i", { style: `width:${Math.round((j.progress ?? 0) * 100)}%` })) : null,
        h("div", { class: "note" }, j.state === "failed" || j.state === "stopped" ? j.error : j.state === "done" ? (j.doneNote ?? (PROJECT ? "Done. The files are in the clip's renders folder:" : "Done. Click a file to download it:")) : j.note),
        j.files.length ? h("div", { class: "files" }, j.files.map((f) => h("a", { href: f.url, download: f.download ? f.name : null, target: f.download ? null : "_blank" }, `${f.download ? "↓" : "▶"} ${f.format} · ${f.name} · ${(f.size / 1e6).toFixed(1)} MB${f.note ? ` · ${f.note}` : ""}`)), PROJECT ? h("button", { class: "ghost", style: "justify-self:start;margin-left:-9px", onclick: () => B.reveal(j.files[0].path) }, "Show in folder") : null) : null,
      ),
    );
  box.replaceChildren(...kids);
}

// ---------- clips kept in this browser ----------

const flush = async () => {
  if (saveTimer) saveNow();
  await saving;
};

async function openClip(id, { keep = false } = {}) {
  if (!keep) play(false);
  const { clip, media } = await B.open(id);
  S.clipId = id;
  S.clip = clip;
  S.media = media;
  S.urls = Object.fromEntries(media.map((m) => [m.path, m.url]));
  if (PROJECT) {
    S.tools = B.tools;
    lookAtNewFiles();
  }
  if (!keep) {
    S.format = S.clip.format;
    S.sceneId = S.clip.scenes[0].id;
    S.sel = null;
    S.t = 0;
  }
  S.undo.length = S.redo.length = 0;
  fixSelection();
  S.problems = problemsOf(S.clip);
  fontsFor = "";
  showStage();
  drawAll();
  if (!keep) fitZoom();
  loadHistory();
}

// Files Claude Code put into the project from the chat: the browser looks at each once (size, length, a small
// picture) and tells the server, so the library shows them like the ones dropped here
async function lookAtNewFiles() {
  for (const m of S.media) {
    if (m.thumb || m.kind === "font" || (m.kind === "audio" && m.duration)) continue;
    try {
      const blob = await B.blob(S.clipId, m.path);
      if (!blob) continue;
      const info = await inspect(blob, m.kind);
      Object.assign(m, info);
      B.setMediaInfo(S.clipId, m.path, info);
    } catch {
      m.unplayable = true;
    }
  }
  if (S.leftTab === "media") drawLeft();
}

async function createClip(name = "New clip") {
  const id = await B.createClip(blankClip(name));
  S.clips = await B.listClips();
  return id;
}

async function onClipsChange(e) {
  const v = e.target.value;
  await flush();
  if (v === "+new") await openClip(await createClip());
  else if (v === "-delete") {
    if (confirm(`Delete the clip “${S.clip.name}” and its files? This can't be undone.`)) {
      await B.deleteClip(S.clipId);
      S.clips = await B.listClips();
      await openClip(S.clips[0].id);
    }
  } else await openClip(v);
  S.clips = await B.listClips();
  drawClips();
}

// A clip with nothing in it yet says how to start
function drawWelcome() {
  const fresh = !S.media.length && S.clip.scenes.length === 1 && S.clip.scenes[0].layers.length <= 1 && !S.recording;
  const box = $("welcome");
  box.hidden = !fresh;
  if (!fresh || box.childElementCount) return;
  const pick = h("input", { type: "file", multiple: true, hidden: true, accept: "video/*,image/*,audio/*", onchange: (e) => upload([...e.target.files]) });
  box.replaceChildren(
    h(
      "div",
      { class: "welcomeCard" },
      pick,
      h("h2", {}, "Where do we start?"),
      h("p", {}, "Drop videos, pictures or music here, or record your site straight from another tab."),
      h("div", { class: "btnRow" }, h("button", { class: "primary", onclick: () => pick.click() }, "Choose files"), canRecordTab() ? h("button", { class: "line", onclick: startTabRecording }, "● Record a tab") : null),
      h("p", { class: "dim" }, "Your files never leave this computer: the clip is kept in this browser, and the video is built here too."),
    ),
  );
}

function drawAll() {
  $("chat").hidden = !PROJECT;
  if (PROJECT) drawChip();
  drawWelcome();
  drawTop();
  drawClips();
  drawNotice();
  drawLeft();
  drawTimeline();
  drawRight();
  drawJobs();
  layoutFrame();
}

// ---------- wiring ----------

function fitZoom() {
  const w = $("timeline").clientWidth - TL_PAD * 2 - 40;
  S.zoom = Math.max(8, Math.min(600, w / Math.max(1, totalDuration(S.clip))));
  drawTimeline();
}

function wire() {
  $("leftTabs").addEventListener("click", (e) => {
    const tab = e.target.closest("button")?.dataset.tab;
    if (!tab) return;
    S.leftTab = tab;
    if (tab === "history") loadHistory();
    drawLeft();
  });
  $("clipName").addEventListener("input", (e) => liveEdit("Clip name", () => (S.clip.name = e.target.value.trim() || "Clip")));
  $("clipName").addEventListener("change", endLive);
  $("play").addEventListener("click", () => play(!S.playing));
  $("mute").addEventListener("click", () => {
    S.muted = !S.muted;
    $("mute").textContent = S.muted ? "🔇" : "🔊";
    stage?.setMuted(S.muted);
  });
  $("splitBtn").addEventListener("click", splitAtPlayhead);
  $("zoomIn").addEventListener("click", () => ((S.zoom = Math.min(600, S.zoom * 1.4)), drawTimeline()));
  $("zoomOut").addEventListener("click", () => ((S.zoom = Math.max(8, S.zoom / 1.4)), drawTimeline()));
  $("zoomFit").addEventListener("click", fitZoom);
  $("renderBtn").addEventListener("click", openRender);
  $("overlay").addEventListener("pointerdown", frameDown);
  $("theme").addEventListener("click", () => {
    const next = document.documentElement.dataset.theme === "light" ? "dark" : "light";
    document.documentElement.dataset.theme = next;
    try {
      localStorage.setItem("uberdesigner-clips-theme", next);
    } catch {
      /* a private window: for this page only */
    }
  });
  $("clips").addEventListener("change", onClipsChange);
  $("rightTabs").addEventListener("click", (e) => {
    const tab = e.target.closest("button")?.dataset.tab;
    if (!tab) return;
    S.rightTab = tab;
    drawRight();
  });
  $("model").addEventListener("change", (e) => B.setModel(e.target.value));
  const ask = $("ask");
  ask.addEventListener("input", () => {
    ask.style.height = "auto";
    ask.style.height = `${Math.min(120, ask.scrollHeight)}px`;
  });
  ask.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      $("chat").requestSubmit();
    }
  });
  $("chat").addEventListener("submit", async (e) => {
    e.preventDefault();
    const request = ask.value.trim();
    if (!request) return;
    if (await sendChange(request)) {
      ask.value = "";
      ask.style.height = "auto";
    }
  });
  $("timeline").addEventListener("pointerdown", (e) => {
    if (e.target === $("tlInner") || e.target.classList.contains("track") || e.target.classList.contains("sceneShade")) scrubDown(e);
  });
  $("timeline").addEventListener(
    "wheel",
    (e) => {
      if (!(e.ctrlKey || e.metaKey)) return;
      e.preventDefault();
      S.zoom = Math.max(8, Math.min(600, S.zoom * (e.deltaY < 0 ? 1.12 : 0.89)));
      drawTimeline();
    },
    { passive: false },
  );
  addEventListener("resize", layoutFrame);
  new ResizeObserver(layoutFrame).observe($("canvas"));

  addEventListener("keydown", (e) => {
    const typing = e.target.closest?.("input, textarea, select, [contenteditable]");
    const mod = e.metaKey || e.ctrlKey;
    if (mod && e.key.toLowerCase() === "z") {
      if (typing) return; // the field's own step back
      e.preventDefault();
      return undo(e.shiftKey);
    }
    if (typing) return;
    if (e.code === "Space") {
      e.preventDefault();
      play(!S.playing);
    } else if (e.key.toLowerCase() === "s" || e.key.toLowerCase() === "ы") splitAtPlayhead();
    else if (e.key === "Delete" || e.key === "Backspace") removeSelected();
    else if (e.key === "ArrowLeft" || e.key === "ArrowRight") {
      e.preventDefault();
      play(false);
      seek(S.t + ((e.key === "ArrowLeft" ? -1 : 1) * (e.shiftKey ? 10 : 1)) / S.clip.fps);
    } else if (e.key === "Escape") {
      if (!$("pop").hidden) $("pop").click();
      else if (S.sel?.type === "layer") select({ type: "scene", id: S.sceneId });
      else select(null);
    } else if (mod && e.key.toLowerCase() === "d" && S.sel?.type === "scene") {
      e.preventDefault();
      edit("Scene copy", (clip) => {
        const id = duplicateScene(clip, S.sel.id);
        S.sceneId = id;
        S.sel = { type: "scene", id };
      });
    }
  });

  // files dropped anywhere on the editor go to the clip's media
  let depth = 0;
  addEventListener("dragenter", (e) => {
    if (!e.dataTransfer?.types.includes("Files")) return;
    depth++;
    $("drop").hidden = false;
  });
  addEventListener("dragleave", () => {
    depth = Math.max(0, depth - 1);
    if (!depth) $("drop").hidden = true;
  });
  addEventListener("dragover", (e) => e.dataTransfer?.types.includes("Files") && e.preventDefault());
  addEventListener("drop", (e) => {
    if (!e.dataTransfer?.files.length) return;
    e.preventDefault();
    depth = 0;
    $("drop").hidden = true;
    upload([...e.dataTransfer.files]);
  });
  addEventListener("beforeunload", () => saveTimer && saveNow());
}

async function boot() {
  try {
    const saved = localStorage.getItem("uberdesigner-clips-theme");
    document.documentElement.dataset.theme = saved ?? (matchMedia("(prefers-color-scheme: light)").matches ? "light" : "dark");
  } catch {
    document.documentElement.dataset.theme = "dark";
  }
  stage = new Stage($("stage"));
  stage.onMediaReady = () => !S.playing && !seekBusy && seek(S.t, true);
  S.clips = await B.listClips();
  let id = await B.lastOpened();
  if (!S.clips.some((c) => c.id === id)) id = S.clips[0]?.id ?? (await createClip());
  wire();
  await openClip(id);
  B.keep();
  if (PROJECT) {
    $("model").replaceChildren(...(B.models ?? []).map((m) => h("option", { value: m, selected: m === B.settings?.model }, m)));
    await poll();
    setInterval(poll, 800);
  }
  window.__clips = { S, stage, upload, startExport }; // for looking inside from the console
}

boot().catch((err) => {
  document.body.textContent = `The editor didn't open: ${err?.message ?? err}`;
});
