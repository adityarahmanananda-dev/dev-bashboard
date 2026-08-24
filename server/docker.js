import fs from 'fs';
import path from 'path';
import { execFile } from 'child_process';

const DATA_DIR = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..', 'data');
const OVERRIDE_DIR = path.join(DATA_DIR, 'compose-overrides');

export function slugify(name) {
  return name.toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '') || 'project';
}

export function parseComposePorts(content) {
  const mappings = [];
  let inServices = false;
  let currentService = null;
  let inPorts = false;
  for (const raw of content.split('\n')) {
    const line = raw.replace(/\t/g, '  ');
    if (/^services:\s*$/.test(line)) { inServices = true; continue; }
    if (/^[A-Za-z]/.test(line)) {
      inServices = /^services:\s*$/.test(line);
      currentService = null;
      inPorts = false;
      continue;
    }
    if (!inServices) continue;
    const svc = line.match(/^ {2}([A-Za-z0-9_.-]+):\s*$/);
    if (svc) { currentService = svc[1]; inPorts = false; continue; }
    const portsKey = line.match(/^ {4}ports:\s*$/);
    if (portsKey) { inPorts = true; continue; }
    if (!inPorts || !currentService) continue;
    if (/^ {4}[A-Za-z-]+:/.test(line)) { inPorts = false; continue; }
    const short = line.match(/^\s*-\s*"?'?(?:([\w.]-?[\w.]*):)?(\d+):(\d+)"?'?\s*(?:#.*)?$/);
    if (short) {
      mappings.push({
        service: currentService,
        bindAddress: short[1] || null,
        hostPort: parseInt(short[2], 10),
        containerPort: parseInt(short[3], 10)
      });
      continue;
    }
    const longPublished = line.match(/^\s*-\s*(?:published:\s*)"?'?(\d+)/);
    const longTarget = line.match(/^\s*target:\s*(\d+)/);
    if (longPublished) {
      mappings.push({ service: currentService, bindAddress: null, hostPort: parseInt(longPublished[1], 10), containerPort: null, _longSyntax: true });
    } else if (longTarget && mappings.length && mappings[mappings.length - 1]._longSyntax) {
      const last = mappings[mappings.length - 1];
      last.containerPort = parseInt(longTarget[1], 10);
      last._longSyntax = false;
    }
  }
  return mappings.filter(m => m.containerPort === null ? m._longSyntax : m.containerPort > 0);
}

export function writeOverride(projectName, mappings, newPort) {
  fs.mkdirSync(OVERRIDE_DIR, { recursive: true });
  const services = {};
  for (const m of mappings) {
    const bind = m.bindAddress ? `${m.bindAddress}:` : '';
    (services[m.service] ||= { ports: [] }).ports.push(`"${bind}${newPort}:${m.containerPort}"`);
  }
  const yaml = [
    '# Dibuat otomatis oleh project-dashboard untuk override port host.',
    '# Aman dihapus kapan saja.',
    'services:'
  ];
  for (const [svc, cfg] of Object.entries(services)) {
    yaml.push(`  ${svc}:`, '    ports: !override');
    for (const p of cfg.ports) yaml.push(`      - ${p}`);
  }
  const file = path.join(OVERRIDE_DIR, `${slugify(projectName)}.yml`);
  fs.writeFileSync(file, yaml.join('\n') + '\n');
  return file;
}

export function buildUpArgs({ projectName, cwd, composeFile, mappings, desiredPort }) {
  const args = ['compose', '-p', slugify(projectName)];
  const files = [path.resolve(cwd, composeFile || 'docker-compose.yml')];
  const effectiveMappings = mappings?.length
    ? mappings
    : [{ service: null, hostPort: null, containerPort: null }];

  let overrideFile = null;
  if (desiredPort && mappings?.length && mappings.some(m => m.hostPort !== desiredPort)) {
    overrideFile = writeOverride(projectName, mappings, desiredPort);
    files.push(overrideFile);
  }
  for (const f of files) args.push('-f', f);
  args.push('up', '-d', '--build');

  const defaultHostPort = mappings?.[0]?.hostPort ?? null;
  const finalHostPort = desiredPort || defaultHostPort;
  return { args, overrideFile, finalHostPort };
}

function composeCmd(args, cwd) {
  return new Promise((resolve, reject) => {
    execFile('docker', ['compose', ...args], { cwd }, (err, stdout, stderr) => {
      if (err && !stdout && !stderr) return reject(err);
      resolve({ ok: !err, output: (stdout + stderr).trim() });
    });
  });
}

export async function isRunning(projectName, cwd) {
  try {
    const { ok, output } = await composeCmd(['-p', slugify(projectName), 'ps', '-q', '--status', 'running'], cwd);
    return ok && output.split('\n').some(l => l.trim());
  } catch {
    return false;
  }
}

export async function down(projectName, cwd) {
  try {
    return await composeCmd(['-p', slugify(projectName), 'down', '--remove-orphans'], cwd);
  } catch (e) {
    return { ok: false, output: e.message };
  }
}

export async function fetchLogs(projectName, cwd, tail = 400) {
  try {
    const { output } = await composeCmd(['-p', slugify(projectName), 'logs', '--no-color', '--no-log-prefix', '--tail', String(tail)], cwd);
    return output ? output.split('\n') : [];
  } catch (e) {
    return [`[dashboard] gagal ambil log compose: ${e.message}`];
  }
}
