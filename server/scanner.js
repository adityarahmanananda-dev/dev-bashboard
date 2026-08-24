import fs from 'fs';
import path from 'path';
import os from 'os';
import { execSync } from 'child_process';
import { parseComposePorts } from './docker.js';

const SELF_DIR = path.dirname(new URL(import.meta.url).pathname);
const APP_ROOT = path.resolve(SELF_DIR, '..');

function readFileSafe(p) {
  try { return fs.readFileSync(p, 'utf8'); } catch { return null; }
}

function exists(p) {
  try { return fs.existsSync(p); } catch { return false; }
}

function gitBranch(dir) {
  const head = readFileSafe(path.join(dir, '.git', 'HEAD'));
  if (!head) return null;
  const m = head.match(/^ref: refs\/heads\/(.+)\n?$/);
  return m ? m[1] : head.trim().slice(0, 7);
}

function readDescription(dir) {
  for (const f of ['README.md', 'readme.md', 'README.txt', 'README']) {
    const content = readFileSafe(path.join(dir, f));
    if (!content) continue;
    for (const line of content.split('\n')) {
      const t = line.trim();
      if (!t || /^#{1,6}\s*$/.test(t)) continue;
      if (/^#{1,6}\s+/.test(t)) return t.replace(/^#{1,6}\s+/, '').trim();
      if (!/^[=!<>\-|[\]()*]/.test(t)) return t.slice(0, 140);
    }
    return null;
  }
  return null;
}

function findVenv(dir) {
  for (const name of fs.readdirSync(dir)) {
    const binPython = path.join(dir, name, 'bin', 'python');
    const isDir = (() => { try { return fs.statSync(path.join(dir, name)).isDirectory(); } catch { return false; } })();
    if (isDir && exists(binPython)) {
      if (name === 'venv' || name === '.venv' || /env|venv/i.test(name)) return name;
    }
  }
  return null;
}

const NESTED_DIRS = ['backend', 'server', 'src', 'client', 'frontend', 'app'];

function findNestedFile(dir, filename) {
  for (const sub of NESTED_DIRS) {
    const p = path.join(dir, sub, filename);
    try {
      if (fs.statSync(p).isFile()) return { file: p, relSub: sub };
    } catch {}
  }
  return null;
}

function detectPortInFiles(dir, depth = 1) {
  const found = [];
  const candidates = [
    'docker-compose.yml', 'docker-compose.yaml', 'compose.yml',
    '.env', 'vite.config.js', 'vite.config.ts', 'next.config.js',
    'nuxt.config.ts', 'angular.json', 'svelte.config.js'
  ];
  for (const c of candidates) {
    const content = readFileSafe(path.join(dir, c));
    if (!content) continue;
    const portMatches = content.matchAll(/(?:^|\n)\s*-?\s*"?(?:\d+(\.\d+\.\d+\.\d+)?:)?(\d{2,5}):\d{2,5}"?(?:\s|$)/g);
    for (const m of portMatches) {
      const p = parseInt(m[2], 10);
      if (p >= 1024 && p <= 65535) found.push(p);
    }
    const envPort = content.match(/^PORT\s*=\s*(\d{2,5})\s*$/m);
    if (envPort) found.push(parseInt(envPort[1], 10));
  }
  if (depth > 0) {
    for (const sub of ['backend', 'server', 'src', 'client', 'app']) {
      const subDir = path.join(dir, sub);
      try {
        if (fs.statSync(subDir).isDirectory()) found.push(...detectPortInFiles(subDir, 0));
      } catch {}
    }
  }
  return [...new Set(found)];
}

function scanGo(dir) {
  let root = dir;
  const gomodRoot = exists(path.join(dir, 'go.mod'));
  if (!gomodRoot) {
    const nested = findNestedFile(dir, 'go.mod');
    if (!nested) return null;
    root = path.dirname(nested.file);
  }
  const gomod = readFileSafe(path.join(root, 'go.mod'));
  if (!gomod) return null;
  const stacks = ['Go'];
  let entry = null;
  let usesEnvAddr = false, usesEnvPort = false;

  const cmdDir = path.join(root, 'cmd');
  if (exists(cmdDir)) {
    for (const sub of fs.readdirSync(cmdDir)) {
      if (exists(path.join(cmdDir, sub, 'main.go'))) { entry = `./cmd/${sub}`; break; }
    }
  }
  if (!entry && exists(path.join(root, 'main.go'))) entry = '.';
  if (!entry) return { runnable: false, stacks };

  const mainFiles = [];
  const collectMain = (base, d = 0) => {
    try {
      for (const f of fs.readdirSync(base)) {
        const full = path.join(base, f);
        const st = fs.statSync(full);
        if (st.isDirectory() && d < 3 && f !== '.git') collectMain(full, d + 1);
        else if (f === 'main.go') mainFiles.push(full);
      }
    } catch {}
  };
  collectMain(root);
  for (const mf of mainFiles) {
    const src = readFileSafe(mf) || '';
    if (/env\(\s*"(ADDR|LISTEN_ADDR|HTTP_ADDR)"/.test(src)) usesEnvAddr = true;
    if (/env\(\s*"(PORT|HTTP_PORT)"|Getenv\(\s*"(PORT|HTTP_PORT)"/.test(src)) usesEnvPort = true;
  }

  return {
    runnable: true,
    stacks,
    recipe: {
      type: 'go',
      cwd: root,
      argv: ['go', 'run', entry],
      portMode: usesEnvAddr ? 'env:ADDR' : usesEnvPort ? 'env:PORT' : 'none'
    },
    detectedPorts: detectPortInFiles(dir)
  };
}

function scanNode(dir) {
  let root = dir;
  let pkgPath = path.join(dir, 'package.json');
  let prefixArgs = [];
  if (!exists(pkgPath)) {
    const nested = findNestedFile(dir, 'package.json');
    if (!nested) return null;
    root = path.dirname(nested.file);
    pkgPath = nested.file;
    prefixArgs = ['--prefix', nested.relSub];
  }
  let pkg;
  try { pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8')); } catch { return { runnable: false, stacks: ['Node.js'] }; }

  const stacks = ['Node.js'];
  const deps = { ...pkg.dependencies, ...pkg.devDependencies };
  if (deps.electron) stacks.push('Electron');
  if (deps.next) stacks.push('Next.js');
  if (deps.vite) stacks.push('Vite');
  if (deps.express) stacks.push('Express');
  if (deps.react || deps.vue || deps.svelte) stacks.push(deps.react ? 'React' : deps.vue ? 'Vue' : 'Svelte');

  const scripts = pkg.scripts || {};
  const scriptName = ['dev', 'start', 'serve'].find(s => scripts[s]);
  if (!scriptName) return { runnable: false, stacks, description: pkg.description };

  let detectedPorts = detectPortInFiles(dir);
  if (deps.vite && !detectedPorts.length) detectedPorts.push(5173);
  if (deps.next && !detectedPorts.length) detectedPorts.push(3000);

  return {
    runnable: true,
    stacks,
    description: pkg.description || null,
    recipe: {
      type: 'node',
      cwd: dir,
      argv: ['npm', ...prefixArgs, 'run', scriptName],
      portMode: 'env:PORT',
      scriptName
    },
    detectedPorts
  };
}

function scanPython(dir) {
  const files = new Set(fs.existsSync(dir) ? fs.readdirSync(dir) : []);
  const pyEntry = ['manage.py', 'app.py', 'main.py', 'server.py', 'run.py'].find(f => files.has(f));
  const isPy = pyEntry || files.has('requirements.txt') || files.has('pyproject.toml');
  if (!isPy) return null;

  const stacks = ['Python'];
  const venv = findVenv(dir);
  const pythonBin = venv ? path.join(venv, 'bin', 'python') : 'python3';

  let recipe = null;
  let detectedPorts = detectPortInFiles(dir);

  if (pyEntry === 'manage.py') {
    stacks.push('Django');
    recipe = { type: 'django', cwd: dir, argv: [pythonBin, 'manage.py', 'runserver'], portMode: 'arg', venv };
  } else if (pyEntry) {
    const src = readFileSafe(path.join(dir, pyEntry)) || '';
    const flask = /from flask import|import flask/.test(src);
    const fastapi = /from fastapi import|import fastapi/.test(src);
    const uvicornRun = /uvicorn\.run/.test(src);

    if (fastapi) stacks.push('FastAPI');
    if (flask) stacks.push('Flask');
    if (files.has('requirements.txt')) {
      const req = readFileSafe(path.join(dir, 'requirements.txt')) || '';
      if (/flask/i.test(req) && !flask) stacks.push('Flask');
      if (/uvicorn|fastapi/i.test(req) && !fastapi) stacks.push('FastAPI');
    }

    const readsEnvPort = /environ\.get\(\s*["'](PORT|APP_PORT)["']|getenv\(\s*["'](PORT|APP_PORT)["']/.test(src);
    const hardcodedPort = src.match(/port\s*=\s*(\d{4,5})/);

    if (flask && !readsEnvPort) {
      const flaskBin = venv ? path.join(venv, 'bin', 'flask') : 'flask';
      recipe = {
        type: 'flask-cli',
        cwd: dir,
        argv: [flaskBin, '--app', pyEntry.replace(/\.py$/, ''), 'run', '--host', '127.0.0.1'],
        portMode: 'arg',
        fallbackArgv: [pythonBin, pyEntry],
        venv
      };
    } else if (fastapi || uvicornRun) {
      recipe = { type: 'uvicorn-env', cwd: dir, argv: [pythonBin, pyEntry], portMode: 'env:PORT', venv };
    } else {
      recipe = { type: 'python-env', cwd: dir, argv: [pythonBin, pyEntry], portMode: readsEnvPort ? 'env:PORT' : 'none', venv };
    }
    if (hardcodedPort) detectedPorts.push(parseInt(hardcodedPort[1], 10));
  } else {
    const pyproject = readFileSafe(path.join(dir, 'pyproject.toml'));
    if (pyproject) stacks.push('Library/paket');
    return { runnable: false, stacks, venv };
  }

  return { runnable: true, stacks, recipe, detectedPorts, venv };
}

function scanStatic(dir) {
  const hasIndex = exists(path.join(dir, 'index.html'));
  const entries = fs.existsSync(dir) ? fs.readdirSync(dir) : [];
  const codeFiles = entries.filter(f => /\.(js|ts|py|go|rs|java|rb|php|c|cpp)$/.test(f));
  if (!hasIndex || codeFiles.length > 0) return null;
  return {
    runnable: true,
    stacks: ['HTML/CSS/JS statis'],
    recipe: {
      type: 'static',
      cwd: dir,
      argv: ['python3', '-m', 'http.server'],
      portMode: 'arg-static'
    },
    detectedPorts: []
  };
}

function detectCompose(dir) {
  for (const f of ['docker-compose.yml', 'docker-compose.yaml', 'compose.yml', 'compose.yaml']) {
    const content = readFileSafe(path.join(dir, f));
    if (content) return { file: f, content };
  }
  return null;
}

const DB_SKIP_DIRS = new Set([
  'node_modules', '.git', 'dist', 'build', '__pycache__', '.next',
  '.nuxt', 'release', 'out', 'coverage', 'vendor'
]);
const DB_TEXT_EXT = new Set(['.env', '.py', '.js', '.ts', '.mjs', '.cjs', '.go', '.yml', '.yaml', '.json', '.toml', '.prisma', '.sql', '.example']);

const DB_DEP_PATTERNS = [
  [/psycopg|asyncpg|pg8000|"pg"|'pg'|pg-promise|node-postgres|jackc\/pgx|lib\/pq|postgres\.js|\bpostgres\b/i, 'PostgreSQL'],
  [/pymysql|mysqlclient|mysql-connector|mysql2|go-sql-driver\/mysql/i, 'MySQL'],
  [/pymongo|mongoose|mongo-driver|\bmongodb?\b/i, 'MongoDB'],
  [/\bioredis\b|\bredis\b|go-redis/i, 'Redis'],
  [/better-sqlite3|mattn\/go-sqlite3|modernc\.org\/sqlite|sqlite3/i, 'SQLite'],
  [/@supabase\/supabase-js/i, 'PostgreSQL']
];

const DB_CLOUD_PROVIDERS = [
  [/supabase\.(co|com)$/i, 'Supabase'],
  [/neon\.tech$/i, 'Neon'],
  [/mongodb\.net$/i, 'MongoDB Atlas'],
  [/planetscale/i, 'PlanetScale'],
  [/turso\.tech/i, 'Turso'],
  [/upstash\.io/i, 'Upstash'],
  [/aivencloud|aiven\.io/i, 'Aiven'],
  [/amazonaws\.com$/i, 'AWS'],
  [/azure\.com$/i, 'Azure'],
  [/render\.com$/i, 'Render'],
  [/railway\.(app|internal)$/i, 'Railway'],
  [/fly\.dev$/i, 'Fly.io'],
  [/timescale/i, 'Timescale'],
  [/cockroachlabs|cockroachdb/i, 'CockroachDB Cloud'],
  [/koyeb\.app$/i, 'Koyeb'],
  [/clever-cloud/i, 'Clever Cloud']
];

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '0.0.0.0', '::1', 'host.docker.internal']);
const SCHEME_TO_ENGINE = {
  postgresql: 'PostgreSQL', postgres: 'PostgreSQL',
  mysql: 'MySQL', mariadb: 'MariaDB',
  mongodb: 'MongoDB', 'mongodb+srv': 'MongoDB',
  redis: 'Redis', rediss: 'Redis',
  sqlite: 'SQLite'
};

function collectDbCandidateFiles(dir) {
  const out = [];
  const walk = (base, depth) => {
    if (out.length >= 60 || depth > 3) return;
    let entries;
    try { entries = fs.readdirSync(base, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (e.name.startsWith('.') && e.name !== '.env' && !e.name.endsWith('.env')) continue;
      if (DB_SKIP_DIRS.has(e.name)) continue;
      const full = path.join(base, e.name);
      if (e.isDirectory()) { walk(full, depth + 1); continue; }
      const ext = path.extname(e.name);
      if (DB_TEXT_EXT.has(ext) || e.name === '.env' || e.name.endsWith('.env')) {
        try { if (fs.statSync(full).size < 300000) out.push(full); } catch {}
      }
      if (out.length >= 60) return;
    }
  };
  walk(dir, 0);
  return out;
}

function classifyDbHost(host, composeServiceNames) {
  if (!host) return null;
  const bare = host.replace(/\.$/, '').toLowerCase();
  if (LOCAL_HOSTS.has(bare)) return { hosting: 'local' };
  if (!bare.includes('.')) {
    return { hosting: composeServiceNames?.includes(bare) ? 'docker' : 'local', detail: bare };
  }
  for (const [re, provider] of DB_CLOUD_PROVIDERS) {
    if (re.test(bare)) return { hosting: 'online', provider, detail: bare };
  }
  return { hosting: 'online', provider: bare.split('.').slice(-2).join('.'), detail: bare };
}

export function detectDatabases(dir, composeContent) {
  const found = new Map();

  const addDb = (engine, hosting, extra = {}) => {
    if (!engine) return;
    const key = `${engine}`;
    const prev = found.get(key);
    const priority = { online: 4, docker: 3, local: 2, file: 1 };
    const cand = { engine, hosting, ...extra };
    if (!prev || (priority[cand.hosting] ?? 0) >= (priority[prev.hosting] ?? 0)) {
      found.set(key, { ...cand, ...(prev && prev.detail && !cand.detail ? { detail: prev.detail } : {}) });
    }
  };

  const composeServiceNames = [];
  if (composeContent) {
    for (const m of composeContent.matchAll(/^\s{2}([A-Za-z0-9_-]+):\s*$/gm)) composeServiceNames.push(m[1].toLowerCase());
    for (const m of composeContent.matchAll(/image:\s*["']?([^\s"']+)/gi)) {
      const img = m[1].toLowerCase();
      if (/postgres|timescale|supabash|pgvector/.test(img)) addDb('PostgreSQL', 'docker');
      else if (/mysql|mariadb/.test(img)) addDb(img.includes('maria') ? 'MariaDB' : 'MySQL', 'docker');
      else if (/mongo/.test(img)) addDb('MongoDB', 'docker');
      else if (/redis|valkey|keydb/.test(img)) addDb('Redis', 'docker');
      else if (/clickhouse/.test(img)) addDb('ClickHouse', 'docker');
    }
  }

  const depSources = [];
  for (const f of ['requirements.txt', 'go.mod', 'package.json']) {
    const c = readFileSafe(path.join(dir, f));
    if (c) depSources.push(c);
  }
  try {
    const pkg = JSON.parse(readFileSafe(path.join(dir, 'package.json')) || '{}');
    depSources.push(JSON.stringify({ ...pkg.dependencies, ...pkg.devDependencies }));
  } catch {}
  const prisma = readFileSafe(path.join(dir, 'prisma', 'schema.prisma')) || '';
  const prismaProvider = prisma.match(/provider\s*=\s*"([^"]+)"/)?.[1];
  if (prismaProvider) {
    const map = { postgresql: 'PostgreSQL', mysql: 'MySQL', sqlite: 'SQLite', mongodb: 'MongoDB', sqlserver: 'SQL Server' };
    addDb(map[prismaProvider], prismaProvider === 'sqlite' ? 'file' : 'local');
  }

  const allDeps = depSources.join('\n');
  for (const [re, engine] of DB_DEP_PATTERNS) {
    if (re.test(allDeps)) addDb(engine, engine === 'SQLite' ? 'file' : 'local');
  }

  const urlRe = /(postgres(?:ql)?|mysql|mariadb|mongodb(?:\+srv)?|rediss?|sqlite):\/\/(?:[^\s'"@<>\/]+@[^\s'"<>\/]+|[^\s'"<>@\/]+)/gi;
  const seenUrls = new Set();
  for (const file of collectDbCandidateFiles(dir)) {
    const content = readFileSafe(file);
    if (!content) continue;

    if (/sqlite3\.connect|better-sqlite3|sqlite3\.Database|new\s+SQLite|gorm\.io\/driver\/sqlite|modernc\.org\/sqlite/.test(content)) {
      addDb('SQLite', 'file');
    }
    for (const m of content.matchAll(urlRe)) {
      const scheme = m[1].toLowerCase().replace('+srv', '');
      const rest = m[0].slice(m[1].length + 3);
      const authority = rest.split(/[\/\s'"><]/)[0];
      const hostPart = authority.includes('@') ? authority.slice(authority.lastIndexOf('@') + 1) : authority;
      const host = hostPart.split(':')[0];
      const key = `${scheme}://${host}`;
      if (seenUrls.has(key)) continue;
      seenUrls.add(key);
      const engine = SCHEME_TO_ENGINE[scheme] || m[1];
      const cls = classifyDbHost(host, composeServiceNames);
      if (cls) {
        const extra = {};
        if (cls.provider) extra.provider = cls.provider;
        if (cls.detail && cls.hosting !== 'local') extra.detail = cls.detail;
        addDb(engine, cls.hosting, extra);
      }
    }
  }

  for (const e of fs.existsSync(dir) ? fs.readdirSync(dir) : []) {
    if (/\.(db|sqlite3?)$/i.test(e)) addDb('SQLite', 'file', { detail: e });
  }

  return [...found.values()].sort((a, b) => a.engine.localeCompare(b.engine));
}

export function scanProject(dir) {
  const result = {
    name: path.basename(dir),
    path: dir,
    branch: gitBranch(dir),
    description: readDescription(dir),
    runnable: false,
    stacks: [],
    recipe: null,
    detectedPorts: []
  };

  const detectors = [scanGo, scanNode, scanPython, scanStatic];
  for (const det of detectors) {
    try {
      const r = det(dir);
      if (!r) continue;
      Object.assign(result, r);
      break;
    } catch (e) {
      console.error(`[scanner] error di ${dir}:`, e.message);
    }
  }

  result.detectedPorts = [...new Set(result.detectedPorts.filter(p => p >= 1024))];

  const compose = detectCompose(dir);
  result.databases = detectDatabases(dir, compose?.content);

  if (compose) {    const mappings = parseComposePorts(compose.content);
    if (!result.stacks.includes('Docker Compose')) result.stacks.push('Docker Compose');
    if (result.runnable && result.recipe && result.recipe.type !== 'docker') {
      result.altRecipe = result.recipe;
    }
    result.recipe = {
      type: 'docker',
      cwd: dir,
      argv: ['docker', 'compose', 'up', '-d', '--build'],
      composeFile: compose.file,
      mappings,
      portMode: 'docker'
    };
    result.runnable = true;
    for (const m of mappings) {
      if (m.hostPort >= 1024 && !result.detectedPorts.includes(m.hostPort)) result.detectedPorts.push(m.hostPort);
    }
  }

  return result;
}

export function scanRoot(root) {
  const projects = [];
  let entries;
  try { entries = fs.readdirSync(root, { withFileTypes: true }); } catch { throw new Error(`Tidak bisa membaca folder: ${root}`); }

  for (const ent of entries) {
    if (!ent.isDirectory()) continue;
    if (ent.name.startsWith('.') || ent.name === 'node_modules') continue;
    const full = path.join(root, ent.name);
    if (full === APP_ROOT) continue;
    try {
      if (fs.statSync(full).isDirectory()) projects.push(scanProject(full));
    } catch {}
  }
  projects.sort((a, b) => a.name.localeCompare(b.name));
  return projects;
}

export function listDirs(target) {
  const resolved = target ? path.resolve(target.replace(/^~(?=\/|$)/, os.homedir())) : os.homedir();
  const entries = fs.readdirSync(resolved, { withFileTypes: true });
  const dirs = [];
  for (const e of entries) {
    if (e.name.startsWith('.')) continue;
    try {
      const st = fs.statSync(path.join(resolved, e.name));
      if (st.isDirectory()) dirs.push(e.name);
    } catch {}
  }
  dirs.sort((a, b) => a.localeCompare(b, 'id', { sensitivity: 'base' }));
  const parent = path.dirname(resolved);
  return {
    path: resolved,
    parent: parent !== resolved ? parent : null,
    home: os.homedir(),
    dirs
  };
}
