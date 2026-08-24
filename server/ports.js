import net from 'net';
import { execFile } from 'child_process';

export const RESERVED_PORTS = new Set([
  20, 21, 22, 23, 25, 53, 67, 68, 69, 80, 110, 111, 123, 135, 137, 138, 139,
  143, 161, 162, 389, 443, 445, 465, 514, 515, 587, 623, 636, 873,
  1080, 1433, 1521, 2049, 2181, 2375, 2376, 2379, 2380, 3000, 3001, 3128,
  3306, 3389, 4000, 4200, 4444, 5000, 5001, 5060, 5061, 5173, 5174, 5353,
  5432, 5555, 5672, 5900, 5901, 5984, 6379, 6443, 7000, 7777, 8000, 8001,
  8008, 8080, 8081, 8086, 8443, 8500, 8888, 9000, 9001, 9090, 9092, 9200,
  9300, 9411, 11211, 15672, 16379, 26379, 27017, 27018, 27019, 28017
]);

const PORT_MIN = 1024;
const PORT_MAX = 65535;

function runSs() {
  return new Promise((resolve) => {
    execFile('ss', ['-Hltnp'], (err, stdout) => {
      if (err) {
        execFile('ss', ['-Hltn'], (err2, stdout2) => resolve(err2 ? '' : stdout2));
      } else {
        resolve(stdout);
      }
    });
  });
}

export async function getListeningPorts() {
  const out = await runSs();
  const result = [];
  for (const line of out.split('\n')) {
    const cols = line.trim().split(/\s+/);
    if (cols.length < 4) continue;
    const local = cols[3];
    if (!local) continue;
    const portStr = local.includes(']:') ? local.split(']:').pop() : local.split(':').pop();
    const port = parseInt(portStr, 10);
    if (!Number.isInteger(port)) continue;
    const procMatch = line.match(/users:\(\("([^"]+)",pid=(\d+)/);
    result.push({
      port,
      address: local,
      process: procMatch ? procMatch[1] : null,
      pid: procMatch ? parseInt(procMatch[2], 10) : null
    });
  }
  const seen = new Set();
  return result.filter(r => { const k = `${r.port}-${r.address}`; if (seen.has(k)) return false; seen.add(k); return true; });
}

export function isValidPort(p) {
  return Number.isInteger(p) && p >= PORT_MIN && p <= PORT_MAX;
}

function freeToBind(port) {
  return new Promise((resolve) => {
    const srv = net.createServer();
    srv.once('error', () => resolve(false));
    srv.listen(port, '0.0.0.0', () => srv.close(() => resolve(true)));
  });
}

export async function suggestPorts(count = 8, exclude = new Set()) {
  const listening = new Set((await getListeningPorts()).map(l => l.port));
  const out = [];
  let tries = 0;
  while (out.length < count && tries < 6000) {
    tries++;
    const p = 20000 + Math.floor(Math.random() * (PORT_MAX - 20000));
    if (RESERVED_PORTS.has(p) || listening.has(p) || exclude.has(p) || out.includes(p)) continue;
    if (await freeToBind(p)) out.push(p);
  }
  return out;
}

export function checkPortConflict(port, listening, managedRunning) {
  const sys = listening.find(l => l.port === port && l.address !== '*:22');
  if (sys) {
    return {
      conflict: true,
      reason: `Port ${port} sudah dipakai${sys.process ? ` oleh ${sys.process} (pid ${sys.pid})` : ' oleh proses lain'}`
    };
  }
  const managed = managedRunning.find(m => m.port === port);
  if (managed) {
    return { conflict: true, reason: `Port ${port} dipakai project "${managed.name}" yang sedang jalan` };
  }
  if (RESERVED_PORTS.has(port)) {
    return { conflict: true, reason: `Port ${port} adalah port bawaan layanan/dev server (mis. database, redis, framework). Pilih port lain di atas 20000` };
  }
  return { conflict: false };
}
