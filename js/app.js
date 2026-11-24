// uberdesigner clips, in the browser. One state object, a few draw functions (layers, timeline, inspector), and the
// stage on a canvas. Everything happens in this tab: the clip and its files are kept in the browser's own storage,
// and the video file is built here too.

import {
  blankClip, duplicateScene, EASES, findLayer, findScene, FITS, FORMATS, frameSize, freshId, layerSpan, mediaUsed, MOTIONS, resolveLayer, round, sceneAt,
  sceneDuration, sceneStarts, setPlaced, splitScene, totalDuration, TRANSITIONS, validate,
} from "./model.mjs";
import { canExport, exportFormat } from "./export.js";
import { canRecordTab, inspect, kindOf, recordTab, safeName } from "./media.js";
import { loadFonts, Stage } from "./renderer.js";
import * as store from "./store.js";

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
const secs = (n) => `${round(n, 2)} с`;
const KIND_NAME = { video: "Видео", image: "Картинка", text: "Текст", shape: "Фигура", site: "Сайт", audio: "Звук" };
const MOTION_NAME = { none: "Нет", fade: "Проявление", up: "Снизу", down: "Сверху", left: "Справа", right: "Слева", scale: "Масштаб", blur: "Размытие" };
const TRANSITION_NAME = { cut: "Склейка", fade: "Растворение", "slide-left": "Сдвиг влево", "slide-up": "Сдвиг вверх", zoom: "Наезд", wipe: "Шторка" };
const EASE_NAME = { linear: "Ровно", in: "Разгон", out: "Торможение", inOut: "Плавно", expoOut: "Резкое торможение", backOut: "С отскоком" };

// ---------- state ----------

const S = {
  clipId: null,
  clips: [], // every clip kept in this browser: { id, name, updatedAt }
  clip: null,
  media: [], // this clip's files: { path, name, kind, width, height, duration, audio, thumb }
  blobs: {}, // path → the file itself
  urls: {}, // path → an address the page can play it from
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
};
let stage = null;

const curScene = () => findScene(S.clip, S.sceneId) ?? S.clip.scenes[0];
const selLayer = () => (S.sel?.type === "layer" ? findLayer(S.clip, S.sel.id) : null);
const snap = (t) => round(Math.round(t * S.clip.fps) / S.clip.fps, 3);

// ---------- editing: change, show, save ----------

let saveTimer = null;
let saveLabel = "Правка";
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
  for (const [path, who] of mediaUsed(clip)) if (!S.blobs[path]) errors.push(`${who.map((w) => `"${w}"`).join(", ")}: файла ${path.split("/").pop()} нет в клипе`);
  return errors;
}

function scheduleSave(label) {
  saveLabel = label ?? saveLabel;
  $("saved").textContent = "Сохраняю…";
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
      await store.saveClip(id, clip);
      await store.recordHistory(id, clip, label);
      S.problems = id === S.clipId ? problemsOf(S.clip) : S.problems;
      $("saved").textContent = store.persistent() ? "Сохранено в этом браузере" : "Не сохраняется: приватное окно";
      const mine = S.clips.find((c) => c.id === id);
      if (mine && mine.name !== clip.name) {
        mine.name = clip.name;
        drawClips();
      }
    } catch (err) {
      $("saved").textContent = `Не сохранено: ${err?.name === "QuotaExceededError" ? "в браузере кончилось место" : (err?.message ?? err)}`;
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
  scheduleSave(redo ? "Повтор" : "Шаг назад");
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
  drawLeft();
  drawTimeline();
  drawRight();
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
      h("button", { class: `${f === S.format ? "on" : ""} ${made.has(f) ? "" : "off"}`, title: `${FORMATS[f].hint}${f === S.clip.format ? " · основной формат" : made.has(f) ? "" : " · не собирается (включается в свойствах клипа)"}`, onclick: () => setFormat(f) }, f),
    ),
  );
  $("total").textContent = fmtTime(totalDuration(S.clip), S.clip.fps);
}

function drawClips() {
  $("clips").replaceChildren(
    ...S.clips.map((c) => h("option", { value: c.id, selected: c.id === S.clipId }, c.name || "Клип")),
    h("option", { value: "+new" }, "＋ Новый клип"),
    S.clips.length > 1 ? h("option", { value: "-delete" }, "Удалить этот клип…") : null,
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
  if (S.problems.length) lines.push(`В клипе ошибка, собрать видео пока нельзя:\n${S.problems.slice(0, 4).join("\n")}`);
  if (!canExport()) lines.push("Этот браузер не умеет собирать видео. Монтировать можно, а для сборки откройте редактор в Chrome или Edge.");
  if (!store.persistent()) lines.push("Браузер не дал места для хранения (приватное окно?). Клип пропадёт, когда вы закроете вкладку.");
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
      scaling ? "Размер слоя" : "Положение слоя",
      () => {
        if (scaling) {
          const d = Math.hypot((ev.clientX - rect.left) / frameScale - cx, (ev.clientY - rect.top) / frameScale - cy);
          setPlaced(S.clip, found.layer, S.format, "scale", round(Math.max(0.05, start.scale * (d / d0)), 3));
        } else {
          let x = start.x + (dx / size.width) * 100;
          let y = start.y + (dy / size.height) * 100;
          if (!ev.shiftKey) {
            if (Math.abs(x) < 0.8) x = 0; // the centre holds on to a layer that comes near it
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
      h("button", { class: "line", onclick: () => addLayer("text") }, "+ Текст"),
      h("button", { class: "line", onclick: () => addLayer("shape") }, "+ Фигура"),
      h("button", { class: "line", onclick: addScene }, "+ Сцена"),
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
          h("button", { class: "eye", title: L.hidden ? `Показать в ${S.format}` : `Скрыть в ${S.format}`, onclick: (e) => (e.stopPropagation(), edit("Видимость слоя", () => setPlaced(S.clip, layer, S.format, "hidden", !L.hidden))) }, L.hidden ? "○" : "●"),
        ),
      );
    }
    if (!scene.layers.length) out.push(h("div", { class: "hint small", style: "padding-left:22px" }, "Пусто. Добавьте слой из «Медиа» или кнопками выше."));
  });
  if (S.clip.audio?.length) {
    out.push(h("div", { class: "sub" }, "Звук"));
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
    h("button", { class: "upload", onclick: () => pick.click() }, "Добавить файлы…"),
    canRecordTab() ? h("button", { class: "upload rec", disabled: !!S.recording, onclick: startTabRecording }, "● Записать вкладку с сайтом") : null,
  ];
  if (!S.media.length) out.push(h("div", { class: "hint" }, "Перетащите сюда видео, картинки и музыку. Записи экрана, MP4 из Cinema 4D и кадры из Figma подойдут как есть. Файлы остаются на этом компьютере."));
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
        h("div", { class: "acts" }, m.kind === "audio" ? h("button", { onclick: () => addAudio(m) }, "+ Звуковая дорожка") : [h("button", { onclick: () => addMediaScene(m) }, "+ Новой сценой"), h("button", { onclick: () => addMediaLayer(m) }, "+ В эту сцену")], used.has(m.path) ? null : h("button", { class: "rm", title: "Убрать файл из клипа", onclick: () => removeMedia(m) }, "Убрать файл")),
        h("div", { class: "cap" }, h("b", {}, m.name), h("span", {}, meta || KIND_NAME[m.kind])),
      ),
    );
  }
  out.push(grid);
  const fonts = S.media.filter((m) => m.kind === "font");
  if (fonts.length) out.push(h("div", { class: "sub" }, "Шрифты"), ...fonts.map((m) => h("div", { class: "layerRow", style: "padding-left:8px" }, h("span", { class: "rowName" }, m.name))));
  return out;
}

function historyView() {
  if (!S.history.length) return [h("div", { class: "hint" }, "Здесь появятся точки, к которым можно вернуться. Они хранятся в этом браузере вместе с клипом.")];
  return S.history.map((v, i) =>
    h(
      "div",
      { class: "ver" },
      h("div", {}, h("b", {}, v.label || "Правка"), h("span", {}, `${new Date(v.at).toLocaleString("ru", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" })}${i === 0 ? " · сейчас" : ""}`)),
      i === 0 ? null : h("button", { class: "line", onclick: () => restore(v.n) }, "Вернуться"),
    ),
  );
}

async function loadHistory() {
  S.history = await store.listHistory(S.clipId);
  if (S.leftTab === "history") drawLeft();
}
async function restore(n) {
  await flush();
  const clip = await store.historyClip(S.clipId, n);
  if (!clip) return;
  const entry = S.history.find((v) => v.n === n);
  edit(`Возврат к: ${entry?.label || "точке"}`, () => (S.clip = clip));
  fixSelection();
  drawAll();
  await flush();
  loadHistory();
}

// ---------- adding things ----------

function addScene() {
  edit("Новая сцена", (clip) => {
    const id = freshId(clip, "scene");
    const i = clip.scenes.findIndex((s) => s.id === S.sceneId);
    clip.scenes.splice(i + 1, 0, { id, label: "Новая сцена", duration: 3, background: clip.background ?? "#080808", layers: [] });
    S.sceneId = id;
    S.sel = { type: "scene", id };
  });
  seek(sceneStarts(S.clip)[S.clip.scenes.findIndex((s) => s.id === S.sceneId)] + 0.001, true);
}

function addLayer(kind) {
  const scene = curScene();
  const local = Math.max(0, Math.min(S.t - sceneStarts(S.clip)[S.clip.scenes.indexOf(scene)], sceneDuration(scene) - 0.2));
  edit("Новый слой", (clip) => {
    const id = freshId(clip, `${scene.id}-${kind}`);
    const base = { id, kind, label: KIND_NAME[kind] };
    if (local > 0.3) base.start = snap(local);
    if (kind === "text") Object.assign(base, { text: "Текст", size: 72, weight: 600, color: "#ffffff", enter: { type: "up", duration: 0.5 } });
    if (kind === "shape") Object.assign(base, { fill: "#7548d9", box: { w: 30, h: 30 }, radius: 24 });
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
  edit("Новая сцена из файла", (clip) => {
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
  edit("Слой из файла", (clip) => {
    const scene = curScene();
    const layer = mediaLayer(clip, m);
    scene.layers.push(layer);
    S.sel = { type: "layer", id: layer.id };
  });
}
function addAudio(m) {
  edit("Звуковая дорожка", (clip) => {
    clip.audio ??= [];
    const id = freshId(clip, m.name);
    clip.audio.push({ id, label: m.name.replace(/\.[a-z0-9]+$/i, ""), src: m.path, start: 0, volume: 0.8, fadeIn: 0.3, fadeOut: 1 });
    S.sel = { type: "audio", id };
  });
}

// A file comes into the clip: looked at, kept in the browser's storage, and given an address the stage can play
async function ingest(file, name = file.name) {
  const kind = kindOf({ type: file.type, name });
  if (!kind) throw new Error("такой файл клип не использует (нужны видео, картинки, звук или шрифты)");
  let info;
  try {
    info = await inspect(file, kind);
  } catch {
    throw new Error(kind === "video" ? "браузер не может проиграть это видео (так бывает с ProRes и HEVC). Пересохраните его в MP4 (H.264)" : "браузер не может открыть этот файл");
  }
  const clean = safeName(name);
  const dot = clean.lastIndexOf(".");
  const [stem, ext] = dot > 0 ? [clean.slice(0, dot), clean.slice(dot)] : [clean, ""];
  let path = `media/${clean}`;
  for (let n = 2; S.blobs[path]; n++) path = `media/${stem}-${n}${ext}`;
  const item = { path, name: path.slice(6), kind, ...info };
  await store.putMedia(S.clipId, { ...item, blob: file });
  S.blobs[path] = file;
  S.urls[path] = URL.createObjectURL(file);
  S.media.push(item);
  return item;
}

async function upload(files) {
  let last = null;
  const added = [];
  for (const file of files) {
    toast(`Добавляю ${file.name}…`);
    try {
      last = await ingest(file);
      added.push(last);
    } catch (err) {
      toast(`${file.name}: ${err?.name === "QuotaExceededError" ? "в браузере кончилось место для файлов" : err.message}`, true);
      await new Promise((r) => setTimeout(r, 2500));
    }
  }
  if (last) toast("");
  S.problems = problemsOf(S.clip);
  // the first files of an empty clip go straight onto the timeline: that is what the person came to do
  const fresh = S.clip.scenes.length === 1 && S.clip.scenes[0].layers.every((l) => l.kind === "text" && l.id === "title-text");
  const visual = added.filter((m) => m.kind === "video" || m.kind === "image");
  if (fresh && visual.length) {
    edit("Первые файлы", (clip) => {
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
  await store.deleteMedia(S.clipId, m.path);
  URL.revokeObjectURL(S.urls[m.path]);
  delete S.urls[m.path];
  delete S.blobs[m.path];
  S.media = S.media.filter((x) => x !== m);
  drawLeft();
}

// Recording a tab: the browser asks which one, the person shows their site there, and the take becomes a scene
async function startTabRecording() {
  if (S.recording) return;
  const finish = async () => {
    const rec = S.recording;
    if (!rec) return;
    S.recording = null;
    clearInterval(rec.timer);
    toast("Сохраняю запись…");
    try {
      const blob = await rec.stop();
      if (blob.size < 2000) throw new Error("запись пустая");
      const d = new Date();
      const name = `Запись-${String(d.getHours()).padStart(2, "0")}-${String(d.getMinutes()).padStart(2, "0")}-${String(d.getSeconds()).padStart(2, "0")}.${blob.type.includes("mp4") ? "mp4" : "webm"}`;
      const item = await ingest(new File([blob], name, { type: blob.type }), name);
      toast("");
      addMediaScene(item);
      S.leftTab = "layers";
      drawLeft();
    } catch (err) {
      toast(`Запись не сохранилась: ${err.message}`, true);
    }
    drawJobs();
  };
  try {
    toast("В окне браузера выберите «Вкладка» и сайт, который хотите показать.");
    const rec = await recordTab({ fps: Math.max(30, S.clip.fps), onEnd: finish });
    toast("");
    S.recording = { ...rec, finish, timer: setInterval(drawJobs, 500) };
    drawWelcome();
    drawLeft();
    drawJobs();
  } catch (err) {
    toast(err?.name === "NotAllowedError" ? "" : `Запись не началась: ${err.message}`, true);
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
      (dt) => edit("Длительность сцены", () => (scene.duration = Math.max(0.2, snap(d0 + dt))), { live: true }),
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
      edit("Порядок сцен", (clip) => {
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
        "Время слоя",
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
        "Время звука",
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
  edit("Разрез сцены", (clip) => {
    done = splitScene(clip, at.scene.id, local);
    if (done) {
      S.sceneId = done.second;
      S.sel = { type: "scene", id: done.second };
    }
  });
  if (!done) toast("Разрезать можно не ближе 0,1 с от края сцены.", true);
}

function removeSelected() {
  if (!S.sel) return;
  if (S.sel.type === "scene") {
    if (S.clip.scenes.length < 2) return toast("В клипе должна остаться хотя бы одна сцена.", true);
    edit("Сцена удалена", (clip) => {
      const i = clip.scenes.findIndex((s) => s.id === S.sel.id);
      clip.scenes.splice(i, 1);
      S.sceneId = clip.scenes[Math.max(0, i - 1)].id;
      S.sel = null;
    });
  } else if (S.sel.type === "layer") {
    edit("Слой удалён", (clip) => {
      const f = findLayer(clip, S.sel.id);
      f.scene.layers.splice(f.scene.layers.indexOf(f.layer), 1);
      S.sel = { type: "scene", id: f.scene.id };
    });
  } else
    edit("Звук удалён", (clip) => {
      clip.audio = clip.audio.filter((a) => a.id !== S.sel.id);
      S.sel = null;
    });
  seek(S.t, true);
}

// ---------- inspector ----------

function drawRight() {
  const body = $("rightBody");
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
    out.push(num("Длится", () => m().duration ?? 0.5, (v) => put({ duration: v }), { min: 0, max: 10, step: 0.05, unit: "с" }));
    out.push(choice("Кривая", () => m().ease ?? (key === "enter" ? "out" : "in"), (v) => put({ ease: v }), EASES, EASE_NAME));
  }
  return out;
}

function layerProps(layer, scene) {
  const fmt = S.format;
  const other = fmt !== S.clip.format;
  const L = () => resolveLayer(layer, fmt);
  const place = (key) => (v) => setPlaced(S.clip, layer, fmt, key, v);
  const span = layerSpan(layer, scene);
  const out = [h("div", { class: "head" }, h("i", { class: `kind ${layer.kind}` }), h("input", { value: layer.label ?? layer.id, "aria-label": "Название слоя", oninput: (e) => liveEdit("Название слоя", () => (layer.label = e.target.value)), onchange: endLive }), h("span", { class: "dim" }, KIND_NAME[layer.kind]))];

  if (layer.kind === "text") {
    out.push(
      group(
        "Текст",
        text("Слова", () => layer.text, (v) => (layer.text = v), { area: true }),
        text("Шрифт", () => layer.font ?? "", (v) => (v.trim() ? (layer.font = v.trim()) : delete layer.font), { placeholder: "Instrument Sans" }),
        num("Размер", () => L().size ?? 64, place("size"), { min: 8, max: 600, step: 1, slider: true }),
        num("Жирность", () => layer.weight ?? 500, (v) => (layer.weight = v), { min: 100, max: 900, step: 100, slider: true }),
        color("Цвет", () => layer.color ?? "#ffffff", (v) => (layer.color = v)),
        choice("Выключка", () => L().align ?? "center", place("align"), ["left", "center", "right"], { left: "Влево", center: "По центру", right: "Вправо" }),
        num("Ширина", () => L().maxWidth ?? 84, place("maxWidth"), { min: 10, max: 100, step: 1, unit: "%", slider: true }),
        num("Трекинг", () => layer.letterSpacing ?? -0.02, (v) => (layer.letterSpacing = v), { min: -0.1, max: 0.5, step: 0.005, unit: "em" }),
        num("Интерлиньяж", () => layer.lineHeight ?? 1.05, (v) => (layer.lineHeight = v), { min: 0.7, max: 2.5, step: 0.05 }),
        check("Прописными", () => layer.uppercase, (v) => (v ? (layer.uppercase = true) : delete layer.uppercase)),
      ),
    );
    if (layer.font && !["Instrument Sans"].includes(layer.font) && !(S.clip.fonts ?? []).some((f) => (typeof f === "string" ? f : f.family) === layer.font))
      out.push(h("div", { class: "status warn" }, `Шрифта «${layer.font}» нет в клипе. `, h("button", { class: "ghost", onclick: () => edit("Шрифт добавлен", (clip) => (clip.fonts = [...(clip.fonts ?? []), layer.font])) }, "Подключить из Google Fonts")));
  }
  if (layer.kind === "video" || (layer.kind === "site" && layer.recording)) {
    const m = S.media.find((x) => x.path === (layer.kind === "site" ? layer.recording : layer.src));
    out.push(
      group(
        "Видео",
        num("С момента", () => layer.trim?.in ?? 0, (v) => (v > 0 ? (layer.trim = { ...(layer.trim ?? {}), in: v }) : delete layer.trim), { min: 0, max: m?.duration ?? 3600, step: 0.05, unit: "с" }),
        num("Скорость", () => layer.speed ?? 1, (v) => (v === 1 ? delete layer.speed : (layer.speed = v)), { min: 0.1, max: 8, step: 0.05, unit: "×", slider: true }),
        layer.kind === "video" && m?.audio ? num("Звук", () => layer.volume ?? 0, (v) => (v > 0 ? (layer.volume = v) : delete layer.volume), { min: 0, max: 1, step: 0.05, slider: true }) : null,
        m?.duration ? h("div", { class: "hint small" }, `Файл длится ${secs(m.duration)}${m.width ? `, ${m.width}×${m.height}` : ""}.`) : null,
      ),
    );
  }
  if (layer.kind === "shape") out.push(group("Фигура", color("Цвет", () => layer.fill ?? "#7548d9", (v) => (layer.fill = v))));

  const placing = [];
  if (layer.kind !== "text") {
    if (layer.kind !== "shape") {
      placing.push(choice("В кадре", () => L().fit ?? "cover", place("fit"), FITS, { cover: "Заполнить (с обрезкой)", contain: "Целиком" }));
      if ((L().fit ?? "cover") === "cover")
        placing.push(field("Что в кадре", h("div", { class: "pair" }, h("input", { type: "number", min: 0, max: 100, step: 1, value: L().focus?.x ?? 50, title: "По горизонтали, %", oninput: (e) => liveEdit("Фокус", () => place("focus")({ x: Number(e.target.value), y: L().focus?.y ?? 50 })), onchange: endLive }), h("input", { type: "number", min: 0, max: 100, step: 1, value: L().focus?.y ?? 50, title: "По вертикали, %", oninput: (e) => liveEdit("Фокус", () => place("focus")({ x: L().focus?.x ?? 50, y: Number(e.target.value) })), onchange: endLive }))));
    }
    placing.push(field("Рамка, %", h("div", { class: "pair" }, h("input", { type: "number", min: 1, max: 300, step: 1, value: L().box?.w ?? 100, title: "Ширина, % кадра", oninput: (e) => liveEdit("Рамка", () => place("box")({ w: Math.max(1, Number(e.target.value) || 100), h: L().box?.h ?? 100 })), onchange: endLive }), h("input", { type: "number", min: 1, max: 300, step: 1, value: L().box?.h ?? 100, title: "Высота, % кадра", oninput: (e) => liveEdit("Рамка", () => place("box")({ w: L().box?.w ?? 100, h: Math.max(1, Number(e.target.value) || 100) })), onchange: endLive }))));
  }
  placing.push(
    field("Положение", h("div", { class: "pair" }, h("input", { type: "number", step: 0.5, value: L().x ?? 0, title: "X, % кадра от центра", oninput: (e) => liveEdit("Положение", () => place("x")(Number(e.target.value) || 0)), onchange: endLive }), h("input", { type: "number", step: 0.5, value: L().y ?? 0, title: "Y, % кадра от центра", oninput: (e) => liveEdit("Положение", () => place("y")(Number(e.target.value) || 0)), onchange: endLive }))),
    num("Масштаб", () => L().scale ?? 1, place("scale"), { min: 0.05, max: 5, step: 0.01, slider: true }),
    num("Поворот", () => L().rotate ?? 0, place("rotate"), { min: -180, max: 180, step: 1, unit: "°" }),
    num("Прозрачность", () => layer.opacity ?? 1, (v) => (v >= 1 ? delete layer.opacity : (layer.opacity = v)), { min: 0, max: 1, step: 0.01, slider: true }),
  );
  if (layer.kind !== "text") placing.push(num("Скругление", () => layer.radius ?? 0, (v) => (v > 0 ? (layer.radius = v) : delete layer.radius), { min: 0, max: 540, step: 1 }));
  const g = group("Положение", ...placing);
  if (other) {
    g.firstChild.append(h("small", {}, `только для ${fmt}`));
    if (layer.formats?.[fmt]) g.append(h("div", { class: "btnRow" }, h("button", { class: "line", onclick: () => edit("Формат сброшен", () => (delete layer.formats[fmt], Object.keys(layer.formats).length || delete layer.formats)) }, `Как в ${S.clip.format}`)));
  }
  out.push(g);

  out.push(
    group(
      "Время",
      num("Начало", () => span.start, (v) => (v > 0 ? (layer.start = Math.min(v, sceneDuration(scene) - 0.1)) : delete layer.start), { min: 0, max: sceneDuration(scene), step: 0.05, unit: "с" }),
      num("Длится", () => (span.open ? undefined : span.duration), (v) => (v == null ? delete layer.duration : (layer.duration = Math.max(0.05, v))), { min: 0.05, step: 0.05, unit: "с", empty: "до конца сцены" }),
    ),
  );
  out.push(group("Анимация", ...motionFields("Появление", layer, "enter"), ...motionFields("Уход", layer, "exit"), ...moveFields(layer)));
  const idx = scene.layers.indexOf(layer);
  out.push(
    h(
      "div",
      { class: "btnRow" },
      h("button", { class: "line", disabled: idx >= scene.layers.length - 1, onclick: () => edit("Порядок слоёв", () => (scene.layers.splice(idx, 1), scene.layers.splice(idx + 1, 0, layer))) }, "Выше"),
      h("button", { class: "line", disabled: idx <= 0, onclick: () => edit("Порядок слоёв", () => (scene.layers.splice(idx, 1), scene.layers.splice(idx - 1, 0, layer))) }, "Ниже"),
      h("button", { class: "line", onclick: () => edit("Копия слоя", (clip) => { const copy = structuredClone(layer); copy.id = freshId(clip, `${layer.id}-copy`); copy.label = `${layer.label ?? layer.id} (копия)`; scene.layers.splice(idx + 1, 0, copy); S.sel = { type: "layer", id: copy.id }; }) }, "Копия"),
      h("button", { class: "line danger", onclick: removeSelected }, "Удалить"),
    ),
  );
  return out;
}

function moveFields(layer) {
  const on = !!layer.move;
  const out = [check("Медленный наезд или панорама", () => on, (v) => (v ? (layer.move = { from: { scale: 1 }, to: { scale: 1.12 }, ease: "inOut" }) : delete layer.move))];
  if (!on) return out;
  const part = (side, key, dflt) => h("input", { type: "number", step: key === "scale" ? 0.01 : 0.5, value: layer.move[side]?.[key] ?? dflt, title: `${side === "from" ? "В начале" : "В конце"}: ${key === "scale" ? "масштаб" : key.toUpperCase() + ", %"}`, oninput: (e) => liveEdit("Наезд", () => (layer.move[side] = { ...(layer.move[side] ?? {}), [key]: Number(e.target.value) || 0 })), onchange: endLive });
  out.push(field("Масштаб", h("div", { class: "pair" }, part("from", "scale", 1), part("to", "scale", 1))), field("Сдвиг X", h("div", { class: "pair" }, part("from", "x", 0), part("to", "x", 0))), field("Сдвиг Y", h("div", { class: "pair" }, part("from", "y", 0), part("to", "y", 0))), choice("Кривая", () => layer.move.ease ?? "inOut", (v) => (layer.move.ease = v), EASES, EASE_NAME), h("div", { class: "hint small" }, "Слева — в начале слоя, справа — в конце."));
  return out;
}

function sceneProps(scene) {
  const i = S.clip.scenes.indexOf(scene);
  const tr = () => scene.transition ?? { type: "cut" };
  const out = [
    h("div", { class: "head" }, h("input", { value: scene.label ?? scene.id, "aria-label": "Название сцены", oninput: (e) => liveEdit("Название сцены", () => (scene.label = e.target.value)), onchange: endLive }), h("span", { class: "dim" }, `Сцена ${i + 1}`)),
    group("Сцена", num("Длится", () => sceneDuration(scene), (v) => (scene.duration = v), { min: 0.2, max: 600, step: 0.05, unit: "с" }), color("Фон", () => scene.background ?? S.clip.background ?? "#000000", (v) => (scene.background = v))),
  ];
  if (i > 0)
    out.push(
      group(
        "Переход с прошлой сцены",
        choice("Вид", () => tr().type, (v) => (v === "cut" ? delete scene.transition : (scene.transition = { type: v, duration: tr().duration ?? 0.5 })), TRANSITIONS, TRANSITION_NAME),
        tr().type !== "cut" ? num("Длится", () => tr().duration ?? 0.5, (v) => (scene.transition = { ...tr(), duration: v }), { min: 0, max: 5, step: 0.05, unit: "с" }) : null,
      ),
    );
  out.push(
    h(
      "div",
      { class: "btnRow" },
      h("button", { class: "line", disabled: i <= 0, onclick: () => edit("Порядок сцен", (clip) => (clip.scenes.splice(i, 1), clip.scenes.splice(i - 1, 0, scene))) }, "← Раньше"),
      h("button", { class: "line", disabled: i >= S.clip.scenes.length - 1, onclick: () => edit("Порядок сцен", (clip) => (clip.scenes.splice(i, 1), clip.scenes.splice(i + 1, 0, scene))) }, "Позже →"),
      h("button", { class: "line", onclick: () => edit("Копия сцены", (clip) => { const id = duplicateScene(clip, scene.id); S.sceneId = id; S.sel = { type: "scene", id }; }) }, "Копия"),
      h("button", { class: "line", onclick: splitAtPlayhead }, "Разрезать"),
      h("button", { class: "line danger", onclick: removeSelected }, "Удалить"),
    ),
  );
  return out;
}

function audioProps(a) {
  const total = totalDuration(S.clip);
  return [
    h("div", { class: "head" }, h("i", { class: "kind audio" }), h("input", { value: a.label ?? a.src.split("/").pop(), "aria-label": "Название дорожки", oninput: (e) => liveEdit("Название", () => (a.label = e.target.value)), onchange: endLive }), h("span", { class: "dim" }, "Звук")),
    group(
      "Дорожка",
      num("Начало", () => a.start ?? 0, (v) => (a.start = v), { min: 0, max: total, step: 0.05, unit: "с" }),
      num("С момента", () => a.trimIn ?? 0, (v) => (v > 0 ? (a.trimIn = v) : delete a.trimIn), { min: 0, step: 0.1, unit: "с" }),
      num("Длится", () => a.duration, (v) => (v == null ? delete a.duration : (a.duration = v)), { min: 0.2, step: 0.1, unit: "с", empty: "до конца клипа" }),
      num("Громкость", () => a.volume ?? 1, (v) => (a.volume = v), { min: 0, max: 1.5, step: 0.05, slider: true }),
      num("Нарастание", () => a.fadeIn ?? 0, (v) => (a.fadeIn = v), { min: 0, max: 20, step: 0.1, unit: "с" }),
      num("Затухание", () => a.fadeOut ?? 0, (v) => (a.fadeOut = v), { min: 0, max: 20, step: 0.1, unit: "с" }),
    ),
    h("div", { class: "btnRow" }, h("button", { class: "line danger", onclick: removeSelected }, "Удалить")),
  ];
}

function clipProps() {
  const clip = S.clip;
  const made = new Set([clip.format, ...(clip.formats ?? [])]);
  return [
    h("div", { class: "head" }, h("b", { style: "font-size:14px;padding:0 8px" }, "Клип")),
    group(
      "Кадр",
      choice("Формат", () => clip.format, (v) => ((clip.format = v), (clip.formats = [...new Set([v, ...(clip.formats ?? [])])]), (S.format = v)), Object.keys(FORMATS)),
      h("div", { class: "field tall" }, h("label", {}, "Собирать в"), h("div", {}, Object.keys(FORMATS).map((f) => h("label", { class: "check" }, h("input", { type: "checkbox", checked: made.has(f), disabled: f === clip.format, onchange: (e) => edit("Форматы клипа", () => (clip.formats = Object.keys(FORMATS).filter((x) => x === clip.format || (x === f ? e.target.checked : made.has(x))))) }), `${f} · ${FORMATS[f].hint}`)))),
      choice("Кадров/с", () => String(clip.fps), (v) => (clip.fps = Number(v)), ["24", "25", "30", "50", "60"]),
      color("Фон", () => clip.background ?? "#080808", (v) => (clip.background = v)),
    ),
    group("Шрифты", text("Google Fonts", () => (clip.fonts ?? []).filter((f) => typeof f === "string").join(", "), (v) => (clip.fonts = [...(clip.fonts ?? []).filter((f) => typeof f !== "string"), ...v.split(",").map((s) => s.trim()).filter(Boolean)]), { placeholder: "Inter, Unbounded" }), h("div", { class: "hint small" }, "Названия через запятую. Instrument Sans есть всегда.")),
    h("div", { class: "hint" }, "Выберите сцену или слой, чтобы увидеть их свойства. Пробел — пуск, S — разрезать, ⌘Z — шаг назад, стрелки — по кадру."),
  ];
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
      h("h2", {}, "Собрать видео"),
      Object.keys(FORMATS).map((f) => h("label", { class: "fmt" }, h("input", { type: "checkbox", checked: picked.has(f), onchange: (e) => (e.target.checked ? picked.add(f) : picked.delete(f)) }), h("b", {}, f), h("span", {}, `${FORMATS[f].width}×${FORMATS[f].height} · ${FORMATS[f].hint}`))),
      h("div", { class: "field", style: "margin-top:10px" }, h("label", {}, "Качество"), h("select", { onchange: (e) => (quality = e.target.value) }, h("option", { value: "draft" }, "Черновик (файл меньше)"), h("option", { value: "high", selected: true }, "Высокое"), h("option", { value: "max" }, "Максимум"))),
      h("div", { class: "hint small" }, `${secs(totalDuration(clip))} · ${clip.fps} кадров в секунду · MP4 (H.264). Видео собирается прямо в этой вкладке: не закрывайте и не сворачивайте её, пока идёт сборка.`),
      errors.length ? h("div", { class: "status warn" }, `Сначала исправьте: ${errors[0]}`) : null,
      !canExport() ? h("div", { class: "status warn" }, "Этот браузер не умеет собирать видео. Откройте редактор в Chrome или Edge.") : null,
      h("div", { class: "btnRow" }, h("button", { class: "primary", disabled: !!errors.length || !canExport() || S.jobs.some((j) => j.state === "running"), onclick: () => (close(), startExport([...picked], quality)) }, "Собрать"), h("button", { class: "line", onclick: close }, "Отмена")),
    ),
  );
  pop.hidden = false;
  pop.onclick = close;
}

let jobId = 0;
async function startExport(formats, quality) {
  if (!formats.length) return toast("Не выбран ни один формат.", true);
  await flush();
  play(false);
  const clip = structuredClone(S.clip);
  const job = { id: ++jobId, label: `Сборка: ${formats.join(", ")}`, state: "running", progress: 0, note: "Готовлюсь…", files: [], stopped: false };
  S.jobs.push(job);
  drawJobs();
  try {
    await loadFonts(clip, S.urls);
    for (const [i, format] of formats.entries()) {
      const r = await exportFormat(clip, format, {
        urls: S.urls,
        blobs: S.blobs,
        quality,
        job: { get stopped() { return job.stopped; }, progress: (f, note) => ((job.progress = (i + f) / formats.length), (job.note = note), drawJobs()) },
      });
      const name = `${safeName(clip.name).replace(/[.-]+$/, "").replace(/-{2,}/g, "-") || "clip"}-${format.replace(":", "x")}.mp4`;
      job.files.push({ format, name, url: URL.createObjectURL(r.blob), size: r.blob.size, note: r.wantedSound && !r.sound ? "без звука: этот браузер не кодирует звук" : r.sound === "opus" ? "звук в Opus: в QuickTime может молчать" : "" });
      drawJobs();
    }
    job.state = "done";
    job.progress = 1;
  } catch (err) {
    job.state = job.stopped ? "stopped" : "failed";
    job.error = job.stopped ? "Остановлено." : `Не получилось: ${err?.message ?? err}`;
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
        h("div", { class: "jt" }, h("i", { class: "recDot" }), h("b", {}, `Идёт запись вкладки · ${fmtTime(S.recording.seconds(), 30).slice(0, 5)}`), h("button", { class: "line danger", onclick: () => S.recording?.finish() }, "Остановить")),
        h("div", { class: "note" }, "Перейдите на вкладку с сайтом и покажите его: прокрутите, наведите, нажмите. Потом вернитесь сюда и остановите запись. Лишнее в начале и в конце обрежете на таймлайне."),
      ),
    );
  for (const j of S.jobs.filter((x) => !x.closed))
    kids.push(
      h(
        "div",
        { class: `job ${j.state}` },
        h("div", { class: "jt" }, j.state === "running" ? h("i", { class: "spin" }) : null, h("b", {}, j.label), j.state === "running" ? h("button", { class: "ghost", onclick: () => ((j.stopped = true), (j.note = "Останавливаю…"), drawJobs()) }, "Стоп") : h("button", { class: "icon", title: "Закрыть", onclick: () => ((j.closed = true), drawJobs()) }, "×")),
        j.state === "running" ? h("div", { class: "bar" }, h("i", { style: `width:${Math.round((j.progress ?? 0) * 100)}%` })) : null,
        h("div", { class: "note" }, j.state === "failed" || j.state === "stopped" ? j.error : j.state === "done" ? "Готово. Нажмите на файл, чтобы скачать:" : j.note),
        j.files.length ? h("div", { class: "files" }, j.files.map((f) => h("a", { href: f.url, download: f.name }, `↓ ${f.format} · ${f.name} · ${(f.size / 1e6).toFixed(1)} МБ${f.note ? ` · ${f.note}` : ""}`))) : null,
      ),
    );
  box.replaceChildren(...kids);
}

// ---------- clips kept in this browser ----------

const flush = async () => {
  if (saveTimer) saveNow();
  await saving;
};

async function openClip(id) {
  play(false);
  for (const url of Object.values(S.urls)) URL.revokeObjectURL(url);
  S.urls = {};
  S.blobs = {};
  S.media = [];
  S.clipId = id;
  S.clip = await store.loadClip(id);
  for (const { blob, clipId, ...item } of await store.listMedia(id)) {
    S.media.push(item);
    S.blobs[item.path] = blob;
    S.urls[item.path] = URL.createObjectURL(blob);
  }
  S.format = S.clip.format;
  S.sceneId = S.clip.scenes[0].id;
  S.sel = null;
  S.t = 0;
  S.undo.length = S.redo.length = 0;
  S.problems = problemsOf(S.clip);
  await store.setLastOpened(id);
  fontsFor = "";
  showStage();
  drawAll();
  fitZoom();
  loadHistory();
}

async function createClip(name = "Новый клип") {
  const id = store.newId();
  const clip = blankClip(name);
  await store.saveClip(id, clip);
  await store.recordHistory(id, clip, "Новый клип");
  S.clips = await store.listClips();
  return id;
}

async function onClipsChange(e) {
  const v = e.target.value;
  await flush();
  if (v === "+new") await openClip(await createClip());
  else if (v === "-delete") {
    if (confirm(`Удалить клип «${S.clip.name}» вместе с его файлами? Вернуть его будет нельзя.`)) {
      await store.deleteClip(S.clipId);
      S.clips = await store.listClips();
      await openClip(S.clips[0].id);
    }
  } else await openClip(v);
  S.clips = await store.listClips();
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
      h("h2", {}, "С чего начнём?"),
      h("p", {}, "Перетащите сюда видео, картинки или музыку — или запишите свой сайт прямо из соседней вкладки."),
      h("div", { class: "btnRow" }, h("button", { class: "primary", onclick: () => pick.click() }, "Выбрать файлы"), canRecordTab() ? h("button", { class: "line", onclick: startTabRecording }, "● Записать вкладку") : null),
      h("p", { class: "dim" }, "Файлы не покидают ваш компьютер: клип хранится в этом браузере, и видео собирается здесь же."),
    ),
  );
}

function drawAll() {
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
  $("clipName").addEventListener("input", (e) => liveEdit("Название клипа", () => (S.clip.name = e.target.value.trim() || "Клип")));
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
      edit("Копия сцены", (clip) => {
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
  S.clips = await store.listClips();
  let id = await store.lastOpened();
  if (!S.clips.some((c) => c.id === id)) id = S.clips[0]?.id ?? (await createClip());
  wire();
  await openClip(id);
  store.keep();
  window.__clips = { S, stage, upload, startExport }; // for looking inside from the console
}

boot().catch((err) => {
  document.body.textContent = `Редактор не открылся: ${err?.message ?? err}`;
});
