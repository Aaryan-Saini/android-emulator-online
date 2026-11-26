// Signs in to an app on the phone the way a person would: it reads the screen (uiautomator), taps through
// intro screens and permission prompts, types each saved value into the matching field, and presses the
// app's own button. Values are typed in the order the account lists them; secret values (passwords) only
// ever go into password fields, plain values only into normal text fields.
//
// Speed: taps and typing go through the already-open scrcpy control channel (`io`), waits end as soon as the
// screen stops changing, and the on-screen keyboard is switched off so every field on a screen is filled from
// a single read of the screen (reading the screen is the slow part, about 2 s).
const { shell } = require('./adb');
const { sleep } = require('./util');

const SYSTEM_PACKAGES = /^(android|com\.android\.settings|com\.android\.permissioncontroller|com\.google\.android\.permissioncontroller|com\.android\.systemui)$/;
// Buttons that move past intro, consent and welcome screens.
const ADVANCE = /^(allow|ok|okay|got it|continue|i understand.*|.*continue$|i agree|agree|agree and continue|accept|accept all|accept & continue|get started|start|next|skip|let'?s go|proceed|understood|sign ?in|log ?in|login|i already have an account|already have an account.*)$/i;
// Buttons that submit a form.
const SUBMIT = /^(sign ?in|log ?in|login|continue|next|submit|proceed|verify|done|go|enter|confirm|sign me in|log me in)$/i;
// Tabs/links that switch a sign-in screen from one-time codes to a password.
const PASSWORD_MODE = /^((log ?in|sign ?in) (with|using|via) password|use (a |your )?password( instead)?|password( log ?in| sign ?in)?|with password)$/i;
// Text that means the app rejected what was typed.
const ERROR_TEXT = /invalid|incorrect|wrong|doesn.?t match|don.?t match|not match|not found|no account|not recogni[sz]ed|failed|error|try again|unable|not valid|expired|locked|disabled/i;
// Never press these, whatever else matches.
const NEVER = /google|apple|facebook|microsoft|github|twitter|forgot|reset|otp|register|sign ?up|create|new account|show|hide|terms|privacy|policy|help|cancel|deny|don.?t|not now|no thanks|later|close|delete|remove|logout|log ?out|sign ?out/i;

function parseNodes(xml) {
  const attr = (n, a) => {
    const m = n.match(new RegExp(`\\s${a}="([^"]*)"`));
    return m ? m[1].replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#10;/g, ' ').replace(/&lt;/g, '<').replace(/&gt;/g, '>') : '';
  };
  // `uiautomator dump` uses <node> tags; the accessibility helper uses class names as tags. Both carry bounds.
  return (xml.match(/<(?!hierarchy\b)[\w.$]+ [^>]*\bbounds="[^"]*"[^>]*>/g) || []).map((n) => {
    const b = (attr(n, 'bounds').match(/\d+/g) || [0, 0, 0, 0]).map(Number);
    const cls = attr(n, 'class');
    const label = (attr(n, 'text') || attr(n, 'content-desc')).replace(/\s+/g, ' ').trim();
    return {
      cls,
      pkg: attr(n, 'package'),
      id: attr(n, 'resource-id'),
      text: attr(n, 'text'),
      label,
      clean: label.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, ''),
      hint: attr(n, 'hint'),
      clickable: attr(n, 'clickable') === 'true',
      enabled: attr(n, 'enabled') !== 'false',
      password: attr(n, 'password') === 'true',
      editable: /EditText|AutoCompleteTextView/.test(cls),
      x: Math.round((b[0] + b[2]) / 2),
      y: Math.round((b[1] + b[3]) / 2),
      area: Math.max(0, b[2] - b[0]) * Math.max(0, b[3] - b[1]),
      bottom: b[3],
      bounds: attr(n, 'bounds'),
    };
  });
}

function parseHierarchy(xml) {
  const at = xml.indexOf('<hierarchy');
  if (at < 0) return null;
  const rotation = Number((xml.slice(at, at + 200).match(/rotation="(\d)"/) || [])[1] || 0);
  const all = parseNodes(xml.slice(at));
  // Number the text fields in document order (1-based), so the helper can find "the 2nd text field" even if the
  // keyboard has moved it. Counted before filtering, to match the helper's own XPath over the full tree.
  let ei = 0;
  for (const n of all) if (n.editable) n.ei = ++ei;
  const nodes = all.filter((n) => n.area > 0);
  return { nodes, rotation, pkg: nodes.length ? nodes[0].pkg : '' };
}

// Reads the screen: through the accessibility helper when it is running (~0.15 s), else `uiautomator dump` (~2 s).
async function readScreen(serial, a11y) {
  if (a11y && a11y.ready) {
    for (let i = 0; i < 3; i++) {
      const xml = await a11y.source().catch(() => null);
      const ui = xml && parseHierarchy(String(xml));
      if (ui && ui.nodes.length) return ui;
      await sleep(150);
    }
  }
  for (let i = 0; i < 5; i++) {
    const out = await shell(serial, 'uiautomator dump /sdcard/handset-ui.xml >/dev/null 2>&1; cat /sdcard/handset-ui.xml 2>/dev/null; rm -f /sdcard/handset-ui.xml', { timeout: 25000 }).catch(() => '');
    const ui = parseHierarchy(out);
    if (ui) return ui;
    await sleep(500); // usually "could not get idle state" while something animates
  }
  return null;
}

const shellQuote = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;

async function typeText(serial, text) {
  // `input text` turns "%s" into a space; type in chunks so long values do not hit argument limits.
  const escaped = String(text).replace(/ /g, '%s');
  for (let i = 0; i < escaped.length; i += 80) await shell(serial, `input text ${shellQuote(escaped.slice(i, i + 80))}`, { timeout: 20000 });
}

// Slow but always-available input through `adb shell input` (used when no video stream is open).
function adbIo(serial) {
  return {
    tap: (n) => shell(serial, `input tap ${n.x} ${n.y}`, { timeout: 10000 }),
    text: (v) => typeText(serial, v),
    clear: () => shell(serial, 'input keycombination 113 29; input keyevent 67', { timeout: 10000 }).catch(() => {}),
    key: (code) => shell(serial, `input keyevent ${code}`, { timeout: 10000 }),
    del: (n) => shell(serial, `input keyevent ${Array(Math.max(1, n)).fill(67).join(' ')}`, { timeout: 20000 }),
    settle: (min = 300, max = 1500) => sleep(Math.min(max, Math.max(min, 900))),
    hideKeyboard: async () => {
      if (await keyboardShown(serial)) {
        await shell(serial, 'input keyevent 4', { timeout: 10000 });
        await sleep(500);
      }
    },
  };
}

async function keyboardShown(serial) {
  const out = await shell(serial, 'dumpsys input_method | grep mInputShown', { timeout: 10000 }).catch(() => '');
  return /mInputShown=true/.test(out);
}

const permCache = new Map();
// Grants every runtime permission the app requests and exempts it from battery optimisation (one shell call
// after the first time), so no permission pop-ups slow the sign-in down.
async function grantEverything(serial, pkg) {
  let perms = permCache.get(pkg);
  if (!perms) {
    const dump = await shell(serial, `dumpsys package ${shellQuote(pkg)}`, { timeout: 20000 }).catch(() => '');
    perms = new Set();
    let inRequested = false;
    for (const line of dump.split(/\r?\n/)) {
      if (/^\s*requested permissions:/.test(line)) {
        inRequested = true;
        continue;
      }
      if (inRequested) {
        const m = line.match(/^\s+([\w.]+\.permission\.[\w.]+)/);
        if (m) perms.add(m[1]);
        else if (/^\s*\S.*:\s*$/.test(line) || !line.trim()) inRequested = false;
      }
    }
    perms = [...perms].filter((p) => /^[\w.]+$/.test(p));
    permCache.set(pkg, perms);
  }
  return [...perms.map((p) => `pm grant ${pkg} ${p} 2>/dev/null`), `dumpsys deviceidle whitelist +${pkg} >/dev/null 2>&1`].join('; ');
}

function systemAllowButton(ui) {
  const find = (suffix) => ui.nodes.find((n) => n.id.endsWith(suffix) && n.enabled);
  return (
    find(':id/permission_allow_foreground_only_button') ||
    find(':id/permission_allow_button') ||
    find(':id/permission_allow_one_time_button') ||
    (SYSTEM_PACKAGES.test(ui.pkg) ? find('android:id/button1') : null)
  );
}

const pressable = (n) => n.enabled && (n.clickable || /Button/.test(n.cls)) && n.clean && !NEVER.test(n.clean);

function findButton(ui, re, below = -1) {
  const matches = ui.nodes.filter((n) => pressable(n) && !n.editable && re.test(n.clean) && n.y > below);
  // The main call-to-action is normally the biggest matching button.
  matches.sort((a, b) => b.area - a.area);
  return matches[0] || null;
}

/**
 * Logged out, logged in, or can't tell? Used after restoring a saved sign-in.
 * loginTexts: labels seen on this app's sign-in screens before.
 */
async function looksSignedOut(serial, pkg, loginTexts = [], a11y = null) {
  const known = new Set(loginTexts);
  for (let i = 0; i < 3; i++) {
    const ui = await readScreen(serial, a11y);
    if (!ui) return null;
    if (ui.pkg && ui.pkg !== pkg && !SYSTEM_PACKAGES.test(ui.pkg)) return true; // app closed or crashed
    const inputs = ui.nodes.filter((n) => n.editable);
    if (inputs.some((n) => n.password)) return true;
    if (inputs.length && ui.nodes.filter((n) => n.label && known.has(n.label)).length >= 3) return true;
    const content = ui.nodes.filter((n) => n.label).length;
    if (content >= 3 || inputs.length) return false;
    await sleep(1200); // probably still a splash screen
  }
  return false;
}

/**
 * @param {object} o
 * @param {string} o.serial   device serial
 * @param {string} o.pkg      app package
 * @param {() => Promise<void>} o.prepare  signs the app out and opens it
 * @param {() => Promise<void>} o.launch   reopens the app if it was left
 * @param {{label:string,value:string,secret:boolean}[]} o.fields  values in the order the app asks for them
 * @param {object} [o.io]     fast input (tap/text/clear/key/settle); falls back to adb
 * @param {(step:string) => void} o.onStep  progress messages
 * @param {(labels:string[]) => void} [o.onLoginScreen]  called with the labels of each sign-in screen before typing
 * @param {() => boolean} o.cancelled
 * @returns {Promise<{ok:boolean, message:string}>}
 */
async function signIn({ serial, pkg, prepare, launch, fields, io, onStep, onLoginScreen, cancelled }) {
  io = io || adbIo(serial);
  const read = () => readScreen(serial, io.a11y);
  // Measured on a busy PC: the app can take over a second to move focus to a field and to take in typed keys.
  // Keys sent before focus moves land in the previous field (the start of a password ended up in the email), so
  // with the helper we wait until the field really has focus, and until it holds what was typed.
  // Returns the field's state ({ focused, text }) when the helper can read it, else null.
  const focusField = async (field, from) => {
    if (!(io.focus && (await io.focus(field).then(() => true, () => false)))) {
      await io.hideKeyboard();
      await io.tap(field, from);
      await sleep(250);
      return null;
    }
    if (!io.fieldState) return void (await sleep(250));
    let state = null;
    for (let round = 0; round < 2; round++) {
      const t0 = Date.now();
      while (Date.now() - t0 < 1500) {
        state = await io.fieldState(field).catch(() => null);
        if (!state || state.focused) return state;
        await sleep(60);
      }
      await io.focus(field).catch(() => {}); // the first click did not take: click again
    }
    return state;
  };
  const settleField = async (field, value, password) => {
    if (!io.fieldState) return;
    const t0 = Date.now();
    let last = null;
    let same = 0;
    while (Date.now() - t0 < 4000) {
      const s = await io.fieldState(field).catch(() => null);
      if (!s || (password ? s.text.length === value.length : s.text === value)) return;
      same = s.text === last ? same + 1 : 0;
      if (same >= 3) return; // stopped changing: the read-back below decides whether to retype
      last = s.text;
      await sleep(120);
    }
  };
  // Remove what a field holds: go to its end and delete exactly that many characters. (Select-all + Delete does
  // not clear fields in some apps, and a blind clear could hit the previous field.)
  const erase = async (count) => {
    if (count <= 0) return;
    await io.key(123); // end of the field
    await io.del(count);
  };
  // Fill a field: instantly through the accessibility helper (like a password manager), else type into it.
  const fill = async (field, value, from, password) => {
    if (io.setText && (await io.setText(field, value).then(() => true, () => false))) return;
    // Focus it through the helper when possible (found by its order, so a sliding keyboard can't make us miss),
    // otherwise close the keyboard and tap where the screen read says it is.
    const state = await focusField(field, from);
    if (state && state.focused) await erase(state.text.length);
    else if (!io.fieldState) await io.clear(); // no way to read the field: clear it the old way
    await io.text(value);
    await settleField(field, value, password);
  };
  // Press a button: click the element itself through the helper (no coordinates), else tap where it was.
  const press = async (node, from) => {
    if (io.click && (await io.click(node).then(() => true, () => false))) return;
    await io.hideKeyboard();
    await io.tap(node, from);
  };
  const plain = fields.filter((f) => !f.secret && f.value !== '');
  const secret = fields.filter((f) => f.secret && f.value !== '');
  const loginLabels = new Set();
  const st = { pi: 0, si: 0, typedPlain: [], screen: { typed: [], submitted: false, switched: false }, stuck: 0, advanced: 0, idle: 0, relaunched: 0, done: false, clearReads: 0 };
  const allUsed = () => st.pi >= plain.length && st.si >= secret.length;
  const check = () => {
    if (cancelled()) throw Object.assign(new Error('Sign-in was cancelled.'), { cancelled: true });
  };

  onStep('Signing out and opening the app');
  await prepare();
  check();
  // With the fast screen reader, look again almost immediately; the sign-in screen is filled as soon as it shows.
  await (io.a11y ? io.settle(120, 800) : io.settle(400, 2500));

  const deadline = Date.now() + 120000;
  while (Date.now() < deadline) {
    check();
    if (!io.a11y) await io.hideKeyboard(); // read the screen without the keyboard, so tap positions stay valid
    const ui = await read();
    check();
    if (!ui) {
      await sleep(500);
      continue;
    }

    // Permission prompts and system dialogs: allow, like a tester would.
    const allow = systemAllowButton(ui);
    if (allow) {
      onStep(`Allowing: ${(ui.nodes.find((n) => /permission_message|alertTitle/.test(n.id)) || {}).text || 'permission'}`);
      await press(allow, ui);
      await io.settle(250, 1500);
      continue;
    }
    if (ui.pkg && ui.pkg !== pkg) {
      if (SYSTEM_PACKAGES.test(ui.pkg)) {
        await io.key(4);
        await io.settle(250, 1500);
        continue;
      }
      if (st.relaunched++ >= 2) return { ok: false, message: `The app left to ${ui.pkg}. Finish signing in on the phone.` };
      await launch();
      await io.settle(400, 2500);
      continue;
    }

    const inputs = ui.nodes.filter((n) => n.editable && n.enabled).sort((a, b) => a.y - b.y);
    if (inputs.length) {
      st.clearReads = 0;
      st.idleSince = 0;
      // Still the screen we just submitted? Then the values we typed are still in its fields.
      if (st.screen.submitted) {
        const typedPlain = st.screen.typed.filter((t) => !t.secret).map((t) => t.value);
        const typedSecret = st.screen.typed.some((t) => t.secret);
        const same = inputs.some((n) => (n.password ? typedSecret && n.text !== '' : n.text !== '' && typedPlain.includes(n.text)));
        if (same) {
          const said = ui.nodes.find((n) => !n.editable && n.label.length > 8 && n.label.length < 200 && ERROR_TEXT.test(n.label));
          if (said || ++st.stuck >= 4) {
            const base = st.done ? 'Still on the sign-in screen.' : 'The app did not move past this screen.';
            return { ok: false, message: said ? `${base} The app says: “${said.label}”` : `${base} Check the saved details for this account.` };
          }
          await io.settle(300, 1500);
          continue;
        }
        st.screen = { typed: [], submitted: false, switched: false };
        st.stuck = 0;
      }
      // After the last step: a screen that holds something typed earlier, or that looks like a sign-in screen we
      // already filled in (the app may clear its fields after rejecting them), means the sign-in did not work.
      if (st.done && !st.screen.typed.length) {
        const backWithValues = inputs.some((n) => n.text !== '' && st.typedPlain.includes(n.text));
        const overlap = ui.nodes.filter((n) => n.label && loginLabels.has(n.label)).length;
        if (backWithValues || overlap >= 3 || (inputs.some((n) => n.password) && overlap >= 1)) {
          const said = ui.nodes.find((n) => !n.editable && n.label.length > 8 && n.label.length < 200 && ERROR_TEXT.test(n.label));
          return { ok: false, message: `Still on the sign-in screen.${said ? ` The app says: “${said.label}”` : ' Check the saved details for this account.'}` };
        }
        // A different screen with a text field: signed in (e.g. a dashboard with a search box), unless it asks for a code.
        const wantsCode = ui.nodes.some((n) => /\b(otp|one.?time|verification code|enter (the )?code|2fa|two.?factor)\b/i.test(n.label || n.hint));
        return { ok: true, message: wantsCode ? 'Signed in, but the app now asks for a one-time code. Finish that on the phone.' : '' };
      }

      // A password is saved but this screen has no password field: switch to the app's password sign-in if offered
      // (e.g. "Login with Password" next to "Login with OTP").
      if (st.si < secret.length && !inputs.some((n) => n.password) && !st.screen.switched && !st.screen.typed.length) {
        const usePassword = ui.nodes.find((n) => n.enabled && n.clickable && PASSWORD_MODE.test(n.clean) && !/forgot|reset/i.test(n.clean));
        if (usePassword) {
          st.screen.switched = true;
          onStep(`Tapping “${usePassword.clean}”`);
          await press(usePassword, ui);
          await io.settle(300, 1500);
          continue;
        }
      }

      // Fill every empty field we have a value for, all from this one read (the keyboard is off, so nothing moves).
      if (!st.screen.typed.length) {
        const labels = ui.nodes.map((n) => n.label).filter(Boolean);
        labels.forEach((l) => loginLabels.add(l));
        // Waited for: it may snapshot the signed-out app, which must finish before anything is filled in.
        if (onLoginScreen) await onLoginScreen(labels);
      }
      let typedNow = 0;
      const filled = [];
      for (const [index, target] of inputs.entries()) {
        if (target.text !== '') continue;
        const value = target.password ? secret[st.si] : plain[st.pi];
        if (!value) continue;
        check();
        onStep(`Entering ${value.label.toLowerCase()}`);
        await fill(target, value.value, ui, target.password);
        if (target.password) st.si++;
        else {
          st.pi++;
          st.typedPlain.push(value.value);
        }
        st.screen.typed.push({ value: value.value, secret: target.password });
        filled.push({ index, value: value.value, password: target.password, label: value.label });
        typedNow++;
      }

      // Read the fields back before submitting; retype any that lost keystrokes (passwords: compare the length).
      let current = ui;
      for (let attempt = 0; filled.length && attempt < 2; attempt++) {
        if (!io.a11y) await io.hideKeyboard();
        const back = await read();
        if (!back) break;
        const now = back.nodes.filter((n) => n.editable && n.enabled).sort((a, b) => a.y - b.y);
        if (now.length !== inputs.length) break; // the screen changed under us; carry on
        current = back;
        // Match fields by their order in the screen tree (stable even if the keyboard moved them).
        const fieldOf = (f) => now.find((n) => n.ei && n.ei === inputs[f.index].ei) || now[f.index];
        const wrong = filled.filter((f) => {
          const n = fieldOf(f);
          return f.password ? n.text.length !== f.value.length : n.text !== f.value;
        });
        if (!wrong.length) break;
        for (const f of wrong) {
          check();
          const field = fieldOf(f);
          onStep(`Retyping ${f.label.toLowerCase()}`);
          if (io.setText && (await io.setText(field, f.value).then(() => true, () => false))) continue;
          const state = await focusField(field, back);
          if (state && !state.focused) continue; // could not focus it; the next read-back tries again
          await erase((state ? state.text.length : field.text.length) + (state ? 0 : 4));
          await io.text(f.value);
          await settleField(field, f.value, f.password);
        }
      }
      if (!st.screen.typed.length) {
        const target = inputs.find((n) => n.text === '');
        const what = !target ? 'details that are already filled in' : target.password ? 'a password' : `“${target.hint || 'a value'}”`;
        return { ok: false, message: `The app asks for ${what}, but this account has no more saved values for that kind of field.` };
      }

      // Press the app's button (positions from a keyboard-free read), or Enter.
      const last = inputs[inputs.length - 1];
      const button = findButton(current, SUBMIT, last.y) || findButton(current, SUBMIT);
      onStep(allUsed() ? 'Signing in' : 'Continuing');
      if (typedNow && !io.setText) await sleep(120); // let the app register the last keystrokes
      if (button) await press(button, current);
      else {
        await press(last, current);
        await io.key(66);
      }
      st.screen.submitted = true;
      st.stuck = 0;
      if (allUsed()) st.done = true;
      await io.settle(700, 4000);
      continue;
    }

    // No text fields on screen.
    if (st.done) {
      // Make sure the form is really gone, not just behind a loading screen.
      if (++st.clearReads >= 2 || ui.nodes.filter((n) => n.label).length >= 4) return { ok: true, message: '' };
      await io.settle(400, 1500);
      continue;
    }
    const next = st.advanced < 12 ? findButton(ui, ADVANCE) : null;
    if (next) {
      st.idleSince = 0; // acting on a screen: restart the "waiting for the app" clock
      onStep(`Tapping “${next.clean}”`);
      st.advanced++;
      await press(next, ui);
      await io.settle(300, 2000);
      continue;
    }
    if (!st.idleSince) st.idleSince = Date.now();
    if (Date.now() - st.idleSince > 30000) return { ok: false, message: 'Could not find a sign-in screen in this app. Sign in on the phone instead.' };
    onStep('Waiting for the app');
    await (io.a11y ? io.settle(120, 400) : io.settle(500, 1500));
  }
  return { ok: false, message: 'Signing in took too long. Finish it on the phone.' };
}

module.exports = { signIn, typeText, readScreen, looksSignedOut, grantEverything, shellQuote, keyboardShown, parseHierarchy };
