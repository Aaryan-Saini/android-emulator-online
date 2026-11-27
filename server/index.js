const fs = require('fs');
const http = require('http');
const path = require('path');
const { WebSocketServer } = require('ws');
const cfg = require('./config');
const store = require('./store');
const { DevicePool } = require('./pool');
const { SessionManager } = require('./sessions');
const { screencap } = require('./adb');
const { log } = require('./util');

const pool = new DevicePool();
const sessions = new SessionManager(pool);

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json',
  '.png': 'image/png',
  '.webp': 'image/webp',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.woff2': 'font/woff2',
  '.ico': 'image/x-icon',
};
const FONT = path.join(cfg.ROOT, 'node_modules', '@fontsource-variable', 'geist', 'files', 'geist-latin-wght-normal.woff2');

function clientIp(req) {
  if (process.env.TRUST_PROXY && req.headers['x-forwarded-for']) return req.headers['x-forwarded-for'].split(',')[0].trim();
  return req.socket.remoteAddress;
}

// Someone using Android Emulator Online on the PC it runs on (http://localhost:PORT) may manage every app's accounts, from any
// browser. Visitors through a tunnel or reverse proxy also connect from this PC, so they are told apart by the
// address they typed (Host) and the forwarding headers those add; they still need the uploader's key.
function localAdmin(req) {
  if (!cfg.LOCAL_ADMIN) return false;
  if (!/^(127\.|::1$|::ffff:127\.)/.test(req.socket.remoteAddress || '')) return false;
  const h = req.headers;
  if (h['x-forwarded-for'] || h.forwarded || h['x-real-ip'] || h['cf-connecting-ip'] || h['x-forwarded-host']) return false;
  const host = String(h.host || '').toLowerCase().replace(/:\d+$/, '');
  return host === 'localhost' || host === '127.0.0.1' || host === '[::1]';
}

function json(res, status, body) {
  const data = JSON.stringify(body);
  res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
  res.end(data);
}

function readJson(req, limit = 256 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) {
        reject(Object.assign(new Error('Request is too large'), { status: 413 }));
        req.destroy();
      } else chunks.push(c);
    });
    req.on('end', () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'));
      } catch {
        reject(Object.assign(new Error('Invalid JSON'), { status: 400 }));
      }
    });
    req.on('error', reject);
  });
}

function sendFile(res, file, { cache = 'no-cache', download } = {}) {
  fs.stat(file, (err, st) => {
    if (err || !st.isFile()) return json(res, 404, { error: 'Not found' });
    const headers = { 'Content-Type': TYPES[path.extname(file).toLowerCase()] || 'application/octet-stream', 'Content-Length': st.size, 'Cache-Control': cache };
    if (download) headers['Content-Disposition'] = `attachment; filename="${download}"`;
    res.writeHead(200, headers);
    fs.createReadStream(file).pipe(res);
  });
}

function serveStatic(res, rel) {
  const file = path.resolve(cfg.PUBLIC_DIR, `.${rel}`);
  if (!file.startsWith(cfg.PUBLIC_DIR + path.sep)) return json(res, 404, { error: 'Not found' });
  sendFile(res, file);
}

async function route(req, res) {
  const url = new URL(req.url, 'http://local');
  const p = url.pathname;
  const m = (re) => p.match(re);
  let r;

  // ---------- pages ----------
  if (req.method === 'GET' && p === '/') return serveStatic(res, '/index.html');
  if (req.method === 'GET' && m(/^\/app\/[\w-]+\/?$/)) return serveStatic(res, '/app.html');
  if (req.method === 'GET' && p === '/favicon.ico') return serveStatic(res, '/assets/favicon.svg');
  if (req.method === 'GET' && p === '/assets/fonts/geist.woff2') return sendFile(res, FONT, { cache: 'public, max-age=31536000, immutable' });
  if (req.method === 'GET' && p.startsWith('/assets/')) return serveStatic(res, p);

  // ---------- apps ----------
  if (p === '/api/apps' && req.method === 'POST') {
    const name = decodeURIComponent(req.headers['x-file-name'] || 'app.apk');
    const result = await store.createFromUpload(req, name);
    return json(res, 201, result);
  }
  if (p === '/api/apps' && req.method === 'GET') {
    const ids = (url.searchParams.get('ids') || '').split(',').filter(store.validId).slice(0, 200);
    return json(res, 200, { apps: ids.map((id) => store.publicView(store.get(id))).filter(Boolean) });
  }
  if ((r = m(/^\/api\/apps\/([\w-]+)$/))) {
    const app = store.get(r[1]);
    if (!app) return json(res, 404, { error: 'This app does not exist or was deleted.' });
    if (req.method === 'GET') return json(res, 200, { app: { ...store.publicView(app), canManage: localAdmin(req) } });
    if (req.method === 'DELETE') {
      store.remove(r[1], req.headers['x-owner-key']);
      return json(res, 200, { ok: true });
    }
  }
  if ((r = m(/^\/api\/apps\/([\w-]+)\/accounts$/))) {
    if (!store.get(r[1])) return json(res, 404, { error: 'This app does not exist or was deleted.' });
    const key = req.headers['x-owner-key'];
    const admin = localAdmin(req);
    if (req.method === 'GET') return json(res, 200, { accounts: store.ownerAccounts(r[1], key, { admin }) });
    if (req.method === 'PUT') {
      const body = await readJson(req);
      return json(res, 200, { accounts: store.setAccounts(r[1], key, body.accounts, { admin }) });
    }
  }
  if (req.method === 'GET' && (r = m(/^\/api\/apps\/([\w-]+)\/files\/([\w.-]+)$/))) {
    const file = store.filePath(r[1], r[2]);
    if (!file) return json(res, 404, { error: 'Not found' });
    return sendFile(res, file, { cache: 'public, max-age=86400' });
  }

  // ---------- sessions ----------
  if (req.method === 'POST' && (r = m(/^\/api\/apps\/([\w-]+)\/sessions$/))) {
    const app = store.get(r[1]);
    if (!app) return json(res, 404, { error: 'This app does not exist or was deleted.' });
    const session = sessions.create(app, clientIp(req), url.searchParams.get('phone'));
    return json(res, 201, { session: session.status() });
  }
  if ((r = m(/^\/api\/sessions\/([\w-]+)$/))) {
    const session = sessions.get(r[1]);
    if (!session) return json(res, 404, { error: 'Session not found' });
    if (req.method === 'GET') return json(res, 200, { session: session.status() });
    if (req.method === 'DELETE') {
      sessions.end(session, 'You ended the session.');
      return json(res, 200, { ok: true });
    }
  }
  if (req.method === 'GET' && (r = m(/^\/api\/sessions\/([\w-]+)\/screenshot$/))) {
    const session = sessions.get(r[1]);
    if (!session || !session.device) return json(res, 404, { error: 'No phone is running for this session' });
    await sessions.wake(session);
    const png = await screencap(session.device.serial);
    const stamp = new Date().toISOString().replace(/[:T]/g, '-').slice(0, 19);
    res.writeHead(200, {
      'Content-Type': 'image/png',
      'Content-Length': png.length,
      'Cache-Control': 'no-store',
      'Content-Disposition': `attachment; filename="${session.app.name.replace(/[^\w.-]+/g, '-')}-${stamp}.png"`,
    });
    return res.end(png);
  }
  if (req.method === 'GET' && p === '/api/status') return json(res, 200, { pool: pool.stats() });

  json(res, 404, { error: 'Not found' });
}

const server = http.createServer((req, res) => {
  route(req, res).catch((err) => {
    const status = err.status || 500;
    if (status >= 500) log('http', `${req.method} ${req.url}: ${err.stack || err.message}`);
    if (!res.headersSent) json(res, status, { error: err.message || 'Something went wrong' });
    else res.end();
  });
});
server.requestTimeout = 0; // large uploads

const wss = new WebSocketServer({ noServer: true, maxPayload: 512 * 1024, perMessageDeflate: false });
server.on('upgrade', (req, socket, head) => {
  const wsUrl = new URL(req.url, 'http://local');
  const match = wsUrl.pathname.match(/^\/ws\/sessions\/([\w-]+)$/);
  const session = match && sessions.get(match[1]);
  if (!session) {
    socket.write('HTTP/1.1 404 Not Found\r\n\r\n');
    return socket.destroy();
  }
  wss.handleUpgrade(req, socket, head, (ws) => {
    ws.isAlive = true;
    ws.on('pong', () => (ws.isAlive = true));
    sessions.attach(session, ws, { max: wsUrl.searchParams.get('max') });
  });
});
setInterval(() => {
  for (const ws of wss.clients) {
    if (!ws.isAlive) ws.terminate();
    else {
      ws.isAlive = false;
      ws.ping();
    }
  }
}, 20000).unref();

// A bug somewhere must not take every session down with it: log it and keep serving.
process.on('uncaughtException', (err) => log('server', `unexpected error (still running): ${err && err.stack ? err.stack : err}`));
process.on('unhandledRejection', (err) => log('server', `unexpected error (still running): ${err && err.stack ? err.stack : err}`));

// Stopping the server keeps phones and sessions alive (they are picked up again on the next start), unless
// KEEP_PHONES_ON_RESTART=false or the server is started with --stop-phones-on-exit. `npm run stop-phones` stops them.
let stopping = false;
async function shutdown() {
  if (stopping) return process.exit(1);
  stopping = true;
  if (cfg.KEEP_PHONES_ON_RESTART && !process.argv.includes('--stop-phones-on-exit')) {
    sessions.persist();
    log('server', 'stopping; phones and sessions keep running and are picked up on the next start');
    return process.exit(0);
  }
  log('server', 'shutting down phones…');
  await sessions.endAll();
  await pool.stopAll();
  process.exit(0);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

server.listen(cfg.PORT, cfg.HOST, async () => {
  log('server', `Android Emulator Online running at http://localhost:${cfg.PORT}`);
  await pool.start();
  sessions.restore();
});
