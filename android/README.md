# MacDoc Android app

The Android app shows your Mac's dock full screen in landscape on a tablet or
phone. Keep MacDoc running on the Mac (`npm start`); the app
connects to it over your Wi-Fi.

## Build and install

You need JDK 17 or 21 and the Android SDK (Platform 34). On a Mac with Homebrew's
`openjdk@17` and the SDK in `~/Library/Android/sdk`:

```bash
cd android
echo "sdk.dir=$HOME/Library/Android/sdk" > local.properties
JAVA_HOME=/opt/homebrew/opt/openjdk@17/libexec/openjdk.jdk/Contents/Home ./gradlew assembleDebug testDebugUnitTest
```

Output: `app/build/outputs/apk/debug/app-debug.apk`. It supports Android 7 (API 24)
and newer, targets API 34, and is signed with this Mac's debug key. Updates must
be signed with the same key.

**After the first install, update over Wi-Fi.** `npm run android:update` (from the
repository root) builds the app with the next build number and publishes it to
`~/.config/macdoc/updates`. The app checks when it opens and every 30 minutes and
shows an update pop-up that has to be tapped. Android asks once to allow MacDoc
to install apps.

**First install.** Either pair the tablet's browser at the Mac's address, then open
`/install` and download the app; or connect a USB cable with USB debugging on and
run `adb install -r` with the APK. Avoid `adb shell am force-stop` on the tablet:
on some Android 15 builds it blocks the WebView renderer until the next reboot.

Open MacDoc on the same Wi-Fi as the Mac and enter the PIN. If discovery misses
the Mac, type the address MacDoc shows and tap Connect; a bare IP uses port 8620.
MacDoc keeps the middle of each side edge for its own swipes, so Android's Back
gesture works above and below that band.

## Verification

`./gradlew testDebugUnitTest` runs the Kotlin unit tests.
`npm test` includes the cross-language protocol check. The Kotlin tests execute
the real URL/discovery parser and same-origin request policy.

For the emulator flow, start `node scripts/android-smoke-host.mjs` in another
terminal. It listens only on loopback port 18622 and provides five fake apps,
test PIN 8642, and an action log in `artifacts/android-smoke/events.json`.
It never calls the Mac provider or reads the user's saved dock.

With an Android emulator running, use the SDK's adb (specify `-s SERIAL` if
more than one device is attached):

```bash
cd android
./gradlew assembleDebug assembleDebugAndroidTest
adb install -r app/build/outputs/apk/debug/app-debug.apk
adb install -r app/build/outputs/apk/androidTest/debug/app-debug-androidTest.apk
adb shell am instrument -w -e class com.macdoc.app.DockSmokeTest com.macdoc.app.test/androidx.test.runner.AndroidJUnitRunner
```

Expected: `OK (1 test)`. The test targets the emulator's host alias
`http://10.0.2.2:18622`; do not run this fixture test against a physical phone.
It verifies pairing errors/success, WebSocket sync, icon-only landscape layout,
two pages, real injected touch swipes, long press, dialog Back handling,
launch/focus requests, failed manual address recovery and Activity recreation.
Screenshots are in the app's external files directory. The first-run Android
fullscreen explanation is dismissed using UI Automator on the English emulator.

The emulator flow does not exercise real Wi-Fi discovery or a real Mac; those are
checked on a physical tablet against the Mac host.

### Automatic now-playing regression

Start `node scripts/now-playing-smoke-host.mjs` from the repository root. It runs
an isolated host on loopback port 18623 and a test-only media control endpoint
on 18624. Keep other clients disconnected from this fixture during the Android
test so its background polling count is isolated. After building/installing the
debug and instrumentation APKs as above, run:

```bash
adb shell am instrument -w -e class com.macdoc.app.NowPlayingSmokeTest com.macdoc.app.test/androidx.test.runner.AndroidJUnitRunner
```

Expected: `OK (1 test)`. The test changes the host's simulated track, artist,
playback state and active media session, checks the actual Android WebView updates
without tapping Refresh, and checks polling pauses in the background and resumes
on return. It uses the emulator host alias `10.0.2.2`; do not run on a physical phone.

The same fixture supports a browser regression. Open `http://127.0.0.1:18623` in
Playwright CLI, then run `run-code --filename=scripts/browser/now-playing.js`
from the repository root. It also checks HTTP error recovery, slow requests,
playback controls, focus preservation and zero Refresh clicks/page reloads.
Create `output/playwright/` first for the screenshot. `npm test` includes the
poller's automatic-update, inactive-state, timeout and concurrency regression.

## Transport and build decisions

Android's network security XML matches domains, not private IP subnets. The
transport allows HTTP, while `EndpointPolicy` limits selected hosts to private
or loopback IPv4 addresses (plus localhost). Health checks reject redirects,
limit response size/time and require MacDoc's identity. The WebView permits
only the selected origin, disables file/content access, and never overrides
TLS certificate errors. PIN/session handling stays in the shared web UI.
This is LAN HTTP, not encrypted transport. Android HTTP does not enable the
PWA's secure-origin-only service worker/offline support.

Reference documentation: [Android network security](https://developer.android.com/privacy-and-security/security-config),
[immersive system bars](https://developer.android.com/develop/ui/views/layout/immersive),
[AGP 8.5 compatibility](https://developer.android.com/build/releases/agp-8-5-0-release-notes),
and [Gradle wrapper checksums](https://docs.gradle.org/current/userguide/gradle_wrapper.html).
