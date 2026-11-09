# 개인정보처리방침 / Privacy Policy

## 개인정보처리방침

본 개인정보처리방침은 OpenStill 브라우저 확장 프로그램의 개인정보 처리 방식에 대해 설명합니다.

### 1. 개인정보 수집 여부

개발자는 OpenStill을 통해 사용자의 개인정보를 수집하거나 보관하지 않습니다. OpenStill은 추적 데이터, 백업 파일, Koofr 연결 정보를 개발자에게 전송하지 않습니다.

### 2. 데이터 처리 방식

OpenStill은 사용자가 저장하거나 가져온 웹페이지를 브라우저에서 열고, 사용자가 설정한 선택자에 해당하는 내용을 확인합니다. 추적 URL, 페이지 제목, 선택자, 캡처한 텍스트·HTML·링크, 변경·실행 이력, 설정과 복구 자료는 사용자의 브라우저 프로필에 저장합니다. 사용자는 JSON 파일로 데이터를 내보내거나 불러올 수 있습니다.

Koofr 연결을 등록하면 OpenStill은 사용자가 입력한 가입 이메일과 앱 비밀번호를 일반 설정과 분리해 브라우저 프로필의 확장 프로그램 저장소에 보관합니다. 두 값은 Koofr 연결을 인증하는 데 사용되며 로컬 또는 Koofr 백업 파일에 포함되지 않습니다.

### 3. 제3자 제공

Koofr는 선택 기능입니다. 연결 확인, 백업 저장, 백업 목록 조회와 복원에 필요한 요청은 HTTPS로 Koofr WebDAV에 직접 전송합니다. 연결 확인 시 작은 시험용 JSON 파일을 생성하고 읽은 뒤 삭제합니다.

사용자가 수동 백업을 실행하거나 직접 켠 자동 백업이 실행되면, 추적 정보, 캡처한 내용, 이력, 설정과 복구 원본의 사본이 사용자의 Koofr 계정에 저장됩니다. 백업 목록을 구성하는 데 사용하는 임의의 브라우저 프로필 식별자와 백업 정보도 함께 전송합니다. 복원할 때는 사용자가 선택한 백업을 해당 계정에서 읽습니다. Koofr에서 처리하는 데이터에는 Koofr의 개인정보처리방침이 적용됩니다. [Koofr 개인정보처리방침](https://koofr.eu/privacy/)

### 4. 외부 서버 및 분석 도구

OpenStill은 개발자가 운영하는 데이터 수집 서버, 광고 SDK, 사용 분석 또는 광고 추적 도구를 사용하지 않습니다. 개발자는 OpenStill 사용자의 데이터를 판매하거나 광고에 이용하지 않습니다.

### 5. 개인정보 보관 및 파기

추적을 삭제하면 되돌릴 수 있도록 사본이 브라우저의 복구함에 남을 수 있습니다. 사용자는 브라우저에서 확장 프로그램의 저장 데이터를 지워 로컬 데이터를 삭제할 수 있습니다. 내보낸 JSON 파일은 사용자가 직접 관리합니다.

Koofr 자동 백업과 자동 삭제는 기본값에서 꺼져 있습니다. 사용자가 보관할 백업 개수를 설정하면 OpenStill은 새 백업을 검증한 뒤 이 기기의 오래된 완료 백업을 정리합니다. Koofr 설정에서 연결 정보를 삭제하면 브라우저에 저장된 이메일과 앱 비밀번호가 지워지고 자동 백업이 꺼집니다. 업로드한 백업은 Koofr 계정에 남으며, 사용자가 Koofr에서 직접 삭제할 수 있습니다.

### 6. 문의

본 개인정보처리방침에 대한 문의가 있는 경우, 아래 연락처로 문의할 수 있습니다.

- 이메일: `team@soleil.channel.io`

### 7. 시행일

최초 시행일은 2026년 5월 5일입니다. 이 개정 방침은 OpenStill 1.7.0부터 적용됩니다.

---

## Privacy Policy

This Privacy Policy explains how the OpenStill browser extension handles user data.

### 1. Collection of Personal Information

The developer does not collect or retain personal information through OpenStill. OpenStill does not send tracking data, backup files, or Koofr connection credentials to the developer.

### 2. Data Processing

OpenStill opens web pages the user saves or imports and reads the content matched by the selectors the user configures. It stores tracked URLs, page titles, selectors, captured text, HTML and links, change and check history, settings, and recovery data in the user's browser profile. Users can export and import data as JSON files.

If the user connects Koofr, OpenStill stores the Koofr account email address and app password in the extension's local storage, separately from general settings. OpenStill uses these credentials to authenticate to Koofr and excludes them from both local and Koofr backup files.

### 3. Sharing with Third Parties

Koofr is optional. OpenStill sends requests for connection checks, uploads, backup listings, and restores directly to Koofr WebDAV over HTTPS. A connection check creates, reads, and then deletes a small test JSON file.

When the user starts a manual backup or an automatic backup they have enabled runs, OpenStill saves a copy of the tracking data, captured content, history, settings, and recovery originals to the user's Koofr account. It also sends a randomly generated browser profile identifier and backup information used to list available backups. During a restore, OpenStill reads the backup the user selected from that account. Koofr's privacy policy applies to data it processes. [Koofr Privacy Policy](https://koofr.eu/privacy/)

### 4. External Servers and Analytics Tools

OpenStill does not use developer-operated data collection servers, advertising SDKs, usage analytics, or ad tracking tools. The developer does not sell OpenStill user data or use it for advertising.

### 5. Data Retention and Deletion

Deleting a tracker can leave a copy in the browser's recovery area so the user can restore it. Users can delete local data by clearing the extension's stored data in their browser. Users manage their exported JSON files.

Automatic Koofr backups and automatic deletion are off by default. If the user sets a retention limit, OpenStill removes older completed backups for that device after verifying a new backup. Removing the connection in Koofr settings clears the stored email address and app password and disables automatic backups. Uploaded backups remain in the user's Koofr account, where the user can delete them.

### 6. Contact

For questions about this Privacy Policy, please contact:

- Email: `team@soleil.channel.io`

### 7. Effective Date

This Privacy Policy first took effect on May 5, 2026. This revision applies starting with OpenStill 1.7.0.
