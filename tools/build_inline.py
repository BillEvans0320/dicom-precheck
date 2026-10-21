"""OCR 엔진·언어 데이터를 <script>로 읽을 수 있는 JS 파일로 변환한다.

왜 필요한가: HTML 파일을 직접 열면(file://) 브라우저가 Worker 스크립트·데이터 파일 로딩을 막는다.
엔진과 데이터를 문자열로 <script>에 담아 두고 메모리(blob)에서 Worker를 만들면 온라인·오프라인 모두 동작한다.

입력: vendor-src/  (tesseract.js 5.1.1 worker, tesseract.js-core 5.1.1, @tesseract.js-data eng/kor 4.0.0_best_int)
출력: vendor/inline/*.js

tesseract.js 5.1.1 worker 수정 1곳 (Apache-2.0에 따라 수정 사실을 기록):
  언어 데이터를 객체({code, data})로 넘길 때 초기화 단계가 언어 이름 대신 data를 쓰는 버그 → code를 쓰도록 수정.
사용: python tools/build_inline.py
"""
import base64
import json
import os

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SRC = os.path.join(ROOT, "vendor-src")
OUT = os.path.join(ROOT, "vendor", "inline")

BUG = 'return"string"==typeof t?t:t.data})).join("+")'
FIX = 'return"string"==typeof t?t:t.code})).join("+")'


def write(name, var, text):
    with open(os.path.join(OUT, name), "w", encoding="utf-8") as f:
        f.write(f"window.{var}={json.dumps(text)};\n")


def main():
    os.makedirs(OUT, exist_ok=True)
    worker = open(os.path.join(SRC, "worker.min.js"), encoding="utf-8").read()
    assert worker.count(BUG) == 1, "tesseract.js worker 버전이 예상과 다릅니다 (수정 위치를 찾을 수 없음)"
    write("worker.js", "__TESS_WORKER", worker.replace(BUG, FIX))
    for name, var in (("tesseract-core-simd-lstm.wasm.js", "__TESS_CORE_SIMD"),
                      ("tesseract-core-lstm.wasm.js", "__TESS_CORE")):
        out = "core-simd.js" if "simd" in name else "core.js"
        write(out, var, open(os.path.join(SRC, "tesseract-core", name), encoding="utf-8").read())
    for lang in ("eng", "kor"):
        data = open(os.path.join(SRC, "lang", f"{lang}.traineddata.gz"), "rb").read()
        write(f"lang-{lang}.js", f"__TESS_LANG_{lang}", base64.b64encode(data).decode("ascii"))
    for f in sorted(os.listdir(OUT)):
        print(f"{f}: {os.path.getsize(os.path.join(OUT, f)) // 1024} KB")


if __name__ == "__main__":
    main()
