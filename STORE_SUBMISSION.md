# Chrome Web Store 제출 메모

## 단일 목적

OpenStill은 사용자가 선택한 웹페이지 요소의 텍스트 변화를 정기적으로 비교하고 알리는 단일 목적의 생산성 확장 프로그램입니다.

## 권한 사유

| Manifest 권한 | 사용자에게 보이는 기능 | 필요 사유 |
| --- | --- | --- |
| `activeTab` | 현재 페이지에서 요소 선택 | 사용자가 툴바 버튼을 눌렀을 때 한 탭에만 임시 접근합니다. |
| `scripting` | 시각적 요소 선택기 | 사용자가 요청한 선택기를 현재 탭에만 주입합니다. |
| `storage` | 모니터·라벨·텍스트 기준값 저장 | 데이터를 브라우저 로컬에 보관합니다. |
| `alarms` | 1시간~14일 주기 검사 | 가장 가까운 검사 시각을 예약합니다. |
| `notifications` | 변경 감지 알림 | 실제 변경이 생길 때만 시스템 알림을 표시합니다. |
| `offscreen` | CSS 선택자 문법 검증 및 알림음 | 서비스 워커에서 지원하지 않는 DOM 문법 검증과 로컬 Web Audio 알림음을 처리합니다. |
| optional HTTP/HTTPS host permissions | 저장한 사이트의 정기 확인 | 사용자가 허용한 정확한 origin을 비활성 임시 탭에서 렌더링하고 선택 요소를 검사합니다. |

## 권한을 요청하지 않는 항목

- `tabs`, `cookies`, `history`, `webRequest`, `downloads`, `unlimitedStorage`, `contextMenus`
- 설치 시점의 `<all_urls>` host permission
- 정적 content script, `all_frames`, remote hosted code

## 공개 문구 초안

> OpenStill은 사용자가 고른 웹페이지 요소의 텍스트 변경을 알려줍니다. 선택한 사이트에만 접근하고, URL·선택자·텍스트 기준값은 브라우저에만 저장됩니다. 개발자나 제3자 서버로 데이터를 전송하지 않습니다.

## 업로드 전 점검

- 실제 배포 URL에서 [PRIVACY.md](PRIVACY.md)의 내용을 공개한다.
- Store Privacy practices에서 웹 탐색 활동 및 웹사이트 콘텐츠가 **사용자 기능 제공을 위해 로컬에서 처리되며 판매·공유되지 않음**을 정확히 신고한다.
- 배포 ZIP에서 `References/`, `.git/`, 개발용 문서, 임시 파일을 제외한다.
- `manifest.json`의 권한과 이 문서가 일치하는지 다시 확인한다.
