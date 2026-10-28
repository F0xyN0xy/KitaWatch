#!/usr/bin/env node
/** One-time setup: clone the Kuhi API and install its Python dependencies. */
import { existsSync, mkdirSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const apiDir = path.join(root, 'api', 'anime-api');
const FORK_URL = 'https://github.com/F0xyN0xy/anime-api';

const git = (args, cwd) => execFileSync('git', args, { cwd, stdio: 'inherit' });

if (existsSync(apiDir) && existsSync(path.join(apiDir, '.git'))) {
  if (process.env.KITAWATCH_API_UPDATE) {
    console.log('[setup:api] KITAWATCH_API_UPDATE set — pulling latest...');
    git(['pull'], apiDir);
  } else {
    console.log('[setup:api] Kuhi API already present — skipping pull (set KITAWATCH_API_UPDATE=1 to update).');
  }
} else if (existsSync(apiDir) && existsSync(path.join(apiDir, 'requirements.txt'))) {
  console.log('[setup:api] api/anime-api exists but is not a git clone — using as-is.');
} else {
  if (existsSync(apiDir)) {
    console.log('[setup:api] api/anime-api is incomplete (no requirements.txt) — recloning...');
    rmSync(apiDir, { recursive: true, force: true });
  }
  console.log('[setup:api] Cloning anime-api fork...');
  mkdirSync(path.dirname(apiDir), { recursive: true });
  git(['clone', FORK_URL, apiDir]);
}

const basePython = process.env.KITAWATCH_PYTHON || (process.platform === 'win32' ? 'py' : 'python3');
const pythonArgs = process.env.KITAWATCH_PYTHON
  ? []
  : process.platform === 'win32' ? ['-3.12'] : [];
const venvPythonFor = (dir) => path.join(
  dir, '.venv', process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python3',
);

function ensureVenv(dir, label) {
  const venvPython = venvPythonFor(dir);
  if (!existsSync(venvPython)) {
    console.log(`[setup:api] Creating isolated Python environment for ${label}...`);
    execFileSync(basePython, [...pythonArgs, '-m', 'venv', '.venv'], { cwd: dir, stdio: 'inherit' });
  }
  console.log(`[setup:api] Installing ${label} dependencies in ${venvPython}...`);
  execFileSync(venvPython, ['-m', 'pip', 'install', '--upgrade', 'pip'], { cwd: dir, stdio: 'inherit' });
  execFileSync(venvPython, ['-m', 'pip', 'install', '--upgrade', '-r', 'requirements.txt'], { cwd: dir, stdio: 'inherit' });
  execFileSync(venvPython, ['-m', 'pip', 'check'], { cwd: dir, stdio: 'inherit' });
}

// Each Python service gets its own environment. This prevents unrelated global
// packages (especially pydantic and pydantic-core) from breaking either service.
ensureVenv(apiDir, 'Kuhi API');
const proxyDir = path.join(root, 'proxy');
if (existsSync(path.join(proxyDir, 'requirements.txt'))) {
  ensureVenv(proxyDir, 'proxy');
}

console.log('[setup:api] Done. Python services use isolated .venv environments.');
console.log('[setup:api] Start the API with: npm run api');
console.log('[setup:api] (The Tauri app also auto-starts it when the ports are free.)');