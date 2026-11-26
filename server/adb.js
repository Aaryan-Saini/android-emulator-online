const { ADB } = require('./config');
const { run } = require('./util');

const adb = (serial, args, opts) => run(ADB, serial ? ['-s', serial, ...args] : args, opts);
const shell = async (serial, cmd, opts) => (await adb(serial, ['shell', cmd], opts)).stdout;

async function screencap(serial) {
  const { stdout } = await adb(serial, ['exec-out', 'screencap', '-p'], { encoding: 'buffer', timeout: 15000 });
  return stdout;
}

module.exports = { adb, shell, screencap };
