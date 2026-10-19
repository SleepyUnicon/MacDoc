# MacDoc

**Your Mac. Within reach.**

Turn a spare Android tablet or phone into a dock for your Mac. Keep it beside
your keyboard: tap to open apps, see and switch between windows, control what's
playing, set each app's volume, share the clipboard, and use it as a touchpad,
all over your local Wi-Fi with no account or cloud service. **Mac only.**

[Version history](CHANGELOG.md) · [MIT license](LICENSE)

## Run on a Mac

MacDoc's host runs on macOS with Node.js 20+:

```bash
npm install
npm run build:mac   # builds the touchpad/keyboard, sound and window helpers (needs Xcode Command Line Tools)
npm start
```

It prints the address and a 4-digit PIN. Install the Android app on your tablet or
phone, keep both on the same Wi-Fi, and connect with that PIN. You can also open
the address in any browser on the network.

On a Mac you get your apps with their real icons, volume and mute, Spotify/Music
playback, lock and sleep, CPU/memory/battery stats in the drawer, and **Clipboard**:
see what's on the Mac's clipboard, copy it to the tablet, send text back, and
reuse recent items. The history stays in memory and clears when the host stops.
macOS asks for Automation permission the first time MacDoc quits an app or
controls a music player.

**Touch & sign** works on the Mac too: one finger moves the cursor, tap to click,
two-finger tap to right-click, two-finger slide to scroll, pinch for Ctrl+scroll
zoom, and **Drag** to hold the button. The keyboard button types into the focused
Mac text field (Unicode, emoji, Enter, Tab, Backspace and arrows), and signatures
save as transparent PNGs to `~/Pictures/MacDoc/Signatures`; **Insert** puts the PNG
on the clipboard and sends Cmd+V to the app you were using. This runs through a
small Swift helper, `MacDocInput`, built by `npm run build:mac`
(source: `native/mac/MacDocInput.swift`; set `MACDOC_INPUT_HELPER` to use a copy
elsewhere). It needs the **Accessibility** permission for the app that starts the
host — Terminal if you run `npm start` there. The first time you open the
touchpad macOS offers to open System Settings; the touchpad status names the app
to allow under Privacy & Security › Accessibility. Turn it on, then reopen the
touchpad. Ctrl+scroll zooms in browsers, and the whole screen if macOS zoom is on.

**Sound** (swipe in from the right edge) lists every app playing sound on the Mac,
each with its own volume slider and mute, under the Mac's own output volume.
Spotify, Music, QuickTime and VLC are turned up or down through their own
volume. Every other app — Safari, Chrome, Zoom, games — goes through a gain
engine in the `MacDocAudio` helper (source: `native/mac/MacDocAudio.swift`; set
`MACDOC_AUDIO_HELPER` to use a copy elsewhere). It needs macOS 14.2 or later and
uses Core Audio process taps: while an app is below 100% or muted, its sound is
taken off the speakers and played back at the level you chose, ramped so changes
don't click. It follows the Mac's current output device and new audio
processes of the app; at 100%, or when the app quits, the tap is released and the
app plays directly again. Nothing is recorded or saved.

The first time you move a non-player app's slider, macOS asks to let
**MacDocAudio** record system audio — choose **Allow**. If you said no, the Sound
column says so: turn MacDocAudio on in System Settings › Privacy & Security ›
Screen & System Audio Recording (under **System Audio Recording Only**) and move
the slider again. The helper asks for itself rather than for Terminal, so it
works however the host is started; rebuilding it with `npm run build:mac` makes
macOS ask once more.

**Set it up from your Mac.** Open `http://localhost:8620/setup` on the Mac to
arrange the dock on a big screen: drag tiles to reorder, rename them, give any
tile your own icon (PNG, JPEG or WebP), choose the tablet's grid, background and
glass, pick what each edge swipe opens, and see the PIN and paired devices.
Changes reach the tablet straight away. The PIN and device controls only work on
the Mac itself; custom icons are kept in `~/.config/macdoc/icons`.

**Keep the same PIN.** By default MacDoc makes a new PIN each time it starts.
To use your own, run `npm run set-pin -- 1234` (any four digits) and restart
MacDoc. The PIN is saved in `~/.config/macdoc/host.json` on your Mac, never in
the repository; `MACDOC_PIN=1234 npm start` works too. Paired devices are
remembered in `~/.config/macdoc/sessions.json` (hashed), so they stay connected
across restarts until you change the PIN. `npm run set-pin -- --random` goes
back to a new PIN each start.

Tablets get larger grids: from 4 up to 32 icons per page in **Appearance** or the setup page.

**Update the tablet over Wi-Fi.** Run `npm run android:update` on the Mac (add
`--notes "What's new"` if you like). It builds the Android app with the next
build number and publishes it to `~/.config/macdoc/updates`. MacDoc on the
tablet checks when it opens and every 30 minutes, and shows an update pop-up
that has to be tapped; the APK downloads over the paired connection and is
checked against its SHA-256 before installing. Android asks once to allow
MacDoc to install apps. To install MacDoc on a new tablet without a cable,
pair in its browser at the Mac's address, then open `/install`.

## What you can do

- **Your Mac's apps, with their real icons.** Tap to open an app or bring it
  forward. Pick apps on the welcome screen, the drawer's **Apps**, or the setup
  page. Rename any tile or give it your own icon.
- **Room for all of them.** 4 to 32 icons per page, swipe between pages, hold to
  rearrange, and reorder whole pages from the small gear.
- **Open windows.** Swipe down for a card for every window on the Mac, with a
  live preview; tap one to bring that window to the front.
- **Whatever's playing.** Swipe in from the left for a player that follows any
  app: artwork, progress, play, pause and skip.
- **Clipboard and sound.** Swipe in from the right for the shared clipboard and
  each app's volume and mute.
- **The control bar.** Show Desktop, the Mac's volume, Lock, and Sleep /
  Restart / Shut down (without the "reopen windows" prompt).
- **Touchpad, keyboard and signatures** for your Mac, from the drawer.
- **Always ready.** The screen stays on while MacDoc is open, your tablet stays
  paired with your own PIN, and app updates arrive over Wi-Fi.

## How it works

MacDoc on your Mac (`npm start`) serves the dock on your local
network and does the work on the Mac through three small Swift helpers:
`MacDocInput` (touchpad and keyboard), `MacDocAudio` (per-app volume) and
`MacDocWindows` (window cards, Show Desktop, lock). The Android app finds the Mac
on your Wi-Fi, shows the dock full screen in landscape, and pairs once with your
PIN. Any browser on the same network can open the dock too.

Everything stays on your Mac and your network; MacDoc is made for a trusted home
or office network, not internet remote access.

## Develop locally

The host needs **Node.js 20.11+** and the **Xcode Command Line Tools** (for the
Swift helpers). Android builds need **JDK 17 or 21** and the **Android SDK
(Platform 34)**.

```bash
npm ci
npm test
npm run build:mac
npm start
```

| Command | Purpose |
| --- | --- |
| `npm start` | Run the host in a terminal |
| `npm test` | Run the verification scripts |
| `npm run build:mac` | Build the Swift helpers: `MacDocInput`, `MacDocAudio`, `MacDocWindows` |
| `npm run set-pin -- 1234` | Keep the same PIN across restarts |
| `npm run android:update` | Build the Android app and publish it for Wi-Fi updates |

More detail: [developer reference](docs/DEVELOPMENT.md) ·
[Android build and testing](android/README.md).

## Contributing

[Open an issue](https://github.com/SleepyUnicon/MacDoc/issues) with your macOS
version, tablet or phone model, steps to reproduce, and what you expected. Keep
the platform-provider boundary intact and run `npm test`. Never include pairing
PINs, session cookies, or your personal dock configuration in a report or commit.

## License

MacDoc's source code is available under the [MIT license](LICENSE).
Copyright © 2026 [Ali Saad](https://github.com/aliihsaad).
MacDoc is a fork of [WinDock](https://github.com/aliihsaad/WinDock) by Ali Saad.
Third-party dependencies and app icons retain their own licenses and trademarks.
