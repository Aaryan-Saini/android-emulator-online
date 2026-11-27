// One-time setup: creates the emulator profile Handset uses and saves the clean snapshot every session boots from.
// It tries the fastest graphics mode first (the computer's GPU) and falls back to software rendering.
//   npm run setup                        create if missing
//   npm run setup -- --force             rebuild from scratch
//   npm run setup -- --force --gpu=host  force a graphics mode (host | swiftshader | swangle)
//   --avd=<name>                         build into a separate profile (switch while phones are running)
//   --screen=464x1024@180                screen size and density
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const cfg = require('../server/config');
const { adb, shell } = require('../server/adb');
const { run, sleep } = require('../server/util');

const args = process.argv.slice(2);
const force = args.includes('--force');
const gpuArg = (args.find((a) => a.startsWith('--gpu=')) || '').slice(6);
// --avd=<name>: build into another emulator profile, e.g. to switch graphics mode while phones are running from
// the current one (a snapshot must not be replaced under running phones). The server uses it after a restart.
const AVD = (args.find((a) => a.startsWith('--avd=')) || '').slice(6) || cfg.AVD;
const AVD_HOME = process.env.ANDROID_AVD_HOME || path.join(os.homedir(), '.android', 'avd');
const avdDir = path.join(AVD_HOME, `${AVD}.avd`);
const PORT = 5598;
const serial = `emulator-${PORT}`;

// Apps see the same layout in every mode (about 412 x 910 dp, a Pixel 7). With software drawing (the CPU draws
// every pixel) the screen is 464 x 1024: the video sent to browsers is at most 1024 tall (VIDEO_MAX_SIZE), so
// drawing more pixels than that only costs CPU (720 x 1600 drew 2.4x as many). --screen=WxH@dpi picks another size.
const SOFTWARE_SCREEN = { w: 464, h: 1024, dpi: 180 };
const MODES = {
  host: { gpu: 'host', window: 'hidden', features: '-Vulkan', lcd: { w: 1080, h: 2400, dpi: 420 } },
  swiftshader: { gpu: 'swiftshader_indirect', window: 'none', features: '', lcd: SOFTWARE_SCREEN },
  // ANGLE on SwiftShader's Vulkan engine (what Chrome uses for software graphics), instead of SwiftShader's older
  // OpenGL ES library, whose generated code crashed phones while apps were drawing.
  // (Plain "swangle": unlike swiftshader_indirect, "swangle_indirect" is not understood and silently falls back.)
  swangle: { gpu: 'swangle', window: 'none', features: '', lcd: SOFTWARE_SCREEN },
};
// --ram=<MB> and --cores=<n>: the phone's memory and CPU cores. Default 3 GB and 3 cores: measured against 4 GB and
// 4 cores (6-core PC, software drawing), app start was the same, scrolling slightly smoother, ~0.9 GB less RAM.
const RAM_MB = Number((args.find((a) => a.startsWith('--ram=')) || '').slice(6)) || 3072;
const CORES = Number((args.find((a) => a.startsWith('--cores=')) || '').slice(8)) || 3;
const API_LEVEL = Number((args.find((a) => a.startsWith('--api=')) || '').slice(6)) || 0;
const IMAGE_TAG = (args.find((a) => a.startsWith('--tag=')) || '').slice(6);
// --as=<kind>: offer this profile as a kind of phone visitors can choose, e.g. --as=light (data/emulator.json "phones").
const AS_KIND = ((args.find((a) => a.startsWith('--as=')) || '').slice(5).match(/^[a-z][\w-]{0,20}$/) || [])[0] || '';
// --no-switch: build only; keep the default phone as it is.
const noSwitch = args.includes('--no-switch');
const screenArg = (args.find((a) => a.startsWith('--screen=')) || '').slice(9).match(/^(\d+)x(\d+)@(\d+)$/);
if (screenArg) for (const m of Object.values(MODES)) m.lcd = { w: Number(screenArg[1]), h: Number(screenArg[2]), dpi: Number(screenArg[3]) };

function pickSystemImage() {
  const abi = process.arch === 'arm64' ? 'arm64-v8a' : 'x86_64';
  const root = path.join(cfg.SDK, 'system-images');
  if (!fs.existsSync(root)) return null;
  const found = [];
  for (const api of fs.readdirSync(root)) {
    const level = Number((api.match(/android-(\d+)/) || [])[1]);
    if (!level) continue;
    for (const tag of fs.readdirSync(path.join(root, api))) {
      if (fs.existsSync(path.join(root, api, tag, abi, 'system.img'))) found.push({ api, level, tag, abi });
    }
  }
  const rank = (t) => (t === 'google_apis' ? 3 : t === 'google_apis_playstore' ? 2 : t === 'default' ? 1 : 0);
  found.sort((a, b) => b.level - a.level || rank(b.tag) - rank(a.tag));
  // --api=<level>: a specific Android version (e.g. 34 for Android 14); default: the newest.
  // --tag=<image type>: e.g. google_atd, Google's slim test image (no status bar, navigation bar or bundled apps).
  return found.find((f) => f.level >= 30 && (IMAGE_TAG ? f.tag === IMAGE_TAG : rank(f.tag) > 0) && (!API_LEVEL || f.level === API_LEVEL)) || null;
}

function writeAvd(img, mode) {
  fs.mkdirSync(avdDir, { recursive: true });
  const tagName = { google_apis: 'Google APIs', google_apis_playstore: 'Google Play', default: 'Default Android System Image', google_atd: 'Google APIs ATD', aosp_atd: 'AOSP ATD' }[img.tag] || img.tag;
  const config = {
    'PlayStore.enabled': img.tag === 'google_apis_playstore' ? 'yes' : 'no',
    'abi.type': img.abi,
    'avd.id': AVD,
    'avd.name': AVD,
    'avd.ini.encoding': 'UTF-8',
    'disk.dataPartition.size': '8G',
    'fastboot.forceColdBoot': 'no',
    'fastboot.forceFastBoot': 'yes',
    'hw.accelerometer': 'yes',
    'hw.audioInput': 'no',
    'hw.audioOutput': 'yes',
    'hw.battery': 'yes',
    'hw.camera.back': 'none',
    'hw.camera.front': 'none',
    'hw.cpu.arch': img.abi === 'x86_64' ? 'x86_64' : 'arm64',
    'hw.cpu.ncore': String(CORES),
    'hw.dPad': 'no',
    'hw.device.manufacturer': 'Google',
    'hw.device.name': 'pixel_7',
    'hw.gps': 'yes',
    'hw.gpu.enabled': 'yes',
    'hw.gpu.mode': mode.gpu,
    'hw.gyroscope': 'yes',
    'hw.initialOrientation': 'portrait',
    'hw.keyboard': 'yes',
    'hw.lcd.density': String(mode.lcd.dpi),
    'hw.lcd.depth': '32',
    'hw.lcd.height': String(mode.lcd.h),
    'hw.lcd.width': String(mode.lcd.w),
    'hw.lcd.vsync': '60',
    'hw.mainKeys': 'no',
    'hw.ramSize': String(RAM_MB),
    'hw.screen': 'multi-touch',
    'hw.sdCard': 'yes',
    'hw.sensors.orientation': 'yes',
    'hw.sensors.proximity': 'yes',
    'hw.trackBall': 'no',
    'image.sysdir.1': path.join('system-images', img.api, img.tag, img.abi) + path.sep,
    'sdcard.size': '512 MB',
    'showDeviceFrame': 'no',
    'tag.display': tagName,
    'tag.id': img.tag,
    'target': img.api,
    'vm.heapSize': '228M',
  };
  fs.writeFileSync(path.join(avdDir, 'config.ini'), Object.entries(config).map(([k, v]) => `${k}=${v}`).join('\n') + '\n');
  fs.writeFileSync(
    path.join(AVD_HOME, `${AVD}.ini`),
    [`avd.ini.encoding=UTF-8`, `path=${avdDir}`, `path.rel=avd${path.sep}${AVD}.avd`, `target=${img.api}`].join('\n') + '\n',
  );
}

function imageFromConfig() {
  try {
    const ini = Object.fromEntries(
      fs.readFileSync(path.join(avdDir, 'config.ini'), 'utf8').split(/\r?\n/).filter((l) => l.includes('=')).map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]),
    );
    const parts = ini['image.sysdir.1'].split(/[\\/]/).filter(Boolean);
    return { api: parts[1], tag: parts[2], abi: parts[3] };
  } catch {
    return null;
  }
}

async function bootOnce(mode) {
  const display = cfg.emulatorDisplayArgs(mode);
  console.log(`Cold-booting with ${mode.gpu} graphics. The first boot takes a few minutes…`);
  const proc = spawn(cfg.EMULATOR, ['-avd', AVD, '-port', String(PORT), '-no-snapshot-load', '-no-audio', '-no-boot-anim', ...display], {
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  proc.stdout.on('data', (d) => (output += d));
  proc.stderr.on('data', (d) => (output += d));
  const state = { exited: false };
  proc.on('exit', () => (state.exited = true));
  const t0 = Date.now();
  for (;;) {
    if (state.exited) return { ok: false, why: `the emulator crashed (${output.split('\n').filter((l) => /ERROR|FATAL/.test(l)).slice(-2).join(' ') || 'no message'})` };
    if (Date.now() - t0 > 5 * 60000) return { ok: false, why: 'it did not finish booting within 5 minutes', proc, state };
    const v = await shell(serial, 'getprop sys.boot_completed', { timeout: 5000 }).catch(() => '');
    if (v.trim() === '1') break;
    await sleep(2000);
  }
  console.log(`Booted in ${Math.round((Date.now() - t0) / 1000)}s. Letting it settle and checking stability…`);
  // Exercise the graphics for a bit: a mode that crashes under load is no use.
  for (let i = 0; i < 6 && !state.exited; i++) {
    await shell(serial, 'am start -a android.settings.SETTINGS >/dev/null; input swipe 540 1800 540 400 120; input swipe 540 400 540 1800 120; input keyevent KEYCODE_HOME', { timeout: 20000 }).catch(() => {});
    await sleep(5000);
  }
  if (state.exited) return { ok: false, why: 'the emulator crashed under load' };
  const gles = await shell(serial, "dumpsys SurfaceFlinger | grep -m1 'GLES:'", { timeout: 10000 }).catch(() => '');
  console.log(`Renderer: ${gles.replace(/^\s*GLES:\s*/, '').trim()}`);
  if (mode.gpu === 'host' && /SwiftShader/i.test(gles)) return { ok: false, why: 'host GPU was not used', proc, state };
  if (mode.gpu === 'swangle' && !/ANGLE/i.test(gles)) return { ok: false, why: 'ANGLE was not used (the emulator fell back to another renderer)', proc, state };
  return { ok: true, proc, state };
}

async function kill(result) {
  await adb(serial, ['emu', 'kill'], { timeout: 15000 }).catch(() => {});
  for (let i = 0; i < 30 && result && result.state && !result.state.exited; i++) await sleep(1000);
  if (result && result.proc && result.state && !result.state.exited) {
    if (process.platform === 'win32') await run('taskkill', ['/PID', String(result.proc.pid), '/T', '/F']).catch(() => {});
    else result.proc.kill('SIGKILL');
  }
}

async function main() {
  console.log(`Android SDK: ${cfg.SDK}`);
  for (const [name, p] of [['adb', cfg.ADB], ['emulator', cfg.EMULATOR], ['aapt2', cfg.AAPT2], ['scrcpy-server', cfg.SCRCPY_SERVER]]) {
    if (!p || !fs.existsSync(p)) throw new Error(`${name} not found${p ? ` at ${p}` : ''}. Install it with the Android SDK Manager.`);
  }
  const accel = await run(cfg.EMULATOR, ['-accel-check'], { timeout: 30000 }).then((r) => r.stdout, (e) => e.stdout || '');
  if (!/is installed and usable|accel:\s*0/i.test(accel)) console.warn('Warning: hardware acceleration may be unavailable. Phones will be very slow.\n', accel.trim());

  const hasSnapshot = fs.existsSync(path.join(avdDir, 'snapshots', cfg.SNAPSHOT));
  if (hasSnapshot && fs.existsSync(cfg.EMULATOR_FILE) && !force) {
    console.log(`Emulator profile "${AVD}" with snapshot "${cfg.SNAPSHOT}" already exists. Use --force to rebuild it.`);
    return;
  }
  const img = imageFromConfig() || pickSystemImage();
  if (!img) throw new Error('No suitable system image found (API 30+, Google APIs). Install one, e.g.:\n  sdkmanager "system-images;android-35;google_apis;x86_64"');
  console.log(`System image: ${img.api}/${img.tag}/${img.abi}`);

  const order = gpuArg ? [gpuArg] : ['host', 'swiftshader'];
  let chosen = null;
  let result = null;
  for (const name of order) {
    const mode = MODES[name];
    if (!mode) throw new Error(`Unknown --gpu mode "${name}". Use host, swiftshader or swangle.`);
    fs.rmSync(path.join(avdDir, 'snapshots'), { recursive: true, force: true });
    writeAvd(img, mode);
    result = await bootOnce(mode);
    if (result.ok) {
      chosen = { name, ...mode };
      break;
    }
    console.log(`${name} graphics did not work here: ${result.why}.`);
    await kill(result);
  }
  if (!chosen) throw new Error('No graphics mode worked.');

  await shell(serial, [
    'settings put system accelerometer_rotation 0',
    'settings put system user_rotation 0',
    'settings put global stay_on_while_plugged_in 7',
    'settings put system screen_off_timeout 2147483647',
    'settings put secure show_ime_with_hard_keyboard 1',
    'settings put global package_verifier_enable 0',
    'settings put global verifier_verify_adb_installs 0',
    'locksettings set-disabled true',
    'input keyevent KEYCODE_WAKEUP',
    'input keyevent KEYCODE_HOME',
  ].join('; '), { timeout: 30000 }).catch(() => {});
  await sleep(15000);

  console.log(`Saving snapshot "${cfg.SNAPSHOT}"…`);
  const saved = await adb(serial, ['emu', 'avd', 'snapshot', 'save', cfg.SNAPSHOT], { timeout: 180000 });
  if (!/OK/.test(saved.stdout)) throw new Error(`Snapshot failed: ${saved.stdout}`);
  await kill(result);
  const summary = `${chosen.name} graphics, ${chosen.lcd.w}x${chosen.lcd.h}, ${RAM_MB} MB, ${CORES} cores`;
  // data/emulator.json: the default profile ("avd") and the kinds of phone visitors can choose ("phones").
  let current = {};
  try {
    current = JSON.parse(fs.readFileSync(cfg.EMULATOR_FILE, 'utf8'));
  } catch {}
  const phones = { ...(current.phones || {}) };
  if (AS_KIND) phones[AS_KIND] = AVD;
  else if (!noSwitch && Object.keys(phones).length) phones.standard = AVD;
  const next = noSwitch ? { ...current } : { ...current, avd: AVD, gpu: chosen.gpu, window: chosen.window, features: chosen.features, lcd: chosen.lcd };
  if (Object.keys(phones).length) next.phones = phones;
  fs.mkdirSync(path.dirname(cfg.EMULATOR_FILE), { recursive: true });
  fs.writeFileSync(cfg.EMULATOR_FILE, JSON.stringify(next, null, 2));
  if (noSwitch) return console.log(`Built profile "${AVD}" (${summary})${AS_KIND ? ` as the "${AS_KIND}" phone` : ''}. The default phone is unchanged.`);
  console.log(`Done (${summary}). Start Handset with: npm start`);
}

main().catch((e) => {
  console.error(`\nSetup failed: ${e.message}`);
  adb(serial, ['emu', 'kill'], { timeout: 5000 }).catch(() => {}).finally(() => process.exit(1));
});
