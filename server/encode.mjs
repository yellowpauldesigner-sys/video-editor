// Frames in, a video file out, through ffmpeg. Only the scripted site recorder uses this (it takes its frames from a
// headless Chrome); the editor itself builds videos in the page and needs no ffmpeg.

import { spawn } from "node:child_process";
import { findFfmpeg } from "./tools.mjs";

// Frames in, a finished video file out. Returns { write(buffer), finish() }.
export function encoder(out, { fps, png = false, crf = 17, gop = null }) {
  const ffmpeg = findFfmpeg();
  if (!ffmpeg) throw new Error("Не нашёл ffmpeg на этом компьютере. Он нужен только для покадровой записи сайта: sh scripts/install-ffmpeg.sh");
  const args = [
    "-y", "-loglevel", "error", "-f", "image2pipe", "-c:v", png ? "png" : "mjpeg", "-framerate", String(fps), "-i", "-",
    "-vf", "pad=ceil(iw/2)*2:ceil(ih/2)*2,scale=in_range=full:out_range=tv:out_color_matrix=bt709,format=yuv420p",
    "-c:v", "libx264", "-preset", "medium", "-crf", String(crf), ...(gop ? ["-g", String(gop)] : []),
    "-colorspace", "bt709", "-color_primaries", "bt709", "-color_trc", "bt709", "-color_range", "tv",
    "-movflags", "+faststart", "-an", out,
  ];
  const child = spawn(ffmpeg, args, { stdio: ["pipe", "ignore", "pipe"], windowsHide: true });
  let err = "";
  let failed = null;
  child.stderr.on("data", (d) => (err = (err + d).slice(-4000)));
  child.stdin.on("error", (e) => (failed ??= e));
  const closed = new Promise((res) => child.on("close", res));
  return {
    child,
    async write(buf) {
      if (failed) throw new Error(`ffmpeg остановился: ${err.trim() || failed.message}`);
      if (!child.stdin.write(buf)) await new Promise((r) => child.stdin.once("drain", r));
    },
    async finish() {
      child.stdin.end();
      const code = await closed;
      if (code !== 0) throw new Error(`ffmpeg не собрал видео: ${err.trim().split("\n").slice(-3).join(" ") || `код ${code}`}`);
    },
    kill() {
      child.kill("SIGKILL");
    },
  };
}

