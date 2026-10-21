/*
 * ZipStream — 파일을 하나씩 바로 써 나가는 ZIP 작성기 (압축 없이 저장, 브라우저·Node 공용)
 *  - 전체를 메모리에 모으지 않으므로 큰 데이터에서도 안전하다.
 *  - 파일 65,535개 초과 또는 4GB 초과 시 ZIP64 형식을 사용한다.
 *  - 파일 이름은 UTF-8로 기록한다 (한글 폴더명 유지).
 * sink: { write(Uint8Array) → Promise } 형태의 대상
 */
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.ZipStream = factory();
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  const CRC_TABLE = (() => {
    const t = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      t[n] = c >>> 0;
    }
    return t;
  })();
  function crc32(bytes) {
    let c = 0xffffffff;
    for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  }

  const MAX32 = 0xffffffff;
  const enc = new TextEncoder();

  function dosDateTime(d) {
    const time = (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1);
    const date = ((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate();
    return { time, date };
  }

  class Writer {
    constructor(size) { this.buf = new Uint8Array(size); this.v = new DataView(this.buf.buffer); this.p = 0; }
    u16(x) { this.v.setUint16(this.p, x, true); this.p += 2; return this; }
    u32(x) { this.v.setUint32(this.p, x >>> 0, true); this.p += 4; return this; }
    u64(x) { this.v.setUint32(this.p, x % 0x100000000, true); this.v.setUint32(this.p + 4, Math.floor(x / 0x100000000), true); this.p += 8; return this; }
    bytes(b) { this.buf.set(b, this.p); this.p += b.length; return this; }
  }

  class ZipStream {
    constructor(sink) {
      this.sink = sink;
      this.offset = 0;
      this.entries = [];
      this.stamp = dosDateTime(new Date());
    }

    async _write(b) {
      await this.sink.write(b);
      this.offset += b.length;
    }

    async addFile(path, data) {
      if (data.length >= MAX32) throw new Error("4GB 이상인 단일 파일은 지원하지 않습니다: " + path);
      const name = enc.encode(path.replace(/\\/g, "/"));
      const crc = crc32(data);
      const local = new Writer(30 + name.length)
        .u32(0x04034b50).u16(20).u16(0x0800).u16(0)
        .u16(this.stamp.time).u16(this.stamp.date)
        .u32(crc).u32(data.length).u32(data.length)
        .u16(name.length).u16(0).bytes(name);
      this.entries.push({ name, crc, size: data.length, offset: this.offset });
      await this._write(local.buf);
      await this._write(data);
    }

    async finish() {
      const cdStart = this.offset;
      // 중앙 디렉터리 (작은 조각을 모아서 쓴다)
      let chunk = [];
      let chunkSize = 0;
      for (const e of this.entries) {
        const z64 = e.offset >= MAX32;
        const extraLen = z64 ? 12 : 0;
        const w = new Writer(46 + e.name.length + extraLen)
          .u32(0x02014b50).u16(z64 ? 45 : 20).u16(z64 ? 45 : 20).u16(0x0800).u16(0)
          .u16(this.stamp.time).u16(this.stamp.date)
          .u32(e.crc).u32(e.size).u32(e.size)
          .u16(e.name.length).u16(extraLen).u16(0).u16(0).u16(0).u32(0)
          .u32(z64 ? MAX32 : e.offset).bytes(e.name);
        if (z64) w.u16(0x0001).u16(8).u64(e.offset);
        chunk.push(w.buf);
        chunkSize += w.buf.length;
        if (chunkSize > (1 << 20)) { await this._write(concat(chunk, chunkSize)); chunk = []; chunkSize = 0; }
      }
      if (chunk.length) await this._write(concat(chunk, chunkSize));
      const cdSize = this.offset - cdStart;
      const n = this.entries.length;
      const needZip64 = n > 0xffff || cdStart >= MAX32 || cdSize >= MAX32;
      if (needZip64) {
        const z64EocdOffset = this.offset;
        await this._write(new Writer(56)
          .u32(0x06064b50).u64(44).u16(45).u16(45).u32(0).u32(0)
          .u64(n).u64(n).u64(cdSize).u64(cdStart).buf);
        await this._write(new Writer(20).u32(0x07064b50).u32(0).u64(z64EocdOffset).u32(1).buf);
      }
      await this._write(new Writer(22)
        .u32(0x06054b50).u16(0).u16(0)
        .u16(needZip64 ? 0xffff : n).u16(needZip64 ? 0xffff : n)
        .u32(needZip64 ? MAX32 : cdSize).u32(needZip64 ? MAX32 : cdStart).u16(0).buf);
      return { files: n, bytes: this.offset };
    }
  }

  function concat(parts, size) {
    const out = new Uint8Array(size);
    let p = 0;
    for (const b of parts) { out.set(b, p); p += b.length; }
    return out;
  }

  ZipStream.crc32 = crc32;
  return ZipStream;
});
