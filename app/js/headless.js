// The editor's engine with no editor around it, for the skill's command line: Claude Code opens this page in a
// headless Chrome to look at a frame, to build the video, or to find the cuts in a file. It is the same stage and
// the same export the editor uses, so what Claude sees and builds is what the person sees and builds.

import { detectCuts, refineCut } from "./media.js";
import { exportFormat } from "./export.js";
import { loadFonts, Stage } from "./renderer.js";
import { pickBackend } from "./backend.js";

const B = pickBackend();
const safe = (name) => String(name).normalize("NFC").replace(/[\\/\0]+/g, "-").replace(/\s+/g, "-").replace(/^[.-]+/, "").replace(/[.-]+$/, "").replace(/-{2,}/g, "-") || "clip";

async function project() {
  const { clip, media } = await B.open("project");
  return { clip, urls: Object.fromEntries(media.map((m) => [m.path, m.url])) };
}

window.__headless = {
  progress: { fraction: 0, note: "" },
  // Draw one frame; the caller takes a picture of the page
  async still(t, format) {
    const { clip, urls } = await project();
    const stage = new Stage(document.getElementById("stage"), { silent: true });
    stage.load(clip, { format: format ?? clip.format, urls });
    await loadFonts(clip, urls);
    await stage.seek(t);
    return stage.size;
  },
  async render(formats, quality) {
    const { clip, urls } = await project();
    await loadFonts(clip, urls);
    const out = [];
    const list = formats?.length ? formats : [...new Set([clip.format, ...(clip.formats ?? [])])];
    for (const [i, format] of list.entries()) {
      const r = await exportFormat(clip, format, { urls, getBlob: (path) => B.blob("project", path), quality: quality ?? "high", job: { stopped: false, progress: (f, note) => (this.progress = { fraction: (i + f) / list.length, note }) } });
      const saved = await B.saveRender(`${safe(clip.name)}-${format.replace(":", "x")}.mp4`, r.blob);
      out.push({ format, path: saved.path, width: r.width, height: r.height, size: r.blob.size, sound: r.sound, wantedSound: r.wantedSound });
    }
    return out;
  },
  // The shots of a finished video: where each starts and ends, in seconds
  async split(path, fps) {
    const { urls } = await project();
    if (!urls[path]) throw new Error(`no such file in the project: ${path}`);
    const { cuts, duration } = await detectCuts(urls[path], { onProgress: (f) => (this.progress = { fraction: f, note: "looking for cuts" }) });
    const exact = [];
    for (const c of cuts) exact.push(await refineCut(urls[path], c, { fps: fps ?? 30 }));
    return { duration: Math.round(duration * 1000) / 1000, cuts: exact };
  },
};
window.__headlessReady = true;
