// Runtime bootstrap: the skill is often installed by tools that only copy files
// (npx skills, gh skill, Claude Code plugins). Install playwright-core on first use.
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { stateDir } from './common.mjs';

const skillDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const pkg = JSON.parse(fs.readFileSync(path.join(skillDir, 'package.json'), 'utf8'));
const range = pkg.dependencies['playwright-core'];

// Where playwright-core lives: the skill folder (npm install done by hand) or the shared runtime folder.
function located() {
  for (const dir of [skillDir, path.join(stateDir(), 'runtime')]) {
    const p = path.join(dir, 'node_modules', 'playwright-core');
    if (fs.existsSync(path.join(p, 'package.json'))) return p;
  }
  return null;
}

// Install into ~/.decision-playwright/runtime (writable even if the skill folder is not).
export function ensureRuntime() {
  if (located()) return located();
  const dir = path.join(stateDir(), 'runtime');
  fs.mkdirSync(dir, { recursive: true });
  if (!fs.existsSync(path.join(dir, 'package.json'))) fs.writeFileSync(path.join(dir, 'package.json'), '{"private":true}');
  process.stderr.write(`decision-playwright: first run, installing playwright-core ${range} into ${dir} ...\n`);
  // Run npm without a shell: npm_execpath is set under npm/npx; otherwise use npm-cli.js next to node.
  const npmCli = process.env.npm_execpath?.endsWith('.js') ? process.env.npm_execpath
    : path.join(path.dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js');
  const args = ['install', `playwright-core@${range}`, '--no-audit', '--no-fund', '--loglevel=error'];
  const r = fs.existsSync(npmCli)
    ? spawnSync(process.execPath, [npmCli, ...args], { cwd: dir, stdio: ['ignore', 'inherit', 'inherit'] })
    : spawnSync(process.platform === 'win32' ? 'npm.cmd' : 'npm', args, { cwd: dir, stdio: ['ignore', 'inherit', 'inherit'], shell: process.platform === 'win32' });
  if (r.status !== 0 || !located()) throw new Error(`Could not install playwright-core. Run: npm install --prefix "${skillDir}"`);
  return located();
}

export async function loadChromium() {
  const p = ensureRuntime();
  return (await import(pathToFileURL(path.join(p, 'index.mjs')).href)).chromium;
}

// Browser order: DPW_EXECUTABLE_PATH / DPW_CHANNEL, then Playwright's Chromium, Chrome, Edge.
// If none starts, download Playwright's Chromium once. The working choice is cached.
export async function launchBrowser(chromium, base) {
  if (process.env.DPW_EXECUTABLE_PATH) return chromium.launch({ ...base, executablePath: process.env.DPW_EXECUTABLE_PATH });
  if (process.env.DPW_CHANNEL) return chromium.launch({ ...base, channel: process.env.DPW_CHANNEL });
  const cache = path.join(stateDir(), 'browser.json');
  let cached = null;
  try { cached = JSON.parse(fs.readFileSync(cache, 'utf8')); } catch {}
  const tries = [cached, {}, { channel: 'chrome' }, { channel: 'msedge' }].filter(Boolean);
  for (const t of tries) {
    try {
      const b = await chromium.launch({ ...base, ...t });
      fs.writeFileSync(cache, JSON.stringify(t));
      return b;
    } catch {}
  }
  process.stderr.write('decision-playwright: no Chrome/Edge found, downloading Chromium ...\n');
  const cli = path.join(located(), 'cli.js');
  spawnSync(process.execPath, [cli, 'install', 'chromium'], { stdio: ['ignore', 'inherit', 'inherit'] });
  const b = await chromium.launch(base);
  fs.writeFileSync(cache, '{}');
  return b;
}
