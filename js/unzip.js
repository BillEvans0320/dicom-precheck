/*
 * ZipReader — ZIP 파일 안의 파일 목록을 읽고, 각 파일을 File처럼 다룰 수 있게 한다 (브라우저·Node 공용)
 *  - ZIP 전체를 메모리에 올리지 않는다. 목록(중앙 디렉터리)만 읽고, 파일 내용은 필요할 때 꺼낸다.
 *  - 압축 없음(stored)과 deflate 압축을 지원한다. deflate는 브라우저 내장 DecompressionStream을 쓴다.
 *  - ZIP64(파일 65,535개 초과, 4GB 초과)를 지원한다.
 *  - 파일 이름: UTF-8 표시가 있으면 UTF-8, 없으면 한국어 윈도우 기본값(CP949)으로 읽는다.
 *  - 암호가 걸린 파일은 읽지 않는다(readable=false).
 */
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.ZipReader = factory();
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  const utf8 = new TextDecoder("utf-8");
  const utf8Strict = new TextDecoder("utf-8", { fatal: true });
  let cp949;
  try { cp949 = new TextDecoder("euc-kr"); } catch (e) { cp949 = utf8; }

  // 파일 이름 해석: UTF-8 표시가 있으면 UTF-8. 표시가 없어도 UTF-8로 올바르게 읽히면 UTF-8(맥에서 만든 ZIP),
  // 아니면 CP949(한국어 윈도우에서 만든 ZIP). 맥의 자모 분리형 한글은 일반형(NFC)으로 바꾼다.
  function decodeName(bytes, flagUtf8) {
    let s;
    if (flagUtf8) s = utf8.decode(bytes);
    else {
      try { s = utf8Strict.decode(bytes); } catch (e) { s = cp949.decode(bytes); }
    }
    return s.normalize("NFC").replace(/\\/g, "/");
  }
  // 맥이 ZIP에 함께 넣는 보조 파일 (__MACOSX/, ._파일, .DS_Store)
  function isSystemJunk(path) {
    return path.split("/").some(seg => seg === "__MACOSX" || seg.startsWith("._") || seg === ".DS_Store");
  }

  async function readRange(blob, start, end) {
    return new Uint8Array(await blob.slice(start, end).arrayBuffer());
  }
  const u16 = (b, p) => b[p] | (b[p + 1] << 8);
  const u32 = (b, p) => (b[p] | (b[p + 1] << 8) | (b[p + 2] << 16) | (b[p + 3] << 24)) >>> 0;
  const u64 = (b, p) => u32(b, p) + u32(b, p + 4) * 0x100000000;

  /** 압축된 내용을 풀어 Uint8Array로 */
  async function inflateRaw(bytes) {
    const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream("deflate-raw"));
    return new Uint8Array(await new Response(stream).arrayBuffer());
  }

  /** ZIP 안의 한 파일. size / slice(a,b).arrayBuffer() / arrayBuffer() 를 File처럼 제공 */
  class ZipEntryFile {
    constructor(zipBlob, info) {
      this.zip = zipBlob;
      this.info = info;
      this.name = info.name.split("/").pop();
      this.size = info.size;
    }
    async _dataStart() {
      if (this._start != null) return this._start;
      const h = await readRange(this.zip, this.info.localOffset, this.info.localOffset + 30);
      if (u32(h, 0) !== 0x04034b50) throw new Error("ZIP 내부 구조 오류");
      this._start = this.info.localOffset + 30 + u16(h, 26) + u16(h, 28);
      return this._start;
    }
    async arrayBuffer() {
      const start = await this._dataStart();
      const raw = await readRange(this.zip, start, start + this.info.compressedSize);
      const out = this.info.method === 0 ? raw : await inflateRaw(raw);
      return out.buffer.slice(out.byteOffset, out.byteOffset + out.byteLength);
    }
    slice(a, b) {
      const self = this;
      return {
        async arrayBuffer() {
          if (self.info.method === 0) {
            const start = await self._dataStart();
            const s = start + (a || 0), e = start + Math.min(b == null ? self.size : b, self.size);
            const r = await readRange(self.zip, s, e);
            return r.buffer.slice(r.byteOffset, r.byteOffset + r.byteLength);
          }
          // 압축된 파일은 일부만 꺼낼 수 없어 전체를 푼 뒤 자른다
          return (await self.arrayBuffer()).slice(a || 0, b == null ? undefined : b);
        },
      };
    }
  }

  /**
   * ZIP 파일(Blob/File)의 목록을 읽는다.
   * 반환: [{path, file(ZipEntryFile), readable, reason}]  (폴더 항목은 제외)
   */
  async function list(zipBlob) {
    const size = zipBlob.size;
    const tailLen = Math.min(size, 65557);
    const tail = await readRange(zipBlob, size - tailLen, size);
    let eocd = -1;
    for (let i = tail.length - 22; i >= 0; i--) {
      if (u32(tail, i) === 0x06054b50) { eocd = i; break; }
    }
    if (eocd < 0) throw new Error("ZIP 파일이 아니거나 손상되었습니다");
    let count = u16(tail, eocd + 10);
    let cdSize = u32(tail, eocd + 12);
    let cdOffset = u32(tail, eocd + 16);
    // ZIP64
    const locPos = eocd - 20;
    if (locPos >= 0 && u32(tail, locPos) === 0x07064b50) {
      const z64Off = u64(tail, locPos + 8);
      const z = await readRange(zipBlob, z64Off, z64Off + 56);
      if (u32(z, 0) === 0x06064b50) {
        count = u64(z, 32);
        cdSize = u64(z, 40);
        cdOffset = u64(z, 48);
      }
    }
    const cd = await readRange(zipBlob, cdOffset, cdOffset + cdSize);
    const out = [];
    let p = 0;
    for (let i = 0; i < count && p + 46 <= cd.length; i++) {
      if (u32(cd, p) !== 0x02014b50) throw new Error("ZIP 목록 구조 오류");
      const flags = u16(cd, p + 8);
      const method = u16(cd, p + 10);
      let compressedSize = u32(cd, p + 20);
      let sizeU = u32(cd, p + 24);
      const nameLen = u16(cd, p + 28), extraLen = u16(cd, p + 30), commentLen = u16(cd, p + 32);
      let localOffset = u32(cd, p + 42);
      let name = decodeName(cd.subarray(p + 46, p + 46 + nameLen), flags & 0x0800);
      // ZIP64 추가 정보: 0xFFFFFFFF인 값만 순서대로 들어 있다
      let e = p + 46 + nameLen;
      const eEnd = e + extraLen;
      while (e + 4 <= eEnd) {
        const id = u16(cd, e), len = u16(cd, e + 2);
        if (id === 0x0001) {
          let q = e + 4;
          if (sizeU === 0xffffffff) { sizeU = u64(cd, q); q += 8; }
          if (compressedSize === 0xffffffff) { compressedSize = u64(cd, q); q += 8; }
          if (localOffset === 0xffffffff) { localOffset = u64(cd, q); q += 8; }
        } else if (id === 0x7075 && len > 5) {
          // Info-ZIP 유니코드 경로 (원래 이름과 별도로 UTF-8 이름을 담은 경우)
          name = decodeName(cd.subarray(e + 9, e + 4 + len), true);
        }
        e += 4 + len;
      }
      p = eEnd + commentLen;
      if (name.endsWith("/") || isSystemJunk(name)) continue;
      const info = { name, method, compressedSize, size: sizeU, localOffset };
      let readable = true, reason = "";
      if (flags & 0x0001) { readable = false; reason = "암호가 걸린 파일"; }
      else if (method !== 0 && method !== 8) { readable = false; reason = `지원하지 않는 압축 방식(${method})`; }
      out.push({ path: name, file: new ZipEntryFile(zipBlob, info), readable, reason });
    }
    return out;
  }

  return { list };
});
