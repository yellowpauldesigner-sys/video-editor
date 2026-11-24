// Building the video file, in the browser. A second stage draws every frame of the clip on its own canvas at the
// format's real size; each frame is encoded as H.264; the clip's sound is mixed off-line and encoded; and both are
// written into one MP4. Nothing leaves the computer.

import { frameSize, isMoving, layerSource, layerSpan, resolveLayer, sceneDuration, sceneStarts, totalDuration } from "./model.mjs";
import { Mp4 } from "./mp4.js";
import { Stage } from "./renderer.js";

export const canExport = () => typeof VideoEncoder !== "undefined" && typeof VideoFrame !== "undefined";

const BITRATE = { draft: 5e6, high: 14e6, max: 28e6 };

async function videoConfig(width, height, fps, quality) {
  const base = { width, height, framerate: fps, bitrate: Math.round(BITRATE[quality] * Math.max(0.6, (width * height) / (1920 * 1080))), avc: { format: "avc" }, latencyMode: "quality" };
  for (const codec of ["avc1.640033", "avc1.640028", "avc1.4d0028", "avc1.42E028"])
    for (const hardwareAcceleration of ["prefer-hardware", "no-preference"]) {
      const config = { ...base, codec, hardwareAcceleration };
      try {
        if ((await VideoEncoder.isConfigSupported(config)).supported) return config;
      } catch {
        /* this browser doesn't know the option: try the next */
      }
    }
  return null;
}

// Every sound of the clip mixed into one buffer, or null when the clip is silent
async function mixSound(clip, format, blobs, onNote) {
  const total = totalDuration(clip);
  const plan = [];
  for (const a of clip.audio ?? []) plan.push({ src: a.src, at: a.start ?? 0, from: a.trimIn ?? 0, len: a.duration ?? total - (a.start ?? 0), volume: a.volume ?? 1, speed: 1, fadeIn: a.fadeIn ?? 0, fadeOut: a.fadeOut ?? 0 });
  const starts = sceneStarts(clip);
  clip.scenes.forEach((scene, i) => {
    for (const raw of scene.layers) {
      const L = resolveLayer(raw, format);
      if (!isMoving(L) || L.hidden || !(L.volume > 0)) continue;
      const span = layerSpan(L, scene);
      plan.push({ src: layerSource(L), at: starts[i] + span.start, from: L.trim?.in ?? 0, len: Math.min(span.duration, sceneDuration(scene) - span.start), volume: L.volume, speed: L.speed ?? 1, fadeIn: 0.03, fadeOut: 0.03 });
    }
  });
  const live = plan.filter((p) => p.volume > 0 && p.len > 0.02 && p.at < total && blobs[p.src]);
  if (!live.length) return null;
  onNote?.("Свожу звук…");
  const RATE = 48000;
  const ctx = new OfflineAudioContext(2, Math.ceil(total * RATE), RATE);
  const decoded = new Map();
  let any = false;
  for (const p of live) {
    if (!decoded.has(p.src)) {
      try {
        decoded.set(p.src, await ctx.decodeAudioData(await blobs[p.src].arrayBuffer()));
      } catch {
        decoded.set(p.src, null); // a video with no sound track, or a file the browser can't decode
      }
    }
    const buffer = decoded.get(p.src);
    if (!buffer) continue;
    const len = Math.min(p.len, total - p.at);
    const node = ctx.createBufferSource();
    node.buffer = buffer;
    node.playbackRate.value = p.speed;
    const gain = ctx.createGain();
    const g = gain.gain;
    const fi = Math.min(p.fadeIn, len / 2);
    const fo = Math.min(p.fadeOut, len / 2);
    g.setValueAtTime(fi > 0 ? 0 : p.volume, p.at);
    if (fi > 0) g.linearRampToValueAtTime(p.volume, p.at + fi);
    if (fo > 0) {
      g.setValueAtTime(p.volume, p.at + len - fo);
      g.linearRampToValueAtTime(0, p.at + len);
    }
    node.connect(gain).connect(ctx.destination);
    node.start(p.at, p.from, len * p.speed);
    any = true;
  }
  return any ? ctx.startRendering() : null;
}

async function encodeSound(buffer, mp4) {
  if (typeof AudioEncoder === "undefined") return false;
  const RATE = buffer.sampleRate;
  let codec = null;
  for (const [name, id] of [["aac", "mp4a.40.2"], ["opus", "opus"]]) {
    try {
      if ((await AudioEncoder.isConfigSupported({ codec: id, sampleRate: RATE, numberOfChannels: 2, bitrate: 192000 })).supported) {
        codec = { name, id };
        break;
      }
    } catch {
      /* next */
    }
  }
  if (!codec) return false;
  mp4.startAudio({ codec: codec.name, rate: RATE, channels: 2 });
  let failed = null;
  const enc = new AudioEncoder({ output: (chunk, meta) => mp4.addAudio(chunk, meta), error: (e) => (failed = e) });
  enc.configure({ codec: codec.id, sampleRate: RATE, numberOfChannels: 2, bitrate: 192000 });
  const left = buffer.getChannelData(0);
  const right = buffer.numberOfChannels > 1 ? buffer.getChannelData(1) : left;
  const STEP = RATE; // a second at a time
  for (let at = 0; at < buffer.length; at += STEP) {
    const n = Math.min(STEP, buffer.length - at);
    const data = new Float32Array(n * 2);
    data.set(left.subarray(at, at + n), 0);
    data.set(right.subarray(at, at + n), n);
    const frame = new AudioData({ format: "f32-planar", sampleRate: RATE, numberOfFrames: n, numberOfChannels: 2, timestamp: Math.round((at / RATE) * 1e6), data });
    enc.encode(frame);
    frame.close();
  }
  await enc.flush();
  enc.close();
  if (failed) throw failed;
  return codec.name;
}

// Build one format. job: { stopped, progress(fraction, note) }. Returns { blob, width, height, sound }.
export async function exportFormat(clip, format, { urls, blobs, quality = "high", job }) {
  if (!canExport()) throw new Error("Этот браузер не умеет собирать видео. Откройте редактор в Chrome или Edge.");
  const { width, height } = frameSize(format);
  const fps = clip.fps;
  const total = totalDuration(clip);
  const frames = Math.max(1, Math.round(total * fps));
  const config = await videoConfig(width, height, fps, quality);
  if (!config) throw new Error("В этом браузере нет кодировщика H.264. Откройте редактор в Chrome или Edge.");

  const canvas = document.createElement("canvas");
  const stage = new Stage(canvas, { silent: true });
  stage.load(clip, { format, urls });
  const mp4 = new Mp4({ width, height, fps });
  let failed = null;
  const enc = new VideoEncoder({ output: (chunk, meta) => mp4.addVideo(chunk, meta), error: (e) => (failed = e) });
  enc.configure(config);
  try {
    const began = performance.now();
    for (let f = 0; f < frames; f++) {
      if (job.stopped) throw new Error("Остановлено.");
      if (failed) throw failed;
      await stage.seek((f + 0.5) / fps);
      const frame = new VideoFrame(canvas, { timestamp: Math.round((f * 1e6) / fps), duration: Math.round(1e6 / fps) });
      enc.encode(frame, { keyFrame: f % (fps * 2) === 0 });
      frame.close();
      while (enc.encodeQueueSize > 6) await new Promise((r) => setTimeout(r, 4));
      if (f % 5 === 0) {
        const left = ((performance.now() - began) / (f + 1)) * (frames - f - 1);
        job.progress((f + 1) / frames, `${format} · кадр ${f + 1} из ${frames}${f > 15 ? ` · осталось ~${Math.max(1, Math.round(left / 1000))} с` : ""}`);
        await new Promise((r) => setTimeout(r, 0)); // let the page breathe
      }
    }
    await enc.flush();
    if (failed) throw failed;
  } finally {
    if (enc.state !== "closed") enc.close();
    stage.dispose();
  }
  let sound = null;
  const mix = await mixSound(clip, format, blobs, (note) => job.progress(1, `${format} · ${note}`));
  if (mix) sound = await encodeSound(mix, mp4);
  return { blob: mp4.finish(), width, height, sound, wantedSound: !!mix };
}
