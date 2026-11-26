// Shared helpers for both pages.
const Handset = (() => {
  const LIB_KEY = 'handset.apps';

  const library = {
    all() {
      try {
        return JSON.parse(localStorage.getItem(LIB_KEY)) || [];
      } catch {
        return [];
      }
    },
    add(id, ownerKey) {
      const list = library.all().filter((a) => a.id !== id);
      list.unshift({ id, ownerKey, addedAt: Date.now() });
      localStorage.setItem(LIB_KEY, JSON.stringify(list.slice(0, 200)));
    },
    remove(id) {
      localStorage.setItem(LIB_KEY, JSON.stringify(library.all().filter((a) => a.id !== id)));
    },
    ownerKey(id) {
      const entry = library.all().find((a) => a.id === id);
      return entry ? entry.ownerKey : null;
    },
  };

  function el(tag, props = {}, ...children) {
    const node = document.createElement(tag);
    for (const [k, v] of Object.entries(props)) {
      if (k === 'class') node.className = v;
      else if (k === 'style') Object.assign(node.style, v);
      else if (k.startsWith('on')) node.addEventListener(k.slice(2), v);
      else if (v !== undefined && v !== null && v !== false) node.setAttribute(k, v === true ? '' : v);
    }
    for (const c of children.flat()) if (c !== null && c !== undefined) node.append(c.nodeType ? c : document.createTextNode(c));
    return node;
  }

  // Renders an Android launcher icon. Adaptive icons are 108dp layers of which the middle 72dp show.
  function icon(app, size = 48) {
    const box = el('span', { class: 'icon', style: { '--s': `${size}px` } });
    box.style.setProperty('--s', `${size}px`);
    const ic = app && app.icon;
    if (ic && ic.kind === 'image') {
      box.append(el('img', { class: 'icon-img', src: ic.url, alt: '', draggable: 'false' }));
    } else if (ic && ic.kind === 'adaptive') {
      const bg = el('span', { class: 'icon-bg' });
      if (ic.bg.url) bg.style.backgroundImage = `url("${ic.bg.url}")`;
      else bg.style.background = ic.bg.color;
      const inset = Math.max(0, Math.min(0.4, ic.fg.inset || 0));
      const fg = el('img', { class: 'icon-fg', src: ic.fg.url, alt: '', draggable: 'false' });
      Object.assign(fg.style, {
        width: `${150 * (1 - 2 * inset)}%`,
        height: `${150 * (1 - 2 * inset)}%`,
        left: `${-25 + 150 * inset}%`,
        top: `${-25 + 150 * inset}%`,
      });
      box.append(bg, fg);
    } else {
      const name = (app && app.name) || '?';
      let hash = 0;
      for (const ch of name) hash = (hash * 31 + ch.charCodeAt(0)) | 0;
      const hues = [18, 32, 145, 200, 225, 262, 330];
      box.append(el('span', { class: 'icon-letter', style: { background: `hsl(${hues[Math.abs(hash) % hues.length]} 45% 38%)` } }, name.trim()[0].toUpperCase()));
    }
    return box;
  }

  function bytes(n) {
    if (!n && n !== 0) return '';
    if (n < 1024 * 1024) return `${Math.max(1, Math.round(n / 1024))} KB`;
    if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(n < 10 * 1024 * 1024 ? 1 : 0)} MB`;
    return `${(n / 1024 / 1024 / 1024).toFixed(1)} GB`;
  }

  function ago(t) {
    const s = Math.round((Date.now() - t) / 1000);
    if (s < 60) return 'just now';
    if (s < 3600) return `${Math.floor(s / 60)} min ago`;
    if (s < 86400) return `${Math.floor(s / 3600)} h ago`;
    const d = Math.floor(s / 86400);
    return d === 1 ? 'yesterday' : `${d} days ago`;
  }

  let toastTimer;
  function toast(text, ms = 2600) {
    let t = document.getElementById('toast');
    if (!t) {
      t = el('div', { id: 'toast', class: 'toast', role: 'status' });
      document.body.append(t);
    }
    t.textContent = text;
    t.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => t.classList.remove('show'), ms);
  }

  async function api(path, opts = {}) {
    const res = await fetch(path, opts);
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw Object.assign(new Error(body.error || `Request failed (${res.status})`), { status: res.status });
    return body;
  }

  async function copy(text) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
      const ta = el('textarea', { style: { position: 'fixed', opacity: '0' } });
      ta.value = text;
      document.body.append(ta);
      ta.select();
      const ok = document.execCommand('copy');
      ta.remove();
      return ok;
    }
  }

  return { library, el, icon, bytes, ago, toast, api, copy };
})();
