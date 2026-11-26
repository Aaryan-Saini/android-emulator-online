// All settings live here. Every value can be overridden with an environment variable.
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const exe = (name) => (process.platform === 'win32' ? `${name}.exe` : name);
const env = (key, fallback) => (process.env[key] === undefined || process.env[key] === '' ? fallback : process.env[key]);
const num = (key, fallback) => Number(env(key, fallback));
const bool = (key, fallback) => /^(1|true|yes|on)$/i.test(String(env(key, fallback)));

function findSdk() {
  const candidates = [
    process.env.ANDROID_HOME,
    process.env.ANDROID_SDK_ROOT,
    process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, 'Android', 'Sdk'),
    path.join(os.homedir(), 'Library', 'Android', 'sdk'),
    path.join(os.homedir(), 'Android', 'Sdk'),
  ].filter(Boolean);
  return candidates.find((p) => fs.existsSync(path.join(p, 'platform-tools', exe('adb')))) || null;
}

function findAapt2(sdk) {
  const dir = path.join(sdk, 'build-tools');
  if (!fs.existsSync(dir)) return null;
  const versions = fs
    .readdirSync(dir)
    .filter((v) => fs.existsSync(path.join(dir, v, exe('aapt2'))))
    .sort((a, b) => b.localeCompare(a, undefined, { numeric: true }));
  return versions.length ? path.join(dir, versions[0], exe('aapt2')) : null;
}

const SDK = env('ANDROID_SDK', findSdk());
if (!SDK) {
  console.error('Android SDK not found. Set ANDROID_HOME to your SDK folder.');
  process.exit(1);
}

const DATA = path.resolve(env('HANDSET_DATA', path.join(ROOT, 'data')));

// How phones draw their screen. `npm run setup` picks the fastest mode that works on this machine and
// saves it here, because a snapshot only loads with the same graphics mode it was saved with.
const EMULATOR_FILE = path.join(DATA, 'emulator.json');
let emulatorMode = { gpu: 'swiftshader_indirect', window: 'none', features: '' };
try {
  emulatorMode = { ...emulatorMode, ...JSON.parse(fs.readFileSync(EMULATOR_FILE, 'utf8')) };
} catch {}
if (process.env.EMULATOR_GPU) emulatorMode.gpu = process.env.EMULATOR_GPU;

function emulatorDisplayArgs(mode = emulatorMode) {
  return [
    ...(mode.window === 'hidden' ? ['-qt-hide-window'] : ['-no-window']),
    '-gpu', mode.gpu,
    ...(mode.features ? ['-feature', mode.features] : []),
  ];
}

module.exports = {
  ROOT,
  DATA,
  APPS_DIR: path.join(DATA, 'apps'),
  PUBLIC_DIR: path.join(ROOT, 'public'),

  PORT: num('PORT', 3000),
  HOST: env('HOST', '0.0.0.0'),

  SDK,
  ADB: path.join(SDK, 'platform-tools', exe('adb')),
  EMULATOR: path.join(SDK, 'emulator', exe('emulator')),
  AAPT2: env('AAPT2', findAapt2(SDK)),

  SCRCPY_SERVER: env('SCRCPY_SERVER', path.join(ROOT, 'vendor', 'scrcpy-server-v5.0.1')),
  SCRCPY_VERSION: env('SCRCPY_VERSION', '5.0.1'),

  // The emulator profile and clean snapshot every session starts from (created by `npm run setup`).
  AVD: env('HANDSET_AVD', emulatorMode.avd || 'handset-base'),
  SNAPSHOT: env('HANDSET_SNAPSHOT', 'handset_clean'),
  EMULATOR_FILE,
  emulatorMode,
  emulatorDisplayArgs,

  // How many phones may run at once, and how many to keep booted and waiting for the next visitor.
  MAX_DEVICES: num('MAX_DEVICES', 2),
  // Spare phones kept ready for the next visitor. With FREEZE_SPARE they are paused and their memory handed back
  // to Windows while they wait (measured: ~0% CPU, ~0 MB RAM in use), and wake in ~1.5 s when someone arrives.
  WARM_DEVICES: num('WARM_DEVICES', 1),
  FREEZE_SPARE: bool('FREEZE_SPARE', true),
  // Pause a phone (0% CPU) when its tab is hidden this long, or as soon as its tab is closed. It wakes on return.
  PAUSE_HIDDEN_SECONDS: num('PAUSE_HIDDEN_SECONDS', 30),
  // Switch off apps visitors' apps don't need (YouTube, Gmail, Maps…) on every phone to cut background load.
  STRIP_EXTRAS: bool('STRIP_EXTRAS', true),
  // With 2+ phones busy, give each its own share of CPU cores so they don't interrupt each other.
  PIN_CORES: bool('PIN_CORES', true),
  // Phones go online over mobile data instead of the emulator's Wi-Fi. Measured: the emulator's Wi-Fi drops ~10 s
  // after a frozen phone wakes (apps say "You're offline" for ~5 s) and does not come back; mobile data stays up.
  PHONE_WIFI: bool('PHONE_WIFI', false),
  BASE_PORT: num('EMULATOR_BASE_PORT', 5620),
  BOOT_TIMEOUT_MS: num('BOOT_TIMEOUT_SECONDS', 150) * 1000,

  // 0 = no time limit: a session lasts as long as the tab stays open.
  SESSION_MINUTES: num('SESSION_MINUTES', 0),
  // After the tab closes (or loses connection), keep the phone this long so a refresh or a dropped
  // connection picks up the same phone. Then it is shut down to free the memory.
  IDLE_SECONDS: num('IDLE_SECONDS', 120),
  MAX_SESSIONS_PER_IP: num('MAX_SESSIONS_PER_IP', 2),
  MAX_UPLOAD_MB: num('MAX_UPLOAD_MB', 1024),

  // Video stream. Each browser asks for the size it actually displays; these are the bounds (long edge, px).
  // Measured on a 6-core i5 with software rendering, while scrolling: 720 -> 43 fps, 1024 -> 37 fps, 1600 -> 21 fps.
  MAX_SIZE: num('VIDEO_MAX_SIZE', 1024),
  MIN_SIZE: num('VIDEO_MIN_SIZE', 640),
  VIDEO_BITRATE: num('VIDEO_BITRATE', 8000000),
  MAX_FPS: num('VIDEO_MAX_FPS', 60),

  // Grant every runtime permission at install. Off by default so permission prompts appear like on a real phone.
  GRANT_PERMISSIONS: bool('GRANT_PERMISSIONS', false),

  // Fill sign-in fields through the accessibility helper in vendor/appium-uia2 (instant), instead of typing.
  FAST_FILL: bool('FAST_FILL', true),

  // Anyone using Handset on this PC (http://localhost) can manage every app's accounts, from any browser. Visitors
  // from other machines or through a tunnel still need the uploader's browser.
  LOCAL_ADMIN: bool('LOCAL_ADMIN', true),

  // Keep phones and sessions running across server restarts (people reconnect instead of losing their session).
  KEEP_PHONES_ON_RESTART: bool('KEEP_PHONES_ON_RESTART', true),
};
