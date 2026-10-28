#!/usr/bin/env node
/** Run the Kuhi API standalone (the Tauri app normally handles this itself). */
import { existsSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const apiDir = process.env.KITAWATCH_API_DIR
  ? path.resolve(process.env.KITAWATCH_API_DIR)
  : path.join(root, 'api', 'anime-api');

if (!existsSync(path.join(apiDir, 'api.py'))) {
  console.error('[api] Kuhi API not found at ' + apiDir);
  console.error('[api] Run `npm run setup:api` first.');
  process.exit(1);
}

const venvPython = path.join(apiDir, '.venv', process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python3');
const python = existsSync(venvPython)
  ? venvPython
  : process.env.KITAWATCH_PYTHON || (process.platform === 'win32' ? 'python' : 'python3');
if (!existsSync(venvPython)) {
  console.warn('[api] Isolated Python environment not found; run `npm run setup:api` to avoid global package conflicts.');
}
console.log('[api] Starting Kuhi API on http://127.0.0.1:8000 ...');

const child = spawn(
  python,
  ['-m', 'uvicorn', 'api:app', '--host', '127.0.0.1', '--port', '8000'],
  { cwd: apiDir, stdio: 'inherit' },
);

child.on('exit', (code) => process.exit(code ?? 0));
