// Minimal ZIP reader: enough to pull icons out of an APK and split APKs out of .apks/.xapk bundles.
const fs = require('fs');
const zlib = require('zlib');
const { pipeline } = require('stream/promises');

class Zip {
  static async open(file) {
    const fh = await fs.promises.open(file, 'r');
    try {
      const { size } = await fh.stat();
      const tailLen = Math.min(size, 65557);
      const tail = Buffer.alloc(tailLen);
      await fh.read(tail, 0, tailLen, size - tailLen);
      let eocd = -1;
      for (let i = tailLen - 22; i >= 0; i--) {
        if (tail.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
      }
      if (eocd < 0) throw new Error('Not a valid zip/APK file');
      const count = tail.readUInt16LE(eocd + 10);
      const cdSize = tail.readUInt32LE(eocd + 12);
      const cdOffset = tail.readUInt32LE(eocd + 16);
      if (cdOffset === 0xffffffff || count === 0xffff) throw new Error('ZIP64 archives are not supported');
      const cd = Buffer.alloc(cdSize);
      await fh.read(cd, 0, cdSize, cdOffset);
      const entries = new Map();
      for (let p = 0, n = 0; n < count && p + 46 <= cd.length; n++) {
        if (cd.readUInt32LE(p) !== 0x02014b50) break;
        const nameLen = cd.readUInt16LE(p + 28);
        const extraLen = cd.readUInt16LE(p + 30);
        const commentLen = cd.readUInt16LE(p + 32);
        const name = cd.toString('utf8', p + 46, p + 46 + nameLen);
        entries.set(name, {
          name,
          method: cd.readUInt16LE(p + 10),
          compSize: cd.readUInt32LE(p + 20),
          size: cd.readUInt32LE(p + 24),
          localOffset: cd.readUInt32LE(p + 42),
        });
        p += 46 + nameLen + extraLen + commentLen;
      }
      return new Zip(file, fh, entries);
    } catch (e) {
      await fh.close();
      throw e;
    }
  }

  constructor(file, fh, entries) {
    this.file = file;
    this.fh = fh;
    this.entries = entries;
  }

  async dataOffset(entry) {
    const h = Buffer.alloc(30);
    await this.fh.read(h, 0, 30, entry.localOffset);
    if (h.readUInt32LE(0) !== 0x04034b50) throw new Error(`Bad local header for ${entry.name}`);
    return entry.localOffset + 30 + h.readUInt16LE(26) + h.readUInt16LE(28);
  }

  async read(name) {
    const entry = this.entries.get(name);
    if (!entry) return null;
    const start = await this.dataOffset(entry);
    const raw = Buffer.alloc(entry.compSize);
    await this.fh.read(raw, 0, entry.compSize, start);
    if (entry.method === 0) return raw;
    if (entry.method === 8) return zlib.inflateRawSync(raw);
    throw new Error(`Unsupported compression in ${name}`);
  }

  async extract(name, dest) {
    const entry = this.entries.get(name);
    if (!entry) throw new Error(`Missing ${name}`);
    const start = await this.dataOffset(entry);
    const src = fs.createReadStream(this.file, { start, end: start + entry.compSize - 1 });
    const out = fs.createWriteStream(dest);
    if (entry.compSize === 0) return void out.end();
    if (entry.method === 0) await pipeline(src, out);
    else if (entry.method === 8) await pipeline(src, zlib.createInflateRaw(), out);
    else throw new Error(`Unsupported compression in ${name}`);
  }

  close() {
    return this.fh.close();
  }
}

module.exports = { Zip };
