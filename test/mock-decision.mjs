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
    const pick = (name, choice) => {
      const ids = Object.keys(q[name].criteria);
      const probabilities = Object.fromEntries(ids.map(i => [i, i === choice ? 0.9 : 0.1 / Math.max(ids.length - 1, 1)]));
      if (ids.length === 1) probabilities[choice] = 1;
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
    answers.operation = pick('operation', op);
    res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ answers, model: body.model, usage: {} }));
  });
  return new Promise(r => server.listen(port, '127.0.0.1', () => r({ server, log, port: server.address().port })));
}
