// Keeps a pool of disposable emulators. Every phone boots read-only from the same clean snapshot,
// serves exactly one session, and is destroyed afterwards, so no visitor ever sees another visitor's data.
//
// Phones are started as independent processes and listed in data/devices.json, so they survive a server
// restart: on startup the server adopts the phones that are still running and their sessions continue.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { EventEmitter } = require('events');
const cfg = require('./config');
const { adb, shell } = require('./adb');
const { run, sleep, log } = require('./util');
const a11y = require('./a11y');
const crashinfo = require('./crashinfo');

const REGISTRY = path.join(cfg.DATA, 'devices.json');
// crashes.log: every phone crash with what is known about it.
const LOGS = path.join(cfg.DATA, 'logs');
// Windows writes crash dumps here once it is told to (see README, "When a phone crashes").
const DUMPS = path.join(cfg.DATA, 'crash-dumps');

class Device {
  constructor(slot) {
    this.slot = slot;
    this.port = cfg.BASE_PORT + slot * 2;
    this.serial = `emulator-${this.port}`;
    this.state = 'booting'; // booting | ready | busy | stopping
    this.avd = cfg.AVD; // emulator profile it was started from
    this.pid = null; // emulator process
    this.startedAt = Date.now();
    this.missing = 0;
  }
}

const alive = (pid) => {
  if (!pid) return true; // unknown: rely on adb
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e.code === 'EPERM';
  }
};

class DevicePool extends EventEmitter {
  constructor() {
    super();
    this.devices = [];
    this.waiters = [];
    this.failures = 0;
    this.pausedUntil = 0;
    this.closed = false;
  }

  async start() {
    await adb(null, ['start-server'], { timeout: 30000 }).catch(() => {});
    const online = await this.onlineSerials();
    let saved = [];
    try {
      saved = JSON.parse(fs.readFileSync(REGISTRY, 'utf8'));
    } catch {}
    for (let slot = 0; slot < cfg.MAX_DEVICES; slot++) {
      const serial = `emulator-${cfg.BASE_PORT + slot * 2}`;
      const prev = saved.find((s) => s.serial === serial);
      if (cfg.KEEP_PHONES_ON_RESTART && prev && online.has(serial) && (prev.state === 'busy' || prev.state === 'ready')) {
        // A phone from before the restart is still running: take it over.
        const d = new Device(slot);
        Object.assign(d, { startedAt: prev.startedAt, state: prev.state, pid: prev.pid || null, qemuPid: prev.qemuPid || null, paused: Boolean(prev.paused), avd: prev.avd || 'handset-base', adopted: true });
        this.devices.push(d);
        // A spare from an older emulator profile (e.g. before a graphics switch): replace it with a current one.
        // Phones in use are kept until their session ends.
        if (d.state === 'ready' && d.avd !== cfg.AVD) {
          log('pool', `${serial} is a spare from profile ${d.avd}; replacing it with one from ${cfg.AVD}`);
          this.destroy(d);
          continue;
        }
        if (!d.paused) this.startHelper(d); // a paused phone restarts its helper when it is woken
        log('pool', `${serial} adopted (${d.state})`);
      } else if (online.has(serial)) {
        // Left behind by a run that did not shut down cleanly.
        await adb(serial, ['emu', 'kill'], { timeout: 5000 }).catch(() => {});
      }
    }
    this.cleanTempFiles();
    this.watch();
    log('pool', `ready: up to ${cfg.MAX_DEVICES} phones, keeping ${cfg.WARM_DEVICES} warm (avd ${cfg.AVD}, snapshot ${cfg.SNAPSHOT})`);
    this.maintain();
  }

  adopted(serial) {
    return this.devices.find((d) => d.adopted && d.serial === serial && d.state === 'busy') || null;
  }

  // Busy phones from before a restart whose session could not be restored.
  releaseUnclaimed(claimed) {
    for (const d of [...this.devices]) if (d.adopted && d.state === 'busy' && !claimed.has(d)) this.destroy(d);
  }

  async onlineSerials() {
    const { stdout } = await adb(null, ['devices'], { timeout: 10000 }).catch(() => ({ stdout: '' }));
    return new Set(stdout.split(/\r?\n/).filter((l) => /^emulator-\d+\s+device\b/.test(l)).map((l) => l.split(/\s+/)[0]));
  }

  // Phones run as independent processes, so notice a crashed phone by polling instead of a process exit event.
  watch() {
    const tick = async () => {
      if (this.closed) return;
      const online = await this.onlineSerials();
      for (const d of [...this.devices]) {
        if (d.state === 'booting' || d.state === 'stopping') continue;
        if (this.check(d)) continue;
        d.missing = online.has(d.serial) ? 0 : d.missing + 1;
        if (d.missing >= 3) this.onExit(d, 'stopped responding'); // ~7 s, so a brief adb hiccup is not fatal
      }
      setTimeout(tick, 2500);
    };
    setTimeout(tick, 2500);
  }

  // A phone whose process has ended is gone for certain: say so at once instead of after three missed checks
  // (that alone took ~7 s of a frozen screen per crash). Sessions call this the moment their stream breaks.
  check(device) {
    if (!device || !this.devices.includes(device) || device.state === 'booting' || device.state === 'stopping') return false;
    if (alive(device.pid) && alive(device.qemuPid)) return false;
    this.onExit(device, 'process ended');
    return true;
  }

  save() {
    const list = this.devices.filter((d) => d.state !== 'stopping').map((d) => ({ slot: d.slot, serial: d.serial, port: d.port, state: d.state, pid: d.pid, qemuPid: d.qemuPid, startedAt: d.startedAt, paused: Boolean(d.paused), avd: d.avd }));
    try {
      fs.mkdirSync(cfg.DATA, { recursive: true });
      fs.writeFileSync(REGISTRY, JSON.stringify(list, null, 2));
    } catch {}
  }

  // Read-only phones keep their writes in temporary disk images. Phones that were killed hard (crash, power
  // loss, server killed) leave those behind, a few hundred MB each. Files still in use are locked and skipped.
  cleanTempFiles() {
    const dir = path.join(os.tmpdir(), 'AndroidEmulator');
    let freed = 0;
    let count = 0;
    try {
      for (const name of fs.readdirSync(dir)) {
        if (!/^TMP[\w]+\.tmp/i.test(name)) continue;
        const file = path.join(dir, name);
        try {
          const { size } = fs.statSync(file);
          fs.unlinkSync(file);
          freed += size;
          count++;
        } catch {}
      }
    } catch {
      return;
    }
    if (count) log('pool', `removed ${count} leftover emulator temp files (${(freed / 1024 ** 3).toFixed(1)} GB)`);
  }

  stats() {
    const by = (s) => this.devices.filter((d) => d.state === s).length;
    return { max: cfg.MAX_DEVICES, ready: by('ready'), busy: by('busy'), booting: by('booting'), queued: this.waiters.length };
  }

  position(session) {
    const i = this.waiters.findIndex((w) => w.session === session);
    return i < 0 ? 0 : i + 1;
  }

  acquire(session) {
    return new Promise((resolve, reject) => {
      this.waiters.push({ session, resolve, reject });
      this.maintain();
    });
  }

  cancel(session) {
    const i = this.waiters.findIndex((w) => w.session === session);
    if (i >= 0) {
      this.waiters.splice(i, 1);
      this.maintain();
    }
  }

  // The phone someone is using gets more CPU than phones that are only waiting for the next visitor.
  async findQemu(device) {
    const pid = device.pid;
    if (!pid) return null;
    try {
      if (process.platform === 'win32') {
        const { stdout } = await run('powershell', ['-NoProfile', '-Command', `(Get-CimInstance Win32_Process -Filter 'ParentProcessId=${pid}' | Where-Object Name -like 'qemu*' | Select-Object -First 1).ProcessId`], { timeout: 15000 });
        return Number(stdout.trim()) || null;
      }
      const { stdout } = await run('pgrep', ['-P', String(pid)], { timeout: 5000 });
      return Number(stdout.trim().split('\n')[0]) || pid;
    } catch {
      return process.platform === 'win32' ? null : pid;
    }
  }

  setPriority(device, level) {
    device.priority = level;
    if (!device.qemuPid) return;
    try {
      os.setPriority(device.qemuPid, os.constants.priority[level]);
    } catch {
      // Raising priority needs privileges on Linux/macOS; running at normal priority is fine.
    }
  }

  maintain() {
    if (this.closed) return;
    while (this.waiters.length) {
      const device = this.devices.find((d) => d.state === 'ready');
      if (!device) break;
      const waiter = this.waiters.shift();
      device.state = 'busy';
      this.setPriority(device, 'PRIORITY_ABOVE_NORMAL');
      // A frozen spare wakes in ~1.5 s; hand it over once it answers.
      this.resume(device).then(() => waiter.resolve(device), () => waiter.resolve(device));
    }
    const spare = this.devices.filter((d) => d.state === 'booting' || d.state === 'ready').length;
    let need = this.waiters.length + cfg.WARM_DEVICES - spare;
    if (Date.now() < this.pausedUntil) need = 0;
    while (need-- > 0 && this.devices.length < cfg.MAX_DEVICES) this.boot();
    // More idle phones than wanted (e.g. WARM_DEVICES was lowered, or one was taken over after a restart): shut the
    // extras down, they only use memory and CPU.
    const idle = this.devices.filter((d) => d.state === 'ready');
    let surplus = idle.length - Math.max(0, cfg.WARM_DEVICES) - this.waiters.length;
    for (const d of idle) {
      if (surplus-- <= 0) break;
      log('pool', `${d.serial} is a spare phone nobody needs; shutting it down`);
      this.destroy(d);
    }
    this.pinCores();
    this.save();
    this.emit('change');
  }

  // ---------- saving CPU and memory ----------

  // Freeze a phone: its CPU use drops to 0%. With `trim`, Windows also takes its memory back (measured: ~4.9 GB
  // -> 3 MB in use); it comes back gradually after resume.
  async pause(device, { trim = false } = {}) {
    if (!device || device.paused || device.state === 'stopping') return;
    await this.mobileDataOnly(device); // phones from before this setting: Wi-Fi would drop after the wake-up
    const r = await adb(device.serial, ['emu', 'avd', 'pause'], { timeout: 10000 }).catch(() => null);
    if (!r || !/OK/.test(r.stdout)) return;
    device.paused = true;
    // A paused emulator still spins one thread (~80% of a core); suspending the process stops it (measured 0%).
    await this.winProcess(device, trim ? ['suspend', 'trim'] : ['suspend']);
    log('pool', `${device.serial} paused${trim ? ' and memory released' : ''}`);
    this.pinCores();
    this.save();
  }

  // Wake a paused phone and wait until it answers (measured: ~0.2 s after the process resumes).
  async resume(device) {
    if (device.freezing) await device.freezing.catch(() => {});
    if (!device.paused) return;
    await this.winProcess(device, ['resume']);
    await adb(device.serial, ['emu', 'avd', 'resume'], { timeout: 10000 }).catch(() => {});
    device.paused = false;
    for (let i = 0; i < 30; i++) {
      if ((await shell(device.serial, 'echo ok', { timeout: 3000 }).catch(() => '')).includes('ok')) break;
      await sleep(150);
    }
    if (!device.a11y || !device.a11y.ready) this.startHelper(device, true); // its helper may have stopped while frozen
    await this.mobileDataOnly(device); // a phone frozen before this setting still has Wi-Fi, which is about to drop
    // Don't hand the phone over until its internet works, so the app's first request does not fail.
    const net = await this.waitForInternet(device);
    log('pool', `${device.serial} resumed${net}`);
    this.pinCores();
    this.save();
  }

  // Wi-Fi off, mobile data on. See PHONE_WIFI in config.js for why.
  async mobileDataOnly(device) {
    if (cfg.PHONE_WIFI || device.wifiOff) return;
    await shell(device.serial, 'svc wifi disable; svc data enable', { timeout: 10000 }).catch(() => {});
    device.wifiOff = true;
  }

  // The phone fetches Android's own connectivity check page (a 204, a few bytes): that proves DNS and the
  // connection out both work. Usually answers on the first try (~0.3 s). Gives up after ~5 s.
  async waitForInternet(device, budgetMs = 5000) {
    const t0 = Date.now();
    const probe = `printf 'GET /generate_204 HTTP/1.0\\r\\nHost: connectivitycheck.gstatic.com\\r\\n\\r\\n' | timeout 2 nc connectivitycheck.gstatic.com 80 2>/dev/null | head -1`;
    for (let i = 0; Date.now() - t0 < budgetMs; i++) {
      const out = await shell(device.serial, probe, { timeout: 4000 }).catch(() => '');
      if (/ 204\b/.test(out)) return i ? `, internet back after ${((Date.now() - t0) / 1000).toFixed(1)}s` : '';
      if (i === 1) await shell(device.serial, cfg.PHONE_WIFI ? 'svc wifi enable; svc data enable' : 'svc data enable', { timeout: 5000 }).catch(() => {});
      await sleep(400);
    }
    return ', but its internet is not working yet (is this PC online?)';
  }

  // Suspend / resume the emulator process and hand its memory back to Windows ('trim'), in one PowerShell call.
  async winProcess(device, actions) {
    if (!device.qemuPid) device.qemuPid = await this.findQemu(device);
    const pid = device.qemuPid;
    if (!pid) return;
    if (process.platform !== 'win32') {
      try {
        if (actions.includes('suspend')) process.kill(pid, 'SIGSTOP');
        if (actions.includes('resume')) process.kill(pid, 'SIGCONT');
      } catch {}
      return;
    }
    const steps = {
      suspend: `[void][H.N]::NtSuspendProcess($h)`,
      resume: `[void][H.N]::NtResumeProcess($h)`,
      trim: `[void][H.N]::EmptyWorkingSet($h)`,
    };
    const ps = [
      `Add-Type -Name N -Namespace H -MemberDefinition '[DllImport("ntdll.dll")] public static extern int NtSuspendProcess(System.IntPtr h); [DllImport("ntdll.dll")] public static extern int NtResumeProcess(System.IntPtr h); [DllImport("psapi.dll")] public static extern bool EmptyWorkingSet(System.IntPtr h);'`,
      `$h = (Get-Process -Id ${pid}).Handle`,
      ...actions.map((a) => steps[a]),
    ].join('; ');
    await run('powershell', ['-NoProfile', '-NonInteractive', '-Command', ps], { timeout: 30000 }).catch(() => {});
  }

  // With two or more phones actively in use, give each its own share of the CPU cores so they stop interrupting
  // each other; a phone running alone gets every core.
  pinCores() {
    if (process.platform !== 'win32') return;
    const n = Math.min(os.cpus().length, 30);
    const all = 2 ** n - 1;
    const active = this.devices.filter((d) => d.state === 'busy' && !d.paused && d.qemuPid);
    for (const d of this.devices) {
      if (!d.qemuPid || d.state === 'stopping') continue;
      let mask = all;
      const i = active.indexOf(d);
      if (cfg.PIN_CORES && active.length >= 2 && i >= 0) {
        const per = Math.max(1, Math.floor(n / active.length));
        mask = (2 ** per - 1) * 2 ** (per * i);
        if (i === active.length - 1) mask = all - (2 ** (per * i) - 1); // last one takes the remainder
      }
      if (d.affinity === mask) continue;
      d.affinity = mask;
      run('powershell', ['-NoProfile', '-NonInteractive', '-Command', `(Get-Process -Id ${d.qemuPid}).ProcessorAffinity = [IntPtr]${mask}`], { timeout: 15000 }).catch(() => {});
    }
  }

  // Apps visitors' apps don't need, switched off on every phone to cut background CPU and memory.
  async stripExtras(device) {
    if (!cfg.STRIP_EXTRAS) return;
    const extras = [
      'com.google.android.youtube',
      'com.google.android.apps.youtube.music',
      'com.google.android.gm',
      'com.google.android.apps.docs',
      'com.google.android.apps.maps',
      'com.google.android.apps.photos',
      'com.google.android.apps.wellbeing',
      'com.google.android.calendar',
    ];
    await shell(device.serial, `${extras.map((p) => `pm disable-user --user 0 ${p} >/dev/null 2>&1`).join('; ')}; am kill-all`, { timeout: 30000 }).catch(() => {});
  }

  // Start the emulator as its own process (not a child of the server), so it keeps running across restarts.
  async spawnEmulator(args) {
    if (process.platform === 'win32') {
      const quoted = args.map((a) => `'${String(a).replace(/'/g, "''")}'`).join(',');
      const ps = `(Start-Process -FilePath '${cfg.EMULATOR.replace(/'/g, "''")}' -ArgumentList ${quoted} -WindowStyle Hidden -PassThru).Id`;
      const { stdout } = await run('powershell', ['-NoProfile', '-NonInteractive', '-Command', ps], { timeout: 30000 });
      return Number(stdout.trim()) || null;
    }
    const proc = spawn(cfg.EMULATOR, args, { detached: true, stdio: 'ignore' });
    proc.unref();
    return proc.pid;
  }

  boot() {
    const used = new Set(this.devices.map((d) => d.slot));
    let slot = 0;
    while (used.has(slot)) slot++;
    const device = new Device(slot);
    this.devices.push(device);
    const args = [
      '-avd', cfg.AVD,
      '-port', String(device.port),
      '-read-only',
      '-snapshot', cfg.SNAPSHOT,
      '-no-snapshot-save',
      '-no-audio',
      '-no-boot-anim',
      ...cfg.emulatorDisplayArgs(),
    ];
    log('pool', `booting ${device.serial}`);
    this.spawnEmulator(args)
      .then((pid) => {
        device.pid = pid;
        return this.waitForBoot(device);
      })
      .catch((err) => {
        log('pool', `${device.serial} failed to boot: ${err.message}`);
        this.failures++;
        if (this.failures >= 3) {
          this.pausedUntil = Date.now() + 60000;
          this.failures = 0;
          log('pool', 'several boots failed in a row; pausing new boots for 60s. Did you run `npm run setup`?');
          setTimeout(() => this.maintain(), 61000);
        }
        this.destroy(device);
      });
  }

  async waitForBoot(device) {
    const deadline = Date.now() + cfg.BOOT_TIMEOUT_MS;
    while (Date.now() < deadline) {
      if (!this.devices.includes(device)) throw new Error('emulator exited');
      if (!alive(device.pid)) throw new Error('emulator exited');
      const out = await shell(device.serial, 'getprop sys.boot_completed', { timeout: 5000 }).catch(() => '');
      if (out.trim() === '1') break;
      await sleep(500);
    }
    if (Date.now() >= deadline) throw new Error('timed out');
    // Root lets Handset save and restore app sign-ins. adbd restarts, so do it before anything connects.
    await adb(device.serial, ['root'], { timeout: 20000 }).catch(() => {});
    await adb(device.serial, ['wait-for-device'], { timeout: 30000 }).catch(() => {});
    for (let i = 0; i < 20; i++) {
      if ((await shell(device.serial, 'id -u', { timeout: 5000 }).catch(() => '')).trim()) break;
      await sleep(250);
    }
    // Make sure the screen is on, unlocked and upright before anyone sees it.
    await shell(
      device.serial,
      'input keyevent KEYCODE_WAKEUP; wm dismiss-keyguard; settings put system accelerometer_rotation 0; settings put system user_rotation 0; input keyevent KEYCODE_HOME',
      { timeout: 10000 },
    ).catch(() => {});
    await this.mobileDataOnly(device);
    await this.addTestMedia(device).catch(() => {});
    await this.stripExtras(device);
    if (device.state !== 'booting') return;
    device.qemuPid = await this.findQemu(device);
    if (device.state !== 'booting') return;
    device.state = 'ready';
    this.setPriority(device, 'PRIORITY_BELOW_NORMAL');
    this.failures = 0;
    log('pool', `${device.serial} ready in ${((Date.now() - device.startedAt) / 1000).toFixed(1)}s`);
    const helper = this.startHelper(device);
    this.maintain(); // may hand it to someone who is waiting right now
    // Nobody took it: it is the spare. Freeze it (0% CPU, memory back to Windows) once its helper is up.
    if (cfg.FREEZE_SPARE && device.state === 'ready') {
      device.freezing = Promise.race([helper || Promise.resolve(), sleep(40000)])
        .then(() => (device.state === 'ready' ? this.pause(device, { trim: true }) : null))
        .finally(() => (device.freezing = null));
    }
  }

  // Test photos (vendor/test-media) in the phone's camera roll, so apps that ask for a photo have something to pick.
  async addTestMedia(device) {
    const dir = path.join(cfg.ROOT, 'vendor', 'test-media');
    const files = fs.readdirSync(dir).filter((f) => /\.(jpe?g|png)$/i.test(f));
    if (!files.length) return;
    await shell(device.serial, 'mkdir -p /sdcard/DCIM/Camera', { timeout: 10000 });
    for (const f of files) await adb(device.serial, ['push', path.join(dir, f), `/sdcard/DCIM/Camera/${f}`], { timeout: 30000 });
    await shell(device.serial, files.map((f) => `am broadcast -a android.intent.action.MEDIA_SCANNER_SCAN_FILE -d 'file:///sdcard/DCIM/Camera/${f}' >/dev/null`).join('; '), { timeout: 20000 });
  }

  // The accessibility helper (fast sign-in) installs and starts in the background; sign-ins type until it is ready.
  // Returns a promise that settles when the helper is up (or failed). `again`: replace a helper that is not running.
  startHelper(device, again = false) {
    if (!a11y.available()) return null;
    if (device.a11y && !(again && !device.a11y.ready)) return device.a11yStart || null;
    if (device.a11y) device.a11y.stop();
    device.a11y = new a11y.A11y(device.serial);
    device.a11yStart = device.a11y.start().catch((e) => log('a11y', `${device.serial} helper not available: ${e.message}`));
    return device.a11yStart;
  }

  onExit(device, why) {
    if (!this.devices.includes(device)) return;
    const unexpected = device.state !== 'stopping';
    this.devices.splice(this.devices.indexOf(device), 1);
    if (device.a11y) device.a11y.stop();
    if (unexpected) {
      log('pool', `${device.serial} exited unexpectedly (${why})`);
      this.emit('died', device);
      this.noteCrash(device).catch(() => {});
    }
    this.maintain();
  }

  // Write down what is known about a crash in data/logs/crashes.log: Windows' crash record and, when crash dumps
  // are on (scripts/enable-crash-dumps.ps1), where in the emulator it crashed. Runs after recovery has started.
  async noteCrash(device) {
    const pid = device.qemuPid;
    await sleep(1500); // Windows finishes its record and dump before the process is gone, but give it a moment
    const rec = await crashinfo.windowsRecord(pid);
    let dump = null;
    let file = pid && path.join(DUMPS, `qemu-system-x86_64-headless.exe.${pid}.dmp`);
    if (!file || !fs.existsSync(file)) {
      const recent = fs.existsSync(DUMPS) ? fs.readdirSync(DUMPS).filter((f) => /^qemu.*\.dmp$/i.test(f)).map((f) => path.join(DUMPS, f)).filter((f) => Date.now() - fs.statSync(f).mtimeMs < 120000) : [];
      file = recent[0] || null;
    }
    if (file) {
      try {
        dump = crashinfo.analyzeDump(file);
      } catch (e) {
        dump = { summary: `could not read ${path.basename(file)}: ${e.message}` };
      }
    }
    const up = Math.round((Date.now() - device.startedAt) / 1000);
    const generated = rec && rec.module === 'unknown' ? 'code generated while running (the software graphics renderer)' : rec && rec.module;
    const lines = [
      `${new Date().toISOString()}  ${device.serial}  ${device.state}${device.paused ? ' (frozen)' : ''}, up ${up}s, emulator process ${pid || '?'}`,
      rec ? `  windows: ${rec.what} (${rec.code}) in ${generated}, offset ${rec.offset}` : '  windows: no crash record (closed from outside, or out of memory?)',
      dump ? `  dump: ${dump.summary}${dump.stack && dump.stack.length ? '\n    ' + dump.stack.join('\n    ') : ''}` : `  dump: none${fs.existsSync(DUMPS) ? '' : ' (crash dumps are off: run scripts/enable-crash-dumps.ps1 once, as administrator)'}`,
    ];
    fs.mkdirSync(LOGS, { recursive: true });
    fs.appendFileSync(path.join(LOGS, 'crashes.log'), lines.join('\n') + '\n\n');
    log('pool', `${device.serial} crash: ${dump ? dump.summary : rec ? `${rec.what} in ${generated}` : 'no Windows crash record'} (data/logs/crashes.log)`);
  }

  async destroy(device) {
    if (device.state === 'stopping') return;
    device.state = 'stopping';
    if (device.a11y) device.a11y.stop();
    if (device.paused) await this.winProcess(device, ['resume']); // a suspended emulator cannot hear "kill"
    await adb(device.serial, ['emu', 'kill'], { timeout: 5000 }).catch(() => {});
    let gone = false;
    for (let i = 0; i < 20 && !gone; i++) {
      await sleep(500);
      gone = !alive(device.pid) || !(await this.onlineSerials()).has(device.serial);
    }
    if (!gone && device.pid) {
      if (process.platform === 'win32') await run('taskkill', ['/PID', String(device.pid), '/T', '/F']).catch(() => {});
      else {
        try {
          process.kill(device.pid, 'SIGKILL');
        } catch {}
      }
    }
    if (this.devices.includes(device)) this.devices.splice(this.devices.indexOf(device), 1);
    log('pool', `${device.serial} destroyed`);
    this.maintain();
  }

  release(device) {
    return this.destroy(device);
  }

  async stopAll() {
    this.closed = true;
    for (const w of this.waiters) w.reject(new Error('Server is shutting down'));
    this.waiters = [];
    await Promise.all(this.devices.map((d) => this.destroy(d)));
    this.save();
  }
}

module.exports = { DevicePool };
