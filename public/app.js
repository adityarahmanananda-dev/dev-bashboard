const $ = (sel) => document.querySelector(sel);

const state = {
  projects: [],
  scanRoot: null,
  listening: [],
  running: [],
  reserved: [],
  setups: [],
  logProject: null,
  logs: {},
  env: null,
  upwork: { jobs: [], dir: null, opencode: false, ai: true, busy: false, sort: 'combined' }
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

/* ---------- env ---------- */

function envLabel(env) {
  if (!env?.kind) {
    const detected = (env?.kinds || []).find(k => k.id === env?.detected);
    return detected ? `auto (${detected.label})` : 'tidak diketahui';
  }
  const k = (env.kinds || []).find(k => k.id === env.kind);
  return env.override && env.kind !== env.detected ? `${k?.label} ⚡` : k?.label || env.kind;
}

function renderEnvChip() {
  const el = $('#env-btn');
  if (!state.env) return;
  el.textContent = `🖥 ${envLabel(state.env)}`;
  el.title = `${state.env.note} — ${state.env.override ? 'override dipilih manual' : 'terdeteksi otomatis'}. Klik untuk ubah.`;
}

async function loadEnv() {
  try {
    state.env = await api('/env');
    renderEnvChip();
    if (!state.env.kind) {
      toast('Lingkungan OS tidak terdeteksi — pilih manual', 'warn');
      openEnvModal(true);
    }
  } catch (e) {
    toast(`Gagal ambil environment: ${e.message}`, 'error');
  }
}

function openEnvModal(force = false) {
  const env = state.env || { kind: null, detected: null, kinds: [] };
  const note = $('#env-detect-note');
  note.textContent = `Terdeteksi: ${env.note || '—'}` +
    (env.override ? ` · saat ini di-override ke ${envLabel(env)}` : '');
  const choices = [{ id: null, label: 'Otomatis (ikuti deteksi)' }, ...(env.kinds || [])];
  const current = env.override ? env.kind : null;
  $('#env-options').innerHTML = choices.map(c => `
    <label class="env-option">
      <input type="radio" name="env-kind" value="${c.id === null ? 'auto' : c.id}" ${(c.id === null ? current == null : c.id === current) ? 'checked' : ''} />
      <span>${c.label}</span>
    </label>
  `).join('');
  $('#env-modal').classList.remove('hidden');
  if (force) $('#env-modal-close').style.display = 'none';
  else $('#env-modal-close').style.display = '';
}

async function saveEnv() {
  const sel = document.querySelector('input[name="env-kind"]:checked');
  if (!sel) return;
  const kind = sel.value === 'auto' ? null : sel.value;
  try {
    state.env = await api('/env', { method: 'POST', body: { kind } });
    renderEnvChip();
    $('#env-modal').classList.add('hidden');
    $('#env-modal-close').style.display = '';
    toast(`Environment: ${envLabel(state.env)}`);
    await refresh();
  } catch (e) {
    toast(e.message, 'error');
  }
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
    const readyTxt = p.deps.ready === true ? '✓ siap' : p.deps.ready === false ? '✗ belum terinstal' : '—';
    const targetTxt = p.deps.id === 'pip' ? `venv <b>${esc(p.deps.target)}</b>` : esc(p.deps.target);
    const parts = [
      `📦 <b>${esc(p.deps.file)}</b> <span class="muted">(${esc(p.deps.label)})</span>`,
      `${targetTxt}: ${readyTxt}`
    ];
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
      ${p.deps && p.deps.ready !== true
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
  $('#log-drawer').scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  api(`/projects/${encodeURIComponent(name)}/logs`).then(d => {
    state.logs[name] = d.lines;
    $('#log-content').textContent = d.lines.join('\n');
    $('#log-content').scrollTop = $('#log-content').scrollHeight;
  }).catch(() => {});
}

/* ---------- tabs ---------- */

function switchTab(name) {
  document.querySelectorAll('.tab').forEach(t => t.classList.toggle('active', t.dataset.tab === name));
  $('#projects-panel').classList.toggle('hidden', name !== 'projects');
  $('#upwork-panel').classList.toggle('hidden', name !== 'upwork');
  if (name === 'upwork') loadUpworkStatus();
}

/* ---------- upwork ---------- */

async function loadUpworkStatus() {
  try {
    const s = await api('/upwork/status');
    state.upwork.dir = s.dir;
    state.upwork.opencode = !!s.opencode;
    $('#upwork-dir').textContent = s.dir;
    $('#upwork-ai').disabled = !s.opencode;
    if (!s.opencode) {
      $('#upwork-ai').checked = false;
      $('#upwork-ai').title = 'opencode tidak terdeteksi — proposal akan pakai template';
    }
  } catch (e) {
    toast(`Gagal ambil status upwork: ${e.message}`, 'error');
  }
}

function setBusy(busy, label = '…') {
  state.upwork.busy = busy;
  $('#upwork-scan-btn').disabled = busy;
  $('#upwork-match-btn').disabled = busy;
  $('#upwork-summary').textContent = busy ? label : '';
}

async function scanUpwork(fetchNow) {
  if (state.upwork.busy) return;
  if (fetchNow) {
    setBusy(true, '⏳ Menyiapkan fetch…');
    try {
      const r = await api('/upwork/scan', { method: 'POST', body: { fetch: true } });
      if (r.taskId) pollScanTask(r.taskId);
      else await applyScanResult(r);
    } catch (e) {
      toast(e.message, 'error');
      $('#upwork-summary').textContent = e.message;
      setBusy(false);
    }
    return;
  }
  setBusy(true, '⏳ Match hasil terakhir…');
  try {
    const r = await api('/upwork/scan', { method: 'POST', body: { fetch: false } });
    await applyScanResult(r, 'Match selesai');
  } catch (e) {
    toast(e.message, 'error');
    $('#upwork-summary').textContent = e.message;
  } finally {
    setBusy(false);
  }
}

async function applyScanResult(r, label = 'Scan selesai') {
  state.upwork.jobs = r.jobs || [];
  $('#upwork-dir').textContent = r.dir;
  renderUpwork();
  const n = (r.jobs || []).length;
  toast(`${label}: ${n} lowongan cocok`);
}

async function pollScanTask(taskId, attempts = 0) {
  let rec;
  try {
    rec = await api(`/upwork/task/${encodeURIComponent(taskId)}`);
  } catch {
    if (attempts > 150) { toast('Gagal memantau scan', 'error'); setBusy(false); return; }
    setTimeout(() => pollScanTask(taskId, attempts + 1), 3000);
    return;
  }
  const p = rec.progress || {};
  $('#upwork-summary').textContent =
    `⏳ Scan: ${p.done ?? '?'}/${p.total ?? '?'} halaman diproses — ${rec.lastLine || '…'}`;
  if (rec.status === 'running') {
    if (attempts > 300) { toast('Timeout scan', 'error'); setBusy(false); return; }
    setTimeout(() => pollScanTask(taskId, attempts + 1), 3000);
    return;
  }
  if (rec.status === 'error') {
    const msg = rec.lastLine || 'Scan gagal';
    toast('Scan gagal', 'error');
    $('#upwork-summary').textContent = msg;
    setBusy(false);
    return;
  }
  setBusy(false);
  try {
    const r = await api('/upwork/scan', { method: 'POST', body: { fetch: false } });
    await applyScanResult(r);
  } catch (e) {
    toast(e.message, 'error');
    $('#upwork-summary').textContent = e.message;
  }
}

function renderUpwork() {
  const jobs = [...state.upwork.jobs];
  const sortKey = state.upwork.sort === 'cuanScore' ? 'cuanScore' : state.upwork.sort === 'winScore' ? 'winScore' : 'combined';
  jobs.sort((a, b) => (b[sortKey] ?? 0) - (a[sortKey] ?? 0));
  $('#upwork-empty').classList.toggle('hidden', jobs.length > 0);
  const totalBudget = jobs.filter(j => j.job?.type === 'fixed').reduce((s, j) => s + (j.job.fixedBudget || 0), 0);
  $('#upwork-summary').textContent =
    `${jobs.length} lowongan cocok · total fixed budget $${totalBudget.toLocaleString()} · ${new Date().toLocaleTimeString()}`;
  const grid = $('#upwork-grid');
  grid.innerHTML = '';
  for (const jr of jobs) grid.appendChild(renderUpworkCard(jr));
}

function fmtMoney(v) {
  const n = Number(v) || 0;
  return n >= 1000 ? `$${(n / 1000).toFixed(n >= 10000 ? 1 : 2)}k` : `$${n}`;
}

function renderUpworkCard(jr) {
  const j = jr.job || {};
  const card = document.createElement('div');
  card.className = 'card upwork-card';
  card.dataset.jobId = j.id || '';

  const client = j.client || {};
  const skillBadges = (j.skills || []).map(s => `<span class="badge highlight">${esc(s)}</span>`).join('');
  const matchedBadges = (jr.skills || []).map(s =>
    `<span class="badge" title="${esc((jr.matched?.[s] || []).join(', '))}">✓ ${esc(s)}</span>`).join('');
  const verified = client.paymentVerified ? '<span class="badge db online">✓ verified</span>' : '<span class="badge">unverified</span>';
  const estVal = jr.estValue > 0 ? fmtMoney(jr.estValue) : '—';
  const win = jr.winScore >= 0 ? `${jr.winScore}%` : '—';
  const apl = jr.estApplicants > 0 ? `~${jr.estApplicants} pelamar` : '';

  card.innerHTML = `
    <div class="card-head">
      <div class="card-name">${esc(j.title || '(tanpa judul)')}</div>
      <div class="score-group">
        <span class="score-pill cuan" title="Skor cuan (nilai proyek + kualitas client)">💰 ${jr.cuanScore ?? 0}</span>
        <span class="score-pill win" title="Perkiraan peluang menang (kecocokan + kompetisi + client + kebaruan)">🎯 ${win}</span>
      </div>
    </div>
    <div class="card-desc" title="${esc(j.description || '')}">${esc(j.description || '')}</div>
    <div class="badges">
      <span class="badge highlight">💵 ${esc(jr.budget || '—')}</span>
      <span class="badge cuan-badge" title="Estimasi nilai proyek (fixed = budget; hourly = rate × jam × durasi)">💰 ${estVal}</span>
      ${apl ? `<span class="badge">${esc(apl)}</span>` : ''}
      ${j.duration ? `<span class="badge">${esc(j.duration)}</span>` : ''}
      ${verified}
    </div>
    ${skillBadges ? `<div class="badges">${skillBadges}</div>` : ''}
    ${matchedBadges ? `<div class="badges">${matchedBadges}</div>` : ''}
    <div class="detected-note">Skor cocok ${jr.score} · Client: ${esc(client.country || '?')} · spent $${client.totalSpent || 0} · hires ${client.totalHires || 0}</div>
    <div class="card-actions">
      <a class="btn" href="${esc(j.url || '#')}" target="_blank" rel="noopener">↗ Buka Job</a>
      <button class="btn btn-primary" data-proposal="${esc(j.id || '')}">✍️ Proposal</button>
      <button class="btn" data-portfolio="${esc(j.id || '')}" title="Buat prompt AI-agent untuk membuat project portfolio pembuktian">🤖 Prompt Portfolio</button>
    </div>
  `;
  return card;
}

async function genProposal(id, force = false) {
  const jr = state.upwork.jobs.find(x => (x.job?.id || '') === id);
  if (!jr) return toast('Job tidak ditemukan', 'error');
  const title = `✍️ Proposal — ${jr.job.title}`;
  $('#result-regenerate').classList.add('hidden');
  openResult(title, state.upwork.ai ? 'AI (opencode) — menulis…' : 'template', '', { bid: bidSuggestion(jr.job) });
  $('#result-copy').disabled = true;
  try {
    const r = await api('/upwork/proposal', { method: 'POST', body: { job: jr.job, ai: state.upwork.ai, force } });
    if (r.taskId) {
      pollTask(r.taskId, title, jr.job.id);
    } else if (r.cached) {
      openResult(title, `${r.source === 'ai' ? 'AI' : 'template'} (sudah ada) · ${r.savedTo}`, r.text, { bid: bidSuggestion(jr.job) });
      $('#result-copy').disabled = false;
      $('#result-regenerate').classList.remove('hidden');
      $('#result-regenerate').dataset.jobId = id;
    } else {
      openResult(title, `${r.source === 'ai' ? 'AI (opencode)' : 'template'} · ${r.savedTo}`, r.text, { bid: bidSuggestion(jr.job) });
      $('#result-copy').disabled = false;
    }
  } catch (e) {
    openResult(title, 'gagal', `Error: ${e.message}`, { bid: bidSuggestion(jr.job) });
    $('#result-copy').disabled = false;
  }
}

function niceStep(v) {
  if (v >= 1000) return 50;
  if (v >= 100) return 10;
  return 5;
}

function niceBid(v) {
  if (!(v > 0)) return 0;
  const step = niceStep(v);
  return Math.max(step, Math.round(v / step) * step);
}

function niceRate(v) {
  if (!(v > 0)) return 0;
  return Math.max(5, Math.round(v / 5) * 5);
}

function engagementHours(engagement) {
  const e = (engagement || '').toLowerCase();
  if (e.includes('30+') || e.includes('more than 30')) return 35;
  if (e.includes('less than 30')) return 20;
  if (e.includes('30')) return 30;
  return 25;
}

function rateIncrease(dur, rate) {
  const d = (dur || '').toLowerCase();
  const freq = d.includes('more than 6') || d.includes('6+') || d.includes('3 to 6')
    ? 'Every 6 months'
    : 'Every year';
  const pct = rate >= 60 ? 5 : 10;
  return { freq, pct };
}

function bidSuggestion(job) {
  const dur = job.duration || '';
  const fixed = job.type === 'fixed' || Number(job.fixedBudget) > 0;
  if (fixed) {
    const budget = Number(job.fixedBudget) || 0;
    const bid = niceBid(budget * 0.95);
    const fee = bid * 0.10;
    const receive = bid - fee;
    const multiPhase = budget >= 1000 || /1 to 3|3 to 6|more than 6/i.test(dur);
    return {
      kind: 'fixed',
      budget,
      payment: multiPhase ? 'By milestone' : 'By project',
      paymentReason: multiPhase
        ? 'Nilai proyek cukup besar / bertahap — pembayaran per milestone lebih aman & transparan.'
        : 'Proyek kecil & sekali jadi — By project lebih sederhana dan cepat.',
      bid,
      fee,
      receive,
      duration: dur || '1 to 3 months',
      durationReason: 'Ikut durasi yang client cantumkan di postingan.',
    };
  }
  const min = Number(job.hourlyMin) || 0;
  const max = Number(job.hourlyMax) || 0;
  const rate = max > min ? niceRate((min + max) / 2) : (min ? niceRate(min) : 0);
  const hours = engagementHours(job.engagement);
  const inc = rateIncrease(dur, rate);
  return {
    kind: 'hourly',
    range: min && max ? `${min}–${max}` : (min ? `${min}+` : '—'),
    rate,
    weekly: rate * hours,
    monthly: rate * hours * 4,
    duration: dur || '1 to 3 months',
    increaseFreq: inc.freq,
    increasePct: inc.pct,
  };
}

function renderBidPanel(bid) {
  const el = $('#result-bid');
  if (!bid) { el.classList.add('hidden'); $('#result-copy-bid').classList.add('hidden'); return; }
  el.innerHTML = bid.kind === 'fixed' ? `
    <div class="bid-cell"><span class="bid-label">Pembayaran</span><span class="bid-val">${esc(bid.payment)}</span><span class="bid-hint">${esc(bid.paymentReason)}</span></div>
    <div class="bid-cell"><span class="bid-label">Jumlah bid</span><span class="bid-val">$${bid.bid.toFixed(2)}</span><span class="bid-hint">95% dari budget client ($${bid.budget.toFixed(2)})</span></div>
    <div class="bid-cell"><span class="bid-label">Fee 10%</span><span class="bid-val neg">-$${bid.fee.toFixed(2)}</span><span class="bid-hint">Freelancer Service Fee</span></div>
    <div class="bid-cell"><span class="bid-label">Kamu terima</span><span class="bid-val pos">$${bid.receive.toFixed(2)}</span><span class="bid-hint">Setelah fee</span></div>
    <div class="bid-cell"><span class="bid-label">Durasi</span><span class="bid-val">${esc(bid.duration)}</span><span class="bid-hint">${esc(bid.durationReason)}</span></div>
  ` : `
    <div class="bid-cell"><span class="bid-label">Jenis</span><span class="bid-val">Hourly — Upwork minta rate/jam</span><span class="bid-hint">Rentang client: ${esc(bid.range)}</span></div>
    <div class="bid-cell"><span class="bid-label">Rate disarankan</span><span class="bid-val">$${bid.rate}/jam</span><span class="bid-hint">Tengah rentang client</span></div>
    <div class="bid-cell"><span class="bid-label">Nilai per minggu</span><span class="bid-val">~$${bid.weekly.toLocaleString()}</span><span class="bid-hint">Pada 20–35 jam/minggu</span></div>
    <div class="bid-cell"><span class="bid-label">Nilai per bulan</span><span class="bid-val">~$${bid.monthly.toLocaleString()}</span><span class="bid-hint">Estimasi 4 minggu</span></div>
    <div class="bid-cell"><span class="bid-label">Naik rate tiap</span><span class="bid-val">${esc(bid.increaseFreq)}</span><span class="bid-hint">Schedule rate increase — ikut durasi kontrak</span></div>
    <div class="bid-cell"><span class="bid-label">Besaran kenaikan</span><span class="bid-val">${esc(bid.increasePct)}%</span><span class="bid-hint">Modest agar mudah disetujui client</span></div>
    <div class="bid-cell"><span class="bid-label">Durasi</span><span class="bid-val">${esc(bid.duration)}</span><span class="bid-hint">Ikut postingan client</span></div>
  `;
  el.classList.remove('hidden');
  $('#result-copy-bid').classList.remove('hidden');
}

function bidSummaryText(bid) {
  if (!bid) return '';
  const lines = bid.kind === 'fixed'
    ? [`Pembayaran: ${bid.payment}`, `Jumlah bid: $${bid.bid.toFixed(2)}`, `Fee 10%: -$${bid.fee.toFixed(2)}`, `Kamu terima: $${bid.receive.toFixed(2)}`, `Durasi: ${bid.duration}`]
    : [`Pembayaran: hourly (rate/jam)`, `Rate disarankan: $${bid.rate}/jam`, `Rentang client: ${bid.range}`, `Nilai per minggu (est): ~$${bid.weekly.toLocaleString()}`, `Nilai per bulan (est): ~$${bid.monthly.toLocaleString()}`, `Naik rate: tiap ${bid.increaseFreq} · +${bid.increasePct}%`, `Durasi: ${bid.duration}`];
  return lines.join('\n');
}

async function copyBid() {
  const el = $('#result-bid');
  const title = $('#result-modal-title').textContent.replace(/^✍️ Proposal — /, '');
  const text = `Saran Bid — ${title}\n${bidSummaryText(currentBid)}`;
  try {
    await navigator.clipboard.writeText(text);
    toast('Saran bid disalin');
  } catch {
    toast('Gagal menyalin', 'error');
  }
}

let currentBid = null;

async function pollTask(taskId, title, jobId, attempts = 0) {
  try {
    const rec = await api(`/upwork/task/${encodeURIComponent(taskId)}`);
    if (rec.status === 'running') {
      if (attempts > 180) {
        openResult(title, 'gagal', 'Timeout menunggu AI');
        $('#result-copy').disabled = false;
        return;
      }
      setTimeout(() => pollTask(taskId, title, jobId, attempts + 1), 3000);
      return;
    }
    if (rec.status === 'error') {
      openResult(title, 'gagal', rec.text || 'Task error');
      $('#result-copy').disabled = false;
      return;
    }
    $('#result-regenerate').classList.add('hidden');
    const jr = state.upwork.jobs.find(x => (x.job?.id || '') === jobId);
    openResult(title, `${rec.source || 'ai'} · ${rec.savedTo || ''}`, rec.text, { bid: jr ? bidSuggestion(jr.job) : null });
    $('#result-copy').disabled = false;
  } catch (e) {
    if (attempts > 60) {
      openResult(title, 'gagal', `Error: ${e.message}`);
      $('#result-copy').disabled = false;
      return;
    }
    setTimeout(() => pollTask(taskId, title, jobId, attempts + 1), 3000);
  }
}

async function genPortfolioPrompt(id) {
  const jr = state.upwork.jobs.find(x => (x.job?.id || '') === id);
  if (!jr) return toast('Job tidak ditemukan', 'error');
  openResult(`🤖 Prompt Portfolio — ${jr.job.title}`, 'menulis…', '');
  $('#result-copy').disabled = true;
  try {
    const r = await api('/upwork/portfolio-prompt', { method: 'POST', body: { job: jr.job } });
    openResult(`🤖 Prompt Portfolio — ${jr.job.title}`, `· ${r.savedTo}`, r.text);
  } catch (e) {
    openResult('Prompt Portfolio', 'gagal', `Error: ${e.message}`);
  } finally {
    $('#result-copy').disabled = false;
  }
}

function openResult(title, meta, text, opts = {}) {
  $('#result-modal-title').textContent = title;
  $('#result-meta').textContent = meta;
  $('#result-content').textContent = text;
  $('#result-regenerate').classList.add('hidden');
  currentBid = opts.bid || null;
  renderBidPanel(currentBid);
  $('#result-modal').classList.remove('hidden');
}

async function copyResult() {
  const text = $('#result-content').textContent;
  try {
    await navigator.clipboard.writeText(text);
    toast('Disalin ke clipboard');
  } catch {
    const ta = document.createElement('textarea');
    ta.value = text;
    document.body.appendChild(ta);
    ta.select();
    document.execCommand('copy');
    ta.remove();
    toast('Disalin ke clipboard');
  }
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
    toast(`Setup dependencies ${name} dimulai`);
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
  const t = e.target.closest('[data-start],[data-stop],[data-suggest],[data-logs],[data-nav],[data-native],[data-setup],[data-proposal],[data-portfolio]');
  if (!t) return;
  if (t.dataset.start) startProject(t.dataset.start);
  else if (t.dataset.native) startProject(t.dataset.native, true);
  else if (t.dataset.stop) stopProject(t.dataset.stop);
  else if (t.dataset.setup && !t.disabled) setupProject(t.dataset.setup);
  else if (t.dataset.suggest) suggestPort(t.dataset.suggest);
  else if (t.dataset.logs) openLogs(t.dataset.logs);
  else if (t.dataset.nav) browse(t.dataset.nav);
  else if (t.dataset.proposal) genProposal(t.dataset.proposal);
  else if (t.dataset.portfolio) genPortfolioPrompt(t.dataset.portfolio);
});

document.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && e.target.classList.contains('port-input')) {
    startProject(e.target.id.replace(/^port-/, ''));
  }
});

$('#rescan-btn').addEventListener('click', refresh);
$('#scan-root-btn').addEventListener('click', openFolderModal);
$('#env-btn').addEventListener('click', () => openEnvModal());
$('#env-modal-close').addEventListener('click', () => $('#env-modal').classList.add('hidden'));
$('#env-save').addEventListener('click', saveEnv);
$('#env-modal').addEventListener('click', (e) => {
  if (e.target === e.currentTarget) e.currentTarget.classList.add('hidden');
});
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

document.querySelectorAll('.tab').forEach(t =>
  t.addEventListener('click', () => switchTab(t.dataset.tab)));
$('#upwork-scan-btn').addEventListener('click', () => scanUpwork(true));
$('#upwork-match-btn').addEventListener('click', () => scanUpwork(false));
$('#upwork-ai').addEventListener('change', (e) => { state.upwork.ai = e.target.checked; });
$('#upwork-sort').addEventListener('change', (e) => { state.upwork.sort = e.target.value; renderUpwork(); });
$('#upwork-dir-btn').addEventListener('click', () => {
  const p = prompt('Path folder upwork-monitor:', state.upwork.dir || '');
  if (!p) return;
  api('/upwork/dir', { method: 'POST', body: { path: p } })
    .then(r => { state.upwork.dir = r.dir; $('#upwork-dir').textContent = r.dir; toast('Folder upwork: ' + r.dir); })
    .catch(e => toast(e.message, 'error'));
});
$('#result-close').addEventListener('click', () => $('#result-modal').classList.add('hidden'));
$('#result-copy').addEventListener('click', copyResult);
$('#result-copy-bid').addEventListener('click', copyBid);
$('#result-regenerate').addEventListener('click', (e) => {
  const jobId = e.currentTarget.dataset.jobId;
  if (jobId) genProposal(jobId, true);
});
$('#result-modal').addEventListener('click', (e) => {
  if (e.target === e.currentTarget) e.currentTarget.classList.add('hidden');
});

/* ---------- init ---------- */

(async function init() {
  const cfg = await api('/config').catch(() => null);
  connectWs();
  await loadEnv();
  await loadPortsMeta();
  await refresh();
  await loadUpworkStatus();
})();
