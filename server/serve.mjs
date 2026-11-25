#!/usr/bin/env node
// uberdesigner clips: the local server. It serves the editor and the project's media, and is the only thing that
// writes clip.json. The editor's page draws the frames and builds the video itself, so the server needs nothing but
// Node. Run it from anywhere:
//
//   node server/serve.mjs <project folder> [--port 5320]
//
// It listens on this computer only (127.0.0.1). Reads are open to its own pages; every change needs the project's
// token, which only the editor page is given.

import { spawn } from "node:child_process";
import { createReadStream, createWriteStream, existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, unwatchFile, watchFile } from "node:fs";
import { createServer } from "node:http";
import { dirname, extname, join, resolve, sep } from "node:path";
import { pipeline } from "node:stream/promises";
import { fileURLToPath } from "node:url";
import { FORMATS, findLayer, findScene, mediaUsed, siteKey } from "../app/js/model.mjs";
import { askClaude, buildPrompt, clipSystem, MODELS, sceneSystem } from "./claude.mjs";
import { freeMediaName, kindOf, listHistory, listMedia, makePlayable, mediaFile, openProject, probe, problems, readCards, readClip, readSettings, safeName, versionClip, withWriteLock, writeCards, writeClip, writeMediaInfo, writeSettings } from "./project.mjs";
import { recordSite } from "./record.mjs";
import { toolStatus } from "./tools.mjs";

const APP = resolve(dirname(fileURLToPath(import.meta.url)), "..", "app");
const TYPES = {
  ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".mjs": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml", ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".webp": "image/webp", ".avif": "image/avif", ".gif": "image/gif",
  ".mp4": "video/mp4", ".m4v": "video/mp4", ".mov": "video/quicktime", ".webm": "video/webm", ".mkv": "video/x-matroska",
  ".mp3": "audio/mpeg", ".wav": "audio/wav", ".m4a": "audio/mp4", ".aac": "audio/aac", ".ogg": "audio/ogg", ".flac": "audio/flac",
  ".woff2": "font/woff2", ".woff": "font/woff", ".ttf": "font/ttf", ".otf": "font/otf",
};

export async function start(projectDir, { port = 5320, quiet = false } = {}) {
  const p = openProject(projectDir);
  let rev = 0; // anything the editor shows changed
  let clipRev = 0; // clip.json changed
  let lastWritten = existsSync(p.clipFile) ? readFileSync(p.clipFile, "utf8") : "";
  const jobs = []; // { id, kind, label, state, progress, note, result, error, cardId, stopped, onStop }
  let jobId = 0;
  let origin = "";
  const bump = () => ++rev;

  // clip.json edited by other hands (Claude Code in the chat, a text editor): the editor picks it up
  watchFile(p.clipFile, { interval: 600 }, () => {
    let text;
    try {
      text = readFileSync(p.clipFile, "utf8");
    } catch {
      return;
    }
    if (text === lastWritten) return;
    lastWritten = text;
    clipRev++;
    bump();
  });

  const save = (clip, kind, label) =>
    withWriteLock(() => {
      const entry = writeClip(p, clip, kind, label);
      lastWritten = readFileSync(p.clipFile, "utf8");
      clipRev++;
      bump();
      return entry;
    });

  function newJob(kind, label, extra = {}) {
    const job = { id: ++jobId, kind, label, state: "running", progress: 0, note: "", startedAt: Date.now(), stopped: false, onStop: null, ...extra };
    job.progressFn = (f, note) => {
      job.progress = f;
      if (note != null) job.note = note;
      bump();
    };
    jobs.push(job);
    while (jobs.length > 30) jobs.shift();
    bump();
    return job;
  }
  const finish = (job, result) => {
    job.state = "done";
    job.progress = 1;
    job.result = result;
    job.endedAt = Date.now();
    bump();
  };
  const fail = (job, err) => {
    job.state = job.stopped ? "stopped" : "failed";
    job.error = job.stopped ? "Stopped." : String(err?.message ?? err);
    job.endedAt = Date.now();
    bump();
  };
  const jobView = (j) => ({ id: j.id, kind: j.kind, label: j.label, state: j.state, progress: j.progress, note: j.note, result: j.result, error: j.error, cardId: j.cardId, layerId: j.layerId, startedAt: j.startedAt, endedAt: j.endedAt });

  // Chrome work (a recording, a render) runs one at a time
  let chromeLine = Promise.resolve();
  const inChrome = (fn) => {
    const next = chromeLine.then(fn, fn);
    chromeLine = next.catch(() => {});
    return next;
  };

  // ---------- what the API does ----------

  async function projectView() {
    const clip = readClip(p);
    const media = await listMedia(p);
    const versions = Object.fromEntries(media.map((m) => [m.path, m.mtime]));
    return { clip, media, versions, clipRev, rev, problems: problems(p, clip), tools: toolNames(), settings: readSettings(p), models: MODELS, root: p.root, formats: FORMATS };
  }
  const toolNames = () => {
    const t = toolStatus();
    return { ffmpeg: !!t.ffmpeg, chrome: !!t.chrome, claude: !!t.claude };
  };

  function startRecord(layerId) {
    const clip = readClip(p);
    const found = findLayer(clip, layerId);
    if (!found || found.layer.kind !== "site") throw new Error("Only a site layer can be recorded.");
    if (jobs.some((j) => j.kind === "record" && j.layerId === layerId && j.state === "running")) throw new Error("This layer is already being recorded.");
    const layer = found.layer;
    const job = newJob("record", `Recording: ${layer.label ?? layer.id}`, { layerId });
    const rel = `media/recordings/${layer.id}.mp4`;
    inChrome(async () => {
      try {
        if (job.stopped) throw new Error("Stopped.");
        const info = await recordSite(layer, layer.fps ?? clip.fps, join(p.root, rel), { get stopped() { return job.stopped; }, set onStop(fn) { job.onStop = fn; }, progress: job.progressFn });
        // the layer now plays its recording; the clip may have changed while it was being made
        const now = readClip(p);
        const again = findLayer(now, layerId);
        if (again) {
          again.layer.recording = rel;
          again.layer.recorded = siteKey(layer);
          delete again.layer.trim;
          await save(now, "record", `Site recorded: ${layer.label ?? layer.id}`);
        }
        finish(job, { path: rel, ...info });
      } catch (err) {
        fail(job, err);
      }
    });
    return job;
  }

  const sameJson = (a, b) => JSON.stringify(a) === JSON.stringify(b);
  const cardById = (cards, id) => cards.find((c) => c.id === id);
  function updateCard(id, fn) {
    const cards = readCards(p);
    const card = cardById(cards, id);
    if (card) fn(card);
    writeCards(p, cards);
    bump();
    return card;
  }

  async function startChange({ sceneId, layerId, request, format, cardId }) {
    request = String(request ?? "").trim();
    if (!request) throw new Error("Say what to change.");
    if (request.length > 4000) throw new Error("The request is too long (over 4000 characters).");
    const clip = readClip(p);
    if (sceneId && !findScene(clip, sceneId)) throw new Error("That scene is no longer in the clip.");
    const running = jobs.filter((j) => j.kind === "change" && j.state === "running");
    if (running.length >= 3) throw new Error("Three changes are already running. Wait for one to finish.");
    const cards = readCards(p);
    if (cards.some((c) => c.state === "running" && (c.sceneId ?? null) === (sceneId ?? null) && c.id !== cardId)) throw new Error("A change to this part is already running. Wait for it.");
    if (!sceneId && cards.some((c) => c.state === "running")) throw new Error("A whole-clip change runs alone. Wait for the others to finish.");
    let card = cardId ? cardById(cards, cardId) : null;
    if (cardId && !card) throw new Error("That card is gone.");
    if (card && (card.sceneId ?? null) !== (sceneId ?? null)) throw new Error("That card is about another part of the clip.");
    if (!card) {
      card = { id: `c${Date.now().toString(36)}`, n: (cards.reduce((m, c) => Math.max(m, c.n ?? 0), 0) || 0) + 1, sceneId: sceneId ?? null, layerId: layerId ?? null, label: sceneId ? (findScene(clip, sceneId).label ?? sceneId) : "Whole clip", tries: [], createdAt: Date.now() };
      cards.push(card);
    }
    card.state = "running";
    card.error = null;
    card.question = null;
    card.pending = request;
    writeCards(p, cards);
    const job = newJob("change", `Claude: ${card.label}`, { cardId: card.id });
    const model = readSettings(p).model;
    (async () => {
      try {
        const media = await listMedia(p);
        const scene = sceneId ? findScene(clip, sceneId) : null;
        const tries = card.tries.map((t) => ({ request: t.request, summary: t.summary, takenBack: t.takenBack }));
        const prompt = buildPrompt({ clip, scene, layerId, request, media, tries, format });
        const system = scene ? sceneSystem() : clipSystem();
        const handle = { get stopped() { return job.stopped; }, set onStop(fn) { job.onStop = fn; } };
        job.progressFn(0.1, "Claude is thinking…");
        let { answer, usage } = await askClaude(system, prompt, { model, job: handle });
        const place = (ans) => {
          // The answer in the clip as it is now: other scenes may have changed while Claude worked
          const now = readClip(p);
          if (scene) {
            if (!ans.scene || typeof ans.scene !== "object") throw new Error("The answer has no scene.");
            if (ans.scene.id !== scene.id) throw new Error(`The scene in the answer is "${ans.scene.id}", but "${scene.id}" was the one to change.`);
            const i = now.scenes.findIndex((s) => s.id === scene.id);
            if (i < 0) throw new Error("While Claude worked, this scene was removed from the clip. Nothing was changed.");
            if (!sameJson(now.scenes[i], scene)) throw new Error("While Claude worked, this scene was changed by hand. Nothing was changed: send the request again.");
            // a recording belongs to the person's Record button, never to an answer
            for (const l of ans.scene.layers ?? []) {
              const was = scene.layers.find((o) => o.id === l.id);
              if (l?.kind === "site") {
                if (was?.recording) {
                  l.recording = was.recording;
                  l.recorded = was.recorded;
                } else {
                  delete l.recording;
                  delete l.recorded;
                }
              }
            }
            now.scenes[i] = ans.scene;
            return { next: now, before: scene, after: ans.scene };
          }
          if (!ans.clip || typeof ans.clip !== "object") throw new Error("The answer has no clip.");
          if (!sameJson(now, clip)) throw new Error("While Claude worked, the clip was changed by hand. Nothing was changed: send the request again.");
          return { next: { ...ans.clip, version: 1 }, before: clip, after: { ...ans.clip, version: 1 } };
        };
        if (answer.question) {
          updateCard(card.id, (c) => {
            c.state = c.tries.length ? "ready" : "question";
            c.question = String(answer.question).slice(0, 1200);
            c.pending = null;
            c.asked = request;
          });
          return finish(job, { question: true });
        }
        job.progressFn(0.8, "Checking the answer…");
        let placed = place(answer);
        let errors = problems(p, placed.next);
        if (errors.length) {
          // one more call with what was wrong, as the studio does after a failed check
          job.progressFn(0.85, "Fixing the answer…");
          const again = await askClaude(system, `${prompt}\n\nYour last reply to this was:\n${JSON.stringify(answer)}\n\nIt can't be used, for these reasons:\n${errors.slice(0, 10).map((e) => `- ${e}`).join("\n")}\n\nReply again with the corrected JSON object only.`, { model, job: handle });
          usage = { input: usage.input + again.usage.input, output: usage.output + again.usage.output, costUsd: usage.costUsd + again.usage.costUsd, seconds: usage.seconds + again.usage.seconds };
          answer = again.answer;
          if (answer.question) throw new Error(String(answer.question));
          placed = place(answer);
          errors = problems(p, placed.next);
          if (errors.length) throw new Error(`Claude's answer didn't pass the check:\n${errors.slice(0, 5).join("\n")}`);
        }
        if (sameJson(placed.before, placed.after)) {
          updateCard(card.id, (c) => {
            c.state = c.tries.length ? "ready" : "failed";
            c.error = "Claude changed nothing. " + String(answer.summary ?? "");
            c.pending = null;
          });
          return finish(job, { unchanged: true });
        }
        const entry = await save(placed.next, "ai", `Claude · ${card.label}: ${request.slice(0, 60)}`);
        updateCard(card.id, (c) => {
          c.tries.push({ request, summary: String(answer.summary ?? "").slice(0, 800), before: placed.before, after: placed.after, at: Date.now(), usage, version: entry.id });
          c.state = "ready";
          c.pending = null;
        });
        finish(job, { card: card.id });
      } catch (err) {
        updateCard(card.id, (c) => {
          c.state = c.tries.some((t) => !t.takenBack) ? "ready" : "failed";
          c.error = job.stopped ? "Stopped. Nothing was changed." : String(err?.message ?? err);
          c.pending = null;
        });
        fail(job, err);
      }
    })();
    return { job, card };
  }

  // Put back what a card's tries changed. Refused when the same part was changed since: History is the way then.
  async function undoCard(id) {
    const cards = readCards(p);
    const card = cardById(cards, id);
    if (!card) throw new Error("That card is gone.");
    const live = card.tries.filter((t) => !t.takenBack);
    if (!live.length) throw new Error("This card has nothing to undo.");
    const first = live[0];
    const last = live.at(-1);
    const clip = readClip(p);
    let next;
    if (card.sceneId) {
      const i = clip.scenes.findIndex((s) => s.id === card.sceneId);
      if (i < 0 || !sameJson(clip.scenes[i], last.after)) throw new Error("The scene was changed again after this change, so it can't be undone by itself: go back to the moment you want in History.");
      clip.scenes[i] = first.before;
      next = clip;
    } else {
      if (!sameJson(clip, last.after)) throw new Error("The clip was changed again after this change, so it can't be undone by itself: go back to the moment you want in History.");
      next = first.before;
    }
    await save(next, "undo", `Undo: ${card.label}`);
    updateCard(id, (c) => {
      for (const t of c.tries) t.takenBack = true;
      c.state = "undone";
    });
  }

  // ---------- http ----------

  const json = (res, code, body) => {
    const text = JSON.stringify(body);
    res.writeHead(code, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
    res.end(text);
  };
  const readBody = (req, limit = 8_000_000) =>
    new Promise((res, rej) => {
      let size = 0;
      const chunks = [];
      req.on("data", (c) => {
        size += c.length;
        if (size > limit) {
          rej(new Error("The request is too large."));
          req.destroy();
        } else chunks.push(c);
      });
      req.on("end", () => {
        try {
          res(chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : {});
        } catch {
          rej(new Error("The request isn't valid JSON."));
        }
      });
      req.on("error", rej);
    });

  function sendFile(req, res, file, { cache = "no-cache" } = {}) {
    let st;
    try {
      st = statSync(file);
    } catch {
      res.writeHead(404).end("Not found");
      return;
    }
    if (!st.isFile()) return void res.writeHead(404).end("Not found");
    const type = TYPES[extname(file).toLowerCase()] ?? "application/octet-stream";
    const range = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range ?? "");
    const base = { "content-type": type, "accept-ranges": "bytes", "cache-control": cache, "x-content-type-options": "nosniff" };
    if (range && (range[1] || range[2])) {
      let from = range[1] ? Number(range[1]) : Math.max(0, st.size - Number(range[2]));
      let to = range[1] && range[2] ? Math.min(Number(range[2]), st.size - 1) : st.size - 1;
      if (from >= st.size || from > to) return void res.writeHead(416, { "content-range": `bytes */${st.size}` }).end();
      res.writeHead(206, { ...base, "content-range": `bytes ${from}-${to}/${st.size}`, "content-length": to - from + 1 });
      if (req.method === "HEAD") return void res.end();
      return void createReadStream(file, { start: from, end: to }).on("error", () => res.destroy()).pipe(res);
    }
    res.writeHead(200, { ...base, "content-length": st.size });
    if (req.method === "HEAD") return void res.end();
    createReadStream(file).on("error", () => res.destroy()).pipe(res);
  }
  const inside = (root, rel) => {
    const file = resolve(root, rel);
    return file === root || file.startsWith(root + sep) ? file : null;
  };

  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url, "http://x");
      const path = decodeURIComponent(url.pathname);
      // Only this computer's own address: a page elsewhere that points a name at 127.0.0.1 is turned away
      const host = String(req.headers.host ?? "");
      if (!/^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/.test(host)) return void res.writeHead(403).end("Forbidden");
      const write = !["GET", "HEAD"].includes(req.method);
      if (write) {
        const from = req.headers.origin;
        if (from && from !== `http://${host}`) return json(res, 403, { error: "A request from another site's page." });
        if (req.headers["x-clips-token"] !== p.token) return json(res, 403, { error: "No access: open the editor again." });
      } else if (path.startsWith("/__clips/")) {
        // reads of the project are for the studio's own pages, not for another site's script
        const site = req.headers["sec-fetch-site"];
        if (site && site !== "same-origin" && site !== "none") return json(res, 403, { error: "A request from another site's page." });
      }

      if (!write) {
        if (path === "/" || path === "/index.html" || path === "/headless.html") {
          // the page gets the project's token: that is what makes it this project's editor
          const html = readFileSync(join(APP, path === "/headless.html" ? "headless.html" : "index.html"), "utf8").replace("__CLIPS_TOKEN__", p.token);
          res.writeHead(200, { "content-type": TYPES[".html"], "cache-control": "no-store" });
          return void res.end(html);
        }
        if (/^\/(css|js|fonts)\//.test(path)) {
          const file = inside(APP, path.slice(1));
          return file ? sendFile(req, res, file) : void res.writeHead(404).end("Not found");
        }
        if (path.startsWith("/media/")) {
          const file = mediaFile(p, path.slice(1));
          return file ? sendFile(req, res, file, { cache: url.searchParams.has("v") ? "max-age=31536000, immutable" : "no-cache" }) : void res.writeHead(404).end("Not found");
        }
        if (path.startsWith("/renders/")) {
          const file = inside(p.renders, path.slice("/renders/".length));
          return file ? sendFile(req, res, file) : void res.writeHead(404).end("Not found");
        }
        if (path === "/__clips/project") return json(res, 200, await projectView());
        if (path === "/__clips/state") return json(res, 200, { rev, clipRev, jobs: jobs.map(jobView), cards: readCards(p).map(cardView), tools: toolNames() });
        if (path === "/__clips/history") return json(res, 200, { versions: listHistory(p).slice().reverse() });
        if (path === "/__clips/history/clip") {
          const clip = versionClip(p, url.searchParams.get("id"));
          return clip ? json(res, 200, { clip }) : json(res, 404, { error: "That version doesn't exist." });
        }
        return void res.writeHead(404).end("Not found");
      }

      if (path === "/__clips/project" && req.method === "PUT") {
        const body = await readBody(req);
        try {
          const entry = await save(body.clip, "edit", String(body.label ?? "Edit").slice(0, 120));
          return json(res, 200, { ok: true, clipRev, version: entry.id });
        } catch (err) {
          return json(res, 422, { error: err.message, problems: err.problems ?? [err.message] });
        }
      }
      if (path === "/__clips/media" && req.method === "POST") {
        const name = safeName(url.searchParams.get("name") ?? "file");
        if (!kindOf(name)) return json(res, 415, { error: `A clip can't use this kind of file: ${name}. It takes video, pictures, sound and fonts.` });
        const target = freeMediaName(p, name);
        try {
          await pipeline(req, createWriteStream(target.file));
        } catch (err) {
          rmSync(target.file, { force: true });
          throw err;
        }
        const path2 = await makePlayable(p, target.path);
        bump();
        const file = mediaFile(p, path2);
        return json(res, 200, { item: { path: path2, name: path2.split("/").pop(), kind: kindOf(path2), ...(await probe(file)) } });
      }
      if (path === "/__clips/renders" && req.method === "POST") {
        // a video the editor's page built: it lands in the project's renders/ folder
        const name = safeName(url.searchParams.get("name") ?? "clip.mp4");
        if (!/\.mp4$/i.test(name)) return json(res, 415, { error: "Only MP4 files are saved here." });
        mkdirSync(p.renders, { recursive: true });
        const tmp = join(p.renders, `.${process.pid}-${Date.now()}.part`);
        try {
          await pipeline(req, createWriteStream(tmp));
          renameSync(tmp, join(p.renders, name));
        } catch (err) {
          rmSync(tmp, { force: true });
          throw err;
        }
        bump();
        return json(res, 200, { name, path: `renders/${name}` });
      }
      const body = await readBody(req);
      if (path === "/__clips/media/info") {
        const file = mediaFile(p, String(body.path));
        if (!file || !existsSync(file)) return json(res, 404, { error: "That file doesn't exist." });
        writeMediaInfo(p, String(body.path), body.info, Math.round(statSync(file).mtimeMs));
        return json(res, 200, { ok: true });
      }
      if (path === "/__clips/media/remove") {
        const file = mediaFile(p, String(body.path));
        if (!file || !existsSync(file)) return json(res, 404, { error: "That file doesn't exist." });
        if (mediaUsed(readClip(p)).has(String(body.path))) return json(res, 409, { error: "That file is used in the clip." });
        rmSync(file);
        bump();
        return json(res, 200, { ok: true });
      }
      if (path === "/__clips/history/restore") {
        const clip = versionClip(p, body.id);
        if (!clip) return json(res, 404, { error: "That version doesn't exist." });
        const entry = listHistory(p).find((e) => e.id === body.id);
        await save(clip, "restore", `Back to: ${entry?.label || new Date(entry?.at ?? Date.now()).toLocaleString("en-US")}`);
        return json(res, 200, { ok: true });
      }
      if (path === "/__clips/record") return json(res, 200, { job: jobView(startRecord(String(body.layerId))) });
      if (path === "/__clips/change") {
        const { job, card } = await startChange(body);
        return json(res, 200, { job: jobView(job), card: cardView(card) });
      }
      if (path === "/__clips/cards/keep") {
        updateCard(String(body.id), (c) => c.state === "ready" && (c.state = "kept"));
        return json(res, 200, { ok: true });
      }
      if (path === "/__clips/cards/undo") {
        await undoCard(String(body.id));
        return json(res, 200, { ok: true });
      }
      if (path === "/__clips/cards/close") {
        const cards = readCards(p);
        const card = cardById(cards, String(body.id));
        if (card && (card.state === "failed" || card.state === "question")) writeCards(p, cards.filter((c) => c !== card));
        bump();
        return json(res, 200, { ok: true });
      }
      if (path === "/__clips/jobs/stop") {
        const job = jobs.find((j) => j.id === Number(body.id));
        if (job?.state === "running") {
          job.stopped = true;
          job.onStop?.();
          bump();
        }
        return json(res, 200, { ok: true });
      }
      if (path === "/__clips/settings") {
        const s = readSettings(p);
        if (MODELS.includes(body.model)) s.model = body.model;
        writeSettings(p, s);
        bump();
        return json(res, 200, { settings: s });
      }
      if (path === "/__clips/reveal") {
        // Show the renders folder (or one render) in the computer's file manager; nothing else can be opened this way
        const rel = typeof body.path === "string" && body.path.startsWith("renders/") ? body.path.slice("renders/".length) : "";
        const file = rel ? inside(p.renders, rel) : null;
        const target = file && existsSync(file) ? file : p.renders;
        const [cmd, args] = process.platform === "darwin" ? ["open", target === p.renders ? [target] : ["-R", target]] : process.platform === "win32" ? ["explorer", [target === p.renders ? target : `/select,${target}`]] : ["xdg-open", [p.renders]];
        spawn(cmd, args, { stdio: "ignore", detached: true }).on("error", () => {}).unref();
        return json(res, 200, { ok: true });
      }
      return json(res, 404, { error: "No such action." });
    } catch (err) {
      if (!res.headersSent) json(res, 400, { error: String(err?.message ?? err) });
      else res.destroy();
    }
  });

  // A card for the editor: without the before/after copies, which only the server needs
  function cardView(c) {
    return { ...c, tries: c.tries.map(({ before, after, ...t }) => t) };
  }

  let bound = port;
  for (let i = 0; ; i++) {
    try {
      await new Promise((res, rej) => {
        server.once("error", rej);
        server.listen(bound, "127.0.0.1", () => {
          server.off("error", rej);
          res();
        });
      });
      break;
    } catch (err) {
      if (err.code !== "EADDRINUSE" || i >= 20) throw err;
      bound++;
    }
  }
  origin = `http://localhost:${bound}`;
  if (!quiet) {
    const t = toolStatus();
    console.log(`uberdesigner clips · ${readClip(p).name}`);
    console.log(`  ${origin}`);
    if (!t.claude) console.log("  TELL Claude Code is not in the terminal: changes by Claude inside the editor wait for it");
  }
  return { origin, port: bound, project: p, close: () => (unwatchFile(p.clipFile), server.closeAllConnections?.(), new Promise((r) => server.close(r))), startRecord, jobs };
}

// Importing this file does nothing; it serves only when it is the command that was run
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const at = args.indexOf("--port");
  const port = at >= 0 ? Number(args[at + 1]) : 5320;
  const dir = args.find((a, i) => !a.startsWith("--") && args[i - 1] !== "--port") ?? ".";
  start(dir, { port }).catch((err) => {
    console.error(String(err?.message ?? err));
    process.exit(1);
  });
}
