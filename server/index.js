import express from 'express';
import http from 'http';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath, pathToFileURL } from 'url';
import { WebSocketServer } from 'ws';

import { scanRoot, scanProject, listDirs } from './scanner.js';
import * as runner from './runner.js';
import * as portsMod from './ports.js';
import * as state from './state.js';
import * as env from './env.js';
import { depManagerFor, checkReady, buildSteps, venvDir, markInstalled } from './deps.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const HOST = '127.0.0.1';
let currentPort = parseInt(process.env.DASHBOARD_PORT || '7333', 10);

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, '..', 'public')));

const api = express.Router();

api.get('/config', (req, res) => {
  res.json({ scanRoot: state.get().scanRoot, dashboardPort: currentPort, env: env.detect() });
});

api.get('/env', (req, res) => {
  res.json(env.detect());
});

api.post('/env', (req, res) => {
  const kind = req.body?.kind;
  if (kind !== null && !env.ENV_KINDS.includes(kind)) {
    return res.status(400).json({ error: `Env tidak dikenal: ${kind}. Pilih: ${env.ENV_KINDS.join(', ')} atau null` });
  }
  env.setKind(kind);
  state.setEnvKind(kind);
  res.json(env.detect());
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
  const { listening, byPgid } = await portsMod.getListeningByPgid();
  runner.refreshActualPorts(byPgid);
  const runningList = runner.listRunning().filter(r => !r.exited);
  const savedPorts = state.get().ports;

  await Promise.all(projects.map(async p => {
    const manager = depManagerFor(p);
    if (!manager) return;
    const ready = await checkReady(manager);
    const target = manager.id === 'pip'
      ? path.basename(venvDir(manager))
      : manager.id === 'npm' ? 'node_modules'
      : manager.id === 'gomod' ? 'module cache Go'
      : manager.id === 'maven' ? '~/.m2 repository'
      : manager.id === 'gradle' ? 'cache Gradle'
      : manager.id === 'conan' ? 'cache Conan'
      : 'vcpkg tree';
    p.deps = { id: manager.id, label: manager.label, file: manager.file, target, ready };
  }));

  res.json({
    scanRoot: state.get().scanRoot,
    listening,
    running: runningList,
    setups: runner.listSetups(),
    projects: projects.map(p => ({
      ...p,
      status: runningList.find(r => r.path === p.path) ? 'running' : 'stopped',
      chosenPort: savedPorts[p.name] ?? null
    }))
  });
});

api.post('/projects/:name/setup', async (req, res) => {
  const project = findProject(req.params.name);
  if (!project) return res.status(404).json({ error: `Project "${req.params.name}" tidak ditemukan di folder scan` });
  const manager = depManagerFor(project);
  if (!manager) {
    return res.status(400).json({ error: 'Tidak ada manifest dependencies yang dikenali (requirements/pyproject/package.json/go.mod/pom.xml/build.gradle/conanfile/vcpkg.json)' });
  }
  if (!buildSteps(manager).steps.length && !runner.getSetup(project.path)) {
    return res.status(400).json({ error: buildSteps(manager).error || 'Tool untuk setup tidak tersedia' });
  }
  try {
    const setup = runner.startSetup(project);
    broadcast({ type: 'status', name: project.name, data: setup });
    res.json({ ok: true, setup });
  } catch (e) {
    res.status(409).json({ error: e.message });
  }
});

api.post('/projects/:name/start', async (req, res) => {
  const project = findProject(req.params.name);
  if (!project) return res.status(404).json({ error: `Project "${req.params.name}" tidak ditemukan di folder scan` });

  const useNative = !!req.body?.native;
  const recipe = useNative ? project.altRecipe : project.recipe;
  if (!recipe) return res.status(400).json({ error: 'Project ini tidak punya cara start yang dikenali' });

  const isDocker = recipe.type === 'docker';
  const hasPublishedPorts = isDocker && Array.isArray(recipe.mappings) && recipe.mappings.length > 0;

  if (!isDocker && ['flask-cli', 'python-env', 'uvicorn-env'].includes(recipe.type)) {
    const manager = depManagerFor(project);
    if (manager?.id === 'pip' && manager) {
      const ready = await checkReady(manager);
      if (ready === false) {
        return res.status(400).json({
          error: `Dependencies Python belum disiapkan — klik tombol 🛠 Setup untuk membuat venv ${path.basename(venvDir(manager))} dan menginstalnya`
        });
      }
    }
  }

  let port = parseInt(req.body?.port, 10);
  if (!hasPublishedPorts && isDocker) port = null;
  if (!portsMod.isValidPort(port)) {
    return res.status(400).json({ error: `Port tidak valid: ${req.body?.port} (harus 1024–65535)` });
  }

  const fixedMode = !isDocker && recipe.portMode === 'none';
  const fixedPort = fixedMode ? project.detectedPorts?.[0] : null;
  if (fixedMode && fixedPort && port !== fixedPort) {
    return res.status(400).json({
      error: `Port tidak bisa dioverride untuk project ini (hanya bisa jalan di port bawaan ${fixedPort}). ${recipe.note || ''}`
    });
  }

  const listening = await portsMod.getListeningPorts();
  const managedRunning = runner.listRunning().filter(r => !r.exited && r.path !== project.path);
  const conflict = portsMod.checkPortConflict(port, listening, managedRunning, { allowReserved: fixedMode });
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

function broadcast(msg) {
  const raw = JSON.stringify(msg);
  for (const client of wss.clients) {
    if (client.readyState === 1) client.send(raw);
  }
}

runner.setOnLog((name, lines) => broadcast({ type: 'log', name, lines }));
runner.setOnSetupEnd((name) => broadcast({ type: 'status', name }));

const wss = new WebSocketServer({ noServer: true });
wss.on('connection', (ws) => {
  ws.send(JSON.stringify({ type: 'hello', running: runner.listRunning() }));
});

let persistTimer = null;

export function start({ port, scanRoot } = {}) {
  if (!Number.isInteger(port)) port = currentPort;
  currentPort = port;
  state.load();
  env.setKind(state.get().envKind);
  if (scanRoot) state.setScanRoot(path.resolve(scanRoot.replace(/^~(?=\/|$)/, os.homedir())));
  runner.adoptPersisted(state.get().processes || []);

  if (!persistTimer) {
    persistTimer = setInterval(() => {
      state.setProcesses(runner.persistable());
    }, 5000);
  }

  const server = http.createServer(app);
  server.on('upgrade', (req, socket, head) => {
    if (req.url === '/ws') wss.handleUpgrade(req, socket, head, ws => wss.emit('connection', ws, req));
    else socket.destroy();
  });

  return new Promise((resolve, reject) => {
    server.once('error', (err) => {
      if (err.code === 'EADDRINUSE') {
        reject(new Error(`Port ${port} sudah dipakai proses lain. Coba jalankan dengan -p <port_lain>`));
      } else reject(err);
    });
    server.listen(port, HOST, () => {
      console.log(`DevBashboard jalan di http://${HOST}:${port}`);
      console.log(`Folder scan: ${state.get().scanRoot}`);
      resolve(server);
    });
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  start({ port: parseInt(process.env.DASHBOARD_PORT || '7333', 10) }).catch((e) => {
    console.error(`[dev-bashboard] ${e.message}`);
    process.exit(1);
  });
}