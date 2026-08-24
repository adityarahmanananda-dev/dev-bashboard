import fs from 'fs';
import path from 'path';
import { execFile } from 'child_process';

export function venvName(project) {
  return `${project.name}.venv`;
}

export function venvPythonPath(project) {
  return path.join(project.path, venvName(project), 'bin', 'python');
}

export function hasVenv(project) {
  return fs.existsSync(venvPythonPath(project));
}

export function depFileFor(project) {
  const req = path.join(project.path, 'requirements.txt');
  if (fs.existsSync(req)) return { kind: 'requirements', path: req };
  const pyproj = path.join(project.path, 'pyproject.toml');
  if (fs.existsSync(pyproj)) return { kind: 'pyproject', path: pyproj };
  return null;
}

export function buildSetupSteps(project) {
  const steps = [];
  const py = venvPythonPath(project);
  if (!fs.existsSync(py)) {
    steps.push({
      argv: ['python3', '-m', 'venv', path.join(project.path, venvName(project))],
      label: `buat venv ${venvName(project)}`
    });
  }
  const depFile = depFileFor(project);
  if (depFile?.kind === 'requirements') {
    steps.push({ argv: [py, '-m', 'pip', 'install', '-r', 'requirements.txt'], label: 'install requirements.txt' });
  } else if (depFile?.kind === 'pyproject') {
    steps.push({ argv: [py, '-m', 'pip', 'install', '.'], label: 'install pyproject.toml' });
  }
  return steps;
}

export function depsSatisfied(project) {
  const py = venvPythonPath(project);
  if (!fs.existsSync(py)) return Promise.resolve(false);
  const depFile = depFileFor(project);
  if (!depFile) return Promise.resolve(true);

  const args =
    depFile.kind === 'requirements'
      ? ['-m', 'pip', 'install', '--dry-run', '--quiet', '-r', 'requirements.txt']
      : ['-m', 'pip', 'install', '--dry-run', '--quiet', '.'];

  return new Promise((resolve) => {
    execFile(py, args, { cwd: project.path, timeout: 90000 }, (err, stdout, stderr) => {
      if (!err) return resolve(true);
      const msg = `${stdout}${stderr}`;
      if (/unknown option|--dry-run|invalid choice/i.test(msg)) return resolve(true);
      resolve(false);
    });
  });
}
