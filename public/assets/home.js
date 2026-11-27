(() => {
  const { library, el, icon, bytes, ago, toast, api, copy } = Handset;
  const $ = (id) => document.getElementById(id);
  const drop = $('drop');
  const fileInput = $('file');
  let busy = false;

  // ---------- upload ----------
  function setDrop(title, sub, progress) {
    $('dropTitle').textContent = title;
    $('dropSub').innerHTML = sub;
    $('dropProgress').style.width = progress === undefined ? '0' : `${progress}%`;
  }
  const resetDrop = () => setDrop('Drop an APK here', 'or <u>choose a file</u>. .apk, .apks or .xapk, up to 1 GB.');

  function showError(msg) {
    $('uploadError').textContent = msg;
    $('uploadError').hidden = !msg;
  }

  function upload(file) {
    if (busy || !file) return;
    showError('');
    const ext = (file.name.match(/\.[^.]+$/) || [''])[0].toLowerCase();
    if (ext === '.aab') return showError('.aab bundles cannot be installed directly. Export an APK, or a universal .apks with bundletool, and upload that.');
    if (!['.apk', '.apks', '.xapk', '.apkm'].includes(ext)) return showError('That is not an Android app. Choose an .apk, .apks or .xapk file.');
    busy = true;
    drop.classList.add('busy');
    setDrop(`Uploading ${file.name}`, `0% of ${bytes(file.size)}`, 0);

    const xhr = new XMLHttpRequest();
    xhr.open('POST', '/api/apps');
    xhr.setRequestHeader('X-File-Name', encodeURIComponent(file.name));
    xhr.setRequestHeader('Content-Type', 'application/octet-stream');
    xhr.upload.onprogress = (e) => {
      if (!e.lengthComputable) return;
      const pct = Math.round((e.loaded / e.total) * 100);
      setDrop(`Uploading ${file.name}`, `${pct}% of ${bytes(file.size)}`, pct);
      if (pct === 100) setDrop('Reading the app', 'Checking the package and pulling out its icon.', 100);
    };
    xhr.onload = () => {
      let body = {};
      try {
        body = JSON.parse(xhr.responseText);
      } catch {}
      if (xhr.status >= 200 && xhr.status < 300 && body.app) {
        library.add(body.app.id, body.ownerKey);
        setDrop(`${body.app.name} is ready`, 'Opening a phone for you…', 100);
        location.href = `/app/${body.app.id}`;
        return;
      }
      fail(body.error || `Upload failed (${xhr.status})`);
    };
    xhr.onerror = () => fail('The upload was interrupted. Check your connection and try again.');
    xhr.send(file);
  }

  function fail(msg) {
    busy = false;
    drop.classList.remove('busy');
    resetDrop();
    showError(msg);
  }

  fileInput.addEventListener('change', () => {
    upload(fileInput.files[0]);
    fileInput.value = '';
  });
  drop.addEventListener('click', (e) => {
    if (busy) e.preventDefault();
  });

  // Drop a file anywhere on the page.
  let depth = 0;
  const hasFiles = (e) => [...(e.dataTransfer?.types || [])].includes('Files');
  window.addEventListener('dragenter', (e) => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    depth++;
    document.body.classList.add('dragging');
  });
  window.addEventListener('dragleave', () => {
    depth = Math.max(0, depth - 1);
    if (!depth) document.body.classList.remove('dragging');
  });
  window.addEventListener('dragover', (e) => {
    if (hasFiles(e)) e.preventDefault();
  });
  window.addEventListener('drop', (e) => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    depth = 0;
    document.body.classList.remove('dragging');
    upload(e.dataTransfer.files[0]);
  });

  // ---------- library ----------
  async function renderLibrary() {
    const saved = library.all();
    if (!saved.length) return;
    let apps = [];
    try {
      ({ apps } = await api(`/api/apps?ids=${saved.map((a) => a.id).join(',')}`));
    } catch {
      return;
    }
    const found = new Set(apps.map((a) => a.id));
    for (const s of saved) if (!found.has(s.id)) library.remove(s.id);
    const order = new Map(saved.map((s, i) => [s.id, i]));
    apps.sort((a, b) => order.get(a.id) - order.get(b.id));
    if (!apps.length) return;

    const list = $('apps');
    list.replaceChildren(
      ...apps.map((app) => {
        const href = `/app/${app.id}`;
        const details = [app.versionName && `Version ${app.versionName}`, app.package, bytes(app.size), ago(app.createdAt)].filter(Boolean).join('  ·  ');
        return el(
          'li',
          { class: 'app-row' },
          el('a', { class: 'app-main', href }, icon(app, 48), el('span', { class: 'app-text' }, el('strong', {}, app.name), el('span', {}, details))),
          el(
            'div',
            { class: 'app-actions' },
            el('button', {
              class: 'btn btn-ghost',
              type: 'button',
              onclick: async () => toast((await copy(location.origin + href)) ? 'Link copied. Anyone who opens it gets their own phone.' : 'Could not copy the link'),
            }, 'Copy link'),
            el('button', {
              class: 'btn btn-quiet',
              type: 'button',
              onclick: async (e) => {
                if (!confirm(`Delete ${app.name}? Links to it will stop working.`)) return;
                try {
                  await api(`/api/apps/${app.id}`, { method: 'DELETE', headers: { 'X-Owner-Key': library.ownerKey(app.id) || '' } });
                } catch (err) {
                  if (err.status !== 404) return toast(err.message);
                }
                library.remove(app.id);
                e.target.closest('li').remove();
                if (!list.children.length) $('library').hidden = true;
              },
            }, 'Delete'),
            el('a', { class: 'btn btn-ink', href }, 'Open'),
          ),
        );
      }),
    );
    $('library').hidden = false;

    const withShot = apps.filter((a) => a.screenshot).sort((a, b) => order.get(a.id) - order.get(b.id))[0];
    if (withShot) {
      const img = new Image();
      img.onload = () => {
        $('heroShot').src = img.src;
        $('heroShot').alt = `${withShot.name} running on Android Emulator Online`;
      };
      img.src = withShot.screenshot;
    }
  }

  async function renderPool() {
    try {
      const { pool } = await api('/api/status');
      const free = Math.max(0, pool.max - pool.busy);
      $('poolNote').textContent = pool.queued ? `${pool.queued} waiting for a phone` : `${free} of ${pool.max} phones free`;
    } catch {
      $('poolNote').textContent = '';
    }
  }

  renderLibrary();
  renderPool();
  setInterval(renderPool, 10000);
})();
