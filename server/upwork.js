import express from 'express';
import { execFile, execFileSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import * as state from './state.js';

const DEFAULT_DIR = path.join(os.homedir(), 'Projects', 'upwork-monitor');

function upworkDir() {
  return process.env.UPWORK_MONITOR_DIR || state.get().upworkDir || DEFAULT_DIR;
}

function exists(p) {
  try { return fs.statSync(p).isFile(); } catch { return false; }
}

function isDir(p) {
  try { return fs.statSync(p).isDirectory(); } catch { return false; }
}

function resolveBin(name) {
  return path.join(upworkDir(), 'bin', name);
}

function findTool(name) {
  try {
    const r = execFileSync('which', [name], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    if (r && exists(r)) return r;
  } catch {}
  return null;
}

function opencodePath() {
  return findTool('opencode') || (exists(path.join(os.homedir(), '.opencode', 'bin', 'opencode'))
    ? path.join(os.homedir(), '.opencode', 'bin', 'opencode') : null);
}

function stripAnsi(s) {
  return s
    .replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, '')
    .replace(/\x1b\][^\x07]*(\x07|\x1b\\)/g, '')
    .split('\n')
    .map(l => l.replace(/\s+$/, ''))
    .filter(l => !/^\s*(>|→|├|└|│)\s/.test(l))
    .join('\n')
    .trim();
}

function parseOpenCodeJSON(stdout) {
  const parts = [];
  for (const line of (stdout || '').split('\n')) {
    const l = line.trim();
    if (!l) continue;
    let ev;
    try { ev = JSON.parse(l); } catch { continue; }
    if (ev?.type === 'text' && ev?.part?.type === 'text' && ev.part.text) {
      parts.push(ev.part.text);
    }
  }
  return parts.join('\n').trim();
}

const tasks = new Map();

function startTask(cmd, args, opts = {}) {
  const id = 'task_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
  const rec = { status: 'running', text: '', source: opts.source || '', savedTo: opts.savedTo || '' };
  tasks.set(id, rec);
  execFile(cmd, args, {
    cwd: opts.cwd || upworkDir(),
    timeout: opts.timeout || 600000,
    maxBuffer: 20 * 1024 * 1024,
    env: { ...process.env, ...(opts.env || {}) },
  }, (err, stdout, stderr) => {
    if (err) {
      rec.status = 'error';
      rec.text = (stderr || stdout || err.message || 'gagal').slice(0, 4000);
      return;
    }
    rec.status = 'done';
    rec.text = (opts.parse ? opts.parse(stdout || '') : opts.clean ? stripAnsi(stdout || '') : (stdout || '')).trim();
  }).stdin?.end(opts.input != null ? opts.input : '');
  return id;
}

function runNow(cmd, args, opts = {}) {
  return new Promise((resolve) => {
    const child = execFile(cmd, args, {
      cwd: opts.cwd || upworkDir(),
      timeout: opts.timeout || 120000,
      maxBuffer: 20 * 1024 * 1024,
      env: { ...process.env, ...(opts.env || {}) },
    }, (err, stdout, stderr) => {
      resolve({ code: err ? (err.code ?? 1) : 0, stdout: stdout || '', stderr: stderr || '' });
    });
    if (opts.input != null) child.stdin?.write(opts.input);
    child.stdin?.end();
  });
}

function run(cmd, args, opts = {}) {
  return new Promise((resolve) => {
    const child = execFile(cmd, args, {
      cwd: opts.cwd || upworkDir(),
      timeout: opts.timeout || 120000,
      maxBuffer: 20 * 1024 * 1024,
      env: { ...process.env, ...(opts.env || {}) },
    }, (err, stdout, stderr) => {
      resolve({ code: err ? (err.code ?? 1) : 0, stdout: stdout || '', stderr: stderr || '' });
    });
    if (opts.input != null) child.stdin?.write(opts.input);
    child.stdin?.end();
  });
}

async function ensureBinary() {
  const bin = resolveBin('upwork-monitor');
  if (exists(bin)) return true;
  fs.mkdirSync(path.join(upworkDir(), 'bin'), { recursive: true });
  const r = await runNow('go', ['build', '-o', path.join('bin', 'upwork-monitor'), './cmd/upwork-monitor'], { timeout: 240000 });
  return r.code === 0 && exists(bin);
}

async function ensureFetcher() {
  const bin = resolveBin('upwork-feed-fetcher');
  if (exists(bin)) return true;
  const r = await runNow('go', ['install', 'github.com/doonfrs/upwork-feed-fetcher/cmd/upwork-feed-fetcher@latest'],
    { timeout: 300000, env: { GOBIN: path.join(upworkDir(), 'bin') } });
  return r.code === 0 && exists(bin);
}

function latestFile(dir, prefix) {
  try {
    const files = fs.readdirSync(dir).filter(f => f.startsWith(prefix) && f.endsWith('.md')).sort();
    const f = files[files.length - 1];
    return f ? path.join(dir, f) : null;
  } catch { return null; }
}

function appendOutput(kind, title, text) {
  const outDir = path.join(upworkDir(), 'output');
  fs.mkdirSync(outDir, { recursive: true });
  const date = new Date().toISOString().slice(0, 10);
  const file = path.join(outDir, `${kind}_${date}.md`);
  const block = `\n## ${title}\n\n\`\`\`\n${text}\n\`\`\`\n`;
  fs.appendFileSync(file, block);
  return file;
}

function buildAIPrompt(job) {
  return `Write a tailored Upwork proposal (cover letter) for the job below, as Aditya — fullstack developer (Go backend, React/Node, Electron, PDF tooling).

Rules:
- Read my profile from config.yaml in this repo and pick the most relevant portfolio repo (config.yaml: profile.skills[].portfolio) per matched requirement.
- Plain text only. No markdown headers, no code fences, no preamble like "Here is your proposal". Start directly with the greeting.
- 3-5 short paragraphs. Mention the relevant portfolio repo(s) by URL.
- If the job lists a skill I don't fully cover, say I can show a small demo first (I have project-portfolio/ examples).

Job (JSON):
${JSON.stringify(job, null, 2)}`;
}

const router = express.Router();

router.get('/status', (req, res) => {
  res.json({
    dir: upworkDir(),
    exists: isDir(upworkDir()),
    bin: exists(resolveBin('upwork-monitor')),
    fetcher: exists(resolveBin('upwork-feed-fetcher')),
    opencode: opencodePath(),
    reports: {
      matched: latestFile(path.join(upworkDir(), 'output'), 'matched_'),
      proposals: latestFile(path.join(upworkDir(), 'output'), 'proposals_'),
      portfolioPrompts: latestFile(path.join(upworkDir(), 'output'), 'portfolio_prompts_'),
    },
  });
});

router.post('/dir', (req, res) => {
  const dir = req.body?.path;
  if (!dir) return res.status(400).json({ error: 'path wajib diisi' });
  const resolved = path.resolve(dir.replace(/^~(?=\/|$)/, os.homedir()));
  if (!isDir(resolved)) return res.status(400).json({ error: `Folder tidak valid: ${dir}` });
  state.setUpworkDir(resolved);
  res.json({ dir: upworkDir() });
});

router.post('/scan', async (req, res) => {
  const doFetch = !!req.body?.fetch;
  try {
    if (!isDir(upworkDir())) {
      return res.status(400).json({ error: `Folder upwork-monitor tidak ditemukan di ${upworkDir()}. Set lewat env UPWORK_MONITOR_DIR atau POST /api/upwork/dir.` });
    }
    if (!await ensureBinary()) {
      return res.status(500).json({ error: `Gagal build upwork-monitor di ${upworkDir()}` });
    }
    if (doFetch) {
      if (!await ensureFetcher()) {
        return res.status(500).json({ error: 'Gagal menyiapkan upwork-feed-fetcher' });
      }
      const r = await runNow(resolveBin('upwork-monitor'), ['run'], { timeout: 300000 });
      if (r.code !== 0) {
        const hint = /attach|chrome|login|cloudflare/i.test(r.stderr)
          ? ' Jalankan Chrome dulu: google-chrome --remote-debugging-port=9222 --user-data-dir="$HOME/.upwork-attach-profile" lalu login Upwork.'
          : '';
        return res.status(502).json({ error: 'Fetch gagal: ' + (r.stderr || r.stdout || 'unknown error') + hint });
      }
    }
    const r2 = await runNow(resolveBin('upwork-monitor'), ['jobs']);
    let jobs = [];
    try { jobs = JSON.parse(r2.stdout || '[]'); } catch { jobs = []; }
    res.json({ jobs, dir: upworkDir(), scannedAt: new Date().toISOString() });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.post('/proposal', async (req, res) => {
  const job = req.body?.job;
  if (!job) return res.status(400).json({ error: 'job wajib diisi' });
  const oc = opencodePath();
  const useAI = !!req.body?.ai && !!oc;
  try {
    if (!await ensureBinary()) return res.status(500).json({ error: 'Gagal build upwork-monitor' });

    if (useAI) {
      const id = startTask(oc, ['run', '--format', 'json', buildAIPrompt(job)],
        { cwd: upworkDir(), source: 'ai', parse: parseOpenCodeJSON, timeout: 600000 });
      return res.json({ taskId: id });
    }

    const r = await runNow(resolveBin('upwork-monitor'), ['proposal'], { input: JSON.stringify(job), timeout: 30000 });
    if (r.code !== 0) return res.status(502).json({ error: 'Proposal gagal: ' + (r.stderr || '') });
    const text = r.stdout.trim();
    const savedTo = appendOutput('proposals', job.title, text);
    res.json({ text, source: 'template', savedTo });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.get('/task/:id', (req, res) => {
  const rec = tasks.get(req.params.id);
  if (!rec) return res.status(404).json({ error: 'Task tidak ditemukan' });
  res.json(rec);
});

router.post('/portfolio-prompt', async (req, res) => {
  const job = req.body?.job;
  if (!job) return res.status(400).json({ error: 'job wajib diisi' });
  try {
    if (!await ensureBinary()) return res.status(500).json({ error: 'Gagal build upwork-monitor' });
    const r = await runNow(resolveBin('upwork-monitor'), ['portfolio-prompt'], { input: JSON.stringify(job), timeout: 30000 });
    if (r.code !== 0) return res.status(502).json({ error: 'Prompt gagal: ' + (r.stderr || '') });
    const text = r.stdout.trim();
    const savedTo = appendOutput('portfolio_prompts', job.title, text);
    res.json({ text, savedTo });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

export default router;