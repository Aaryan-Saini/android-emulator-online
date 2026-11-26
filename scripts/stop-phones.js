// Stops every Handset phone. Phones keep running when the server stops (so restarts don't end sessions);
// run this when you want them gone:  npm run stop-phones
const fs = require('fs');
const path = require('path');
const cfg = require('../server/config');
const { adb } = require('../server/adb');

(async () => {
  let n = 0;
  for (let slot = 0; slot < Math.max(cfg.MAX_DEVICES, 8); slot++) {
    const serial = `emulator-${cfg.BASE_PORT + slot * 2}`;
    const r = await adb(serial, ['emu', 'kill'], { timeout: 5000 }).catch(() => null);
    if (r) {
      n++;
      console.log(`stopped ${serial}`);
    }
  }
  for (const f of ['devices.json', 'sessions.json']) fs.rmSync(path.join(cfg.DATA, f), { force: true });
  console.log(n ? `Stopped ${n} phone(s).` : 'No Handset phones were running.');
})();
