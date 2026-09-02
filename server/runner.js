import { spawn, execFile } from 'child_process';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import * as docker from './docker.js';
import * as deps from './deps.js';
import * as env from './env.js';

const LOG_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'data', 'logs');
const MAX_LOG_LINES = 800;
const STOP_GRACE_MS = 5000;

const running = new Map();

let onLog = null;
export function setOnLog(fn) {
  onLog = fn;
}

function logFile(name) {
  return path.join(LOG_DIR, `${name.replace(/[^a-zA-Z0-9._-]/g, '_')}.log`);
}

function appendLog(entry, lines) {
  entry.lines.push(...lines);
  if (entry.lines.length > MAX_LOG_LINES) entry.lines.splice(0, entry.lines.length - MAX_LOG_LINES);
  try { fs.appendFileSync(logFile(entry.name), lines.join('\n') + '\n'); } catch {}
  try { onLog?.(entry.name, lines); } catch {}
}

function pgidAlive(pgid) {
  if (env.isWindows()) return false;
  try {
    process.kill(-pgid, 0);
    return true;
  } catch (e) {
    return e.code === 'EPERM';
  }
}

function pidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e.code === 'EPERM';
  }
}

function procInfo(pid) {
  try {
    const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
    const f = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
    return { ppid: parseInt(f[1], 10), pgrp: parseInt(f[2], 10) };
  } catch {
    return null;
  }
}

function collectVictims(rootPid, pgid) {
  if (env.isWindows()) return [rootPid];
  let entries;
  try { entries = fs.readdirSync('/proc'); } catch { return [rootPid]; }
  const infos = new Map();
  for (const d of entries) {
    const pid = parseInt(d, 10);
    if (!Number.isInteger(pid)) continue;
    const info = procInfo(pid);
    if (info) infos.set(pid, info);
  }
  const victims = new Set([rootPid]);
  let grew = true;
  while (grew) {
    grew = false;
    for (const [pid, info] of infos) {
      if (victims.has(pid)) continue;
      if (victims.has(info.ppid) || info.pgrp === pgid) {
        victims.add(pid);
        grew = true;
      }
    }
  }
  return [...victims];
}

function loadDotEnv(cwd) {
  const env = {};
  try {
    const txt = fs.readFileSync(path.join(cwd, '.env'), 'utf8');
    for (const line of txt.split('\n')) {
      if (/^\s*#/.test(line)) continue;
      const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
      if (m) env[m[1]] = m[2].replace(/^["']|["']$/g, '');
    }
  } catch {}
  return env;
}

function buildStartArgs(recipe, port) {
  const argv = [...recipe.argv];
  let env = {};
  switch (recipe.portMode) {
    case 'arg':
      argv.push('--port', String(port));
      break;
    case 'arg-static':
      argv.push(String(port), '--bind', '127.0.0.1');
      break;
    case 'env:PORT':
      env.PORT = String(port);
      env.APP_PORT = String(port);
      break;
    case 'env:ADDR':
      env.ADDR = `:${port}`;
      break;
    default:
      break;
  }
  return { argv, env };
}

let onSetupEnd = null;
export function setOnSetupEnd(fn) {
  onSetupEnd = fn;
}

function entryIsRunning(e) {
  if (e.kind === 'setup') return !e.exited;
  if (e.kind === 'docker') return !e.exited && !e.stopping;
  return !e.exited;
}

function resolveRecipe(project, native) {
  if (native && project.altRecipe) return { recipe: project.altRecipe, isAlt: true };
  return { recipe: project.recipe, isAlt: false };
}

export function start(project, port, opts = {}) {
  const { recipe } = resolveRecipe(project, opts.native);
  if (!recipe) throw new Error('Project tidak bisa dijalankan (tidak ada start command)');
  if ([...running.values()].some(e => e.path === project.path && entryIsRunning(e))) {
    throw new Error(`Project "${project.name}" sudah berjalan`);
  }

  const name = project.name;

  if (recipe.type === 'docker') {
    return startDocker(project, recipe, port);
  }

  let useRecipe = recipe;
  if (useRecipe.argv[0] && useRecipe.argv[0].includes('/') && !fs.existsSync(path.resolve(useRecipe.cwd, useRecipe.argv[0]))) {
    throw new Error(`Binary tidak ditemukan: ${useRecipe.argv[0]} (cek venv project)`);
  }
  const entryNote = useRecipe.note || null;

  let { argv, env } = buildStartArgs(useRecipe, port);
  env = { ...loadDotEnv(useRecipe.cwd), ...env };

  try { fs.mkdirSync(LOG_DIR, { recursive: true }); fs.writeFileSync(logFile(name), ''); } catch {}

  const child = spawn(argv[0], argv.slice(1), {
    cwd: useRecipe.cwd,
    env: { ...process.env, ...env },
    detached: true,
    stdio: ['ignore', 'pipe', 'pipe']
  });

  const entry = {
    kind: 'native',
    name,
    path: project.path,
    cwd: useRecipe.cwd,
    mode: opts.native ? 'native' : 'default',
    port,
    pid: child.pid,
    pgid: -child.pid,
    startedAt: Date.now(),
    exited: false,
    exitCode: null,
    lines: [],
    proc: child
  };
  running.set(project.path, entry);

  const onData = (buf) => appendLog(entry, buf.toString().split('\n').filter(Boolean));
  child.stdout.on('data', onData);
  child.stderr.on('data', onData);

  child.on('exit', (code, signal) => {
    entry.exited = true;
    entry.exitCode = code;
    entry.signal = signal;
    appendLog(entry, [`[dashboard] proses keluar (code=${code ?? '-'}${signal ? `, signal=${signal}` : ''})`]);
    setTimeout(() => {
      if (running.get(project.path) === entry) running.delete(project.path);
    }, 1500);
  });
  child.on('error', (err) => {
    appendLog(entry, [`[dashboard] gagal spawn: ${err.message}`]);
    entry.exited = true;
    entry.exitCode = null;
    setTimeout(() => {
      if (running.get(project.path) === entry) running.delete(project.path);
    }, 1500);
  });

  appendLog(entry, [
    `[dashboard] start: ${argv.join(' ')}`,
    `[dashboard] port diminta: ${port}${Object.keys(env).length ? `, env tambahan: ${JSON.stringify(env)}` : ''}`,
    ...(entryNote ? [`[dashboard] catatan: ${entryNote}`] : [])
  ]);

  return serialize(entry);
}

function startDocker(project, recipe, port) {
  const name = project.name;
  const hasPorts = Array.isArray(recipe.mappings) && recipe.mappings.length > 0;
  const desiredPort = hasPorts ? port : null;
  const { args, overrideFile, finalHostPort } = docker.buildUpArgs({
    projectName: name,
    cwd: recipe.cwd,
    composeFile: recipe.composeFile,
    mappings: recipe.mappings,
    desiredPort
  });

  try { fs.mkdirSync(LOG_DIR, { recursive: true }); fs.writeFileSync(logFile(name), ''); } catch {}

  const child = spawn('docker', args, {
    cwd: recipe.cwd,
    detached: true,
    stdio: ['ignore', 'pipe', 'pipe']
  });

  const entry = {
    kind: 'docker',
    name,
    path: project.path,
    cwd: recipe.cwd,
    composeFile: recipe.composeFile,
    mode: 'default',
    port: finalHostPort,
    pid: child.pid,
    startedAt: Date.now(),
    live: false,
    building: true,
    exited: false,
    exitCode: null,
    lines: [],
    proc: child
  };
  running.set(project.path, entry);

  const onData = (buf) => appendLog(entry, buf.toString().split('\n').filter(Boolean).slice(0, 40));
  child.stdout.on('data', onData);
  child.stderr.on('data', onData);

  child.on('exit', (code) => {
    entry.building = false;
    if (code === 0) {
      entry.live = true;
      appendLog(entry, ['[dashboard] container berjalan di background (detached)']);
    } else {
      entry.exited = true;
      entry.exitCode = code;
      appendLog(entry, [`[dashboard] docker compose gagal (exit ${code}), lihat log di atas`]);
      setTimeout(() => {
        if (running.get(project.path) === entry) running.delete(project.path);
      }, 1500);
    }
  });
  child.on('error', (err) => {
    entry.building = false;
    entry.exited = true;
    appendLog(entry, [`[dashboard] gagal jalankan docker: ${err.message}`]);
  });

  appendLog(entry, [
    `[dashboard] start (docker compose): docker ${args.join(' ')}`,
    ...(overrideFile ? [`[dashboard] override port host -> ${desiredPort} (${overrideFile})`] : []),
    ...(!hasPorts && port ? [`[dashboard] catatan: compose tidak mempublikasi port apa pun; permintaan port ${port} diabaikan`] : [])
  ]);

  return serialize(entry);
}

export async function reconcileDocker() {
  for (const entry of [...running.values()]) {
    if (entry.kind !== 'docker' || entry.building || entry.stopping) continue;
    const alive = await docker.isRunning(entry.name, entry.cwd);
    if (!alive) running.delete(entry.path);
    else entry.live = true;
  }
}

export function refreshActualPorts(byPgid) {
  for (const e of running.values()) {
    if (e.kind !== 'native' || e.exited || e.pgid == null) continue;
    const socks = byPgid.get(Math.abs(e.pgid)) || [];
    const ports = [...new Set(socks.map(s => s.port))].sort((a, b) => a - b);
    if (ports.length) {
      if (JSON.stringify(ports) !== JSON.stringify(e.actualPorts)) {
        onLog?.(e.name, [`[dashboard] terdeteksi listening di port: ${ports.join(', ')}${e.port && !ports.includes(e.port) ? ` (diminta :${e.port}, app memakai port sendiri)` : ''}`]);
      }
      e.actualPorts = ports;
    }
  }
}

export function getSetup(projectPath) {
  return running.get('setup:' + projectPath) || null;
}

export function startSetup(project) {
  const key = 'setup:' + project.path;
  if (running.has(key)) throw new Error('Setup untuk project ini sedang berjalan');

  const manager = deps.depManagerFor(project);
  if (!manager) throw new Error('Tidak ada manifest dependencies yang dikenali (requirements/pyproject/package.json/go.mod/pom.xml/build.gradle/conanfile/vcpkg.json)');
  const { steps, error } = deps.buildSteps(manager);
  if (error || !steps.length) throw new Error(error || 'Tidak ada langkah setup untuk dijalankan');

  try { fs.mkdirSync(LOG_DIR, { recursive: true }); fs.writeFileSync(logFile(project.name), ''); } catch {}

  const entry = {
    kind: 'setup',
    name: project.name,
    path: project.path,
    cwd: manager.dir,
    port: null,
    pid: null,
    pgid: null,
    startedAt: Date.now(),
    exited: false,
    exitCode: null,
    stepIndex: -1,
    steps: steps.map(s => s.label),
    manager,
    lines: [],
    proc: null
  };
  running.set(key, entry);

  const runNext = () => {
    entry.stepIndex++;
    if (entry.stepIndex >= steps.length) {
      entry.exited = true;
      entry.exitCode = 0;
      deps.markInstalled(manager);
      appendLog(entry, [`[setup] SELESAI ✓ — dependencies ${manager.label} siap dipakai`]);
      onSetupEnd?.(project.name, true);
      return;
    }
    const step = steps[entry.stepIndex];
    appendLog(entry, [
      `[setup] langkah ${entry.stepIndex + 1}/${steps.length}: ${step.label}`,
      `$ ${step.argv.join(' ')}`
    ]);
    const child = spawn(step.argv[0], step.argv.slice(1), {
      cwd: step.cwd || project.path,
      detached: true,
      stdio: ['ignore', 'pipe', 'pipe']
    });
    entry.pid = child.pid;
    entry.pgid = -child.pid;
    const onData = buf => appendLog(entry, buf.toString().split('\n').filter(Boolean).slice(0, 200));
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);
    child.on('error', err => {
      appendLog(entry, [`[setup] gagal spawn: ${err.message}`]);
      entry.exited = true;
      entry.exitCode = 1;
      onSetupEnd?.(project.name, false);
    });
    child.on('exit', code => {
      if (entry.exited) return;
      if (code === 0) runNext();
      else {
        entry.exited = true;
        entry.exitCode = code;
        appendLog(entry, [`[setup] GAGAL di langkah "${step.label}" (exit ${code}) — periksa log di atas`]);
        onSetupEnd?.(project.name, false);
      }
    });
  };
  runNext();
  return serialize(entry);
}

export function listSetups() {
  return [...running.values()]
    .filter(e => e.kind === 'setup')
    .map(e => ({
      ...serialize(e),
      state: e.exited ? (e.exitCode === 0 ? 'done' : 'failed') : 'running',
      progress: `${Math.min(e.stepIndex + (e.exited ? 1 : 1), e.steps.length)}/${e.steps.length}`
    }));
}

export function stop(projectPath) {
  const entry = running.get(projectPath) || running.get('setup:' + projectPath);
  if (!entry) return false;

  if (entry.kind === 'setup') {
    const key = 'setup:' + entry.path;
    if (!entry.pid || entry.exited) {
      running.delete(key);
      return true;
    }
    if (env.isWindows()) {
      try { execFile('taskkill', ['/pid', String(entry.pid), '/T', '/F'], () => {}); } catch {}
    } else {
      const victims = collectVictims(entry.pid, Math.abs(entry.pgid));
      for (const p of victims) { try { process.kill(p, 'SIGKILL'); } catch {} }
    }
    appendLog(entry, ['[setup] dibatalkan oleh user']);
    entry.exited = true;
    entry.exitCode = 130;
    onSetupEnd?.(entry.name, false);
    running.delete(key);
    return true;
  }

  if (entry.kind === 'docker') {
    if (entry.stopping || entry.building) return false;
    entry.stopping = true;
    appendLog(entry, ['[dashboard] docker compose down…']);
    docker.down(entry.name, entry.cwd).then((res) => {
      appendLog(entry, res.output ? res.output.split('\n') : ['[dashboard] container dihentikan']);
      running.delete(projectPath);
      onLog?.(entry.name, ['[dashboard] project dihentikan']);
    });
    return true;
  }

  if (env.isWindows()) {
    if (entry.pid) {
      try { execFile('taskkill', ['/pid', String(entry.pid), '/T', '/F'], () => {}); } catch {}
      if (!entry.proc) {
        const timer = setInterval(() => {
          if (pidAlive(entry.pid)) return;
          clearInterval(timer);
          if (running.get(projectPath) === entry) running.delete(projectPath);
          onLog?.(entry.name, ['[dashboard] project dihentikan']);
        }, 300);
        setTimeout(() => clearInterval(timer), 15000);
      }
    }
    appendLog(entry, ['[dashboard] stop: taskkill /T ke proses tree']);
    return true;
  }

  const pgid = Math.abs(entry.pgid);
  let victims = collectVictims(entry.pid, pgid);
  const killAll = (sig) => {
    for (const p of victims) {
      try { process.kill(p, sig); } catch {}
    }
    try { process.kill(-pgid, sig); } catch {}
  };
  killAll('SIGTERM');
  appendLog(entry, [`[dashboard] stop: SIGTERM ke ${victims.length} proses (termasuk child yang pindah group)`]);

  const deadline = Date.now() + STOP_GRACE_MS;
  const timer = setInterval(() => {
    victims = victims.filter(pidAlive);
    if (!victims.length) {
      clearInterval(timer);
      running.delete(projectPath);
      return;
    }
    if (Date.now() > deadline) {
      killAll('SIGKILL');
      clearInterval(timer);
      running.delete(projectPath);
    }
  }, 300);

  appendLog(entry, ['[dashboard] menerima perintah stop…']);
  return true;
}

export function get(projectPath) {
  const e = running.get(projectPath);
  return e ? serialize(e) : null;
}

export function findEntryByName(name) {
  return [...running.values()].find(e => e.name === name) || null;
}

export function getLogs(projectPath) {
  const e = running.get(projectPath);
  return e ? e.lines : [];
}

export async function getLogsFor(name, projectPath) {
  const e = findEntryByName(name);
  if (!e) return [];
  if (e.kind === 'docker') {
    const lines = await docker.fetchLogs(e.name, e.cwd);
    return lines.slice(-MAX_LOG_LINES);
  }
  return e.lines;
}

export function listRunning() {
  return [...running.values()].filter(e => e.kind !== 'setup' && entryIsRunning(e)).map(serialize);
}

export function anyEntryAt(projectPath) {
  return running.has(projectPath);
}

export async function adoptPersisted(saved) {
  for (const s of saved || []) {
    if (s.kind === 'docker') {
      const alive = await docker.isRunning(s.name, s.cwd || path.dirname(s.path));
      if (alive) {
        running.set(s.path, {
          kind: 'docker',
          name: s.name,
          path: s.path,
          cwd: s.cwd,
          port: s.port,
          pid: null,
          startedAt: s.startedAt || Date.now(),
          adopted: true,
          live: true,
          building: false,
          exited: false,
          exitCode: null,
          proc: null,
          lines: []
        });
      }
    } else if (s.pgid && (env.isWindows() ? (s.pid && pidAlive(s.pid)) : pgidAlive(s.pgid))) {
      running.set(s.path, {
        kind: 'native',
        name: s.name,
        path: s.path,
        cwd: s.cwd,
        port: s.port,
        pid: s.pid,
        pgid: s.pgid,
        startedAt: s.startedAt || Date.now(),
        adopted: true,
        exited: false,
        exitCode: null,
        proc: null,
        lines: []
      });
    }
  }
}

export function persistable() {
  return [...running.values()]
    .filter(e => e.kind !== 'setup' && !e.exited)
    .map(({ kind, name, path, cwd, port, pid, pgid, startedAt, actualPorts }) => ({
      kind,
      name,
      path,
      cwd,
      port: (actualPorts && actualPorts[0]) || port,
      pid,
      pgid,
      startedAt
    }));
}

function serialize(e) {
  return {
    kind: e.kind,
    name: e.name,
    path: e.path,
    cwd: e.cwd,
    port: e.port,
    pid: e.pid,
    startedAt: e.startedAt,
    exited: !!e.exited,
    exitCode: e.exitCode,
    adopted: !!e.adopted,
    building: !!e.building,
    actualPorts: e.actualPorts || []
  };
}
