// The server end to end on a tiny project, with a stand-in for Claude Code. No browser, no ffmpeg needed.
import assert from "node:assert/strict";
import { cpSync, mkdtempSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";
import { blankClip } from "../app/js/model.mjs";

const here = dirname(fileURLToPath(import.meta.url));
process.env.CLAUDE_BIN = join(here, "fake-claude.mjs");
const { start } = await import("../server/serve.mjs");

let s, dir, token;
const call = async (path, body, method = "POST", headers = {}) => {
  const res = await fetch(s.origin + path, body === undefined ? { headers } : { method, headers: { "content-type": "application/json", "x-clips-token": token, ...headers }, body: JSON.stringify(body) });
  return { status: res.status, data: await res.json().catch(() => null) };
};
const settle = async () => {
  for (let i = 0; i < 100; i++) {
    const { data } = await call("/__clips/state");
    if (!data.jobs.some((j) => j.state === "running")) return data;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error("still running");
};
const onDisk = () => JSON.parse(readFileSync(join(dir, "clip.json"), "utf8"));

before(async () => {
  dir = mkdtempSync(join(tmpdir(), "clips-test-"));
  const clip = blankClip("Test");
  clip.scenes.push({ id: "two", label: "Вторая", duration: 4, layers: [] });
  writeFileSync(join(dir, "clip.json"), JSON.stringify(clip));
  s = await start(dir, { port: 5470, quiet: true });
  token = s.project.token;
});
after(() => s.close());

test("the editor page carries the token; the project reads", async () => {
  const html = await (await fetch(s.origin + "/")).text();
  assert.ok(html.includes(token));
  const { data } = await call("/__clips/project");
  assert.equal(data.clip.name, "Test");
  assert.deepEqual(data.problems, []);
});

test("a change needs the token, and its own origin", async () => {
  const clip = onDisk();
  assert.equal((await call("/__clips/project", { clip }, "PUT", { "x-clips-token": "nope" })).status, 403);
  assert.equal((await call("/__clips/project", { clip }, "PUT", { origin: "http://evil.example" })).status, 403);
  const res = await fetch(s.origin + "/__clips/project", { headers: { "sec-fetch-site": "cross-site" } });
  assert.equal(res.status, 403);
});

test("a bad clip is refused whole and the file stays", async () => {
  const clip = onDisk();
  clip.scenes[0].layers.push({ id: "v", kind: "video", src: "media/none.mp4" });
  const r = await call("/__clips/project", { clip }, "PUT");
  assert.equal(r.status, 422);
  assert.match(r.data.problems[0], /нет в проекте/);
  assert.equal(onDisk().scenes[0].layers.length, 1);
});

test("a save writes the file and a point in History; going back is a new point", async () => {
  const clip = onDisk();
  clip.scenes[0].duration = 5;
  assert.equal((await call("/__clips/project", { clip, label: "Длительность" }, "PUT")).status, 200);
  assert.equal(onDisk().scenes[0].duration, 5);
  const { data } = await call("/__clips/history");
  assert.equal(data.versions[0].label, "Длительность");
  const first = data.versions.at(-1);
  await call("/__clips/history/restore", { id: first.id });
  assert.equal(onDisk().scenes[0].duration, 3);
  assert.equal((await call("/__clips/history")).data.versions[0].kind, "restore");
});

test("Claude changes one scene; the card keeps what it did; Undo puts it back", async () => {
  const r = await call("/__clips/change", { sceneId: "two", request: "короче" });
  assert.equal(r.status, 200);
  let st = await settle();
  const card = st.cards.at(-1);
  assert.equal(card.state, "ready");
  assert.equal(card.tries[0].summary, "Сделал сцену вдвое короче.");
  assert.equal(card.tries[0].before, undefined); // the copies stay on the server
  assert.equal(onDisk().scenes[1].duration, 2);
  assert.equal(onDisk().scenes[0].duration, 3); // the other scene was not sent and did not change
  // a refinement is a second try on the same card
  await call("/__clips/change", { sceneId: "two", request: "ещё короче", cardId: card.id });
  st = await settle();
  assert.equal(st.cards.at(-1).tries.length, 2);
  assert.equal(onDisk().scenes[1].duration, 1);
  assert.equal((await call("/__clips/cards/undo", { id: card.id })).status, 200);
  assert.equal(onDisk().scenes[1].duration, 4);
  assert.equal((await call("/__clips/state")).data.cards.at(-1).state, "undone");
});

test("an answer that breaks the format is sent back once, then used", async () => {
  process.env.FAKE_CLAUDE = "bad";
  await call("/__clips/change", { sceneId: "two", request: "короче" });
  const st = await settle();
  assert.equal(st.cards.at(-1).state, "ready");
  assert.equal(onDisk().scenes[1].duration, 2);
  delete process.env.FAKE_CLAUDE;
});

test("Undo is refused once the scene was changed again by hand", async () => {
  const card = (await call("/__clips/state")).data.cards.at(-1);
  const clip = onDisk();
  clip.scenes[1].label = "Руками";
  await call("/__clips/project", { clip }, "PUT");
  const r = await call("/__clips/cards/undo", { id: card.id });
  assert.equal(r.status, 400);
  assert.match(r.data.error, /Истори/);
  assert.equal(onDisk().scenes[1].label, "Руками");
});

test("a question changes nothing", async () => {
  process.env.FAKE_CLAUDE = "question";
  const was = readFileSync(join(dir, "clip.json"), "utf8");
  await call("/__clips/change", { sceneId: "title", request: "поставь видео" });
  const st = await settle();
  assert.equal(st.cards.at(-1).state, "question");
  assert.equal(readFileSync(join(dir, "clip.json"), "utf8"), was);
  delete process.env.FAKE_CLAUDE;
});

test("a whole-clip change", async () => {
  await call("/__clips/change", { sceneId: null, request: "переименуй" });
  const st = await settle();
  assert.equal(st.cards.at(-1).label, "Весь клип");
  assert.equal(onDisk().name, "Test v2");
});

test("media: an upload lands in media/, and nothing else can be read", async () => {
  const res = await fetch(s.origin + "/__clips/media?name=" + encodeURIComponent("../../кадр 1.png"), { method: "POST", headers: { "x-clips-token": token }, body: Buffer.from("89504e470d0a1a0a", "hex") });
  const { item } = await res.json();
  assert.equal(item.path, "media/кадр-1.png");
  assert.equal((await fetch(s.origin + "/media/" + encodeURIComponent("кадр-1.png"))).status, 200);
  assert.equal((await fetch(s.origin + "/media/..%2Fclip.json")).status, 404);
  assert.equal((await fetch(s.origin + "/js/../../server/serve.mjs")).status, 404);
  assert.equal((await fetch(s.origin + "/js/model.mjs")).status, 200);
  assert.equal((await fetch(s.origin + "/media/" + encodeURIComponent("кадр-1.png"), { headers: { range: "bytes=0-3" } })).status, 206);
  assert.equal((await fetch(s.origin + "/__clips/media?name=x.exe", { method: "POST", headers: { "x-clips-token": token }, body: "x" })).status, 415);
});

test("a clip edited by other hands is picked up", async () => {
  const before = (await call("/__clips/state")).data.clipRev;
  const clip = onDisk();
  clip.name = "Из чата";
  writeFileSync(join(dir, "clip.json"), JSON.stringify(clip));
  for (let i = 0; i < 60 && (await call("/__clips/state")).data.clipRev === before; i++) await new Promise((r) => setTimeout(r, 50));
  assert.ok((await call("/__clips/state")).data.clipRev > before);
  assert.equal((await call("/__clips/project")).data.clip.name, "Из чата");
});

test("what the page learned about a file is kept, and a render lands in renders/", async () => {
  const path = "media/кадр-1.png";
  assert.equal((await call("/__clips/media/info", { path, info: { width: 10, height: 20, thumb: "data:image/jpeg;base64,AAAA", evil: "x" } })).status, 200);
  const m = (await call("/__clips/project")).data.media.find((x) => x.path === path);
  assert.equal(m.width, 10);
  assert.equal(m.thumb, "data:image/jpeg;base64,AAAA");
  assert.equal(m.evil, undefined);
  const res = await fetch(s.origin + "/__clips/renders?name=" + encodeURIComponent("../Мой клип-16x9.mp4"), { method: "POST", headers: { "x-clips-token": token }, body: Buffer.from("00000018667479706d703432", "hex") });
  const r = await res.json();
  assert.equal(r.path, "renders/Мой-клип-16x9.mp4");
  assert.equal((await fetch(s.origin + "/renders/" + encodeURIComponent("Мой-клип-16x9.mp4"))).status, 200);
  assert.equal((await fetch(s.origin + "/__clips/renders?name=x.sh", { method: "POST", headers: { "x-clips-token": token }, body: "x" })).status, 415);
  assert.equal((await call("/__clips/media/remove", { path })).status, 200);
  assert.equal((await fetch(s.origin + "/media/" + encodeURIComponent("кадр-1.png"))).status, 404);
});

test("the editor page is this project's: it carries the token, the plain site does not", async () => {
  const html = await (await fetch(s.origin + "/")).text();
  assert.ok(!html.includes("__CLIPS_TOKEN__"));
  assert.ok((await (await fetch(s.origin + "/headless.html")).text()).includes(token));
});
