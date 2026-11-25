// Files coming into a clip: what a file is, a small picture of it for the library, and recording a browser tab.

const VIDEO = /\.(mp4|mov|webm|m4v|mkv)$/i;
const IMAGE = /\.(png|jpe?g|webp|avif|svg|gif)$/i;
const AUDIO = /\.(mp3|wav|m4a|aac|ogg|flac)$/i;
const FONT = /\.(woff2?|ttf|otf)$/i;

export function kindOf(file) {
  const type = file.type ?? "";
  const name = file.name ?? "";
  if (type.startsWith("video/") || VIDEO.test(name)) return "video";
  if (type.startsWith("image/") || IMAGE.test(name)) return "image";
  if (type.startsWith("audio/") || AUDIO.test(name)) return "audio";
  if (type.startsWith("font/") || FONT.test(name)) return "font";
  return null;
}

export const safeName = (name) =>
  String(name)
    .normalize("NFC")
    .replace(/[\\/\0]+/g, "-")
    .replace(/\s+/g, "-")
    .replace(/^[.-]+/, "")
    .slice(-100) || "file";

const once = (el, ok, ms = 15000) =>
  new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error("timeout")), ms);
    el.addEventListener(ok, () => (clearTimeout(t), resolve()), { once: true });
    el.addEventListener("error", () => (clearTimeout(t), reject(new Error("can't read"))), { once: true });
  });

// A video straight from MediaRecorder says its length is endless until it has been read to the end once
async function trueDuration(video) {
  if (Number.isFinite(video.duration)) return video.duration;
  video.currentTime = 1e7;
  await once(video, "seeked", 20000).catch(() => {});
  const d = Number.isFinite(video.duration) ? video.duration : video.currentTime;
  video.currentTime = 0;
  await once(video, "seeked", 5000).catch(() => {});
  return d;
}

// What the browser can tell about a file, and a thumbnail. Throws when the browser can't play it.
export async function inspect(blob, kind) {
  const url = URL.createObjectURL(blob);
  try {
    if (kind === "image") {
      const img = new Image();
      img.src = url;
      await img.decode();
      return { width: img.naturalWidth, height: img.naturalHeight, thumb: thumbOf(img, img.naturalWidth, img.naturalHeight) };
    }
    if (kind === "video") {
      const v = document.createElement("video");
      v.muted = true;
      v.preload = "auto";
      v.src = url;
      await once(v, "loadeddata");
      const duration = await trueDuration(v);
      if (!v.videoWidth) throw new Error("no picture");
      v.currentTime = Math.min(1, duration / 3);
      await once(v, "seeked", 8000).catch(() => {});
      const info = { width: v.videoWidth, height: v.videoHeight, duration: Math.round(duration * 1000) / 1000, thumb: thumbOf(v, v.videoWidth, v.videoHeight) };
      info.audio = await hasSound(v);
      v.removeAttribute("src");
      v.load();
      return info;
    }
    if (kind === "audio") {
      const a = new Audio();
      a.preload = "metadata";
      a.src = url;
      await once(a, "loadedmetadata");
      return { duration: Math.round(a.duration * 1000) / 1000, audio: true };
    }
    return {};
  } finally {
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
}

async function hasSound(v) {
  if (typeof v.audioTracks?.length === "number") return v.audioTracks.length > 0;
  if (typeof v.webkitAudioDecodedByteCount === "number") {
    // Chrome counts decoded sound bytes only once it has played a little
    try {
      v.currentTime = 0;
      await v.play();
      await new Promise((r) => setTimeout(r, 250));
      v.pause();
      return v.webkitAudioDecodedByteCount > 0;
    } catch {
      return false;
    }
  }
  return typeof v.mozHasAudio === "boolean" ? v.mozHasAudio : false;
}

function thumbOf(source, w, h) {
  const c = document.createElement("canvas");
  c.width = 320;
  c.height = Math.max(2, Math.round((320 * h) / w));
  try {
    c.getContext("2d").drawImage(source, 0, 0, c.width, c.height);
    return c.toDataURL("image/jpeg", 0.72);
  } catch {
    return null;
  }
}

// ---------- recording a tab ----------

export const canRecordTab = () => !!navigator.mediaDevices?.getDisplayMedia && typeof MediaRecorder !== "undefined";

// Ask which tab to record and start. Returns { stop(): Promise<Blob>, onended } once the person has chosen;
// throws when they cancel. The file type is the best one this browser can both record and play back.
export async function recordTab({ fps = 60, onEnd } = {}) {
  const stream = await navigator.mediaDevices.getDisplayMedia({
    video: { frameRate: { ideal: fps, max: fps }, width: { ideal: 3840 }, height: { ideal: 2160 }, cursor: "motion" },
    audio: true, // the tab's own sound, when the person ticks it
    preferCurrentTab: false,
    selfBrowserSurface: "exclude",
    surfaceSwitching: "exclude",
  });
  const type = ["video/mp4;codecs=avc1.640033,mp4a.40.2", "video/mp4;codecs=avc1.640033", "video/mp4", "video/webm;codecs=vp9,opus", "video/webm;codecs=vp9", "video/webm"].find((t) => MediaRecorder.isTypeSupported(t));
  const rec = new MediaRecorder(stream, { mimeType: type, videoBitsPerSecond: 24_000_000 });
  const parts = [];
  rec.addEventListener("dataavailable", (e) => e.data.size && parts.push(e.data));
  const done = new Promise((resolve) => rec.addEventListener("stop", () => resolve(new Blob(parts, { type: type.split(";")[0] })), { once: true }));
  const started = performance.now();
  let stopped = false;
  const stop = () => {
    if (!stopped) {
      stopped = true;
      if (rec.state !== "inactive") rec.stop();
      for (const t of stream.getTracks()) t.stop();
    }
    return done;
  };
  // the browser's own "Stop sharing" button ends it too
  stream.getVideoTracks()[0].addEventListener("ended", () => {
    if (!stopped) {
      stop();
      onEnd?.();
    }
  });
  rec.start(1000);
  const settings = stream.getVideoTracks()[0].getSettings();
  return { stop, type, seconds: () => (performance.now() - started) / 1000, width: settings.width, height: settings.height };
}

// ---------- finding the cuts in a finished video ----------

// Where a video changes shot, in seconds. The video is looked at a few times a second as a tiny picture; a cut is
// a moment where the picture changes far more than it does around it. Slow fades are not found: a designer cuts
// those by hand with S.
export async function detectCuts(url, { onProgress, shouldStop, step = 0.2, minScene = 0.6 } = {}) {
  const v = document.createElement("video");
  v.muted = true;
  v.preload = "auto";
  v.src = url;
  await once(v, "loadeddata");
  const duration = await trueDuration(v);
  const W = 48;
  const H = 27;
  const c = document.createElement("canvas");
  c.width = W;
  c.height = H;
  const ctx = c.getContext("2d", { willReadFrequently: true });
  const diffs = [];
  let prev = null;
  const count = Math.max(1, Math.floor(duration / step));
  for (let i = 0; i <= count; i++) {
    if (shouldStop?.()) break;
    const t = Math.min(i * step, Math.max(0, duration - 0.01));
    v.currentTime = t;
    await once(v, "seeked", 6000).catch(() => {});
    ctx.drawImage(v, 0, 0, W, H);
    const px = ctx.getImageData(0, 0, W, H).data;
    // brightness of each pixel, and a coarse colour histogram: a pan moves pixels but keeps the colours
    const luma = new Float32Array(W * H);
    const hist = new Float32Array(64);
    for (let p = 0, q = 0; p < px.length; p += 4, q++) {
      luma[q] = 0.299 * px[p] + 0.587 * px[p + 1] + 0.114 * px[p + 2];
      hist[((px[p] >> 6) << 4) | ((px[p + 1] >> 6) << 2) | (px[p + 2] >> 6)]++;
    }
    if (prev) {
      let d = 0;
      for (let q = 0; q < luma.length; q++) d += Math.abs(luma[q] - prev.luma[q]);
      let hd = 0;
      for (let b = 0; b < 64; b++) hd += Math.abs(hist[b] - prev.hist[b]);
      diffs.push({ t, pixels: d / luma.length / 255, colours: hd / (2 * W * H) });
    }
    prev = { luma, hist };
    if (i % 5 === 0) onProgress?.(i / count);
  }
  v.removeAttribute("src");
  v.load();
  // a cut: both measures jump, and the jump stands well above the moments around it
  const score = diffs.map((d) => Math.min(d.pixels * 2.2, d.colours * 1.6));
  const cuts = [];
  for (let i = 0; i < score.length; i++) {
    const around = [];
    for (let k = Math.max(0, i - 4); k <= Math.min(score.length - 1, i + 4); k++) if (k !== i) around.push(score[k]);
    const calm = around.length ? around.sort((a, b) => a - b)[Math.floor(around.length / 2)] : 0;
    if (score[i] > 0.18 && score[i] > calm * 3 + 0.06) {
      const at = diffs[i].t - step / 2;
      if (at > minScene && duration - at > minScene && (!cuts.length || at - cuts.at(-1) >= minScene)) cuts.push(Math.round(at * 100) / 100);
    }
  }
  return { cuts, duration };
}

// Narrow a cut found on the coarse grid down to the frame where it happens
export async function refineCut(url, at, { step = 0.2, fps = 30 } = {}) {
  const v = document.createElement("video");
  v.muted = true;
  v.preload = "auto";
  v.src = url;
  await once(v, "loadeddata");
  const c = document.createElement("canvas");
  c.width = 48;
  c.height = 27;
  const ctx = c.getContext("2d", { willReadFrequently: true });
  const grab = async (t) => {
    v.currentTime = Math.max(0, t);
    await once(v, "seeked", 6000).catch(() => {});
    ctx.drawImage(v, 0, 0, 48, 27);
    return ctx.getImageData(0, 0, 48, 27).data;
  };
  const dist = (a, b) => {
    let d = 0;
    for (let p = 0; p < a.length; p += 4) d += Math.abs(a[p] - b[p]) + Math.abs(a[p + 1] - b[p + 1]) + Math.abs(a[p + 2] - b[p + 2]);
    return d;
  };
  let lo = at - step / 2;
  let hi = at + step / 2;
  const first = await grab(lo);
  const last = await grab(hi);
  // the cut is where a frame stops looking like the shot before and starts looking like the one after
  while (hi - lo > 1 / fps) {
    const mid = (lo + hi) / 2;
    const m = await grab(mid);
    if (dist(m, first) < dist(m, last)) lo = mid;
    else hi = mid;
  }
  v.removeAttribute("src");
  v.load();
  return Math.round(hi * fps) / fps;
}
