/* Minimal streaming ZIP writer (store method, UTF-8 names, data
   descriptors) — packs R2 objects into an archive on the fly without
   buffering files in memory. Classic (non-ZIP64) format: callers must
   keep every file and the whole archive under 4 GB and 65k entries. */

export const ZIP_MAX_BYTES = 0xFFFF0000; // ~4 GB, leaves room for headers
export const ZIP_MAX_FILES = 65000;

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function dosDateTime(date) {
  const d = date instanceof Date && !Number.isNaN(date.getTime()) ? date : new Date();
  const year = Math.max(1980, d.getFullYear());
  return {
    dosTime: (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1),
    dosDate: ((year - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate(),
  };
}

/** entries: [{ name, mtime?, open: () => Promise<ReadableStream> }] →
    ReadableStream of the resulting .zip */
export function zipStream(entries) {
  const { readable, writable } = new TransformStream();
  writeZip(entries, writable); // pump runs for the life of the response
  return readable;
}

async function writeZip(entries, writable) {
  const writer = writable.getWriter();
  const encoder = new TextEncoder();
  const central = [];
  let offset = 0;

  const write = async (bytes) => {
    await writer.write(bytes);
    offset += bytes.length;
  };

  try {
    for (const entry of entries) {
      const nameBytes = encoder.encode(entry.name);
      const { dosTime, dosDate } = dosDateTime(entry.mtime);
      const headerOffset = offset;

      /* local header: sizes/CRC deferred to the data descriptor (bit 3),
         names are UTF-8 (bit 11) */
      const lfh = new DataView(new ArrayBuffer(30));
      lfh.setUint32(0, 0x04034B50, true);
      lfh.setUint16(4, 20, true);
      lfh.setUint16(6, 0x0808, true);
      lfh.setUint16(8, 0, true);
      lfh.setUint16(10, dosTime, true);
      lfh.setUint16(12, dosDate, true);
      lfh.setUint16(26, nameBytes.length, true);
      await write(new Uint8Array(lfh.buffer));
      await write(nameBytes);

      let crc = 0xFFFFFFFF;
      let size = 0;
      const reader = (await entry.open()).getReader();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        for (let i = 0; i < value.length; i++) {
          crc = CRC_TABLE[(crc ^ value[i]) & 0xFF] ^ (crc >>> 8);
        }
        size += value.length;
        await write(value);
      }
      crc = (crc ^ 0xFFFFFFFF) >>> 0;

      const dd = new DataView(new ArrayBuffer(16));
      dd.setUint32(0, 0x08074B50, true);
      dd.setUint32(4, crc, true);
      dd.setUint32(8, size, true);
      dd.setUint32(12, size, true);
      await write(new Uint8Array(dd.buffer));

      central.push({ nameBytes, crc, size, headerOffset, dosTime, dosDate });
    }

    const cdStart = offset;
    for (const e of central) {
      const cd = new DataView(new ArrayBuffer(46));
      cd.setUint32(0, 0x02014B50, true);
      cd.setUint16(4, 20, true);
      cd.setUint16(6, 20, true);
      cd.setUint16(8, 0x0808, true);
      cd.setUint16(10, 0, true);
      cd.setUint16(12, e.dosTime, true);
      cd.setUint16(14, e.dosDate, true);
      cd.setUint32(16, e.crc, true);
      cd.setUint32(20, e.size, true);
      cd.setUint32(24, e.size, true);
      cd.setUint16(28, e.nameBytes.length, true);
      cd.setUint32(42, e.headerOffset, true);
      await write(new Uint8Array(cd.buffer));
      await write(e.nameBytes);
    }

    const eocd = new DataView(new ArrayBuffer(22));
    eocd.setUint32(0, 0x06054B50, true);
    eocd.setUint16(8, central.length, true);
    eocd.setUint16(10, central.length, true);
    eocd.setUint32(12, offset - cdStart, true);
    eocd.setUint32(16, cdStart, true);
    await write(new Uint8Array(eocd.buffer));
    await writer.close();
  } catch (err) {
    await writer.abort(err).catch(() => {});
  }
}

/** List every file under an R2 prefix and build zip entries whose names
    live inside <rootName>/. Returns { entries, total } or { error }. */
export async function collectZipEntries(bucket, prefix, rootName) {
  const entries = [];
  let total = 0;
  let cursor;
  do {
    const page = await bucket.list({ prefix, cursor, limit: 1000 });
    for (const obj of page.objects) {
      const rel = obj.key.slice(prefix.length);
      if (!rel || rel.endsWith('/.keep')) continue;
      if (rel === '.keep') continue;
      if (obj.size >= ZIP_MAX_BYTES) return { error: 'too-large' };
      total += obj.size;
      entries.push({
        name: `${rootName}/${rel}`,
        mtime: obj.uploaded ? new Date(obj.uploaded) : new Date(),
        open: async () => {
          const object = await bucket.get(obj.key);
          if (!object) throw new Error(`object vanished: ${obj.key}`);
          return object.body;
        },
      });
    }
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor);

  if (entries.length > ZIP_MAX_FILES) return { error: 'too-many-files' };
  /* rough per-entry overhead: headers + descriptor + name twice */
  const overhead = entries.reduce((sum, e) => sum + 100 + 2 * e.name.length, 22);
  if (total + overhead >= ZIP_MAX_BYTES) return { error: 'too-large' };
  return { entries, total };
}

export function zipResponse(entries, zipName) {
  return new Response(zipStream(entries), {
    headers: {
      'Content-Type': 'application/zip',
      'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(zipName)}`,
      'Cache-Control': 'no-store',
    },
  });
}
