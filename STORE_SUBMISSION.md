# Chrome Web Store 제출 메모

## 단일 목적

OpenStill은 사용자가 지정한 웹페이지와 typed locator(CSS, XCSS, XPath)의 변화를 브라우저 로컬에서 확인하는 단일 목적의 생산성 도구입니다. 사용자가 저장하거나 가져온 URL만 열고, 해당 추적에 설정한 locator 결과만 비교합니다. 일정과 결과는 Chrome 로컬 저장소에만 저장됩니다.

**Single purpose (English)**

> OpenStill is a user-controlled local web page tracking tool. It opens only webpages explicitly saved or imported by the user, extracts only the CSS-selected elements configured for each tracker, and compares the results on a user-defined automatic schedule or when the user manually requests a check. Schedules and results stay in the browser's local storage.

## 권한 사유

| Manifest 권한 | 사용자에게 보이는 기능 | 필요 사유 |
| --- | --- | --- |
| `activeTab` | 현재 페이지에서 요소 선택 | 사용자가 툴바 버튼을 눌렀을 때 현재 탭에서 선택기를 시작합니다. |
| `scripting` | 시각적 CSS 선택기와 렌더된 요소 확인 | 사용자가 선택하거나 저장한 추적에만 패키지 안의 고정된 스크립트를 주입합니다. 실시간 감시를 명시적으로 연결한 경우에는 해당 열린 페이지의 접근 가능한 프레임에도 같은 고정 observer를 주입합니다. |
| `storage` | 로컬 추적 데이터와 설정 | 확장이 실행 중일 때 목록·상태를 로컬에 유지합니다. |
| `unlimitedStorage` | 최대 10,000개 추적과 복구 자료 보관 | IndexedDB에 추적·불변 스냅샷·이전 정상본·삭제 원본·손상 파일과 작업 준비 자료를 보관합니다. 브라우저 자원 한계는 존재하며 데이터는 외부 서버로 전송되지 않습니다. |
| `alarms` | Chrome가 켜진 동안의 자동 예약 확인 | 가장 가까운 자동 확인 시각을 예약합니다. 수동 추적은 알람으로 갱신하지 않습니다. |
| `notifications` | 변경 감지 알림 | 실제 변경이나 확인 필요 상태만 알립니다. |
| `offscreen` | 선택자 문법 검증, 정규식 필터, 알림음 | 서비스 워커에서 지원하지 않는 DOM 검증과 로컬 오디오 재생, 시간 제한으로 종료할 수 있는 정규식 Worker를 처리합니다. |
| `webNavigation` | 저장된 iframe locator의 frame ID 확인 | 사용자가 선택한 하위 프레임에만 해당 locator를 실행하고, 새로고침 후에도 URL 기반 frame 경로로 다시 찾아 접근 불가 프레임을 변경으로 오인하지 않기 위해 필요합니다. |
| `tabs` | 저장 URL의 확인·실시간 전용 탭 관리 | 비활성 고정 탭을 생성하고 소유권·진행·정리 상태를 보관합니다. 상주 실시간 탭은 최대 12개이며, 관련 없는 탭의 콘텐츠를 읽거나 소유권이 불확실한 탭을 자동으로 닫지 않습니다. |
| `downloads` | 사용자가 요청한 분할 JSON 백업 저장 | 내보내기 버튼을 눌렀을 때만 각 JSON 파일을 저장하고, 그 확장이 만든 파일의 완료·실패 상태만 확인합니다. 기존 다운로드 목록은 조회·저장하지 않습니다. |
| required HTTP/HTTPS host permissions (`http://*/*`, `https://*/*`) | 수백 개 임의 도메인의 가져오기·예약 확인 | 사용자가 가져오거나 저장한 URL을 도메인별 추가 권한 대화상자 없이 예약 실행하기 위해 필요합니다. |

## 광범위 호스트 권한 사유

OpenStill은 사용자가 선택한 임의 도메인 추적을 가져오고 자동 예약 실행하기 위해 HTTP/HTTPS 웹사이트 접근 권한이 필요합니다. 가져온 도메인마다 별도의 권한을 요구하면 일괄 가져오기와 예약 확인 기능을 제공할 수 없습니다. 저장한 URL만 열고, 초기 캡처는 DOM 준비 뒤 약 2초와 설정된 추가 대기를 적용하여 CSS/XCSS/XPath locator 결과만 읽습니다. 모든 자원의 완전한 로드를 기다린다고 보장하지 않습니다. 방문 기록·관련 없는 탭·쿠키를 수집하거나 원본 DOM을 변경하지 않습니다. 일회성 확인 탭은 포커스를 빼앗지 않는 고정 전용 탭으로 잠시 열며, 실시간 감시는 별도 상주 전용 탭에서 연결합니다.

**Host-permission justification (English)**

> OpenStill needs HTTP and HTTPS access to revisit arbitrary domains explicitly saved or imported by the user. Initial capture waits for DOM readiness, then approximately two seconds plus the configured additional delay, and reads only configured CSS/XCSS/XPath locator results. It does not guarantee complete resource loading, collect browsing history, inspect unrelated tab content, modify the original DOM, or read cookie values. Checks use inactive pinned tabs; live tracking uses dedicated resident tabs.

## 사용자 대상 고지문 초안

> OpenStill은 사용자가 추적으로 명시적으로 추가한 URL과 locator 결과만 읽습니다. 자동 확인은 Chrome과 확장이 실행 중일 때만 처리하며, 수동 추적은 확인 요청 시에만 갱신합니다. 초기 캡처는 DOM 준비 뒤 약 2초와 설정된 추가 대기를 적용합니다. 실시간 감시는 별도 고정 전용 탭에서 동작합니다. URL, 선택자, 일정, 결과, 이전 정상본과 복구 원본은 브라우저 로컬에 저장됩니다. 추적 삭제 후에도 복구 원본이 남을 수 있습니다. 관련 없는 방문 기록을 수집하지 않고 데이터를 판매·광고 사용·개발자 서버 전송하지 않습니다.

**Prominent disclosure (English)**

> OpenStill reads saved URLs and configured locator results while Chrome and the extension are running. Initial capture waits for DOM readiness, then approximately two seconds plus the configured additional delay. Live tracking uses dedicated pinned tabs. Trackers, snapshots, previous versions, recovery originals, settings, and operation progress stay locally in the browser. Deleting a tracker can retain a recovery copy. OpenStill does not collect unrelated browsing history, sell user data, use it for advertising, or transmit it to developer-controlled servers.

## 요청하지 않는 항목과 구현 제한

- `cookies`, `history`, `webRequest`, `contextMenus`, 정적 content script
- 기존 다운로드 목록의 조회·저장(`downloads`는 사용자가 요청한 백업 파일 저장과 해당 파일 상태 확인에만 사용)
- 원격 호스팅 JavaScript/Wasm, `eval`, 원격에서 받은 코드의 실행
- 로그인·페이월·CAPTCHA 우회, 자동 사이트 발견, 관련 없는 탭의 검사

DOM 추출 로직과 주입 스크립트는 모두 확장 패키지에 포함되어 있습니다.

최대 등록 수는 10,000개이며 캡처는 모든 경로에서 전역 6개·origin별 2개의 공통 큐를 사용합니다. 짧은 일정이 실제 처리 시간을 보장하지 않으며, Chrome 알람·네트워크·서비스 워커 수명·대기열에 따라 지연될 수 있습니다. 상주 실시간 탭은 최대 12개입니다. 백업에는 설정과 복구 대기 원본을 포함하며, 불완전 파일에서도 완전한 독립 레코드를 먼저 복원합니다. 큰 입력은 해석 예산과 브라우저 자원에 따라 복구 대기에 남을 수 있습니다.

## 업로드 전 점검

- 실제 배포 URL에서 [PRIVACY.md](PRIVACY.md)의 내용을 공개한다.
- Store Privacy practices에서 Website content와 Browsing activity가 기능 제공을 위해 로컬 처리되고 판매·공유되지 않음을 실제 동작과 일치하게 신고한다.
- Privacy practices에서 원격 코드를 사용하지 않는다고 정확히 신고한다.
- 배포 ZIP에서 `References/`, `.git/`, 테스트, 개발 문서, 임시 파일을 제외한다.
- `manifest.json`의 권한, Store listing, 이 문서, 개인정보처리방침의 표현이 일치하는지 확인한다.
