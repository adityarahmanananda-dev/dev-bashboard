import fs from 'fs';
import path from 'path';
import os from 'os';

const DATA_DIR = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..', 'data');
const STATE_FILE = path.join(DATA_DIR, 'state.json');

let state = { scanRoot: null, ports: {}, processes: [] };

export function load() {
  try {
    state = { ...state, ...JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')) };
  } catch {}
  if (!state.scanRoot) {
    const parent = path.resolve(DATA_DIR, '..', '..');
    state.scanRoot = fs.existsSync(parent) ? parent : os.homedir();
  }
  return state;
}

export function get() {
  return state;
}

export function save() {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
  } catch (e) {
    console.error('[state] gagal simpan:', e.message);
  }
}

export function setScanRoot(root) {
  state.scanRoot = root;
  save();
}

export function setPort(projectName, port) {
  if (port == null) delete state.ports[projectName];
  else state.ports[projectName] = port;
  save();
}

export function setProcesses(list) {
  state.processes = list;
  save();
}
