// A change made by Claude: one call to the person's own Claude Code, with no tools, that gets only the scene it
// is about (or the clip, for a whole-clip change) and answers with that scene's new JSON. The answer is checked in
// full before anything is written.

import { mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EASES, FORMATS, MOTIONS, SHAPES, TEXT_MOTIONS, TEXT_UNITS, TRANSITIONS } from "../app/js/model.mjs";
import { findClaude, run } from "./tools.mjs";

export const MODELS = ["haiku", "sonnet", "opus"];

// What a clip.json may hold, as short as it can be said. reference/clip-format.md is the long version.
export const FORMAT_BRIEF = `A clip is JSON. Times are seconds. Positions are percent of the frame, 0 is the center (x right, y down).
Sizes of text and radius are in design pixels: the frame's short side is always 1080 of them.

clip: { version: 1, name, fps, format (main format), formats: [${Object.keys(FORMATS).map((f) => `"${f}"`).join(", ")}], background, facts: [string], fonts: [Google Fonts family | { family, src: "media/…" }], scenes: [scene], audio: [track] }
scene: { id, label, duration, background, transition?: { type: ${TRANSITIONS.join(" | ")}, duration } (how this scene comes in over the one before), layers: [layer] }  Scenes play one after another. Layers are drawn in order: the last is on top.
layer, any kind: { id, kind, label, start? (inside the scene, default 0), duration? (leave out: to the scene's end), x?, y?, scale?, rotate?, opacity?, radius?,
  enter?: { type: ${MOTIONS.join(" | ")}, duration, ease }, exit?: same,
  move?: { from: { x, y, scale }, to: { x, y, scale }, ease } (a slow pan or zoom over the layer's whole life, added to x, y, scale),
  formats?: { "9:16": { x, y, scale, rotate, fit, box, size, maxWidth, align, focus, hidden } } (how another format places this layer) }
  ease: ${EASES.join(" | ")}
kind "video": { src: "media/…", trim?: { in } (where in the file it starts), speed?, volume? (0 = silent, the default), fit?: cover | contain, focus?: { x, y } (percent: which part stays in view when cover crops), box?: { w, h } percent of the frame, default 100×100 }
kind "image": { src, fit?, focus?, box? }
  enter/exit types "grow-x" and "grow-y" uncover the layer from its left edge / from its foot: a bar that grows, a line that draws itself, a word wiped in.
kind "text": { text, font?, size, weight?, color?, align?: left | center | right, maxWidth? (percent of the frame's width), letterSpacing? (em), lineHeight?, uppercase?,
  animate?: { by: ${TEXT_UNITS.join(" | ")}, type: ${TEXT_MOTIONS.join(" | ")}, stagger (seconds between pieces), duration (of each piece), ease } (kinetic type: the text comes in piece by piece; use it instead of enter, not with it),
  count?: { from, to, decimals, duration, ease } (a number that counts up; the text must hold {n} where the number goes, e.g. "{n}%" or "+{n} clients") }
kind "shape": { shape?: ${SHAPES.join(" | ")}, fill, box?, radius? }  Infographics are built from these: a bar is a rect with enter "grow-x" or "grow-y" (place bars with x, y and box), a dot or ring is an ellipse, a rule is a thin rect.
kind "site": { url, viewport?: { width, height, scale }, cursor?: boolean, scrollIn?: selector, settle? (seconds to wait after load), actions: [ { do: "wait", for } | { do: "scroll", to: px | "bottom" | "top" | selector, for, ease } | { do: "wheel", by: px, for } | { do: "move", to: selector | [x, y], for } | { do: "click", to?, for? } | { do: "type", text, for } | { do: "key", key } ], recording?: "media/recordings/…" , trim?, speed?, fit?, focus?, box? }
  A site layer is recorded into a video by the person pressing Record. Never write or change "recording" yourself. Changing url, viewport or actions means it has to be recorded again: say so in the summary.
track: { id, src: "media/…", start?, trimIn?, duration?, volume?, fadeIn?, fadeOut? }
Every id is unique in the whole clip: lowercase latin letters, digits and hyphens. Media files must be ones from the list you are given.`;

const RULES = `You change one video clip made in uberdesigner clips, for a designer. You get the clip's format, its facts, the files it has, and the part to change. Reply with ONE JSON object and nothing else: no prose before or after, no code fence.

To make the change:
  { "summary": "one or two short sentences, in the language of the request, saying what you changed, in a designer's words", SCOPE }
If the request can't be done with what you were given (it needs a file that isn't in the list, or a part you weren't sent), or you must ask before changing anything:
  { "question": "what you need, in the language of the request" }

Rules:
- Change only what the request asks for. Keep every other field, id and order exactly as it is.
- Keep the ids of scenes and layers that stay. New ones get new ids that say what they are ("cta-text").
- Use only media files from the list. Never invent a file name.
- Keep layers inside their scene: start + duration no later than the scene's duration.
- When the request is about how something looks in one format (vertical, square), change that layer's formats override, not the layer itself.
- Taste: few fonts, generous margins (text no wider than about 84% of the frame), motion that eases out, 0.4–0.8 s entrances. A designer will look at this.
- Motion type: one idea per scene, 2–6 words on screen at a time, big (size 90–180), animate by word for statements and by letter only for one or two words. Numbers count up. Give every line time to be read: about 0.35 s per word after it has come in.
- A chart is a few shapes and texts placed by hand: align them on a common baseline, stagger their starts by 0.08–0.15 s, and label each value with a text beside its bar.`;

export const sceneSystem = () => `${RULES.replace("SCOPE", '"scene": { the whole scene, changed }')}\n\nThe scene's id must stay the same.\n\n${FORMAT_BRIEF}`;
export const clipSystem = () => `${RULES.replace("SCOPE", '"clip": { the whole clip, changed }')}\n\n${FORMAT_BRIEF}`;

const mediaLine = (m) => `- ${m.path} (${m.kind}${m.width ? `, ${m.width}×${m.height}` : ""}${m.duration ? `, ${m.duration} s` : ""}${m.audio && m.kind === "video" ? ", has sound" : ""})`;

export function buildPrompt({ clip, scene, layerId, request, media, tries, format }) {
  const parts = [];
  parts.push(`Clip: "${clip.name}", ${clip.fps} fps, main format ${clip.format}, also made in ${(clip.formats ?? []).filter((f) => f !== clip.format).join(", ") || "no other format"}. The designer is looking at ${format ?? clip.format} now.`);
  if (clip.facts?.length) parts.push(`Facts about this clip:\n${clip.facts.map((f) => `- ${f}`).join("\n")}`);
  parts.push(`Files in the project:\n${media.length ? media.map(mediaLine).join("\n") : "(none yet)"}`);
  if (scene) {
    const order = clip.scenes.map((s, i) => `${i + 1}. ${s.id}${s.id === scene.id ? " (this one)" : ""} · ${s.label ?? ""} · ${s.duration} s`).join("\n");
    parts.push(`The scenes of the clip, in order:\n${order}`);
    parts.push(`The scene to change:\n${JSON.stringify(scene, null, 1)}`);
    if (layerId) parts.push(`The designer has the layer "${layerId}" picked: the request is most likely about it.`);
    const taken = [];
    for (const s of clip.scenes) if (s.id !== scene.id) taken.push(s.id, ...s.layers.map((l) => l.id));
    for (const a of clip.audio ?? []) taken.push(a.id);
    if (taken.length) parts.push(`Ids taken elsewhere in the clip (don't reuse): ${taken.join(", ")}`);
  } else parts.push(`The whole clip:\n${JSON.stringify(clip, null, 1)}`);
  if (tries?.length) parts.push(`Earlier tries at this change (the JSON above already holds the last one that is in place):\n${tries.map((t, i) => `${i + 1}. Asked: ${t.request}\n   You did: ${t.summary ?? "(nothing)"}${t.takenBack ? " (the designer took this one back)" : ""}`).join("\n")}`);
  parts.push(`The request:\n${request}`);
  return parts.join("\n\n");
}

// The JSON object in Claude's reply, even when it came wrapped in a fence or a sentence
export function parseAnswer(text) {
  const t = String(text).trim();
  const tryParse = (s) => {
    try {
      const v = JSON.parse(s);
      return v && typeof v === "object" && !Array.isArray(v) ? v : null;
    } catch {
      return null;
    }
  };
  const direct = tryParse(t);
  if (direct) return direct;
  const fenced = t.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fenced) {
    const v = tryParse(fenced[1].trim());
    if (v) return v;
  }
  const a = t.indexOf("{");
  const b = t.lastIndexOf("}");
  if (a >= 0 && b > a) {
    const v = tryParse(t.slice(a, b + 1));
    if (v) return v;
  }
  throw new Error("Claude's answer isn't valid JSON.");
}

// One call. job: { stopped, onStop }. Returns { answer, usage }.
export async function askClaude(system, prompt, { model = "sonnet", job } = {}) {
  const bin = findClaude();
  if (!bin) throw new Error("Claude Code wasn't found in this computer's terminal. Ask in the chat: “connect uberdesigner clips to Claude Code”.");
  const cwd = join(tmpdir(), "uberdesigner-clips"); // an empty folder: nothing of the person's is in reach
  mkdirSync(cwd, { recursive: true });
  const args = ["-p", "--safe-mode", "--output-format", "json", "--tools", "", "--system-prompt", system, "--model", MODELS.includes(model) ? model : "sonnet"];
  const r = await run(bin, args, {
    cwd,
    input: prompt,
    timeout: 20 * 60_000,
    onSpawn: (child) => job && (job.onStop = () => child.kill("SIGKILL")),
  });
  if (job) job.onStop = null;
  if (job?.stopped) throw new Error("Stopped. Nothing was changed.");
  let result;
  try {
    result = JSON.parse(r.out);
  } catch {
    const why = (r.err || r.out || "").trim().split("\n").slice(-2).join(" ").slice(0, 300);
    if (/log ?in|auth|credential|api key/i.test(why)) throw new Error("Claude Code isn't logged in. Run in the terminal: claude auth login");
    throw new Error(r.timedOut ? "Claude didn't answer in 20 minutes, so the request was stopped. Nothing was changed." : `Claude Code ended without an answer${why ? `: ${why}` : ""}. Nothing was changed.`);
  }
  if (Array.isArray(result)) result = result.find((e) => e.type === "result") ?? {};
  if (result.is_error || !result.result) {
    const why = String(result.result ?? "Claude returned an error");
    if (/log ?in|auth|credential|api key/i.test(why)) throw new Error("Claude Code isn't logged in. Run in the terminal: claude auth login");
    throw new Error(why.slice(0, 400));
  }
  const u = result.usage ?? {};
  const usage = {
    input: (u.input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0),
    output: u.output_tokens ?? 0,
    costUsd: result.total_cost_usd ?? 0,
    seconds: Math.round((result.duration_ms ?? 0) / 100) / 10,
  };
  return { answer: parseAnswer(result.result), usage };
}
