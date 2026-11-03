// MediaRecorder MP4s can have either one sample table or many fragments.
// Count only video samples and their media timestamps. Skip the video payload:
// inspecting a 500 MB take must not read 500 MB into memory on an iPhone.
const u32 = (v, at) => v.getUint32(at);
const u64 = (v, at) => u32(v, at) * 2 ** 32 + u32(v, at + 4);
const fourcc = (v, at) => String.fromCharCode(...new Uint8Array(v.buffer, v.byteOffset + at, 4));
function header(view, offset, remaining) {
  let size = u32(view, offset);
  const large = size === 1;
  size = large ? u64(view, offset + 8) : size || remaining;
  const head = large ? 16 : 8;
  if (!Number.isSafeInteger(size) || size < head || size > remaining) throw RangeError();
  return { type: fourcc(view, offset + 4), size, head };
}
function* children(view, wanted) {
  for (let offset = 0; offset < view.byteLength;) {
    const { type, size, head } = header(view, offset, view.byteLength - offset);
    if (type === wanted) yield new DataView(view.buffer, view.byteOffset + offset + head, size - head);
    offset += size;
  }
}
const first = (view, type) => children(view, type).next().value;
function videoTable(moov) {
  for (const trak of children(moov, 'trak')) {
    const mdia = first(trak, 'mdia');
    if (fourcc(first(mdia, 'hdlr'), 8) !== 'vide') continue;
    const tkhd = first(trak, 'tkhd'), mdhd = first(mdia, 'mdhd');
    const id = u32(tkhd, tkhd.getUint8(0) ? 20 : 12);
    const scale = u32(mdhd, mdhd.getUint8(0) ? 20 : 12);
    let count = 0, end = 0, defaultDuration = 0;
    const stts = first(first(first(mdia, 'minf'), 'stbl'), 'stts');
    const entries = u32(stts, 4);
    for (let i = 0; i < entries; i++) {
      const n = u32(stts, 8 + i * 8);
      count += n;
      end += n * u32(stts, 12 + i * 8);
    }
    const mvex = first(moov, 'mvex');
    if (mvex) for (const trex of children(mvex, 'trex')) {
      if (u32(trex, 4) === id) defaultDuration = u32(trex, 12);
    }
    return { id, scale, count, start: count ? 0 : null, end, defaultDuration };
  }
}
function addFragment(meta, moof) {
  for (const traf of children(moof, 'traf')) {
    const tfhd = first(traf, 'tfhd');
    if (u32(tfhd, 4) !== meta.id) continue;
    const flags = u32(tfhd, 0), tfdt = first(traf, 'tfdt');
    const fixed = flags & 8 ? u32(tfhd, 8 + (flags & 1 ? 8 : 0) + (flags & 2 ? 4 : 0)) : meta.defaultDuration;
    let time = tfdt ? (tfdt.getUint8(0) ? u64(tfdt, 4) : u32(tfdt, 4)) : meta.end;
    if (meta.start == null) meta.start = time;
    for (const run of children(traf, 'trun')) {
      const fields = u32(run, 0), n = u32(run, 4);
      if (fields & 0x100) {
        let at = 8 + (fields & 1 ? 4 : 0) + (fields & 4 ? 4 : 0);
        const stride = 4 + [0x200, 0x400, 0x800].filter(bit => fields & bit).length * 4;
        if (at + n * stride > run.byteLength) throw RangeError();
        for (let i = 0; i < n; i++, at += stride) time += u32(run, at);
      } else {
        if (!fixed && n) throw RangeError();
        time += n * fixed;
      }
      meta.count += n;
    }
    meta.end = Math.max(meta.end, time);
  }
}
export async function readTakeFrameRate(blob, current = () => true) {
  if (!/mp4|quicktime/i.test(blob.type)) return null;
  try {
    let track, bytes = 0, boxes = 0;
    for (let at = 0; at < blob.size;) {
      if (!current() || ++boxes > 10000) return null;
      const view = new DataView(await blob.slice(at, at + 16).arrayBuffer());
      const { type, size, head } = header(view, 0, blob.size - at);
      if (type === 'moov' || type === 'moof') {
        bytes += size;
        if (size > 4 * 1024 ** 2 || bytes > 16 * 1024 ** 2) return null;
        const data = new DataView(await blob.slice(at + head, at + size).arrayBuffer());
        if (type === 'moov') { if (track) return null; track = videoTable(data); }
        else addFragment(track, data);
      }
      at += size;
    }
    if (!track || track.start == null || track.count < 2) return null;
    const rate = track.scale * track.count / (track.end - track.start);
    return Number.isFinite(rate) && rate > 0 && rate <= 240 ? rate : null;
  } catch { return null; } // Unknown file layout: keep playback and export available.
}
