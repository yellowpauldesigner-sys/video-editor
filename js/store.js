// Where the editor keeps its work: this browser's own storage (IndexedDB). Clips, their media files and the
// points to go back to live here; nothing is uploaded anywhere. If the browser refuses storage (a private window),
// everything still works in memory for as long as the page is open, and the editor says so.

const DB = "uberdesigner-clips";
let db = null;
let memory = null; // the stand-in when storage isn't there: store name → Map

const STORES = ["clips", "media", "history", "meta"];

function open() {
  if (db || memory) return Promise.resolve();
  return new Promise((resolve) => {
    const fallback = () => {
      memory = Object.fromEntries(STORES.map((s) => [s, new Map()]));
      resolve();
    };
    let req;
    try {
      req = indexedDB.open(DB, 1);
    } catch {
      return fallback();
    }
    req.onupgradeneeded = () => {
      const d = req.result;
      d.createObjectStore("clips"); // id → { id, clip, updatedAt }
      d.createObjectStore("media"); // "<clip id>|<path>" → { clipId, path, name, kind, blob, info }
      d.createObjectStore("history"); // "<clip id>|<n>" → { clipId, n, at, label, clip }
      d.createObjectStore("meta");
    };
    req.onsuccess = () => {
      db = req.result;
      resolve();
    };
    req.onerror = fallback;
    req.onblocked = fallback;
  });
}

export const persistent = () => !memory;

async function tx(store, mode, fn) {
  await open();
  if (memory) return fn({ mem: memory[store] });
  return new Promise((resolve, reject) => {
    const t = db.transaction(store, mode);
    const s = t.objectStore(store);
    let out;
    Promise.resolve(fn({ s })).then((v) => (out = v), reject);
    t.oncomplete = () => resolve(out);
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error ?? new Error("storage refused the write"));
  });
}
const req = (r) => new Promise((res, rej) => ((r.onsuccess = () => res(r.result)), (r.onerror = () => rej(r.error))));

const get = (store, key) => tx(store, "readonly", ({ s, mem }) => (mem ? mem.get(key) : req(s.get(key))));
const put = (store, key, value) => tx(store, "readwrite", ({ s, mem }) => (mem ? void mem.set(key, value) : req(s.put(value, key))));
const del = (store, key) => tx(store, "readwrite", ({ s, mem }) => (mem ? void mem.delete(key) : req(s.delete(key))));
const all = (store, prefix) =>
  tx(store, "readonly", async ({ s, mem }) => {
    if (mem) return [...mem.entries()].filter(([k]) => !prefix || k.startsWith(prefix)).map(([, v]) => v);
    return req(prefix ? s.getAll(IDBKeyRange.bound(prefix, `${prefix}￿`)) : s.getAll());
  });
const keys = (store, prefix) =>
  tx(store, "readonly", async ({ s, mem }) => {
    if (mem) return [...mem.keys()].filter((k) => k.startsWith(prefix));
    return req(s.getAllKeys(IDBKeyRange.bound(prefix, `${prefix}￿`)));
  });

// ---------- clips ----------

export const listClips = async () => (await all("clips")).map((c) => ({ id: c.id, name: c.clip.name, updatedAt: c.updatedAt })).sort((a, b) => b.updatedAt - a.updatedAt);
export const loadClip = async (id) => (await get("clips", id))?.clip ?? null;
export const saveClip = (id, clip) => put("clips", id, { id, clip, updatedAt: Date.now() });
export const newId = () => `c${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
export const lastOpened = () => get("meta", "last");
export const setLastOpened = (id) => put("meta", "last", id);

export async function deleteClip(id) {
  for (const k of await keys("media", `${id}|`)) await del("media", k);
  for (const k of await keys("history", `${id}|`)) await del("history", k);
  await del("clips", id);
}

// ---------- media ----------

export const listMedia = (clipId) => all("media", `${clipId}|`);
export const putMedia = (clipId, item) => put("media", `${clipId}|${item.path}`, { ...item, clipId });
export const deleteMedia = (clipId, path) => del("media", `${clipId}|${path}`);

// ---------- points to go back to ----------

const pad = (n) => String(n).padStart(6, "0");
export async function listHistory(clipId) {
  return (await all("history", `${clipId}|`)).map(({ n, at, label }) => ({ n, at, label })).sort((a, b) => b.n - a.n);
}
export const historyClip = async (clipId, n) => (await get("history", `${clipId}|${pad(n)}`))?.clip ?? null;

// A run of small edits is one point; a new point is made when the label changes or a minute has passed
export async function recordHistory(clipId, clip, label) {
  const list = await listHistory(clipId);
  const last = list[0];
  const now = Date.now();
  if (last && last.label === label && now - last.at < 60_000) {
    await put("history", `${clipId}|${pad(last.n)}`, { clipId, n: last.n, at: now, label, clip });
    return;
  }
  const n = (last?.n ?? 0) + 1;
  await put("history", `${clipId}|${pad(n)}`, { clipId, n, at: now, label, clip });
  for (const old of list.slice(59)) await del("history", `${clipId}|${pad(old.n)}`); // the last 60 are kept
}

// How much room the browser gives this site, when it says
export async function room() {
  try {
    const e = await navigator.storage.estimate();
    return { used: e.usage ?? 0, quota: e.quota ?? 0 };
  } catch {
    return null;
  }
}
// Ask the browser not to clear this site's storage when the disk runs low
export const keep = () => navigator.storage?.persist?.().catch(() => false);
