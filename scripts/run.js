// Runs the Android Emulator Online server and starts it again within a second if it ever stops unexpectedly. Phones and sessions
// survive server restarts, so visitors only see a brief "Reconnecting".   npm start
const path = require('path');
const { spawn } = require('child_process');

const server = path.join(__dirname, '..', 'server', 'index.js');
let child = null;
let stopping = false;
let restarts = [];

function start() {
  child = spawn(process.execPath, [server, ...process.argv.slice(2)], { stdio: 'inherit' });
  child.on('exit', (code, signal) => {
    if (stopping) return process.exit(code || 0);
    const now = Date.now();
    restarts = restarts.filter((t) => now - t < 60000).concat(now);
    const wait = restarts.length > 5 ? 10000 : 1000; // back off if it keeps failing
    console.log(`${new Date().toISOString().slice(11, 19)} [watcher] server stopped (${signal || `code ${code}`}); starting it again in ${wait / 1000}s`);
    setTimeout(start, wait);
  });
}

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    stopping = true;
    if (child) child.kill(sig);
    else process.exit(0);
  });
}

start();
