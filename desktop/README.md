# OpenStill Desktop Companion

OpenStill Desktop is the same-PC local data owner for OpenStill schedules and results. It uses a local SQLite database, exposes a dashboard only on `127.0.0.1`, and uses Chrome Native Messaging for the extension bridge. It does not open an internet-facing server and does not send data to a developer server.

Website-content payloads in the SQLite database and the pairing token are protected with Windows DPAPI for the current Windows user. Schedule index metadata (for example, the next run timestamp) remains in SQLite so the local scheduler can query it efficiently.

## Build a Windows `onedir` distribution

From the repository root:

```powershell
./desktop/build-onedir.ps1
```

The script uses `python -m PyInstaller` and produces two folders:

- `desktop/dist/OpenStillDesktop/OpenStillDesktop.exe` — the local dashboard program.
- `desktop/dist/OpenStillNativeHost/OpenStillNativeHost.exe` — the protocol-only executable Chrome starts for Native Messaging.

Both are PyInstaller `onedir` distributions: keep each executable together with its `_internal` directory. Do not move the `.exe` out of its folder.

To run the dashboard, double-click `OpenStillDesktop.exe`. It opens `http://127.0.0.1:8765/` and displays the one-time pairing token. For a terminal-only token lookup:

```powershell
./desktop/dist/OpenStillDesktop/OpenStillDesktop.exe --print-pairing-token
```

Use `--no-open` if starting the dashboard from a script without opening a browser window.

## Connect Chrome

1. Build the `onedir` folders.
2. Find the OpenStill extension ID in `chrome://extensions`. For the Web Store release, use its permanent published ID; for local development, use the unpacked extension's displayed ID.
3. Register the native host for the current Windows user:

   ```powershell
   ./desktop/register-native-host.ps1 -ExtensionId YOUR_32_CHARACTER_EXTENSION_ID
   ```

   This creates a host manifest beside `OpenStillNativeHost.exe` and writes only the current-user registry key `HKCU\Software\Google\Chrome\NativeMessagingHosts\com.openstill.desktop`. The manifest allows exactly that one Chrome extension ID.
4. Restart Chrome.
5. Open OpenStill's browser management page, select **Desktop**, and paste the token displayed by `OpenStillDesktop.exe`.

After connection, the Desktop database is authoritative. Existing Desktop schedules are restored into the browser cache; if Desktop is empty, the browser's existing cache is copied into Desktop. The extension polls Desktop's due-job queue because a native application cannot initiate calls into Chrome. When Chrome or the extension is closed, Desktop coalesces overdue work to one pending job per monitor instead of creating a backlog.

## Local data and migration

By default data is stored at `%LOCALAPPDATA%\OpenStill` (or `%APPDATA%\OpenStill` when LocalAppData is unavailable):

- `openstill-desktop.sqlite3` — schedules, monitor definitions, and results.
- `desktop-config.json` — a local pairing token.

Use **백업 내보내기** from the Desktop page rather than copying a live SQLite database with an active WAL file. Import that JSON into a new Desktop install using **선택 초안 또는 백업 붙여넣기**. Browser site grants are deliberately not transferred; Chrome requires them to be granted again on a new profile or computer.

The exported JSON is intentionally portable between computers and is therefore not DPAPI-bound. Treat it like any other local backup containing your saved URLs, selectors, and results.

The extension's picker copies an `openstill-selector-draft` v1 JSON document when a user saves selected CSS elements. Paste that draft into Desktop to create a tracker later; Desktop does not need to have been running when the selection was made.

## Bridge protocol

The Native Messaging envelope is fixed and schema-validated:

```json
{
  "protocol": "openstill.desktop/v1",
  "id": "request-id",
  "token": "same-PC pairing token",
  "type": "hello | get-state | replace-state | upsert-monitor | delete-monitor | due-jobs | check-result | export | import",
  "payload": {}
}
```

Responses use `{ "protocol", "id", "ok", "payload" }` or a bounded `{ "error": { "code", "message" } }`. Unknown fields, unsupported commands, invalid URLs, arbitrary code, and oversized messages are rejected. The Desktop only accepts HTTP/HTTPS tracker URLs, 1–20 CSS selectors per monitor, a 1-hour to 14-day interval, and up to 1,000 monitors.

The native host itself does not open a listening network port. The visual dashboard binds only to loopback. Native Messaging additionally enforces the exact extension ID configured in its Chrome manifest; the token is a second same-PC pairing check.
