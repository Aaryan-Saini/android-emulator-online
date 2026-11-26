# Handset

Upload an Android app (`.apk`, `.apks` or `.xapk`) and use it in the browser on a real Android phone. Tap, swipe, scroll, type, rotate. Every visitor gets their own fresh phone, and it is destroyed when they leave.

Share the link `/app/<id>` and anyone who opens it gets a new phone with that app installed.

## Run it on your computer

Each person runs their own copy: clone it, set it up once, and it runs on your machine with your own phones, apps and test accounts. Nothing is shared between copies. Uploaded apps, saved accounts and phone data live in `data/`, which stays on your computer and is never committed.

### What you need

- **Hardware virtualization** switched on. The phones are Android emulators, and without it they are unusably slow.
  - Windows: turn on virtualization in the BIOS, then *Windows Features* → **Windows Hypervisor Platform**, and restart.
  - Linux: KVM (`/dev/kvm` must be usable by your user).
  - macOS: nothing to do.
- **Memory:** each phone uses about 5 GB of RAM while in use, so 16 GB or more is recommended. On 8 GB, run one phone at a time (`MAX_DEVICES=1 WARM_DEVICES=0`, see [Settings](#settings)).
- **Disk:** about 15 GB free for the Android SDK, the system image and the snapshot.
- **Node.js 18 or newer.**
- **Android SDK** with platform-tools, the emulator, build-tools (for `aapt2`) and one API 30+ *Google APIs* system image. The easiest way is to install [Android Studio](https://developer.android.com/studio) and add these in *Settings → Android SDK*. With the command-line tools instead:

  ```bash
  sdkmanager "platform-tools" "emulator" "build-tools;35.0.0" "system-images;android-35;google_apis;x86_64"
  ```

  On an Apple silicon Mac use `system-images;android-35;google_apis;arm64-v8a`. Handset finds the SDK in its usual places (`%LOCALAPPDATA%\Android\Sdk`, `~/Library/Android/sdk`, `~/Android/Sdk`); otherwise set `ANDROID_HOME` to it.

### Start

```bash
git clone https://github.com/Aaryan-Saini/handset.git
cd handset
npm install
npm run setup     # once: creates the "handset-base" emulator profile and a clean snapshot (5–10 minutes)
npm start         # http://localhost:3000
```

Open [localhost:3000](http://localhost:3000), upload an `.apk`, and the app opens on a phone in the browser. Test accounts for one-click role switching are added from the panel beside the phone. On the computer Handset runs on you can always manage them (see [Test accounts](#test-accounts-switch-roles-in-one-click)).

`npm start` runs the server under a small watcher that restarts it if it ever stops. Phones keep running while the server restarts, so open sessions carry on. To shut everything down, stop the server (<kbd>Ctrl</kbd>+<kbd>C</kbd>) and run `npm run stop-phones`. Setup does not touch your other emulator profiles.

`npm run setup -- --force` rebuilds the snapshot from scratch (stop the server first). Setup tries to draw the phone screen with your graphics card. If that crashes or isn't available it falls back to software rendering at 720×1600, which keeps apps' layout identical (411×914 dp) but halves the CPU work. Force a mode with `--gpu=host`, `--gpu=swiftshader` or `--gpu=swangle` (ANGLE on SwiftShader's Vulkan engine; setup checks the phone really uses it, and refuses if the emulator falls back, as emulator 36.5 on Windows does). `--avd=<name>` builds into a separate emulator profile, so the graphics mode can be changed while phones are running; the server switches to it on its next restart and replaces the waiting spare. The choice is saved in `data/emulator.json`.

## How it works

```text
browser ──HTTP upload──▶ server ──aapt2──▶ app name, package, icon (data/apps/<id>/)
browser ──WebSocket────▶ server ──adb────▶ emulator (read-only, booted from snapshot)
   ▲  H.264 frames            │              │
   │  ◀────────────────────── scrcpy-server ◀┘   (video out, touch/keys/clipboard in)
   └─ WebCodecs decoder → <canvas>; pointer events → multi-touch
```

- **Phones** (`server/pool.js`): emulators boot with `-read-only -snapshot handset_clean`, so each one starts in 10–15 s from the same clean state and nothing is saved. One spare phone is kept ready but frozen (~0% CPU, its memory handed back to the system), so a new session gets a phone in about 2.5 s. A phone whose tab is hidden or closed is frozen the same way and wakes when the visitor returns. After a session the phone is destroyed. If a phone crashes, its session moves to a fresh phone with the same app.
- **Sessions** (`server/sessions.js`): queue → install (`adb install`, or `install-multiple` for bundles) → launch → stream. There is no time limit by default: a session lasts while the tab is open, and ends when the visitor clicks *End session* or `IDLE_SECONDS` after the tab closes. A page refresh reconnects to the same phone.
- **Streaming** (`server/scrcpy.js`): runs the bundled scrcpy-server 5.0.1 on the phone and forwards its H.264 stream over the WebSocket. Each browser asks for exactly the resolution it displays (and asks again on full screen), because the phone's video encoder shares the CPU with the app. If a visitor's connection falls behind, frames are dropped up to the next keyframe so lag never builds up.
- **CPU priority**: the phone someone is using runs at above-normal priority, and spare phones waiting for the next visitor run below normal.
- **Input** (`public/assets/player.js`): real touch events with up to 9 fingers, so Android's own gestures work: swipe up for home, swipe in from the edge for back, flings, long-press. On a phone or tablet the stream fills the screen and multi-touch works natively.

### Controls on a computer

| Action | How |
| --- | --- |
| Tap / swipe / fling | Click, or click and drag |
| Pinch / zoom | Hold <kbd>Ctrl</kbd> and drag |
| Back | Right-click, <kbd>Esc</kbd>, or swipe in from the left edge |
| Home | Middle-click, the circle button, or swipe up from the bottom edge |
| Type | Just type; <kbd>Ctrl</kbd>+<kbd>V</kbd> pastes your clipboard into the phone |
| Copy out | Text copied on the phone lands on your clipboard |
| Scroll | Mouse wheel or trackpad |

The frame's side buttons are clickable (power, volume up/down). The toolbar also has rotate, screenshot (full resolution PNG), restart app, clear app data and full screen.

## Test accounts (switch roles in one click)

Save a login for each role of an app (for example *Admin* and *Front desk*) with **+ Add account** in the panel beside the phone. Drag accounts up or down to reorder them (or <kbd>Alt</kbd>+<kbd>↑</kbd> / <kbd>↓</kbd>). **Export** / **Import** move them between apps or computers as a file (it contains the passwords). Anyone who opens the app's link then gets the **Sign in as** list and can switch roles in one click. They never see the passwords. Accounts can be added or changed from any browser on the computer Handset runs on (`http://localhost`), or from the browser that uploaded the app; visitors from other machines cannot. They are stored in `data/apps/<id>/meta.json`.

What happens on **Sign in as** (`server/autologin.js`):

1. The app is signed out by clearing its data, its permissions are granted up front, and it is reopened.
2. Handset reads the screen with uiautomator and taps through intro and consent screens (*Continue*, *Next*, *Get started*, *I understand*…) and any permission prompts.
3. The saved fields are typed **in order**. Plain values go into normal text fields and hidden values only into password fields. For a multi-step login, list the fields in the order the app asks for them, for example *Organisation code → Email → Password*. If a screen offers *Login with Password* next to a code/OTP login and the account has a password, Handset switches to the password login.
4. Handset presses the app's own button (*Sign in*, *Log in*, *Continue*…), then checks the sign-in screen is gone. If the app shows an error ("invalid password"…), that message is shown to the visitor.

Each account row also has **Type** links: tap a field on the phone, then click *Email* or *Password* to type that saved value into it, for apps the automation cannot follow. One-time codes (OTP, 2FA) cannot be automated; Handset stops and says so.

## Settings

All optional, as environment variables:

| Variable | Default | Meaning |
| --- | --- | --- |
| `PORT` | `3000` | HTTP port |
| `MAX_DEVICES` | `2` | Phones that may run at once. Each uses about 5 GB of RAM. |
| `WARM_DEVICES` | `1` | Spare phones kept booted for the next visitor. With `FREEZE_SPARE` (default `true`) the spare is frozen while it waits (~0% CPU, ~0 MB RAM in use) and wakes in a few seconds |
| `PHONE_WIFI` | `false` | Phones go online over mobile data. The emulator's Wi-Fi drops ~10 s after a frozen phone wakes (apps say "You're offline"); `true` keeps Wi-Fi on anyway |
| `SESSION_MINUTES` | `0` | Maximum session length; `0` means no limit |
| `IDLE_SECONDS` | `120` | Shut a phone down this long after its tab closes |
| `MAX_SESSIONS_PER_IP` | `2` | Concurrent phones per visitor |
| `MAX_UPLOAD_MB` | `1024` | Upload size limit |
| `VIDEO_MAX_SIZE` / `VIDEO_MIN_SIZE` | `1024` / `640` | Bounds for the per-viewer stream size (long edge, px). While scrolling on a 6-core i5: 720 → 43 fps, 1024 → 37 fps, 1600 → 21 fps |
| `VIDEO_BITRATE` | `8000000` | Video bitrate |
| `GRANT_PERMISSIONS` | `false` | `true` grants every runtime permission at install (skips permission prompts) |
| `FAST_FILL` | `true` | Fill sign-in fields instantly through the accessibility helper in `vendor/appium-uia2` (falls back to typing) |
| `LOCAL_ADMIN` | `true` | Anyone using Handset on the computer it runs on (`http://localhost`) can add and change every app's accounts, from any browser. Visitors from other machines or through a tunnel still need the uploader's browser |
| `KEEP_PHONES_ON_RESTART` | `true` | Phones and sessions keep running while the server restarts; visitors reconnect automatically. `npm run stop-phones` stops them |
| `TRUST_PROXY` | unset | Set when behind a reverse proxy so per-visitor limits use `X-Forwarded-For` |
| `ANDROID_HOME` | auto | Android SDK location |

## When a phone crashes

The session moves to a fresh phone with the same app (a few seconds), and the crash is written to `data/logs/crashes.log` with Windows' crash record. Crashes seen so far happen inside the code SwiftShader (the software renderer) generates while apps draw; with software rendering, emulator 36.5 always uses that renderer for OpenGL ES. To also see *where* in the emulator it crashed, let Windows keep a small crash dump: run this once from a PowerShell window opened as administrator:

```powershell
powershell -ExecutionPolicy Bypass -File scripts\enable-crash-dumps.ps1   # add -Off to undo
```

Each crash then adds the library it happened in and the libraries on the crashing thread's stack to `crashes.log`. `node server/crashinfo.js` explains the newest dump in `data/crash-dumps` again.

## Letting other people use it

Browsers only decode video on HTTPS pages (or on `localhost`), so people on other machines need an `https://` address. The quickest way:

```bash
cloudflared tunnel --url http://localhost:3000
```

For a permanent setup, put it behind any TLS reverse proxy (Caddy, nginx) with WebSocket support and set `TRUST_PROXY=1`. For more than a couple of phones at once, run it on a Linux server with KVM. That is also where Android emulators run fastest.

Anyone with access can upload an app and get a phone with internet access. If the address is public, add a login in front of it.

## Limits

- Android only. iOS apps cannot run outside Apple's simulator on a Mac.
- No sound yet. scrcpy can capture audio (Opus) and the browser can decode it; that is the next thing to add.
- `.aab` files must be turned into an APK or a universal `.apks` first (bundletool). OBB expansion files inside `.xapk` are ignored.
- The phones are emulators (Google APIs image, no Play Store). Apps that refuse to run on emulators or need the Play Store will behave as they would on any emulator. Apps with only ARM code run through the emulator's ARM translation.
- No camera on the phone.

## Files

```text
server/index.js     HTTP routes, static files, WebSocket upgrade
server/pool.js      emulator pool (boot, hand out, freeze/wake, destroy)
server/crashinfo.js explains phone crashes (Windows crash record, crash dump reader)
server/sessions.js  session lifecycle, install/launch, browser ↔ phone bridge
server/scrcpy.js    scrcpy-server launcher, stream parser, control messages
server/apk.js       aapt2 parsing, adaptive icon extraction, bundle unpacking
server/zip.js       small ZIP reader
server/store.js     uploaded apps (data/apps/<id>/)
public/             home page, player page, styles, scripts
scripts/setup.js    creates the emulator profile and clean snapshot
vendor/             scrcpy-server 5.0.1 (Apache 2.0, see scrcpy-LICENSE.txt)
```
