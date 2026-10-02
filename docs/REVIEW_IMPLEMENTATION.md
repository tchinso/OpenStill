# 검토보고서 적용 내역

검토 기준: 사용자가 제공한 저장·복원·캡처·실시간·대량 운영·화면 검토보고서. 작성일: 2026-10-02.

아래의 구현 내역은 소스와 회귀 검사에 대응한다. 모형 Chrome API 검사, 실제 Chromium의 DOM·IndexedDB 검사, 실제 사용자 프로필에서의 장기 운영 검증은 서로 구분한다. 테스트를 통과했다는 이유로 모든 사이트·브라우저 재시작·디스크 장애에서 무손실을 보장한다고 해석하지 않는다.

## 저장과 자동 복구

| 요구 ID | 적용한 변경 | 검증 근거 |
| --- | --- | --- |
| S01–S03 | 정상 추적과 해석 실패 원본을 분리. 레코드 단위 IndexedDB transaction, 마이그레이션 원본 컨테이너·손상 봉투 보존, 이전 정상본 회수. 무관한 정상 추적 변경은 다른 원본을 삭제하지 않음 | service-worker import 회귀 검사, storage-browser의 손상 혼합·컨테이너·세대·중간 transaction 실패 사례 |
| S04–S05 | 원문/저장 길이, 지문 버전, 잘림 플래그를 보존. 항목별 실제 사용량으로 예산 배분. 반복 정규화·백업 뒤 원문 지문 유지 | 999,999/1,000,000/1,000,001자 경계, 700,000자+4자 사례 |
| S06 | 주소 이동에서 기준·변경·읽음·이력을 유지하고 주소 이력 추가. 이동/복제의 실제 대상·효과를 실행 전에 표시 | 주소 이동 회귀 검사 및 dashboard 주소 변경 경로 점검 |
| S07–S08 | 복원 가능 0건의 불량 replace는 기존 자료 유지. 명시적 빈 입력과 구분. Date 범위 검사로 잘못된 날짜만 수리 | 불량 replace 및 범위 밖 숫자 날짜 회귀 검사 |
| R01–R03 | 불량 locator·일정은 해당 추적만 중지하고 정상 본문·이력·이름을 회수. exists 추론 및 aggregate fallback을 진단. 수리 전 원문 보존 | 불량 필드 혼합과 aggregate 본문·exists 추론 회귀 검사 |
| R04 | 정상 history/runs 후보를 확인한 뒤 운영 보존 한도를 적용. 기준 내용 복구 후보와 화면용 최근 이력을 구분 | 손상 앞부분 뒤 정상 이력·실행 기록 회수 검사 |
| R05–R07 | 누락·공백·중복 ID와 revision의 복구 결과를 지속 저장. 문자열 boolean 안전 수리, 불확실한 실행 설정 비활성화 | 재시작 후 ID 안정성·중복 ID·문자열 false 사례 |
| R08 | 레코드 schema와 추가 필드·원문을 보존. 지원 불가 미래 schema의 파괴적 수정 차단 | 미래 record schema 및 확장 필드 보존 검사 |

현재 스냅샷은 불변 자료로 별도 저장하고 추적에서 참조한다. 레코드별 이전 정상본과 스냅샷 검증 복사본을 유지한다. 삭제·교체 원본은 복구함에 남는다. 현재본·복사본·이전본이 함께 손상되었거나 이전 버전에서 이미 잘려 없어진 원문은 내부 자료만으로 재생성할 수 없다.

## 백업과 부분 복원

| 요구 ID | 적용한 변경 | 검증 근거 |
| --- | --- | --- |
| B01–B02 | 손상 파일·누락 part·불완전 조각과 정상 독립 레코드를 분리. 정상 자료 먼저 회수, 불완전 원문·누락 목록을 지속 보관 | recovery-json 스트리밍 오류 격리, import 부분 복원·조각 검사 |
| B03–B04 | 정상·수리·복구 원본 수를 대조하여 모두 백업. 내용뿐 아니라 part 순서·세트 ID·완료·개수 정보를 보호하는 봉투와 세트 manifest | backup-integrity 봉투·세트 변조 검사, 원본 포함 export 검사 |
| B05 | 동일 ID+동일 내용은 건너뜀. 동일 ID+다른 내용은 양쪽 보존. URL만으로 추적 병합하지 않음 | 반복 불러오기·ID 충돌·재시작 뒤 commit 재생 검사 |
| B06–B07 | 파일 원본·준비 레코드·조각·세션·내보내기 checkpoint·저장 영수증을 지속 저장. 같은 세션에서 보관 파일 재해석·누락 파일 추가·부분 복원 재시도. 다운로드 확인 뒤 cursor/manifest를 저장하여 내보내기 재개 | staging 재시작·commit 응답 소실 검사. 실제 dashboard에서 보관 파일과 추가 파일을 같은 세션으로 처리하고 retry:true 확인. 실제 생성 blob의 다운로드 실패 뒤 세트 ID·cursor·manifest 재개 검사 |
| B08 | 파일 스트리밍, 레코드 ACK backpressure, 디스크 staging과 UTF-8 예산. v5에서 SHA 스냅샷과 추적 참조를 분리하여 반복 본문 복제 감소 | 멀티바이트 경계·해석 예산·backpressure 검사 및 실제 IndexedDB 검사 |
| B09–B10 | 같은 digest의 중복 part 통합, 서로 다른 세트를 분리. 충돌·수리·누락 원문과 파일/레코드/위치/필드 진단 보존 | backup-integrity 중복·혼합 세트 및 import 진단 검사 |
| B11–B12 | 워커 오류·응답 없음·취소 때 버튼과 화면 복구, 중단 시 staging 유지. 전역 알림음과 대시보드 정렬 설정도 백업 | 워커 error/messageerror/watchdog/abort 경로 점검, 설정 transaction 검사 |

백업은 v5를 생성하고 v2·v3·v4를 읽는다. 각 출력 파일은 32 MiB 미만이다. 독립 JSON 레코드 해석 예산은 UTF-8 16 MiB, 이전 형식 조각의 전체 조립 예산은 64 MiB다. 예산을 초과한 레코드는 원본을 보관하고 복구 대기로 표시한다. 누락 부분을 추측하여 정상 내용으로 합성하지 않는다. 이전 형식이 제공하지 않은 원문·지문·완료 정보를 소급해서 증명하지 않는다.

## 캡처와 실시간 감시

| 요구 ID | 적용한 변경 | 검증 근거 |
| --- | --- | --- |
| C01, C06 | template.content·중첩 template·주석·shadow 처리. 원본 DOM/base는 읽기 전용, detached 자료에서만 직렬화 | 실제 Chromium template·원본 DOM 불변 검사 |
| C02–C04 | 의미 있는 frame query 유지. 명시적 변동 파라미터만 제외. frameUrl-only 지원, 부모 iframe의 안정적 속성으로 식별하고 모호한 frame은 확인 필요 처리 | frame query·중복 URL·frameUrl-only 검사, 실제 cross-origin iframe fixture |
| C05 | 정규식을 종료 가능한 별도 Worker에서 실행하고 시간 초과 시 종료. 이전 정상 자료 유지 | catastrophic regexp timeout과 worker terminate 검사 |
| C07–C09 | 동일 요소의 locator field 합집합, locator별 match·품질 정보, 빈 결과 재시도는 최종 결과만 비교 | 실제 다중 field·부분 locator·빈 재시도 검사 |
| C10–C12 | 추적 간 XCSS 상태 누출 제거. 원본 property의 0/false 유지. XPath attribute 처리, 지원하지 않는 text/comment 결과는 수정 안내 | 실제 CSS→XCSS→CSS, property, XPath 및 offscreen 검증 일치 검사 |
| L01–L02 | live에서도 전체 지정 frame을 캡처. 저장 성공 뒤에만 dedupe cache 전진, 저장 실패 결과 재시도 | 다중 frame 검사, live 저장 실패 뒤 같은 내용 재시도 검사 |
| L03–L04 | revision 변경 뒤 observer 재연결. 일시정지·삭제는 commit 뒤 실행 상태 정리 | 라벨 변경·저장 실패 pause/delete 회귀 검사 |
| L05–L06 | 선택한 text/data 표현을 dedupe에 사용. 임의 속성·input/change·DOM property polling 관찰 | 동일 텍스트의 링크 변경과 observer 감시 범위 검사 |

게시물 대응은 사이트 ID·사용자 identity attribute·permalink를 우선한다. 같은 ID의 수정과 순서 변경을 분리하고, 키가 없으면 전체 내용 지문과 중복 발생 횟수를 사용한다. iframe의 transient frameId를 게시물 정체성으로 사용하지 않는다. 화면에서 사라진 항목은 **관측 목록 이탈**이며 서버의 영구 삭제를 증명하지 않는다.

## 종료 복구와 대량 운영

| 요구 ID | 적용한 변경 | 검증 근거 |
| --- | --- | --- |
| W01–W03 | 생성 직후 소유 탭·job 단계·브라우저 세션 기록. 재시작 시 검증된 소유 탭 정리·작업 복구. 불확실한 탭은 자동 종료하지 않고 사용자가 후보 주소·탭 번호를 확인하여 연결/정리/해제 | interrupted job·이전 세션 소유권·실제 dashboard 복구 dialog 검사 |
| W04–W06 | 추적별 lifecycle queue와 single flight. 제거 실패 시 pendingCleanup 유지. 닫힌 live 탭은 실제 연결/대기 상태와 복구 정책 반영 | 동시 live start, 제거 실패, 소유권 해제·재연결 검사 |
| W07–W08 | 초기화 singleton. badge 등 부수 실패와 필수 엔진 복구 분리. observer 프레임별 result.ok 확인 | 초기화·badge 실패 및 observer ok:false 검사 |
| W09–W10 | 캡처 watchdog·취소·탭 정리. underlying 작업이 끝날 때까지 중복 실행 제한 | timeout 뒤 single-flight lock과 interrupted capture 검사 |
| W11–W13 | 새 alarm 생성 실패 시 기존 예약 유지. 저장 장애 backoff, 제한된 pending capture 보관. 변경 API는 commit 결과·operation ID·후처리 경고를 분리 | alarm 실패·저장 장애·commit 뒤 badge/alarm 실패·영수증 재생 검사 |
| 10,000개 구조 요구 | 최대 10,000개, 레코드별 쓰기·불변 스냅샷 참조·경량 요약·ID lookup·지연 상세 조회·분할 상세 전송. 모든 확인 경로가 전역 6개/origin별 2개 큐 공유. resident live 탭 최대 12개 | 실제 IndexedDB 10,000개 중 1개 변경, 대형 blob 미재기록 검사, 혼합 10,000개 큐와 resident 상한 검사 |

대시보드는 진행·대기 수와 실제 최장 대기 시간·상주 탭·정리/소유권 확인·저장 재시도 상태를 표시한다. 5초 일정을 표현할 수 있다는 것은 10,000개 주소를 5초마다 확인한다는 약속이 아니다. DOM 준비 뒤 초기 약 2초 대기, 추가 대기, 네트워크·캡처 비용과 전역 큐가 실제 처리 시간을 결정한다. Chrome 알람·서비스 워커 수명 때문에 짧은 주기의 실제 실행도 늦어질 수 있다.

## 대시보드와 변경 상세

| 요구 ID | 적용한 변경 | 검증 근거 |
| --- | --- | --- |
| U01–U02 | 완료·실패·일시정지·누락·충돌·미처리 개수 분리. 실패 재시도, 모든 선택 ID를 chunk 처리, 실패/미처리 선택 유지 | 전체 실패, 1,001개 부분 실패, 10,000개 전체 삭제의 실제 dashboard 검사 |
| U03 | 편집 JSON 오류 행·원문 표시 후 저장 차단. identityAttribute·frameUrl/path·변동 파라미터 등 metadata 보존 | invalid locator·수정 전송 없음·metadata 보존 browser 검사 |
| U04–U06 | 48px 가상 행, viewport+overscan만 DOM 생성. ID별 요약 patch, scroll anchor·focus·selection 보존. 필요한 local 키만 구독. ID·URL·검색·라벨 index | 실제 Chromium 30/1,000/10,000개: 첫 화면 각각 22행/목록 element 179개. 저장소 ID patch 뒤 focus·scroll 유지 |
| U07–U08 | 표시/숨김/전체 선택 수, viewport/검색 결과/전체 선택. 페이지 삭제·주소 이동·복제·도메인 일괄 변경의 실제 범위 표시 | 숨김 9,999개 포함 선택 및 scope 문구 browser 검사/코드 점검 |
| U09–U10 | 기본 행에서 선택자·상세 일정·이력을 이동. 라벨 검색·빈도 정렬·40개씩 더 보기·독립 스크롤 | compact row DOM/CSS 검사 및 label index 점검 |
| U11–U13 | finally 버튼 복구, 제출 lock·operation ID, expectedRevision/expectedChangeId 및 변경 필드만 전송 | refresh 실패 뒤 버튼 복구, 중복 제출 1건, stale revision/change 검사 |
| U14–U17 | origin 전체(프로토콜·포트 포함), 표시/전체 개수·badge 기준 구분, pageTitle 검색, 실행 상태와 unread 별도 표시 | pageTitle 검색 및 표시/숨김 선택 browser 검사, compact row/popup 경로 점검 |
| U18–U20 | 최근 변경 기본 정렬, 미확인·오류 quick filter, 요약 숫자 버튼, 전체 이름·URL dialog/복사. 주요 행 글씨 13–14px | summary/filter/detail/CSS 경로 점검 및 browser DOM 검사 |
| 항목 alignment 요구 | ID 우선 연결, 완전한 내용 지문·중복 횟수, 순서 변경 표시. 큰 목록·텍스트는 공통 anchor로 분할하여 유지 부분을 보존 | 5/110/1,000/10,000개 head insertion, 같은 제목·다른 링크, 중복·재정렬, text-only 250행, 반복 10,000행 검사 |
| 상세 제한·빈 값·이력 요구 | 5,000 DOM 노드·180,000자 이후를 조용히 숨기지 않음. 큰 내용은 부분 표시·다음 변경 이동. 구조화 항목은 80개씩 표시, 긴 개별 항목도 tail 변경 표시. 생략·저장 당시 잘림·관측 빈 값 구분 | 실제 Chromium 180k 이후 tail 변경·10,000개 structured item·큰 identity item·omitted/empty 이력 검사 |
| 문구 일치 요구 | 전용 pinned live 탭, DOM 준비+약 2초, 주소 이동 이력 유지, 부분 복원·복구 원본·v5 백업·설정 범위로 README/PRIVACY/STORE_SUBMISSION 갱신 | 문서/실행 경로 대조 |

## 검증 범위와 실제 브라우저의 한계

- `tests/dashboard-core.test.js`는 DOM 없는 비교·정렬 범위·파싱·결과 합계를 검증한다. `tests/dashboard-browser.test.js`는 실제 Chrome headless에서 프로젝트 HTML/CSS/JS를 실행하여 DOM 수·행 높이·focus·scroll·diff·양식·일괄 동작을 검증한다. 내보내기 blob을 읽어 v5 봉투·manifest를 검증하고, 실제 Worker·IndexedDB로 보관 파일 재해석과 추가 파일 처리를 검사한다. Chrome 확장 API·다운로드 완료/실패 상태는 fixture이므로 실제 사용자 탭/알람/다운로드 시스템까지 검증한 것으로 보지 않는다.
- `tests/storage-browser.test.js`는 실제 Chromium IndexedDB transaction·중간 실패 rollback·손상 현재본/복사본/이전본·staging 재시작·10,000개 중 단일 레코드 쓰기를 검증한다. OS 전원 차단, 실제 Chrome 프로필 삭제·디스크 전체 손상은 재현하지 않았다.
- `tests/capture-browser.test.js`는 실제 DOM과 cross-origin frame fixture를 사용한다. 로그인 세션·CAPTCHA·보호된 iframe·모든 SPA의 지연 로딩을 보장하지 않는다. closed shadow root와 브라우저가 주입을 금지하는 영역에는 일반 스크립트의 접근 한계가 남는다.
- `tests/import-worker-browser.test.js`는 실제 Worker·File.stream·IndexedDB에서 ACK 대기, 손상 원문 보관, 종료 후 파일 재해석 및 v5 봉투 검증을 검사한다. `tests/extension-browser.test.js`는 임시 Edge 프로필에 실제 unpacked 확장을 로드하여 서비스 워커·대시보드와 실제 runtime 메시지의 import/export/삭제/재복원 왕복을 확인했다. 사용자 프로필은 변경하지 않았다.
- `tests/runtime-safety.test.js`의 10,000개 혼합 큐·종료 복구·상주 한도·저장 장애 검사는 제어 가능한 API 모형이다. 실제 인터넷 10,000개 주소의 장기 처리량·CPU/메모리 최고점·Chrome 강제 종료/업데이트/절전 조합은 별도 운영 검증이 필요하다.
- 내부 이전본·검증 복사·복구함은 같은 프로필에 존재한다. 모든 내부 사본 손상·확장 제거·프로필 손실에 대비하려면 사용자가 내보낸 외부 백업이 필요하다. 기존 저장에서 이미 사라진 원문은 되살릴 수 없다.
- 실행 명령: `node --test tests/*.test.js`. 실제 browser suite에는 Playwright와 Chrome/Chromium 실행 파일이 필요하며, 환경이 없으면 해당 검사는 skip된다. 최종 결과에는 skip을 성공한 browser 검증으로 합산하지 않는다.

변경을 마무리한 뒤 전체 회귀 검사와 실제 browser suite를 함께 실행하고, 실행 환경·통과·실패·skip 결과를 구분해 기록한다. 실제 장기 운영·전원 차단·프로필 손상은 위 검사 범위에 포함되지 않는다.

## 최종 검증 결과

2026-10-02, Node와 Playwright 및 설치된 Chrome/Edge로 검증했다. 전체 143개를 실행하여 142개 통과와 1개 실패를 확인했다. 실패한 검사는 이전 v4 레코드 위치를 기대하던 저장 세션 검사였으며, v5의 추적 참조·스냅샷 본문·SHA를 확인하도록 수정했다. 이 검사 재실행은 1개 통과·실패 0·skip 0이다. 다른 142개에는 영향을 주는 소스 변경이 없어 결과를 재사용했다. 최종 검증된 143개 모두 통과했으며 skip은 없다.

실제 확장 smoke도 1개 통과·skip 0이며 Edge를 사용했다. 저장 경계 999,999/1,000,000/1,000,001자는 반복 정규화·무관한 라벨 변경·v5 백업 왕복을 모두 확인했다. JavaScript 운영 파일 14개의 구문과 Git diff 공백 검사가 통과했다. `dist/OpenStill-chrome-store.zip`에는 26개 파일과 모든 신규 운영 모듈이 포함된다.
