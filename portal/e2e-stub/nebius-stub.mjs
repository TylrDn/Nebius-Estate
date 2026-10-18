// TEST ONLY: serves stubApi.js (documented Nebius REST, Monitoring and calculator shapes with
// invented e00mock data) on loopback for the synthetic demo and Playwright suite (app-config.e2e.yaml).
// Never part of a build or of any production configuration.
import { createServer } from 'node:http';
import { createRequire } from 'node:module';

const { handle } = createRequire(import.meta.url)('./stubApi.js');
const port = Number(process.env.E2E_STUB_PORT ?? 7199);

createServer((req, res) => {
  const chunks = [];
  req.on('data', c => chunks.push(c));
  req.on('end', () => {
    let body;
    try {
      body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : undefined;
    } catch {
      body = undefined;
    }
    const r = handle(req.method ?? 'GET', req.url ?? '/', req.headers, body);
    if (r.raw) {
      res.writeHead(r.status, { 'content-type': r.contentType ?? 'application/octet-stream', 'content-length': r.raw.length });
      res.end(r.raw);
      return;
    }
    res.writeHead(r.status, { 'content-type': 'application/json' });
    res.end(JSON.stringify(r.body));
  });
}).listen(port, '127.0.0.1', () => console.log(`nebius stub on http://127.0.0.1:${port}`));
