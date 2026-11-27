(() => {
  const { el, icon, toast, api, copy } = Handset;
  const $ = (id) => document.getElementById(id);

  const appId = location.pathname.split('/')[2];
  const storeKey = `handset.session.${appId}`;
  const canvas = $('canvas');
  const ctx = canvas.getContext('2d', { alpha: false, desynchronized: true });
  const screenEl = $('screen');
  const phone = $('phone');
  const stage = $('stage');

  let app = null;
  let login = null; // { id, label, state: 'working' | 'failed', step, message }
  let sessionId = null;
  let ws = null;
  let state = 'connecting';
  let size = { w: 1080, h: 2400 };
  let expiresAt = null;
  let retries = 0;
  let rtt = null;
  let fps = 0;
  let warnedMinute = false;

  // ======================================================================
  // Video: H.264 Annex B packets from scrcpy -> WebCodecs -> canvas
  // ======================================================================
  const hex = (n) => n.toString(16).padStart(2, '0');
  function codecFromConfig(b) {
    for (let i = 0; i + 4 < b.length; i++) {
      if (b[i] !== 0 || b[i + 1] !== 0) continue;
      const start = b[i + 2] === 1 ? i + 3 : b[i + 2] === 0 && b[i + 3] === 1 ? i + 4 : -1;
      if (start < 0 || start + 3 >= b.length) continue;
      if ((b[start] & 0x1f) === 7) return `avc1.${hex(b[start + 1])}${hex(b[start + 2])}${hex(b[start + 3])}`;
    }
    return null;
  }

  const video = {
    decoder: null,
    codec: null,
    config: null,
    needKey: true,
    pending: null,
    raf: 0,
    frames: 0,
    errors: 0,
    accel: 'prefer-software',
    gotFrame: false,

    async init() {
      // Software decoding returns every frame immediately; some hardware decoders hold the last frame back.
      try {
        const r = await VideoDecoder.isConfigSupported({ codec: 'avc1.42c029', hardwareAcceleration: 'prefer-software', optimizeForLatency: true });
        if (!r.supported) this.accel = 'no-preference';
      } catch {
        this.accel = 'no-preference';
      }
    },

    setup(codec) {
      if (this.decoder && this.decoder.state === 'configured' && this.codec === codec) return;
      this.close();
      this.codec = codec;
      this.decoder = new VideoDecoder({ output: (f) => this.output(f), error: (e) => this.fail(e) });
      this.decoder.configure({ codec, optimizeForLatency: true, hardwareAcceleration: this.accel });
      this.needKey = true;
    },

    push(flags, pts, data) {
      if (flags & 1) {
        this.config = data.slice();
        const codec = codecFromConfig(this.config);
        if (codec) this.setup(codec);
        return;
      }
      if (!this.decoder || this.decoder.state !== 'configured') return;
      const key = (flags & 2) !== 0;
      if (this.needKey && !key) return;
      if (!key && this.decoder.decodeQueueSize > 6) {
        // Decoder is falling behind: drop to the next keyframe rather than lag.
        this.needKey = true;
        send({ t: 'reset-video' });
        return;
      }
      let payload = data;
      if (key && this.config) {
        payload = new Uint8Array(this.config.length + data.length);
        payload.set(this.config, 0);
        payload.set(data, this.config.length);
      }
      try {
        this.decoder.decode(new EncodedVideoChunk({ type: key ? 'key' : 'delta', timestamp: pts, data: payload }));
        this.needKey = false;
      } catch (e) {
        this.fail(e);
      }
    },

    // Even pacing: frames often arrive in bursts (two at once, then a gap). Drawn on arrival, the first of a pair
    // is never seen and the gap after it reads as a stutter. So frames are shown at the pace the phone captured
    // them (their timestamps), at most one per screen refresh, held back by a few milliseconds at most.
    // If the tab is hidden, only the newest frame is kept.
    queue: [],
    base: null, // arrival time minus capture time of the earliest-arriving recent frame (ms)
    lastAt: 0,
    tick: 0,
    output(frame) {
      if (document.hidden) {
        if (this.pending) this.pending.close();
        this.pending = frame;
        return;
      }
      if (this.pending) {
        this.pending.close();
        this.pending = null;
      }
      const now = performance.now();
      const offset = now - frame.timestamp / 1000;
      // After a still screen (no frames), the next frame starts a new timeline; otherwise follow the earliest
      // arrivals, drifting slowly so a lasting slowdown does not keep every frame late.
      if (this.base === null || now - this.lastAt > 400 || offset < this.base) this.base = offset;
      else this.base += (offset - this.base) * 0.02;
      this.lastAt = now;
      frame.due = frame.timestamp / 1000 + this.base + 4;
      this.queue.push(frame);
      if (!this.tick) this.tick = requestAnimationFrame((t) => this.present(t));
    },

    present(now) {
      this.tick = 0;
      // Of the frames that are due by this refresh, show the newest; the older ones would be covered anyway.
      let show = null;
      while (this.queue.length && (this.queue[0].due <= now + 8 || this.queue.length > 3)) {
        if (show) show.close();
        show = this.queue.shift();
      }
      if (show) this.draw(show);
      if (this.queue.length) this.tick = requestAnimationFrame((t) => this.present(t));
    },

    flush() {
      for (const f of this.queue) f.close();
      this.queue = [];
      this.base = null;
      if (this.tick) cancelAnimationFrame(this.tick);
      this.tick = 0;
    },

    draw(f) {
      const w = f.displayWidth;
      const h = f.displayHeight;
      if (canvas.width !== w || canvas.height !== h) {
        canvas.width = w;
        canvas.height = h;
      }
      ctx.drawImage(f, 0, 0, w, h);
      f.close();
      this.frames++;
      if (!this.gotFrame) {
        this.gotFrame = true;
        screenEl.classList.add('has-frame');
        render();
      }
    },

    fail(e) {
      console.warn('decoder error', e);
      this.close();
      if (++this.errors >= 2 && this.accel !== 'no-preference') this.accel = 'no-preference';
      // A fresh config + keyframe follows a reset; setup() runs again when the config arrives.
      send({ t: 'reset-video' });
    },

    close() {
      this.flush();
      if (this.decoder && this.decoder.state !== 'closed') {
        try {
          this.decoder.close();
        } catch {}
      }
      this.decoder = null;
      this.codec = null;
    },

    reset() {
      this.close();
      this.config = null;
      this.gotFrame = false;
      screenEl.classList.remove('has-frame');
    },
  };

  document.addEventListener('visibilitychange', () => {
    // Hidden tab: the server stops the video and, after a while, freezes the phone. Shown again: it wakes it.
    send({ t: 'visibility', hidden: document.hidden });
    if (!document.hidden && video.pending) {
      const f = video.pending;
      video.pending = null;
      video.draw(f);
    }
  });

  setInterval(() => {
    fps = video.frames;
    video.frames = 0;
    renderMeta();
  }, 1000);

  // ======================================================================
  // Layout: size the phone to the window, keep the stream's aspect ratio
  // ======================================================================
  const mobile = () => matchMedia('(max-width: 700px), (pointer: coarse) and (max-height: 900px) and (max-width: 1024px)').matches;

  function layout() {
    const ar = size.w / size.h;
    const landscape = ar > 1;
    phone.classList.toggle('landscape', landscape);
    let maxW;
    let maxH;
    if (document.fullscreenElement === stage) {
      maxW = innerWidth - (landscape ? 0 : 160);
      maxH = innerHeight;
    } else if (mobile()) {
      const rig = phone.parentElement;
      const tools = rig.querySelector('.tools');
      maxW = rig.clientWidth;
      maxH = rig.clientHeight - tools.offsetHeight;
    } else {
      const toolsW = 22 + 56;
      // The account list sits at the left edge; keep the centred phone clear of it on both sides.
      const panel = $('accounts');
      const side = panel.hidden || !panel.offsetWidth ? 0 : panel.offsetLeft + panel.offsetWidth + 32;
      maxW = side ? stage.clientWidth - 2 * side - toolsW : stage.clientWidth - 48 - toolsW - 40;
      maxH = stage.clientHeight - 48 - 18 * 2 - 40;
      maxH = Math.min(maxH, landscape ? 760 : 940);
    }
    let h = maxH;
    let w = h * ar;
    if (w > maxW) {
      w = maxW;
      h = w / ar;
    }
    w = Math.max(120, Math.floor(w));
    h = Math.max(120, Math.floor(h));
    screenEl.style.width = `${w}px`;
    screenEl.style.height = `${h}px`;
    const short = Math.min(w, h);
    const framed = !mobile() && document.fullscreenElement !== stage;
    phone.style.setProperty('--bezel-w', framed ? `${Math.max(7, Math.round(short * 0.028))}px` : '0px');
    phone.style.setProperty('--screen-r', framed ? `${Math.round(short * 0.1)}px` : '0px');
    requestQuality();
  }

  // Ask the phone to encode exactly the pixels this screen shows. Less to encode = smoother and lower lag.
  let streamMax = 0;
  let qualityTimer = 0;
  // High-density screens get at most 1.5x: beyond that the extra sharpness costs a lot of smoothness.
  const wantedSize = () => Math.round(Math.max(screenEl.clientWidth, screenEl.clientHeight) * Math.min(1.5, window.devicePixelRatio || 1));
  function requestQuality() {
    clearTimeout(qualityTimer);
    qualityTimer = setTimeout(() => {
      const want = wantedSize();
      if (!streamMax || !ws || ws.readyState !== 1) return;
      if (Math.abs(want - streamMax) / streamMax < 0.15) return;
      streamMax = want;
      send({ t: 'quality', max: want });
    }, 500);
  }
  addEventListener('resize', layout);
  document.addEventListener('fullscreenchange', layout);
  new ResizeObserver(layout).observe(stage);

  // ======================================================================
  // UI state
  // ======================================================================
  function renderMeta() {
    const parts = [];
    if (state === 'running' || state === 'installing' || state === 'launching') {
      parts.push('Pixel 7', 'Android 15');
      if (expiresAt) {
        const left = Math.max(0, Math.round((expiresAt - Date.now()) / 1000));
        parts.push(`${Math.floor(left / 60)}:${String(left % 60).padStart(2, '0')} left`);
        if (left <= 60 && left > 0 && !warnedMinute) {
          warnedMinute = true;
          toast('One minute left in this session.');
        }
      }
      if (rtt !== null) parts.push(`${Math.max(1, rtt)} ms`);
      if (fps > 0) parts.push(`${fps} fps`);
    }
    const line = $('metaLine');
    line.replaceChildren();
    parts.forEach((p, i) => {
      if (i) line.append(el('span', { class: 'sep' }, '·'));
      line.append(p);
    });
  }

  function overlay(title, sub, { busy = true, actions = [], showIcon = true, watch = false } = {}) {
    const ov = $('overlay');
    ov.classList.remove('gone');
    ov.classList.toggle('static', !busy);
    ov.classList.toggle('watch', watch);
    $('ovTitle').textContent = title;
    $('ovSub').textContent = sub || '';
    $('ovSub').hidden = !sub;
    $('ovIcon').replaceChildren(showIcon && app ? icon(app, 64) : '');
    $('ovActions').replaceChildren(...actions);
  }
  const hideOverlay = () => $('overlay').classList.add('gone');

  let status = {};
  function render() {
    renderMeta();
    $('endBtn').hidden = state === 'ended';
    switch (state) {
      case 'connecting':
        return overlay('Connecting', '');
      case 'reconnecting':
        return overlay('Reconnecting', 'The connection dropped. Your phone is still running.');
      case 'queued':
        return overlay(
          status.message || 'Waiting for a free phone',
          status.message === 'Starting a fresh phone' ? 'This takes about fifteen seconds.' : status.position > 1 ? `You are number ${status.position} in line.` : 'You are next in line.',
        );
      case 'installing':
        return overlay(status.message || 'Installing', 'Large apps can take a little while.');
      case 'launching':
        return overlay(status.message || 'Opening', '');
      case 'running':
        if (!video.gotFrame) return overlay(app ? `Opening ${app.name}` : 'Opening', '');
        if (login && login.state === 'working') {
          const s = ((Date.now() - (login.startedAt || Date.now())) / 1000).toFixed(1);
          return overlay(`Signing in as ${login.label}`, `${login.step || 'Starting'} · ${s} s`, { watch: true });
        }
        if (login && login.state === 'failed') {
          return overlay(`Couldn’t sign in as ${login.label}`, login.message, {
            busy: false,
            actions: [
              el('button', { class: 'btn btn-ink', type: 'button', onclick: () => signInAs(login.id) }, 'Try again'),
              el('button', {
                class: 'btn btn-ghost',
                type: 'button',
                onclick: () => {
                  manual = findAccount(login.id) || null;
                  login = null;
                  render();
                  renderAccounts();
                },
              }, 'Type it in myself'),
              el('button', { class: 'btn btn-ghost', type: 'button', onclick: () => { login = null; render(); renderAccounts(); } }, 'Close'),
            ],
          });
        }
        return hideOverlay();
      case 'ended':
        return overlay(status.error ? 'Something went wrong' : 'Session ended', status.message || '', {
          busy: false,
          actions: [
            el('button', { class: 'btn btn-ink', type: 'button', onclick: () => startNew() }, 'Start a new session'),
            el('a', { class: 'btn btn-ghost', href: '/' }, 'Back to Handset'),
          ],
        });
      case 'replaced':
        return overlay('Opened somewhere else', 'This session is now showing in another tab or window.', {
          busy: false,
          actions: [el('button', { class: 'btn btn-ink', type: 'button', onclick: () => connect() }, 'Use it here')],
        });
      case 'unsupported':
        return overlay(status.message, status.sub, { busy: false, showIcon: false });
      case 'missing':
        return overlay('App not found', 'This app was deleted or the link is wrong.', {
          busy: false,
          showIcon: false,
          actions: [el('a', { class: 'btn btn-ink', href: '/' }, 'Upload an app')],
        });
      default:
    }
  }

  function setState(next, extra) {
    state = next;
    if (extra) status = { ...status, ...extra };
    render();
  }

  // ======================================================================
  // Session + connection
  // ======================================================================
  function send(msg) {
    if (ws && ws.readyState === 1) ws.send(JSON.stringify(msg));
  }

  async function ensureSession() {
    const saved = sessionStorage.getItem(storeKey);
    if (saved) {
      try {
        const { session } = await api(`/api/sessions/${saved}`);
        if (session.state !== 'ended') return saved;
      } catch {}
      sessionStorage.removeItem(storeKey);
    }
    const kind = localStorage.getItem(PHONE_KEY);
    const { session } = await api(`/api/apps/${appId}/sessions${kind ? `?phone=${encodeURIComponent(kind)}` : ''}`, { method: 'POST' });
    sessionStorage.setItem(storeKey, session.id);
    return session.id;
  }

  // ---------- kind of phone (standard, or light: less memory, no status bar) ----------
  const PHONE_KEY = 'handset.phone';
  const PHONE_LABELS = {
    standard: ['Standard phone', 'Full Android 15, looks like a real phone'],
    light: ['Light phone', 'Uses about 1.4 GB less memory and starts apps faster. No status bar or gesture navigation'],
  };
  let phoneNow = null;
  function renderPhoneKind(msg) {
    const select = $('phoneKind');
    const kinds = Array.isArray(msg.phones) ? msg.phones : [];
    select.hidden = kinds.length < 2 || msg.state === 'ended';
    if (select.hidden || (msg.phone === phoneNow && select.options.length === kinds.length)) return;
    phoneNow = msg.phone;
    select.replaceChildren(
      ...kinds.map((k) => {
        const [label, hint] = PHONE_LABELS[k] || [`${k[0].toUpperCase()}${k.slice(1)} phone`, ''];
        return el('option', { value: k, title: hint, selected: k === msg.phone || undefined }, label);
      }),
    );
    select.value = msg.phone;
    select.title = (PHONE_LABELS[msg.phone] || [])[1] || '';
  }
  $('phoneKind').addEventListener('change', async (e) => {
    const kind = e.target.value;
    localStorage.setItem(PHONE_KEY, kind);
    if (kind === phoneNow) return;
    toast(`Starting a ${((PHONE_LABELS[kind] || [kind])[0]).toLowerCase()} with your app…`);
    if (sessionId) await api(`/api/sessions/${sessionId}`, { method: 'DELETE' }).catch(() => {});
    startNew();
  });

  async function startNew() {
    sessionStorage.removeItem(storeKey);
    if (ws) {
      ws.onclose = null;
      ws.close();
    }
    video.reset();
    warnedMinute = false;
    expiresAt = null;
    setState('connecting', { message: '', error: false });
    try {
      sessionId = await ensureSession();
      connect();
    } catch (e) {
      setState('ended', { message: e.message, error: true });
    }
  }

  function connect() {
    if (ws) {
      ws.onclose = null;
      ws.close();
    }
    video.reset();
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    streamMax = wantedSize();
    const sock = new WebSocket(`${proto}://${location.host}/ws/sessions/${sessionId}?max=${streamMax}`);
    ws = sock;
    sock.binaryType = 'arraybuffer';
    sock.onopen = () => {
      retries = 0;
      if (document.hidden) send({ t: 'visibility', hidden: true });
    };
    sock.onmessage = (e) => {
      if (typeof e.data !== 'string') {
        const view = new DataView(e.data);
        video.push(view.getUint8(0), Number(view.getBigUint64(1)), new Uint8Array(e.data, 9));
        return;
      }
      const msg = JSON.parse(e.data);
      if (msg.type === 'status') {
        expiresAt = msg.expiresAt;
        if (msg.state === 'ended') {
          sessionStorage.removeItem(storeKey);
          video.reset();
        }
        setState(msg.state, msg);
        renderPhoneKind(msg);
        if ((msg.account || null) !== currentAccount) {
          currentAccount = msg.account || null;
          renderAccounts();
        }
      } else if (msg.type === 'size') {
        size = { w: msg.w, h: msg.h };
        layout();
      } else if (msg.type === 'clipboard') {
        copy(msg.text).then((ok) => ok && toast('Copied from the phone to your clipboard'));
      } else if (msg.type === 'notice') {
        login = null;
        currentAccount = null;
        video.reset();
        toast(msg.text, 6000);
        renderAccounts();
      } else if (msg.type === 'login') {
        if (msg.state === 'done') {
          login = null;
          currentAccount = msg.id;
          const took = msg.seconds ? ` in ${msg.seconds.toFixed(1)} s` : '';
          toast(msg.message || `${msg.restored ? 'Switched to' : 'Signed in as'} ${msg.label}${took}`, msg.message ? 7000 : 2600);
        } else {
          const startedAt = login && login.id === msg.id && login.startedAt ? login.startedAt : Date.now();
          login = { ...msg, startedAt };
          if (msg.state === 'working') currentAccount = null;
        }
        render();
        renderAccounts();
      } else if (msg.type === 'pong') {
        rtt = Math.round(performance.now() - msg.t);
      } else if (msg.type === 'replaced') {
        setState('replaced');
      }
    };
    sock.onclose = async (e) => {
      if (ws !== sock) return;
      if (e.code === 4000) return setState('replaced');
      if (state === 'ended' || e.code === 4001) return;
      retries++;
      if (retries > 3) {
        try {
          const { session } = await api(`/api/sessions/${sessionId}`);
          if (session.state === 'ended') return setState('ended', session);
        } catch (err) {
          if (err.status === 404) {
            sessionStorage.removeItem(storeKey);
            return setState('ended', { message: 'This session is over.', error: false });
          }
        }
      }
      setState('reconnecting');
      setTimeout(() => ws === sock && connect(), Math.min(8000, 400 * 2 ** Math.min(retries, 5)));
    };
  }

  setInterval(() => send({ t: 'ping', t0: Math.round(performance.now()) }), 3000);
  setInterval(() => login && login.state === 'working' && state === 'running' && render(), 200); // live sign-in timer
  setInterval(renderMeta, 1000);

  // ======================================================================
  // Input: pointer -> touch, wheel -> scroll, keyboard -> text/keys
  // ======================================================================
  const live = () => ws && ws.readyState === 1 && ['installing', 'launching', 'running'].includes(state);
  const clamp = (v) => Math.max(0, Math.min(1, v));
  function point(e) {
    const r = canvas.getBoundingClientRect();
    return [clamp((e.clientX - r.left) / r.width), clamp((e.clientY - r.top) / r.height)];
  }
  const fingers = new Map();
  let pinch = null;
  const PINCH_FINGER = 9;

  function freeFinger() {
    const used = new Set(fingers.values());
    for (let i = 0; i < PINCH_FINGER; i++) if (!used.has(i)) return i;
    return -1;
  }
  const touch = (a, p, x, y, pr) => send({ t: 'touch', a, p, x: +x.toFixed(5), y: +y.toFixed(5), ...(pr !== undefined ? { pr } : {}) });

  canvas.addEventListener('pointerdown', (e) => {
    if (!live()) return;
    if (e.pointerType === 'mouse' && e.button !== 0) {
      e.preventDefault();
      if (e.button === 2) send({ t: 'nav', k: 'back' });
      if (e.button === 1) send({ t: 'nav', k: 'home' });
      return;
    }
    e.preventDefault();
    canvas.focus({ preventScroll: true });
    const f = freeFinger();
    if (f < 0) return;
    canvas.setPointerCapture(e.pointerId);
    fingers.set(e.pointerId, f);
    const [x, y] = point(e);
    touch(0, f, x, y, e.pointerType === 'pen' ? e.pressure : undefined);
    if (e.pointerType === 'mouse' && (e.ctrlKey || e.metaKey)) {
      pinch = e.pointerId;
      touch(0, PINCH_FINGER, 1 - x, 1 - y);
    }
  });
  canvas.addEventListener('pointermove', (e) => {
    const f = fingers.get(e.pointerId);
    if (f === undefined) return;
    const [x, y] = point(e);
    touch(2, f, x, y, e.pointerType === 'pen' ? e.pressure : undefined);
    if (pinch === e.pointerId) touch(2, PINCH_FINGER, 1 - x, 1 - y);
  });
  function lift(e, cancel) {
    const f = fingers.get(e.pointerId);
    if (f === undefined) return;
    fingers.delete(e.pointerId);
    const [x, y] = point(e);
    touch(cancel ? 3 : 1, f, x, y);
    if (pinch === e.pointerId) {
      touch(cancel ? 3 : 1, PINCH_FINGER, 1 - x, 1 - y);
      pinch = null;
    }
  }
  canvas.addEventListener('pointerup', (e) => lift(e, false));
  canvas.addEventListener('pointercancel', (e) => lift(e, true));
  canvas.addEventListener('lostpointercapture', (e) => lift(e, false));
  canvas.addEventListener('contextmenu', (e) => e.preventDefault());
  canvas.addEventListener('auxclick', (e) => e.preventDefault());
  canvas.addEventListener('mousedown', (e) => e.button === 1 && e.preventDefault());

  // Mouse wheel and trackpad scrolling drive a virtual finger that drags the screen. Android then scrolls the way
  // it does under a real finger: smoothly, pixel by pixel, instead of jumping one "scroll step" per wheel notch.
  // Wheel notches glide over ~150 ms; trackpad movement is followed 1:1. The finger only goes down after a few
  // pixels of movement (a tiny nudge must never become a tap) and lifts once scrolling stops, almost at rest, so
  // the page stops where the wheel left it. A long scroll re-grips the screen like a person flicking again.
  const glide = {
    on: false,
    f: -1,
    sx: 0, sy: 0, // where the finger went down (0..1 of the screen)
    tx: 0, ty: 0, // where it should be, relative to that point
    cx: 0, cy: 0, // where it is now
    px: 0, py: 0, // movement gathered before the finger goes down
    ox: 0.5, oy: 0.5, // pointer position
    ease: 1,
    lastInput: 0,
    raf: 0,

    add(e) {
      const r = canvas.getBoundingClientRect();
      if (!r.height) return;
      const unit = e.deltaMode === 1 ? 40 : e.deltaMode === 2 ? r.height * 0.85 : 1;
      // Wheel down moves the content up, which is a finger moving up.
      const dx = (-e.deltaX * unit) / r.width;
      const dy = (-e.deltaY * unit) / r.height;
      [this.ox, this.oy] = point(e);
      // Notched wheels send big steps (~100 px): glide them. Trackpads send many small ones: follow directly.
      this.ease = Math.abs(e.deltaY * unit) >= 50 || Math.abs(e.deltaX * unit) >= 50 ? 0.28 : 1;
      this.lastInput = performance.now();
      if (!this.on) {
        this.px += dx;
        this.py += dy;
        if (Math.hypot(this.px * r.width, this.py * r.height) < 10) return void this.schedule();
        if (!this.begin(this.px, this.py)) {
          this.px = this.py = 0;
          return;
        }
        this.tx += this.px;
        this.ty += this.py;
        this.px = this.py = 0;
      } else {
        this.tx += dx;
        this.ty += dy;
      }
      this.schedule();
    },

    // Put the finger down under the pointer, unless that leaves too little room to move in this direction.
    begin(dx, dy) {
      if (fingers.size) return false; // a real finger or mouse drag is in progress
      const f = freeFinger();
      if (f < 0) return false;
      const room = (p, d) => (d < 0 ? p - 0.03 : 0.97 - p);
      this.sx = room(this.ox, dx) >= 0.35 || Math.abs(dx) < 1e-6 ? Math.min(0.95, Math.max(0.05, this.ox)) : dx < 0 ? 0.7 : 0.3;
      this.sy = room(this.oy, dy) >= 0.35 || Math.abs(dy) < 1e-6 ? Math.min(0.95, Math.max(0.05, this.oy)) : dy < 0 ? 0.72 : 0.28;
      this.f = f;
      this.on = true;
      this.tx = this.ty = this.cx = this.cy = 0;
      fingers.set('glide', f);
      touch(0, f, this.sx, this.sy);
      return true;
    },

    end() {
      if (!this.on) return;
      touch(1, this.f, this.sx + this.cx, this.sy + this.cy);
      fingers.delete('glide');
      this.on = false;
    },

    schedule() {
      if (!this.raf) this.raf = requestAnimationFrame(() => this.step());
    },

    step() {
      this.raf = 0;
      const idle = performance.now() - this.lastInput;
      if (!this.on) {
        // Movement too small to start a drag: forget it once the wheel has been still for a moment.
        if (idle > 150) this.px = this.py = 0;
        else this.schedule();
        return;
      }
      this.cx += (this.tx - this.cx) * this.ease;
      this.cy += (this.ty - this.cy) * this.ease;
      if (Math.abs(this.tx - this.cx) < 0.0005) this.cx = this.tx;
      if (Math.abs(this.ty - this.cy) < 0.0005) this.cy = this.ty;
      let x = this.sx + this.cx;
      let y = this.sy + this.cy;
      // Out of room: lift and put the finger down again, carrying over the distance still to go.
      if (x < 0.02 || x > 0.98 || y < 0.02 || y > 0.98) {
        const restX = this.tx - this.cx;
        const restY = this.ty - this.cy;
        this.cx = Math.max(0.02, Math.min(0.98, x)) - this.sx;
        this.cy = Math.max(0.02, Math.min(0.98, y)) - this.sy;
        this.end();
        if (this.begin(restX, restY)) {
          this.tx = restX;
          this.ty = restY;
          this.schedule();
        }
        return;
      }
      touch(2, this.f, x, y);
      const settled = this.cx === this.tx && this.cy === this.ty;
      if (settled && idle > 90) return this.end();
      this.schedule();
    },
  };
  canvas.addEventListener(
    'wheel',
    (e) => {
      e.preventDefault();
      if (!live()) return;
      glide.add(e);
    },
    { passive: false },
  );
  // A real touch or click takes over from a wheel glide.
  canvas.addEventListener('pointerdown', () => glide.end(), true);

  const KEYS = {
    Backspace: 67, Delete: 112, Enter: 66, Tab: 61, Escape: 4,
    ArrowUp: 19, ArrowDown: 20, ArrowLeft: 21, ArrowRight: 22,
    Home: 122, End: 123, PageUp: 92, PageDown: 93,
  };
  const CTRL_KEYS = { a: 29, c: 31, x: 52, z: 54, y: 53 };
  const META_CTRL = 0x3000;
  const META_SHIFT = 0x41;

  document.addEventListener('keydown', (e) => {
    if (!live() || e.isComposing || $('acctDialog').open || (login && login.state === 'working')) return;
    const t = e.target;
    if (t.closest && t.closest('input, textarea, [contenteditable]')) return;
    if (t.closest && t.closest('button, a') && (e.key === 'Enter' || e.key === ' ')) return;
    if (e.ctrlKey || e.metaKey) {
      const k = e.key.toLowerCase();
      if (CTRL_KEYS[k] && !e.altKey) {
        e.preventDefault();
        send({ t: 'key', k: CTRL_KEYS[k], m: META_CTRL });
      }
      return; // Ctrl+V arrives as a paste event; other shortcuts stay with the browser.
    }
    if (KEYS[e.key] !== undefined) {
      e.preventDefault();
      send({ t: 'key', k: KEYS[e.key], m: e.shiftKey ? META_SHIFT : 0 });
      return;
    }
    if (e.key.length === 1 && !e.altKey) {
      e.preventDefault();
      send({ t: 'text', s: e.key });
    }
  });
  window.addEventListener('paste', (e) => {
    if (!live() || $('acctDialog').open || (e.target.closest && e.target.closest('input, textarea, [contenteditable]'))) return;
    const text = e.clipboardData && e.clipboardData.getData('text');
    if (!text) return;
    e.preventDefault();
    send({ t: 'clip', s: text, paste: true });
  });

  // ======================================================================
  // Controls
  // ======================================================================
  document.querySelectorAll('[data-nav]').forEach((b) =>
    b.addEventListener('click', () => {
      send({ t: 'nav', k: b.dataset.nav });
      canvas.focus({ preventScroll: true });
    }),
  );
  $('restartBtn').addEventListener('click', () => send({ t: 'app', k: 'restart' }));
  $('clearBtn').addEventListener('click', () => {
    if (confirm(`Clear all data for ${app ? app.name : 'this app'} and open it again? You will be signed out of it.`)) send({ t: 'app', k: 'clear' });
  });
  $('shotBtn').addEventListener('click', async () => {
    if (!live()) return;
    try {
      const res = await fetch(`/api/sessions/${sessionId}/screenshot`);
      if (!res.ok) throw new Error();
      const blob = await res.blob();
      const name = (res.headers.get('Content-Disposition') || '').match(/filename="([^"]+)"/);
      const a = el('a', { href: URL.createObjectURL(blob), download: name ? name[1] : 'screenshot.png' });
      a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 5000);
      toast('Screenshot saved');
    } catch {
      toast('Could not take a screenshot');
    }
  });
  $('fullBtn').addEventListener('click', () => {
    if (document.fullscreenElement) document.exitFullscreen();
    else stage.requestFullscreen().catch(() => toast('Full screen is not available here'));
  });
  $('shareBtn').addEventListener('click', async () => {
    const ok = await copy(`${location.origin}/app/${appId}`);
    toast(ok ? 'Link copied. Anyone who opens it gets their own phone.' : 'Could not copy the link');
  });
  $('endBtn').addEventListener('click', async () => {
    if (!sessionId) return;
    await api(`/api/sessions/${sessionId}`, { method: 'DELETE' }).catch(() => {});
    sessionStorage.removeItem(storeKey);
  });

  // ======================================================================
  // Accounts: one-click "Sign in as" (a panel beside the phone, or a dropdown on small screens)
  // ======================================================================
  const ownerKey = () => Handset.library.ownerKey(appId);
  // The uploader's browser, or anyone on the PC Handset runs on (the server says so in app.canManage).
  const canManage = () => Boolean(ownerKey() || (app && app.canManage));
  const acctMenu = $('acctMenu');
  let currentAccount = null; // id of the account the phone is signed in as
  let manual = null; // account being typed in by hand: { id, name, username, hasPassword, extras }

  const ICON_GO = '<svg viewBox="0 0 24 24"><path d="M5 12h14M13 6l6 6-6 6"/></svg>';
  const ICON_CHECK = '<svg viewBox="0 0 24 24"><path d="m5 12.5 4.5 4.5L19 7.5"/></svg>';
  const ICON_X = '<svg viewBox="0 0 24 24"><path d="M6 6l12 12M18 6 6 18"/></svg>';
  const ICON_GRIP = '<svg viewBox="0 0 10 18"><circle cx="2.5" cy="3" r="1.5"/><circle cx="7.5" cy="3" r="1.5"/><circle cx="2.5" cy="9" r="1.5"/><circle cx="7.5" cy="9" r="1.5"/><circle cx="2.5" cy="15" r="1.5"/><circle cx="7.5" cy="15" r="1.5"/></svg>';
  function grip() {
    const g = el('span', { class: 'acct-grip', 'aria-hidden': 'true' });
    g.innerHTML = ICON_GRIP;
    return g;
  }
  const ICON_EYE ='<svg viewBox="0 0 24 24"><path d="M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12Z"/><circle cx="12" cy="12" r="2.8"/></svg>';

  function initials(s) {
    const parts = String(s).replace(/@.*/, '').split(/[\s._-]+/).filter(Boolean);
    if (!parts.length) return '?';
    return (parts[0][0] + (parts[1] ? parts[1][0] : parts[0].slice(1, 2))).toUpperCase();
  }
  function hue(s) {
    let h = 0;
    for (const ch of String(s)) h = (h * 31 + ch.charCodeAt(0)) | 0;
    return [18, 32, 145, 168, 200, 225, 262, 330][Math.abs(h) % 8];
  }
  const findAccount = (id) => ((app && app.accounts) || []).find((a) => a.id === id);

  function signInAs(id) {
    const account = findAccount(id);
    if (!account) return;
    closeMenu();
    manual = null;
    if (state !== 'running') return toast('Wait until the app is open, then try again.');
    login = { id, label: account.name, state: 'working', step: 'Starting', startedAt: Date.now() };
    render();
    renderAccounts();
    send({ t: 'login', a: id });
  }

  function accountRow(a) {
    const busy = Boolean(login && login.state === 'working');
    const isBusy = busy && login.id === a.id;
    const isCurrent = !busy && currentAccount === a.id;
    const stateEl = el('span', { class: 'acct-state' });
    if (isBusy) stateEl.append(el('span', { class: 'spin' }), 'Signing in');
    else if (isCurrent) stateEl.innerHTML = ICON_CHECK;
    else stateEl.innerHTML = `<span class="go">${ICON_GO}</span>`;
    return el(
      'button',
      {
        class: `acct-row${isCurrent ? ' is-current' : ''}${isBusy ? ' is-busy' : ''}`,
        type: 'button',
        disabled: busy || undefined,
        title: isCurrent ? `Signed in as ${a.name}. Click to sign in again.` : `Sign in as ${a.name}`,
        onclick: () => !justDragged && signInAs(a.id), // the click that ends a drag is not a sign-in
        'data-id': a.id,
      },
      canManage() ? grip() : null,
      el('span', { class: 'avatar', style: { background: `hsl(${hue(a.username || a.name)} 40% 40%)` } }, initials(a.name)),
      el(
        'span',
        { class: 'acct-text' },
        el('strong', {}, a.name),
        a.username && a.username !== a.name ? el('span', {}, a.username) : null,
        isCurrent ? el('span', { class: 'acct-now' }, 'Signed in') : null,
      ),
      stateEl,
    );
  }

  function accountsContent() {
    const accounts = (app && app.accounts) || [];
    const tools = () =>
      el(
        'div',
        { class: 'accounts-tools' },
        accounts.length ? el('button', { class: 'link-btn accounts-manage', type: 'button', onclick: () => openEditor() }, 'Manage accounts') : null,
        accounts.length ? el('button', { class: 'link-btn', type: 'button', onclick: () => exportSaved() }, 'Export') : null,
        el('button', { class: 'link-btn', type: 'button', onclick: () => $('acctImportFile').click() }, 'Import'),
      );
    if (!accounts.length) {
      return [
        el(
          'div',
          { class: 'accounts-empty' },
          el('p', {}, 'Save a login for each role of this app, then switch between them here with one click.'),
          el('button', { class: 'btn btn-ink', type: 'button', onclick: () => openEditor() }, 'Add accounts'),
          canManage() ? tools() : null,
        ),
      ];
    }
    const add = el('button', { class: 'acct-add', type: 'button', onclick: () => addAccount() }, el('span', { class: 'acct-add-icon', 'aria-hidden': 'true' }, '+'), 'Add account');
    const nodes = [el('div', { class: 'accounts-list' }, ...accounts.map(accountRow), add)];
    if (canManage()) nodes.push(tools());
    return nodes;
  }

  // ---------- reorder by dragging (or Alt+Up / Alt+Down), for people who can manage accounts ----------
  let justDragged = false;

  function moveAccount(from, to) {
    const list = app.accounts;
    if (from === to || from < 0 || to < 0 || to >= list.length) return;
    const before = list.slice();
    list.splice(to, 0, list.splice(from, 1)[0]);
    renderAccounts();
    saveOrder(list.map((a) => a.id), before);
  }

  // Saving sends the full list in the new order; account ids stay the same, so saved sign-ins are kept.
  async function saveOrder(ids, before) {
    const headers = { 'X-Owner-Key': ownerKey() || '' };
    try {
      const { accounts } = await api(`/api/apps/${appId}/accounts`, { headers });
      const byId = new Map(accounts.map((a) => [a.id, a]));
      const ordered = [...ids.map((id) => byId.get(id)).filter(Boolean), ...accounts.filter((a) => !ids.includes(a.id))];
      const res = await api(`/api/apps/${appId}/accounts`, {
        method: 'PUT',
        headers: { ...headers, 'Content-Type': 'application/json' },
        body: JSON.stringify({ accounts: ordered }),
      });
      app.accounts = res.accounts;
      renderAccounts();
    } catch (e) {
      app.accounts = before;
      renderAccounts();
      toast(`Could not save the new order: ${e.message}`);
    }
  }

  function sortable(container) {
    container.addEventListener('pointerdown', (e) => {
      const row = e.target.closest('.acct-row');
      if (!row || e.button !== 0 || e.pointerType === 'touch' || row.disabled || !canManage()) return;
      const listEl = row.parentElement;
      const rows = [...listEl.querySelectorAll('.acct-row')];
      const from = rows.indexOf(row);
      if (rows.length < 2 || from < 0) return;
      const startY = e.clientY;
      let rects = null;
      let to = from;
      const update = (ev) => {
        let dy = ev.clientY - startY;
        if (!rects) {
          if (Math.abs(dy) < 6) return; // a click, not a drag
          rects = rows.map((r) => r.getBoundingClientRect());
          row.setPointerCapture(e.pointerId);
          listEl.classList.add('is-sorting');
          row.classList.add('is-dragging');
        }
        const r = rects[from];
        dy = Math.max(rects[0].top - r.top, Math.min(rects[rects.length - 1].bottom - r.bottom, dy));
        const center = r.top + r.height / 2 + dy;
        to = rects.filter((q, i) => i !== from && q.top + q.height / 2 < center).length;
        const gap = rects.length > 1 ? Math.max(0, rects[1].top - rects[0].bottom) : 8;
        const shift = r.height + gap;
        row.style.transform = `translateY(${dy}px)`;
        rows.forEach((other, i) => {
          if (i === from) return;
          const y = from < to && i > from && i <= to ? -shift : to < from && i >= to && i < from ? shift : 0;
          other.style.transform = y ? `translateY(${y}px)` : '';
        });
      };
      const finish = (ev, cancel = false) => {
        window.removeEventListener('pointermove', update);
        window.removeEventListener('pointerup', onUp);
        window.removeEventListener('pointercancel', onCancel);
        window.removeEventListener('keydown', onKey, true);
        if (!rects) return;
        justDragged = true;
        setTimeout(() => (justDragged = false), 0);
        listEl.classList.remove('is-sorting');
        row.classList.remove('is-dragging');
        rows.forEach((r) => (r.style.transform = ''));
        if (!cancel) setTimeout(() => moveAccount(from, to), 0); // after the browser's closing click
      };
      const onUp = (ev) => finish(ev);
      const onCancel = (ev) => finish(ev, true);
      const onKey = (ev) => {
        if (ev.key !== 'Escape') return;
        ev.stopPropagation();
        finish(ev, true);
      };
      window.addEventListener('pointermove', update);
      window.addEventListener('pointerup', onUp);
      window.addEventListener('pointercancel', onCancel);
      window.addEventListener('keydown', onKey, true);
    });
    // The click that ends a drag must not sign in.
    container.addEventListener('click', (e) => {
      if (!justDragged) return;
      e.stopPropagation();
      e.preventDefault();
    }, true);
    container.addEventListener('keydown', (e) => {
      const row = e.target.closest && e.target.closest('.acct-row');
      if (!row || !e.altKey || (e.key !== 'ArrowUp' && e.key !== 'ArrowDown') || !canManage() || row.disabled) return;
      e.preventDefault();
      e.stopPropagation();
      const from = app.accounts.findIndex((a) => a.id === row.dataset.id);
      const to = from + (e.key === 'ArrowUp' ? -1 : 1);
      if (to < 0 || to >= app.accounts.length) return;
      moveAccount(from, to);
      const moved = container.querySelector(`.acct-row[data-id="${CSS.escape(row.dataset.id)}"]`);
      if (moved) moved.focus();
    });
  }
  sortable($('accountsList'));
  sortable(acctMenu);

  function addAccount() {
    if (canManage()) return openEditor({ add: true });
    closeMenu();
    toast('Accounts can be added on the computer Handset runs on, or in the browser this app was uploaded from.', 7000);
  }

  function renderAccounts() {
    const accounts = (app && app.accounts) || [];
    const show = accounts.length > 0 || canManage();
    const wasShown = !$('accounts').hidden;
    $('accounts').hidden = !show;
    $('acct').hidden = !show;
    $('accountsList').replaceChildren(...accountsContent());
    acctMenu.replaceChildren(...accountsContent());
    const cur = findAccount(currentAccount);
    $('acctBtnLabel').textContent = cur ? cur.name : accounts.length ? 'Switch account' : 'Add accounts';
    renderAssist();
    if (wasShown !== show) layout();
  }

  // Signing in by hand: a small bar under the phone that types saved values into the focused field.
  function renderAssist() {
    const bar = $('assist');
    const a = manual && findAccount(manual.id);
    bar.hidden = !a;
    if (!a) return;
    const typeBtn = (label, which) =>
      el('button', {
        class: 'btn btn-ghost',
        type: 'button',
        onclick: () => {
          send({ t: 'type', a: a.id, f: which });
          canvas.focus({ preventScroll: true });
        },
      }, label);
    bar.replaceChildren(
      el('span', { class: 'assist-text' }, `Tap a field on the phone, then type ${a.name}’s`),
      ...a.extras.map((label, i) => typeBtn(label, `extra:${i}`)),
      a.username ? typeBtn('Username', 'username') : null,
      a.hasPassword ? typeBtn('Password', 'password') : null,
      el('button', { class: 'btn btn-quiet', type: 'button', onclick: () => { manual = null; renderAssist(); } }, 'Done'),
    );
  }

  function closeMenu() {
    acctMenu.hidden = true;
    $('acctBtn').setAttribute('aria-expanded', 'false');
  }
  $('acctBtn').addEventListener('click', (e) => {
    e.stopPropagation();
    if (!app.accounts.length && canManage()) return openEditor();
    acctMenu.hidden = !acctMenu.hidden;
    $('acctBtn').setAttribute('aria-expanded', String(!acctMenu.hidden));
  });
  document.addEventListener('click', (e) => {
    if (!acctMenu.hidden && !e.target.closest('#acct')) closeMenu();
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !acctMenu.hidden) {
      e.stopPropagation();
      closeMenu();
    }
  }, true);

  // ---------- editor (only for the person who uploaded the app) ----------
  const dialog = $('acctDialog');
  let fieldSeq = 0;

  function input(cls, type, placeholder, value, key, extra = {}) {
    const i = el('input', { class: cls, type, placeholder, 'data-k': key, autocomplete: 'off', spellcheck: 'false', autocapitalize: 'off', ...extra });
    i.value = value || '';
    return i;
  }

  function accountEditor(a = { label: '', username: '', password: '', extras: [] }) {
    const ids = [++fieldSeq, ++fieldSeq, ++fieldSeq].map((n) => `acf${n}`);
    const name = input('in in-name', 'text', 'e.g. Admin, Front desk, Waiter', a.label, 'name', { id: ids[0] });
    const user = input('in', 'text', 'Email, phone or username', a.username, 'username', { id: ids[1] });
    const pass = input('in', 'password', 'Password', a.password, 'password', { id: ids[2], autocomplete: 'new-password' });
    const eye = el('button', { class: 'icon-btn', type: 'button', title: 'Show password', 'aria-label': 'Show password' });
    eye.innerHTML = ICON_EYE;
    eye.addEventListener('click', () => {
      pass.type = pass.type === 'password' ? 'text' : 'password';
      eye.title = pass.type === 'password' ? 'Show password' : 'Hide password';
    });

    const note = el('p', { class: 'extras-note' }, 'Typed before the username, for apps that first ask for something like an organisation code.');
    const extras = el('div', { class: 'extras' }, note);
    const sync = () => (note.hidden = !extras.querySelector('.extra-row'));
    const addExtra = (e = { label: '', value: '' }) => {
      const remove = el('button', { class: 'icon-btn', type: 'button', title: 'Remove this step', 'aria-label': 'Remove this step' });
      remove.innerHTML = ICON_X;
      const row = el('div', { class: 'extra-row' }, input('in', 'text', 'e.g. Organisation code', e.label, 'xlabel'), input('in', 'text', 'Value', e.value, 'xvalue'), remove);
      remove.addEventListener('click', () => {
        row.remove();
        sync();
      });
      extras.append(row);
      sync();
      return row;
    };
    (a.extras || []).forEach(addExtra);
    sync();

    const box = el(
      'section',
      { class: 'acct-edit' },
      el('div', { class: 'acct-grid' },
        el('label', { for: ids[0] }, 'Name'), name,
        el('label', { for: ids[1] }, 'Username'), user,
        el('label', { for: ids[2] }, 'Password'), el('div', { class: 'pw' }, pass, eye)),
      extras,
      el('div', { class: 'acct-edit-foot' },
        el('button', { class: 'link-btn', type: 'button', onclick: () => addExtra().querySelector('input').focus() }, 'Add a step before the username'),
        el('button', { class: 'btn btn-quiet', type: 'button', onclick: () => box.remove() }, 'Remove')),
    );
    box.dataset.id = a.id || '';
    return box;
  }

  // `add`: start with a blank account at the end, ready to type into.
  async function openEditor({ add = false } = {}) {
    closeMenu();
    $('acctError').hidden = true;
    let accounts = [];
    try {
      ({ accounts } = await api(`/api/apps/${appId}/accounts`, { headers: { 'X-Owner-Key': ownerKey() || '' } }));
    } catch (e) {
      return toast(e.message);
    }
    const blank = add || !accounts.length ? accountEditor() : null;
    $('acctEditors').replaceChildren(...accounts.map((a) => accountEditor(a)), ...(blank ? [blank] : []));
    dialog.showModal();
    if (blank) {
      blank.scrollIntoView({ block: 'nearest' });
      blank.querySelector('[data-k="name"]').focus();
    }
  }

  $('acctAdd').addEventListener('click', () => {
    const ed = accountEditor();
    $('acctEditors').append(ed);
    ed.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    ed.querySelector('[data-k="name"]').focus();
  });
  $('acctCancel').addEventListener('click', () => dialog.close());

  function collectEditor() {
    return [...$('acctEditors').children]
      .map((box) => ({
        id: box.dataset.id || undefined,
        label: box.querySelector('[data-k="name"]').value.trim(),
        username: box.querySelector('[data-k="username"]').value.trim(),
        password: box.querySelector('[data-k="password"]').value,
        extras: [...box.querySelectorAll('.extra-row')]
          .map((r) => ({ label: r.querySelector('[data-k="xlabel"]').value.trim(), value: r.querySelector('[data-k="xvalue"]').value.trim() }))
          .filter((x) => x.label || x.value),
      }))
      .filter((a) => a.label || a.username || a.password);
  }

  // ---------- export / import ----------
  function download(accounts) {
    if (!accounts.length) return toast('There are no accounts to export yet.');
    const file = { handset: 'accounts', version: 1, app: { name: app.name, package: app.package }, exportedAt: new Date().toISOString(), accounts };
    const a = el('a', {
      href: URL.createObjectURL(new Blob([JSON.stringify(file, null, 2)], { type: 'application/json' })),
      download: `${app.name.replace(/[^\w.-]+/g, '-')}-accounts.json`,
    });
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 5000);
    toast(`Exported ${accounts.length} account${accounts.length > 1 ? 's' : ''}. The file contains the passwords, so keep it private.`, 5000);
  }
  // From the dialog: export what is in the editor (including unsaved edits).
  $('acctExport').addEventListener('click', () => download(collectEditor().map(({ id, ...a }) => a)));
  // From the panel: export what is saved.
  async function exportSaved() {
    closeMenu();
    try {
      const { accounts } = await api(`/api/apps/${appId}/accounts`, { headers: { 'X-Owner-Key': ownerKey() || '' } });
      download(accounts.map(({ id, ...a }) => a));
    } catch (e) {
      toast(e.message);
    }
  }

  $('acctImport').addEventListener('click', () => $('acctImportFile').click());
  $('acctImportFile').addEventListener('change', async () => {
    const f = $('acctImportFile').files[0];
    $('acctImportFile').value = '';
    if (!f) return;
    let list;
    try {
      const data = JSON.parse(await f.text());
      list = Array.isArray(data) ? data : data.accounts;
      if (!Array.isArray(list)) throw new Error();
    } catch {
      return toast('That file is not a Handset accounts export.');
    }
    const str = (v) => (typeof v === 'string' ? v : v == null ? '' : String(v));
    const incoming = list
      .map((a) => ({
        label: str(a.label || a.name).trim(),
        username: str(a.username).trim(),
        password: str(a.password),
        extras: (Array.isArray(a.extras) ? a.extras : []).map((x) => ({ label: str(x.label).trim(), value: str(x.value).trim() })),
      }))
      .filter((a) => a.username || a.password);
    if (!incoming.length) return toast('No accounts found in that file.');
    closeMenu();
    // Importing from the panel: load the saved accounts into the editor first, then merge into them.
    if (!dialog.open) {
      try {
        const { accounts } = await api(`/api/apps/${appId}/accounts`, { headers: { 'X-Owner-Key': ownerKey() || '' } });
        $('acctError').hidden = true;
        $('acctEditors').replaceChildren(...(accounts.length ? accounts.map((a) => accountEditor(a)) : [accountEditor()]));
      } catch (e) {
        return toast(e.message);
      }
    }
    // Same username = same account: update it. Anything new is added.
    const boxes = [...$('acctEditors').children];
    const blank = boxes.length === 1 && !collectEditor().length ? boxes[0] : null;
    if (blank) blank.remove();
    let added = 0;
    let updated = 0;
    for (const a of incoming) {
      const match = a.username && [...$('acctEditors').children].find((b) => b.querySelector('[data-k="username"]').value.trim().toLowerCase() === a.username.toLowerCase());
      if (match) {
        const ed = accountEditor({ ...a, id: match.dataset.id });
        match.replaceWith(ed);
        updated++;
      } else {
        $('acctEditors').append(accountEditor(a));
        added++;
      }
    }
    if (!dialog.open) dialog.showModal();
    toast([added && `${added} added`, updated && `${updated} updated`].filter(Boolean).join(', ') + '. Saving…');
    $('acctForm').requestSubmit();
  });

  $('acctForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const accounts = collectEditor();
    try {
      const res = await api(`/api/apps/${appId}/accounts`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', 'X-Owner-Key': ownerKey() || '' },
        body: JSON.stringify({ accounts }),
      });
      app.accounts = res.accounts;
      if (!findAccount(currentAccount)) currentAccount = null;
      renderAccounts();
      dialog.close();
      toast(res.accounts.length ? `Saved ${res.accounts.length} account${res.accounts.length > 1 ? 's' : ''}` : 'Accounts removed');
    } catch (err) {
      $('acctError').textContent = err.message;
      $('acctError').hidden = false;
    }
  });

  // ======================================================================
  // Start
  // ======================================================================
  async function main() {
    layout();
    render();
    try {
      ({ app } = await api(`/api/apps/${appId}`));
    } catch {
      $('appName').textContent = 'App not found';
      return setState('missing');
    }
    document.title = `${app.name} on Handset`;
    $('appIcon').replaceChildren(icon(app, 34));
    $('appName').textContent = app.name;
    $('appMeta').textContent = [app.versionName && `Version ${app.versionName}`, app.package].filter(Boolean).join(' · ');
    app.accounts = app.accounts || [];
    renderAccounts();
    render();

    if (!window.isSecureContext) {
      return setState('unsupported', {
        message: 'This page needs a secure connection',
        sub: 'Browsers only decode video on HTTPS pages or on localhost. Open Handset through an https:// address.',
      });
    }
    if (!('VideoDecoder' in window)) {
      return setState('unsupported', {
        message: 'This browser cannot show the phone',
        sub: 'Use a recent version of Chrome, Edge, Safari or Firefox.',
      });
    }
    await video.init();
    try {
      sessionId = await ensureSession();
    } catch (e) {
      return setState('ended', { message: e.message, error: true });
    }
    connect();
  }

  main();
})();
