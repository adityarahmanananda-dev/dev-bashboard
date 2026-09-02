import fs from 'fs';
import os from 'os';
import path from 'path';
import crypto from 'crypto';
import { execFile, execSync } from 'child_process';
import { fileURLToPath } from 'url';
import * as env from './env.js';

const DATA_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'data');
const MARKS_DIR = path.join(DATA_DIR, 'setup-marks');
const NESTED_DIRS = ['backend', 'server', 'src', 'client', 'frontend', 'app'];

function have(tool) {
  const check = process.platform === 'win32' ? `where ${tool}` : `command -v ${tool}`;
  try { execSync(check, { stdio: 'pipe' }); return true; } catch { return false; }
}

function findFile(dir, names) {
  for (const n of names) {
    const p = path.join(dir, n);
    try { if (fs.statSync(p).isFile()) return { name: n, path: p, dir }; } catch {}
  }
  for (const sub of NESTED_DIRS) {
    for (const n of names) {
      const p = path.join(dir, sub, n);
      try { if (fs.statSync(p).isFile()) return { name: n, path: p, dir: path.join(dir, sub) }; } catch {}
    }
  }
  return null;
}

function markFile(manager) {
  return path.join(MARKS_DIR, crypto.createHash('sha1').update(manager.dir + '|' + manager.id).digest('hex') + '.json');
}

function markValid(manager) {
  try {
    const mark = JSON.parse(fs.readFileSync(markFile(manager), 'utf8'));
    const cur = Math.round(fs.statSync(manager.manifestPath).mtimeMs);
    return mark.ok === true && mark.manager === manager.id && Math.round(mark.mtimeMs) === cur;
  } catch { return false; }
}

export function markInstalled(manager) {
  fs.mkdirSync(MARKS_DIR, { recursive: true });
  fs.writeFileSync(markFile(manager), JSON.stringify({
    manager: manager.id,
    file: manager.file,
    mtimeMs: fs.statSync(manager.manifestPath).mtimeMs,
    ok: true,
    at: Date.now()
  }, null, 2));
}

export function venvDir(manager) {
  return path.join(manager.dir, `${path.basename(manager.dir)}.venv`);
}

export function depManagerFor(project) {
  const dir = project.path;

  const req = findFile(dir, ['requirements.txt']);
  const pyproj = findFile(dir, ['pyproject.toml']);
  const pkg = findFile(dir, ['package.json']);
  const gomod = findFile(dir, ['go.mod']);
  const pom = findFile(dir, ['pom.xml']);
  const gradle = findFile(dir, ['build.gradle', 'build.gradle.kts', 'settings.gradle', 'settings.gradle.kts']);
  const conan = findFile(dir, ['conanfile.txt', 'conanfile.py']);
  const vcpkg = findFile(dir, ['vcpkg.json']);

  if (req) return { id: 'pip', label: 'Python/pip', file: req.name, manifestPath: req.path, dir: req.dir, kind: 'requirements' };
  if (pyproj) return { id: 'pip', label: 'Python/pip', file: pyproj.name, manifestPath: pyproj.path, dir: pyproj.dir, kind: 'pyproject' };
  if (pkg) return { id: 'npm', label: 'Node/npm', file: pkg.name, manifestPath: pkg.path, dir: pkg.dir };
  if (gomod) return { id: 'gomod', label: 'Go modules', file: gomod.name, manifestPath: gomod.path, dir: gomod.dir };
  if (pom) return { id: 'maven', label: 'Java/Maven', file: pom.name, manifestPath: pom.path, dir: pom.dir };
  if (gradle) return { id: 'gradle', label: 'Java/Gradle', file: gradle.name, manifestPath: gradle.path, dir: gradle.dir };
  if (conan) return { id: 'conan', label: 'C++/Conan', file: conan.name, manifestPath: conan.path, dir: conan.dir };
  if (vcpkg) return { id: 'vcpkg', label: 'C++/vcpkg', file: vcpkg.name, manifestPath: vcpkg.path, dir: vcpkg.dir };
  return null;
}

export function buildSteps(manager) {
  if (manager.id === 'pip') {
    const venvPath = venvDir(manager);
    const py = env.venvPython(venvPath);
    const pipBin = env.venvBin(venvPath, 'pip');
    const pip3Bin = env.venvBin(venvPath, 'pip3');
    const hasPip = fs.existsSync(pipBin) || fs.existsSync(pip3Bin);
    const steps = [];
    if (!fs.existsSync(py)) {
      steps.push({ argv: [env.pythonCmd(), '-m', 'venv', venvPath], label: `buat venv ${path.basename(venvPath)}`, cwd: manager.dir });
    }
    if (fs.existsSync(py) && !hasPip) {
      steps.push({ argv: [py, '-m', 'ensurepip', '--upgrade'], label: 'bootstrap pip (ensurepip)', cwd: manager.dir });
    }
    steps.push(
      manager.kind === 'requirements'
        ? { argv: [py, '-m', 'pip', 'install', '-r', manager.file], label: 'pip install requirements', cwd: manager.dir }
        : { argv: [py, '-m', 'pip', 'install', '.'], label: 'pip install pyproject', cwd: manager.dir }
    );
    return { steps };
  }

  if (manager.id === 'npm') {
    return { steps: [{ argv: ['npm', 'install', '--no-audit', '--no-fund'], label: 'npm install', cwd: manager.dir }] };
  }

  if (manager.id === 'gomod') {
    if (!have('go')) return { steps: [], error: '`go` tidak ditemukan di PATH — instal Go dulu untuk setup module' };
    return { steps: [{ argv: ['go', 'mod', 'download'], label: 'go mod download', cwd: manager.dir }] };
  }

  if (manager.id === 'maven') {
    if (have('mvn')) {
      return { steps: [{ argv: ['mvn', '-q', 'dependency:resolve'], label: 'maven resolve dependencies', cwd: manager.dir }] };
    }
    const wrapper = fs.existsSync(path.join(manager.dir, 'mvnw.cmd'))
      ? ['cmd', '/c', 'mvnw.cmd', '-q', 'dependency:resolve']
      : fs.existsSync(path.join(manager.dir, 'mvnw'))
        ? ['sh', '-c', './mvnw -q dependency:resolve']
        : null;
    if (wrapper) {
      return { steps: [{ argv: wrapper, label: 'maven (wrapper) resolve dependencies', cwd: manager.dir }] };
    }
    return { steps: [], error: '`mvn` tidak ditemukan di PATH dan project tidak punya ./mvnw' };
  }

  if (manager.id === 'gradle') {
    if (have('gradle')) {
      return { steps: [{ argv: ['gradle', '-q', 'dependencies', '--no-daemon'], label: 'gradle resolve dependencies', cwd: manager.dir }] };
    }
    const wrapper = fs.existsSync(path.join(manager.dir, 'gradlew.bat'))
      ? ['cmd', '/c', 'gradlew.bat', '-q', 'dependencies', '--no-daemon']
      : fs.existsSync(path.join(manager.dir, 'gradlew'))
        ? ['sh', '-c', './gradlew -q dependencies --no-daemon']
        : null;
    if (wrapper) {
      return { steps: [{ argv: wrapper, label: 'gradle (wrapper) resolve dependencies', cwd: manager.dir }] };
    }
    return { steps: [], error: '`gradle` tidak ditemukan di PATH dan project tidak punya ./gradlew' };
  }

  if (manager.id === 'conan') {
    if (!have('conan')) return { steps: [], error: '`conan` tidak ditemukan di PATH — instal dulu (mis. pip install conan)' };
    return { steps: [{ argv: ['conan', 'install', '.', '-s', 'build_type=Release', '--build=missing'], label: 'conan install', cwd: manager.dir }] };
  }

  if (manager.id === 'vcpkg') {
    const root = process.env.VCPKG_ROOT;
    const binFromRoot = root ? path.join(root, 'vcpkg') : null;
    if (have('vcpkg')) {
      return { steps: [{ argv: ['vcpkg', 'install'], label: 'vcpkg install (manifest mode)', cwd: manager.dir }] };
    }
    if (binFromRoot && fs.existsSync(binFromRoot)) {
      return { steps: [{ argv: [binFromRoot, 'install'], label: 'vcpkg install ($VCPKG_ROOT)', cwd: manager.dir }] };
    }
    return { steps: [], error: '`vcpkg` tidak ditemukan — set VCPKG_ROOT atau masukkan vcpkg ke PATH' };
  }

  return { steps: [], error: `Manager tidak dikenal: ${manager.id}` };
}

function goModHasRequires(manifestPath) {
  const src = fs.readFileSync(manifestPath, 'utf8').replace(/\/\/.*$/gm, '');
  if (/^\s*require\s*\(/m.test(src)) return true;
  for (const line of src.split('\n')) {
    if (/^(exclude|replace)\s/.test(line)) continue;
    if (/^\S+\s+v\d/.test(line.trim())) return true;
  }
  return false;
}

function npmStale(manager) {
  const nm = path.join(manager.dir, 'node_modules');
  try {
    const nmMt = fs.statSync(nm).mtimeMs;
    let newest = fs.statSync(manager.manifestPath).mtimeMs;
    for (const lock of ['package-lock.json', 'npm-shrinkwrap.json', 'yarn.lock', 'pnpm-lock.yaml']) {
      try { newest = Math.max(newest, fs.statSync(path.join(manager.dir, lock)).mtimeMs); } catch {}
    }
    return nmMt < newest - 50;
  } catch { return true; }
}

export function checkReady(manager) {
  if (manager.id === 'pip') {
    const py = env.venvPython(venvDir(manager));
    if (!fs.existsSync(py)) return Promise.resolve(false);

    let firstPkg = 'pip';
    try {
      const lines = fs.readFileSync(manager.manifestPath, 'utf8').split('\n');
      for (const line of lines) {
        const m = line.trim().match(/^([a-zA-Z0-9_-]+)/);
        if (m) { firstPkg = m[1].replace(/-/g, '_').toLowerCase(); break; }
      }
    } catch {}

    return new Promise((resolve) => {
      execFile(py, ['-c', `import ${firstPkg}`], { cwd: manager.dir, timeout: 15000 }, (err) => {
        if (!err) return resolve(true);
        execFile(py, ['-m', 'pip', 'install', '--dry-run', '-r', manager.file], { cwd: manager.dir, timeout: 90000 }, (err2, stdout) => {
          if (!err2 && stdout && /Would install|Would download/i.test(stdout)) return resolve(false);
          if (!err2) return resolve(true);
          resolve(false);
        });
      });
    });
  }

  if (manager.id === 'npm') return Promise.resolve(!npmStale(manager) || markValid(manager));

  if (manager.id === 'gomod') {
    if (!goModHasRequires(manager.manifestPath)) return Promise.resolve(true);
    return new Promise((resolve) => {
      execFile('go', ['mod', 'verify'], { cwd: manager.dir, timeout: 60000 }, err =>
        resolve(!err || markValid(manager)));
    });
  }

  return Promise.resolve(markValid(manager));
}
