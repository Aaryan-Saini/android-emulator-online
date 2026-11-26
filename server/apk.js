// Reads app metadata and the launcher icon out of APKs, and unpacks .apks/.xapk bundles.
const fs = require('fs');
const path = require('path');
const { AAPT2 } = require('./config');
const { run } = require('./util');
const { Zip } = require('./zip');

async function aapt(args) {
  if (!AAPT2) throw new Error('aapt2 not found. Install Android SDK build-tools.');
  try {
    return (await run(AAPT2, args, { timeout: 120000 })).stdout;
  } catch (e) {
    // aapt2 sometimes exits non-zero on odd resources but still prints what we need.
    if (e.stdout && e.stdout.length) return e.stdout;
    throw new Error(`Could not read the APK (${(e.stderr || e.message).trim().split('\n')[0]})`);
  }
}

const q = (line, key) => {
  const m = line.match(new RegExp(`${key}='([^']*)'`));
  return m ? m[1] : null;
};

async function badging(apk) {
  const out = await aapt(['dump', 'badging', apk]);
  const lines = out.split(/\r?\n/);
  const info = { icons: [], abis: [], split: null };
  for (const line of lines) {
    if (line.startsWith('package:')) {
      info.package = q(line, 'name');
      info.versionCode = q(line, 'versionCode');
      info.versionName = q(line, 'versionName');
      info.split = q(line, 'split');
    } else if (line.startsWith('application-label:')) {
      info.label = line.slice(line.indexOf(':') + 1).replace(/^'|'$/g, '');
    } else if (!info.labelAny && line.startsWith('application-label-')) {
      info.labelAny = line.slice(line.indexOf(':') + 1).replace(/^'|'$/g, '');
    } else if (line.startsWith('application:')) {
      info.appLabel = q(line, 'label');
      info.icon = q(line, 'icon');
    } else if (line.startsWith('application-icon-')) {
      const m = line.match(/^application-icon-(\d+):'([^']*)'/);
      if (m) info.icons.push({ density: Number(m[1]), path: m[2] });
    } else if (line.startsWith('launchable-activity:') && !info.activity) {
      info.activity = q(line, 'name');
    } else if (line.startsWith('sdkVersion:')) {
      info.minSdk = Number(line.split("'")[1]);
    } else if (line.startsWith('targetSdkVersion:')) {
      info.targetSdk = Number(line.split("'")[1]);
    } else if (line.startsWith('native-code:')) {
      info.abis = [...line.matchAll(/'([^']+)'/g)].map((m) => m[1]);
    }
  }
  if (!info.package) throw new Error('This file does not look like an Android app (no package name found).');
  info.name = info.label || info.appLabel || info.labelAny || info.package;
  return info;
}

// ---------- icons ----------

const DENSITY = ['ldpi', 'mdpi', 'tvdpi', 'hdpi', 'xhdpi', 'xxhdpi', 'xxxhdpi'];
function densityRank(config) {
  if (/night/.test(config)) return -1;
  const m = config.match(/(xxxhdpi|xxhdpi|xhdpi|tvdpi|hdpi|mdpi|ldpi|nodpi)/);
  if (!m) return config.trim() === '' ? 0.5 : 0;
  return m[1] === 'nodpi' ? 3 : DENSITY.indexOf(m[1]) + 1;
}
const isRaster = (p) => /\.(png|webp|jpe?g)$/i.test(p || '');

async function resources(apk) {
  const out = await aapt(['dump', 'resources', apk]);
  const byId = new Map();
  const byName = new Map();
  let cur = null;
  for (const line of out.split(/\r?\n/)) {
    const r = line.match(/^\s+resource (0x[0-9a-f]+) (\S+)/);
    if (r) {
      cur = { id: r[1], name: r[2], values: [] };
      byId.set(cur.id, cur);
      byName.set(cur.name, cur);
      continue;
    }
    const v = cur && line.match(/^\s+\(([^)]*)\) (.*)$/);
    if (v) {
      const value = v[2].trim();
      const file = value.match(/^\(file\) (\S+)/);
      cur.values.push({ config: v[1], file: file ? file[1] : null, value });
    } else if (/^\s*type /.test(line)) cur = null;
  }
  return { byId, byName };
}

function argbToCss(hex) {
  const h = hex.replace('#', '');
  if (h.length === 8) {
    const a = parseInt(h.slice(0, 2), 16) / 255;
    return `rgba(${parseInt(h.slice(2, 4), 16)}, ${parseInt(h.slice(4, 6), 16)}, ${parseInt(h.slice(6, 8), 16)}, ${a.toFixed(3)})`;
  }
  return `#${h}`;
}

function resolveRef(res, ref, depth = 0) {
  if (!ref || depth > 4) return null;
  if (/^#[0-9a-f]{6,8}$/i.test(ref)) return { color: argbToCss(ref) };
  const target = ref.startsWith('@0x') ? res.byId.get(ref.slice(1)) : res.byName.get(ref.replace(/^@/, ''));
  if (!target) return null;
  const rasters = target.values.filter((v) => isRaster(v.file)).sort((a, b) => densityRank(b.config) - densityRank(a.config));
  if (rasters.length) return { file: rasters[0].file };
  for (const v of target.values) {
    if (/^#[0-9a-f]{6,8}$/i.test(v.value)) return { color: argbToCss(v.value) };
    if (v.value.startsWith('@')) {
      const inner = resolveRef(res, v.value.split(/\s/)[0], depth + 1);
      if (inner) return inner;
    }
  }
  const xml = target.values.find((v) => v.file && v.file.endsWith('.xml'));
  return xml ? { xml: xml.file } : null;
}

// Parses `aapt2 dump xmltree` of an <adaptive-icon> into its background and foreground layers.
async function adaptiveLayers(apk, xmlPath) {
  const out = await aapt(['dump', 'xmltree', '--file', xmlPath, apk]);
  if (!/E: adaptive-icon/.test(out)) return null;
  const layers = {};
  let layer = null;
  for (const line of out.split(/\r?\n/)) {
    const e = line.match(/^\s*E: (background|foreground|monochrome)\b/);
    if (e) { layer = e[1]; layers[layer] = {}; continue; }
    if (!layer) continue;
    const d = line.match(/:drawable\([^)]*\)=(@0x[0-9a-f]+|#[0-9a-f]{6,8})/i);
    if (d && !layers[layer].ref) layers[layer].ref = d[1];
    const inset = line.match(/:inset\([^)]*\)=([\d.]+)/);
    if (inset) {
      const v = Number(inset[1]);
      layers[layer].inset = v < 1 ? v : v / 100;
    }
  }
  return layers;
}

async function extractIcon(apk, info, outDir) {
  const iconPath = info.icon || (info.icons.sort((a, b) => b.density - a.density)[0] || {}).path;
  if (!iconPath) return null;
  const zip = await Zip.open(apk);
  const save = async (file, name) => {
    const data = await zip.read(file);
    if (!data) return null;
    const out = `${name}${path.extname(file).toLowerCase()}`;
    await fs.promises.writeFile(path.join(outDir, out), data);
    return out;
  };
  try {
    if (isRaster(iconPath)) {
      const best = info.icons.filter((i) => isRaster(i.path)).sort((a, b) => b.density - a.density)[0];
      const file = await save(best ? best.path : iconPath, 'icon');
      return file ? { kind: 'image', file } : null;
    }
    const res = await resources(apk);
    const owner = [...res.byId.values()].find((r) => r.values.some((v) => v.file === iconPath));
    const layers = await adaptiveLayers(apk, iconPath).catch(() => null);
    if (layers && layers.foreground) {
      const fg = resolveRef(res, layers.foreground.ref);
      const bg = layers.background ? resolveRef(res, layers.background.ref) : null;
      if (fg && fg.file) {
        const icon = { kind: 'adaptive', fg: { file: await save(fg.file, 'icon-fg'), inset: layers.foreground.inset || 0 } };
        if (bg && bg.file) icon.bg = { file: await save(bg.file, 'icon-bg') };
        else if (bg && bg.color) icon.bg = { color: bg.color };
        else icon.bg = { color: '#ffffff' };
        if (icon.fg.file) return icon;
      }
    }
    // Pre-Android-8 style icon at another density of the same resource.
    if (owner) {
      const raster = owner.values.filter((v) => isRaster(v.file)).sort((a, b) => densityRank(b.config) - densityRank(a.config))[0];
      if (raster) return { kind: 'image', file: await save(raster.file, 'icon') };
    }
    const legacy = res.byName.get('mipmap/ic_launcher') || res.byName.get('drawable/ic_launcher');
    const r = legacy && resolveRef(res, `@${legacy.name}`);
    if (r && r.file) return { kind: 'image', file: await save(r.file, 'icon') };
    return null;
  } finally {
    await zip.close();
  }
}

// ---------- bundles (.apks / .xapk / .apkm) ----------

const ABI_SPLIT = /(?:^|[._-])(arm64_v8a|armeabi_v7a|armeabi|x86_64|x86|mips64|mips)(?:[._-]|$)/;

// Extracts every APK inside a bundle into `dir`, keeps only the ABI splits this emulator can run,
// and returns { base, files } with file names relative to dir.
async function unpackBundle(bundle, dir) {
  const zip = await Zip.open(bundle);
  const names = [];
  try {
    const apks = [...zip.entries.keys()].filter((n) => n.toLowerCase().endsWith('.apk') && !n.startsWith('standalones/') && !n.endsWith('/'));
    if (!apks.length) throw new Error('No APK files were found inside this bundle.');
    for (const entry of apks) {
      const safe = path.basename(entry).replace(/[^\w.-]/g, '_');
      let name = safe;
      for (let i = 2; names.includes(name); i++) name = `${i}-${safe}`;
      await zip.extract(entry, path.join(dir, name));
      names.push(name);
    }
  } finally {
    await zip.close();
  }

  const parts = [];
  for (const name of names) {
    const info = await badging(path.join(dir, name)).catch(() => null);
    if (info) parts.push({ name, info });
  }
  const base = parts.find((p) => !p.info.split) || parts.find((p) => p.info.activity);
  if (!base) throw new Error('Could not find the base APK inside this bundle.');

  // Prefer native x86_64 code; fall back to arm64 (runs through the emulator's ARM translation).
  const abiOf = (p) => { const m = (p.info.split || '').match(ABI_SPLIT); return m ? m[1] : null; };
  const abiParts = parts.filter((p) => p !== base && abiOf(p));
  const keepAbi = ['x86_64', 'arm64_v8a'].find((a) => abiParts.some((p) => abiOf(p) === a));
  const files = [base.name];
  for (const p of parts) {
    if (p === base || p.info.package !== base.info.package) continue;
    const abi = abiOf(p);
    if (abi && abi !== keepAbi) continue;
    files.push(p.name);
  }
  for (const name of names) if (!files.includes(name)) await fs.promises.unlink(path.join(dir, name)).catch(() => {});
  return { base: base.name, info: base.info, files };
}

module.exports = { badging, extractIcon, unpackBundle };
