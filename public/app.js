const $ = (sel) => document.querySelector(sel);

const state = {
  projects: [],
  scanRoot: null,
  listening: [],
  running: [],
  reserved: [],
  setups: [],
  logProject: null,
  logs: {}
};

/* ---------- helpers ---------- */

async function api(path, opts = {}) {
  const res = await fetch(`/api${path}`, {
    headers: { 'Content-Type': 'application/json' },
    ...opts,
    body: opts.body ? JSON.stringify(opts.body) : undefined
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(json.error || `HTTP ${res.status}`);
  return json;
}

function toast(msg, type = 'ok') {
  const el = document.createElement('div');
  el.className = `toast ${type}`;
  el.textContent = msg;
  $('#toast-container').appendChild(el);
  setTimeout(() => { el.style.opacity = '0'; el.style.transition = 'opacity .3s'; }, 3600);
  setTimeout(() => el.remove(), 4000);
}

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

/* ---------- data ---------- */

async function refresh() {
  try {
    const data = await api('/projects');
    state.projects = data.projects;
    state.scanRoot = data.scanRoot;
    state.listening = data.listening;
    state.running = data.running;
    state.setups = data.setups || [];
    render();
  } catch (e) {
    toast(`Gagal scan: ${e.message}`, 'error');
  }
}

async function loadPortsMeta() {
  const data = await api('/ports/used');
  state.reserved = data.reserved;
  $('#reserved-count').textContent = data.reserved.length;
  $('#reserved-list').textContent = [...data.reserved].sort((a, b) => a - b).join('  ');
}

/* ---------- render ---------- */

function render() {
  $('#scan-root-label').textContent = state.scanRoot || '—';
  $('#empty-state').classList.toggle('hidden', state.projects.length > 0);

  const runCount = state.projects.filter(p => p.status === 'running').length;
  $('#summary-bar').textContent =
    `${state.projects.length} project ditemukan · ${runCount} sedang berjalan`;

  const grid = $('#projects-grid');
  grid.innerHTML = '';
  for (const p of state.projects) grid.appendChild(renderCard(p));
  renderPortsTable();
}

function renderCard(p) {
  const card = document.createElement('div');
  card.className = `card ${p.status === 'running' ? 'running' : ''}`;
  card.dataset.name = p.name;

  const isRunning = p.status === 'running';
  const isDocker = p.recipe?.type === 'docker';
  const runInfo = state.running.find(r => r.path === p.path);
  const actualPort = runInfo?.actualPorts?.[0] ?? null;
  const currentPort = isRunning ? (actualPort ?? runInfo?.port) : null;
  const portDiffers = isRunning && actualPort != null && runInfo?.port != null && actualPort !== runInfo.port;
  const shownPort = currentPort ?? p.chosenPort ?? p.detectedPorts?.[0] ?? '';

  const badges = (p.stacks || [])
    .map(s => `<span class="badge ${/Flask|FastAPI|Django|Go|Node|Electron|React|Vue|Svelte|Next/.test(s) ? 'highlight' : ''}">${esc(s)}</span>`)
    .join('');

  const HOSTING_ICON = { online: '☁️', docker: '🐳', local: '🖥️', file: '📄' };
  const HOSTING_LABEL = { online: 'online', docker: 'docker lokal', local: 'lokal', file: 'file lokal' };
  const dbBadges = (p.databases || [])
    .map(d => {
      const detail = d.provider || d.detail;
      const title = d.detail && d.detail !== d.provider ? `${d.engine} — ${d.hosting} (${d.detail})` : `${d.engine} — ${HOSTING_LABEL[d.hosting]}`;
      return `<span class="badge db ${esc(d.hosting)}" title="${esc(title)}">🗄 ${esc(d.engine)} · ${HOSTING_ICON[d.hosting]} ${esc(d.provider ? d.provider : HOSTING_LABEL[d.hosting])}</span>`;
    })
    .join('');

  const setupInfo = state.setups.find(s => s.path === p.path);
  const setupRunning = !!setupInfo && !setupInfo.exited;

  let depsNote = '';
  if (p.deps) {
    const parts = [`🐍 <b>${esc(p.deps.file)}</b>`];
    parts.push(p.deps.venvExists ? `venv <b>${esc(p.deps.venvName)}</b> siap` : `venv <b>${esc(p.deps.venvName)}</b> belum ada`);
    if (p.deps.venvExists) parts.push(p.deps.depsOk ? 'deps ✓' : 'deps ✗ belum lengkap');
    if (setupRunning) parts.push(`⟳ setup ${setupInfo.progress || ''}`);
    depsNote = `<div class="detected-note">${parts.join(' · ')}</div>`;
  }

  let portNote = '';
  if (p.runnable && isDocker) {
    const maps = (p.recipe.mappings || []).map(m => `${m.hostPort}→${m.containerPort}`).join(', ');
    portNote = `<div class="detected-note">🐳 <b>docker compose</b>${maps ? ` · port host di compose: <b>${esc(maps)}</b>` : ' · tanpa port terpublikasi'}${p.altRecipe ? ' · bisa juga native' : ''}</div>`;
  } else if (p.runnable) {
    if (p.recipe?.portMode === 'none') {
      portNote = `<div class="detected-note">⚠️ Port tidak bisa dioverride untuk project ini${p.detectedPorts.length ? ` (default <b>${p.detectedPorts[0]}</b>)` : ''}</div>`;
    } else if (p.detectedPorts.length) {
      portNote = `<div class="detected-note">Port terdeteksi di config/kode: <b>${p.detectedPorts.join(', ')}</b></div>`;
    }
  }

  card.innerHTML = `
    <div class="card-head">
      <div class="card-name">${esc(p.name)} ${p.branch ? `<span class="branch">${esc(p.branch)}</span>` : ''}</div>
      <span class="status-pill status-${isRunning ? 'running' : p.exitCode != null ? 'error' : 'stopped'}">
        ${isRunning ? (runInfo?.building ? '⟳ build…' : `● jalan :${currentPort}`) : '○ berhenti'}
      </span>
    </div>
    <div class="card-desc" title="${esc(p.description || '')}">${esc(p.description || '')}</div>
    <div class="badges">${badges}</div>
    ${dbBadges ? `<div class="badges">${dbBadges}</div>` : ''}
    ${depsNote}
    ${portNote}
    ${isRunning ? `
      <div class="port-row">
        <span class="port-label">Berjalan di</span>
        <a class="mono" href="http://127.0.0.1:${currentPort}" target="_blank" rel="noopener">http://127.0.0.1:${currentPort}</a>
        ${portDiffers ? `<span class="muted small" title="App ini mengabaikan port yang diminta dan memakai port bawaannya">⚠ diminta :${runInfo.port}</span>` : ''}
        ${runInfo?.adopted ? '<span class="muted small">(diadopsi dari sesi sebelumnya)</span>' : ''}
      </div>
    ` : `
      <div class="port-row">
        <label class="port-label" for="port-${esc(p.name)}">Port</label>
        <input id="port-${esc(p.name)}" class="port-input mono" type="number"
               min="1024" max="65535" value="${shownPort}" placeholder="1024–65535" />
        <button class="btn suggest-btn" title="Sarankan port yang bebas pakai" data-suggest="${esc(p.name)}">🎲 cari</button>
      </div>
      <div class="conflict-msg" hidden></div>
    `}
    <div class="card-actions">
      ${setupRunning ? `<button class="btn btn-danger" data-stop="${esc(p.name)}">■ Stop Setup</button>` : ''}
      ${isRunning
        ? `<button class="btn btn-danger" data-stop="${esc(p.name)}">■ Stop</button>`
        : `${!setupRunning ? `<button class="btn btn-primary" data-start="${esc(p.name)}">▶ Start${isDocker ? ' (Docker)' : ''}</button>` : ''}
           ${!setupRunning && p.altRecipe ? `<button class="btn" title="Jalan tanpa docker: ${esc(p.altRecipe.argv.join(' '))}" data-native="${esc(p.name)}">⚡ Native</button>` : ''}`}
      ${p.deps && (!p.deps.venvExists || p.deps.depsOk === false)
        ? `<button class="btn" data-setup="${esc(p.name)}" ${setupRunning ? 'disabled' : ''}>${setupRunning ? '⏳ Setup…' : '🛠 Setup'}</button>` : ''}
      <button class="btn btn-ghost" data-logs="${esc(p.name)}">▤ Log</button>
      ${isRunning ? `<a class="btn btn-ghost" href="http://127.0.0.1:${currentPort}" target="_blank" rel="noopener">↗ Buka</a>` : ''}
    </div>
  `;
  return card;
}

function renderPortsTable() {
  const tbody = $('#ports-used-body');
  const managedByPort = new Map(state.running.map(r => [r.port, r]));
  const rows = [];
  for (const l of state.listening.sort((a, b) => a.port - b.port)) {
    const managed = managedByPort.get(l.port);
    rows.push(`
      <tr>
        <td>${l.port}</td>
        <td>${esc(l.process || '?')}${l.pid ? ` <span class="muted">#${l.pid}</span>` : ''}</td>
        <td>${managed ? `<span class="managed-tag">project</span>` : ''}</td>
      </tr>`);
  }
  tbody.innerHTML = rows.join('') || '<tr><td colspan="3" class="muted">Tidak ada port yang listening</td></tr>';
}

function appendLogs(name, lines) {
  state.logs[name] = [...(state.logs[name] || []), ...lines].slice(-800);
  if (state.logProject === name) {
    const box = $('#log-content');
    const stick = $('#autoscroll-toggle').checked &&
      box.scrollTop + box.clientHeight >= box.scrollHeight - 40;
    box.textContent = state.logs[name].join('\n');
    if (stick) box.scrollTop = box.scrollHeight;
  }
}

function openLogs(name) {
  state.logProject = name;
  state.logs[name] = [];
  $('#log-title').textContent = name;
  $('#log-meta').textContent = '';
  $('#log-content').textContent = '';
  $('#log-drawer').classList.remove('hidden');
  api(`/projects/${encodeURIComponent(name)}/logs`).then(d => {
    state.logs[name] = d.lines;
    $('#log-content').textContent = d.lines.join('\n');
    $('#log-content').scrollTop = $('#log-content').scrollHeight;
  }).catch(() => {});
}

/* ---------- actions ---------- */

async function startProject(name, native = false) {
  const input = document.querySelector(`[data-port-for="${name}"], #port-${CSS.escape(name)}`);
  const port = parseInt(input?.value, 10);
  const card = document.querySelector(`.card[data-name="${CSS.escape(name)}"]`);
  const conflictEl = card?.querySelector('.conflict-msg');
  if (conflictEl) conflictEl.hidden = true;

  if (!native && !Number.isInteger(port)) {
    toast('Isi port dulu (1024–65535)', 'warn');
    return;
  }
  try {
    const r = await api(`/projects/${encodeURIComponent(name)}/start`, { method: 'POST', body: { port, native } });
    if (r.warning) toast(r.warning, 'warn');
    else toast(`${name} start${port ? ` di port ${port}` : ''}`);
    openLogs(name);
  } catch (e) {
    if (conflictEl) { conflictEl.textContent = e.message; conflictEl.hidden = false; }
    toast(e.message, 'error');
  }
  await refresh();
}

async function stopProject(name) {
  try {
    await api(`/projects/${encodeURIComponent(name)}/stop`, { method: 'POST' });
    toast(`${name} dihentikan`);
  } catch (e) {
    toast(e.message, 'error');
  }
  await refresh();
}

async function setupProject(name) {
  try {
    await api(`/projects/${encodeURIComponent(name)}/setup`, { method: 'POST' });
    toast(`Setup ${name} dimulai — venv + install dependencies`);
    openLogs(name);
  } catch (e) {
    toast(e.message, 'error');
  }
  await refresh();
}

async function suggestPort(name) {
  const exclude = state.projects
    .filter(p => p.name !== name)
    .map(p => parseInt(document.querySelector(`#port-${CSS.escape(p.name)}`)?.value, 10))
    .filter(Number.isInteger);
  try {
    const r = await api('/ports/suggest', { method: 'POST', body: { exclude } });
    if (!r.suggestions.length) return toast('Tidak menemukan port kosong, coba lagi', 'warn');
    const input = document.querySelector(`#port-${CSS.escape(name)}`);
    input.value = r.suggestions[0];
    input.title = 'Alternatif: ' + r.suggestions.slice(1).join(', ');
    toast(`Port ${r.suggestions[0]} bebas dipakai`);
  } catch (e) {
    toast(e.message, 'error');
  }
}

/* ---------- folder picker modal ---------- */

let browsePath = null;

async function browse(target) {
  try {
    const data = await api(`/browse?path=${encodeURIComponent(target ?? '')}`);
    browsePath = data;
    $('#browse-breadcrumb').innerHTML =
      `<span class="go-up" style="cursor:pointer">${data.home.startsWith(data.path) ? '' : ''}${esc(data.path)}</span>`;
    const items = [];
    if (data.parent) items.push(`<li data-nav="${esc(data.parent)}"><span>↩ ..</span><span class="go-up">naik ke atas</span></li>`);
    for (const d of data.dirs) items.push(`<li data-nav="${esc(data.path.replace(/\/$/, '') + '/' + d)}"><span>📁 ${esc(d)}</span></li>`);
    $('#dir-list').innerHTML = items.join('');
    $('#manual-path').value = data.path;
  } catch (e) {
    toast(e.message, 'error');
  }
}

function openFolderModal() {
  browse(state.scanRoot);
  $('#folder-modal').classList.remove('hidden');
}

async function pickFolder() {
  const chosen = $('#manual-path').value.trim() || browsePath?.path;
  if (!chosen) return;
  try {
    const r = await api('/scan-root', { method: 'POST', body: { path: chosen } });
    state.scanRoot = r.scanRoot;
    $('#folder-modal').classList.add('hidden');
    toast(`Folder scan: ${r.scanRoot}`);
    await refresh();
  } catch (e) {
    toast(e.message, 'error');
  }
}

/* ---------- websocket ---------- */

function connectWs() {
  const ws = new WebSocket(`ws://${location.host}/ws`);
  const dot = $('#ws-status');
  ws.onopen = () => dot.classList.add('online');
  ws.onclose = () => {
    dot.classList.remove('online');
    setTimeout(connectWs, 2000);
  };
  ws.onmessage = (ev) => {
    const msg = JSON.parse(ev.data);
    if (msg.type === 'log') appendLogs(msg.name, msg.lines);
    if (msg.type === 'status') refresh();
    if (msg.type === 'hello' && msg.running?.length) {
      for (const r of msg.running) state.logs[r.name] = state.logs[r.name] || [];
    }
  };
}

/* ---------- events ---------- */

document.addEventListener('click', (e) => {
  const t = e.target.closest('[data-start],[data-stop],[data-suggest],[data-logs],[data-nav],[data-native],[data-setup]');
  if (!t) return;
  if (t.dataset.start) startProject(t.dataset.start);
  else if (t.dataset.native) startProject(t.dataset.native, true);
  else if (t.dataset.stop) stopProject(t.dataset.stop);
  else if (t.dataset.setup && !t.disabled) setupProject(t.dataset.setup);
  else if (t.dataset.suggest) suggestPort(t.dataset.suggest);
  else if (t.dataset.logs) openLogs(t.dataset.logs);
  else if (t.dataset.nav) browse(t.dataset.nav);
});

document.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && e.target.classList.contains('port-input')) {
    startProject(e.target.id.replace(/^port-/, ''));
  }
});

$('#rescan-btn').addEventListener('click', refresh);
$('#scan-root-btn').addEventListener('click', openFolderModal);
$('#folder-modal-close').addEventListener('click', () => $('#folder-modal').classList.add('hidden'));
$('#folder-modal').addEventListener('click', (e) => {
  if (e.target === e.currentTarget) e.currentTarget.classList.add('hidden');
});
$('#manual-path-go').addEventListener('click', () => browse($('#manual-path').value));
$('#pick-folder').addEventListener('click', pickFolder);
$('#log-close').addEventListener('click', () => {
  $('#log-drawer').classList.add('hidden');
  state.logProject = null;
});

/* ---------- init ---------- */

(async function init() {
  const cfg = await api('/config').catch(() => null);
  connectWs();
  await loadPortsMeta();
  await refresh();
})();
