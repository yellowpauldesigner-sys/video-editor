// The programs the studio runs on the person's computer: where ffmpeg, ffprobe, Chrome and Claude Code are, and
// one way to run a command and get its output.

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, join } from "node:path";

const WIN = process.platform === "win32";
const MAC = process.platform === "darwin";

function onPath(name) {
  const exts = WIN ? [".exe", ".cmd", ""] : [""];
  for (const dir of (process.env.PATH ?? "").split(delimiter)) for (const ext of exts) if (dir && existsSync(join(dir, name + ext))) return join(dir, name + ext);
  return null;
}
const first = (list) => list.find((p) => p && existsSync(p)) ?? null;

// The studio keeps its own copy of ffmpeg here when the person installed it with scripts/install-ffmpeg.sh
export const OWN_BIN = join(homedir(), ".uberdesigner", "clips", "bin");

export const findFfmpeg = () => first([process.env.FFMPEG, join(OWN_BIN, WIN ? "ffmpeg.exe" : "ffmpeg")]) ?? onPath("ffmpeg") ?? first(["/opt/homebrew/bin/ffmpeg", "/usr/local/bin/ffmpeg", "/usr/bin/ffmpeg"]);
export const findFfprobe = () => first([process.env.FFPROBE, join(OWN_BIN, WIN ? "ffprobe.exe" : "ffprobe")]) ?? onPath("ffprobe") ?? first(["/opt/homebrew/bin/ffprobe", "/usr/local/bin/ffprobe", "/usr/bin/ffprobe"]);

export function findChrome() {
  if (process.env.CHROME && existsSync(process.env.CHROME)) return process.env.CHROME;
  if (MAC)
    return first([
      "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
      join(homedir(), "Applications/Google Chrome.app/Contents/MacOS/Google Chrome"),
      "/Applications/Chromium.app/Contents/MacOS/Chromium",
      "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
      "/Applications/Brave Browser.app/Contents/MacOS/Brave Browser",
    ]);
  if (WIN) {
    const roots = [process.env["PROGRAMFILES"], process.env["PROGRAMFILES(X86)"], process.env.LOCALAPPDATA].filter(Boolean);
    return first(roots.flatMap((r) => [join(r, "Google/Chrome/Application/chrome.exe"), join(r, "Microsoft/Edge/Application/msedge.exe")]));
  }
  return onPath("google-chrome") ?? onPath("google-chrome-stable") ?? onPath("chromium") ?? onPath("chromium-browser");
}

export const findClaude = () => first([process.env.CLAUDE_BIN, join(homedir(), ".local/bin/claude"), "/opt/homebrew/bin/claude", "/usr/local/bin/claude"]) ?? onPath("claude");

// Run a command to its end. Never throws on a failing exit: the caller reads `code`.
export function run(cmd, args, { input, cwd, timeout, onSpawn, onErrLine, env } = {}) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(cmd, args, { cwd, env: env ?? process.env, stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
    } catch (err) {
      return resolve({ code: -1, out: "", err: String(err?.message ?? err), timedOut: false });
    }
    onSpawn?.(child);
    let out = "";
    let err = "";
    let tail = "";
    let timedOut = false;
    const timer = timeout
      ? setTimeout(() => {
          timedOut = true;
          child.kill("SIGKILL");
        }, timeout)
      : null;
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => {
      const s = String(d);
      err = (err + s).slice(-20000);
      if (!onErrLine) return;
      tail += s;
      const lines = tail.split(/[\r\n]+/);
      tail = lines.pop() ?? "";
      for (const line of lines) if (line.trim()) onErrLine(line);
    });
    child.on("error", (e) => {
      if (timer) clearTimeout(timer);
      resolve({ code: -1, out, err: err + String(e?.message ?? e), timedOut });
    });
    child.on("close", (code) => {
      if (timer) clearTimeout(timer);
      resolve({ code, out, err, timedOut });
    });
    child.stdin.on("error", () => {});
    if (input != null) child.stdin.end(input);
    else child.stdin.end();
  });
}

// What each of the studio's programs is, for the editor's status line and the setup check
export function toolStatus() {
  return { ffmpeg: findFfmpeg(), ffprobe: findFfprobe(), chrome: findChrome(), claude: findClaude() };
}
