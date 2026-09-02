#!/usr/bin/env node
import fs from 'fs';
import path from 'path';
import { spawn } from 'child_process';
import { fileURLToPath } from 'url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const HELP = `
DevBashboard — dashboard lokal untuk project kamu
Pakai: dev-bashboard [opsi]

Opsi:
  -p, --port <n>      Port untuk dashboard (default: 7333)
  -r, --root <path>   Folder awal yang discan (mis. ~/Projects)
      --no-open       Jangan buka browser otomatis
  -h, --help          Tampilkan bantuan ini
  -v, --version       Tampilkan versi
`;

function parseArgs(argv) {
  const opts = { port: null, root: null, open: true };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '-h' || a === '--help') { console.log(HELP.trim()); process.exit(0); }
    else if (a === '-v' || a === '--version') {
      const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
      console.log(`dev-bashboard v${pkg.version}`);
      process.exit(0);
    }
    else if (a === '-p' || a === '--port') opts.port = parseInt(argv[++i], 10);
    else if (a === '-r' || a === '--root') opts.root = argv[++i];
    else if (a === '--no-open') opts.open = false;
    else {
      console.error(`Opsi tidak dikenal: ${a}\n${HELP.trim()}`);
      process.exit(1);
    }
  }
  return opts;
}

const opts = parseArgs(process.argv.slice(2));

if (opts.port !== null && (!Number.isInteger(opts.port) || opts.port < 1024 || opts.port > 65535)) {
  console.error('[dev-bashboard] Port harus angka 1024-65535');
  process.exit(1);
}

if (!fs.existsSync(path.join(ROOT, 'node_modules', 'express'))) {
  console.error('[dev-bashboard] Dependency belum terpasang.');
  console.error('  Jalankan dulu di folder repo:');
  console.error(`    cd ${ROOT} && npm install`);
  process.exit(1);
}

const { start } = await import('../server/index.js');

try {
  await start({ port: opts.port ?? undefined, scanRoot: opts.root });
} catch (e) {
  console.error(`[dev-bashboard] ${e.message}`);
  process.exit(1);
}

const port = opts.port ?? parseInt(process.env.DASHBOARD_PORT || '7333', 10);
const url = `http://127.0.0.1:${port}`;

console.log('Tekan Ctrl+C untuk menghentikan DevBashboard.');

if (opts.open) {
  const platform = process.platform;
  const [cmd, args] = platform === 'win32'
    ? ['cmd', ['/c', 'start', '', url]]
    : platform === 'darwin'
      ? ['open', [url]]
      : ['xdg-open', [url]];
  const child = spawn(cmd, args, { detached: true, stdio: 'ignore' });
  child.on('error', () => {
    console.log(`[dev-bashboard] browser tidak bisa dibuka otomatis — buka manual: ${url}`);
  });
  child.unref();
}
