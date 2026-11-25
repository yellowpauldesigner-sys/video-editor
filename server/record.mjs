// Recording a live site as a video, frame by frame. The page's own clock is taken over: time moves only when the
// recorder says so, one frame's worth at a time, and a picture is taken after each step. So the result is even
// (every frame is there, at any frame rate) however heavy the page is and however slow the computer: a WebGL scene
// that runs at 20 frames a second on screen still records as a smooth 60.
//
// What follows the recorder's clock: requestAnimationFrame, performance.now, Date, setTimeout and setInterval,
// CSS animations and transitions, and videos on the page. What a script draws from those (three.js, GSAP, Lenis)
// follows with them.

import { mkdirSync, renameSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { actionsDuration, ease, lerp } from "../app/js/model.mjs";
import { openTab, sleep } from "./cdp.mjs";
import { encoder } from "./encode.mjs";

// Runs in the page before any of its own scripts
const CLOCK = `(() => {
  if (window.__rec) return;
  const perf = performance;
  const realNow = perf.now.bind(perf);
  const RealDate = Date;
  const realRAF = window.requestAnimationFrame.bind(window);
  const realST = window.setTimeout.bind(window), realCT = window.clearTimeout.bind(window);
  const realSI = window.setInterval.bind(window), realCI = window.clearInterval.bind(window);
  let stepped = false, vnow = 0;
  const epoch = RealDate.now() - realNow();
  const now = () => (stepped ? vnow : realNow());
  perf.now = now;
  window.Date = new Proxy(RealDate, {
    construct: (T, a) => (a.length ? new T(...a) : new T(epoch + now())),
    apply: (T) => new T(epoch + now()).toString(),
    get: (T, k) => (k === "now" ? () => Math.round(epoch + now()) : Reflect.get(T, k)),
  });
  let rafId = 0, rafQ = new Map(), pumping = false;
  const runRaf = (ts) => { const q = rafQ; rafQ = new Map(); for (const cb of q.values()) { try { cb(ts); } catch (e) { console.error(e); } } };
  const pump = () => { if (pumping) return; pumping = true; realRAF(() => { pumping = false; if (!stepped) runRaf(realNow()); }); };
  window.requestAnimationFrame = (cb) => { const id = ++rafId; rafQ.set(id, cb); if (!stepped) pump(); return id; };
  window.cancelAnimationFrame = (id) => { rafQ.delete(id); };
  let tid = 0; const timers = new Map();
  const fn = (cb) => (typeof cb === "function" ? cb : () => (0, eval)(String(cb)));
  window.setTimeout = (cb, ms, ...args) => {
    const id = ++tid, f = fn(cb), d = Math.max(0, +ms || 0), t = { f, args, at: now() + d, every: null };
    timers.set(id, t);
    if (!stepped) t.real = realST(() => { if (stepped || !timers.has(id)) return; timers.delete(id); f(...args); }, d);
    return id;
  };
  window.setInterval = (cb, ms, ...args) => {
    const id = ++tid, f = fn(cb), d = Math.max(1, +ms || 0), t = { f, args, at: now() + d, every: d };
    timers.set(id, t);
    if (!stepped) t.real = realSI(() => { if (stepped || !timers.has(id)) return; t.at = now() + d; f(...args); }, d);
    return id;
  };
  window.clearTimeout = window.clearInterval = (id) => { const t = timers.get(id); if (!t) return; timers.delete(id); if (t.real != null) (t.every ? realCI : realCT)(t.real); };
  const anims = new WeakMap(); let vids = [];
  const syncAnims = (dt) => {
    for (const a of document.getAnimations()) {
      let s = anims.get(a);
      if (!s) {
        if (a.playState !== "running") continue; // one the page paused itself stays as the page has it
        s = { t: Number(a.currentTime) || 0, rate: a.playbackRate || 1 };
        anims.set(a, s);
        try { a.pause(); } catch {}
      }
      if (!dt) continue;
      s.t += dt * s.rate;
      try {
        const end = a.effect?.getComputedTiming?.().endTime;
        if (Number.isFinite(end) && s.t >= end) { a.finish(); anims.delete(a); } else a.currentTime = s.t;
      } catch {}
    }
  };
  const cursor = { el: null };
  window.__rec = {
    begin() {
      if (stepped) return;
      vnow = realNow(); stepped = true;
      vids = [...document.querySelectorAll("video")].filter((v) => !v.paused && !v.ended);
      for (const v of vids) v.pause();
      syncAnims(0);
    },
    // One frame: place the scroll, move time on by dt, run what was due
    frame(dt, scroll) {
      if (scroll) {
        const box = scroll.box ? document.querySelector(scroll.box) : null;
        if (box) box.scrollTo({ top: scroll.y, behavior: "instant" }); else window.scrollTo({ top: scroll.y, behavior: "instant" });
      }
      vnow += dt;
      for (let guard = 0; guard < 2000; guard++) {
        let next = null, nid = 0;
        for (const [id, t] of timers) if (t.at <= vnow && (!next || t.at < next.at)) { next = t; nid = id; }
        if (!next) break;
        if (next.every != null) next.at += next.every; else timers.delete(nid);
        try { next.f(...next.args); } catch (e) { console.error(e); }
      }
      syncAnims(dt);
      runRaf(vnow);
      syncAnims(0);
      const waits = [];
      for (const v of vids) {
        let t = v.currentTime + dt / 1000;
        if (Number.isFinite(v.duration) && t >= v.duration) t = v.loop ? t % v.duration : v.duration;
        v.currentTime = t;
        waits.push(new Promise((r) => { v.addEventListener("seeked", r, { once: true }); realST(r, 400); }));
      }
      return waits.length ? Promise.all(waits).then(() => true) : true;
    },
    scrollY: (box) => { const b = box ? document.querySelector(box) : null; return b ? b.scrollTop : window.scrollY; },
    scrollMax: (box) => { const b = box ? document.querySelector(box) : document.scrollingElement; return Math.max(0, b.scrollHeight - (box ? b.clientHeight : window.innerHeight)); },
    top(sel, box) {
      const el = document.querySelector(sel); if (!el) return null;
      const b = box ? document.querySelector(box) : null;
      return el.getBoundingClientRect().top + (b ? b.scrollTop - b.getBoundingClientRect().top : window.scrollY);
    },
    center(sel) { const el = document.querySelector(sel); if (!el) return null; const r = el.getBoundingClientRect(); return [r.left + r.width / 2, r.top + r.height / 2]; },
    cursor(x, y, down) {
      if (!cursor.el) {
        const el = document.createElement("div");
        el.style.cssText = "position:fixed;left:0;top:0;z-index:2147483647;pointer-events:none;width:28px;height:28px;margin:-3px 0 0 -5px;transition:none";
        el.innerHTML = '<svg viewBox="0 0 28 28" width="28" height="28"><path d="M6 3l15 13-7 1 4 8-3 1.5-4-8-5 5z" fill="#fff" stroke="#000" stroke-width="1.6" stroke-linejoin="round"/></svg>';
        document.documentElement.append(el); cursor.el = el;
      }
      cursor.el.style.transform = "translate(" + x + "px," + y + "px) scale(" + (down ? 0.86 : 1) + ")";
    },
  };
})();`;

// Record a site layer into a video file. Returns { duration, frames }.
export async function recordSite(layer, fps, outFile, job) {
  const vp = { width: 1920, height: 1080, ...(layer.viewport ?? {}) };
  const scale = vp.scale ?? (vp.width < 800 ? 2 : 1);
  const actions = layer.actions?.length ? layer.actions : [{ do: "wait", for: 4 }];
  const total = actionsDuration(actions);
  if (total <= 0) throw new Error("У сценария записи нулевая длительность: добавьте действиям время (for).");
  const frames = Math.round(total * fps);
  mkdirSync(dirname(outFile), { recursive: true });
  const tmp = join(dirname(outFile), `.recording-${process.pid}.mp4`);
  const tab = await openTab({ width: vp.width, height: vp.height, scale });
  const enc = encoder(tmp, { fps, crf: 14, gop: Math.round(fps / 2) }); // many keyframes: the editor jumps around in it
  job.onStop = () => {
    enc.kill();
    tab.close();
  };
  let frame = 0;
  try {
    await tab.send("Page.addScriptToEvaluateOnNewDocument", { source: CLOCK });
    job.progress(0, "Открываю сайт…");
    const loaded = tab.once("Page.loadEventFired", 45_000);
    const nav = await tab.send("Page.navigate", { url: layer.url });
    if (nav.errorText) throw new Error(`Сайт не открылся (${layer.url}): ${nav.errorText}. Если это локальный сайт, запустите его сервер.`);
    if (!(await loaded)) throw new Error(`Сайт не загрузился за 45 секунд: ${layer.url}`);
    await sleep(Math.round((layer.settle ?? 1.5) * 1000)); // fonts, pictures, the first WebGL frames, in real time
    if (!(await tab.ev("!!window.__rec"))) throw new Error("Не удалось взять время страницы под управление (страница перезагрузилась во время записи).");
    await tab.ev("window.__rec.begin()");
    const dt = 1000 / fps;
    const box = layer.scrollIn ? JSON.stringify(layer.scrollIn) : "undefined";
    let mouse = [Math.round(vp.width / 2), Math.round(vp.height / 2)];
    const began = Date.now();
    const shoot = async (scroll) => {
      if (job.stopped) throw new Error("Остановлено.");
      await tab.ev(`window.__rec.frame(${dt}, ${scroll == null ? "null" : JSON.stringify({ y: scroll, box: layer.scrollIn ?? null })})`);
      await enc.write(await tab.shot("jpeg", 96));
      frame++;
      if (frame % 3 === 0) {
        const left = ((Date.now() - began) / frame) * (frames - frame);
        job.progress(frame / frames, `Записываю · кадр ${frame} из ${frames}${frame > 10 ? ` · осталось ~${Math.max(1, Math.round(left / 1000))} с` : ""}`);
      }
    };
    const point = async (to) => {
      if (Array.isArray(to)) return to;
      const c = await tab.ev(`window.__rec.center(${JSON.stringify(to)})`);
      if (!c) throw new Error(`На странице нет элемента ${to} (действие сценария записи).`);
      return c;
    };
    const moveMouse = async (x, y) => {
      mouse = [x, y];
      await tab.send("Input.dispatchMouseEvent", { type: "mouseMoved", x, y });
      if (layer.cursor) await tab.ev(`window.__rec.cursor(${x.toFixed(1)}, ${y.toFixed(1)}, false)`);
    };
    for (const a of actions) {
      const n = Math.max(0, Math.round((Number(a.for) || (a.do === "click" || a.do === "key" ? 0.2 : 0)) * fps));
      if (a.do === "wait") {
        for (let i = 0; i < n; i++) await shoot(null);
      } else if (a.do === "scroll") {
        const from = await tab.ev(`window.__rec.scrollY(${box})`);
        let to;
        if (typeof a.to === "number") to = a.to;
        else if (a.to === "bottom") to = await tab.ev(`window.__rec.scrollMax(${box})`);
        else if (a.to === "top") to = 0;
        else {
          to = await tab.ev(`window.__rec.top(${JSON.stringify(a.to)}, ${box})`);
          if (to == null) throw new Error(`На странице нет элемента ${a.to} (прокрутка в сценарии записи).`);
          to = Math.max(0, to - (a.offset ?? 0));
        }
        for (let i = 1; i <= n; i++) await shoot(lerp(from, to, ease(a.ease ?? "inOut", i / n)));
        if (!n) await tab.ev(`window.__rec.frame(0, ${JSON.stringify({ y: to, box: layer.scrollIn ?? null })})`);
      } else if (a.do === "wheel") {
        // For pages that listen to the wheel and have no real scroll (a WebGL story): the same turns, spread evenly
        let done = 0;
        for (let i = 1; i <= Math.max(1, n); i++) {
          const want = a.by * ease(a.ease ?? "inOut", i / Math.max(1, n));
          await tab.send("Input.dispatchMouseEvent", { type: "mouseWheel", x: mouse[0], y: mouse[1], deltaX: 0, deltaY: want - done });
          done = want;
          if (n) await shoot(null);
        }
      } else if (a.do === "move") {
        const [tx, ty] = await point(a.to);
        const [fx, fy] = mouse;
        for (let i = 1; i <= Math.max(1, n); i++) {
          const k = ease(a.ease ?? "inOut", i / Math.max(1, n));
          await moveMouse(lerp(fx, tx, k), lerp(fy, ty, k));
          if (n) await shoot(null);
        }
      } else if (a.do === "click") {
        if (a.to != null) {
          const [tx, ty] = await point(a.to);
          await moveMouse(tx, ty);
        }
        const [x, y] = mouse;
        await tab.send("Input.dispatchMouseEvent", { type: "mousePressed", x, y, button: "left", clickCount: 1 });
        if (layer.cursor) await tab.ev(`window.__rec.cursor(${x}, ${y}, true)`);
        const half = Math.min(n, Math.max(1, Math.round(fps * 0.08)));
        for (let i = 0; i < half; i++) await shoot(null);
        await tab.send("Input.dispatchMouseEvent", { type: "mouseReleased", x, y, button: "left", clickCount: 1 });
        if (layer.cursor) await tab.ev(`window.__rec.cursor(${x}, ${y}, false)`);
        for (let i = half; i < n; i++) await shoot(null);
      } else if (a.do === "type") {
        const chars = [...a.text];
        const per = Math.max(1, Math.floor(n / Math.max(1, chars.length)));
        let used = 0;
        for (const ch of chars) {
          await tab.send("Input.insertText", { text: ch });
          for (let i = 0; i < per && used < n; i++, used++) await shoot(null);
        }
        for (; used < n; used++) await shoot(null);
      } else if (a.do === "key") {
        await tab.send("Input.dispatchKeyEvent", { type: "keyDown", key: a.key, code: a.key, windowsVirtualKeyCode: KEYS[a.key] ?? 0 });
        await tab.send("Input.dispatchKeyEvent", { type: "keyUp", key: a.key, code: a.key, windowsVirtualKeyCode: KEYS[a.key] ?? 0 });
        for (let i = 0; i < n; i++) await shoot(null);
      }
    }
    while (frame < frames) await shoot(null); // rounding: the file is exactly as long as the script says
    await enc.finish();
    rmSync(outFile, { force: true });
    renameSync(tmp, outFile);
  } catch (err) {
    enc.kill();
    rmSync(tmp, { force: true });
    throw err;
  } finally {
    job.onStop = null;
    tab.close();
  }
  return { duration: frame / fps, frames: frame, width: vp.width * scale, height: vp.height * scale };
}

const KEYS = { Enter: 13, Escape: 27, Tab: 9, Backspace: 8, ArrowLeft: 37, ArrowUp: 38, ArrowRight: 39, ArrowDown: 40, " ": 32, Space: 32, PageDown: 34, PageUp: 33, Home: 36, End: 35 };
