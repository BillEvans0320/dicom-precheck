/*
 * DeidCore — 판정 로직 (브라우저와 Node 공용)
 *  - DICOM 헤더 읽기 (영상 데이터 앞까지만)
 *  - 후보 선정 (SOP Class, 헤더 단서)
 *  - 픽셀 → 회색조 이미지 (비압축만), OCR 전처리
 *  - OCR 결과에서 환자정보 항목 이름 찾기
 * 환자정보 값 자체는 반환하지 않는다.
 */
(function (root, factory) {
  if (typeof module === "object" && module.exports) {
    module.exports = factory(require("dicom-parser"));
  } else {
    root.DeidCore = factory(root.dicomParser);
  }
})(typeof self !== "undefined" ? self : this, function (dicomParser) {
  "use strict";

  const PIXEL_TAG = "x7fe00010";

  // 보고서형 SOP Class (주 후보)
  const PRIMARY_SOP = [
    ["1.2.840.10008.5.1.4.1.1.7", "Secondary Capture"],
    ["1.2.840.10008.5.1.4.1.1.104.", "Encapsulated document (PDF 등)"],
    ["1.2.840.10008.5.1.4.1.1.88.", "Structured Report"],
    ["1.2.840.10008.5.1.4.1.1.9.", "Waveform (ECG 등)"],
    ["1.2.840.10008.1.3.10", "DICOMDIR (환자 목록 파일)"],
  ];
  // 헤더 단서로 볼 Modality
  const CLUE_MODALITIES = new Set(["OT", "SC", "DOC", "SR", "ECG", "EK", "US", "XC", "SMR"]);
  const SMALL_SERIES_MAX = 5;
  const HIGH_SERIES_NUMBER = 900;

  // ---------- 헤더 ----------

  function str(ds, tag) {
    try {
      const v = ds.string(tag);
      return v == null ? "" : String(v).trim();
    } catch (e) {
      return "";
    }
  }
  function u16(ds, tag) {
    try {
      const v = ds.uint16(tag);
      return v == null ? null : v;
    } catch (e) {
      return null;
    }
  }

  function parse(bytes, untilPixel) {
    const opts = untilPixel ? { untilTag: PIXEL_TAG } : {};
    let hasPreamble = bytes.length >= 132 &&
      bytes[128] === 0x44 && bytes[129] === 0x49 && bytes[130] === 0x43 && bytes[131] === 0x4d;
    if (hasPreamble) {
      return { ds: dicomParser.parseDicom(bytes, opts), hasPreamble };
    }
    // DICM 표시 없이 메타 헤더(그룹 0002)로 시작하는 파일: 앞에 빈 128바이트 + "DICM"을 붙여 표준 형태로 읽는다.
    // 이때 원소 위치(dataOffset)는 원본보다 132바이트 뒤로 밀린다(shift=132).
    if (bytes.length >= 2 && bytes[0] === 0x02 && bytes[1] === 0x00) {
      const fixed = new Uint8Array(bytes.length + 132);
      fixed.set([0x44, 0x49, 0x43, 0x4d], 128);
      fixed.set(bytes, 132);
      try {
        return { ds: dicomParser.parseDicom(fixed, opts), hasPreamble, bytes: fixed, shift: 132 };
      } catch (e) {
        /* 아래 방식으로 계속 시도 */
      }
    }
    // DICM 표시가 없는 파일: 데이터가 바로 시작된다고 보고 implicit → explicit VR 순으로 읽어 본다
    let lastErr;
    for (const ts of ["1.2.840.10008.1.2", "1.2.840.10008.1.2.1"]) {
      try {
        const ds = dicomParser.parseDicom(bytes, Object.assign({}, opts, { TransferSyntaxUID: ts }));
        if (str(ds, "x00080016") || str(ds, "x00020002")) return { ds, hasPreamble, assumedTs: ts };
      } catch (e) {
        lastErr = e;
      }
    }
    throw lastErr || new Error("DICOM으로 읽을 수 없음");
  }

  /**
   * 헤더 읽기. bytes가 파일 일부(isPartial)일 때 영상 데이터 태그까지 도달하지 못하면 needMore=true.
   */
  function readHeader(bytes, isPartial) {
    let parsed;
    try {
      parsed = parse(bytes, true);
    } catch (e) {
      if (isPartial) return { needMore: true };
      return { ok: false, error: String(e && e.message || e).slice(0, 120) };
    }
    const ds = parsed.ds;
    if (isPartial && !ds.elements[PIXEL_TAG]) return { needMore: true };
    const sop = str(ds, "x00080016") || str(ds, "x00020002");
    if (!sop) return { ok: false, error: "SOP Class UID 없음 (DICOM이 아닐 수 있음)" };

    let hasOverlay = false;
    for (const key in ds.elements) {
      const g = parseInt(key.slice(1, 5), 16);
      if (g >= 0x6000 && g <= 0x60ff && g % 2 === 0) { hasOverlay = true; break; }
    }
    const pix = ds.elements[PIXEL_TAG];
    return {
      ok: true,
      hasPreamble: parsed.hasPreamble,
      transferSyntax: str(ds, "x00020010") || parsed.assumedTs || "",
      sopClassUID: sop,
      modality: str(ds, "x00080060").toUpperCase(),
      imageType: str(ds, "x00080008").toUpperCase().split("\\").filter(Boolean),
      conversionType: str(ds, "x00080064"),
      burnedIn: str(ds, "x00280301").toUpperCase(),
      seriesUID: str(ds, "x0020000e"),
      seriesNumber: str(ds, "x00200011"),
      seriesDescription: str(ds, "x0008103e"),
      studyUID: str(ds, "x0020000d"),
      samplesPerPixel: u16(ds, "x00280002"),
      photometric: str(ds, "x00280004").toUpperCase(),
      rows: u16(ds, "x00280010"),
      columns: u16(ds, "x00280011"),
      hasOverlay,
      hasPixelData: !!pix,
      encapsulated: !!(pix && pix.encapsulatedPixelData),
    };
  }

  // ---------- 후보 선정 ----------

  function sopLabel(sop) {
    for (const [prefix, label] of PRIMARY_SOP) {
      if (prefix.endsWith(".") ? sop.startsWith(prefix) : (sop === prefix || sop.startsWith(prefix + "."))) return label;
    }
    return null;
  }

  /**
   * 헤더 목록 전체를 받아 파일마다 {group, reasons}를 붙인다.
   * group: "primary"(보고서형 SOP) | "clue"(헤더 단서) | "none"
   */
  function classifyAll(headers) {
    const seriesCount = new Map();
    for (const h of headers) {
      if (h && h.ok) seriesCount.set(h.seriesUID, (seriesCount.get(h.seriesUID) || 0) + 1);
    }
    return headers.map(h => classify(h, h && h.ok ? seriesCount.get(h.seriesUID) : 0));
  }

  function classify(h, nInSeries) {
    if (!h || !h.ok) return { group: "unreadable", reasons: ["DICOM 아님/읽기 실패"] };
    const reasons = [];
    const label = sopLabel(h.sopClassUID);
    if (label) reasons.push(`SOP Class: ${label}`);
    const clue = [];
    if (CLUE_MODALITIES.has(h.modality)) clue.push(`Modality=${h.modality}`);
    const color = h.samplesPerPixel === 3 || /^(RGB|YBR)/.test(h.photometric);
    if ((h.modality === "CT" || h.modality === "MR") && color) clue.push("CT/MR인데 컬러 영상");
    if (h.imageType.includes("SECONDARY")) clue.push("ImageType SECONDARY");
    if (h.burnedIn === "YES") clue.push("BurnedInAnnotation=YES");
    if (h.hasOverlay) clue.push("오버레이(6000~60FF) 있음");
    const sn = parseInt(h.seriesNumber, 10);
    if (!isNaN(sn) && sn >= HIGH_SERIES_NUMBER) clue.push(`시리즈 번호 ${sn}`);
    if (nInSeries > 0 && nInSeries <= SMALL_SERIES_MAX && !h.imageType.includes("LOCALIZER")) {
      clue.push(`영상 ${nInSeries}장뿐인 시리즈`);
    }
    reasons.push(...clue);
    if (!h.hasPreamble) reasons.push("DICM 표시 없음");
    const group = label ? "primary" : clue.length ? "clue" : "none";
    return { group, reasons };
  }

  // ---------- 픽셀 → 회색조 ----------

  const UNCOMPRESSED_LE = new Set(["1.2.840.10008.1.2", "1.2.840.10008.1.2.1"]);

  /**
   * 파일 전체 bytes에서 첫 프레임을 8비트 회색조로 만든다. 비압축 little endian만 지원.
   * 반환: {width, height, data(Uint8Array)} 또는 {unsupported: 이유}
   */
  function toGray(bytes) {
    let parsed;
    try {
      parsed = parse(bytes, false);
    } catch (e) {
      return { unsupported: "읽기 실패" };
    }
    const ds = parsed.ds;
    if (parsed.bytes) bytes = parsed.bytes; // 앞에 132바이트를 붙여 읽은 경우 같은 버퍼 기준으로 위치 계산
    const pix = ds.elements[PIXEL_TAG];
    if (!pix) return { unsupported: "영상 데이터 없음" };
    const ts = str(ds, "x00020010") || parsed.assumedTs || "1.2.840.10008.1.2";
    if (pix.encapsulatedPixelData || !UNCOMPRESSED_LE.has(ts)) return { unsupported: "압축 영상 (뷰어에서 확인)" };
    const rows = u16(ds, "x00280010"), cols = u16(ds, "x00280011");
    const spp = u16(ds, "x00280002") || 1;
    const bits = u16(ds, "x00280100") || 8;
    const signed = u16(ds, "x00280103") === 1;
    const planar = u16(ds, "x00280006") === 1;
    const mono1 = str(ds, "x00280004").toUpperCase() === "MONOCHROME1";
    if (!rows || !cols) return { unsupported: "영상 크기 정보 없음" };
    const n = rows * cols;
    const off = pix.dataOffset;
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const vals = new Float32Array(n);
    if (spp === 3 && bits === 8) {
      if (off + n * 3 > bytes.length) return { unsupported: "영상 데이터 길이 부족" };
      for (let i = 0; i < n; i++) {
        const r = planar ? bytes[off + i] : bytes[off + i * 3];
        const g = planar ? bytes[off + n + i] : bytes[off + i * 3 + 1];
        const b = planar ? bytes[off + 2 * n + i] : bytes[off + i * 3 + 2];
        vals[i] = 0.299 * r + 0.587 * g + 0.114 * b;
      }
    } else if (spp === 1 && (bits === 8 || bits === 16)) {
      const step = bits / 8;
      if (off + n * step > bytes.length) return { unsupported: "영상 데이터 길이 부족" };
      for (let i = 0; i < n; i++) {
        const p = off + i * step;
        vals[i] = bits === 8 ? bytes[p] : signed ? view.getInt16(p, true) : view.getUint16(p, true);
      }
    } else {
      return { unsupported: `지원하지 않는 형식 (samples=${spp}, bits=${bits})` };
    }
    let lo = Infinity, hi = -Infinity;
    for (let i = 0; i < n; i++) { if (vals[i] < lo) lo = vals[i]; if (vals[i] > hi) hi = vals[i]; }
    const scale = hi > lo ? 255 / (hi - lo) : 0;
    const data = new Uint8Array(n);
    for (let i = 0; i < n; i++) {
      const v = (vals[i] - lo) * scale;
      data[i] = mono1 ? 255 - v : v;
    }
    return { width: cols, height: rows, data };
  }

  /** OCR 전처리: 어두운 배경이면 밝기 반전, 폭이 upscaleBelow(px) 미만이면 2배 확대 */
  function prepareForOcr(img, upscaleBelow) {
    if (upscaleBelow == null) upscaleBelow = 1500;
    let sum = 0;
    for (let i = 0; i < img.data.length; i++) sum += img.data[i];
    const invert = sum / img.data.length < 128;
    const k = img.width < upscaleBelow ? 2 : 1;
    const w = img.width * k, h = img.height * k;
    const out = new Uint8Array(w * h);
    for (let y = 0; y < h; y++) {
      const sy = Math.min(img.height - 1, (y + 0.5) / k - 0.5);
      const y0 = Math.max(0, Math.floor(sy)), y1 = Math.min(img.height - 1, y0 + 1), fy = Math.max(0, sy - y0);
      for (let x = 0; x < w; x++) {
        const sx = Math.min(img.width - 1, (x + 0.5) / k - 0.5);
        const x0 = Math.max(0, Math.floor(sx)), x1 = Math.min(img.width - 1, x0 + 1), fx = Math.max(0, sx - x0);
        const d = img.data;
        const v = (d[y0 * img.width + x0] * (1 - fx) + d[y0 * img.width + x1] * fx) * (1 - fy) +
                  (d[y1 * img.width + x0] * (1 - fx) + d[y1 * img.width + x1] * fx) * fy;
        out[y * w + x] = invert ? 255 - v : v;
      }
    }
    return { width: w, height: h, data: out, inverted: invert };
  }

  // ---------- OCR 결과 판정 ----------

  // 항목 이름 (하나라도 있으면 '유력')
  const STRONG_LABELS = [
    ["Name", /\b(patient'?s?\s*)?name\b/i],
    ["Patient ID", /\bpatient\s*id\b/i],
    ["ID:", /\bID\s*[:：]/],
    ["Birth", /\bbirth|\bD\.?O\.?B\b/i],
    ["Patient Info", /\bpatient\s*info/i],
    ["MRN/등록번호", /\bMRN\b|\b(hospital|reg(istration)?|chart)\s*(no|number|#)/i],
    ["성명/이름", /성\s*명|이\s*름|환\s*자\s*명/],
    ["등록번호", /등\s*록\s*번\s*호|병\s*록\s*번\s*호|환\s*자\s*번\s*호/],
    ["생년월일/주민번호", /생\s*년\s*월\s*일|주\s*민/],
  ];

  /**
   * text: OCR 전체 글자, words: [{text, confidence}]
   * 반환: {verdict: "유력"|"확인 필요"|"정상", labels: [...], wordCount}
   */
  function judgeOcr(text, words) {
    const labels = STRONG_LABELS.filter(([, re]) => re.test(text)).map(([n]) => n);
    const solid = (words || []).filter(w => w.confidence >= 60 && /[A-Za-z가-힣0-9]{3,}/.test(w.text)).length;
    const verdict = labels.length ? "유력" : solid >= 3 ? "확인 필요" : "정상";
    return { verdict, labels, wordCount: solid };
  }

  /** Tesseract.js 결과(data)에서 단어 목록 추출 */
  function wordsFromTesseract(data) {
    if (Array.isArray(data.words) && data.words.length) return data.words;
    const out = [];
    for (const b of data.blocks || []) for (const p of b.paragraphs || []) for (const l of p.lines || []) {
      for (const w of l.words || []) out.push(w);
    }
    return out;
  }

  // ---------- 메타데이터 비식별화 (Calgary SCTG 도구와 같은 30개 태그) ----------

  const ANON_TAGS = {
    x00100010: "PatientName", x00100020: "PatientID", x00100030: "PatientBirthDate",
    x00100032: "PatientBirthTime", x00101040: "PatientAddress", x00101000: "OtherPatientIDs",
    x00101001: "OtherPatientNames", x00100021: "IssuerOfPatientID", x00080050: "AccessionNumber",
    x00080090: "ReferringPhysicianName", x00080092: "ReferringPhysicianAddress",
    x00081050: "PerformingPhysicianName", x00080080: "InstitutionName", x00080081: "InstitutionAddress",
    x00080094: "ReferringPhysicianTelephoneNumbers", x00080096: "ReferringPhysicianIdentificationSequence",
    x0008009c: "ConsultingPhysicianName", x0008009d: "ConsultingPhysicianIdentificationSequence",
    x00321032: "RequestingPhysician", x00081048: "PhysiciansOfRecord",
    x00081060: "NameOfPhysiciansReadingStudy", x00081070: "OperatorsName",
    x00400006: "ScheduledPerformingPhysicianName", x00401010: "NamesOfIntendedRecipientsOfResults",
    x00700084: "ContentCreatorName", x4008010c: "InterpretationAuthor",
    x40080114: "PhysicianApprovingInterpretation", x00380016: "RouteOfAdmissions",
    x00101010: "PatientAge", x00100033: "PatientBirthDateInAlternativeCalendar",
  };
  const UNDEFINED_LENGTH = 0xffffffff;

  function blankRange(out, start, len) {
    if (!len || len === UNDEFINED_LENGTH || start < 0 || start + len > out.length) return 0;
    for (let i = start; i < start + len; i++) out[i] = 0x20;
    return 1;
  }

  // 시퀀스 태그 자체를 공백으로 덮으면 파일 구조가 깨지므로, 안쪽 값들만 공백으로 바꾼다
  function blankLeaves(out, ds, shift) {
    let n = 0;
    for (const key in ds.elements) {
      const e = ds.elements[key];
      if (e.items) { for (const it of e.items) if (it.dataSet) n += blankLeaves(out, it.dataSet, shift); }
      else n += blankRange(out, e.dataOffset - shift, e.length);
    }
    return n;
  }

  function walkTargets(ds, fn) {
    for (const key in ds.elements) {
      const e = ds.elements[key];
      if (ANON_TAGS[e.tag]) fn(e);
      else if (e.items) for (const it of e.items) if (it.dataSet) walkTargets(it.dataSet, fn);
    }
  }

  /**
   * 30개 태그 값을 같은 길이의 공백으로 덮어쓴 사본을 돌려준다 (원본 bytes는 그대로).
   * 영상 데이터와 나머지 부분은 바이트 단위로 같다.
   */
  function anonymize(bytes) {
    const parsed = parse(bytes, true);
    const shift = parsed.shift || 0;
    const out = new Uint8Array(bytes);
    let blanked = 0;
    walkTargets(parsed.ds, e => {
      blanked += e.items ? e.items.reduce((n, it) => n + (it.dataSet ? blankLeaves(out, it.dataSet, shift) : 0), 0)
                         : blankRange(out, e.dataOffset - shift, e.length);
    });
    return { bytes: out, blanked };
  }

  function isBlank(bytes, start, len) {
    if (!len || len === UNDEFINED_LENGTH) return true;
    for (let i = start; i < start + len; i++) if (bytes[i] !== 0x20 && bytes[i] !== 0x00) return false;
    return true;
  }
  function leavesBlank(bytes, ds, shift) {
    for (const key in ds.elements) {
      const e = ds.elements[key];
      if (e.items) { for (const it of e.items) if (it.dataSet && !leavesBlank(bytes, it.dataSet, shift)) return false; }
      else if (!isBlank(bytes, e.dataOffset - shift, e.length)) return false;
    }
    return true;
  }

  /** 비식별화 결과 재점검: 30개 태그 중 값이 남아 있는 태그 이름 목록 (비어 있으면 통과) */
  function verifyAnonymized(bytes) {
    let parsed;
    try {
      parsed = parse(bytes, true);
    } catch (e) {
      return { ok: false, remaining: ["다시 읽기 실패"] };
    }
    const shift = parsed.shift || 0;
    const remaining = new Set();
    walkTargets(parsed.ds, e => {
      const blank = e.items ? e.items.every(it => !it.dataSet || leavesBlank(bytes, it.dataSet, shift))
                            : isBlank(bytes, e.dataOffset - shift, e.length);
      if (!blank) remaining.add(ANON_TAGS[e.tag]);
    });
    return { ok: remaining.size === 0, remaining: [...remaining] };
  }

  return { readHeader, classifyAll, classify, toGray, prepareForOcr, judgeOcr, wordsFromTesseract, sopLabel,
           anonymize, verifyAnonymized, ANON_TAGS };
});
