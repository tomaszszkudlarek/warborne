// Map files (.wlmap): a generated map saved whole, so the game plays exactly what the
// generator produced even after the generator changes. Pure JS (browser and Node 18+).
//
// Layout, gzip-compressed:  "WLMAP1\n" | uint32 header length | JSON header | binary blob
// The JSON header is the map object with every typed array replaced by
// { $ta: 'Float32Array', o: byteOffset, n: length } into the blob (8-byte aligned), and
// non-finite numbers by { $num: 'Infinity' | '-Infinity' | 'NaN' }.

export const MAP_FILE_EXT = '.wlmap';
const MAGIC = 'WLMAP1\n';
const TYPED = { Float32Array, Float64Array, Int8Array, Uint8Array, Int16Array, Uint16Array, Int32Array, Uint32Array };

/** Map object -> gzip-compressed bytes (Uint8Array). `meta` ({ name, ... }) is stored as map.meta. */
export async function encodeMap(map, meta = {}) {
  const chunks = [];
  let size = 0;
  const walk = (v) => {
    if (ArrayBuffer.isView(v)) {
      const pad = (8 - (size % 8)) % 8;
      if (pad) { chunks.push(new Uint8Array(pad)); size += pad; }
      const bytes = new Uint8Array(v.buffer, v.byteOffset, v.byteLength);
      chunks.push(bytes.slice());
      const ref = { $ta: v.constructor.name, o: size, n: v.length };
      size += v.byteLength;
      return ref;
    }
    if (typeof v === 'number' && !Number.isFinite(v)) return { $num: String(v) };
    if (Array.isArray(v)) return v.map(walk);
    if (v && typeof v === 'object') {
      const o = {};
      for (const [k, x] of Object.entries(v)) if (typeof x !== 'function' && x !== undefined) o[k] = walk(x);
      return o;
    }
    return v;
  };
  const header = walk({ ...map, meta: { ...(map.meta ?? {}), ...meta, savedAt: new Date().toISOString() } });
  const json = new TextEncoder().encode(JSON.stringify(header));
  const magic = new TextEncoder().encode(MAGIC);
  const out = new Uint8Array(magic.length + 4 + json.length + size);
  out.set(magic, 0);
  new DataView(out.buffer).setUint32(magic.length, json.length, true);
  out.set(json, magic.length + 4);
  let p = magic.length + 4 + json.length;
  for (const c of chunks) { out.set(c, p); p += c.length; }
  return gzip(out);
}

/** Bytes (ArrayBuffer / Uint8Array, gzipped or not) -> map object. */
export async function decodeMap(data) {
  let bytes = data instanceof Uint8Array ? data : new Uint8Array(data);
  if (bytes[0] === 0x1f && bytes[1] === 0x8b) bytes = await gunzip(bytes);
  const magic = new TextDecoder().decode(bytes.subarray(0, MAGIC.length));
  if (magic !== MAGIC) throw new Error('Not a Warlords map file');
  const len = new DataView(bytes.buffer, bytes.byteOffset).getUint32(MAGIC.length, true);
  const start = MAGIC.length + 4;
  const header = JSON.parse(new TextDecoder().decode(bytes.subarray(start, start + len)));
  const blobAt = start + len;
  // copy the blob into an aligned buffer so typed views can sit on it
  const blob = bytes.slice(blobAt).buffer;
  const revive = (v) => {
    if (Array.isArray(v)) return v.map(revive);
    if (v && typeof v === 'object') {
      if (v.$ta) {
        const T = TYPED[v.$ta];
        return new T(blob.slice(v.o, v.o + v.n * T.BYTES_PER_ELEMENT));
      }
      if (v.$num) return Number(v.$num);
      const o = {};
      for (const [k, x] of Object.entries(v)) o[k] = revive(x);
      return o;
    }
    return v;
  };
  return revive(header);
}

async function pipe(bytes, stream) {
  const res = new Response(new Blob([bytes]).stream().pipeThrough(stream));
  return new Uint8Array(await res.arrayBuffer());
}
const gzip = (b) => pipe(b, new CompressionStream('gzip'));
const gunzip = (b) => pipe(b, new DecompressionStream('gzip'));
