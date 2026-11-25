import assert from "node:assert/strict";
import { test } from "node:test";
import { blankClip, countValue, duplicateScene, layerSpan, resolveLayer, sceneAt, setPlaced, siteKey, splitScene, totalDuration, validate } from "../app/js/model.mjs";

const clip = () => ({
  ...blankClip("T"),
  scenes: [
    { id: "a", label: "A", duration: 4, layers: [
      { id: "v", kind: "video", src: "media/v.mp4", trim: { in: 1 }, speed: 2, exit: { type: "fade" }, move: { from: { scale: 1 }, to: { scale: 2 }, ease: "linear" } },
      { id: "t", kind: "text", text: "hi", start: 0.5, duration: 1 },
      { id: "late", kind: "text", text: "late", start: 3 },
    ] },
    { id: "b", label: "B", duration: 2, transition: { type: "fade", duration: 0.5 }, layers: [] },
  ],
});

test("a blank clip is valid", () => assert.deepEqual(validate(blankClip()), []));

test("timing", () => {
  const c = clip();
  assert.equal(totalDuration(c), 6);
  assert.equal(sceneAt(c, 4.5).scene.id, "b");
  assert.equal(sceneAt(c, 4.5).local, 0.5);
  assert.deepEqual(layerSpan(c.scenes[0].layers[0], c.scenes[0]), { start: 0, duration: 4, end: 4, open: true });
});

test("problems are named in words", () => {
  const c = clip();
  c.scenes[0].layers[1].id = "v";
  c.scenes[0].layers[0].src = "../secret.mp4";
  c.scenes[1].transition.type = "spin";
  const errors = validate(c);
  assert.equal(errors.length, 3);
  assert.match(errors.join("\n"), /already taken/);
  assert.match(errors.join("\n"), /media\//);
});

test("a path can't leave media/", () => {
  for (const src of ["media/../clip.json", "/etc/passwd", "media\\x.mp4", "media/a/../../x"]) {
    const c = clip();
    c.scenes[0].layers[0].src = src;
    assert.ok(validate(c).length, src);
  }
});

test("split: a video goes on from where it stopped, short layers stay on their side", () => {
  const c = clip();
  const r = splitScene(c, "a", 1);
  assert.deepEqual(r, { first: "a", second: "a-b" });
  assert.equal(totalDuration(c), 6);
  const [a, b] = c.scenes;
  assert.equal(a.duration, 1);
  assert.equal(b.duration, 3);
  assert.equal(b.layers.find((l) => l.id === "v-b").trim.in, 3); // 1 + 1 s at speed 2
  assert.equal(a.layers.find((l) => l.id === "v").exit, undefined);
  assert.equal(a.layers.find((l) => l.id === "v").move.to.scale, 1.25);
  assert.equal(b.layers.find((l) => l.id === "v-b").move.from.scale, 1.25);
  // the text crossed the cut: 0.5 s before it, 0.5 s after
  assert.equal(a.layers.find((l) => l.id === "t").duration, 0.5);
  assert.equal(b.layers.find((l) => l.id === "t-b").duration, 0.5);
  assert.equal(b.layers.find((l) => l.id === "late").start, 2);
  assert.deepEqual(validate(c), []);
  assert.equal(splitScene(c, "a", 0.05), null);
});

test("duplicate keeps ids unique", () => {
  const c = clip();
  duplicateScene(c, "a");
  assert.deepEqual(validate(c), []);
  assert.equal(c.scenes.length, 3);
});

test("a format's placement is its own", () => {
  const c = clip();
  const layer = c.scenes[0].layers[1];
  setPlaced(c, layer, "9:16", "y", 20);
  setPlaced(c, layer, "16:9", "y", 5);
  assert.equal(resolveLayer(layer, "9:16").y, 20);
  assert.equal(resolveLayer(layer, "16:9").y, 5);
  assert.equal(resolveLayer(layer, "1:1").y, 5);
  assert.deepEqual(validate(c), []);
});

test("a recording knows what it was made from", () => {
  const l = { kind: "site", url: "http://localhost:1", actions: [{ do: "wait", for: 1 }] };
  const k = siteKey(l);
  l.actions[0].for = 2;
  assert.notEqual(siteKey(l), k);
});

test("motion type and counters", () => {
  const c = blankClip();
  c.scenes[0].layers.push({ id: "n", kind: "text", text: "+{n} clients", count: { from: 0, to: 12500 }, animate: { by: "word", type: "up", stagger: 0.08 } }, { id: "bar", kind: "shape", shape: "ellipse", fill: "#fff", enter: { type: "grow-y", duration: 0.6 } });
  assert.deepEqual(validate(c), []);
  assert.equal(countValue({ from: 0, to: 12500 }, 99, 2), "12\u202f500");
  assert.equal(countValue({ from: 0, to: 100, ease: "linear", duration: 2 }, 1, 5), "50");
  assert.equal(countValue({ to: 98.6, decimals: 1, comma: true }, 9, 2), "98,6");
  c.scenes[0].layers[1].text = "no place for it";
  c.scenes[0].layers[1].animate.by = "syllable";
  c.scenes[0].layers[2].shape = "star";
  assert.equal(validate(c).length, 3);
});
