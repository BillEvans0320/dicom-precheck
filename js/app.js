/* 화면 동작: 폴더 선택 → 헤더 스캔 → 후보 선정 → 후보 OCR → 썸네일 확인 → 보고서 */
(function () {
  "use strict";
  const $ = id => document.getElementById(id);
  const HEADER_BYTES = 64 * 1024;
  const SCAN_CONCURRENCY = 16;
  const OCR_WORKERS = 2;
  const OCR_BATCH = 4;
  const VERDICT_CLASS = { "유력": "v-strong", "확인 필요": "v-warn", "정상": "v-ok" };

  let entries = [];      // [{file, rel}]
  let results = [];      // 파일별 결과
  let filter = "전체";

  // ---------- 폴더 선택 ----------

  // 선택 목록에 ZIP 파일이 있으면 안의 파일들로 펼친다 (ZIP 내부 폴더 구조 유지)
  async function expandZips(list) {
    const out = [];
    const zipErrors = [];
    let zips = 0;
    for (const e of list) {
      if (!/\.zip$/i.test(e.rel)) { out.push(e); continue; }
      zips++;
      const dir = e.rel.includes("/") ? e.rel.slice(0, e.rel.lastIndexOf("/") + 1) : "";
      const base = e.rel.slice(dir.length).replace(/\.zip$/i, "");
      let items;
      try {
        items = await ZipReader.list(e.file);
      } catch (err) {
        zipErrors.push({ file: e.file, rel: e.rel, zipError: String(err && err.message || err) });
        continue;
      }
      // ZIP 안이 폴더 하나로 묶여 있으면 그 폴더 이름을, 아니면 ZIP 이름을 폴더로 쓴다
      const tops = new Set(items.map(i => i.path.split("/")[0]));
      const single = tops.size === 1 && items.every(i => i.path.includes("/"));
      for (const i of items) {
        const nested = /\.zip$/i.test(i.path) ? "ZIP 안의 ZIP은 읽지 않습니다. 압축을 풀어 따로 선택하세요" : "";
        out.push({ file: i.file, rel: dir + (single ? "" : base + "/") + i.path, fromZip: e.rel,
                   zipError: i.readable ? nested : i.reason });
      }
    }
    // 같은 경로가 겹치면(예: 같은 이름의 폴더와 ZIP을 함께 선택) ZIP 쪽 폴더 이름에 "(zip)"을 붙인다
    const seen = new Set(out.filter(e => !e.fromZip).map(e => e.rel));
    for (const e of out) {
      if (!e.fromZip) continue;
      if (seen.has(e.rel)) {
        const parts = e.rel.split("/");
        const k = (e.fromZip.match(/\//g) || []).length;  // ZIP이 있던 폴더 깊이 다음 단계 이름에 표시
        parts[k] = parts[k] + " (zip)";
        e.rel = parts.join("/");
      }
      seen.add(e.rel);
    }
    return { list: out.concat(zipErrors), zips };
  }

  let selectToken = 0;
  async function setEntries(list) {
    const token = ++selectToken;  // 선택을 연달아 바꾸면 마지막 선택만 반영
    $("picked").textContent = "파일 목록을 읽는 중…";
    list = list.filter(e => !e.rel.split("/").some(s => s.startsWith(".")));
    const expanded = await expandZips(list);
    if (token !== selectToken) return;
    entries = expanded.list;
    const pickedZips = expanded.zips;
    entries.sort((a, b) => a.rel.localeCompare(b.rel));
    const tops = new Set(entries.filter(e => !e.fromZip).map(e => e.rel.split("/")[0]));
    const parts = [];
    if (tops.size) parts.push(`폴더 ${tops.size}개`);
    if (pickedZips) parts.push(`ZIP ${pickedZips}개`);
    $("picked").textContent = entries.length
      ? `${parts.join(" · ")} · 파일 ${entries.length.toLocaleString()}개 선택됨`
      : "선택된 폴더 없음";
    $("run").disabled = entries.length === 0;
  }

  $("picker").addEventListener("change", e => {
    setEntries(Array.from(e.target.files).map(f => ({ file: f, rel: f.webkitRelativePath || f.name })));
  });
  $("zip-picker").addEventListener("change", e => {
    setEntries(Array.from(e.target.files).map(f => ({ file: f, rel: f.name })));
  });

  const drop = $("drop");
  // 상자 밖에 떨어뜨려도 브라우저가 파일을 열어 화면이 바뀌지 않도록 막는다
  window.addEventListener("dragover", e => e.preventDefault());
  window.addEventListener("drop", e => e.preventDefault());
  drop.addEventListener("dragenter", e => { e.preventDefault(); drop.classList.add("over"); });
  drop.addEventListener("dragover", e => { e.preventDefault(); drop.classList.add("over"); });
  drop.addEventListener("dragleave", e => { if (!drop.contains(e.relatedTarget)) drop.classList.remove("over"); });
  drop.addEventListener("drop", async e => {
    e.preventDefault();
    drop.classList.remove("over");
    // 끌어다 놓은 항목 정보는 이 이벤트 안에서 바로 받아 두어야 한다 (await 뒤에는 사라짐)
    const items = Array.from(e.dataTransfer.items || []).filter(i => i.kind === "file");
    const handles = items.map(i => (i.getAsFileSystemHandle ? i.getAsFileSystemHandle() : null));
    const entries = items.map(i => (i.webkitGetAsEntry ? i.webkitGetAsEntry() : null));
    const plainFiles = Array.from(e.dataTransfer.files || []);
    $("picked").textContent = "파일 목록을 읽는 중…";
    let out = [];
    // 1) File System Access 방식: HTML 파일을 직접 연 경우(file://)에도 동작
    try {
      if (!handles.length || handles.some(h => !h)) throw new Error("지원 안 함");
      for (const h of await Promise.all(handles)) if (h) await walkHandle(h, "", out);
    } catch (err1) {
      out = [];
      // 2) 이전 방식: 웹 주소(https://)로 연 경우
      try {
        if (entries.some(en => !en)) throw new Error("지원 안 함");
        for (const en of entries) await walkEntry(en, "", out);
      } catch (err2) {
        // 3) 마지막 방법: 파일(ZIP 등)만 받는다. 폴더는 읽을 수 없으므로 안내한다
        out = plainFiles.filter((f, i) => !(entries[i] && entries[i].isDirectory)).map(f => ({ file: f, rel: f.name }));
        if (entries.some(en => en && en.isDirectory)) {
          setEntries(out).then(() => {
            $("picked").textContent = "이 브라우저에서는 끌어다 놓은 폴더를 읽을 수 없습니다. '폴더 선택…' 버튼을 사용해 주세요." +
              (out.length ? ` (함께 놓은 파일 ${out.length}개는 선택됨)` : "");
          });
          return;
        }
      }
    }
    setEntries(out);
  });

  async function walkHandle(h, prefix, out) {
    if (h.kind === "file") {
      out.push({ file: await h.getFile(), rel: prefix + h.name });
    } else if (h.kind === "directory") {
      for await (const child of h.values()) await walkHandle(child, prefix + h.name + "/", out);
    }
  }

  async function walkEntry(entry, prefix, out) {
    if (entry.isFile) {
      const file = await new Promise((res, rej) => entry.file(res, rej));
      out.push({ file, rel: prefix + entry.name });
    } else if (entry.isDirectory) {
      const reader = entry.createReader();
      for (;;) {
        const batch = await new Promise((res, rej) => reader.readEntries(res, rej));
        if (!batch.length) break;
        for (const child of batch) await walkEntry(child, prefix + entry.name + "/", out);
      }
    }
  }

  $("reset").addEventListener("click", () => location.reload());

  // ---------- 실행 ----------

  function progress(frac, text) {
    $("bar").style.width = `${Math.round(frac * 100)}%`;
    $("status").textContent = text;
  }

  async function readHeaderOf(entry) {
    if (entry.zipError) return { ok: false, error: entry.zipError };
    try {
      return await readHeaderInner(entry);
    } catch (e) {
      return { ok: false, error: String(e && e.message || e).slice(0, 120) };
    }
  }
  async function readHeaderInner(entry) {
    const f = entry.file;
    const n = Math.min(f.size, HEADER_BYTES);
    let h = DeidCore.readHeader(new Uint8Array(await f.slice(0, n).arrayBuffer()), n < f.size);
    if (h.needMore) h = DeidCore.readHeader(new Uint8Array(await f.arrayBuffer()), false);
    return h;
  }

  async function runPool(items, limit, fn) {
    let next = 0;
    const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (next < items.length) {
        const i = next++;
        await fn(items[i], i);
      }
    });
    await Promise.all(workers);
  }

  // 여러 OCR 작업이 동시에 요청해도 엔진은 한 번만 준비한다
  let schedulerPromise = null;
  function getScheduler() {
    if (!schedulerPromise) schedulerPromise = createScheduler();
    return schedulerPromise;
  }
  let engineSeconds = 0;
  // OCR 엔진은 필요할 때만 불러온다. 엔진·언어 데이터를 <script>로 읽어 메모리(blob)에서 Worker를 만든다.
  // 이렇게 하면 GitHub 링크로 열 때와 HTML 파일을 직접 열 때(file://) 모두 같은 방식으로 동작한다.
  function loadScript(src) {
    return new Promise((res, rej) => {
      const s = document.createElement("script");
      s.src = src;
      s.onload = res;
      s.onerror = () => rej(new Error(src + " 를 불러오지 못했습니다"));
      document.head.append(s);
    });
  }
  function wasmSimdSupported() {
    try {
      return WebAssembly.validate(new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0, 1, 5, 1, 96, 0, 1, 123, 3, 2, 1, 0,
        10, 10, 1, 8, 0, 65, 0, 253, 15, 253, 98, 11]));
    } catch (e) {
      return false;
    }
  }
  async function gunzipBase64(b64) {
    const gz = Uint8Array.from(atob(b64), c => c.charCodeAt(0));
    const stream = new Blob([gz]).stream().pipeThrough(new DecompressionStream("gzip"));
    return new Uint8Array(await new Response(stream).arrayBuffer());
  }
  async function createScheduler() {
    const t0 = performance.now();
    const simd = wasmSimdSupported();
    await Promise.all(["vendor/inline/worker.js", simd ? "vendor/inline/core-simd.js" : "vendor/inline/core.js",
      "vendor/inline/lang-eng.js", "vendor/inline/lang-kor.js"].map(loadScript));
    const core = simd ? window.__TESS_CORE_SIMD : window.__TESS_CORE;
    // 엔진 코어를 Worker 스크립트 앞에 붙여 한 파일로 만든다 (Worker 안에서 별도 파일을 불러오지 않도록)
    const workerUrl = URL.createObjectURL(new Blob([core, "\n;\n", window.__TESS_WORKER], { type: "text/javascript" }));
    const langs = [
      { code: "eng", data: await gunzipBase64(window.__TESS_LANG_eng) },
      { code: "kor", data: await gunzipBase64(window.__TESS_LANG_kor) },
    ];
    const opts = { workerPath: workerUrl, corePath: "inline.js", workerBlobURL: false, gzip: false, cacheMethod: "none" };
    const scheduler = Tesseract.createScheduler();
    for (let i = 0; i < OCR_WORKERS; i++) {
      scheduler.addWorker(await Tesseract.createWorker(langs, 1, opts));
    }
    engineSeconds = (performance.now() - t0) / 1000;
    return scheduler;
  }

  function grayToCanvas(img, maxSide) {
    const c = document.createElement("canvas");
    c.width = img.width; c.height = img.height;
    const ctx = c.getContext("2d");
    const id = ctx.createImageData(img.width, img.height);
    for (let i = 0, j = 0; i < img.data.length; i++, j += 4) {
      const v = img.data[i];
      id.data[j] = id.data[j + 1] = id.data[j + 2] = v; id.data[j + 3] = 255;
    }
    ctx.putImageData(id, 0, 0);
    if (!maxSide || Math.max(img.width, img.height) <= maxSide) return c;
    const k = maxSide / Math.max(img.width, img.height);
    const t = document.createElement("canvas");
    t.width = Math.round(img.width * k); t.height = Math.round(img.height * k);
    t.getContext("2d").drawImage(c, 0, 0, t.width, t.height);
    return t;
  }

  async function ocrOne(r) {
    const bytes = new Uint8Array(await r.entry.file.arrayBuffer());
    const gray = DeidCore.toGray(bytes);
    if (gray.unsupported) {
      r.ocrNote = gray.unsupported;
      if (r.reasons.some(s => s.startsWith("SOP Class: DICOMDIR"))) {
        r.verdict = "유력"; r.labels = ["DICOMDIR"];
      } else {
        r.verdict = "확인 필요"; r.labels = [];
      }
      return;
    }
    r.thumb = grayToCanvas(gray, 320);
    const sch = await getScheduler();
    const recognize = async upscale => {
      const prepped = DeidCore.prepareForOcr(gray, upscale ? Infinity : 0);
      const { data } = await sch.addJob("recognize", grayToCanvas(prepped), {}, { text: true, blocks: true });
      return DeidCore.judgeOcr(data.text, DeidCore.wordsFromTesseract(data));
    };
    const t0 = performance.now();
    // 1차: 원래 크기 (큰 글씨는 여기서 바로 잡힘, 글씨가 없는 영상도 여기서 끝남)
    let j = await recognize(false);
    r.ocrPasses = 1;
    // 2차: 2배 확대 (작은 글씨용). 글씨는 있는데 항목 이름이 안 잡혔거나, 보고서형 SOP인데 유력이 아닐 때만
    if (j.verdict !== "유력" && (j.verdict === "확인 필요" || r.group === "primary")) {
      const j2 = await recognize(true);
      r.ocrPasses = 2;
      if (j2.verdict === "유력" || j2.wordCount > j.wordCount) j = j2;
    }
    r.verdict = j.verdict; r.labels = j.labels; r.wordCount = j.wordCount;
    r.ocrSeconds = (performance.now() - t0) / 1000;
  }

  $("run").addEventListener("click", async () => {
    $("run").disabled = true;
    $("step-progress").classList.remove("hidden");
    $("step-review").classList.add("hidden");
    const t0 = performance.now();

    // 1) 헤더 스캔
    const headers = new Array(entries.length);
    let done = 0;
    await runPool(entries, SCAN_CONCURRENCY, async (e, i) => {
      headers[i] = await readHeaderOf(e);
      if (++done % 200 === 0 || done === entries.length) {
        progress(0.3 * done / entries.length, `헤더 읽는 중 ${done.toLocaleString()} / ${entries.length.toLocaleString()}`);
      }
    });
    const tScan = (performance.now() - t0) / 1000;

    // 2) 후보 선정
    const cls = DeidCore.classifyAll(headers);
    results = entries.map((entry, i) => ({
      entry, rel: entry.rel, h: headers[i], group: cls[i].group, reasons: cls[i].reasons,
      verdict: "", labels: [], decision: "", ocrNote: "",
    }));
    if ($("opt-series-ocr").checked) {
      const seen = new Set();
      for (const r of results) {
        if (r.group !== "none" || !r.h.hasPixelData) continue;
        const key = r.h.studyUID + "|" + r.h.seriesUID;
        if (seen.has(key)) continue;
        seen.add(key);
        r.group = "sample"; r.reasons = ["시리즈 대표 1장 (옵션)"];
      }
    }

    // 3) 후보 OCR
    const queue = results.filter(r => r.group === "primary" || r.group === "clue" || r.group === "sample");
    let ocrDone = 0;
    const tOcr0 = performance.now();
    for (let i = 0; i < queue.length; i += OCR_BATCH) {
      await Promise.all(queue.slice(i, i + OCR_BATCH).map(ocrOne));
      ocrDone = Math.min(queue.length, i + OCR_BATCH);
      progress(0.3 + 0.7 * ocrDone / queue.length, `후보 OCR 검사 중 ${ocrDone} / ${queue.length}`);
    }

    // 4) 기본 결정
    for (const r of results) {
      if (r.group === "unreadable") { r.decision = "제외"; continue; }
      if (!r.verdict) { r.decision = "업로드"; continue; }
      r.decision = r.verdict === "정상" ? "업로드" : "제외";
    }
    const total = (performance.now() - t0) / 1000;
    const tOcr = (performance.now() - tOcr0) / 1000 - engineSeconds;
    const twoPass = count(r => r.ocrPasses === 2);
    progress(1, `완료 · 헤더 스캔 ${tScan.toFixed(1)}초` +
      (queue.length ? ` · OCR 엔진 준비 ${engineSeconds.toFixed(1)}초 · 후보 ${queue.length}장 OCR ${tOcr.toFixed(1)}초 (2배 확대 재검사 ${twoPass}장)` : "") +
      ` · 전체 ${total.toFixed(1)}초`);
    renderSummary();
    renderReview();
    $("step-save").classList.remove("hidden");
    $("save-status").textContent = "";
    $("run").disabled = false;
  });

  // ---------- 비식별화 후 ZIP 저장 ----------

  // 저장 위치: Chrome·Edge는 저장할 파일을 먼저 고르고 조각씩 바로 쓴다(메모리 절약).
  // 이 기능이 없는 브라우저는 메모리에 모아 내려받는다(Calgary 도구와 같은 방식).
  async function openSink(name) {
    const forceFallback = /[?&]zipfallback=1/.test(location.search);
    if (window.showSaveFilePicker && !forceFallback) {
      const handle = await window.showSaveFilePicker({
        suggestedName: name,
        startIn: "downloads",  // 저장 창은 '다운로드' 폴더에서 시작
        types: [{ description: "ZIP 파일", accept: { "application/zip": [".zip"] } }],
      });
      const writable = await handle.createWritable();
      const sink = bufferedSink(b => writable.write(b), () => writable.close());
      sink.fileName = handle.name;  // 사용자가 저장 창에서 이름을 바꿨을 수 있다
      sink.where = "저장 창에서 고른 폴더 (바꾸지 않았다면 '다운로드' 폴더)";
      return sink;
    }
    const parts = [];
    const sink = bufferedSink(async b => { parts.push(b); }, async () => {
      const a = document.createElement("a");
      a.href = URL.createObjectURL(new Blob(parts, { type: "application/zip" }));
      a.download = name;
      document.body.append(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(a.href), 60000);
    });
    sink.fileName = name;
    sink.where = "브라우저의 다운로드 폴더 (보통 '다운로드' 폴더)";
    return sink;
  }
  // 작은 조각을 8MB 단위로 모아서 쓴다
  function bufferedSink(writeFn, closeFn) {
    const LIMIT = 8 * 1024 * 1024;
    let parts = [], size = 0;
    const flush = async () => {
      if (!size) return;
      const out = new Uint8Array(size);
      let p = 0;
      for (const b of parts) { out.set(b, p); p += b.length; }
      parts = []; size = 0;
      await writeFn(out);
    };
    return {
      async write(b) {
        if (b.length >= LIMIT) { await flush(); await writeFn(b); return; }
        parts.push(b.slice()); size += b.length;
        if (size >= LIMIT) await flush();
      },
      async close() { await flush(); await closeFn(); },
    };
  }

  $("save").addEventListener("click", async () => {
    const targets = results.filter(r => r.decision === "업로드" && r.h && r.h.ok);
    if (!targets.length) { $("save-status").textContent = "업로드로 정한 파일이 없습니다."; return; }
    const name = `anonymized_dicoms_${stamp()}.zip`;
    let sink;
    try {
      sink = await openSink(name);
    } catch (e) {
      $("save-status").textContent = "저장을 취소했습니다.";
      return;
    }
    $("save").disabled = true;
    $("run").disabled = true;
    $("save-result").classList.add("hidden");
    $("save-progress").classList.remove("hidden");
    const bar = $("save-bar");
    const t0 = performance.now();
    const zip = new ZipStream(sink);
    let ok = 0, failed = 0;
    for (const r of results) { r.anon = ""; }
    for (let i = 0; i < targets.length; i++) {
      const r = targets[i];
      try {
        const a = DeidCore.anonymize(new Uint8Array(await r.entry.file.arrayBuffer()));
        const v = DeidCore.verifyAnonymized(a.bytes);
        if (!v.ok) throw new Error("재점검 실패: " + v.remaining.join(", "));
        await zip.addFile(r.rel, a.bytes);
        r.anon = "완료 (재점검 통과)";
        ok++;
      } catch (e) {
        // 비식별화나 재점검에 실패한 파일은 ZIP에 넣지 않는다
        r.anon = "ZIP에서 제외: " + String(e && e.message || e).slice(0, 100);
        failed++;
      }
      if (i % 20 === 0 || i === targets.length - 1) {
        bar.style.width = `${Math.round(100 * (i + 1) / targets.length)}%`;
        $("save-status").textContent = `비식별화·저장 중 ${(i + 1).toLocaleString()} / ${targets.length.toLocaleString()}`;
        await new Promise(res => setTimeout(res, 0));
      }
    }
    const info = await zip.finish();
    await sink.close();
    const secs = (performance.now() - t0) / 1000;
    const excluded = count(r => r.decision === "제외");
    $("save-status").textContent =
      `ZIP에 ${ok.toLocaleString()}개 저장 (모두 재점검 통과)` +
      (failed ? ` · 실패로 빠진 파일 ${failed}개 (보고서 확인)` : "") +
      ` · 업로드 제외 ${excluded.toLocaleString()}개 · ${(info.bytes / 1048576).toFixed(1)}MB · ${secs.toFixed(1)}초`;
    $("save-name").textContent = sink.fileName;
    $("save-where").textContent = sink.where;
    $("save-result").classList.remove("hidden");
    $("save").disabled = false;
    $("run").disabled = false;
  });

  $("copy-name").addEventListener("click", async () => {
    const text = $("save-name").textContent;
    try {
      await navigator.clipboard.writeText(text);
    } catch (e) {
      // 복사 기능을 쓸 수 없으면 이름을 선택해 두어 Ctrl/Cmd+C로 복사할 수 있게 한다
      const r = document.createRange();
      r.selectNodeContents($("save-name"));
      const sel = getSelection();
      sel.removeAllRanges();
      sel.addRange(r);
    }
    $("copy-name").textContent = "복사됨";
    setTimeout(() => { $("copy-name").textContent = "파일 이름 복사"; }, 1500);
  });

  // ---------- 화면 ----------

  function count(pred) { return results.filter(pred).length; }

  function renderSummary() {
    const stats = [
      ["전체 파일", results.length],
      ["OCR 검사한 후보", count(r => r.verdict)],
      ["유력", count(r => r.verdict === "유력")],
      ["확인 필요", count(r => r.verdict === "확인 필요")],
      ["읽기 실패/DICOM 아님", count(r => r.group === "unreadable")],
      ["업로드 예정", count(r => r.decision === "업로드")],
    ];
    const box = $("summary");
    box.textContent = "";
    for (const [k, v] of stats) {
      const d = document.createElement("div");
      d.className = "stat";
      const b = document.createElement("b");
      b.textContent = v.toLocaleString();
      d.append(b, k);
      box.append(d);
    }
  }

  function renderReview() {
    $("step-review").classList.remove("hidden");
    const fbox = $("filters");
    fbox.textContent = "";
    for (const f of ["전체", "유력", "확인 필요", "정상"]) {
      const b = document.createElement("button");
      b.textContent = `${f} (${f === "전체" ? count(r => r.verdict) : count(r => r.verdict === f)})`;
      if (f === filter) b.classList.add("active");
      b.addEventListener("click", () => { filter = f; renderReview(); });
      fbox.append(b);
    }

    const grid = $("grid");
    grid.textContent = "";
    const shown = results.filter(r => r.verdict && (filter === "전체" || r.verdict === filter));
    if (!shown.length) {
      const p = document.createElement("p");
      p.className = "muted";
      p.textContent = "표시할 후보가 없습니다.";
      grid.append(p);
    }
    for (const r of shown) grid.append(card(r));
    renderOthers();
  }

  function card(r) {
    const d = document.createElement("div");
    d.className = "item" + (r.decision === "제외" ? " excluded" : "");
    if (r.thumb) {
      d.append(r.thumb);
    } else {
      const n = document.createElement("div");
      n.className = "noimg";
      n.textContent = r.ocrNote || "썸네일 없음";
      d.append(n);
    }
    const v = document.createElement("div");
    const badge = document.createElement("span");
    badge.className = "badge " + (VERDICT_CLASS[r.verdict] || "");
    badge.textContent = r.verdict;
    v.append(badge, r.labels.length ? ` · 발견: ${r.labels.join(", ")}` : "");
    const p = document.createElement("div");
    p.className = "path";
    p.textContent = r.rel;
    const why = document.createElement("div");
    why.className = "reasons";
    why.textContent = r.reasons.join(" · ") + (r.ocrNote ? ` · ${r.ocrNote}` : "");
    const dec = document.createElement("div");
    dec.className = "decide";
    for (const opt of ["제외", "업로드"]) {
      const l = document.createElement("label");
      const inp = document.createElement("input");
      inp.type = "radio";
      inp.name = "d-" + results.indexOf(r);
      inp.checked = r.decision === opt;
      inp.addEventListener("change", () => {
        r.decision = opt;
        d.classList.toggle("excluded", opt === "제외");
        renderSummary();
      });
      l.append(inp, " " + opt);
      dec.append(l);
    }
    d.append(v, p, why, dec);
    return d;
  }

  function renderOthers() {
    const box = $("others");
    box.textContent = "";
    const bad = results.filter(r => r.group === "unreadable");
    const nodicm = results.filter(r => r.h && r.h.ok && !r.h.hasPreamble);
    if (!bad.length && !nodicm.length) return;
    const h = document.createElement("h3");
    h.textContent = "기타 확인 항목";
    box.append(h);
    const t = document.createElement("table");
    t.innerHTML = "<tr><th>파일</th><th>내용</th></tr>";
    for (const r of bad) {
      const why = r.entry.zipError ? `읽지 않음: ${r.entry.zipError}` : "DICOM 아님/읽기 실패";
      addRow(t, r.rel, why + " → 업로드에서 제외");
    }
    for (const r of nodicm) addRow(t, r.rel, "DICM 표시 없음 (다른 비식별화 도구에서는 알림 없이 빠질 수 있는 파일)");
    box.append(t);
  }
  function addRow(t, a, b) {
    const tr = document.createElement("tr");
    for (const x of [a, b]) { const td = document.createElement("td"); td.textContent = x; tr.append(td); }
    t.append(tr);
  }

  // ---------- 보고서 (환자정보 값은 넣지 않음) ----------

  function csv(rows) {
    const esc = v => {
      const s = v == null ? "" : String(v);
      return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    };
    return "﻿" + rows.map(r => r.map(esc).join(",")).join("\r\n");
  }
  function download(name, text) {
    const a = document.createElement("a");
    a.href = URL.createObjectURL(new Blob([text], { type: "text/csv" }));
    a.download = name;
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  }
  const stamp = () => new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const sopName = h => (h && h.ok ? DeidCore.sopLabel(h.sopClassUID) || h.sopClassUID : "");

  $("dl-files").addEventListener("click", () => {
    const rows = [["파일", "최종 결정", "후보 구분", "이유", "OCR 판정", "발견한 항목 이름", "OCR 비고",
      "SOP Class", "Modality", "ImageType", "시리즈 번호", "시리즈 설명", "DICM 표시", "비식별화"]];
    for (const r of results) {
      const h = r.h || {};
      rows.push([r.rel, r.decision, r.group, r.reasons.join("; "), r.verdict, r.labels.join("; "), r.ocrNote,
        sopName(h), h.modality, (h.imageType || []).join("\\"), h.seriesNumber, h.seriesDescription,
        h.ok ? (h.hasPreamble ? "있음" : "없음") : "", r.anon || ""]);
    }
    download(`precheck_files_${stamp()}.csv`, csv(rows));
  });

  $("dl-series").addEventListener("click", () => {
    const m = new Map();
    for (const r of results) {
      if (!r.h || !r.h.ok) continue;
      const top = r.rel.split("/").slice(0, -1).join("/");
      const key = top + "|" + r.h.seriesUID;
      if (!m.has(key)) m.set(key, { top, h: r.h, n: 0, cand: 0, excl: 0, color: false });
      const s = m.get(key);
      s.n++;
      if (r.verdict) s.cand++;
      if (r.decision === "제외") s.excl++;
      if (r.h.samplesPerPixel === 3) s.color = true;
    }
    const rows = [["폴더", "시리즈 번호", "시리즈 설명", "Modality", "SOP Class", "파일 수", "컬러", "후보 수", "제외 수"]];
    for (const s of m.values()) {
      rows.push([s.top, s.h.seriesNumber, s.h.seriesDescription, s.h.modality, sopName(s.h), s.n,
        s.color ? "예" : "", s.cand, s.excl]);
    }
    download(`precheck_series_${stamp()}.csv`, csv(rows));
  });
})();
