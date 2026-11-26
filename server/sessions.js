// A session is one visitor using one app on one fresh phone.
const cfg = require('./config');
const store = require('./store');
const { adb, shell, screencap } = require('./adb');
const { ScrcpyStream, MSG } = require('./scrcpy');
const fs = require('fs');
const path = require('path');
const { signIn, typeText, looksSignedOut, grantEverything, keyboardShown } = require('./autologin');
const appstate = require('./appstate');
const { newId, log, sleep } = require('./util');

const KEYCODE = { back: 4, home: 3, recents: 187, power: 26, volup: 24, voldown: 25 };
const SESSIONS_FILE = path.join(cfg.DATA, 'sessions.json');
const SAFE_NAME = /^[\w.$]+$/;

const INSTALL_ERRORS = [
  [/NO_MATCHING_ABIS/, 'This app only contains native code for processors this phone cannot run.'],
  [/OLDER_SDK/, 'This app needs a newer version of Android than the phone runs (Android 15).'],
  [/NO_CERTIFICATES|INVALID_APK|NOT_APK/, 'The APK is not signed or is damaged. Upload a signed build.'],
  [/MISSING_SPLIT/, 'This APK is only part of a split app. Upload the full .apks or .xapk bundle.'],
  [/INSUFFICIENT_STORAGE/, 'The app is too large for the phone storage.'],
  [/DEPRECATED_SDK_VERSION/, 'This app targets a very old Android version that Android 15 refuses to install.'],
];

function friendlyInstallError(text) {
  for (const [re, msg] of INSTALL_ERRORS) if (re.test(text)) return msg;
  const code = (text.match(/INSTALL_[A-Z_]+/) || [])[0];
  return code ? `Android refused to install the app (${code}).` : 'Android could not install this app.';
}

class Session {
  constructor(app, ip) {
    this.id = newId(18);
    this.app = app;
    this.ip = ip;
    this.state = 'queued';
    this.message = '';
    this.device = null;
    this.client = null;
    this.stream = null;
    this.createdAt = Date.now();
    this.expiresAt = null;
    this.timers = {};
    this.streamRetries = 0;
  }

  status() {
    return {
      type: 'status',
      id: this.id,
      state: this.state,
      message: this.message,
      position: this.position || 0,
      expiresAt: this.expiresAt,
      account: this.signedInAs || null,
      device: this.device ? { name: 'Pixel 7', android: '15' } : null,
    };
  }
}

class SessionManager {
  constructor(pool) {
    this.pool = pool;
    this.sessions = new Map();
    pool.on('change', () => {
      const { booting } = pool.stats();
      for (const s of this.sessions.values()) {
        if (s.state !== 'queued') continue;
        const p = pool.position(s);
        const message = p > 0 && p <= booting ? 'Starting a fresh phone' : 'Waiting for a free phone';
        if (p !== s.position || message !== s.message) {
          s.position = p;
          s.message = message;
          this.broadcast(s);
        }
      }
    });
    pool.on('died', (device) => {
      for (const s of this.sessions.values()) if (s.device === device) this.recover(s);
    });
  }

  get(id) {
    return this.sessions.get(id) || null;
  }

  active() {
    return [...this.sessions.values()].filter((s) => s.state !== 'ended');
  }

  create(app, ip) {
    const mine = this.active().filter((s) => s.ip === ip);
    if (mine.length >= cfg.MAX_SESSIONS_PER_IP) {
      const err = new Error(`You already have ${mine.length} phone${mine.length > 1 ? 's' : ''} running. End one before starting another.`);
      err.status = 429;
      throw err;
    }
    const session = new Session(app, ip);
    this.sessions.set(session.id, session);
    log('session', `${session.id.slice(0, 6)} created for ${app.package}`);
    this.armIdle(session);
    this.run(session).catch((err) => {
      log('session', `${session.id.slice(0, 6)} failed: ${err.message}`);
      this.end(session, err.message, true);
    });
    return session;
  }

  setState(session, state, message = '') {
    if (session.state === 'ended') return;
    session.state = state;
    session.message = message;
    this.broadcast(session);
    this.persistSoon();
  }

  // ---------- surviving server restarts ----------
  // Open sessions are written to data/sessions.json; after a restart they are rebuilt on the phones the pool
  // adopted, and visitors' pages reconnect to them.

  persistSoon() {
    clearTimeout(this.persistTimer);
    this.persistTimer = setTimeout(() => this.persist(), 200);
  }

  persist() {
    // Every open session, including ones still waiting for a phone or being set up: after a restart they resume.
    const list = this.active().map((s) => ({
      id: s.id,
      appId: s.app.id,
      ip: s.ip,
      state: s.state,
      serial: s.device ? s.device.serial : null,
      createdAt: s.createdAt,
      expiresAt: s.expiresAt,
      signedInAs: s.signedInAs || null,
      maxSize: s.maxSize || null,
    }));
    try {
      fs.mkdirSync(cfg.DATA, { recursive: true });
      fs.writeFileSync(SESSIONS_FILE, JSON.stringify(list, null, 2));
    } catch {}
  }

  restore() {
    let list = [];
    if (cfg.KEEP_PHONES_ON_RESTART) {
      try {
        list = JSON.parse(fs.readFileSync(SESSIONS_FILE, 'utf8'));
      } catch {}
    }
    const claimed = new Set();
    const resume = [];
    for (const x of list) {
      const app = store.get(x.appId);
      if (!app) continue;
      const device = x.serial ? this.pool.adopted(x.serial) : null;
      const s = new Session(app, x.ip);
      Object.assign(s, { id: x.id, createdAt: x.createdAt, expiresAt: x.expiresAt, maxSize: x.maxSize || undefined });
      this.sessions.set(s.id, s);
      if (s.expiresAt) s.timers.expire = setTimeout(() => this.end(s, 'Your session reached its time limit.'), Math.max(1000, s.expiresAt - Date.now()));
      this.armIdle(s); // its page reconnects within IDLE_SECONDS, or the phone is freed
      if (device && !claimed.has(device)) {
        claimed.add(device);
        s.device = device;
        if (x.state === 'running') {
          Object.assign(s, { state: 'running', signedInAs: x.signedInAs });
          log('session', `${s.id.slice(0, 6)} restored on ${device.serial} after a restart`);
        } else {
          s.state = 'installing';
          resume.push([s, () => this.setup(s)]); // was still installing or opening the app: finish that
          log('session', `${s.id.slice(0, 6)} restored on ${device.serial}; finishing setup`);
        }
      } else {
        // Its phone is gone (or it was still waiting for one): get a fresh phone.
        s.state = 'queued';
        resume.push([s, () => this.run(s)]);
        log('session', `${s.id.slice(0, 6)} restored after a restart; getting a fresh phone`);
      }
    }
    this.pool.releaseUnclaimed(claimed);
    for (const [s, go] of resume) go().catch((err) => this.end(s, err.message, true));
    // Saved sign-ins of phones that no longer exist.
    const keep = new Set(this.pool.devices.map((d) => `${d.serial}-${d.startedAt}`));
    try {
      for (const dir of fs.readdirSync(path.join(cfg.DATA, 'phone-states'))) {
        if (!keep.has(dir)) fs.rmSync(path.join(cfg.DATA, 'phone-states', dir), { recursive: true, force: true });
      }
    } catch {}
    this.persist();
  }

  broadcast(session, msg = session.status()) {
    const ws = session.client;
    if (ws && ws.readyState === 1) ws.send(JSON.stringify(msg));
  }

  async run(session) {
    const { app } = session;
    const device = await this.pool.acquire(session);
    if (session.state === 'ended') return void this.pool.release(device);
    session.device = device;
    log('session', `${session.id.slice(0, 6)} is on ${device.serial}`);
    if (cfg.SESSION_MINUTES > 0) {
      session.expiresAt = Date.now() + cfg.SESSION_MINUTES * 60000;
      session.timers.expire = setTimeout(() => this.end(session, 'Your session reached its time limit.'), cfg.SESSION_MINUTES * 60000);
    }
    await this.setup(session);
  }

  // Install the app on the session's phone and open it (also used to resume a session after a restart).
  async setup(session) {
    const { app, device } = session;
    if (session.client) this.startStream(session);

    this.setState(session, 'installing', `Installing ${app.name}`);
    const files = store.installFiles(app);
    const flags = ['-r', '-t', ...(cfg.GRANT_PERMISSIONS ? ['-g'] : [])];
    const args = files.length > 1 ? ['install-multiple', ...flags, ...files] : ['install', ...flags, files[0]];
    const t0 = Date.now();
    try {
      const { stdout } = await adb(device.serial, args, { timeout: 10 * 60000 });
      if (!/Success/.test(stdout)) throw Object.assign(new Error(stdout), { stdout });
    } catch (e) {
      const text = `${e.stdout || ''} ${e.stderr || ''} ${e.message}`;
      log('session', `${session.id.slice(0, 6)} install failed: ${text.trim().split('\n').pop()}`);
      throw new Error(friendlyInstallError(text));
    }
    if (session.state === 'ended') return;
    log('session', `${session.id.slice(0, 6)} installed ${app.package} in ${((Date.now() - t0) / 1000).toFixed(1)}s`);

    this.setState(session, 'launching', `Opening ${app.name}`);
    await this.launch(session);
    this.setState(session, 'running');

    // Keep a fresh screenshot of the app for the library.
    session.timers.shot = setTimeout(async () => {
      if (session.state !== 'running') return;
      const png = await screencap(device.serial).catch(() => null);
      store.saveScreenshot(app.id, png);
    }, 9000);
  }

  async launch(session) {
    const { app, device } = session;
    if (!SAFE_NAME.test(app.package)) throw new Error('Invalid package name');
    if (app.activity && SAFE_NAME.test(app.activity)) {
      const out = await shell(device.serial, `am start -W -n '${app.package}/${app.activity}'`, { timeout: 60000 }).catch((e) => e.stdout || '');
      if (!/Error|Exception/.test(out)) return;
    }
    const out = await shell(device.serial, `monkey -p '${app.package}' -c android.intent.category.LAUNCHER 1`, { timeout: 60000 }).catch((e) => e.stdout || '');
    if (/No activities found|monkey aborted/i.test(out)) throw new Error('This app has no screen that can be opened from the home screen.');
  }

  // The emulator crashed (it happens occasionally with software graphics): move the visitor to a fresh
  // phone with the app installed, instead of ending their session.
  recover(session) {
    if (session.state === 'ended') return;
    session.recoveries = (session.recoveries || 0) + 1;
    if (session.recoveries > 2) return this.end(session, 'The phone stopped unexpectedly, several times.', true);
    log('session', `${session.id.slice(0, 6)} phone crashed; moving to a fresh phone`);
    this.stopStream(session);
    clearTimeout(session.timers.shot);
    this.dropStates(session.device);
    session.device = null;
    session.streamRetries = 0;
    session.login = null;
    session.signedInAs = null;
    session.loginEpoch = (session.loginEpoch || 0) + 1;
    this.broadcast(session, { type: 'notice', text: 'The phone crashed. Starting a fresh one with your app.' });
    this.setState(session, 'queued', 'Starting a fresh phone');
    this.run(session).catch((err) => this.end(session, err.message, true));
  }

  // ---------- test accounts ----------

  // Saved sign-ins only work on the phone that made them (apps often encrypt logins with keys held in that
  // phone's keystore), so they are kept per phone and deleted when the phone is destroyed.
  stateFile(session, name) {
    const d = session.device;
    return path.join(cfg.DATA, 'phone-states', `${d.serial}-${d.startedAt}`, session.app.id, `${String(name).replace(/[^\w-]/g, '')}.tgz`);
  }

  dropStates(device) {
    if (device) fs.rmSync(path.join(cfg.DATA, 'phone-states', `${device.serial}-${device.startedAt}`), { recursive: true, force: true });
  }

  // Fast input for the sign-in automation: through the open scrcpy control channel when there is one.
  async fastIo(session) {
    const serial = session.device.serial;
    if (!session.device.display) {
      const out = await shell(serial, 'wm size', { timeout: 10000 }).catch(() => '');
      const sizes = out.match(/\d+x\d+/g) || ['720x1600'];
      const [w, h] = sizes[sizes.length - 1].split('x').map(Number);
      session.device.display = { w, h };
    }
    const { w: W, h: H } = session.device.display;
    const s = () => (session.stream && session.stream.size ? session.stream : null);
    // The accessibility helper fills fields and clicks buttons directly (instant, no keyboard). Typing is the fallback.
    const a11y = session.device.a11y && session.device.a11y.ready ? session.device.a11y : null;
    return {
      a11y,
      setText: a11y ? (n, v) => a11y.setText(n, v) : undefined,
      click: a11y ? (n) => a11y.click(n) : undefined,
      focus: a11y ? (n) => a11y.click(n) : undefined, // clicking a text field focuses it
      async tap(n, ui) {
        const stream = s();
        if (!stream) return void (await shell(serial, `input tap ${n.x} ${n.y}`, { timeout: 10000 }));
        const [w, h] = ui && ui.rotation % 2 ? [H, W] : [W, H];
        stream.touch(0, 0, n.x / w, n.y / h);
        await sleep(55);
        stream.touch(1, 0, n.x / w, n.y / h);
        await sleep(90);
      },
      async text(v) {
        const stream = s();
        if (!stream) return void (await typeText(serial, v));
        // Small paced bursts: a single blast can lose keystrokes while the app is busy.
        for (let i = 0; i < v.length; i += 2) {
          stream.text(v.slice(i, i + 2));
          await sleep(22);
        }
        await sleep(60);
      },
      async del(n) {
        const stream = s();
        if (!stream) return void (await shell(serial, `input keyevent ${Array(Math.max(1, n)).fill(67).join(' ')}`, { timeout: 20000 }));
        for (let i = 0; i < n; i++) {
          stream.press(67);
          await sleep(12);
        }
        await sleep(60);
      },
      async clear() {
        const stream = s();
        if (!stream) return void (await shell(serial, 'input keycombination 113 29; input keyevent 67', { timeout: 10000 }).catch(() => {}));
        stream.press(29, 0x3000); // Ctrl+A
        stream.press(67); // Delete
        await sleep(30);
      },
      async key(code) {
        const stream = s();
        if (!stream) return void (await shell(serial, `input keyevent ${code}`, { timeout: 10000 }));
        stream.press(code);
        await sleep(60);
      },
      // Close the on-screen keyboard if it is open (Back only closes the keyboard; it does not leave the app).
      async hideKeyboard() {
        if (!(await keyboardShown(serial))) return;
        const stream = s();
        if (stream) stream.press(4);
        else await shell(serial, 'input keyevent 4', { timeout: 10000 });
        const t0 = Date.now();
        await sleep(150);
        while (Date.now() - t0 < 1500 && (await keyboardShown(serial))) await sleep(80);
        await sleep(180); // let the form slide back down
      },
      // Wait until the screen stops changing: at least `min` ms, at most `max` ms.
      async settle(min = 250, max = 2000) {
        const t0 = Date.now();
        await sleep(min);
        if (!s()) return void (await sleep(Math.max(0, Math.min(max, 900) - min)));
        while (Date.now() - t0 < max) {
          if (Date.now() - (session.lastFrameAt || 0) >= 160) return;
          await sleep(40);
        }
      },
    };
  }

  async loginAs(session, accountId) {
    if (session.state !== 'running' || session.login) return;
    await this.wake(session);
    const account = store.account(session.app, accountId);
    if (!account) return this.broadcast(session, { type: 'login', state: 'failed', label: '', message: 'That account no longer exists.' });
    const { app } = session;
    const serial = session.device.serial;
    const pkg = app.package;
    if (!SAFE_NAME.test(pkg)) return;
    const login = { id: account.id, label: account.name, step: '' };
    session.login = login;
    const previous = session.signedInAs;
    session.signedInAs = null;
    const epoch = session.loginEpoch || 0;
    const current = () => epoch === (session.loginEpoch || 0) && session.state !== 'ended';
    // If the phone was replaced meanwhile, this sign-in no longer matters: stay quiet.
    const report = (state, extra = {}) => current() && this.broadcast(session, { type: 'login', state, id: account.id, label: account.name, step: login.step, ...extra });
    const step = (text) => {
      login.step = text;
      report('working');
    };
    log('session', `${session.id.slice(0, 6)} signing in as "${account.name}"`);
    const t0 = Date.now();
    const secs = () => ((Date.now() - t0) / 1000).toFixed(1);
    try {
      await session.stateBusy; // a background save of the previous account may still be running
      if (session.device.root === undefined) session.device.root = await appstate.hasRoot(serial);
      const root = session.device.root;
      const startCmd = app.activity && SAFE_NAME.test(app.activity) ? `am start -W -n '${pkg}/${app.activity}' >/dev/null 2>&1` : `monkey -p '${pkg}' -c android.intent.category.LAUNCHER 1 >/dev/null 2>&1`;
      // Permissions survive logging out (they are not app data), so grant them once per phone.
      const device = session.device;
      device.granted = device.granted || new Set();
      const grants = device.granted.has(pkg) ? ':' : await grantEverything(serial, pkg);
      device.savedAt = device.savedAt || {};
      const phase = (name, since) => log('session', `${session.id.slice(0, 6)}   ${name} ${((Date.now() - since) / 1000).toFixed(1)}s`);
      // Press Home through the video connection (instant) so the app stops drawing before it is closed.
      const homeNow = () => {
        if (session.stream) session.stream.press(3);
        return Boolean(session.stream);
      };

      // Keep the account we are leaving fresh (its tokens may have been refreshed while it was used), unless it
      // was saved in the last few minutes anyway.
      if (root && previous && previous !== account.id && store.account(app, previous) && Date.now() - (device.savedAt[previous] || 0) > 5 * 60000) {
        step('Saving the current sign-in');
        const tp = Date.now();
        await appstate.save(serial, pkg, this.stateFile(session, previous)).then(() => (device.savedAt[previous] = Date.now())).catch(() => {});
        phase('saved the current sign-in in', tp);
      }

      // 1) Fast path: put back this account's saved sign-in and reopen the app.
      const saved = this.stateFile(session, account.id);
      if (root && fs.existsSync(saved)) {
        step('Restoring saved sign-in');
        const tp = Date.now();
        await appstate.restore(serial, pkg, saved, { homeSent: homeNow() });
        phase('restored files in', tp);
        const ts = Date.now();
        await shell(serial, `${grants}; ${startCmd}`, { timeout: 60000 });
        device.granted.add(pkg);
        phase('app opened in', ts);
        device.savedAt[account.id] = fs.statSync(saved).mtimeMs; // the restored copy is this recent
        session.signedInAs = account.id;
        this.persistSoon();
        if (session.login === login) session.login = null;
        log('session', `${session.id.slice(0, 6)} restored "${account.name}" in ${secs()}s`);
        report('done', { seconds: Number(secs()), restored: true });
        // Check in the background that the app accepted it; if not, sign in the slow way.
        const signedOut = await looksSignedOut(serial, pkg, app.loginTexts || [], session.device.a11y && session.device.a11y.ready ? session.device.a11y : null).catch(() => null);
        if (!signedOut || !current() || session.signedInAs !== account.id) return;
        log('session', `${session.id.slice(0, 6)} saved sign-in for "${account.name}" was not accepted; signing in again`);
        fs.rmSync(saved, { force: true });
        session.signedInAs = null;
        if (session.login) return;
        session.login = login;
        login.step = 'The saved sign-in had expired. Signing in again';
        report('working');
      }

      // 2) Sign in by filling the form, as fast as the screen allows.
      const baseline = this.stateFile(session, '_baseline');
      let baselineTaken = false;
      let prepared = 0;
      const io = await this.fastIo(session);
      // Apps where instant filling did not work before are filled by typing (screen reads stay fast).
      if (app.fillMode === 'type') io.setText = undefined; // still focus fields and click buttons through the helper
      const attempt = (withIo) => signIn({
        serial,
        pkg,
        fields: account.fields,
        io: withIo,
        prepare: async () => {
          const tp = Date.now();
          const homeSent = homeNow();
          if (root && fs.existsSync(baseline)) await appstate.restore(serial, pkg, baseline, { homeSent }); // skips intro screens
          else if (root) await appstate.wipe(serial, pkg, { homeSent });
          else await shell(serial, `${homeSent ? 'sleep 0.25' : 'input keyevent 3; sleep 0.4'}; am force-stop '${pkg}'; pm clear '${pkg}'`, { timeout: 30000 }); // background first: see appstate.js
          phase('signed out in', tp);
          const ts = Date.now();
          await shell(serial, `settings put secure show_ime_with_hard_keyboard 0; ${grants}; ${startCmd}`, { timeout: 60000 });
          device.granted.add(pkg);
          phase('app opened in', ts);
          prepared = Date.now();
        },
        launch: () => this.launch(session),
        onStep: step,
        onLoginScreen: async (labels) => {
          if (prepared) {
            phase('sign-in screen appeared', prepared);
            prepared = 0;
          }
          store.rememberLoginTexts(app.id, labels);
          // Remember the app as it looks on its first sign-in screen, so later sign-ins skip the intro screens.
          // Awaited: with instant filling the sign-in would otherwise finish first and the "signed-out" snapshot
          // would contain this account's login.
          if (root && !baselineTaken && !fs.existsSync(baseline)) {
            baselineTaken = true;
            await appstate.save(serial, pkg, baseline).catch(() => {});
          }
        },
        cancelled: () => !current(),
      });
      let result = await attempt(io);
      // Safety net: if instant filling did not take (and the app did not reject the password itself), sign in again
      // by typing, and use typing for this app from now on.
      if (!result.ok && io.setText && /^(Still on the sign-in screen|The app did not move past)/.test(result.message) && !/don.?t match|invalid|incorrect|wrong|no account|not recogni|locked|disabled|expired/i.test(result.message)) {
        log('session', `${session.id.slice(0, 6)} instant fill did not work for ${pkg} (${result.message}); signing in by typing`);
        step('Trying again by typing');
        result = await attempt({ ...io, setText: undefined });
        if (result.ok) {
          app.fillMode = 'type';
          store.rememberFillMode(app.id, 'type');
        }
      }
      log('session', `${session.id.slice(0, 6)} sign-in as "${account.name}" ${result.ok ? 'done' : 'failed'} in ${secs()}s${result.message ? `: ${result.message}` : ''}`);
      if (session.login === login) session.login = null;
      if (result.ok && current()) session.signedInAs = account.id;
      this.persistSoon();
      report(result.ok ? 'done' : 'failed', { message: result.message, seconds: Number(secs()) });
      // Save this sign-in so the next switch back takes seconds.
      if (result.ok && root && current()) {
        session.stateBusy = sleep(1500)
          .then(() => appstate.save(serial, pkg, saved))
          .then((bytes) => {
            device.savedAt[account.id] = Date.now();
            return bytes;
          })
          .then((bytes) => log('session', `${session.id.slice(0, 6)} saved sign-in for "${account.name}" (${Math.round(bytes / 1024)} KB)`))
          .catch((e) => log('session', `${session.id.slice(0, 6)} could not save sign-in: ${e.message}`));
      }
    } catch (e) {
      if (session.login === login) session.login = null;
      if (!e.cancelled) report('failed', { message: `Signing in stopped: ${e.message}` });
    } finally {
      if (session.device) shell(serial, 'settings put secure show_ime_with_hard_keyboard 1', { timeout: 10000 }).catch(() => {});
    }
  }

  // Types one saved value into whatever field is focused on the phone (for signing in by hand).
  // which: 'username' | 'password' | 'extra:<n>'
  async typeField(session, accountId, which) {
    if (!session.device) return;
    await this.wake(session);
    const account = store.account(session.app, accountId);
    if (!account) return;
    const extra = /^extra:(\d)$/.exec(which);
    const value = which === 'username' ? account.username : which === 'password' ? account.password : extra && account.extras[Number(extra[1])] ? account.extras[Number(extra[1])].value : '';
    if (!value) return;
    if (session.stream) session.stream.text(value);
    else await typeText(session.device.serial, value).catch(() => {});
  }

  async appAction(session, kind) {
    if (session.state !== 'running' || session.login) return;
    await this.wake(session);
    const pkg = session.app.package;
    if (!SAFE_NAME.test(pkg)) return;
    if (kind === 'clear') session.signedInAs = null;
    this.setState(session, 'launching', kind === 'clear' ? `Clearing data and reopening ${session.app.name}` : `Restarting ${session.app.name}`);
    if (kind === 'clear' && session.device.root) await appstate.wipe(session.device.serial, pkg).catch(() => {}); // keeps keystore keys, so saved sign-ins stay usable
    else await shell(session.device.serial, `input keyevent 3; sleep 0.4; ${kind === 'clear' ? `pm clear '${pkg}'` : `am force-stop '${pkg}'`}`, { timeout: 30000 }).catch(() => {});
    await this.launch(session).catch(() => {});
    this.setState(session, 'running');
  }

  // ---------- browser connection ----------

  // Clamp the long edge the viewer asked for. Encoding only the pixels the browser shows keeps the phone's
  // (software) video encoder cheap, which is most of what makes the stream smooth.
  streamSize(requested) {
    const n = Number(requested);
    if (!Number.isFinite(n) || n <= 0) return cfg.MAX_SIZE;
    return Math.max(cfg.MIN_SIZE, Math.min(cfg.MAX_SIZE, Math.ceil(n / 16) * 16));
  }

  attach(session, ws, opts = {}) {
    session.maxSize = this.streamSize(opts.max);
    if (session.client && session.client !== ws) {
      const old = session.client;
      session.client = null;
      this.stopStream(session);
      old.send(JSON.stringify({ type: 'replaced' }));
      old.close(4000, 'replaced');
    }
    if (session.state === 'ended') {
      ws.send(JSON.stringify(session.status()));
      ws.close(4001, 'ended');
      return;
    }
    session.client = ws;
    clearTimeout(session.timers.idle);
    clearTimeout(session.timers.pause);
    session.hidden = false;
    this.broadcast(session);
    if (session.login) this.broadcast(session, { type: 'login', state: 'working', id: session.login.id, label: session.login.label, step: session.login.step });
    if (session.device) this.wake(session).then(() => session.client === ws && this.startStream(session));

    ws.on('message', (data, isBinary) => {
      if (isBinary) return;
      let msg;
      try {
        msg = JSON.parse(data.toString());
      } catch {
        return;
      }
      this.onClientMessage(session, msg);
    });
    ws.on('close', () => {
      if (session.client !== ws) return;
      session.client = null;
      this.stopStream(session);
      this.armIdle(session);
      // Tab closed (or connection lost): freeze the phone while we wait to see if they come back.
      clearTimeout(session.timers.pause);
      session.timers.pause = setTimeout(() => {
        if (!session.client && !session.login && session.device) this.pool.pause(session.device, { trim: true });
      }, 3000);
    });
    ws.on('error', () => {});
  }

  // Make sure the session's phone is running (it may have been paused while nobody was watching).
  async wake(session) {
    clearTimeout(session.timers.pause);
    if (session.device && session.device.paused) await this.pool.resume(session.device);
  }

  // The visitor's tab was hidden or shown again. Hidden: stop the video, and after a while freeze the phone.
  onVisibility(session, hidden) {
    session.hidden = hidden;
    clearTimeout(session.timers.pause);
    if (hidden) {
      this.stopStream(session);
      session.timers.pause = setTimeout(() => {
        if (session.hidden && !session.login && session.device) this.pool.pause(session.device);
      }, cfg.PAUSE_HIDDEN_SECONDS * 1000);
    } else if (session.device && session.client) {
      const ws = session.client;
      this.wake(session).then(() => session.client === ws && !session.hidden && this.startStream(session));
    }
  }

  armIdle(session) {
    clearTimeout(session.timers.idle);
    session.timers.idle = setTimeout(() => {
      if (!session.client) this.end(session, 'Nobody was connected, so the phone was shut down.');
    }, cfg.IDLE_SECONDS * 1000);
  }

  startStream(session) {
    if (session.stream || !session.device || !session.client) return;
    const ws = session.client;
    const stream = new ScrcpyStream(session.device.serial, { maxSize: session.maxSize || cfg.MAX_SIZE });
    session.stream = stream;
    let dropping = false;

    stream.on('size', (size) => this.broadcast(session, { type: 'size', ...size }));
    stream.on('clipboard', (text) => this.broadcast(session, { type: 'clipboard', text }));
    stream.on('packet', (p) => {
      if (!p.config) session.lastFrameAt = Date.now();
      if (ws.readyState !== 1) return;
      // If the visitor's connection cannot keep up, skip frames until the next keyframe instead of building lag.
      if (!p.config) {
        if (dropping) {
          if (!p.key || ws.bufferedAmount > 256 * 1024) return;
          dropping = false;
        } else if (ws.bufferedAmount > 2 * 1024 * 1024) {
          dropping = true;
          stream.simple(MSG.RESET_VIDEO);
          return;
        }
      }
      const head = Buffer.alloc(9);
      head[0] = (p.config ? 1 : 0) | (p.key ? 2 : 0);
      head.writeBigUInt64BE(p.pts, 1);
      ws.send(Buffer.concat([head, p.data]), { binary: true });
    });
    stream.on('close', (reason) => {
      if (session.stream === stream) session.stream = null;
      if (stream.stoppedByUs || session.state === 'ended' || session.client !== ws || ws.readyState !== 1) return;
      // The phone's process is gone: the pool moves the session to a fresh phone right now (recover).
      if (session.device && this.pool.check(session.device)) return;
      // Otherwise keep retrying for ~15 s: if the phone stopped answering, the pool notices within ~8 s and moves the
      // session to a fresh phone, which is better than ending it here.
      if (session.streamRetries++ < 10) {
        log('session', `${session.id.slice(0, 6)} stream closed (${reason}), restarting`);
        setTimeout(() => session.device && this.startStream(session), 1500);
      } else {
        this.end(session, 'Lost the connection to the phone screen.', true);
      }
    });
    stream.start().then(
      () => {
        session.streamRetries = 0;
      },
      (err) => {
        log('session', `${session.id.slice(0, 6)} stream failed: ${err.message}`);
        stream.close('start failed');
      },
    );
  }

  stopStream(session) {
    if (session.stream) {
      const s = session.stream;
      session.stream = null;
      s.stoppedByUs = true;
      s.close('stopped');
    }
  }

  // The viewer's display size changed a lot (e.g. full screen): restart the stream at the new size.
  resizeStream(session, requested) {
    const next = this.streamSize(requested);
    const prev = session.maxSize || cfg.MAX_SIZE;
    if (Math.abs(next - prev) / prev < 0.15) return;
    session.maxSize = next;
    if (!session.stream) return;
    this.stopStream(session);
    this.startStream(session);
  }

  onClientMessage(session, m) {
    const s = session.stream;
    const n = (v, lo, hi) => (typeof v === 'number' && Number.isFinite(v) ? Math.max(lo, Math.min(hi, v)) : lo);
    switch (m.t) {
      case 'touch':
        if (s) s.touch(n(m.a, 0, 3) | 0, n(m.p, 0, 9) | 0, n(m.x, 0, 1), n(m.y, 0, 1), m.pr === undefined ? 1 : n(m.pr, 0, 1));
        break;
      case 'key':
        if (s) {
          const code = n(m.k, 0, 400) | 0;
          const meta = n(m.m, 0, 0x7fffffff) | 0;
          if (m.a === 0 || m.a === 1) s.key(m.a, code, meta, n(m.r, 0, 1000) | 0);
          else s.press(code, meta);
        }
        break;
      case 'text':
        if (s && typeof m.s === 'string' && m.s.length) s.text(m.s.slice(0, 300));
        break;
      case 'scroll':
        if (s) s.scroll(n(m.x, 0, 1), n(m.y, 0, 1), n(m.h, -16, 16), n(m.v, -16, 16));
        break;
      case 'clip':
        if (s && typeof m.s === 'string') s.setClipboard(m.s, Boolean(m.paste));
        break;
      case 'nav':
        if (!s) break;
        if (KEYCODE[m.k]) s.press(KEYCODE[m.k]);
        else if (m.k === 'rotate') s.simple(MSG.ROTATE);
        else if (m.k === 'notifications') s.simple(MSG.EXPAND_NOTIFICATIONS);
        else if (m.k === 'quicksettings') s.simple(MSG.EXPAND_SETTINGS);
        else if (m.k === 'collapse') s.simple(MSG.COLLAPSE_PANELS);
        break;
      case 'reset-video':
        if (s) s.simple(MSG.RESET_VIDEO);
        break;
      case 'visibility':
        this.onVisibility(session, Boolean(m.hidden));
        break;
      case 'quality':
        this.resizeStream(session, m.max);
        break;
      case 'app':
        if (m.k === 'restart' || m.k === 'clear') this.appAction(session, m.k).catch(() => {});
        break;
      case 'login':
        if (typeof m.a === 'string') this.loginAs(session, m.a).catch(() => {});
        break;
      case 'type':
        if (typeof m.a === 'string' && typeof m.f === 'string') this.typeField(session, m.a, m.f).catch(() => {});
        break;
      case 'ping':
        this.broadcast(session, { type: 'pong', t: m.t0 });
        break;
      default:
    }
  }

  end(session, reason = 'Session ended.', error = false) {
    if (session.state === 'ended') return;
    session.state = 'ended';
    session.message = reason;
    session.error = error;
    for (const t of Object.values(session.timers)) clearTimeout(t);
    this.stopStream(session);
    this.pool.cancel(session);
    if (session.device) {
      this.dropStates(session.device);
      this.pool.release(session.device);
    }
    session.device = null;
    this.broadcast(session, { ...session.status(), error });
    log('session', `${session.id.slice(0, 6)} ended: ${reason}`);
    this.persistSoon();
    // Keep the record briefly so a reconnecting page learns why it ended.
    setTimeout(() => this.sessions.delete(session.id), 10 * 60000);
  }

  async endAll() {
    for (const s of this.sessions.values()) this.end(s, 'The server is restarting.');
  }
}

module.exports = { SessionManager };
