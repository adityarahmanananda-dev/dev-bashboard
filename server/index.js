import express from 'express';
import http from 'http';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';
import { WebSocketServer } from 'ws';

import { scanRoot, scanProject, listDirs } from './scanner.js';
import * as runner from './runner.js';
import * as portsMod from './ports.js';
import * as state from './state.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = parseInt(process.env.DASHBOARD_PORT || '7333', 10);
const HOST = '127.0.0.1';

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, '..', 'public')));

const api = express.Router();

api.get('/config', (req, res) => {
  res.json({ scanRoot: state.get().scanRoot, dashboardPort: PORT });
});

api.post('/scan-root', (req, res) => {
  const root = req.body?.path;
  if (!root) return res.status(400).json({ error: 'path wajib diisi' });
  const resolved = path.resolve(root.replace(/^~(?=\/|$)/, os.homedir()));
  try {
    if (!fs.statSync(resolved).isDirectory()) throw new Error();
  } catch {
    return res.status(400).json({ error: `Folder tidak valid: ${root}` });
  }
  state.setScanRoot(resolved);
  res.json({ scanRoot: resolved });
});

api.get('/browse', (req, res) => {
  try {
    res.json(listDirs(req.query.path));
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

function findProject(name) {
  const projects = scanRoot(state.get().scanRoot);
  return projects.find(p => p.name === name);
}

api.get('/projects', async (req, res) => {
  let projects;
  try {
    projects = scanRoot(state.get().scanRoot);
  } catch (e) {
    return res.status(400).json({ error: e.message });
  }
  await runner.reconcileDocker();
  const listening = await portsMod.getListeningPorts();
  const runningList = runner.listRunning().filter(r => !r.exited);
  const savedPorts = state.get().ports;

  res.json({
    scanRoot: state.get().scanRoot,
    listening,
    running: runningList,
    projects: projects.map(p => ({
      ...p,
      status: runningList.find(r => r.path === p.path) ? 'running' : 'stopped',
      chosenPort: savedPorts[p.name] ?? null
    }))
  });
});

api.post('/projects/:name/start', async (req, res) => {
  const project = findProject(req.params.name);
  if (!project) return res.status(404).json({ error: `Project "${req.params.name}" tidak ditemukan di folder scan` });

  const useNative = !!req.body?.native;
  const recipe = useNative ? project.altRecipe : project.recipe;
  if (!recipe) return res.status(400).json({ error: 'Project ini tidak punya cara start yang dikenali' });

  const isDocker = recipe.type === 'docker';
  const hasPublishedPorts = isDocker && Array.isArray(recipe.mappings) && recipe.mappings.length > 0;

  let port = parseInt(req.body?.port, 10);
  if (!hasPublishedPorts && isDocker) port = null;
  if (!portsMod.isValidPort(port)) {
    return res.status(400).json({ error: `Port tidak valid: ${req.body?.port} (harus 1024–65535)` });
  }

  const listening = await portsMod.getListeningPorts();
  const managedRunning = runner.listRunning().filter(r => !r.exited && r.path !== project.path);
  const conflict = portsMod.checkPortConflict(port, listening, managedRunning);
  if (conflict.conflict) return res.status(409).json({ error: conflict.reason, conflict: true });

  try {
    const started = runner.start(project, port, { native: useNative });
    state.setPort(project.name, port);
    broadcast({ type: 'status', name: project.name, data: started });
    res.json({ ok: true, warning: conflict.warn || null, process: started });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

api.post('/projects/:name/stop', (req, res) => {
  const projects = (() => { try { return scanRoot(state.get().scanRoot); } catch { return []; } })();
  const project = projects.find(p => p.name === req.params.name);
  const target = project?.path || runner.listRunning().find(r => r.name === req.params.name)?.path;
  if (!target) return res.status(404).json({ error: 'Project tidak sedang berjalan' });

  const entry = runner.get(target);
  const stopped = runner.stop(target);
  if (!stopped) return res.status(404).json({ error: 'Project tidak sedang berjalan' });
  broadcast({ type: 'status', name: req.params.name, data: { ...entry, exited: true } });
  res.json({ ok: true });
});

api.get('/projects/:name/logs', async (req, res) => {
  const entry = runner.findEntryByName(req.params.name);
  if (!entry) return res.json({ lines: [] });
  const lines = await runner.getLogsFor(req.params.name, entry.path);
  res.json({ lines });
});

api.get('/ports/used', async (req, res) => {
  const listening = await portsMod.getListeningPorts();
  const managed = runner.listRunning().filter(r => !r.exited);
  res.json({ listening, reserved: [...portsMod.RESERVED_PORTS], managed });
});

api.post('/ports/suggest', async (req, res) => {
  const exclude = new Set((runner.listRunning().filter(r => !r.exited)).map(r => r.port));
  for (const p of Array.isArray(req.body?.exclude) ? req.body.exclude : []) exclude.add(parseInt(p, 10));
  const count = Math.min(parseInt(req.body?.count, 10) || 6, 20);
  const suggestions = await portsMod.suggestPorts(count, exclude);
  res.json({ suggestions });
});

api.use((err, req, res, next) => res.status(500).json({ error: err.message }));

app.use('/api', api);

const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: '/ws' });

function broadcast(msg) {
  const raw = JSON.stringify(msg);
  for (const client of wss.clients) {
    if (client.readyState === 1) client.send(raw);
  }
}

runner.setOnLog((name, lines) => broadcast({ type: 'log', name, lines }));

setInterval(() => {
  const procs = runner.persistable();
  state.setProcesses(procs);
}, 5000);

wss.on('connection', (ws) => {
  ws.send(JSON.stringify({ type: 'hello', running: runner.listRunning() }));
});

state.load();
runner.adoptPersisted(state.get().processes || []);

server.listen(PORT, HOST, () => {
  console.log(`Dashboard jalan di http://${HOST}:${PORT}`);
  console.log(`Folder scan: ${state.get().scanRoot}`);
});
