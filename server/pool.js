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

const REGISTRY = path.join(cfg.DATA, 'devices.json');

class Device {
  constructor(slot) {
    this.slot = slot;
    this.port = cfg.BASE_PORT + slot * 2;
    this.serial = `emulator-${this.port}`;
    this.state = 'booting'; // booting | ready | busy | stopping
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
        Object.assign(d, { startedAt: prev.startedAt, state: prev.state, pid: prev.pid || null, qemuPid: prev.qemuPid || null, adopted: true });
        this.devices.push(d);
        this.startHelper(d);
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
        const gone = !online.has(d.serial) || !alive(d.pid);
        d.missing = gone ? d.missing + 1 : 0;
        if (d.missing >= 3) this.onExit(d, !alive(d.pid) ? 'process ended' : 'stopped responding'); // ~7 s, so a brief adb hiccup is not fatal
      }
      setTimeout(tick, 2500);
    };
    setTimeout(tick, 2500);
  }

  save() {
    const list = this.devices.filter((d) => d.state !== 'stopping').map((d) => ({ slot: d.slot, serial: d.serial, port: d.port, state: d.state, pid: d.pid, qemuPid: d.qemuPid, startedAt: d.startedAt }));
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
      waiter.resolve(device);
    }
    const spare = this.devices.filter((d) => d.state === 'booting' || d.state === 'ready').length;
    let need = this.waiters.length + cfg.WARM_DEVICES - spare;
    if (Date.now() < this.pausedUntil) need = 0;
    while (need-- > 0 && this.devices.length < cfg.MAX_DEVICES) this.boot();
    this.save();
    this.emit('change');
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
    await this.addTestMedia(device).catch(() => {});
    if (device.state !== 'booting') return;
    device.qemuPid = await this.findQemu(device);
    if (device.state !== 'booting') return;
    device.state = 'ready';
    this.setPriority(device, 'PRIORITY_BELOW_NORMAL');
    this.failures = 0;
    log('pool', `${device.serial} ready in ${((Date.now() - device.startedAt) / 1000).toFixed(1)}s`);
    this.startHelper(device);
    this.maintain();
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
  startHelper(device) {
    if (!a11y.available() || device.a11y) return;
    device.a11y = new a11y.A11y(device.serial);
    device.a11y.start().catch((e) => log('a11y', `${device.serial} helper not available: ${e.message}`));
  }

  onExit(device, why) {
    if (!this.devices.includes(device)) return;
    const unexpected = device.state !== 'stopping';
    this.devices.splice(this.devices.indexOf(device), 1);
    if (device.a11y) device.a11y.stop();
    if (unexpected) {
      log('pool', `${device.serial} exited unexpectedly (${why})`);
      this.emit('died', device);
    }
    this.maintain();
  }

  async destroy(device) {
    if (device.state === 'stopping') return;
    device.state = 'stopping';
    if (device.a11y) device.a11y.stop();
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
