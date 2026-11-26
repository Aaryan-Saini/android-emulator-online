// Runs scrcpy-server on a device and exposes its H.264 stream and its touch/key control channel.
//
// Wire format (scrcpy 5.x, tunnel_forward=true, audio=false):
//   video socket: [dummy 0x00] [device name, 64 bytes] [codec id, 4 bytes]
//                 then 12-byte headers, each followed by a payload:
//                   bit 63 set  -> session packet: u32 flags | u32 width | u32 height (no payload)
//                   otherwise   -> media packet: u64 (bit 62 config, bit 61 keyframe, rest pts in µs) | u32 length
//   control socket: client -> device control messages; device -> client clipboard / acks.
const net = require('net');
const { spawn } = require('child_process');
const { EventEmitter } = require('events');
const cfg = require('./config');
const { adb } = require('./adb');
const { freePort, sleep, log } = require('./util');

const REMOTE_JAR = '/data/local/tmp/scrcpy-server.jar';
const MIN_PRESS_MS = 45;

const MSG = {
  KEY: 0,
  TEXT: 1,
  TOUCH: 2,
  SCROLL: 3,
  EXPAND_NOTIFICATIONS: 5,
  EXPAND_SETTINGS: 6,
  COLLAPSE_PANELS: 7,
  SET_CLIPBOARD: 9,
  ROTATE: 11,
  RESET_VIDEO: 17,
};

class ScrcpyStream extends EventEmitter {
  constructor(serial, { maxSize = cfg.MAX_SIZE } = {}) {
    super();
    this.serial = serial;
    this.maxSize = maxSize;
    this.size = null;
    this.stopped = false;
    this.clipSeq = 1n;
  }

  async start() {
    const scid = (Math.floor(Math.random() * 0x7fffffff) >>> 0).toString(16).padStart(8, '0');
    await adb(this.serial, ['push', cfg.SCRCPY_SERVER, REMOTE_JAR], { timeout: 30000 });
    this.port = await freePort();
    await adb(this.serial, ['forward', `tcp:${this.port}`, `localabstract:scrcpy_${scid}`]);
    const opts = [
      `scid=${scid}`,
      'log_level=info',
      'tunnel_forward=true',
      'audio=false',
      'control=true',
      'cleanup=true',
      'video_codec=h264',
      `max_size=${this.maxSize}`,
      `max_fps=${cfg.MAX_FPS}`,
      `video_bit_rate=${cfg.VIDEO_BITRATE}`,
      'stay_awake=true',
      'power_off_on_close=false',
      'clipboard_autosync=true',
    ];
    const cmd = `CLASSPATH=${REMOTE_JAR} app_process / com.genymobile.scrcpy.Server ${cfg.SCRCPY_VERSION} ${opts.join(' ')}`;
    this.proc = spawn(cfg.ADB, ['-s', this.serial, 'shell', cmd], { windowsHide: true });
    const onLog = (d) => {
      for (const line of d.toString().split(/\r?\n/)) {
        if (line.trim() && !/INFO: (Device:|Video capture reset|Device clipboard set)/.test(line)) log(`scrcpy ${this.serial}`, line.trim());
      }
    };
    this.proc.stdout.on('data', onLog);
    this.proc.stderr.on('data', onLog);
    this.proc.on('exit', () => this.close('server exited'));

    // The forwarded port accepts connections before the server listens; the dummy byte proves it is really there.
    const deadline = Date.now() + 15000;
    while (!this.video && Date.now() < deadline && !this.stopped) {
      const sock = await this.connect().catch(() => null);
      if (sock) {
        const first = await new Promise((r) => {
          sock.once('data', r);
          sock.once('close', () => r(null));
          sock.once('error', () => r(null));
        });
        if (first) {
          this.video = sock;
          this.buf = first.subarray(1);
          break;
        }
        sock.destroy();
      }
      await sleep(100);
    }
    if (!this.video) {
      this.close('could not connect');
      throw new Error('The video stream did not start');
    }
    this.control = await this.connect();
    if (this.stopped) {
      this.control.destroy();
      throw new Error('Stream stopped while starting');
    }
    this.control.setNoDelay(true);
    this.video.setNoDelay(true);

    this.stage = 'name';
    this.video.on('data', (chunk) => this.onVideo(chunk));
    this.video.on('close', () => this.close('video closed'));
    this.video.on('error', () => {});
    this.control.on('data', (chunk) => this.onControl(chunk));
    this.control.on('close', () => this.close('control closed'));
    this.control.on('error', () => {});
    if (this.buf.length) {
      const pending = this.buf;
      this.buf = Buffer.alloc(0);
      this.onVideo(pending);
    }
  }

  connect() {
    return new Promise((resolve, reject) => {
      const s = net.connect(this.port, '127.0.0.1');
      s.once('connect', () => resolve(s));
      s.once('error', reject);
    });
  }

  onVideo(chunk) {
    this.buf = this.buf.length ? Buffer.concat([this.buf, chunk]) : chunk;
    for (;;) {
      if (this.stage === 'name') {
        if (this.buf.length < 64) return;
        this.deviceName = this.buf.toString('utf8', 0, 64).replace(/\0+$/, '');
        this.buf = this.buf.subarray(64);
        this.stage = 'codec';
      }
      if (this.stage === 'codec') {
        if (this.buf.length < 4) return;
        this.buf = this.buf.subarray(4);
        this.stage = 'header';
      }
      if (this.stage === 'header') {
        if (this.buf.length < 12) return;
        if (this.buf.readUInt32BE(0) & 0x80000000) {
          this.size = { w: this.buf.readUInt32BE(4), h: this.buf.readUInt32BE(8) };
          this.buf = this.buf.subarray(12);
          this.emit('size', this.size);
          continue;
        }
        const head = this.buf.readBigUInt64BE(0);
        this.packet = {
          config: Boolean((head >> 62n) & 1n),
          key: Boolean((head >> 61n) & 1n),
          pts: head & 0x1fffffffffffffffn,
          length: this.buf.readUInt32BE(8),
        };
        this.buf = this.buf.subarray(12);
        this.stage = 'body';
      }
      if (this.stage === 'body') {
        if (this.buf.length < this.packet.length) return;
        const data = this.buf.subarray(0, this.packet.length);
        this.buf = this.buf.subarray(this.packet.length);
        this.stage = 'header';
        this.emit('packet', { ...this.packet, data });
      }
    }
  }

  onControl(chunk) {
    this.cbuf = this.cbuf ? Buffer.concat([this.cbuf, chunk]) : chunk;
    while (this.cbuf.length) {
      const type = this.cbuf[0];
      if (type === 0) {
        if (this.cbuf.length < 5) return;
        const len = this.cbuf.readUInt32BE(1);
        if (this.cbuf.length < 5 + len) return;
        const text = this.cbuf.toString('utf8', 5, 5 + len);
        this.cbuf = this.cbuf.subarray(5 + len);
        if (text !== this.lastClipboardSet) this.emit('clipboard', text);
      } else if (type === 1) {
        if (this.cbuf.length < 9) return;
        this.cbuf = this.cbuf.subarray(9);
      } else if (type === 2) {
        if (this.cbuf.length < 5) return;
        const len = this.cbuf.readUInt16BE(3);
        if (this.cbuf.length < 5 + len) return;
        this.cbuf = this.cbuf.subarray(5 + len);
      } else {
        this.cbuf = Buffer.alloc(0);
      }
    }
  }

  send(buf) {
    if (this.control && !this.control.destroyed) this.control.write(buf);
  }

  // x, y are 0..1 relative to the screen. action: 0 down, 1 up, 2 move, 3 cancel.
  // Some views (the Pixel launcher among them) ignore a tap whose down and up land in the same instant,
  // so very short presses are stretched to MIN_PRESS_MS. Later touches wait in order behind them.
  touch(action, pointer, x, y, pressure = 1) {
    if (!this.downAt) {
      this.downAt = new Map();
      this.held = [];
    }
    const now = Date.now();
    if (action === 0) this.downAt.set(pointer, now);
    if ((action === 1 || action === 3) && !this.held.length) {
      const since = now - (this.downAt.get(pointer) || 0);
      if (since < MIN_PRESS_MS) {
        this.held.push([action, pointer, x, y, pressure]);
        setTimeout(() => {
          const queued = this.held;
          this.held = [];
          for (const args of queued) this.writeTouch(...args);
        }, MIN_PRESS_MS - since);
        return;
      }
    }
    if (this.held.length) return void this.held.push([action, pointer, x, y, pressure]);
    this.writeTouch(action, pointer, x, y, pressure);
  }

  writeTouch(action, pointer, x, y, pressure) {
    if (!this.size) return;
    const b = Buffer.alloc(32);
    b[0] = MSG.TOUCH;
    b[1] = action;
    b.writeBigInt64BE(BigInt(pointer), 2);
    b.writeInt32BE(Math.round(x * (this.size.w - 1)), 10);
    b.writeInt32BE(Math.round(y * (this.size.h - 1)), 14);
    b.writeUInt16BE(this.size.w, 18);
    b.writeUInt16BE(this.size.h, 20);
    b.writeUInt16BE(action === 1 || action === 3 ? 0 : Math.round(Math.min(1, Math.max(0, pressure)) * 0xffff), 22);
    b.writeInt32BE(0, 24);
    b.writeInt32BE(0, 28);
    this.send(b);
  }

  key(action, keycode, meta = 0, repeat = 0) {
    const b = Buffer.alloc(14);
    b[0] = MSG.KEY;
    b[1] = action;
    b.writeInt32BE(keycode, 2);
    b.writeInt32BE(repeat, 6);
    b.writeInt32BE(meta, 10);
    this.send(b);
  }

  press(keycode, meta = 0) {
    this.key(0, keycode, meta);
    this.key(1, keycode, meta);
  }

  text(str) {
    const t = Buffer.from(str, 'utf8').subarray(0, 300);
    const b = Buffer.alloc(5 + t.length);
    b[0] = MSG.TEXT;
    b.writeUInt32BE(t.length, 1);
    t.copy(b, 5);
    this.send(b);
  }

  // h, v: scroll amount in "wheel notches" (positive v scrolls content up, like a mouse wheel forward).
  scroll(x, y, h, v) {
    if (!this.size) return;
    const fixed = (n) => Math.round(Math.max(-1, Math.min(1, n / 16)) * 0x7fff);
    const b = Buffer.alloc(21);
    b[0] = MSG.SCROLL;
    b.writeInt32BE(Math.round(x * (this.size.w - 1)), 1);
    b.writeInt32BE(Math.round(y * (this.size.h - 1)), 5);
    b.writeUInt16BE(this.size.w, 9);
    b.writeUInt16BE(this.size.h, 11);
    b.writeInt16BE(fixed(h), 13);
    b.writeInt16BE(fixed(v), 15);
    b.writeInt32BE(0, 17);
    this.send(b);
  }

  setClipboard(text, paste) {
    this.lastClipboardSet = text;
    const t = Buffer.from(text, 'utf8').subarray(0, 256 * 1024);
    const b = Buffer.alloc(14 + t.length);
    b[0] = MSG.SET_CLIPBOARD;
    b.writeBigUInt64BE(this.clipSeq++, 1);
    b[9] = paste ? 1 : 0;
    b.writeUInt32BE(t.length, 10);
    t.copy(b, 14);
    this.send(b);
  }

  simple(type) {
    this.send(Buffer.from([type]));
  }

  close(reason) {
    if (this.stopped) return;
    this.stopped = true;
    if (this.video) this.video.destroy();
    if (this.control) this.control.destroy();
    if (this.proc && this.proc.exitCode === null) this.proc.kill();
    if (this.port) adb(this.serial, ['forward', '--remove', `tcp:${this.port}`]).catch(() => {});
    this.emit('close', reason);
  }
}

module.exports = { ScrcpyStream, MSG };
