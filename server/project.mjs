// A clip project on disk: clip.json, the media folder, and the studio's own state in .clips/ (History, the change
// cards, settings, the token). Every write to clip.json goes through writeClip, one at a time, checked first.

import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { basename, extname, join, resolve, sep } from "node:path";
import { isMediaPath, mediaUsed, validate } from "../app/js/model.mjs";
import { findFfmpeg, findFfprobe, run } from "./tools.mjs";

export const VIDEO_EXT = [".mp4", ".mov", ".webm", ".m4v", ".mkv", ".gif"];
export const IMAGE_EXT = [".png", ".jpg", ".jpeg", ".webp", ".avif", ".svg"];
export const AUDIO_EXT = [".mp3", ".wav", ".m4a", ".aac", ".ogg", ".flac"];
export const FONT_EXT = [".woff2", ".woff", ".ttf", ".otf"];
// What Chrome plays as it is; anything else is converted once to H.264 when it comes in
const PLAYS = ["h264", "vp8", "vp9", "av1"];

export const kindOf = (name) => {
  const e = extname(name).toLowerCase();
  return VIDEO_EXT.includes(e) ? "video" : IMAGE_EXT.includes(e) ? "image" : AUDIO_EXT.includes(e) ? "audio" : FONT_EXT.includes(e) ? "font" : null;
};

export function openProject(dir) {
  const root = resolve(dir);
  const p = {
    root,
    clipFile: join(root, "clip.json"),
    media: join(root, "media"),
    renders: join(root, "renders"),
    state: join(root, ".clips"),
    history: join(root, ".clips", "history"),
    cache: join(root, ".clips", "cache"),
  };
  if (!existsSync(p.clipFile)) throw new Error(`Здесь нет clip.json: ${root}. Создайте проект: node scripts/new.mjs <папка>`);
  for (const d of [p.media, p.renders, p.state, p.history, p.cache]) mkdirSync(d, { recursive: true });
  const ignore = join(root, ".gitignore");
  const had = existsSync(ignore) ? readFileSync(ignore, "utf8") : "";
  const want = [".clips/", "renders/"].filter((l) => !had.split(/\r?\n/).includes(l));
  if (want.length) writeFileSync(ignore, `${had}${had && !had.endsWith("\n") ? "\n" : ""}${want.join("\n")}\n`);
  const tokenFile = join(p.state, "token");
  if (!existsSync(tokenFile)) writeFileSync(tokenFile, randomBytes(24).toString("hex"), { mode: 0o600 });
  p.token = readFileSync(tokenFile, "utf8").trim();
  return p;
}

const readJson = (file, fallback) => {
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return fallback;
  }
};
// Written whole or not at all: to a side file first, then moved into place
function writeJson(file, value) {
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`);
  renameSync(tmp, file);
}

export function readClip(p) {
  let clip;
  try {
    clip = JSON.parse(readFileSync(p.clipFile, "utf8"));
  } catch (err) {
    throw new Error(`clip.json не читается как JSON: ${err.message}`);
  }
  return clip;
}

// A path inside media/, as a real file. Null when it would leave the folder.
export function mediaFile(p, path) {
  if (!isMediaPath(path)) return null;
  const file = resolve(p.root, path);
  return file.startsWith(p.media + sep) ? file : null;
}

// Everything wrong with a clip: its format, and the files it names that aren't there
export function problems(p, clip) {
  const errors = validate(clip);
  if (errors.length) return errors;
  for (const [path, who] of mediaUsed(clip)) {
    const file = mediaFile(p, path);
    if (!file || !existsSync(file)) errors.push(`${who.map((w) => `"${w}"`).join(", ")}: файла ${path} нет в проекте`);
  }
  return errors;
}

// ---------- History: a snapshot of clip.json per version ----------

const indexFile = (p) => join(p.history, "index.json");
export const listHistory = (p) => readJson(indexFile(p), []);

function record(p, clip, kind, label) {
  const index = listHistory(p);
  const last = index.at(-1);
  const text = JSON.stringify(clip);
  if (last && readJson(join(p.history, `${last.id}.json`), null) && JSON.stringify(readJson(join(p.history, `${last.id}.json`), null)) === text) return last;
  const now = Date.now();
  // A run of hand edits in the editor is one point, not one per drag
  if (last && kind === "edit" && last.kind === "edit" && now - last.at < 45_000) {
    writeJson(join(p.history, `${last.id}.json`), clip);
    last.at = now;
    last.label = label ?? last.label;
    writeJson(indexFile(p), index);
    return last;
  }
  const entry = { id: String((Number(last?.id) || 0) + 1).padStart(5, "0"), at: now, kind, label: label ?? "" };
  writeJson(join(p.history, `${entry.id}.json`), clip);
  index.push(entry);
  // Keep the last 400; hand edits go first when it's time to drop some
  while (index.length > 400) {
    const drop = index.findIndex((e) => e.kind === "edit");
    const [gone] = index.splice(drop < 0 ? 0 : drop, 1);
    rmSync(join(p.history, `${gone.id}.json`), { force: true });
  }
  writeJson(indexFile(p), index);
  return entry;
}

let writing = Promise.resolve();
// One writer at a time
export function withWriteLock(fn) {
  const next = writing.then(fn, fn);
  writing = next.catch(() => {});
  return next;
}

// Check, record what was there if the studio didn't write it, write, record. Throws with the list of problems.
export function writeClip(p, clip, kind, label) {
  const errors = problems(p, clip);
  if (errors.length) {
    const err = new Error(errors.slice(0, 12).join("\n"));
    err.problems = errors;
    throw err;
  }
  const index = listHistory(p);
  const onDisk = readJson(p.clipFile, null);
  if (onDisk) {
    const last = index.at(-1);
    const lastClip = last ? readJson(join(p.history, `${last.id}.json`), null) : null;
    if (!lastClip) record(p, onDisk, "start", "Как было в начале");
    else if (JSON.stringify(lastClip) !== JSON.stringify(onDisk)) record(p, onDisk, "outside", "Изменено вне редактора");
  }
  writeJson(p.clipFile, clip);
  return record(p, clip, kind, label);
}

export function versionClip(p, id) {
  if (!/^\d{5}$/.test(String(id))) return null;
  return readJson(join(p.history, `${id}.json`), null);
}

// ---------- the change cards ----------

const cardsFile = (p) => join(p.state, "cards.json");
export const readCards = (p) => readJson(cardsFile(p), []);
export const writeCards = (p, cards) => writeJson(cardsFile(p), cards);

const settingsFile = (p) => join(p.state, "settings.json");
export const readSettings = (p) => ({ model: "sonnet", ...readJson(settingsFile(p), {}) });
export const writeSettings = (p, s) => writeJson(settingsFile(p), s);

// ---------- media ----------

const probed = new Map(); // file → { key, info }

export async function probe(file) {
  const st = statSync(file);
  const key = `${st.size}:${st.mtimeMs}`;
  const had = probed.get(file);
  if (had?.key === key) return had.info;
  const info = { size: st.size, mtime: Math.round(st.mtimeMs) };
  const ffprobe = findFfprobe();
  const kind = kindOf(file);
  if (ffprobe && (kind === "video" || kind === "audio" || kind === "image")) {
    const r = await run(ffprobe, ["-v", "error", "-print_format", "json", "-show_format", "-show_streams", file], { timeout: 30_000 });
    try {
      const j = JSON.parse(r.out);
      const v = j.streams?.find((s) => s.codec_type === "video");
      const a = j.streams?.find((s) => s.codec_type === "audio");
      if (v) {
        const rot = Math.abs(Number(v.side_data_list?.find((d) => d.rotation != null)?.rotation ?? v.tags?.rotate ?? 0)) % 180 === 90;
        info.width = rot ? v.height : v.width;
        info.height = rot ? v.width : v.height;
        info.codec = v.codec_name;
        const [n, d] = String(v.avg_frame_rate ?? "0/1").split("/").map(Number);
        if (n && d) info.fps = Math.round((n / d) * 100) / 100;
      }
      if (a) info.audio = true;
      const dur = Number(j.format?.duration);
      if (Number.isFinite(dur) && kind !== "image") info.duration = Math.round(dur * 1000) / 1000;
    } catch {
      /* a file ffprobe can't read is listed without details */
    }
  }
  probed.set(file, { key, info });
  return info;
}

// What the editor's page learned about a file by opening it (its size, its length, a small picture): kept beside
// the project so the library shows it at once next time, and so Claude can read lengths without ffprobe
const infoFile = (p) => join(p.state, "media-info.json");
export const readMediaInfo = (p) => readJson(infoFile(p), {});
export function writeMediaInfo(p, path, info, mtime) {
  const all = readMediaInfo(p);
  const clean = {};
  for (const k of ["width", "height", "duration", "audio"]) if (typeof info?.[k] === "number" || typeof info?.[k] === "boolean") clean[k] = info[k];
  if (typeof info?.thumb === "string" && info.thumb.startsWith("data:image/") && info.thumb.length < 200_000) clean.thumb = info.thumb;
  all[path] = { ...clean, mtime };
  writeJson(infoFile(p), all);
}

export async function listMedia(p) {
  const out = [];
  const seen = readMediaInfo(p);
  const walk = async (dir, rel) => {
    for (const e of readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      if (e.name.startsWith(".")) continue;
      if (e.isDirectory()) {
        if (e.name !== "originals") await walk(join(dir, e.name), `${rel}/${e.name}`);
        continue;
      }
      const kind = kindOf(e.name);
      if (!kind) continue;
      const path = `${rel}/${e.name}`;
      const probed = await probe(join(dir, e.name));
      const { mtime, ...known } = seen[path]?.mtime === probed.mtime ? seen[path] : {};
      // what ffprobe measured stands; what it couldn't say (or it isn't installed) comes from the page
      const item = { path, name: e.name, kind, ...probed };
      for (const [k, v] of Object.entries(known)) if (!item[k]) item[k] = v;
      out.push(item);
    }
  };
  await walk(p.media, "media");
  return out;
}

export function safeName(name) {
  const base = basename(String(name)).normalize("NFC").replace(/[^\p{L}\p{N}._ -]+/gu, "-").replace(/\s+/g, "-").replace(/^[.-]+/, "");
  return base.slice(-120) || "file";
}

// A free name in media/ for a new file
export function freeMediaName(p, name, sub = "") {
  const dir = sub ? join(p.media, sub) : p.media;
  mkdirSync(dir, { recursive: true });
  const ext = extname(name);
  const stem = name.slice(0, name.length - ext.length);
  let n = name;
  for (let i = 2; existsSync(join(dir, n)); i++) n = `${stem}-${i}${ext}`;
  return { file: join(dir, n), path: `media/${sub ? `${sub}/` : ""}${n}` };
}

// A video Chrome can't play (ProRes from a 3D render, HEVC from a phone, a GIF) becomes an H.264 copy the stage
// can show; the original is kept in media/originals/.
export async function makePlayable(p, path, onNote) {
  const file = mediaFile(p, path);
  if (!file || kindOf(file) !== "video") return path;
  const info = await probe(file);
  const ext = extname(file).toLowerCase();
  if (PLAYS.includes(info.codec) && [".mp4", ".webm", ".m4v", ".mov"].includes(ext)) return path;
  const ffmpeg = findFfmpeg();
  if (!ffmpeg) return path;
  onNote?.(`Перевожу ${basename(file)} в формат, который показывает браузер…`);
  const name = `${basename(file, extname(file))}.mp4`;
  const target = freeMediaName(p, name === basename(file) ? `${basename(file, ".mp4")}-h264.mp4` : name);
  const r = await run(ffmpeg, ["-y", "-i", file, "-vf", "pad=ceil(iw/2)*2:ceil(ih/2)*2,format=yuv420p", "-c:v", "libx264", "-preset", "fast", "-crf", "15", "-g", "30", "-c:a", "aac", "-b:a", "256k", "-movflags", "+faststart", target.file], { timeout: 30 * 60_000 });
  if (r.code !== 0) {
    rmSync(target.file, { force: true });
    return path;
  }
  mkdirSync(join(p.media, "originals"), { recursive: true });
  renameSync(file, freeMediaName(p, basename(file), "originals").file);
  return target.path;
}

export async function thumbnail(p, path) {
  const file = mediaFile(p, path);
  if (!file || !existsSync(file)) return null;
  const kind = kindOf(file);
  if (kind === "image") return file;
  if (kind !== "video") return null;
  const st = statSync(file);
  const out = join(p.cache, `${Buffer.from(`${path}:${st.size}:${Math.round(st.mtimeMs)}`).toString("base64url").slice(-80)}.jpg`);
  if (existsSync(out)) return out;
  const ffmpeg = findFfmpeg();
  if (!ffmpeg) return null;
  const info = await probe(file);
  const at = Math.min(1, (info.duration ?? 0) / 3);
  const r = await run(ffmpeg, ["-y", "-ss", String(at), "-i", file, "-frames:v", "1", "-vf", "scale=320:-2", "-q:v", "4", out], { timeout: 30_000 });
  return r.code === 0 && existsSync(out) ? out : null;
}
