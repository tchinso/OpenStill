# Chrome Web Store 제출 메모

## 단일 목적

OpenStill은 사용자가 지정한 웹페이지와 CSS 선택자의 변화를 로컬에서 예약 확인하는 단일 목적의 생산성 도구입니다. 사용자가 저장하거나 가져온 URL만 열고, 해당 추적에 설정한 CSS 선택자 결과만 비교합니다. 일정과 결과는 브라우저의 동작용 캐시 및 선택적으로 같은 PC의 OpenStill Desktop에만 저장되며, Desktop의 웹사이트 콘텐츠 payload는 현재 Windows 사용자에 묶인 DPAPI로 보호됩니다.

**Single purpose (English)**

> OpenStill is a user-controlled local web page tracking tool. It opens only webpages explicitly saved or imported by the user, extracts only the CSS-selected elements configured for each tracker, and compares the results on a user-defined schedule. Schedules and results stay on the user's device in an operational browser cache and, when enabled, the same-device OpenStill Desktop companion.

## 권한 사유

| Manifest 권한 | 사용자에게 보이는 기능 | 필요 사유 |
| --- | --- | --- |
| `activeTab` | 현재 페이지에서 요소 선택 | 사용자가 툴바 버튼을 눌렀을 때 현재 탭에서 선택기를 시작합니다. |
| `scripting` | 시각적 CSS 선택기와 렌더된 요소 확인 | 사용자가 선택하거나 저장한 추적에만 패키지 안의 고정된 스크립트를 주입합니다. |
| `storage` | 동작용 캐시와 설정 | 확장이 실행 중일 때 목록·상태를 로컬에 유지합니다. |
| `unlimitedStorage` | 수백 개 추적의 안전한 가져오기 | 큰 로컬 스냅샷 때문에 사용자가 가져온 추적이 실패하지 않게 합니다. 데이터는 외부 서버로 전송되지 않습니다. |
| `alarms` | Chrome가 켜진 동안의 예약 확인 | 가장 가까운 확인 시각을 예약합니다. Desktop 연결 시에는 Desktop 일정과 동기화합니다. |
| `notifications` | 변경 감지 알림 | 실제 변경이나 확인 필요 상태만 알립니다. |
| `offscreen` | 선택자 문법 검증·알림음·초안 복사 | 서비스 워커에서 지원하지 않는 DOM 검증, 로컬 오디오, 사용자가 요청한 선택 초안의 클립보드 복사를 처리합니다. |
| `clipboardWrite` | Desktop에 붙여넣을 CSS 선택 초안 | 사용자가 저장을 누를 때 URL·선택자·일정만 담은 버전 있는 JSON 초안을 클립보드에 복사합니다. |
| `nativeMessaging` | 선택적 OpenStill Desktop 연동 | 같은 PC에 사용자가 설치한 Desktop과 제한된 스키마의 일정·상태 메시지만 주고받습니다. 개발자나 제3자 서버를 사용하지 않습니다. |
| required HTTP/HTTPS host permissions (`http://*/*`, `https://*/*`) | 수백 개 임의 도메인의 가져오기·예약 확인 | 사용자가 가져오거나 저장한 URL을 도메인별 추가 권한 대화상자 없이 예약 실행하기 위해 필요합니다. |

## 광범위 호스트 권한 사유

OpenStill은 사용자가 선택한 수백 개의 임의 도메인 추적을 가져오고 예약 실행하기 위해 HTTP/HTTPS 웹사이트 접근 권한이 필요합니다. 가져온 도메인마다 별도의 권한을 요구하면 일괄 가져오기와 예약 확인 기능을 제공할 수 없습니다. 확장 프로그램은 사용자가 명시적으로 저장한 URL만 열고, top-level 페이지가 완전히 로드된 후 최소 2.5초 뒤 해당 추적에 설정된 CSS 선택자 요소만 읽습니다. 방문 기록·관련 없는 탭·쿠키를 수집하거나 웹페이지를 변경하지 않습니다. 확인 탭은 포커스를 빼앗지 않는 왼쪽 고정 파비콘 탭으로 잠시 열리고, 확인이 끝나면 닫힙니다.

**Host-permission justification (English)**

> OpenStill needs access to HTTP and HTTPS websites because users can import and schedule trackers for hundreds of arbitrary, user-selected domains. Scheduled tracking must revisit those saved URLs without asking the user to grant a separate permission for every imported domain. The extension opens only URLs explicitly saved by the user, waits until the top-level page load is complete plus at least 2.5 seconds, and reads only the CSS-selected elements configured for that tracker. It does not collect browsing history, inspect unrelated tabs, modify websites, or access cookies.

## Native Messaging 사유

OpenStill은 사용자가 같은 PC에 설치한 선택적 OpenStill Desktop과만 Native Messaging을 사용합니다. Desktop은 일정과 결과를 로컬 SQLite 데이터베이스에 보관하고, 확장과는 스키마 검증된 URL·CSS 선택자·간격·상태 메시지만 주고받습니다. native host manifest의 `allowed_origins`에는 출시된 OpenStill 확장 ID 하나만 넣으며 와일드카드를 사용하지 않습니다.

**Native Messaging justification (English)**

> OpenStill uses native messaging only to communicate with the optional OpenStill Desktop companion installed on the same computer. The companion stores user schedules and tracking results locally and exchanges only schema-validated tracker configuration and status messages. No browsing data is sent to developer-controlled servers or third parties.

## 사용자 대상 고지문 초안

> OpenStill은 사용자가 추적으로 명시적으로 추가한 웹페이지의 URL과 선택한 요소의 콘텐츠만 읽습니다. 예약 확인 시 Chrome과 확장 프로그램이 실행 중인 경우에만 저장된 추적 URL을 열며, 페이지가 완전히 로드된 뒤 최소 2.5초 후 사용자가 지정한 CSS 선택자 요소만 추출합니다. URL, 선택자, 일정, 결과는 브라우저와 선택적으로 활성화한 동일 PC의 OpenStill Desktop에 로컬 저장됩니다. OpenStill은 관련 없는 방문 기록을 수집하지 않고, 사용자 데이터를 판매하거나 광고에 사용하거나 개발자 서버로 전송하지 않습니다.

**Prominent disclosure (English)**

> OpenStill reads the URL and selected page content only from webpages that you explicitly add as trackers. For scheduled checks, it opens only your saved tracker URLs while Chrome and the extension are running, waits for full page load plus at least 2.5 seconds, and extracts only the CSS-selected elements you configured. URLs, selectors, schedules, and results are stored locally in the browser and, if enabled, in the OpenStill Desktop companion on the same computer. OpenStill does not collect unrelated browsing history, sell user data, use it for advertising, or transmit it to developer-controlled servers.

## 요청하지 않는 항목과 구현 제한

- `tabs`, `cookies`, `history`, `webRequest`, `downloads`, `contextMenus`, 정적 content script, `all_frames`
- 원격 호스팅 JavaScript/Wasm, `eval`, 원격에서 받은 코드의 실행
- 로그인·페이월·CAPTCHA 우회, 자동 사이트 발견, 관련 없는 탭의 검사

Desktop이 보내는 값은 URL·CSS 선택자·이름·라벨·간격처럼 고정 스키마의 선언형 데이터만 허용합니다. DOM 추출 로직과 주입 스크립트는 모두 확장 패키지에 포함되어 있습니다.

## 업로드 전 점검

- 실제 배포 URL에서 [PRIVACY.md](PRIVACY.md)의 내용을 공개한다.
- Store Privacy practices에서 Website content와 Browsing activity가 기능 제공을 위해 로컬 처리되고 판매·공유되지 않음을 실제 동작과 일치하게 신고한다.
- Privacy practices에서 원격 코드를 사용하지 않는다고 정확히 신고한다.
- native host와 Desktop 실행 파일은 Chrome Web Store ZIP에 넣지 않고, 별도 Desktop 설치 단계에서 등록한다.
- 배포 ZIP에서 `References/`, `desktop/`, `.git/`, 테스트, 개발 문서, 임시 파일을 제외한다.
- `manifest.json`의 권한, Store listing, 이 문서, 개인정보처리방침의 표현이 일치하는지 확인한다.
