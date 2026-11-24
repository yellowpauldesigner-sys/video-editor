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
