// Where a clip lives. The editor is the same in both places; only this file knows the difference.
//
//   browser   the page was opened as a plain site: clips and files are kept in this browser's storage (IndexedDB)
//   project   the page is served by the uberdesigner clips skill from a clip's folder: clip.json and media/ are
//             files on disk, Claude Code can read and change them, and the editor's chat reaches Claude
//
// The skill's server puts the project's token into the page; without one, this is the browser's own storage.

import * as store from "./store.js";

const TOKEN = document.querySelector('meta[name="clips-token"]')?.content ?? "";
const PROJECT = !!TOKEN && !TOKEN.startsWith("__");

function browserBackend() {
  const blobs = new Map(); // "<clip>|<path>" → Blob
  const urlOf = new Map();
  const keyOf = (id, path) => `${id}|${path}`;
  const give = (id, path, blob) => {
    const key = keyOf(id, path);
    blobs.set(key, blob);
    if (!urlOf.has(key)) urlOf.set(key, URL.createObjectURL(blob));
    return urlOf.get(key);
  };
  let current = null;
  return {
    mode: "browser",
    persistent: () => store.persistent(),
    savedNote: () => (store.persistent() ? "Сохранено в этом браузере" : "Не сохраняется: приватное окно"),
    listClips: () => store.listClips(),
    lastOpened: () => store.lastOpened(),
    async createClip(clip) {
      const id = store.newId();
      await store.saveClip(id, clip);
      await store.recordHistory(id, clip, "Новый клип");
      return id;
    },
    deleteClip: (id) => store.deleteClip(id),
    async open(id) {
      // the files of the clip that was open before are let go
      if (current && current !== id)
        for (const [key, url] of urlOf)
          if (key.startsWith(`${current}|`)) {
            URL.revokeObjectURL(url);
            urlOf.delete(key);
            blobs.delete(key);
          }
      current = id;
      const clip = await store.loadClip(id);
      const media = (await store.listMedia(id)).map(({ blob, clipId, ...item }) => ({ ...item, url: give(id, item.path, blob) }));
      await store.setLastOpened(id);
      return { clip, media };
    },
    async save(id, clip, label) {
      await store.saveClip(id, clip);
      await store.recordHistory(id, clip, label);
    },
    async addMedia(id, file, name, info) {
      const dot = name.lastIndexOf(".");
      const [stem, ext] = dot > 0 ? [name.slice(0, dot), name.slice(dot)] : [name, ""];
      let path = `media/${name}`;
      for (let n = 2; blobs.has(keyOf(id, path)); n++) path = `media/${stem}-${n}${ext}`;
      const item = { path, name: path.slice(6), ...info };
      await store.putMedia(id, { ...item, blob: file });
      return { ...item, url: give(id, path, file) };
    },
    async removeMedia(id, path) {
      await store.deleteMedia(id, path);
      const key = keyOf(id, path);
      URL.revokeObjectURL(urlOf.get(key));
      urlOf.delete(key);
      blobs.delete(key);
    },
    setMediaInfo: async () => {},
    blob: async (id, path) => blobs.get(keyOf(id, path)) ?? null,
    history: async (id) => (await store.listHistory(id)).map((v) => ({ key: v.n, at: v.at, label: v.label })),
    historyClip: (id, key) => store.historyClip(id, key),
    // In a browser the file is handed to the person as a download
    saveRender: async (name, blob) => ({ name, url: URL.createObjectURL(blob), download: true }),
    keep: () => store.keep(),
  };
}

function projectBackend() {
  const call = async (path, body, method = "POST") => {
    const res = await fetch(path, body === undefined ? {} : { method, headers: { "content-type": "application/json", "x-clips-token": TOKEN }, body: JSON.stringify(body) });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      const err = new Error(data.error ?? `Ошибка ${res.status}`);
      err.problems = data.problems;
      throw err;
    }
    return data;
  };
  const urlOf = (m) => `/${m.path.split("/").map(encodeURIComponent).join("/")}?v=${m.mtime ?? 0}`;
  const b = {
    mode: "project",
    clipRev: -1,
    persistent: () => true,
    savedNote: () => "Сохранено в папке клипа",
    listClips: async () => [{ id: "project", name: "", updatedAt: 0 }],
    lastOpened: async () => "project",
    createClip: async () => "project",
    deleteClip: async () => {},
    async open() {
      const p = await call("/__clips/project");
      b.clipRev = p.clipRev;
      b.tools = p.tools;
      b.settings = p.settings;
      b.models = p.models;
      b.root = p.root;
      return { clip: p.clip, media: p.media.map((m) => ({ ...m, url: urlOf(m) })) };
    },
    async save(id, clip, label) {
      const r = await call("/__clips/project", { clip, label }, "PUT");
      b.clipRev = Math.max(b.clipRev, r.clipRev);
    },
    async addMedia(id, file, name, info) {
      const res = await fetch(`/__clips/media?name=${encodeURIComponent(name)}`, { method: "POST", headers: { "x-clips-token": TOKEN }, body: file });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error ?? "файл не сохранился");
      const item = { ...data.item, ...info };
      await b.setMediaInfo(id, item.path, info);
      return { ...item, url: urlOf(item) };
    },
    removeMedia: (id, path) => call("/__clips/media/remove", { path }),
    setMediaInfo: (id, path, info) => call("/__clips/media/info", { path, info }).catch(() => {}),
    blob: async (id, path) => {
      const res = await fetch(`/${path.split("/").map(encodeURIComponent).join("/")}`);
      return res.ok ? res.blob() : null;
    },
    history: async () => (await call("/__clips/history")).versions.map((v) => ({ key: v.id, at: v.at, label: v.label || v.kind })),
    historyClip: async (id, key) => (await call(`/__clips/history/clip?id=${encodeURIComponent(key)}`)).clip,
    // In a project the file goes into the clip's renders/ folder
    async saveRender(name, blob) {
      const res = await fetch(`/__clips/renders?name=${encodeURIComponent(name)}`, { method: "POST", headers: { "x-clips-token": TOKEN }, body: blob });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error ?? "файл не сохранился");
      return { name: data.name, url: `/${data.path}`, path: data.path, download: false };
    },
    keep: () => {},
    // what only a project has: Claude, and things the server does
    state: () => call("/__clips/state"),
    change: (body) => call("/__clips/change", body),
    cardAct: (what, id) => call(`/__clips/cards/${what}`, { id }),
    stopJob: (id) => call("/__clips/jobs/stop", { id }),
    setModel: async (model) => (b.settings = (await call("/__clips/settings", { model })).settings),
    record: (layerId) => call("/__clips/record", { layerId }),
    reveal: (path) => call("/__clips/reveal", { path }),
  };
  return b;
}

export const pickBackend = () => (PROJECT ? projectBackend() : browserBackend());
