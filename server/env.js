import fs from 'fs';
import os from 'os';
import path from 'path';

export const ENV_KINDS = ['windows', 'wsl', 'linux', 'mac'];

const KIND_INFO = {
  windows: { label: 'Windows', python: 'python', venvSub: 'Scripts' },
  wsl: { label: 'WSL (Linux)', python: 'python3', venvSub: 'bin' },
  linux: { label: 'Linux', python: 'python3', venvSub: 'bin' },
  mac: { label: 'macOS', python: 'python3', venvSub: 'bin' }
};

let overrideKind = null;

export function detectRaw() {
  const p = process.platform;
  if (p === 'win32') return { kind: 'windows', confident: true, note: `Windows (${os.release()})` };
  if (p === 'darwin') return { kind: 'mac', confident: true, note: `macOS (${os.release()})` };
  if (p === 'linux') {
    let wsl = false;
    try {
      const v = fs.readFileSync('/proc/version', 'utf8').toLowerCase();
      wsl = v.includes('microsoft') || v.includes('wsl');
    } catch {}
    if (!wsl && (process.env.WSLENV || /microsoft/i.test(os.release()))) wsl = true;
    return wsl
      ? { kind: 'wsl', confident: true, note: `WSL (${os.release()})` }
      : { kind: 'linux', confident: true, note: `Linux (${os.release()})` };
  }
  return { kind: null, confident: false, note: `Platform tidak dikenal: ${p}` };
}

export function kind() {
  return overrideKind || detectRaw().kind;
}

export function setKind(k) {
  overrideKind = ENV_KINDS.includes(k) ? k : null;
}

export function detect() {
  const raw = detectRaw();
  return {
    kind: kind(),
    detected: raw.kind,
    confident: raw.confident,
    note: raw.note,
    override: !!overrideKind,
    kinds: ENV_KINDS.map(k => ({ id: k, label: KIND_INFO[k].label }))
  };
}

export function info(k) {
  return KIND_INFO[k] || { label: k || '?', python: 'python', venvSub: '' };
}

export function isWindows() {
  return kind() === 'windows';
}

export function pythonCmd() {
  return info(kind()).python;
}

export function venvBin(venvPath, name) {
  const sub = info(kind()).venvSub;
  const exe = isWindows() && !/\.(exe|cmd|bat)$/i.test(name) ? `${name}.exe` : name;
  return path.join(venvPath, sub, exe);
}

export function venvPython(venvPath) {
  return venvBin(venvPath, 'python');
}

export function venvFlask(venvPath) {
  return venvBin(venvPath, 'flask');
}

export function openBrowserCmd(url) {
  if (isWindows()) return { cmd: 'cmd', args: ['/c', 'start', '', url] };
  if (kind() === 'mac') return { cmd: 'open', args: [url] };
  return { cmd: 'xdg-open', args: [url] };
}