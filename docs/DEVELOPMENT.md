# Developer reference

## Architecture

The Android app is a Kotlin WebView host: it discovers the Mac by UDP broadcast
(each network's own broadcast address, then 255.255.255.255), remembers the
endpoint, and loads the web interface the Mac serves. The web interface handles
pairing; the Android wrapper never sees the PIN or the session cookie.

The Node host owns the dock and publishes updates over WebSocket. Platform
providers implement one contract (`src/platform/contract.js`). The macOS
provider does the work through `osascript`, `open`, `pbpaste` and three Swift
helpers; a Linux provider exists for development and the test suite.

| Path | Responsibility |
| --- | --- |
| `server.js` | HTTP API, static serving, provider wiring |
| `src/platform/macos.js` | macOS provider: apps and icons, running apps, controls, now playing, clipboard, sound, windows |
| `src/platform/mac-media.js` | Driving browser tabs (Brave, Chrome, Edge, Arc, Vivaldi, Opera, Safari) and their web apps |
| `src/platform/mac-mixer.js` | Per-app volume through the `MacDocAudio` helper |
| `src/platform/input.js` | Persistent JSON-lines bridge to the `MacDocInput` helper |
| `src/platform/linux.js` | Linux provider for development and tests |
| `src/auth.js`, `src/host-settings.js` | PIN pairing, sessions, lockout, fixed PIN |
| `src/config.js` | Dock tiles and shared settings, written atomically |
| `src/clipboard.js` | Clipboard history (memory only) |
| `src/custom-icons.js` | Uploaded tile icons, stored by SHA-256 |
| `src/app-updates.js` | Android app updates over Wi-Fi |
| `src/discovery.js`, `src/sync.js` | UDP responder, WebSocket updates |
| `public/` | Dock UI, setup page (`setup.html`), install page (`install.html`) |
| `native/mac/` | Swift helpers `MacDocInput`, `MacDocAudio`, `MacDocWindows` |
| `android/` | Discovery, validated endpoints, landscape WebView, updater |
| `scripts/verify-*.mjs` | Verification scripts run by `npm test` |

## Boundaries

- Native commands use `execFile` with argument arrays and `shell: false`.
  AppleScript and JXA sources are fixed strings; caller values travel as
  separate `osascript` arguments read through `on run argv`. Control verbs are
  allowlisted.
- Quitting an app asks it politely, so it can offer to save.
- The service worker never caches `/api/` requests or replays actions. It needs
  a secure origin; ordinary LAN HTTP can serve the online interface only.
- Android permits LAN HTTP, validates private/loopback IPv4 endpoints, and
  restricts navigation and intercepted requests to the selected origin. Its
  JavaScript bridge (keyboard, clipboard) only answers that page.

## Pairing and network access

`POST /api/auth` exchanges a PIN for a session. Other `/api/*` routes require
that session or trusted loopback access. `/health` and the web pages are public.
PIN comparison is constant-time; five failed attempts lock a client out for
60 seconds. Cookies use `HttpOnly`, `SameSite=Lax`, and `Secure` over HTTPS,
for up to 180 days. Sessions are saved hashed in `~/.config/macdoc/sessions.json`
and end when the PIN changes.

State-changing requests and WebSocket upgrades check the request origin.
Loopback is trusted by default; the PIN and paired-device routes
(`/api/pairing`, `/api/pin`, `/api/devices`) answer only a page loaded from
`localhost` on the Mac. Discovery never includes the PIN. The four-digit PIN
and LAN HTTP design are for a trusted local network; don't expose the host port
to the internet.

## Configuration

| Path or variable | Purpose |
| --- | --- |
| `~/.config/macdoc/config.json` | Dock tiles and shared settings (`MACDOC_CONFIG` overrides) |
| `~/.config/macdoc/host.json` | Fixed PIN (`npm run set-pin`); `MACDOC_PIN` overrides |
| `~/.config/macdoc/sessions.json` | Paired devices (hashed tokens) |
| `~/.config/macdoc/icons/` | Custom tile icons |
| `~/.config/macdoc/updates/` | Published Android builds (`npm run android:update`) |
| `MACDOC_INPUT_HELPER`, `MACDOC_AUDIO_HELPER`, `MACDOC_WINDOWS_HELPER` | Use helper binaries from another location |
| `MACDOC_HOST`, `PORT` | Bind address and port (default 8620) |

## Permissions

macOS grants permissions to the app that starts the host: Terminal when you
run `npm start`. Accessibility covers the touchpad, keyboard,
window focus and Lock; Screen Recording covers window previews; System Audio
Recording covers per-app volume; Automation is asked per app MacDoc scripts
(music players, browsers, System Events). Browsers also need **Allow JavaScript
from Apple Events** (per profile in Chromium browsers) before MacDoc can control
their tabs.
