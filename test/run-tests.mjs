// End-to-end test: 5 providers x (run -> NEEDS_TYPING -> type -> resume -> NEEDS_VERIFICATION).
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
const run = promisify(execFile);
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startMock } from './mock-decision.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const cli = path.join(here, '../skills/decision-playwright/scripts/dpw.mjs');
const pages = http.createServer((req, res) => {
  const f = path.join(here, 'pages', new URL(req.url, 'http://x').pathname.replace(/^\/$/, '/index.html'));
  fs.existsSync(f) ? res.writeHead(200, { 'content-type': 'text/html' }).end(fs.readFileSync(f)) : res.writeHead(404).end();
});
await new Promise(r => pages.listen(0, '127.0.0.1', r));
const site = `http://127.0.0.1:${pages.address().port}`;
const mock = await startMock();
const m = `http://127.0.0.1:${mock.port}`;

const cases = {
  typesafe: { TYPESAFE_BASE_URL: m + '/v1', TYPESAFE_API_KEY: 'k-typesafe' , expect: ['/v1/systemone', 'authorization', 'Bearer k-typesafe', 'jev-latest'] },
  foundry: { FOUNDRY_ENDPOINT: m, FOUNDRY_API_KEY: 'k-foundry', DECISION_DEPLOYMENT: 'Microsoft-Decision-1.1', expect: ['/providers/microsoft/v1/systemone', 'api-key', 'k-foundry', 'Microsoft-Decision-1.1'] },
  endpoint: { DECISION_ENDPOINT_URL: m + '/custom/decide', DECISION_API_KEY: 'k-endpoint', DECISION_MODEL: 'decision-proxy', expect: ['/custom/decide', 'authorization', 'Bearer k-endpoint', 'decision-proxy'] },
  apim: { APIM_GATEWAY_URL: m + '/gw', APIM_SUBSCRIPTION_KEY: 'k-apim', DECISION_MODEL: 'Microsoft-Decision-1.1', expect: ['/gw/providers/microsoft/v1/systemone', 'ocp-apim-subscription-key', 'k-apim', 'Microsoft-Decision-1.1'] },
  aigateway: { AIGATEWAY_URL: m, AIGATEWAY_API_KEY: 'k-aigw', DECISION_MODEL: 'my-foundry/decision-1-1', expect: ['/default/models/providers/microsoft/v1/systemone', 'authorization', 'Bearer k-aigw', 'my-foundry/decision-1-1'] },
};
let failed = 0;
for (const [provider, c] of Object.entries(cases)) {
  const { expect, ...vars } = c;
  const env = { ...process.env, ...vars, DECISION_PROVIDER: provider, DPW_SESSION: 'test-' + provider };
  const dpw = async (...a) => { try { return JSON.parse((await run('node', [cli, ...a], { env })).stdout); } catch (e) { return JSON.parse(e.stdout); } };
  mock.log.length = 0;
  const steps = [];
  try {
    const r1 = await dpw('run', 'Search for "red shoes" sorted by price', '--url', site + '/');
    steps.push(r1.status);
    if (r1.status !== 'NEEDS_TYPING') throw new Error('expected NEEDS_TYPING: ' + JSON.stringify(r1));
    const t = await dpw('type', r1.target.ref, 'red shoes');
    steps.push('type:' + t.status);
    const r2 = await dpw('resume');
    steps.push(r2.status);
    if (r2.status !== 'NEEDS_VERIFICATION') throw new Error('expected NEEDS_VERIFICATION: ' + JSON.stringify(r2));
    const snap = await dpw('snapshot');
    if (!snap.text.includes('Results for red shoes sorted by price')) throw new Error('page text wrong: ' + snap.text);
    const last = mock.log.at(-1);
    const [p, h, v, model] = expect;
    if (last.path !== p || last.headers[h] !== v || last.model !== model) throw new Error('request wrong: ' + JSON.stringify({ path: last.path, h: last.headers[h], model: last.model }));
    console.log(`PASS ${provider}: ${steps.join(' -> ')} | ${mock.log.length} Decision calls | POST ${p} | ${h} | model=${model}`);
  } catch (e) { failed++; console.log(`FAIL ${provider}: ${e.message}`); }
  finally { await dpw('stop'); }
}
// Long page (300 links): the goal's link must be among the elements sent to Decision.
// Signup: a weak BLOCKED with an empty field falls back to TYPE_TEXT.
{
  const env = { ...process.env, DECISION_PROVIDER: 'endpoint', DECISION_ENDPOINT_URL: m + '/x', DECISION_API_KEY: 'k', DECISION_MODEL: 'd', DPW_SESSION: 'test-heuristics' };
  const dpw = async (...a) => { try { return JSON.parse((await run('node', [cli, ...a], { env })).stdout); } catch (e) { return JSON.parse(e.stdout); } };
  try {
    const r1 = await dpw('run', 'Open the documentation and open the release notes (not the download) for version 1.0.2.', '--url', site + '/home.html');
    const sent = mock.log.findLast(l => l.body.state.page.title === 'Documentation').body.state.elements.length;
    if (r1.status !== 'NEEDS_VERIFICATION' || !r1.page.url.endsWith('release.html?v=1.0.2')) throw new Error('long page: ' + JSON.stringify(r1));
    console.log(`PASS long page: goal link found among ${sent} sent elements (page has 300)`);
    const r2 = await dpw('run', 'Create an account for Jane Doe', '--url', site + '/signup.html');
    if (r2.status !== 'NEEDS_TYPING' || r2.fallbackFrom !== 'BLOCKED' || r2.target.label !== 'Full name') throw new Error('fallback: ' + JSON.stringify(r2));
    console.log('PASS weak BLOCKED: fell back to NEEDS_TYPING on "Full name"');
  } catch (e) { failed++; console.log('FAIL heuristics: ' + e.message); }
  finally { await dpw('stop'); }
}
// Missing secret must fail cleanly without printing secrets.
{
  const env = { ...process.env, DECISION_PROVIDER: 'foundry', FOUNDRY_RESOURCE: 'x', DECISION_DEPLOYMENT: 'd', FOUNDRY_API_KEY: '' };
  const out = (await run('node', [cli, 'config'], { env })).stdout;
  if (out.includes('Missing env FOUNDRY_API_KEY')) console.log('PASS config: missing key reported'); else { failed++; console.log('FAIL config: ' + out); }
}
mock.server.close(); pages.close();
process.exit(failed ? 1 : 0);
