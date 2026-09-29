#!/usr/bin/env node
/** npm run release:tag -- 0.4.0   →   bump versions, commit, tag, push */
import { readFileSync, writeFileSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const version = process.argv[2];
if (!version || !/^\d+\.\d+\.\d+$/.test(version)) {
  console.error('Usage: npm run release:tag -- <version>   (e.g. 0.4.0)');
  process.exit(1);
}
const tag = `v${version}`;
const run = (cmd) => execSync(cmd, { cwd: root, stdio: 'inherit' });

// 1. bump package.json
const pkgPath = path.join(root, 'package.json');
const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));
pkg.version = version;
writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + '\n');

// 2. bump tauri.conf.json
const confPath = path.join(root, 'src-tauri', 'tauri.conf.json');
const conf = JSON.parse(readFileSync(confPath, 'utf8'));
conf.version = version;
writeFileSync(confPath, JSON.stringify(conf, null, 2) + '\n');

// 3. bump Cargo.toml (simple line replace)
const cargoPath = path.join(root, 'src-tauri', 'Cargo.toml');
writeFileSync(
  cargoPath,
  readFileSync(cargoPath, 'utf8').replace(/^version = ".*"$/m, `version = "${version}"`),
);

console.log(`[release] bumped to ${version}`);
run('git add .');
// Version may already be bumped in the working copy (e.g. re-running the
// script) — an empty commit exits 1 and would abort before the tag push.
const staged = execSync('git status --porcelain', { cwd: root, encoding: 'utf8' }).trim();
if (staged) {
  run(`git commit -m "${tag}"`);
} else {
  console.log('[release] nothing to commit — versions already bumped, tagging existing tree');
}
run(`git tag ${tag}`);
run('git push origin main');
run(`git push origin ${tag}`);
console.log(`[release] ${tag} pushed — GitHub Actions is building the release now.`);