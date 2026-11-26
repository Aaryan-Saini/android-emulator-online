// Talks to the Appium UiAutomator2 server (vendor/appium-uia2) running on a phone: a long-lived accessibility
// helper. Compared with spawning `uiautomator dump` for every look at the screen (~2 s), it reads the screen in
// ~0.15 s, and it can set a field's whole text or click a node directly, the way password managers fill forms:
// no keyboard, no focus changes, no dropped keystrokes, no screen coordinates.
const fs = require('fs');
const path = require('path');
const http = require('http');
const { spawn } = require('child_process');
const cfg = require('./config');
const { adb, shell } = require('./adb');
const { freePort, sleep, log } = require('./util');

const DIR = path.join(cfg.ROOT, 'vendor', 'appium-uia2');
const PKG = 'io.appium.uiautomator2.server';
const TEST_PKG = 'io.appium.uiautomator2.server.test';
const DEVICE_PORT = 6790;
const ELEMENT_KEY = 'element-6066-11e4-a52f-4ca7cfdc0d48';

function apks() {
  try {
    const files = fs.readdirSync(DIR);
    const server = files.find((f) => /^appium-uiautomator2-server-v[\d.]+\.apk$/.test(f));
    const test = files.find((f) => /androidTest\.apk$/.test(f));
    return server && test ? { server: path.join(DIR, server), test: path.join(DIR, test) } : null;
  } catch {
    return null;
  }
}

const available = () => Boolean(cfg.FAST_FILL && apks());
const xq = (s) => (String(s).includes("'") ? `"${s}"` : `'${s}'`);

class A11y {
  constructor(serial) {
    this.serial = serial;
    this.ready = false;
    this.sid = null;
  }

  async start() {
    const files = apks();
    if (!files) throw new Error('helper APKs not found in vendor/appium-uia2');
    const { serial } = this;
    const installed = await shell(serial, `pm list packages ${PKG}`, { timeout: 15000 }).catch(() => '');
    if (!installed.includes(`package:${PKG}`) || !installed.includes(`package:${TEST_PKG}`)) {
      await adb(serial, ['install', '-r', '-g', '-t', files.server], { timeout: 180000 });
      await adb(serial, ['install', '-r', '-g', '-t', files.test], { timeout: 120000 });
    }
    await shell(serial, `am force-stop ${PKG}; am force-stop ${TEST_PKG}`, { timeout: 15000 }).catch(() => {});
    this.proc = spawn(cfg.ADB, ['-s', serial, 'shell', `am instrument -w -e disableAnalytics true ${TEST_PKG}/androidx.test.runner.AndroidJUnitRunner`], {
      windowsHide: true,
      stdio: 'ignore',
    });
    this.proc.on('exit', () => {
      this.ready = false;
    });
    this.port = await freePort();
    await adb(serial, ['forward', `tcp:${this.port}`, `tcp:${DEVICE_PORT}`]);
    const t0 = Date.now();
    for (;;) {
      if (Date.now() - t0 > 30000) throw new Error('helper did not start');
      const ok = await this.req('GET', '/status', null, 2000).then(() => true, () => false);
      if (ok) break;
      await sleep(400);
    }
    const created = await this.req('POST', '/session', { capabilities: { firstMatch: [{}], alwaysMatch: { platformName: 'Android' } } }, 30000);
    this.sid = created.sessionId || (created.value && created.value.sessionId);
    if (!this.sid) throw new Error('helper session was not created');
    // Read the screen right away instead of waiting for animations to finish.
    await this.call('POST', '/appium/settings', { settings: { waitForIdleTimeout: 0, waitForSelectorTimeout: 0, actionAcknowledgmentTimeout: 0 } }).catch(() => {});
    this.ready = true;
    log('a11y', `${serial} helper ready in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
  }

  req(method, p, body, timeout = 10000) {
    return new Promise((resolve, reject) => {
      const data = body ? Buffer.from(JSON.stringify(body)) : null;
      const r = http.request(
        { host: '127.0.0.1', port: this.port, path: p, method, timeout, headers: data ? { 'Content-Type': 'application/json', 'Content-Length': data.length } : {} },
        (res) => {
          const chunks = [];
          res.on('data', (c) => chunks.push(c));
          res.on('end', () => {
            let json = {};
            try {
              json = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
            } catch {}
            if (res.statusCode >= 400 || (json.value && json.value.error)) return reject(new Error((json.value && (json.value.message || json.value.error)) || `HTTP ${res.statusCode}`));
            resolve(json);
          });
        },
      );
      r.on('timeout', () => r.destroy(new Error('helper timed out')));
      r.on('error', reject);
      if (data) r.write(data);
      r.end();
    });
  }

  async call(method, p, body, timeout) {
    if (!this.sid) throw new Error('helper not started');
    return (await this.req(method, `/session/${this.sid}${p}`, body, timeout)).value;
  }

  // Same kind of XML as `uiautomator dump`, but element tags are class names.
  async source() {
    return this.call('GET', '/source', null, 10000);
  }

  async find(xpath) {
    // The helper takes strategy/selector; W3C clients send using/value. Send both.
    const el = await this.call('POST', '/element', { strategy: 'xpath', selector: xpath, using: 'xpath', value: xpath }, 8000);
    return el && (el[ELEMENT_KEY] || el.ELEMENT);
  }

  // Locate a node seen in a screen read. Text fields by their order on screen (a keyboard sliding up moves
  // them but does not reorder them), buttons by their label, anything else by its exact bounds.
  xpathFor(node) {
    if (node.editable && node.ei) return `(//*[contains(@class,'EditText')])[${node.ei}]`;
    if (node.label && node.clickable) return `(//*[(@content-desc=${xq(node.label)} or @text=${xq(node.label)}) and @clickable='true'])[1]`;
    return `//*[@bounds=${xq(node.bounds)}${node.cls ? ` and @class=${xq(node.cls)}` : ''}]`;
  }

  // Instant fill: the whole value at once, like a password manager. Flutter only accepts it on a field that has
  // focus, and on a busy PC the app can take 1-2 s to move focus (a fixed short wait made this fail at random),
  // so wait until the field reports focus, then check it holds the value. Throws if it did not take, so the caller
  // can type instead. Measured: 12 of 12 fields correct, ~1-3 s each.
  async setText(node, text) {
    const id = await this.find(this.xpathFor(node));
    if (!id) throw new Error('field not found');
    const focused = async () => String(await this.call('GET', `/element/${id}/attribute/focused`, null, 5000)) === 'true';
    let ok = await focused();
    for (let round = 0; round < 2 && !ok; round++) {
      await this.call('POST', `/element/${id}/click`, {}, 10000).catch(() => {});
      for (const t0 = Date.now(); Date.now() - t0 < 2500 && !(ok = await focused()); ) await sleep(50);
    }
    if (!ok) throw new Error('the field did not take focus');
    await this.call('POST', `/element/${id}/value`, { text, replace: true }, 10000);
    const holds = (got) => (node.password ? got.length === text.length : got === text);
    for (let i = 0; i < 15; i++) {
      const got = await this.call('GET', `/element/${id}/text`, null, 5000);
      if (holds(typeof got === 'string' ? got : '')) return;
      await sleep(100);
    }
    throw new Error('the field did not take the value');
  }

  async click(node) {
    const id = await this.find(this.xpathFor(node));
    if (!id) throw new Error('button not found');
    await this.call('POST', `/element/${id}/click`, {}, 10000);
  }

  // Whether a text field has focus and what it holds right now. Password fields read as one dot per
  // character, so their length can be checked.
  async fieldState(node) {
    const id = await this.find(this.xpathFor(node));
    if (!id) throw new Error('field not found');
    const focused = await this.call('GET', `/element/${id}/attribute/focused`, null, 5000);
    const text = await this.call('GET', `/element/${id}/text`, null, 5000);
    return { focused: String(focused) === 'true', text: typeof text === 'string' ? text : '' };
  }

  stop() {
    this.ready = false;
    if (this.proc && this.proc.exitCode === null) this.proc.kill();
    if (this.port) adb(this.serial, ['forward', '--remove', `tcp:${this.port}`]).catch(() => {});
  }
}

module.exports = { A11y, available };
