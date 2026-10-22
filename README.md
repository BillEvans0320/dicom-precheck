# DICOM 업로드 전 점검

임상시험 영상 업로드 전에 한 번 돌리는 브라우저 도구입니다.

1. 영상에 환자정보 글씨가 찍혀 있을 수 있는 파일(리포트·화면 캡처 등)을 찾아 업로드 대상에서 분리합니다.
2. 남은 파일의 DICOM 헤더에서 환자정보 30개 항목을 지우고, 결과를 ZIP 파일 하나로 저장합니다.

**영상은 사용하는 PC 밖으로 전송되지 않습니다.** 모든 처리는 브라우저 안에서 이루어지며, 원본 파일은 수정하지 않습니다.
페이지에는 외부 서버 연결을 막는 보안 설정(Content-Security-Policy)이 들어 있습니다.

## 사용법

1. Chrome 또는 Edge에서 페이지를 엽니다.
   - 웹: GitHub Pages 주소
   - 오프라인: 이 저장소를 내려받아 `index.html`을 직접 엽니다. 인터넷 없이도 모든 기능이 동작합니다.
2. DICOM 폴더나 ZIP 파일을 선택하거나 끌어다 놓고 **점검 시작**을 누릅니다.
3. 후보 파일의 썸네일을 보고 파일마다 **업로드 / 제외**를 정합니다.
4. **비식별화 후 ZIP 저장**을 누르고 저장 위치를 고릅니다(기본: 다운로드 폴더).

## 처리 과정

| 단계 | 내용 |
|---|---|
| 헤더 스캔 | 모든 파일의 헤더만 읽습니다(영상 데이터는 읽지 않음). |
| 후보 선정 | SOP Class가 Secondary Capture·PDF·SR·파형·DICOMDIR인 파일, 또는 Modality가 OT·SC·EK·ECG·DOC·US·XC이거나 BurnedInAnnotation=YES·오버레이가 있는 파일. 일반 CT·MR 영상과 재구성 영상은 OCR하지 않음 |
| OCR | 후보만 글자 인식(영어·한글). 시리즈마다 대표 3장(첫·가운데·마지막)을 먼저 검사하고, 하나라도 정상이 아니거나 3장의 단어 수가 10개 이상 차이 나면 시리즈 전체를 검사. 그 외에는 나머지 장도 대표 3장의 결과를 따라 정상으로 판정. 오버레이 글씨와 JPEG 압축 영상도 읽음 |
| 판정 | OCR 신뢰도 60점 이상인 단어만 사용. Name·Patient ID·Birth·성명·등록번호 등 → **유력**, Sex·Age·Physician·Operator 등이나 7자리 이상 숫자, OCR 불가 → **확인 필요**, 그 외 → **정상**. JLK 분석 결과물(제조사 JLK)은 유력이 아니면 **JLK 분석 결과**로 따로 분류(OCR 결과는 카드에 함께 표시) |
| 비식별화 | '업로드'로 정한 파일의 30개 태그 값을 같은 길이의 공백으로 덮어씀(시퀀스 안쪽 포함). 영상 데이터와 나머지 부분은 바이트 단위로 그대로 |
| 재점검 | 저장하는 모든 파일을 다시 읽어 30개 태그가 비었는지 확인. 실패한 파일은 ZIP에 넣지 않음 |

기본값: 유력 → 제외, 확인 필요·JLK 분석 결과·정상·일반 영상 → 업로드. 화면에는 유력·확인 필요·JLK 분석 결과 탭만 표시하고(정상은 개수만), 탭마다 '이 탭 모두 제외/업로드' 버튼이 있음.

### 지우는 태그 (30개)

PatientName, PatientID, PatientBirthDate, PatientBirthTime, PatientAddress, OtherPatientIDs, OtherPatientNames,
IssuerOfPatientID, PatientAge, PatientBirthDateInAlternativeCalendar, AccessionNumber, InstitutionName,
InstitutionAddress, RouteOfAdmissions, ReferringPhysicianName, ReferringPhysicianAddress,
ReferringPhysicianTelephoneNumbers, ReferringPhysicianIdentificationSequence, PerformingPhysicianName,
ConsultingPhysicianName, ConsultingPhysicianIdentificationSequence, RequestingPhysician, PhysiciansOfRecord,
NameOfPhysiciansReadingStudy, OperatorsName, ScheduledPerformingPhysicianName, NamesOfIntendedRecipientsOfResults,
ContentCreatorName, InterpretationAuthor, PhysicianApprovingInterpretation

검사 날짜, 성별, UID, 제조사 전용(private) 태그는 지우지 않습니다.

## 한계

- **영상에 찍힌 글씨는 지우지 않습니다.** 글씨가 있는 파일은 '제외'해야 합니다.
- OCR은 보조 수단입니다. 작거나 흐린 글씨는 놓칠 수 있고, 후보가 아닌 일반 영상은 OCR하지 않습니다
  (옵션으로 시리즈마다 1장씩 검사 가능).
- 시리즈 대표 판정은 같은 시리즈 영상의 형식이 같다는 가정에 기반합니다. 대표 3장과 형식이 다른 장이 시리즈 중간에만 있으면 놓칠 수 있습니다.
- JPEG 외 압축 영상(JPEG 2000, JPEG Lossless 등)은 썸네일과 OCR을 할 수 없어 '확인 필요'로 표시됩니다.
- 암호가 걸린 ZIP과 ZIP 안의 ZIP은 읽지 않습니다.

## 파일 구성

| 경로 | 내용 |
|---|---|
| `index.html`, `style.css` | 화면 |
| `js/core.js` | 헤더 읽기, 후보 선정, OCR 판정, 비식별화·재점검 |
| `js/app.js` | 화면 동작 |
| `js/zip.js`, `js/unzip.js` | ZIP 쓰기(ZIP64 지원)·읽기 |
| `vendor/` | 외부 라이브러리와 OCR 엔진·언어 데이터 |
| `tools/build_inline.py` | `vendor-src/`의 OCR 엔진·언어 데이터를 `vendor/inline/`으로 변환 |

## 사용한 외부 라이브러리

- [dicomParser](https://github.com/cornerstonejs/dicomParser) 1.8.21 — MIT
- [Tesseract.js](https://github.com/naptha/tesseract.js) 5.1.1, tesseract.js-core 5.1.1 — Apache-2.0
- Tesseract 언어 데이터 eng·kor (4.0.0_best_int) — Apache-2.0

라이선스 전문은 `vendor/licenses/`에 있습니다.
Tesseract.js worker는 한 곳을 수정했습니다(언어 데이터를 객체로 넘길 때 언어 이름 대신 데이터를 쓰는 문제).
수정 내용은 `tools/build_inline.py`에 기록되어 있습니다.

## 저작권

Copyright (c) 2026 Hyochul Lee. All rights reserved.

연구실 내부 사용 목적으로 제작되었습니다. 이 저장소의 코드(외부 라이브러리 제외)를 복제·수정·재배포할 수 없습니다.
이 도구는 있는 그대로 제공되며, 비식별화의 완전성을 보장하지 않습니다. 업로드 전 최종 확인은 사용자가 해야 합니다.
