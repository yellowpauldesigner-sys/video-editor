#!/usr/bin/env node
// Stands in for Claude Code in the tests: reads the prompt, and answers the way the real one is asked to.
// FAKE_CLAUDE picks the answer: "shorter" (default) halves the scene, "bad" breaks the format once then fixes it,
// "question" asks back, "clip" renames the whole clip.
import { readFileSync } from "node:fs";
const prompt = readFileSync(0, "utf8");
const mode = process.env.FAKE_CLAUDE ?? "shorter";
const grab = (marker) => {
  const at = prompt.indexOf(marker);
  if (at < 0) return null;
  const from = prompt.indexOf("{", at);
  let depth = 0, inStr = false, esc = false;
  for (let i = from; i < prompt.length; i++) {
    const c = prompt[i];
    if (inStr) { if (esc) esc = false; else if (c === "\\") esc = true; else if (c === '"') inStr = false; continue; }
    if (c === '"') inStr = true; else if (c === "{") depth++; else if (c === "}" && --depth === 0) return JSON.parse(prompt.slice(from, i + 1));
  }
  return null;
};
let answer;
const scene = grab("The scene to change:");
const clip = grab("The whole clip:");
if (mode === "question") answer = { question: "Какой файл поставить?" };
else if (clip) answer = { summary: "Переименовал клип.", clip: { ...clip, name: `${clip.name} v2` } };
else if (mode === "bad" && !prompt.includes("It can't be used")) answer = { summary: "Сломал.", scene: { ...scene, duration: -1 } };
else answer = { summary: "Сделал сцену вдвое короче.", scene: { ...scene, duration: scene.duration / 2 } };
process.stdout.write(JSON.stringify({ type: "result", is_error: false, result: "```json\n" + JSON.stringify(answer) + "\n```", duration_ms: 1200, total_cost_usd: 0.01, usage: { input_tokens: 900, output_tokens: 300 } }));
