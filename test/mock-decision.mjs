// Mock System One server. Deterministic policy for the test pages. Records auth headers per path.
import http from 'node:http';
export function startMock(port = 0) {
  const log = [];
  const server = http.createServer(async (req, res) => {
    let b = ''; for await (const c of req) b += c;
    const body = JSON.parse(b);
    log.push({ path: req.url, headers: req.headers, model: body.model, body });
    const { page, elements } = body.state;
    const q = body.questions;
    // Like the real API: a choice needs at least 2 criteria.
    if (Object.values(q).some(x => Object.keys(x.criteria).length < 2)) {
      return res.writeHead(422, { 'content-type': 'application/json' }).end('{"detail":[{"type":"too_short"}]}');
    }
    const pick = (name, choice) => {
      if (!q[name]) return undefined; // the client resolves a sole target without asking
      const ids = Object.keys(q[name].criteria);
      const probabilities = Object.fromEntries(ids.map(i => [i, i === choice ? 0.9 : 0.1 / (ids.length - 1)]));
      return { type: 'choice', choice, confidence: 0.9, probabilities };
    };
    const find = l => elements.find(e => e.label.includes(l))?.index;
    let op = 'BLOCKED', answers = {};
    if (page.title === 'Shop Home') { op = 'CLICK'; answers.click_target = pick('click_target', find('Go to search')); }
    else if (page.title === 'Search') {
      const qEl = elements.find(e => e.label === 'Query');
      const sort = elements.find(e => e.role === 'combobox' && e.options);
      if (!qEl.value) { op = 'TYPE_TEXT'; answers.type_text_target = pick('type_text_target', qEl.index); }
      else if (sort.value !== 'Price') { op = 'SELECT'; answers.select_target = pick('select_target', sort.options.find(o => o.label === 'Price').index); }
      else { op = 'CLICK'; answers.click_target = pick('click_target', find('Search')); }
    } else if (page.title === 'Results') op = 'DONE';
    // Long list: click the target link only if it was sent; otherwise BLOCKED like the real model.
    else if (page.title === 'Portal') { op = 'CLICK'; answers.click_target = pick('click_target', find('Documentation')); }
    else if (page.title === 'Documentation') {
      const id = elements.find(e => e.label === 'Release notes 1.0.2')?.index;
      if (id) { op = 'CLICK'; answers.click_target = pick('click_target', id); }
    } else if (page.title === 'Release notes') op = 'DONE';
    // Signup: the real model answers a weak BLOCKED (0.7) with TYPE_TEXT second.
    else if (page.title === 'Create account') {
      const ids = Object.keys(q.operation.criteria);
      const probabilities = Object.fromEntries(ids.map(i => [i, i === 'BLOCKED' ? 0.7 : i === 'TYPE_TEXT' ? 0.2 : 0.1 / (ids.length - 2)]));
      const name = elements.find(e => e.label === 'Full name');
      const reply = { answers: { operation: { type: 'choice', choice: 'BLOCKED', confidence: 0.6, probabilities },
        type_text_target: pick('type_text_target', name.index) }, model: body.model, usage: {} };
      return res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(reply));
    }
    answers.operation = pick('operation', op);
    res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ answers, model: body.model, usage: {} }));
  });
  return new Promise(r => server.listen(port, '127.0.0.1', () => r({ server, log, port: server.address().port })));
}
