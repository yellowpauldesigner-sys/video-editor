#!/usr/bin/env node
// uberdesigner clips, from the command line. Claude Code runs these while it sets a clip up; they spend no tokens.
//
//   node scripts/clips.mjs check                                 what the studio needs on this computer, and what it found
//   node scripts/clips.mjs new <folder> [--name "Clip name"] [--format 16:9] [--fps 30]
//   node scripts/clips.mjs add <project> <file> [<file>…]        copy files into media/
//   node scripts/clips.mjs verify <project>                      check clip.json and report what the clip holds
//   node scripts/clips.mjs split <project> <media/file.mp4>      find the shots of a finished video (prints where each starts)
//   node scripts/clips.mjs still <project> <seconds> [--format 9:16] [--out file.png]   one frame as a picture
//   node scripts/clips.mjs render <project> [--formats 16:9,9:16] [--quality draft|high|max]
//   node scripts/clips.mjs record <project> [<layer id>…] [--stale]   record site layers (needs ffmpeg)
//   node scripts/clips.mjs serve <project> [--port 5320]         start the editor
//
// still, split and render open the editor's own engine in a headless Chrome: the same code that draws and builds
// in the editor. Importing the server does nothing by itself, so each command starts what it needs and stops it.

import { copyFileSync, existsSync, mkdirSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { actionsDuration, blankClip, FORMATS, frameSize, isMoving, layerSource, layerSpan, sceneDuration, sceneStarts, siteKey, totalDuration } from "../app/js/model.mjs";
import { openTab } from "../server/cdp.mjs";
import { freeMediaName, kindOf, listMedia, makePlayable, mediaFile, openProject, probe, problems, readClip, safeName } from "../server/project.mjs";
import { start } from "../server/serve.mjs";
import { toolStatus } from "../server/tools.mjs";

const [cmd, ...rest] = process.argv.slice(2);
const flag = (name, fallback) => {
  const i = rest.indexOf(`--${name}`);
  return i >= 0 ? (rest[i + 1] ?? true) : fallback;
};
const VALUED = ["name", "format", "fps", "out", "formats", "quality", "port"];
const args = rest.filter((a, i) => !a.startsWith("--") && !(rest[i - 1]?.startsWith("--") && VALUED.includes(rest[i - 1].slice(2))));
const die = (msg) => {
  console.error(msg);
  process.exit(1);
};
const need = (v, what) => v ?? die(`Missing: ${what}. The commands are listed at the top of scripts/clips.mjs.`);

// The editor's engine in a headless Chrome, on a running project: fn gets the tab once the page is ready
async function headless(dir, size, fn) {
  const s = await start(dir, { port: 5340, quiet: true });
  let tab = null;
  try {
    const errs = problems(s.project, readClip(s.project));
    if (errs.length) throw new Error(`The clip has errors:\n${errs.join("\n")}`);
    tab = await openTab(size);
    const loaded = tab.once("Page.loadEventFired", 30_000);
    await tab.send("Page.navigate", { url: `${s.origin}/headless.html` });
    await loaded;
    for (let i = 0; i < 200 && !(await tab.ev("window.__headlessReady === true")); i++) await new Promise((r) => setTimeout(r, 100));
    return await fn(tab, s);
  } finally {
    tab?.close();
    await s.close();
  }
}

async function waitJob(job) {
  let last = "";
  while (job.state === "running") {
    if (job.note && job.note !== last) console.log(`  ${(last = job.note)}`);
    await new Promise((r) => setTimeout(r, 1000));
  }
  if (job.state !== "done") throw new Error(job.error ?? "that didn't work");
  return job.result;
}

// What the clip holds and what may surprise: the same checks the editor makes, and the ones only a look at the files gives
async function report(p, clip) {
  const errors = problems(p, clip);
  const warnings = [];
  const media = new Map((await listMedia(p)).map((m) => [m.path, m]));
  const starts = sceneStarts(clip);
  const fonts = new Set(["Instrument Sans", ...(clip.fonts ?? []).map((f) => (typeof f === "string" ? f : f.family))]);
  if (!errors.length) {
    clip.scenes.forEach((scene, i) => {
      if (!scene.layers.length) warnings.push(`scene "${scene.id}": it has no layers, so it is ${sceneDuration(scene)} s of empty background`);
      if (i === 0 && scene.transition) warnings.push(`scene "${scene.id}": a transition on the first scene does nothing, there is no scene before it`);
      for (const layer of scene.layers) {
        const span = layerSpan(layer, scene);
        if (span.end > sceneDuration(scene) + 0.01) warnings.push(`layer "${layer.id}": it ends at ${span.end} s but its scene ends at ${sceneDuration(scene)} s; the rest won't show`);
        if (layer.kind === "site") {
          if (!layer.recording) warnings.push(`layer "${layer.id}": the site isn't recorded yet (clips.mjs record; needs Chrome and ffmpeg)`);
          else if (layer.recorded && layer.recorded !== siteKey(layer)) warnings.push(`layer "${layer.id}": the address or the script changed after the recording: record again (clips.mjs record --stale)`);
          const need = actionsDuration(layer.actions) / (layer.speed ?? 1);
          if (!layer.recording && Math.abs(need - span.duration) > 0.3) warnings.push(`layer "${layer.id}": the recording script runs ${need.toFixed(1)} s, the layer ${span.duration.toFixed(1)} s`);
        }
        if (isMoving(layer)) {
          const m = media.get(layerSource(layer));
          const until = (layer.trim?.in ?? 0) + span.duration * (layer.speed ?? 1);
          if (m && !m.duration) warnings.push(`layer "${layer.id}": the length of ${m.name} isn't known yet; the editor finds it out when it opens the clip`);
          if (m?.duration && until > m.duration + 0.05) warnings.push(`layer "${layer.id}": the video ends before the layer does (the file is ${m.duration} s, the layer needs ${until.toFixed(2)} s) and will hold its last frame`);
          if (layer.volume > 0 && m && !m.audio) warnings.push(`layer "${layer.id}": a volume is set, but the file has no sound`);
        }
        if (layer.kind === "text" && layer.font && !fonts.has(layer.font)) warnings.push(`layer "${layer.id}": the font "${layer.font}" is not in the clip's fonts, so a fallback will be drawn`);
        for (const f of Object.keys(layer.formats ?? {})) if (f !== clip.format && !(clip.formats ?? []).includes(f)) warnings.push(`layer "${layer.id}": it has settings for ${f}, but the clip isn't built in that format`);
      }
    });
    const total = totalDuration(clip);
    for (const a of clip.audio ?? []) {
      const m = media.get(a.src);
      const left = (m?.duration ?? Infinity) - (a.trimIn ?? 0);
      const want = a.duration ?? total - (a.start ?? 0);
      if (left < want - 0.1) warnings.push(`audio "${a.id}": the file runs out after ${left.toFixed(1)} s and the clip needs ${want.toFixed(1)} s, so the end will be silent`);
    }
  }
  const used = new Set();
  for (const s of clip.scenes ?? []) for (const l of s.layers ?? []) used.add(layerSource(l));
  for (const a of clip.audio ?? []) used.add(a.src);
  return { errors, warnings, media: [...media.values()], unused: [...media.values()].filter((m) => m.kind !== "font" && !used.has(m.path)).map((m) => m.path), starts };
}

if (cmd === "new") {
  const dir = resolve(need(args[0], "the project folder"));
  if (existsSync(join(dir, "clip.json"))) die(`There is already a clip here: ${dir}`);
  if (existsSync(dir) && readdirSync(dir).some((n) => !n.startsWith(".") && n !== "media")) die(`The folder isn't empty: ${dir}. A clip needs a folder of its own.`);
  const format = flag("format", "16:9");
  if (!FORMATS[format]) die(`The format is one of ${Object.keys(FORMATS).join(", ")}`);
  mkdirSync(join(dir, "media"), { recursive: true });
  const clip = blankClip(String(flag("name", basename(dir))));
  clip.format = format;
  clip.formats = [...new Set([format, format === "9:16" ? "16:9" : "9:16"])];
  clip.fps = Number(flag("fps", 30));
  writeFileSync(join(dir, "clip.json"), `${JSON.stringify(clip, null, 2)}\n`);
  openProject(dir);
  console.log(`Clip created: ${dir}\n  clip.json   the clip itself\n  media/      videos, pictures and sound go here`);
} else if (cmd === "add") {
  const p = openProject(need(args[0], "the project folder"));
  if (args.length < 2) die("Missing: the files to add.");
  for (const src of args.slice(1)) {
    const from = resolve(src);
    if (!existsSync(from) || !statSync(from).isFile()) {
      console.log(`  skipped (no such file): ${src}`);
      continue;
    }
    if (!kindOf(from)) {
      console.log(`  skipped (a clip can't use this kind of file): ${src}`);
      continue;
    }
    const target = freeMediaName(p, safeName(basename(from)));
    copyFileSync(from, target.file);
    const path = await makePlayable(p, target.path, (note) => console.log(`  ${note}`));
    const info = await probe(mediaFile(p, path));
    console.log(`  ${path} · ${kindOf(path)}${info.width ? ` · ${info.width}×${info.height}` : ""}${info.duration ? ` · ${info.duration} s` : ""}${info.audio && kindOf(path) === "video" ? " · has sound" : ""}`);
  }
} else if (cmd === "verify") {
  const p = openProject(need(args[0], "the project folder"));
  const clip = readClip(p);
  const r = await report(p, clip);
  if (r.errors.length) {
    console.log(`ERRORS (${r.errors.length}): the clip can't be saved or built:`);
    for (const e of r.errors) console.log(`  ✗ ${e}`);
    process.exit(1);
  }
  console.log(`${clip.name} · ${totalDuration(clip).toFixed(2)} s · ${clip.fps} fps · ${clip.format}${clip.formats?.length > 1 ? ` (+ ${clip.formats.filter((f) => f !== clip.format).join(", ")})` : ""}`);
  clip.scenes.forEach((s, i) => {
    console.log(`  ${r.starts[i].toFixed(2).padStart(6)} s  ${s.id} · ${s.label ?? ""} · ${sceneDuration(s)} s${s.transition ? ` · ${s.transition.type} transition` : ""}`);
    for (const l of s.layers) {
      const span = layerSpan(l, s);
      const other = Object.keys(l.formats ?? {});
      console.log(`             ${l.kind.padEnd(5)} ${l.id}  ${span.start}–${Math.round(span.end * 100) / 100} s${l.kind === "text" ? `  “${String(l.text).replace(/\s+/g, " ").slice(0, 40)}”` : layerSource(l) ? `  ${layerSource(l)}` : l.kind === "site" ? `  ${l.url}` : ""}${other.length ? `  [own settings: ${other.join(", ")}]` : ""}`);
    }
  });
  for (const a of clip.audio ?? []) console.log(`  audio  ${a.id}  ${a.src}  from ${a.start ?? 0} s`);
  if (r.unused.length) console.log(`Files in media/ the clip doesn't use: ${r.unused.join(", ")}`);
  if (r.warnings.length) {
    console.log(`WARNINGS (${r.warnings.length}):`);
    for (const w of r.warnings) console.log(`  ! ${w}`);
  }
  const t = toolStatus();
  if (!t.claude) console.log("TELL Claude Code is not in the terminal: changes by Claude inside the editor wait for it");
  console.log(r.warnings.length ? "Verified, with warnings." : "Verified.");
} else if (cmd === "still") {
  const dir = need(args[0], "the project folder");
  const t = Number(need(args[1], "the moment, in seconds"));
  const p = openProject(dir);
  const format = String(flag("format", readClip(p).format));
  if (!FORMATS[format]) die(`The format is one of ${Object.keys(FORMATS).join(", ")}`);
  const out = resolve(String(flag("out", join(p.cache, `still-${format.replace(":", "x")}-${t}.png`))));
  try {
    await headless(dir, frameSize(format), async (tab) => {
      await tab.ev(`window.__headless.still(${t}, ${JSON.stringify(format)})`);
      writeFileSync(out, await tab.shot("png"));
    });
    console.log(out);
  } catch (err) {
    console.error(String(err.message ?? err));
    process.exitCode = 1;
  }
  process.exit();
} else if (cmd === "split") {
  const dir = need(args[0], "the project folder");
  const path = need(args[1], "a file of the clip, for example media/film.mp4");
  try {
    const r = await headless(dir, { width: 800, height: 600 }, (tab, s) => tab.ev(`window.__headless.split(${JSON.stringify(path)}, ${readClip(s.project).fps})`));
    const marks = [0, ...r.cuts, r.duration];
    console.log(`${path} · ${r.duration} s · cuts found: ${r.cuts.length}`);
    marks.slice(0, -1).forEach((from, i) => console.log(`  shot ${String(i + 1).padStart(2)}: from ${from} s, lasts ${Math.round((marks[i + 1] - from) * 100) / 100} s   → a layer with { "trim": { "in": ${from} } } in a scene ${Math.round((marks[i + 1] - from) * 100) / 100} s long`));
    if (!r.cuts.length) console.log("  No cuts found (or the shots dissolve into each other): keep it as one scene; it can be split in the editor with S.");
  } catch (err) {
    console.error(String(err.message ?? err));
    process.exitCode = 1;
  }
  process.exit();
} else if (cmd === "record") {
  const s = await start(need(args[0], "the project folder"), { port: 5340, quiet: true });
  try {
    const clip = readClip(s.project);
    const sites = clip.scenes.flatMap((sc) => sc.layers).filter((l) => l.kind === "site");
    const want = args.length > 1 ? sites.filter((l) => args.slice(1).includes(l.id)) : sites.filter((l) => !l.recording || (rest.includes("--stale") && l.recorded !== siteKey(l)));
    if (!want.length) console.log("Nothing to record: every site layer is recorded already.");
    for (const layer of want) {
      console.log(`Recording ${layer.id} · ${layer.url} · ${actionsDuration(layer.actions).toFixed(1)} s`);
      const r = await waitJob(s.startRecord(layer.id));
      console.log(`  done: ${r.path} · ${r.width}×${r.height} · ${r.duration.toFixed(2)} s`);
    }
  } catch (err) {
    console.error(String(err.message ?? err));
    process.exitCode = 1;
  } finally {
    await s.close();
  }
  process.exit();
} else if (cmd === "render") {
  const dir = need(args[0], "the project folder");
  const formats = flag("formats") ? String(flag("formats")).split(",").map((f) => f.trim()) : null;
  try {
    const files = await headless(dir, { width: 800, height: 600 }, async (tab, s) => {
      const waiting = readClip(s.project).scenes.flatMap((sc) => sc.layers).filter((l) => l.kind === "site" && !l.recording);
      if (waiting.length) throw new Error(`Record the sites first: ${waiting.map((l) => l.id).join(", ")} (clips.mjs record).`);
      let last = "";
      const tick = setInterval(async () => {
        const note = await tab.ev("window.__headless.progress.note").catch(() => "");
        if (note && note !== last) console.log(`  ${(last = note)}`);
      }, 1500);
      try {
        const out = await tab.ev(`window.__headless.render(${JSON.stringify(formats)}, ${JSON.stringify(String(flag("quality", "high")))})`);
        return out.map((f) => ({ ...f, file: join(s.project.root, f.path) }));
      } finally {
        clearInterval(tick);
      }
    });
    for (const f of files) console.log(`${f.file} · ${f.width}×${f.height} · ${(f.size / 1e6).toFixed(1)} MB${f.wantedSound && !f.sound ? " · NO SOUND (this Chrome can't encode audio)" : f.sound === "opus" ? " · sound is Opus (silent in QuickTime)" : ""}`);
  } catch (err) {
    console.error(String(err.message ?? err));
    process.exitCode = 1;
  }
  process.exit();
} else if (cmd === "serve") {
  await start(need(args[0], "the project folder"), { port: Number(flag("port", 5320)) });
} else if (cmd === "check") {
  // The same as setup-check.sh, for a computer with no shell (Windows): what the studio found, and what it didn't
  const t = toolStatus();
  const node = Number(process.versions.node.split(".")[0]) >= 22;
  console.log(`node    ${node ? process.execPath : `too old (${process.versions.node}), 22 or newer is needed`}`);
  console.log(`chrome  ${t.chrome ?? "MISSING: https://www.google.com/chrome/ (the editor opens in it and builds the video there)"}`);
  console.log(`claude  ${t.claude ?? "not found (needed for changes by Claude inside the editor)"}`);
  console.log(`ffmpeg  ${t.ffmpeg ?? "not found (only the scripted, frame-by-frame site recorder needs it)"}`);
  console.log(node && t.chrome ? "READY" : "NOT READY");
} else {
  die("Commands: check, new, add, verify, split, still, render, record, serve. They are described at the top of scripts/clips.mjs.");
}
