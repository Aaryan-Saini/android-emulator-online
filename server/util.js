const crypto = require('crypto');
const net = require('net');
const { execFile } = require('child_process');

function run(file, args, { timeout = 60000, encoding = 'utf8', maxBuffer = 256 * 1024 * 1024 } = {}) {
  return new Promise((resolve, reject) => {
    execFile(file, args, { timeout, encoding, maxBuffer, windowsHide: true }, (err, stdout, stderr) => {
      if (err) {
        err.stdout = stdout;
        err.stderr = stderr;
        return reject(err);
      }
      resolve({ stdout, stderr });
    });
  });
}

const newId = (bytes = 9) => crypto.randomBytes(bytes).toString('base64url');
const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.unref();
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

function log(scope, ...args) {
  const t = new Date().toISOString().slice(11, 19);
  console.log(`${t} [${scope}]`, ...args);
}

module.exports = { run, newId, sha256, sleep, freePort, log };
