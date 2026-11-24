// Background daemon: keeps one Playwright browser session alive and runs the Decision loop.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { chromium } from 'playwright-core';
import { decide, describeProvider } from './provider.mjs';
import { stateDir } from './common.mjs';

const session = process.env.DPW_SESSION || 'default';
const dir = stateDir();
const infoFile = path.join(dir, `${session}.json`);
const token = crypto.randomBytes(24).toString('hex');

const launch = { headless: process.env.DPW_HEADED !== '1' };
if (process.env.DPW_EXECUTABLE_PATH) launch.executablePath = process.env.DPW_EXECUTABLE_PATH;
else if (process.env.DPW_CHANNEL) launch.channel = process.env.DPW_CHANNEL;
const browser = await chromium.launch(launch);
const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
let page = await context.newPage();
context.on('page', p => { page = p; });

const run = { goal: null, history: [], steps: 0, status: 'idle', pending: null };
const MAX_STEPS = Number(process.env.DPW_MAX_STEPS || 40);

async function observe() {
  await page.waitForLoadState('domcontentloaded').catch(() => {});
  const data = await page.evaluate(() => {
    const sel = 'a[href],button,input,textarea,select,summary,[role=button],[role=link],[role=checkbox],[role=radio],[role=tab],[role=menuitem],[role=option],[role=switch],[role=combobox],[role=textbox],[contenteditable=""],[contenteditable=true],[onclick]';
    const visible = el => {
      const r = el.getBoundingClientRect(); const s = getComputedStyle(el);
      return r.width > 0 && r.height > 0 && s.visibility !== 'hidden' && s.display !== 'none' && !el.disabled;
    };
    const labelOf = el => {
      const t = (x) => (x || '').replace(/\s+/g, ' ').trim();
      const byId = el.id && document.querySelector(`label[for="${CSS.escape(el.id)}"]`);
      return t(el.getAttribute('aria-label')) || t(byId?.innerText) || t(el.closest('label')?.innerText) ||
        t(el.getAttribute('placeholder')) || t(el.innerText) || t(el.value && el.type !== 'password' ? '' : '') ||
        t(el.getAttribute('title')) || t(el.getAttribute('name')) || t(el.getAttribute('alt')) || el.tagName.toLowerCase();
    };
    let n = 0; const out = [];
    document.querySelectorAll('[data-dpw-ref]').forEach(e => e.removeAttribute('data-dpw-ref'));
    for (const el of document.querySelectorAll(sel)) {
      if (!visible(el) || out.length >= 200) continue;
      const tag = el.tagName.toLowerCase(); const type = (el.getAttribute('type') || '').toLowerCase();
      const role = el.getAttribute('role') || (tag === 'a' ? 'link' : tag === 'select' ? 'combobox' : tag === 'textarea' ? 'textbox' :
        tag === 'input' ? (['checkbox', 'radio'].includes(type) ? type : ['submit', 'button', 'reset', 'image'].includes(type) ? 'button' : 'textbox') : tag === 'button' || tag === 'summary' ? 'button' : 'generic');
      const ref = 'e' + (++n); el.setAttribute('data-dpw-ref', ref);
      const item = { index: String(n), ref, role, label: labelOf(el).slice(0, 160) };
      const editable = role === 'textbox' || role === 'combobox' && tag !== 'select' || el.isContentEditable;
      if (tag === 'select') {
        item.value = el.selectedOptions[0]?.text || '';
        item.ops = ['SELECT'];
        item.options = [...el.options].map((o, i) => ({ index: `${n}:${i + 1}`, label: o.text.trim(), value: o.value }));
      } else if (editable) {
        item.value = type === 'password' ? (el.value ? '********' : '') : (el.isContentEditable ? el.innerText : el.value || '').slice(0, 200);
        if (type === 'password') item.sensitive = true;
        item.ops = ['TYPE_TEXT', 'CLICK'];
      } else {
        if (role === 'checkbox' || role === 'radio') item.checked = el.checked ?? el.getAttribute('aria-checked') === 'true';
        item.ops = ['CLICK'];
      }
      out.push(item);
    }
    return { url: location.href, title: document.title, text: (document.body?.innerText || '').replace(/\n{3,}/g, '\n\n'), elements: out };
  });
  return data;
}

const brief = s => ({ url: s.url, title: s.title, elements: s.elements.map(({ index, ops, ...e }) => e) });

async function act(dec, state) {
  const { operation, target } = dec;
  if (operation === 'SELECT') {
    const [elIdx] = target.split(':');
    const el = state.elements.find(e => e.index === elIdx);
    const opt = el.options.find(o => o.index === target);
    await page.locator(`[data-dpw-ref="${el.ref}"]`).selectOption(opt.value, { timeout: 5000 });
    return { action: 'select', ref: el.ref, label: el.label, option: opt.label };
  }
  if (operation === 'CLICK') {
    const el = state.elements.find(e => e.index === target);
    await page.locator(`[data-dpw-ref="${el.ref}"]`).click({ timeout: 5000 });
    return { action: 'click', ref: el.ref, label: el.label };
  }
  if (operation === 'SCROLL_DOWN' || operation === 'SCROLL_UP') {
    await page.mouse.wheel(0, operation === 'SCROLL_DOWN' ? 700 : -700);
    return { action: operation.toLowerCase() };
  }
  if (operation === 'BACK') { await page.goBack({ timeout: 10000 }).catch(() => {}); return { action: 'back' }; }
  throw new Error('Unsupported operation ' + operation);
}

async function loop() {
  run.status = 'running';
  while (run.steps < MAX_STEPS) {
    const state = await observe();
    const dec = await decide(state, run.goal, run.history);
    run.steps++;
    if (dec.operation === 'DONE' || dec.operation === 'BLOCKED') {
      run.status = dec.operation === 'DONE' ? 'done' : 'blocked';
      return { status: dec.operation === 'DONE' ? 'NEEDS_VERIFICATION' : 'BLOCKED', goal: run.goal, steps: run.steps, confidence: dec.confidence, model: dec.model, page: { url: state.url, title: state.title }, history: run.history };
    }
    if (dec.operation === 'TYPE_TEXT') {
      const el = state.elements.find(e => e.index === dec.target);
      run.status = 'needs_typing';
      run.pending = el.ref;
      return {
        status: 'NEEDS_TYPING', goal: run.goal, steps: run.steps,
        target: { ref: el.ref, role: el.role, label: el.label, currentValue: el.value ?? '', sensitive: !!el.sensitive },
        confidence: dec.targetConfidence ?? dec.confidence, model: dec.model,
        page: { url: state.url, title: state.title },
        next: `Type with: dpw type ${el.ref} "<text>"  then: dpw resume`,
      };
    }
    const before = page.url();
    const done = await act(dec, state);
    await page.waitForLoadState('domcontentloaded', { timeout: 10000 }).catch(() => {});
    await page.waitForTimeout(Number(process.env.DPW_SETTLE_MS || 300));
    run.history.push({ ...done, page_changed: page.url() !== before, confidence: dec.confidence });
  }
  run.status = 'step_limit';
  return { status: 'STEP_LIMIT', goal: run.goal, steps: run.steps, history: run.history };
}

async function safeLoop() {
  try { return await loop(); }
  catch (e) { run.status = 'error'; return { status: 'ERROR', error: e.message, steps: run.steps }; }
}

const handlers = {
  async status() { return { session, status: run.status, goal: run.goal, steps: run.steps, url: page.url(), provider: describeProvider() }; },
  async open({ url }) { await page.goto(url, { waitUntil: 'domcontentloaded' }); return { status: 'OK', url: page.url(), title: await page.title() }; },
  async run({ goal, url }) {
    if (url) await page.goto(url, { waitUntil: 'domcontentloaded' });
    Object.assign(run, { goal, history: [], steps: 0, pending: null });
    return safeLoop();
  },
  async resume() {
    if (!run.goal) return { status: 'ERROR', error: 'No goal to resume. Use dpw run first.' };
    run.pending = null;
    return safeLoop();
  },
  async type({ ref, text, submit, append }) {
    const loc = page.locator(`[data-dpw-ref="${ref}"]`);
    if (!(await loc.count())) return { status: 'ERROR', error: `Unknown ref ${ref}. Run dpw snapshot for fresh refs.` };
    if (append) await loc.pressSequentially(text); else await loc.fill(text);
    if (submit) await loc.press('Enter');
    await page.waitForLoadState('domcontentloaded', { timeout: 10000 }).catch(() => {});
    run.history.push({ action: 'host_typed', ref, chars: text.length, submitted: !!submit });
    return { status: 'OK', ref, typedChars: text.length, submitted: !!submit, next: 'dpw resume' };
  },
  async press({ key }) { await page.keyboard.press(key); return { status: 'OK', key }; },
  async snapshot({ full }) { const s = await observe(); return { status: 'OK', ...brief(s), text: full ? s.text : s.text.slice(0, 4000) }; },
  async screenshot({ file }) { await page.screenshot({ path: file }); return { status: 'OK', file }; },
  async stop() { setTimeout(shutdown, 50); return { status: 'STOPPED', session }; },
};

let busy = false;
const server = http.createServer(async (req, res) => {
  if (req.headers['x-dpw-token'] !== token) { res.writeHead(403).end(); return; }
  let body = '';
  for await (const c of req) body += c;
  const { cmd, args = {} } = JSON.parse(body || '{}');
  let out;
  if (!handlers[cmd]) out = { status: 'ERROR', error: 'Unknown command ' + cmd };
  else if (busy && cmd !== 'status' && cmd !== 'stop') out = { status: 'ERROR', error: 'Session busy' };
  else {
    busy = true;
    try { out = await handlers[cmd](args); } catch (e) { out = { status: 'ERROR', error: e.message }; }
    finally { busy = false; }
  }
  res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(out));
});

async function shutdown() {
  try { fs.unlinkSync(infoFile); } catch {}
  await browser.close().catch(() => {});
  server.close();
  process.exit(0);
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

server.listen(0, '127.0.0.1', () => {
  fs.writeFileSync(infoFile, JSON.stringify({ port: server.address().port, token, pid: process.pid }), { mode: 0o600 });
});
