// Saves and restores an app's private data on a (rooted) phone, so a signed-in account can be brought back in a
// couple of seconds instead of typing the login again. Logging out also happens here: the app's files are
// removed but its keystore keys are kept, so states saved earlier on the same phone still decrypt.
const fs = require('fs');
const path = require('path');
const { adb, shell } = require('./adb');

const q = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;
const dirs = (pkg) => [`/data/data/${pkg}`, `/data/user_de/0/${pkg}`];
const KEEP = '! -name lib ! -name cache ! -name code_cache';
// Killing an app while it is drawing can crash the emulator's software graphics. Send it to the background
// first (it stops drawing), give it a moment, then force-stop it.
// `homeSent`: the caller already pressed Home through the video connection (instant), so skip the slow
// `input keyevent` program and only give the app a moment to stop drawing.
const STOP = (pkg, homeSent) => `${homeSent ? 'sleep 0.25' : 'input keyevent 3; sleep 0.4'}; am force-stop ${q(pkg)}`;

async function hasRoot(serial) {
  return (await shell(serial, 'id -u', { timeout: 10000 }).catch(() => '')).trim() === '0';
}

// Clear everything the app saved (logs it out) without touching its keystore keys.
async function wipe(serial, pkg, { homeSent = false } = {}) {
  const cmds = [STOP(pkg, homeSent), ...dirs(pkg).map((d) => `find ${q(d)} -mindepth 1 -maxdepth 1 ${KEEP} -exec rm -rf {} + 2>/dev/null`)];
  await shell(serial, cmds.join('; '), { timeout: 30000 });
}

async function save(serial, pkg, file) {
  const rel = dirs(pkg).map((d) => d.slice(1));
  const cmd = `cd / && tar -czf - --exclude=${q(`${rel[0]}/cache`)} --exclude=${q(`${rel[0]}/code_cache`)} ${rel.map(q).join(' ')} 2>/dev/null`;
  const { stdout } = await adb(serial, ['exec-out', cmd], { encoding: 'buffer', timeout: 120000, maxBuffer: 512 * 1024 * 1024 });
  if (!stdout || stdout.length < 64 || stdout[0] !== 0x1f) throw new Error('Could not read the app data');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(`${file}.tmp`, stdout);
  fs.renameSync(`${file}.tmp`, file);
  return stdout.length;
}

async function restore(serial, pkg, file, { homeSent = false } = {}) {
  const remote = '/data/local/tmp/handset-state.tgz';
  await adb(serial, ['push', file, remote], { timeout: 120000 });
  const [d0, d1] = dirs(pkg);
  await shell(
    serial,
    [
      STOP(pkg, homeSent),
      `uid=$(stat -c %u ${q(d0)})`,
      ...dirs(pkg).map((d) => `find ${q(d)} -mindepth 1 -maxdepth 1 ${KEEP} -exec rm -rf {} + 2>/dev/null`),
      `cd / && tar -xzf ${remote}`,
      `chown -R $uid:$uid ${q(d0)} ${q(d1)} 2>/dev/null`,
      `restorecon -RF ${q(d0)} ${q(d1)} 2>/dev/null`,
      `rm -f ${remote}`,
    ].join('; '),
    { timeout: 60000 },
  );
}

module.exports = { hasRoot, wipe, save, restore };
