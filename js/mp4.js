// A small MP4 writer: H.264 video and one sound track (AAC or Opus) from WebCodecs chunks into one file.
// Everything is kept in memory and written at the end with the index first (so the file plays while it downloads).
// The clips this editor makes are seconds to a few minutes long, which is what this is for.

const u8 = (...n) => new Uint8Array(n);
const u16 = (n) => u8(n >> 8, n & 255);
const u32 = (n) => u8((n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255);
const str = (s) => new Uint8Array([...s].map((c) => c.charCodeAt(0)));
const zeros = (n) => new Uint8Array(n);

function concat(parts) {
  let size = 0;
  for (const p of parts) size += p.length;
  const out = new Uint8Array(size);
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}
const box = (type, ...parts) => {
  const body = concat(parts);
  return concat([u32(body.length + 8), str(type), body]);
};
const full = (type, version, flags, ...parts) => box(type, u8(version, (flags >> 16) & 255, (flags >> 8) & 255, flags & 255), ...parts);
const MATRIX = concat([u32(0x10000), u32(0), u32(0), u32(0), u32(0x10000), u32(0), u32(0), u32(0), u32(0x40000000)]);

// An MPEG-4 descriptor: tag, length (one byte is enough below 128), body
const desc = (tag, ...parts) => {
  const body = concat(parts);
  if (body.length > 127) throw new Error("descriptor too long");
  return concat([u8(tag, body.length), body]);
};

export class Mp4 {
  constructor({ width, height, fps }) {
    this.width = width;
    this.height = height;
    this.fps = fps;
    this.video = { samples: [], config: null };
    this.audio = null; // { codec: "aac" | "opus", samples, config, rate, channels, frame }
  }

  addVideo(chunk, meta) {
    if (meta?.decoderConfig?.description && !this.video.config) this.video.config = new Uint8Array(meta.decoderConfig.description.slice ? meta.decoderConfig.description.slice(0) : meta.decoderConfig.description);
    const data = new Uint8Array(chunk.byteLength);
    chunk.copyTo(data);
    this.video.samples.push({ data, key: chunk.type === "key", time: chunk.timestamp });
  }

  startAudio({ codec, rate, channels }) {
    this.audio = { codec, samples: [], config: null, rate, channels, frame: codec === "aac" ? 1024 : 960 };
  }
  addAudio(chunk, meta) {
    const a = this.audio;
    if (meta?.decoderConfig?.description && !a.config) a.config = new Uint8Array(meta.decoderConfig.description.slice(0));
    const data = new Uint8Array(chunk.byteLength);
    chunk.copyTo(data);
    a.samples.push({ data, duration: chunk.duration ? Math.round((chunk.duration * a.rate) / 1e6) : a.frame });
  }

  finish() {
    const v = this.video;
    if (!v.samples.length || !v.config) throw new Error("no video was encoded");
    const a = this.audio?.samples.length ? this.audio : null;
    const VSCALE = this.fps * 1000;
    const VDELTA = 1000;
    const vDur = v.samples.length * VDELTA;
    const aDur = a ? a.samples.reduce((n, s) => n + s.duration, 0) : 0;
    const MOVIE = 1000;
    const movieDur = Math.round(Math.max((vDur / VSCALE) * MOVIE, a ? (aDur / a.rate) * MOVIE : 0));

    // The file's data: about a second of video, then about a second of sound, and so on
    const vPer = Math.max(1, Math.round(this.fps));
    const aPer = a ? Math.max(1, Math.round(a.rate / a.frame)) : 0;
    const chunksOf = (samples, per) => {
      const out = [];
      for (let i = 0; i < samples.length; i += per) out.push(samples.slice(i, i + per));
      return out;
    };
    const vChunks = chunksOf(v.samples, vPer);
    const aChunks = a ? chunksOf(a.samples, aPer) : [];
    const order = [];
    for (let i = 0; i < Math.max(vChunks.length, aChunks.length); i++) {
      if (vChunks[i]) order.push({ track: "v", samples: vChunks[i] });
      if (aChunks[i]) order.push({ track: "a", samples: aChunks[i] });
    }

    // Presentation times against decode times: the same unless the encoder reordered frames
    const cts = v.samples.map((s, i) => Math.round((s.time * VSCALE) / 1e6) - i * VDELTA);
    const shift = -Math.min(0, ...cts);
    const reordered = cts.some((c) => c !== cts[0]);

    const stbl = (stsd, samples, chunks, per, extra = []) => {
      const stsc = [];
      if (chunks.length) {
        stsc.push([1, chunks[0].length]);
        const last = chunks.at(-1).length;
        if (chunks.length > 1 && last !== chunks[0].length) stsc.push([chunks.length, last]);
      }
      return (offsets) =>
        box(
          "stbl",
          stsd,
          ...extra,
          full("stsc", 0, 0, u32(stsc.length), ...stsc.map(([first, n]) => concat([u32(first), u32(n), u32(1)]))),
          full("stsz", 0, 0, u32(0), u32(samples.length), ...samples.map((s) => u32(s.data.length))),
          full("stco", 0, 0, u32(offsets.length), ...offsets.map(u32)),
        );
    };

    const avc1 = box(
      "avc1",
      zeros(6), u16(1), zeros(16), u16(this.width), u16(this.height), u32(0x480000), u32(0x480000), u32(0), u16(1), zeros(32), u16(0x18), u16(0xffff),
      box("avcC", v.config),
      box("colr", str("nclx"), u16(1), u16(1), u16(1), u8(0)), // BT.709, video range
    );
    const vStbl = stbl(
      full("stsd", 0, 0, u32(1), avc1),
      v.samples,
      vChunks,
      vPer,
      [
        full("stts", 0, 0, u32(1), u32(v.samples.length), u32(VDELTA)),
        full("stss", 0, 0, u32(v.samples.filter((s) => s.key).length), ...v.samples.map((s, i) => (s.key ? u32(i + 1) : null)).filter(Boolean)),
        ...(reordered ? [full("ctts", 0, 0, u32(cts.length), ...cts.map((c) => concat([u32(1), u32(c + shift)])))] : []),
      ],
    );

    let aStbl = null;
    if (a) {
      let entry;
      if (a.codec === "aac") {
        const esds = full(
          "esds", 0, 0,
          desc(0x03, u16(1), u8(0), desc(0x04, u8(0x40, 0x15), u8(0, 0, 0), u32(0), u32(0), desc(0x05, a.config ?? u8(0x11, 0x90))), desc(0x06, u8(2))),
        );
        entry = box("mp4a", zeros(6), u16(1), zeros(8), u16(a.channels), u16(16), u16(0), u16(0), u32(a.rate * 65536), esds);
      } else {
        // Opus in MP4: the stream's own header says how many samples to skip at the start
        const head = a.config;
        const preSkip = head && head.length >= 12 ? head[10] | (head[11] << 8) : 312;
        const dOps = box("dOps", u8(0, a.channels), u16(preSkip), u32(a.rate), u16(0), u8(0));
        entry = box("Opus", zeros(6), u16(1), zeros(8), u16(a.channels), u16(16), u16(0), u16(0), u32(a.rate * 65536), dOps);
      }
      // sample durations, run-length
      const runs = [];
      for (const s of a.samples) {
        if (runs.length && runs.at(-1)[1] === s.duration) runs.at(-1)[0]++;
        else runs.push([1, s.duration]);
      }
      aStbl = stbl(full("stsd", 0, 0, u32(1), entry), a.samples, aChunks, aPer, [full("stts", 0, 0, u32(runs.length), ...runs.map(([n, d]) => concat([u32(n), u32(d)])))]);
    }

    const trak = (id, isVideo, scale, dur, stblBox) =>
      box(
        "trak",
        full("tkhd", 0, 3, u32(0), u32(0), u32(id), u32(0), u32(Math.round((dur / scale) * MOVIE)), zeros(8), u16(0), u16(0), u16(isVideo ? 0 : 0x100), u16(0), MATRIX, u32(isVideo ? this.width * 65536 : 0), u32(isVideo ? this.height * 65536 : 0)),
        box(
          "mdia",
          full("mdhd", 0, 0, u32(0), u32(0), u32(scale), u32(dur), u16(0x55c4), u16(0)),
          full("hdlr", 0, 0, u32(0), str(isVideo ? "vide" : "soun"), zeros(12), str(isVideo ? "Video" : "Sound"), u8(0)),
          box("minf", isVideo ? full("vmhd", 0, 1, zeros(8)) : full("smhd", 0, 0, zeros(4)), box("dinf", full("dref", 0, 0, u32(1), full("url ", 0, 1))), stblBox),
        ),
      );

    const moov = (vOff, aOff) =>
      box(
        "moov",
        full("mvhd", 0, 0, u32(0), u32(0), u32(MOVIE), u32(movieDur), u32(0x10000), u16(0x100), zeros(10), MATRIX, zeros(24), u32(a ? 3 : 2)),
        trak(1, true, VSCALE, vDur, vStbl(vOff)),
        ...(a ? [trak(2, false, a.rate, aDur, aStbl(aOff))] : []),
      );

    const ftyp = box("ftyp", str("isom"), u32(0x200), str("isom"), str("iso2"), str("avc1"), str("mp41"));
    // The index holds every chunk's place in the file, and the places depend on the index's own size: its size
    // doesn't change with the numbers in it, so it is laid out once with zeros to be measured
    const head = ftyp.length + moov(vChunks.map(() => 0), aChunks.map(() => 0)).length + 8;
    const vOff = [];
    const aOff = [];
    let at = head;
    for (const c of order) {
      (c.track === "v" ? vOff : aOff).push(at);
      for (const s of c.samples) at += s.data.length;
    }
    const dataSize = at - head;
    if (at > 0xffffffff) throw new Error("the video is too large for this writer (over 4 GB)");
    const parts = [ftyp, moov(vOff, aOff), u32(dataSize + 8), str("mdat")];
    for (const c of order) for (const s of c.samples) parts.push(s.data);
    return new Blob(parts, { type: "video/mp4" });
  }
}
