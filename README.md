# Handset

Upload an Android app (`.apk`, `.apks` or `.xapk`) and use it in the browser on a real Android phone. Tap, swipe, scroll, type, rotate. Every visitor gets their own fresh phone, and it is destroyed when they leave.

Share the link `/app/<id>` and anyone who opens it gets a new phone with that app installed.

## Run it

Requirements: Node 18+, the Android SDK with the emulator, an API 30+ "Google APIs" x86_64 system image, build-tools (for `aapt2`), and hardware virtualization (WHPX on Windows, KVM on Linux, HVF on macOS).

```bash
npm install
npm run setup     # once: creates the "handset-base" emulator profile and a clean snapshot (5–10 minutes)
npm start         # http://localhost:3000
```

`npm run setup -- --force` rebuilds the snapshot from scratch (stop the server first). Setup tries to draw the phone screen with your graphics card. If that crashes or isn't available it falls back to software rendering at 720×1600, which keeps apps' layout identical (411×914 dp) but halves the CPU work. Force a mode with `--gpu=host` or `--gpu=swiftshader`. The choice is saved in `data/emulator.json`.

## How it works

```text
browser ──HTTP upload──▶ server ──aapt2──▶ app name, package, icon (data/apps/<id>/)
browser ──WebSocket────▶ server ──adb────▶ emulator (read-only, booted from snapshot)
   ▲  H.264 frames            │              │
   │  ◀────────────────────── scrcpy-server ◀┘   (video out, touch/keys/clipboard in)
   └─ WebCodecs decoder → <canvas>; pointer events → multi-touch
```

- **Phones** (`server/pool.js`): emulators boot with `-read-only -snapshot handset_clean`, so each one starts in 10–15 s from the same clean state and nothing is saved. One phone is kept booted and waiting (`WARM_DEVICES`), so new visitors usually skip the boot. After a session the phone is killed and a new one is warmed.
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

The person who uploaded an app can save logins for each role (for example *Admin* and *Front desk*) from **Add test accounts** / **Manage accounts** in the player's header. Anyone who opens the app's link then gets a **Sign in as** menu and can switch roles in one click. They never see the passwords; only the uploader can view or change them (stored in `data/apps/<id>/meta.json` on the server).

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
| `WARM_DEVICES` | `1` | Phones kept booted and waiting |
| `SESSION_MINUTES` | `0` | Maximum session length; `0` means no limit |
| `IDLE_SECONDS` | `120` | Shut a phone down this long after its tab closes |
| `MAX_SESSIONS_PER_IP` | `2` | Concurrent phones per visitor |
| `MAX_UPLOAD_MB` | `1024` | Upload size limit |
| `VIDEO_MAX_SIZE` / `VIDEO_MIN_SIZE` | `1024` / `640` | Bounds for the per-viewer stream size (long edge, px). While scrolling on a 6-core i5: 720 → 43 fps, 1024 → 37 fps, 1600 → 21 fps |
| `VIDEO_BITRATE` | `8000000` | Video bitrate |
| `GRANT_PERMISSIONS` | `false` | `true` grants every runtime permission at install (skips permission prompts) |
| `FAST_FILL` | `true` | Fill sign-in fields instantly through the accessibility helper in `vendor/appium-uia2` (falls back to typing) |
| `KEEP_PHONES_ON_RESTART` | `true` | Phones and sessions keep running while the server restarts; visitors reconnect automatically. `npm run stop-phones` stops them |
| `TRUST_PROXY` | unset | Set when behind a reverse proxy so per-visitor limits use `X-Forwarded-For` |
| `ANDROID_HOME` | auto | Android SDK location |

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
server/pool.js      emulator pool (boot, hand out, destroy)
server/sessions.js  session lifecycle, install/launch, browser ↔ phone bridge
server/scrcpy.js    scrcpy-server launcher, stream parser, control messages
server/apk.js       aapt2 parsing, adaptive icon extraction, bundle unpacking
server/zip.js       small ZIP reader
server/store.js     uploaded apps (data/apps/<id>/)
public/             home page, player page, styles, scripts
scripts/setup.js    creates the emulator profile and clean snapshot
vendor/             scrcpy-server 5.0.1 (Apache 2.0, see scrcpy-LICENSE.txt)
```
