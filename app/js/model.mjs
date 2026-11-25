// The clip's format, in one place: what a clip.json may hold, its timing, and the edits that are pure data
// (split, duplicate, resolve a layer for a format). No imports: the server, the scripts, the stage and the panel
// all use this same file, so they can't disagree about what a clip is.

export const FORMATS = {
  "16:9": { width: 1920, height: 1080, label: "16:9", hint: "YouTube, Behance, websites" },
  "9:16": { width: 1080, height: 1920, label: "9:16", hint: "Reels, Shorts, Stories" },
  "1:1": { width: 1080, height: 1080, label: "1:1", hint: "Instagram feed, LinkedIn" },
  "4:5": { width: 1080, height: 1350, label: "4:5", hint: "Instagram feed, X" },
};

export const LAYER_KINDS = ["video", "image", "text", "shape", "site"];
export const FITS = ["cover", "contain"];
export const MOTIONS = ["none", "fade", "up", "down", "left", "right", "scale", "blur", "grow-x", "grow-y"];
// How a text comes in piece by piece, and the pieces it can be cut into
export const TEXT_UNITS = ["line", "word", "letter"];
export const TEXT_MOTIONS = ["fade", "up", "down", "scale", "blur"];
export const SHAPES = ["rect", "ellipse"];
export const TRANSITIONS = ["cut", "fade", "slide-left", "slide-up", "zoom", "wipe"];
export const EASES = ["linear", "in", "out", "inOut", "expoOut", "backOut"];
export const SITE_ACTIONS = ["wait", "scroll", "wheel", "move", "click", "type", "key"];

// What a format may override on a layer: how it is placed, never what it is
export const FORMAT_KEYS = ["x", "y", "scale", "rotate", "fit", "box", "size", "maxWidth", "hidden", "align", "focus"];

const E = {
  linear: (p) => p,
  in: (p) => p * p * p,
  out: (p) => 1 - (1 - p) ** 3,
  inOut: (p) => (p < 0.5 ? 4 * p * p * p : 1 - (-2 * p + 2) ** 3 / 2),
  expoOut: (p) => (p >= 1 ? 1 : 1 - 2 ** (-10 * p)),
  backOut: (p) => 1 + 2.70158 * (p - 1) ** 3 + 1.70158 * (p - 1) ** 2,
};
export const ease = (name, p) => (E[name] ?? E.out)(Math.min(1, Math.max(0, p)));
export const lerp = (a, b, p) => a + (b - a) * p;
export const round = (n, d = 3) => Math.round(n * 10 ** d) / 10 ** d;

export const frameSize = (format) => FORMATS[format] ?? FORMATS["16:9"];
export const sceneDuration = (s) => Math.max(0.1, Number(s.duration) || 0.1);
export const totalDuration = (clip) => clip.scenes.reduce((n, s) => n + sceneDuration(s), 0);

export function sceneStarts(clip) {
  let t = 0;
  return clip.scenes.map((s) => {
    const at = t;
    t += sceneDuration(s);
    return at;
  });
}

// The scene on screen at t, with the time inside it
export function sceneAt(clip, t) {
  const starts = sceneStarts(clip);
  let i = clip.scenes.length - 1;
  for (let k = 0; k < starts.length; k++) {
    if (t < starts[k] + sceneDuration(clip.scenes[k])) {
      i = k;
      break;
    }
  }
  return { index: i, scene: clip.scenes[i], start: starts[i] ?? 0, local: t - (starts[i] ?? 0) };
}

// When a layer is on, inside its scene. A layer with no duration lasts to the scene's end.
export function layerSpan(layer, scene) {
  const start = Math.max(0, Number(layer.start) || 0);
  const rest = sceneDuration(scene) - start;
  const duration = layer.duration == null ? rest : Math.max(0.05, Number(layer.duration));
  return { start, duration, end: start + duration, open: layer.duration == null };
}

// A layer as one format has it: the layer, with that format's overrides on top
export function resolveLayer(layer, format) {
  const o = layer.formats?.[format];
  return o ? { ...layer, ...o } : layer;
}

// Where an edit of a placement key goes: the layer itself in the clip's main format, the override elsewhere
export function setPlaced(clip, layer, format, key, value) {
  if (format === clip.format || !FORMAT_KEYS.includes(key)) {
    layer[key] = value;
    return;
  }
  layer.formats ??= {};
  layer.formats[format] ??= {};
  layer.formats[format][key] = value;
}

export const findScene = (clip, id) => clip.scenes.find((s) => s.id === id);
export function findLayer(clip, id) {
  for (const scene of clip.scenes) {
    const layer = scene.layers.find((l) => l.id === id);
    if (layer) return { scene, layer };
  }
  return null;
}

export function allIds(clip) {
  const ids = new Set();
  for (const s of clip.scenes) {
    ids.add(s.id);
    for (const l of s.layers) ids.add(l.id);
  }
  for (const a of clip.audio ?? []) ids.add(a.id);
  return ids;
}

export function freshId(clip, base) {
  const ids = allIds(clip);
  const stem =
    String(base || "item")
      .toLowerCase()
      .replace(/\.[a-z0-9]+$/, "")
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 28) || "item";
  if (!ids.has(stem)) return stem;
  for (let n = 2; ; n++) if (!ids.has(`${stem}-${n}`)) return `${stem}-${n}`;
}

// The file a layer plays: a site layer plays its recording once there is one
export const layerSource = (layer) => (layer.kind === "site" ? layer.recording || null : layer.src || null);
export const isMoving = (layer) => layer.kind === "video" || (layer.kind === "site" && !!layer.recording);

// How long a site layer's script runs
export const actionsDuration = (actions) => (actions ?? []).reduce((n, a) => n + Math.max(0, Number(a.for) || (a.do === "click" || a.do === "key" ? 0.2 : 0)), 0);

// What a site layer's recording was made from. The recorder notes it on the layer; when it no longer matches, the
// recording is out of date.
export function siteKey(layer) {
  const text = JSON.stringify([layer.url, layer.viewport ?? null, layer.actions ?? null, !!layer.cursor, layer.scrollIn ?? null, layer.settle ?? null, layer.fps ?? null]);
  let h = 5381;
  for (let i = 0; i < text.length; i++) h = ((h << 5) + h + text.charCodeAt(i)) | 0;
  return (h >>> 0).toString(36);
}

// The number a counting text shows `at` seconds into its layer
export function countValue(count, at, layerDuration) {
  const d = count.duration ?? Math.min(layerDuration, 1.5);
  const v = lerp(count.from ?? 0, count.to, ease(count.ease ?? "expoOut", d > 0 ? at / d : 1));
  const fixed = v.toFixed(count.decimals ?? 0);
  // thin spaces between thousands, as a designer would set them
  const [whole, frac] = fixed.split(".");
  const grouped = count.group === false ? whole : whole.replace(/\B(?=(\d{3})+(?!\d))/g, "\u202f");
  return frac ? `${grouped}${count.comma ? "," : "."}${frac}` : grouped;
}

// ---------- edits ----------

// Cut a scene in two at `at` seconds inside it. Layers that cross the cut are in both halves, and a video goes on
// in the second half from where the first one stopped.
export function splitScene(clip, sceneId, at) {
  const i = clip.scenes.findIndex((s) => s.id === sceneId);
  if (i < 0) return null;
  const scene = clip.scenes[i];
  const total = sceneDuration(scene);
  if (at < 0.1 || at > total - 0.1) return null;
  const a = { ...scene, duration: round(at), layers: [] };
  const b = { ...structuredClone(scene), id: freshId(clip, `${scene.id}-b`), label: `${scene.label ?? scene.id} · 2`, duration: round(total - at), layers: [] };
  delete b.transition;
  const taken = allIds(clip);
  taken.add(b.id);
  for (const layer of scene.layers) {
    const span = layerSpan(layer, scene);
    if (span.end <= at) {
      a.layers.push(layer);
      continue;
    }
    if (span.start >= at) {
      b.layers.push({ ...layer, start: round(span.start - at) });
      continue;
    }
    const first = structuredClone(layer);
    const second = structuredClone(layer);
    let id = `${layer.id}-b`;
    for (let n = 2; taken.has(id); n++) id = `${layer.id}-b${n}`;
    taken.add(id);
    second.id = id;
    const cut = (at - span.start) / span.duration; // how far through the layer the cut falls
    if (!span.open) {
      first.duration = round(at - span.start);
      second.duration = round(span.end - at);
    } else {
      delete first.duration;
      delete second.duration;
    }
    second.start = 0;
    delete first.exit;
    delete second.enter;
    if (isMoving(layer)) {
      const speed = Number(layer.speed) || 1;
      second.trim = { ...(layer.trim ?? {}), in: round((layer.trim?.in ?? 0) + (at - span.start) * speed) };
    }
    if (layer.move) {
      const m = layer.move;
      const p = ease(m.ease ?? "inOut", cut);
      const mid = {};
      for (const k of ["x", "y", "scale"]) {
        const from = m.from?.[k];
        const to = m.to?.[k];
        if (from != null || to != null) mid[k] = round(lerp(from ?? (k === "scale" ? 1 : 0), to ?? (k === "scale" ? 1 : 0), p));
      }
      first.move = { ...m, to: mid, ease: "linear" };
      second.move = { ...m, from: mid, ease: "linear" };
    }
    a.layers.push(first);
    b.layers.push(second);
  }
  clip.scenes.splice(i, 1, a, b);
  return { first: a.id, second: b.id };
}

export function duplicateScene(clip, sceneId) {
  const i = clip.scenes.findIndex((s) => s.id === sceneId);
  if (i < 0) return null;
  const copy = structuredClone(clip.scenes[i]);
  copy.id = freshId(clip, `${copy.id}-copy`);
  copy.label = `${copy.label ?? clip.scenes[i].id} (copy)`;
  const taken = allIds(clip);
  taken.add(copy.id);
  for (const l of copy.layers) {
    let id = `${l.id}-copy`;
    for (let n = 2; taken.has(id); n++) id = `${l.id}-copy${n}`;
    taken.add(id);
    l.id = id;
  }
  clip.scenes.splice(i + 1, 0, copy);
  return copy.id;
}

// ---------- checks ----------

const isNum = (v) => typeof v === "number" && Number.isFinite(v);
const isStr = (v) => typeof v === "string";
const isObj = (v) => v && typeof v === "object" && !Array.isArray(v);
const ID = /^[a-z0-9][a-z0-9-]{0,47}$/;
// A file of the clip: inside media/, no way out of it
export const isMediaPath = (p) => isStr(p) && /^media\/[^\\]+$/.test(p) && !p.split("/").includes("..") && !p.includes("\0");
export const isWebAddress = (u) => isStr(u) && /^https?:\/\/[^\s]+$/i.test(u);

function checkMotion(m, where, errors) {
  if (m == null) return;
  if (!isObj(m)) return errors.push(`${where}: must be an object { type, duration, ease }`);
  if (m.type != null && !MOTIONS.includes(m.type)) errors.push(`${where}.type: "${m.type}" is not one of ${MOTIONS.join(", ")}`);
  if (m.duration != null && !(isNum(m.duration) && m.duration >= 0 && m.duration <= 10)) errors.push(`${where}.duration: a number from 0 to 10 seconds`);
  if (m.ease != null && !EASES.includes(m.ease)) errors.push(`${where}.ease: "${m.ease}" is not one of ${EASES.join(", ")}`);
}

function checkPlaced(l, where, errors) {
  for (const k of ["x", "y"]) if (l[k] != null && !(isNum(l[k]) && Math.abs(l[k]) <= 300)) errors.push(`${where}.${k}: a number, in percent of the frame (0 is the center)`);
  if (l.scale != null && !(isNum(l.scale) && l.scale > 0 && l.scale <= 20)) errors.push(`${where}.scale: a number above 0 (1 is as it is)`);
  if (l.rotate != null && !isNum(l.rotate)) errors.push(`${where}.rotate: a number, in degrees`);
  if (l.fit != null && !FITS.includes(l.fit)) errors.push(`${where}.fit: "cover" or "contain"`);
  if (l.box != null && !(isObj(l.box) && isNum(l.box.w) && isNum(l.box.h) && l.box.w > 0 && l.box.h > 0)) errors.push(`${where}.box: { w, h } in percent of the frame`);
  if (l.size != null && !(isNum(l.size) && l.size > 0 && l.size <= 2000)) errors.push(`${where}.size: the text size, a number above 0`);
  if (l.hidden != null && typeof l.hidden !== "boolean") errors.push(`${where}.hidden: true or false`);
}

// Every problem in a clip, in plain words. An empty list means the clip can be saved and rendered.
export function validate(clip) {
  const errors = [];
  if (!isObj(clip)) return ["clip.json must be an object"];
  if (clip.version !== 1) errors.push('version: must be 1');
  if (!isStr(clip.name) || !clip.name.trim()) errors.push("name: the clip's name, a string");
  if (!(isNum(clip.fps) && [24, 25, 30, 50, 60].includes(clip.fps))) errors.push("fps: 24, 25, 30, 50 or 60");
  if (!FORMATS[clip.format]) errors.push(`format: one of ${Object.keys(FORMATS).join(", ")}`);
  if (clip.formats != null && !(Array.isArray(clip.formats) && clip.formats.every((f) => FORMATS[f]))) errors.push(`formats: a list from ${Object.keys(FORMATS).join(", ")}`);
  if (clip.facts != null && !(Array.isArray(clip.facts) && clip.facts.every(isStr))) errors.push("facts: a list of strings");
  if (clip.fonts != null && !(Array.isArray(clip.fonts) && clip.fonts.every((f) => isStr(f) || (isObj(f) && isStr(f.family) && isMediaPath(f.src))))) errors.push('fonts: a list of Google Fonts family names or { family, src: "media/…" }');
  if (!Array.isArray(clip.scenes) || !clip.scenes.length) {
    errors.push("scenes: at least one scene is needed");
    return errors;
  }
  const seen = new Set();
  const once = (id, where) => {
    if (!isStr(id) || !ID.test(id)) errors.push(`${where}.id: lowercase latin letters, digits and hyphens (it is ${JSON.stringify(id)})`);
    else if (seen.has(id)) errors.push(`${where}.id: "${id}" is already taken: an id is used once in the whole clip`);
    else seen.add(id);
  };
  clip.scenes.forEach((s, si) => {
    const sw = `scenes[${si}]`;
    if (!isObj(s)) return errors.push(`${sw}: must be an object`);
    once(s.id, sw);
    const sn = isStr(s.id) ? `scene "${s.id}"` : sw;
    if (!(isNum(s.duration) && s.duration >= 0.1 && s.duration <= 600)) errors.push(`${sn}: duration is from 0.1 to 600 seconds`);
    if (s.transition != null) {
      if (!isObj(s.transition) || !TRANSITIONS.includes(s.transition.type)) errors.push(`${sn}: transition.type is one of ${TRANSITIONS.join(", ")}`);
      else if (s.transition.duration != null && !(isNum(s.transition.duration) && s.transition.duration >= 0 && s.transition.duration <= 5)) errors.push(`${sn}: transition.duration is from 0 to 5 seconds`);
    }
    if (!Array.isArray(s.layers)) return errors.push(`${sn}: layers is a list of layers (it may be empty)`);
    s.layers.forEach((l, li) => {
      const lw = `${sn}, layers[${li}]`;
      if (!isObj(l)) return errors.push(`${lw}: must be an object`);
      once(l.id, lw);
      const ln = isStr(l.id) ? `layer "${l.id}"` : lw;
      if (!LAYER_KINDS.includes(l.kind)) return errors.push(`${ln}: kind is one of ${LAYER_KINDS.join(", ")}`);
      if (l.start != null && !(isNum(l.start) && l.start >= 0)) errors.push(`${ln}: start is seconds from the scene's start, 0 or more`);
      if (l.duration != null && !(isNum(l.duration) && l.duration > 0)) errors.push(`${ln}: duration is above 0 (or leave the field out: the layer runs to the scene's end)`);
      if (isNum(l.start) && isNum(s.duration) && l.start >= s.duration) errors.push(`${ln}: starts (${l.start} s) after its scene has ended (${s.duration} s)`);
      if (l.opacity != null && !(isNum(l.opacity) && l.opacity >= 0 && l.opacity <= 1)) errors.push(`${ln}: opacity is from 0 to 1`);
      checkPlaced(l, ln, errors);
      checkMotion(l.enter, `${ln}.enter`, errors);
      checkMotion(l.exit, `${ln}.exit`, errors);
      if (l.move != null && !(isObj(l.move) && (isObj(l.move.from) || isObj(l.move.to)))) errors.push(`${ln}: move — { from: { x, y, scale }, to: { x, y, scale }, ease }`);
      if (l.formats != null) {
        if (!isObj(l.formats)) errors.push(`${ln}: formats is an object keyed by format`);
        else
          for (const [f, o] of Object.entries(l.formats)) {
            if (!FORMATS[f]) errors.push(`${ln}: formats["${f}"] is not a format`);
            else if (!isObj(o)) errors.push(`${ln}: formats["${f}"] must be an object`);
            else {
              const extra = Object.keys(o).filter((k) => !FORMAT_KEYS.includes(k));
              if (extra.length) errors.push(`${ln}: formats["${f}"] may change only ${FORMAT_KEYS.join(", ")} (not ${extra.join(", ")})`);
              checkPlaced(o, `${ln}.formats["${f}"]`, errors);
            }
          }
      }
      if (l.kind === "video" || l.kind === "image") {
        if (!isMediaPath(l.src)) errors.push(`${ln}: src is a file in the media/ folder (it is ${JSON.stringify(l.src)})`);
      }
      if (l.kind === "video" || l.kind === "site") {
        if (l.trim != null && !(isObj(l.trim) && (l.trim.in == null || (isNum(l.trim.in) && l.trim.in >= 0)))) errors.push(`${ln}: trim is { in }, in seconds of the source video`);
        if (l.speed != null && !(isNum(l.speed) && l.speed >= 0.1 && l.speed <= 16)) errors.push(`${ln}: speed is from 0.1 to 16`);
        if (l.volume != null && !(isNum(l.volume) && l.volume >= 0 && l.volume <= 2)) errors.push(`${ln}: volume is from 0 to 2`);
      }
      if (l.kind === "text") {
        if (!isStr(l.text)) errors.push(`${ln}: text is a string`);
        if (l.weight != null && !(isNum(l.weight) && l.weight >= 100 && l.weight <= 900)) errors.push(`${ln}: weight is from 100 to 900`);
        if (l.animate != null) {
          const a = l.animate;
          if (!isObj(a) || !TEXT_UNITS.includes(a.by)) errors.push(`${ln}: animate.by is one of ${TEXT_UNITS.join(", ")}`);
          else {
            if (a.type != null && !TEXT_MOTIONS.includes(a.type)) errors.push(`${ln}: animate.type is one of ${TEXT_MOTIONS.join(", ")}`);
            if (a.stagger != null && !(isNum(a.stagger) && a.stagger >= 0 && a.stagger <= 5)) errors.push(`${ln}: animate.stagger is the seconds between one piece and the next, from 0 to 5`);
            if (a.duration != null && !(isNum(a.duration) && a.duration > 0 && a.duration <= 10)) errors.push(`${ln}: animate.duration is seconds, above 0`);
            if (a.ease != null && !EASES.includes(a.ease)) errors.push(`${ln}: animate.ease is one of ${EASES.join(", ")}`);
          }
        }
        if (l.count != null) {
          const c = l.count;
          if (!isObj(c) || !isNum(c.to)) errors.push(`${ln}: count is { from, to, decimals, duration, ease }, and "to" is required`);
          else {
            if (c.from != null && !isNum(c.from)) errors.push(`${ln}: count.from is a number`);
            if (c.decimals != null && !(Number.isInteger(c.decimals) && c.decimals >= 0 && c.decimals <= 4)) errors.push(`${ln}: count.decimals is a whole number from 0 to 4`);
            if (c.duration != null && !(isNum(c.duration) && c.duration > 0)) errors.push(`${ln}: count.duration is seconds, above 0`);
            if (c.ease != null && !EASES.includes(c.ease)) errors.push(`${ln}: count.ease is one of ${EASES.join(", ")}`);
            if (isStr(l.text) && !l.text.includes("{n}")) errors.push(`${ln}: the text needs a place for the number: {n}`);
          }
        }
      }
      if (l.kind === "shape" && l.shape != null && !SHAPES.includes(l.shape)) errors.push(`${ln}: shape is one of ${SHAPES.join(", ")}`);
      if (l.kind === "site") {
        if (!isWebAddress(l.url)) errors.push(`${ln}: url is a site's address, starting with http:// or https://`);
        if (l.recording != null && !isMediaPath(l.recording)) errors.push(`${ln}: recording is a file in the media/ folder`);
        if (l.viewport != null && !(isObj(l.viewport) && isNum(l.viewport.width) && isNum(l.viewport.height) && l.viewport.width >= 320 && l.viewport.width <= 3840 && l.viewport.height >= 320 && l.viewport.height <= 3840)) errors.push(`${ln}: viewport is { width, height }, each from 320 to 3840`);
        if (l.actions != null) {
          if (!Array.isArray(l.actions)) errors.push(`${ln}: actions is a list of actions`);
          else
            l.actions.forEach((a, ai) => {
              const aw = `${ln}, actions[${ai}]`;
              if (!isObj(a) || !SITE_ACTIONS.includes(a.do)) return errors.push(`${aw}: do is one of ${SITE_ACTIONS.join(", ")}`);
              if (a.for != null && !(isNum(a.for) && a.for >= 0 && a.for <= 120)) errors.push(`${aw}: for is seconds, from 0 to 120`);
              if (a.ease != null && !EASES.includes(a.ease)) errors.push(`${aw}: ease is one of ${EASES.join(", ")}`);
              if (a.do === "scroll" && !(isNum(a.to) || isStr(a.to))) errors.push(`${aw}: scroll.to is pixels, "bottom", "top" or a CSS selector`);
              if (a.do === "wheel" && !isNum(a.by)) errors.push(`${aw}: wheel.by is how many pixels to turn the wheel`);
              if ((a.do === "move" || a.do === "click") && !(isStr(a.to) || (Array.isArray(a.to) && a.to.length === 2 && a.to.every(isNum)) || (a.do === "click" && a.to == null))) errors.push(`${aw}: to is a CSS selector or [x, y] in window pixels`);
              if (a.do === "type" && !isStr(a.text)) errors.push(`${aw}: type.text is a string`);
              if (a.do === "key" && !isStr(a.key)) errors.push(`${aw}: key.key is a key's name ("Enter", "Escape", "ArrowDown")`);
            });
        }
      }
    });
  });
  if (clip.audio != null) {
    if (!Array.isArray(clip.audio)) errors.push("audio: a list of audio tracks");
    else
      clip.audio.forEach((a, ai) => {
        const aw = `audio[${ai}]`;
        if (!isObj(a)) return errors.push(`${aw}: must be an object`);
        once(a.id, aw);
        if (!isMediaPath(a.src)) errors.push(`${aw}: src is a file in the media/ folder`);
        if (a.start != null && !(isNum(a.start) && a.start >= 0)) errors.push(`${aw}: start is seconds from the clip's start`);
        if (a.volume != null && !(isNum(a.volume) && a.volume >= 0 && a.volume <= 2)) errors.push(`${aw}: volume is from 0 to 2`);
        for (const k of ["fadeIn", "fadeOut", "trimIn", "duration"]) if (a[k] != null && !(isNum(a[k]) && a[k] >= 0)) errors.push(`${aw}: ${k} is seconds, 0 or more`);
      });
  }
  return errors;
}

// Every media file a clip names, with who uses it
export function mediaUsed(clip) {
  const used = new Map();
  const add = (p, who) => p && used.set(p, [...(used.get(p) ?? []), who]);
  for (const s of clip.scenes ?? [])
    for (const l of s.layers ?? []) {
      if (l.kind === "site") add(l.recording, l.id);
      else add(l.src, l.id);
    }
  for (const a of clip.audio ?? []) add(a.src, a.id);
  for (const f of clip.fonts ?? []) if (f && typeof f === "object") add(f.src, f.family);
  return used;
}

export const blankClip = (name = "New clip") => ({
  version: 1,
  name,
  fps: 30,
  format: "16:9",
  formats: ["16:9", "9:16"],
  background: "#080808",
  facts: [],
  fonts: [],
  scenes: [
    {
      id: "title",
      label: "Title",
      duration: 3,
      background: "#080808",
      layers: [{ id: "title-text", kind: "text", label: "Name", text: name, size: 96, weight: 600, color: "#ffffff", enter: { type: "up", duration: 0.6 }, exit: { type: "fade", duration: 0.4 } }],
    },
  ],
  audio: [],
});
