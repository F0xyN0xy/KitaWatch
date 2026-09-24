#!/usr/bin/env node
/**
 * Build standalone sidecar binaries (Option B).
 *
 *   npm run build:sidecars     (then `npm run tauri build`)
 *
 * Produces, in src-tauri/binaries/ (triple-suffixed for Tauri externalBin):
 *   kitawatch-kuhi-api-<triple>[.exe]   (PyInstaller onefile)
 *   kitawatch-proxy-<triple>[.exe]      (PyInstaller onefile)
 *   kitawatch-anivexa-<triple>[.exe]    (@yao-pkg/pkg)
 *
 * The generated Python entry also honours KITAWATCH_LOG_DIR: the Rust
 * launcher sets it (plus LOG_NAME/LOG_LEVEL) so windowed sidecars write
 * real logs users can paste into bug reports.
 *
 * Windows note: pkg fetches a prebuilt Node base binary; if the exact
 * version is missing from the remote cache it falls back to building from
 * source, which requires GNU `patch` in PATH (shipped with Git for Windows
 * at C:\Program Files\Git\usr\bin, or `choco install patch`). node22 is
 * tried FIRST because its Windows base binary is reliably cached (node20
 * win-x64 has been missing, forcing the from-source path). If neither
 * produces the exe, this script FAILS LOUDLY instead of silently shipping
 * an install without the Anivexa sidecar.
 */
import { existsSync, mkdirSync, writeFileSync, copyFileSync, statSync, chmodSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const triple = (() => {
  if (process.platform === 'win32') return 'x86_64-pc-windows-msvc';
  if (process.env.SIDE_TRIPLE) return process.env.SIDE_TRIPLE;
  if (process.arch === 'arm64') return 'aarch64-unknown-linux-gnu';
  return 'x86_64-unknown-linux-gnu';
})();
const ext = process.platform === 'win32' ? '.exe' : '';
const outDir = path.join(root, 'src-tauri', 'binaries');
mkdirSync(outDir, { recursive: true });
const py = process.env.KITAWATCH_PYTHON || (process.platform === 'win32' ? 'python' : 'python3');
const npx = process.platform === 'win32' ? 'npx.cmd' : 'npx';

const entries = [
  { dir: path.join(root, 'api', 'anime-api'), module: 'api:app', port: 8000, name: 'kitawatch-kuhi-api' },
  { dir: path.join(root, 'proxy'), module: 'server:app', port: 8001, name: 'kitawatch-proxy' },
];

for (const e of entries) {
  if (!existsSync(e.dir)) {
    console.log(`[sidecars] skipping ${e.name} — ${path.relative(root, e.dir)} not found`);
    continue;
  }
  const entryFile = path.join(e.dir, '_kitawatch_entry.py');
  const [mod, attr] = e.module.split(':');
  // Static import + app OBJECT (not "module:attr" string) — the string form
  // makes uvicorn import from CWD, which breaks outside the source dir.
  writeFileSync(
    entryFile,
    `import os\nimport sys\nimport multiprocessing\n\nif __name__ == "__main__":\n    multiprocessing.freeze_support()\n    # windowed (--noconsole) apps have no stdout on Windows; uvicorn's log\n    # formatter calls sys.stdout.isatty() and crashes without one.\n    # When the launcher sets KITAWATCH_LOG_DIR, mirror stdout/stderr to\n    # <dir>/<name>.log so users have something to paste into bug reports;\n    # otherwise fall back to the null device.\n    if sys.stdout is None:\n        log_dir = os.environ.get("KITAWATCH_LOG_DIR", "")\n        if log_dir:\n            os.makedirs(log_dir, exist_ok=True)\n            _log = open(os.path.join(log_dir, os.environ.get("LOG_NAME", "${e.name}") + ".log"), "a", buffering=1)\n            sys.stdout = _log\n            sys.stderr = _log\n        else:\n            sys.stdout = open(os.devnull, "w")\n            sys.stderr = open(os.devnull, "w")\n    import uvicorn\n    import ${mod}\n    uvicorn.run(${mod}.${attr}, host="127.0.0.1", port=int(os.environ.get("PORT", "${e.port}")), log_level=os.environ.get("LOG_LEVEL", "warning"))\n`,
  );
  console.log(`[sidecars] pyinstaller: ${e.name} ...`);
  // execFileSync with an args array: no shell, so paths/values from env or
  // the filesystem can never be reinterpreted (CWE-78).
  execFileSync(
    py,
    [
      '-m', 'PyInstaller',
      '--onefile', '--noconsole', '--noconfirm', '--clean',
      '--name', e.name,
      '--collect-submodules', 'api',
      '--collect-all', 'uvicorn',
      '--collect-all', 'fastapi',
      '--collect-all', 'httpx',
      '--hidden-import', 'multipart',
      entryFile,
    ],
    { cwd: e.dir, stdio: 'inherit' },
  );
  const target = path.join(outDir, `${e.name}-${triple}${ext}`);
  copyFileSync(path.join(e.dir, 'dist', `${e.name}${ext}`), target);
  if (process.platform !== 'win32') {
    try { chmodSync(target, 0o755); } catch {}
  }
  console.log(`[sidecars] -> ${path.relative(root, target)} (${statSync(target).size} bytes)`);
}

const anivexa = path.join(root, 'api', 'anivexa');
if (existsSync(anivexa)) {
  const target = path.join(outDir, `kitawatch-anivexa-${triple}${ext}`);
  let built = false;
  for (const nodeMajor of ['node20', 'node22']) {
    console.log(`[sidecars] pkg: anivexa (${nodeMajor}) ...`);
    try {
      // Linux CI: pkg may try to compile Node from source if prebuilt base missing -> hangs for 30min (g++ crypto_cipher.cc)
      // Use timeout to fail fast and try next version / skip. Skip if requested via SKIP_ANIVEXA.
      if (process.env.SKIP_ANIVEXA === '1') {
        console.log('[sidecars] SKIP_ANIVEXA=1 -> skipping anivexa build');
        break;
      }
      // execFileSync timeout: 4min max for pkg (download + pack). If hangs on g++ compile, kill.
      execFileSync(
        'npx',
        [
          '-y', '@yao-pkg/pkg', 'server.js',
          '--targets', `${nodeMajor}-${process.platform === 'win32' ? 'win' : 'linux'}-x64`,
          '--output', target,
        ],
        { cwd: anivexa, stdio: 'inherit', shell: true, timeout: 240_000 },
      );
    } catch (err) {
      const msg = String(err);
      // Timeout -> killed
      if (msg.includes('ETIMEDOUT') || msg.includes('timeout')) {
        console.log(`[sidecars] ${nodeMajor} timed out after 240s (likely building Node from source, no cached base) -> trying next`);
        continue;
      }
      console.log(`[sidecars] ${nodeMajor} failed: ${msg.slice(0, 800)}`);
      if (process.platform === 'win32' && msg.includes('spawnSync patch')) {
        console.log('[sidecars] base binary not in pkg cache and GNU patch not found in PATH.');
        console.log('[sidecars] fix: add "C:\\Program Files\\Git\\usr\\bin" to PATH (or `choco install patch`).');
      }
      continue;
    }
    if (existsSync(target)) {
      if (process.platform !== 'win32') {
        try { chmodSync(target, 0o755); } catch {}
      }
      built = true;
      break;
    }
  }
  if (!built) {
    if (process.env.CI || process.env.SKIP_ANIVEXA === '1') {
      console.log(`[sidecars] WARNING: anivexa not built (pkg timeout/missing base) - creating dummy placeholder for Tauri`);
      console.log(`[sidecars] The app will run without Anivexa provider, but other providers still work`);
      // Tauri requires externalBin files to exist at build time (tauri.conf -> binaries/...); create empty placeholder
      try {
        writeFileSync(target, '#!/bin/sh\necho "anivexa stub - not built (pkg skipped)" >&2\nexit 1\n');
        chmodSync(target, 0o755);
        console.log(`[sidecars] -> placeholder ${path.relative(root, target)}`);
      } catch (e) {
        console.log(`[sidecars] failed to create placeholder: ${e}`);
      }
    } else {
      throw new Error(
        `[sidecars] FAILED to produce ${path.relative(root, target)}\n` +
          'The Anivexa sidecar exe was NOT built — an install made now would have NO Anivexa API.\n' +
          'On Windows: pkg needs either a cached prebuilt Node base binary or GNU patch in PATH.\n' +
          'Install Git for Windows with "Unix tools" on PATH, or `choco install patch`, then re-run.\n' +
          'On Linux CI: set SKIP_ANIVEXA=1 to skip if pkg hangs.',
      );
    }
  } else {
    console.log(`[sidecars] -> ${path.relative(root, target)} (${statSync(target).size} bytes)`);
  }
} else {
  console.log('[sidecars] skipping anivexa — api/anivexa not found');
}
console.log('[sidecars] done. Next: npm run tauri build');