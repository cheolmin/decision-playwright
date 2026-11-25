#!/usr/bin/env node
// decision-playwright CLI. Prints one JSON object per command.
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { stateDir } from './common.mjs';
import { ensureRuntime, loadChromium, launchBrowser } from './runtime.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2);
const flags = {};
const pos = [];
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a.startsWith('--')) {
    const [k, v] = a.slice(2).split('=');
    if (v !== undefined) flags[k] = v;
    else if (['submit', 'append', 'full'].includes(k)) flags[k] = true;
    else flags[k] = argv[++i];
  } else pos.push(a);
}
if (flags.session) process.env.DPW_SESSION = flags.session;
const session = process.env.DPW_SESSION || 'default';
const infoFile = path.join(stateDir(), `${session}.json`);
const print = o => { process.stdout.write(JSON.stringify(o, null, 2) + '\n'); };

const USAGE = `Usage: dpw <command> [args] [--session name]
  run "<goal>" [--url URL] [--fill JSON]   Decision clicks/scrolls/navigates until DONE, BLOCKED or NEEDS_TYPING.
                             --fill '{"Email":"a@b.c"}' types matching fields without stopping
  type <ref> "<text>" [<ref> "<text>" ...] [--submit] [--append]   Host agent types into fields
  type --fields '{"e1":"Jane","e2":"Doe"}'
  resume [--fill JSON]       Decision takes over again with the same goal
  open <url>                 Navigate without Decision
  snapshot [--full]          Page title, URL, element refs and text
  press <key>                Press a key (e.g. Enter, Escape)
  screenshot <file.png>      Save a screenshot
  status | stop | config
  setup                      Install playwright-core and check that a browser starts`;

function readInfo() { try { return JSON.parse(fs.readFileSync(infoFile, 'utf8')); } catch { return null; } }

async function call(info, cmd, args) {
  const res = await fetch(`http://127.0.0.1:${info.port}/`, {
    method: 'POST', headers: { 'x-dpw-token': info.token, 'content-type': 'application/json' },
    body: JSON.stringify({ cmd, args }),
  });
  return res.json();
}

async function alive(info) { try { await call(info, 'status', {}); return true; } catch { return false; } }

async function ensureDaemon() {
  let info = readInfo();
  if (info && await alive(info)) return info;
  try { fs.unlinkSync(infoFile); } catch {}
  ensureRuntime(); // first run: npm install in the foreground, before the 15 s daemon wait
  const log = fs.openSync(path.join(stateDir(), `${session}.log`), 'a');
  const child = spawn(process.execPath, [path.join(here, 'daemon.mjs')], { detached: true, stdio: ['ignore', log, log], env: process.env });
  child.unref();
  for (let i = 0; i < 150; i++) {
    await new Promise(r => setTimeout(r, 100));
    info = readInfo();
    if (info && await alive(info)) return info;
  }
  throw new Error(`Daemon did not start. See ${path.join(stateDir(), session + '.log')}`);
}

const [cmd, ...rest] = pos;

function jsonFlag(name) {
  if (flags[name] === undefined) return undefined;
  try { const v = JSON.parse(flags[name]); if (v && typeof v === 'object' && !Array.isArray(v)) return v; } catch {}
  throw new Error(`--${name} must be a JSON object, e.g. {"Email":"jane@example.com"}`);
}

// `type e1 "Jane"`, `type e1 "Jane" e2 "Doe"` (refs look like e<number>), or --fields '{"e1":"Jane"}'.
function typePairs() {
  if (flags.fields !== undefined) return Object.entries(jsonFlag('fields')).map(([r, t]) => [r, String(t)]);
  const isRef = x => /^e\d+$/.test(x);
  if (rest.length > 2 && rest.length % 2 === 0 && rest.every((x, i) => i % 2 || isRef(x))) {
    const out = [];
    for (let i = 0; i < rest.length; i += 2) out.push([rest[i], rest[i + 1]]);
    return out;
  }
  return rest[0] && rest.length >= 2 ? [[rest[0], rest.slice(1).join(' ')]] : [];
}
try {
  if (!cmd || cmd === 'help') { console.log(USAGE); process.exit(0); }
  if (cmd === 'config') {
    const { describeProvider } = await import('./provider.mjs');
    print(describeProvider());
    process.exit(0);
  }
  if (cmd === 'setup') {
    const browser = await launchBrowser(await loadChromium(), { headless: true });
    const version = browser.version();
    await browser.close();
    const { describeProvider } = await import('./provider.mjs');
    print({ status: 'OK', playwrightCore: ensureRuntime(), browser: version, provider: describeProvider() });
    process.exit(0);
  }
  if (cmd === 'stop') {
    const info = readInfo();
    print(info && await alive(info) ? await call(info, 'stop', {}) : { status: 'NOT_RUNNING', session });
    process.exit(0);
  }
  const map = {
    run: () => ({ goal: rest.join(' '), url: flags.url, fill: jsonFlag('fill') }),
    type: () => ({ pairs: typePairs(), submit: !!flags.submit, append: !!flags.append }),
    resume: () => ({ fill: jsonFlag('fill') }), status: () => ({}), snapshot: () => ({ full: !!flags.full }),
    open: () => ({ url: rest[0] }), press: () => ({ key: rest[0] }),
    screenshot: () => ({ file: path.resolve(rest[0] || 'dpw.png') }),
  };
  if (!map[cmd]) { console.error(USAGE); process.exit(2); }
  if (cmd === 'run' && !rest.length) throw new Error('run needs a goal');
  if (cmd === 'type' && !typePairs().length) throw new Error('type needs <ref> <text> [<ref> <text> ...] or --fields JSON');
  const info = await ensureDaemon();
  const out = await call(info, cmd, map[cmd]());
  print(out);
  process.exit(out.status === 'ERROR' ? 1 : 0);
} catch (e) {
  print({ status: 'ERROR', error: e.message });
  process.exit(1);
}
