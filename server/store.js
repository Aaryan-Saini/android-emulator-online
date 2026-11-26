// Uploaded apps live in data/apps/<id>/ with a meta.json next to the APK files.
const fs = require('fs');
const path = require('path');
const { pipeline } = require('stream/promises');
const { Transform } = require('stream');
const { APPS_DIR, MAX_UPLOAD_MB } = require('./config');
const { newId, sha256, log } = require('./util');
const apk = require('./apk');

fs.mkdirSync(APPS_DIR, { recursive: true });

const ACCEPTED = ['.apk', '.apks', '.xapk', '.apkm'];
const cache = new Map();

const dirOf = (id) => path.join(APPS_DIR, id);
const validId = (id) => typeof id === 'string' && /^[\w-]{6,40}$/.test(id);

function get(id) {
  if (!validId(id)) return null;
  if (cache.has(id)) return cache.get(id);
  try {
    const meta = JSON.parse(fs.readFileSync(path.join(dirOf(id), 'meta.json'), 'utf8'));
    cache.set(id, meta);
    return meta;
  } catch {
    return null;
  }
}

function save(meta) {
  cache.set(meta.id, meta);
  fs.writeFileSync(path.join(dirOf(meta.id), 'meta.json'), JSON.stringify(meta, null, 2));
}

function publicView(meta) {
  if (!meta) return null;
  const { ownerHash, files, accounts: _accounts, loginTexts: _loginTexts, fillMode: _fillMode, ...rest } = meta;
  const base = `/api/apps/${meta.id}/files/`;
  let icon = null;
  if (meta.icon && meta.icon.kind === 'image') icon = { kind: 'image', url: base + meta.icon.file };
  if (meta.icon && meta.icon.kind === 'adaptive') {
    icon = {
      kind: 'adaptive',
      fg: { url: base + meta.icon.fg.file, inset: meta.icon.fg.inset },
      bg: meta.icon.bg.file ? { url: base + meta.icon.bg.file } : { color: meta.icon.bg.color },
    };
  }
  // Accounts are listed without passwords: anyone with the link can sign in as a role, but only the person
  // who uploaded the app can see or change the passwords.
  const accounts = (meta.accounts || []).map(normalizeAccount).map((a) => ({
    id: a.id,
    name: a.label || a.username || 'Account',
    username: a.username,
    hasPassword: Boolean(a.password),
    extras: a.extras.map((e) => e.label || 'Extra step'),
  }));
  return { ...rest, accounts, icon, screenshot: meta.shotAt ? `${base}screenshot.png?v=${meta.shotAt}` : null };
}

// An account is: a name, a username, a password, and optional extra values the app asks for before the
// username (like an organisation code). Older saves stored a generic list of fields; convert those.
function normalizeAccount(a) {
  if (Array.isArray(a.fields) && a.username === undefined) {
    const plain = a.fields.filter((f) => !f.secret && f.value);
    const secret = a.fields.find((f) => f.secret && f.value);
    let ui = plain.findIndex((f) => /e-?mail|user|login|phone|mobile/i.test(f.label) || f.value.includes('@'));
    if (ui < 0) ui = plain.length - 1;
    return {
      id: a.id,
      label: a.label || '',
      username: ui >= 0 ? plain[ui].value : '',
      password: secret ? secret.value : '',
      extras: plain.filter((_, i) => i !== ui).map((f) => ({ label: f.label, value: f.value })),
    };
  }
  return {
    id: a.id,
    label: a.label || '',
    username: a.username || '',
    password: a.password || '',
    extras: (a.extras || []).map((e) => ({ label: e.label || '', value: e.value || '' })),
  };
}

// What the sign-in automation types, in order.
function signInFields(a) {
  return [
    ...a.extras.filter((e) => e.value).map((e) => ({ label: e.label || 'code', value: e.value, secret: false })),
    ...(a.username ? [{ label: 'Username', value: a.username, secret: false }] : []),
    ...(a.password ? [{ label: 'Password', value: a.password, secret: true }] : []),
  ];
}

const isOwner = (meta, ownerKey) => Boolean(meta && ownerKey && sha256(ownerKey) === meta.ownerHash);

// `admin`: the request comes from the PC Handset runs on (see localAdmin in index.js), which may manage every app.
function requireOwner(meta, ownerKey, admin = false) {
  if (meta && admin) return;
  if (!isOwner(meta, ownerKey)) throw Object.assign(new Error('Only the person who uploaded this app can change its accounts.'), { status: 403 });
}

function ownerAccounts(id, ownerKey, { admin = false } = {}) {
  const meta = get(id);
  requireOwner(meta, ownerKey, admin);
  return (meta.accounts || []).map(normalizeAccount);
}

function setAccounts(id, ownerKey, input, { admin = false } = {}) {
  const meta = get(id);
  requireOwner(meta, ownerKey, admin);
  if (!Array.isArray(input) || input.length > 30) throw Object.assign(new Error('Send up to 30 accounts.'), { status: 400 });
  const str = (v, max) => String(v === undefined || v === null ? '' : v).slice(0, max);
  const accounts = input.map((a, i) => {
    const acc = {
      id: a && typeof a.id === 'string' && /^[\w-]{4,40}$/.test(a.id) ? a.id : newId(6),
      label: str(a && a.label, 40).trim(),
      username: str(a && a.username, 200).trim(),
      password: str(a && a.password, 200),
      extras: (Array.isArray(a && a.extras) ? a.extras : [])
        .slice(0, 4)
        .map((e) => ({ label: str(e && e.label, 40).trim(), value: str(e && e.value, 200).trim() }))
        .filter((e) => e.label || e.value),
    };
    if (!acc.username && !acc.password) throw Object.assign(new Error(`Account ${i + 1}${acc.label ? ` (${acc.label})` : ''} needs a username or a password.`), { status: 400 });
    return acc;
  });
  meta.accounts = accounts;
  save(meta);
  removeStalestates(meta);
  log('apps', `${id}: saved ${accounts.length} account(s)`);
  return publicView(meta).accounts;
}

// Saved sign-ins (app data snapshots) live next to the app: data/apps/<id>/states/<account id>.tgz
function stateFile(appId, name) {
  return path.join(dirOf(appId), 'states', `${String(name).replace(/[^\w-]/g, '')}.tgz`);
}

function removeStalestates(meta) {
  const dir = path.join(dirOf(meta.id), 'states');
  const keep = new Set((meta.accounts || []).map((a) => `${a.id}.tgz`).concat('_baseline.tgz'));
  try {
    for (const f of fs.readdirSync(dir)) if (!keep.has(f)) fs.rmSync(path.join(dir, f), { force: true });
  } catch {}
}

// Labels seen on the app's sign-in screens, used to tell whether a restored sign-in was accepted.
function rememberLoginTexts(appId, labels) {
  const meta = get(appId);
  if (!meta) return;
  const set = new Set(meta.loginTexts || []);
  for (const l of labels) if (l && l.length < 80) set.add(l);
  const next = [...set].slice(-60);
  if (next.length === (meta.loginTexts || []).length) return;
  meta.loginTexts = next;
  save(meta);
}

function rememberFillMode(appId, mode) {
  const meta = get(appId);
  if (!meta || meta.fillMode === mode) return;
  meta.fillMode = mode;
  save(meta);
}

function account(meta, accountId) {
  const a = (meta.accounts || []).find((x) => x.id === accountId);
  if (!a) return null;
  const acc = normalizeAccount(a);
  return { ...acc, name: acc.label || acc.username || 'Account', fields: signInFields(acc) };
}

function sizeLimiter(max) {
  let seen = 0;
  return new Transform({
    transform(chunk, _enc, cb) {
      seen += chunk.length;
      if (seen > max) return cb(Object.assign(new Error(`File is larger than ${MAX_UPLOAD_MB} MB`), { status: 413 }));
      cb(null, chunk);
    },
  });
}

async function createFromUpload(req, fileName) {
  const ext = path.extname(fileName).toLowerCase();
  if (ext === '.aab') {
    throw Object.assign(new Error('.aab files cannot be installed directly. Build an APK (or a universal .apks with bundletool) and upload that.'), { status: 400 });
  }
  if (!ACCEPTED.includes(ext)) throw Object.assign(new Error('Upload an .apk, .apks or .xapk file.'), { status: 400 });
  const max = MAX_UPLOAD_MB * 1024 * 1024;
  if (Number(req.headers['content-length']) > max) throw Object.assign(new Error(`File is larger than ${MAX_UPLOAD_MB} MB`), { status: 413 });

  const id = newId(8);
  const dir = dirOf(id);
  fs.mkdirSync(dir, { recursive: true });
  const upload = path.join(dir, `upload${ext}`);
  try {
    await pipeline(req, sizeLimiter(max), fs.createWriteStream(upload));
    const head = Buffer.alloc(4);
    const fh = await fs.promises.open(upload, 'r');
    await fh.read(head, 0, 4, 0);
    await fh.close();
    if (head.readUInt32LE(0) !== 0x04034b50) throw Object.assign(new Error('This file is not a valid Android package.'), { status: 400 });

    let info;
    let files;
    let baseFile;
    if (ext === '.apk') {
      baseFile = 'base.apk';
      await fs.promises.rename(upload, path.join(dir, baseFile));
      info = await apk.badging(path.join(dir, baseFile));
      if (info.split) throw Object.assign(new Error('This APK is only one piece of a split app. Upload the full .apks or .xapk bundle instead.'), { status: 400 });
      files = [baseFile];
    } else {
      const bundle = await apk.unpackBundle(upload, dir);
      await fs.promises.unlink(upload);
      ({ info, files } = bundle);
      baseFile = bundle.base;
    }

    const icon = await apk.extractIcon(path.join(dir, baseFile), info, dir).catch((e) => {
      log('apk', `icon extraction failed for ${info.package}: ${e.message}`);
      return null;
    });
    let size = 0;
    for (const f of files) size += fs.statSync(path.join(dir, f)).size;

    const ownerKey = newId(18);
    const meta = {
      id,
      ownerHash: sha256(ownerKey),
      fileName: path.basename(fileName),
      name: info.name,
      package: info.package,
      versionName: info.versionName,
      versionCode: info.versionCode,
      minSdk: info.minSdk || null,
      targetSdk: info.targetSdk || null,
      abis: info.abis,
      activity: info.activity || null,
      files,
      size,
      icon,
      createdAt: Date.now(),
      shotAt: null,
    };
    save(meta);
    log('apps', `uploaded ${meta.name} (${meta.package} ${meta.versionName}) as ${id}`);
    return { app: publicView(meta), ownerKey };
  } catch (e) {
    fs.rmSync(dir, { recursive: true, force: true });
    throw e;
  }
}

function remove(id, ownerKey) {
  const meta = get(id);
  if (!meta) return false;
  if (!ownerKey || sha256(ownerKey) !== meta.ownerHash) throw Object.assign(new Error('Only the person who uploaded this app can delete it.'), { status: 403 });
  cache.delete(id);
  fs.rmSync(dirOf(id), { recursive: true, force: true });
  log('apps', `deleted ${id}`);
  return true;
}

function filePath(id, file) {
  const meta = get(id);
  if (!meta) return null;
  const allowed = new Set(['screenshot.png']);
  if (meta.icon) {
    if (meta.icon.file) allowed.add(meta.icon.file);
    if (meta.icon.fg && meta.icon.fg.file) allowed.add(meta.icon.fg.file);
    if (meta.icon.bg && meta.icon.bg.file) allowed.add(meta.icon.bg.file);
  }
  return allowed.has(file) ? path.join(dirOf(id), file) : null;
}

function saveScreenshot(id, png) {
  const meta = get(id);
  if (!meta || !png || png.length < 1000) return;
  fs.writeFileSync(path.join(dirOf(id), 'screenshot.png'), png);
  meta.shotAt = Date.now();
  save(meta);
}

const installFiles = (meta) => meta.files.map((f) => path.join(dirOf(meta.id), f));

module.exports = { get, publicView, createFromUpload, remove, filePath, saveScreenshot, installFiles, validId, ownerAccounts, setAccounts, account, stateFile, rememberLoginTexts, rememberFillMode };
