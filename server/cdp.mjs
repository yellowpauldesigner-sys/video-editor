// A headless Chrome tab driven over the DevTools protocol, with no packages: Node's own WebSocket and the Chrome
// the person already has. The render and the site recorder both take their frames from one of these.

import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { findChrome } from "./tools.mjs";

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export async function openTab({ width, height, scale = 1 }) {
  const chromePath = findChrome();
  if (!chromePath) throw new Error("Google Chrome wasn't found on this computer. Install Chrome (or put its path in the CHROME variable).");
  const profile = mkdtempSync(join(tmpdir(), "uberdesigner-clips-chrome-"));
  const extra = (process.env.CHROME_FLAGS ?? "").split(/\s+/).filter(Boolean);
  const chrome = spawn(
    chromePath,
    [
      "--headless=new",
      "--remote-debugging-port=0",
      `--user-data-dir=${profile}`,
      "--hide-scrollbars",
      "--mute-audio",
      "--autoplay-policy=no-user-gesture-required",
      "--force-device-scale-factor=1",
      "--force-color-profile=srgb",
      "--disable-background-timer-throttling",
      "--disable-renderer-backgrounding",
      "--disable-backgrounding-occluded-windows",
      "--disable-features=CalculateNativeWinOcclusion,Translate",
      "--no-first-run",
      "--no-default-browser-check",
      ...(process.platform === "darwin" ? ["--use-angle=metal"] : []), // the Mac's own graphics, so WebGL runs as on screen
      "--enable-gpu",
      "--ignore-gpu-blocklist",
      `--window-size=${Math.max(800, width)},${Math.max(600, height)}`,
      ...extra,
      "about:blank",
    ],
    { stdio: "ignore" },
  );
  let exited = false;
  chrome.on("exit", () => (exited = true));
  const portFile = join(profile, "DevToolsActivePort");
  let ws = null;
  for (let i = 0; i < 120 && !ws && !exited; i++) {
    await sleep(150);
    if (!existsSync(portFile)) continue;
    const port = Number(readFileSync(portFile, "utf8").split("\n")[0]);
    if (!port) continue;
    try {
      const pages = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
      const page = pages.find((t) => t.type === "page");
      if (!page) continue;
      ws = new WebSocket(page.webSocketDebuggerUrl);
      await new Promise((res, rej) => {
        ws.addEventListener("open", res, { once: true });
        ws.addEventListener("error", () => rej(new Error("Chrome didn't answer")), { once: true });
      });
    } catch {
      ws = null;
    }
  }
  const close = () => {
    try {
      ws?.close();
    } catch {
      /* already closed */
    }
    if (!exited) chrome.kill("SIGKILL");
    setTimeout(() => rmSync(profile, { recursive: true, force: true }), 500).unref();
  };
  if (!ws) {
    close();
    throw new Error(`Chrome didn't start (${chromePath}).${process.platform === "linux" ? " In a container it needs CHROME_FLAGS=--no-sandbox." : ""}`);
  }
  let id = 0;
  const pending = new Map();
  const listeners = new Map();
  ws.addEventListener("message", (m) => {
    const d = JSON.parse(m.data);
    if (d.id && pending.has(d.id)) {
      const p = pending.get(d.id);
      pending.delete(d.id);
      d.error ? p.rej(new Error(d.error.message)) : p.res(d.result);
    } else if (d.method) for (const fn of listeners.get(d.method) ?? []) fn(d.params);
  });
  ws.addEventListener("close", () => {
    for (const p of pending.values()) p.rej(new Error("Chrome closed"));
    pending.clear();
  });
  const send = (method, params = {}) =>
    new Promise((res, rej) => {
      const n = ++id;
      pending.set(n, { res, rej });
      ws.send(JSON.stringify({ id: n, method, params }));
    });
  const on = (method, fn) => listeners.set(method, [...(listeners.get(method) ?? []), fn]);
  const once = (method, ms) =>
    new Promise((res) => {
      let done = false;
      const t = setTimeout(() => !done && ((done = true), res(null)), ms);
      on(method, (p) => {
        if (done) return;
        done = true;
        clearTimeout(t);
        res(p ?? {});
      });
    });
  // Evaluate in the page; a promise is waited for, an exception is thrown here with the page's own message
  const ev = async (expression) => {
    const r = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description?.split("\n")[0] ?? r.exceptionDetails.text ?? "An error on the page");
    return r.result?.value;
  };
  await send("Page.enable");
  await send("Runtime.enable");
  await send("Emulation.setDeviceMetricsOverride", { width, height, deviceScaleFactor: scale, mobile: false });
  const shot = async (format = "jpeg", quality = 95) => {
    const r = await send("Page.captureScreenshot", format === "png" ? { format: "png", optimizeForSpeed: true } : { format: "jpeg", quality, optimizeForSpeed: true });
    return Buffer.from(r.data, "base64");
  };
  return { send, on, once, ev, shot, close, chrome };
}
