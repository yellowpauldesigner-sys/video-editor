// The stage: draws one frame of a clip on a canvas. The preview and the export both use this class, so the file
// that comes out holds exactly what the editor showed.
//
//   const stage = new Stage(canvas)
//   stage.load(clip, { format, urls })   urls: media path → object URL
//   await stage.seek(t)                  the true frame at t (waits for videos and pictures)
//   stage.tick(t)                        the same while playing: videos run by themselves and are kept in step
//   stage.hit(x, y), stage.rect(id)      what is where, in frame pixels

import { countValue, ease, frameSize, isMoving, layerSource, layerSpan, lerp, resolveLayer, sceneAt, sceneDuration, totalDuration } from "./model.mjs";

let fontsKey = "";
// Fonts the clip names: Google Fonts by family, or a file of the clip
export async function loadFonts(clip, urls) {
  const list = clip.fonts ?? [];
  const key = JSON.stringify([list, list.map((f) => (typeof f === "object" ? urls[f.src] : ""))]);
  if (key !== fontsKey) {
    fontsKey = key;
    document.querySelectorAll("link[data-clip-font]").forEach((n) => n.remove());
    const google = list.filter((f) => typeof f === "string" && f.trim());
    if (google.length) {
      const link = document.createElement("link");
      link.rel = "stylesheet";
      link.dataset.clipFont = "";
      link.href = `https://fonts.googleapis.com/css2?${google.map((f) => `family=${encodeURIComponent(f).replace(/%20/g, "+")}:wght@400;500;600;700`).join("&")}&display=swap`;
      document.head.append(link);
      await new Promise((r) => ((link.onload = r), (link.onerror = r), setTimeout(r, 4000)));
    }
    for (const f of list)
      if (f && typeof f === "object" && urls[f.src]) {
        try {
          document.fonts.add(await new FontFace(f.family, `url(${urls[f.src]})`, { weight: "100 900" }).load());
        } catch {
          /* a font file that doesn't load: the fallback is drawn */
        }
      }
  }
  // Canvas text needs each face loaded before it is drawn, or the first frames come out in the fallback
  const wanted = new Set();
  for (const s of clip.scenes) for (const l of s.layers) if (l.kind === "text") wanted.add(`${l.weight ?? 500} 32px "${l.font ?? "Instrument Sans"}"`);
  await Promise.all([...wanted].map((w) => document.fonts.load(w).catch(() => {})));
}

export class Stage {
  constructor(canvas, { silent = false } = {}) {
    this.canvas = canvas;
    this.ctx = canvas.getContext("2d");
    this.silent = silent; // the export's own stage never makes a sound
    this.clip = null;
    this.format = "16:9";
    this.size = frameSize(this.format);
    this.unit = 1;
    this.urls = {};
    this.media = new Map(); // "<layer id>|<file>" → element
    this.sounds = new Map();
    this.rects = []; // what was drawn last, bottom to top: { id, x, y, w, h }
    this.muted = false;
    this.scratch = null;
    this.onMediaReady = null;
  }

  load(clip, { format, urls } = {}) {
    this.clip = clip;
    this.format = format ?? this.format;
    this.urls = urls ?? this.urls;
    this.size = frameSize(this.format);
    this.unit = Math.min(this.size.width, this.size.height) / 1080;
    if (this.canvas.width !== this.size.width || this.canvas.height !== this.size.height) {
      this.canvas.width = this.size.width;
      this.canvas.height = this.size.height;
    }
    const used = new Set();
    for (const scene of clip.scenes)
      for (const layer of scene.layers) {
        const src = layerSource(layer);
        const url = src && this.urls[src];
        if (!url || (layer.kind !== "image" && !isMoving(layer))) continue;
        const key = `${layer.id}|${url}`;
        used.add(key);
        if (this.media.has(key)) continue;
        let el;
        if (layer.kind === "image") {
          el = new Image();
          el.src = url;
          el.decode?.().then(() => this.onMediaReady?.()).catch(() => {});
        } else {
          el = document.createElement("video");
          el.preload = "auto";
          el.playsInline = true;
          el.muted = true;
          el.src = url;
          el.addEventListener("loadeddata", () => this.onMediaReady?.(), { once: true });
        }
        this.media.set(key, el);
      }
    for (const [key, el] of this.media)
      if (!used.has(key)) {
        if (el.tagName === "VIDEO") {
          el.pause();
          el.removeAttribute("src");
          el.load();
        }
        this.media.delete(key);
      }
    const keep = new Set();
    if (!this.silent)
      for (const a of clip.audio ?? []) {
        const url = this.urls[a.src];
        if (!url) continue;
        const key = `${a.id}|${url}`;
        keep.add(key);
        if (!this.sounds.has(key)) {
          const el = new Audio(url);
          el.preload = "auto";
          this.sounds.set(key, el);
        }
      }
    for (const [key, el] of this.sounds)
      if (!keep.has(key)) {
        el.pause();
        this.sounds.delete(key);
      }
  }

  element(layer) {
    const src = layerSource(layer);
    return src ? this.media.get(`${layer.id}|${this.urls[src]}`) : null;
  }

  motion(type, k, o) {
    if (!k || !type || type === "none") return;
    o.opacity *= 1 - k;
    if (type === "up") o.ty += k * 0.08 * this.size.height;
    else if (type === "down") o.ty -= k * 0.08 * this.size.height;
    else if (type === "left") o.tx += k * 0.08 * this.size.width;
    else if (type === "right") o.tx -= k * 0.08 * this.size.width;
    else if (type === "scale") o.scale *= 1 - 0.12 * k;
    else if (type === "blur") o.blur += k * 24 * this.unit;
    else if (type === "grow-x" || type === "grow-y") {
      // a bar that grows, a line that draws itself: the layer is uncovered from its left edge or from its foot
      o.opacity /= 1 - k || 1;
      o.reveal = { axis: type === "grow-x" ? "x" : "y", k: 1 - k };
    }
  }

  // Text that comes in piece by piece: each line, word or letter with its own delay
  drawTextUnits(ctx, lines, L, at, size, lh, bw, bh, align) {
    const a = L.animate;
    const type = a.type ?? "up";
    const d = a.duration ?? 0.5;
    const stagger = a.stagger ?? (a.by === "letter" ? 0.03 : a.by === "word" ? 0.08 : 0.14);
    const baseAlpha = ctx.globalAlpha;
    ctx.textAlign = "left";
    let index = 0;
    lines.forEach((line, i) => {
      const width = ctx.measureText(line).width;
      const x0 = align === "left" ? -bw / 2 : align === "right" ? bw / 2 - width : -width / 2;
      const y = -bh / 2 + i * lh + lh / 2 + size * 0.35;
      const units = a.by === "line" ? [line] : a.by === "word" ? line.split(/(\s+)/) : Array.from(line);
      let before = "";
      for (const unit of units) {
        if (!unit.trim()) {
          before += unit;
          continue;
        }
        const k = 1 - ease(a.ease ?? "expoOut", (at - index * stagger) / d); // how much of this piece is still hidden
        index++;
        const x = x0 + ctx.measureText(before).width;
        before += unit;
        if (k >= 0.999) continue;
        ctx.save();
        ctx.globalAlpha = baseAlpha * (1 - k);
        if (type === "blur" && k > 0.01) ctx.filter = `blur(${(k * size * 0.25).toFixed(2)}px)`;
        if (type === "scale") {
          const w = ctx.measureText(unit).width;
          ctx.translate(x + w / 2, y - size * 0.3);
          ctx.scale(1 - 0.4 * k, 1 - 0.4 * k);
          ctx.translate(-(x + w / 2), -(y - size * 0.3));
        }
        ctx.fillText(unit, x, y + (type === "up" ? k * size * 0.6 : type === "down" ? -k * size * 0.6 : 0));
        ctx.restore();
      }
    });
  }

  // Break a text into the lines it is drawn as
  lines(ctx, text, maxWidth) {
    const out = [];
    for (const para of String(text ?? "").split("\n")) {
      const words = para.split(/(\s+)/);
      let line = "";
      for (const w of words) {
        const next = line + w;
        if (line.trim() && ctx.measureText(next.trimEnd()).width > maxWidth) {
          out.push(line.trimEnd());
          line = w.trim() ? w : "";
        } else line = next;
      }
      out.push(line.trimEnd());
    }
    return out;
  }

  drawScene(ctx, scene, lt, playing, held, waits) {
    const { width: W, height: H } = this.size;
    ctx.fillStyle = scene.background ?? this.clip.background ?? "#000";
    ctx.fillRect(0, 0, W, H);
    const total = sceneDuration(scene);
    for (const raw of scene.layers) {
      const L = resolveLayer(raw, this.format);
      const span = layerSpan(L, scene);
      const el = this.element(raw);
      const on = !L.hidden && lt >= span.start - 1e-6 && (lt < span.end - 1e-6 || (held && span.end >= total - 1e-3) || (!held && lt >= total - 1e-6 && span.end >= total - 1e-3));
      if (!on) {
        if (el?.tagName === "VIDEO" && !el.paused) el.pause();
        continue;
      }
      const at = lt - span.start;
      const o = { tx: 0, ty: 0, scale: L.scale ?? 1, opacity: L.opacity ?? 1, blur: 0 };
      let x = L.x ?? 0;
      let y = L.y ?? 0;
      if (L.move) {
        const p = ease(L.move.ease ?? "inOut", at / span.duration);
        const f = L.move.from ?? {};
        const t = L.move.to ?? {};
        x += lerp(f.x ?? 0, t.x ?? 0, p);
        y += lerp(f.y ?? 0, t.y ?? 0, p);
        o.scale *= lerp(f.scale ?? 1, t.scale ?? 1, p);
      }
      if (L.enter?.type && L.enter.type !== "none") {
        const d = L.enter.duration ?? 0.5;
        if (d > 0 && at < d) this.motion(L.enter.type, 1 - ease(L.enter.ease ?? "out", at / d), o);
      }
      if (L.exit?.type && L.exit.type !== "none" && !held) {
        const d = L.exit.duration ?? 0.4;
        const left = span.duration - at;
        if (d > 0 && left < d) this.motion(L.exit.type, ease(L.exit.ease ?? "in", 1 - left / d), o);
      }
      const cx = ((50 + x) / 100) * W + o.tx;
      const cy = ((50 + y) / 100) * H + o.ty;
      let bw;
      let bh;
      ctx.save();
      ctx.translate(cx, cy);
      if (L.rotate) ctx.rotate((L.rotate * Math.PI) / 180);
      ctx.scale(o.scale, o.scale);
      ctx.globalAlpha = Math.max(0, Math.min(1, o.opacity));
      if (o.blur > 0.05) ctx.filter = `blur(${o.blur.toFixed(2)}px)`;

      if (L.kind === "text") {
        const size = (L.size ?? 64) * this.unit;
        ctx.font = `${L.weight ?? 500} ${size}px "${L.font ?? "Instrument Sans"}", "Instrument Sans", system-ui, sans-serif`;
        ctx.letterSpacing = `${(L.letterSpacing ?? -0.02) * size}px`;
        ctx.fillStyle = L.color ?? "#fff";
        ctx.textBaseline = "alphabetic";
        bw = ((L.maxWidth ?? 84) / 100) * W;
        let text = String(L.text ?? "");
        if (L.count) text = text.replace("{n}", countValue(L.count, at, span.duration));
        if (L.uppercase) text = text.toUpperCase();
        const lines = this.lines(ctx, text, bw);
        const lh = size * (L.lineHeight ?? 1.05);
        bh = lines.length * lh;
        const align = L.align ?? "center";
        ctx.textAlign = align;
        const ax = align === "left" ? -bw / 2 : align === "right" ? bw / 2 : 0;
        if (o.reveal) {
          ctx.beginPath();
          if (o.reveal.axis === "x") ctx.rect(-bw / 2, -bh / 2 - size, bw * o.reveal.k, bh + size * 2);
          else ctx.rect(-bw / 2, bh / 2 + size - (bh + size * 2) * o.reveal.k, bw, (bh + size * 2) * o.reveal.k);
          ctx.clip();
        }
        if (L.animate && !held) this.drawTextUnits(ctx, lines, L, at, size, lh, bw, bh, align);
        else lines.forEach((line, i) => ctx.fillText(line, ax, -bh / 2 + i * lh + lh / 2 + size * 0.35));
        // the box a person grabs is the words themselves, not the whole column they may wrap in
        const widest = Math.max(1, ...lines.map((l) => ctx.measureText(l).width));
        this.note(raw.id, ctx, align === "left" ? -bw / 2 : align === "right" ? bw / 2 - widest : -widest / 2, -bh / 2, widest, bh);
      } else {
        bw = ((L.box?.w ?? 100) / 100) * W;
        bh = ((L.box?.h ?? 100) / 100) * H;
        const r = Math.min((L.radius ?? 0) * this.unit, bw / 2, bh / 2);
        if (o.reveal) {
          ctx.beginPath();
          if (o.reveal.axis === "x") ctx.rect(-bw / 2, -bh / 2, bw * o.reveal.k, bh);
          else ctx.rect(-bw / 2, bh / 2 - bh * o.reveal.k, bw, bh * o.reveal.k);
          ctx.clip();
        }
        ctx.beginPath();
        if (L.kind === "shape" && L.shape === "ellipse") ctx.ellipse(0, 0, bw / 2, bh / 2, 0, 0, Math.PI * 2);
        else if (r > 0) ctx.roundRect(-bw / 2, -bh / 2, bw, bh, r);
        else ctx.rect(-bw / 2, -bh / 2, bw, bh);
        if (L.kind === "shape") {
          ctx.fillStyle = L.fill ?? "#7548d9";
          ctx.fill();
        } else if (!el) {
          // a file that isn't here (or a site layer from the desktop studio that was never recorded)
          ctx.fillStyle = "#1a1a1a";
          ctx.fill();
          ctx.fillStyle = "#a6a6ab";
          ctx.font = `500 ${28 * this.unit}px "Instrument Sans", system-ui, sans-serif`;
          ctx.textAlign = "center";
          ctx.fillText(L.kind === "site" ? "Site not recorded" : "File missing from the clip", 0, 0);
        } else {
          ctx.clip();
          const isVideo = el.tagName === "VIDEO";
          if (isVideo) this.syncVideo(el, L, at, playing && !held, waits);
          else if (!el.complete) waits.push(el.decode().catch(() => {}));
          const mw = isVideo ? el.videoWidth : el.naturalWidth;
          const mh = isVideo ? el.videoHeight : el.naturalHeight;
          if (mw && mh && (!isVideo || el.readyState >= 2)) {
            const fit = L.fit ?? "cover";
            const k = fit === "contain" ? Math.min(bw / mw, bh / mh) : Math.max(bw / mw, bh / mh);
            const dw = mw * k;
            const dh = mh * k;
            const fx = (L.focus?.x ?? 50) / 100;
            const fy = (L.focus?.y ?? 50) / 100;
            ctx.drawImage(el, -bw / 2 + (bw - dw) * fx, -bh / 2 + (bh - dh) * fy, dw, dh);
          }
        }
        this.note(raw.id, ctx, -bw / 2, -bh / 2, bw, bh);
      }
      ctx.restore();
    }
  }

  // Remember where a layer was drawn (its box through the current transform), for picking and the outline
  note(id, ctx, x, y, w, h) {
    const m = ctx.getTransform();
    const pts = [[x, y], [x + w, y], [x, y + h], [x + w, y + h]].map(([px, py]) => [m.a * px + m.c * py + m.e, m.b * px + m.d * py + m.f]);
    const xs = pts.map((p) => p[0]);
    const ys = pts.map((p) => p[1]);
    this.rects.push({ id, x: Math.min(...xs), y: Math.min(...ys), width: Math.max(...xs) - Math.min(...xs), height: Math.max(...ys) - Math.min(...ys) });
  }

  syncVideo(el, L, at, playing, waits) {
    const speed = L.speed ?? 1;
    let want = (L.trim?.in ?? 0) + at * speed;
    if (Number.isFinite(el.duration) && el.duration > 0) want = Math.min(want, Math.max(0, el.duration - 0.001));
    const volume = this.silent || this.muted ? 0 : Math.min(1, L.volume ?? 0);
    el.muted = !(volume > 0);
    if (volume > 0) el.volume = volume;
    if (playing) {
      if (el.playbackRate !== speed) el.playbackRate = speed;
      if (Math.abs(el.currentTime - want) > 0.3) el.currentTime = want;
      if (el.paused && !el.ended) el.play().catch(() => {});
      return;
    }
    if (!el.paused) el.pause();
    if (el.error) return;
    const settle = (resolve) => {
      const done = () => {
        el.removeEventListener("seeked", done);
        el.removeEventListener("error", done);
        resolve();
      };
      el.addEventListener("seeked", done);
      el.addEventListener("error", done);
      setTimeout(done, 5000);
    };
    if (el.readyState < 1) {
      waits.push(
        new Promise((resolve) => {
          el.addEventListener("loadedmetadata", () => { settle(resolve); el.currentTime = Math.max(want, 0.0001); }, { once: true });
          el.addEventListener("error", resolve, { once: true });
          setTimeout(resolve, 8000);
        }),
      );
    } else if (Math.abs(el.currentTime - want) > 0.0005) {
      waits.push(new Promise((resolve) => { settle(resolve); el.currentTime = want; }));
    } else if (el.seeking) {
      waits.push(new Promise(settle));
    } else if (el.readyState < 2) {
      waits.push(new Promise((resolve) => { el.addEventListener("loadeddata", resolve, { once: true }); setTimeout(resolve, 5000); }));
    }
  }

  draw(t, playing) {
    const clip = this.clip;
    const waits = [];
    if (!clip) return waits;
    const { width: W, height: H } = this.size;
    const ctx = this.ctx;
    const total = totalDuration(clip);
    t = Math.max(0, Math.min(t, total));
    const now = sceneAt(clip, Math.min(t, total - 1e-6));
    const local = t - now.start;
    const tr = now.index > 0 ? now.scene.transition : null;
    const td = tr && tr.type !== "cut" ? Math.min(tr.duration ?? 0.5, sceneDuration(now.scene)) : 0;
    const under = td > 0 && local < td ? clip.scenes[now.index - 1] : null;
    // videos of scenes that aren't on screen stop
    for (const scene of clip.scenes)
      if (scene !== now.scene && scene !== under)
        for (const layer of scene.layers) {
          const el = this.element(layer);
          if (el?.tagName === "VIDEO" && !el.paused) el.pause();
        }
    this.rects = [];
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.globalAlpha = 1;
    ctx.filter = "none";
    ctx.fillStyle = clip.background ?? "#000";
    ctx.fillRect(0, 0, W, H);
    if (!under) {
      this.drawScene(ctx, now.scene, local, playing, false, waits);
    } else {
      const k = ease("inOut", local / td); // how far the new scene has come in
      // the scene on its way out, then the new one over it, drawn apart so it fades or slides as one picture
      ctx.save();
      if (tr.type === "slide-left") ctx.translate(-k * W, 0);
      if (tr.type === "slide-up") ctx.translate(0, -k * H);
      this.drawScene(ctx, under, sceneDuration(under) + local, playing, true, waits);
      ctx.restore();
      this.rects = [];
      if (!this.scratch || this.scratch.width !== W || this.scratch.height !== H) this.scratch = Object.assign(document.createElement("canvas"), { width: W, height: H });
      const sctx = this.scratch.getContext("2d");
      sctx.setTransform(1, 0, 0, 1, 0, 0);
      this.drawScene(sctx, now.scene, local, playing, false, waits);
      ctx.save();
      if (tr.type === "fade") ctx.globalAlpha = k;
      else if (tr.type === "slide-left") ctx.translate((1 - k) * W, 0);
      else if (tr.type === "slide-up") ctx.translate(0, (1 - k) * H);
      else if (tr.type === "zoom") {
        ctx.globalAlpha = k;
        const s = 1 + 0.18 * (1 - k);
        ctx.translate(W / 2, H / 2);
        ctx.scale(s, s);
        ctx.translate(-W / 2, -H / 2);
      } else if (tr.type === "wipe") {
        ctx.beginPath();
        ctx.rect(0, 0, W * k, H);
        ctx.clip();
      }
      ctx.drawImage(this.scratch, 0, 0);
      ctx.restore();
    }
    for (const a of clip.audio ?? []) {
      const el = this.sounds.get(`${a.id}|${this.urls[a.src]}`);
      if (!el) continue;
      const start = a.start ?? 0;
      const len = a.duration ?? Math.max(0, total - start);
      const at = t - start;
      if (!playing || this.muted || at < 0 || at >= len || t >= total) {
        if (!el.paused) el.pause();
        continue;
      }
      let v = a.volume ?? 1;
      if (a.fadeIn && at < a.fadeIn) v *= at / a.fadeIn;
      if (a.fadeOut && len - at < a.fadeOut) v *= Math.max(0, (len - at) / a.fadeOut);
      el.volume = Math.max(0, Math.min(1, v));
      const want = (a.trimIn ?? 0) + at;
      if (Math.abs(el.currentTime - want) > 0.35) el.currentTime = want;
      if (el.paused) el.play().catch(() => {});
    }
    return waits;
  }

  async seek(t) {
    let waits = this.draw(t, false);
    if (waits.length) {
      await Promise.all(waits);
      waits = this.draw(t, false); // now with the frames that were waited for
      if (waits.length) await Promise.all(waits);
    }
    return true;
  }
  tick(t) {
    this.draw(t, true);
  }
  stop() {
    for (const el of this.media.values()) if (el.tagName === "VIDEO" && !el.paused) el.pause();
    for (const el of this.sounds.values()) el.pause();
  }
  setMuted(m) {
    this.muted = !!m;
    if (m) for (const el of this.sounds.values()) el.pause();
  }
  hit(x, y) {
    for (let i = this.rects.length - 1; i >= 0; i--) {
      const r = this.rects[i];
      if (x >= r.x && x <= r.x + r.width && y >= r.y && y <= r.y + r.height) return r.id;
    }
    return null;
  }
  rect(id) {
    return this.rects.findLast((r) => r.id === id) ?? null;
  }
  dispose() {
    this.stop();
    for (const el of this.media.values())
      if (el.tagName === "VIDEO") {
        el.removeAttribute("src");
        el.load();
      }
    this.media.clear();
    this.sounds.clear();
  }
}
