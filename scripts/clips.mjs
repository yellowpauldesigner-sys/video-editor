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
const need = (v, what) => v ?? die(`Не хватает: ${what}. Справка — в начале scripts/clips.mjs.`);

// The editor's engine in a headless Chrome, on a running project: fn gets the tab once the page is ready
async function headless(dir, size, fn) {
  const s = await start(dir, { port: 5340, quiet: true });
  let tab = null;
  try {
    const errs = problems(s.project, readClip(s.project));
    if (errs.length) throw new Error(`В клипе ошибки:\n${errs.join("\n")}`);
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
  if (job.state !== "done") throw new Error(job.error ?? "не получилось");
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
      if (!scene.layers.length) warnings.push(`сцена "${scene.id}": в ней нет слоёв, будет ${sceneDuration(scene)} с пустого фона`);
      if (i === 0 && scene.transition) warnings.push(`сцена "${scene.id}": у первой сцены переход не сработает — ей не из чего появляться`);
      for (const layer of scene.layers) {
        const span = layerSpan(layer, scene);
        if (span.end > sceneDuration(scene) + 0.01) warnings.push(`слой "${layer.id}": кончается на ${span.end} с, а сцена — на ${sceneDuration(scene)} с; хвост не покажется`);
        if (layer.kind === "site") {
          if (!layer.recording) warnings.push(`слой "${layer.id}": сайт ещё не записан (clips.mjs record; нужны Chrome и ffmpeg)`);
          else if (layer.recorded && layer.recorded !== siteKey(layer)) warnings.push(`слой "${layer.id}": адрес или сценарий изменились после записи — запишите заново (clips.mjs record --stale)`);
          const need = actionsDuration(layer.actions) / (layer.speed ?? 1);
          if (!layer.recording && Math.abs(need - span.duration) > 0.3) warnings.push(`слой "${layer.id}": сценарий записи длится ${need.toFixed(1)} с, а слой — ${span.duration.toFixed(1)} с`);
        }
        if (isMoving(layer)) {
          const m = media.get(layerSource(layer));
          const until = (layer.trim?.in ?? 0) + span.duration * (layer.speed ?? 1);
          if (m && !m.duration) warnings.push(`слой "${layer.id}": длина файла ${m.name} ещё неизвестна — её узнает редактор, когда откроет клип`);
          if (m?.duration && until > m.duration + 0.05) warnings.push(`слой "${layer.id}": видео кончится раньше слоя (${m.duration} с файла против ${until.toFixed(2)} с) и застынет на последнем кадре`);
          if (layer.volume > 0 && m && !m.audio) warnings.push(`слой "${layer.id}": громкость задана, но в файле нет звука`);
        }
        if (layer.kind === "text" && layer.font && !fonts.has(layer.font)) warnings.push(`слой "${layer.id}": шрифта "${layer.font}" нет в fonts клипа — будет запасной`);
        for (const f of Object.keys(layer.formats ?? {})) if (f !== clip.format && !(clip.formats ?? []).includes(f)) warnings.push(`слой "${layer.id}": есть настройки для ${f}, но клип в этом формате не собирается`);
      }
    });
    const total = totalDuration(clip);
    for (const a of clip.audio ?? []) {
      const m = media.get(a.src);
      const left = (m?.duration ?? Infinity) - (a.trimIn ?? 0);
      const want = a.duration ?? total - (a.start ?? 0);
      if (left < want - 0.1) warnings.push(`звук "${a.id}": файл кончится через ${left.toFixed(1)} с, клипу нужно ${want.toFixed(1)} с — в конце будет тишина`);
    }
  }
  const used = new Set();
  for (const s of clip.scenes ?? []) for (const l of s.layers ?? []) used.add(layerSource(l));
  for (const a of clip.audio ?? []) used.add(a.src);
  return { errors, warnings, media: [...media.values()], unused: [...media.values()].filter((m) => m.kind !== "font" && !used.has(m.path)).map((m) => m.path), starts };
}

if (cmd === "new") {
  const dir = resolve(need(args[0], "папка проекта"));
  if (existsSync(join(dir, "clip.json"))) die(`Здесь уже есть клип: ${dir}`);
  if (existsSync(dir) && readdirSync(dir).some((n) => !n.startsWith(".") && n !== "media")) die(`Папка не пустая: ${dir}. Клипу нужна своя папка.`);
  const format = flag("format", "16:9");
  if (!FORMATS[format]) die(`Формат — один из ${Object.keys(FORMATS).join(", ")}`);
  mkdirSync(join(dir, "media"), { recursive: true });
  const clip = blankClip(String(flag("name", basename(dir))));
  clip.format = format;
  clip.formats = [...new Set([format, format === "9:16" ? "16:9" : "9:16"])];
  clip.fps = Number(flag("fps", 30));
  writeFileSync(join(dir, "clip.json"), `${JSON.stringify(clip, null, 2)}\n`);
  openProject(dir);
  console.log(`Клип создан: ${dir}\n  clip.json — сам клип\n  media/    — сюда кладутся видео, картинки, звук`);
} else if (cmd === "add") {
  const p = openProject(need(args[0], "папка проекта"));
  if (args.length < 2) die("Не хватает: файлы, которые добавить.");
  for (const src of args.slice(1)) {
    const from = resolve(src);
    if (!existsSync(from) || !statSync(from).isFile()) {
      console.log(`  пропущен (нет такого файла): ${src}`);
      continue;
    }
    if (!kindOf(from)) {
      console.log(`  пропущен (клип такие файлы не использует): ${src}`);
      continue;
    }
    const target = freeMediaName(p, safeName(basename(from)));
    copyFileSync(from, target.file);
    const path = await makePlayable(p, target.path, (note) => console.log(`  ${note}`));
    const info = await probe(mediaFile(p, path));
    console.log(`  ${path} · ${kindOf(path)}${info.width ? ` · ${info.width}×${info.height}` : ""}${info.duration ? ` · ${info.duration} с` : ""}${info.audio && kindOf(path) === "video" ? " · со звуком" : ""}`);
  }
} else if (cmd === "verify") {
  const p = openProject(need(args[0], "папка проекта"));
  const clip = readClip(p);
  const r = await report(p, clip);
  if (r.errors.length) {
    console.log(`ОШИБКИ (${r.errors.length}) — клип нельзя ни сохранить, ни собрать:`);
    for (const e of r.errors) console.log(`  ✗ ${e}`);
    process.exit(1);
  }
  console.log(`${clip.name} · ${totalDuration(clip).toFixed(2)} с · ${clip.fps} к/с · ${clip.format}${clip.formats?.length > 1 ? ` (+ ${clip.formats.filter((f) => f !== clip.format).join(", ")})` : ""}`);
  clip.scenes.forEach((s, i) => {
    console.log(`  ${r.starts[i].toFixed(2).padStart(6)} с  ${s.id} · ${s.label ?? ""} · ${sceneDuration(s)} с${s.transition ? ` · переход ${s.transition.type}` : ""}`);
    for (const l of s.layers) {
      const span = layerSpan(l, s);
      const other = Object.keys(l.formats ?? {});
      console.log(`             ${l.kind.padEnd(5)} ${l.id}  ${span.start}–${Math.round(span.end * 100) / 100} с${l.kind === "text" ? `  “${String(l.text).replace(/\s+/g, " ").slice(0, 40)}”` : layerSource(l) ? `  ${layerSource(l)}` : l.kind === "site" ? `  ${l.url}` : ""}${other.length ? `  [свои настройки: ${other.join(", ")}]` : ""}`);
    }
  });
  for (const a of clip.audio ?? []) console.log(`  звук   ${a.id}  ${a.src}  с ${a.start ?? 0} с`);
  if (r.unused.length) console.log(`Файлы в media/, которые клип не использует: ${r.unused.join(", ")}`);
  if (r.warnings.length) {
    console.log(`ЗАМЕЧАНИЯ (${r.warnings.length}):`);
    for (const w of r.warnings) console.log(`  ! ${w}`);
  }
  const t = toolStatus();
  if (!t.claude) console.log("TELL нет Claude Code в терминале: изменения через Claude в редакторе его ждут");
  console.log(r.warnings.length ? "Проверка пройдена, с замечаниями." : "Проверка пройдена.");
} else if (cmd === "still") {
  const dir = need(args[0], "папка проекта");
  const t = Number(need(args[1], "момент в секундах"));
  const p = openProject(dir);
  const format = String(flag("format", readClip(p).format));
  if (!FORMATS[format]) die(`Формат — один из ${Object.keys(FORMATS).join(", ")}`);
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
  const dir = need(args[0], "папка проекта");
  const path = need(args[1], "файл клипа, например media/film.mp4");
  try {
    const r = await headless(dir, { width: 800, height: 600 }, (tab, s) => tab.ev(`window.__headless.split(${JSON.stringify(path)}, ${readClip(s.project).fps})`));
    const marks = [0, ...r.cuts, r.duration];
    console.log(`${path} · ${r.duration} с · кадров-склеек найдено: ${r.cuts.length}`);
    marks.slice(0, -1).forEach((from, i) => console.log(`  кадр ${String(i + 1).padStart(2)}: с ${from} с, длится ${Math.round((marks[i + 1] - from) * 100) / 100} с   → слой { "trim": { "in": ${from} } } в сцене длиной ${Math.round((marks[i + 1] - from) * 100) / 100}`));
    if (!r.cuts.length) console.log("  Склеек не нашлось (или это плавные переходы): оставьте одной сценой, резать можно в редакторе клавишей S.");
  } catch (err) {
    console.error(String(err.message ?? err));
    process.exitCode = 1;
  }
  process.exit();
} else if (cmd === "record") {
  const s = await start(need(args[0], "папка проекта"), { port: 5340, quiet: true });
  try {
    const clip = readClip(s.project);
    const sites = clip.scenes.flatMap((sc) => sc.layers).filter((l) => l.kind === "site");
    const want = args.length > 1 ? sites.filter((l) => args.slice(1).includes(l.id)) : sites.filter((l) => !l.recording || (rest.includes("--stale") && l.recorded !== siteKey(l)));
    if (!want.length) console.log("Записывать нечего: все слои-сайты уже записаны.");
    for (const layer of want) {
      console.log(`Записываю ${layer.id} · ${layer.url} · ${actionsDuration(layer.actions).toFixed(1)} с`);
      const r = await waitJob(s.startRecord(layer.id));
      console.log(`  готово: ${r.path} · ${r.width}×${r.height} · ${r.duration.toFixed(2)} с`);
    }
  } catch (err) {
    console.error(String(err.message ?? err));
    process.exitCode = 1;
  } finally {
    await s.close();
  }
  process.exit();
} else if (cmd === "render") {
  const dir = need(args[0], "папка проекта");
  const formats = flag("formats") ? String(flag("formats")).split(",").map((f) => f.trim()) : null;
  try {
    const files = await headless(dir, { width: 800, height: 600 }, async (tab, s) => {
      const waiting = readClip(s.project).scenes.flatMap((sc) => sc.layers).filter((l) => l.kind === "site" && !l.recording);
      if (waiting.length) throw new Error(`Сначала запишите сайты: ${waiting.map((l) => l.id).join(", ")} (clips.mjs record).`);
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
    for (const f of files) console.log(`${f.file} · ${f.width}×${f.height} · ${(f.size / 1e6).toFixed(1)} МБ${f.wantedSound && !f.sound ? " · БЕЗ ЗВУКА (этот Chrome не кодирует звук)" : f.sound === "opus" ? " · звук в Opus (в QuickTime молчит)" : ""}`);
  } catch (err) {
    console.error(String(err.message ?? err));
    process.exitCode = 1;
  }
  process.exit();
} else if (cmd === "serve") {
  await start(need(args[0], "папка проекта"), { port: Number(flag("port", 5320)) });
} else if (cmd === "check") {
  // The same as setup-check.sh, for a computer with no shell (Windows): what the studio found, and what it didn't
  const t = toolStatus();
  const node = Number(process.versions.node.split(".")[0]) >= 22;
  console.log(`node    ${node ? process.execPath : `слишком старый (${process.versions.node}), нужен 22+`}`);
  console.log(`chrome  ${t.chrome ?? "НЕТ — https://www.google.com/chrome/ (в нём открывается редактор и собирается видео)"}`);
  console.log(`claude  ${t.claude ?? "нет (нужен для изменений через Claude в редакторе)"}`);
  console.log(`ffmpeg  ${t.ffmpeg ?? "нет (нужен только для покадровой записи сайта по сценарию)"}`);
  console.log(node && t.chrome ? "READY" : "NOT READY");
} else {
  die("Команды: check, new, add, verify, split, still, render, record, serve. Справка — в начале scripts/clips.mjs.");
}
