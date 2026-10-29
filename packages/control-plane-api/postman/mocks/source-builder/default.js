const http = require('node:http');
http.createServer(async (req, res) => {
  const send = (status, body) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)); };
  if (req.headers['x-service-token'] !== 'fixture-service-token') return send(403, { detail: 'forbidden' });
  if (!req.headers['x-substrat-tenant']) return send(400, { detail: 'tenant context is required' });
  const path = new URL(req.url, 'http://mock.test').pathname;
  if (path === '/internal/projects') return send(200, { tenant: req.headers['x-substrat-tenant'], projects: [] });
  if (path !== '/internal/build' || req.method !== 'POST') return send(501, { detail: 'Endpoint not modeled' });
  let input = req.body;
  if (!input) { let body = ''; for await (const chunk of req) body += chunk; input = JSON.parse(body); }
  if (typeof input === 'string') input = JSON.parse(input);
  const version = input.request?.version;
  if (version === 'failed') return send(422, { detail: 'dependency installation failed' });
  if (version === 'unavailable') return send(503, { detail: 'sandbox capacity unavailable' });
  const form = new FormData();
  if (version !== 'malformed') form.set('buildResult', JSON.stringify({
    projectId: `project-${req.headers['x-substrat-tenant']}`,
    revision: input.request.revision,
    dataLoss: { status: 'passed', authored: 0 },
  }));
  form.set('manifest', JSON.stringify({ version }));
  form.set('worker.js', new Blob(['export default {}'], { type: 'application/javascript+module' }), 'worker.js');
  const response = new Response(form);
  res.writeHead(200, Object.fromEntries(response.headers));
  res.end(Buffer.from(await response.arrayBuffer()));
}).listen(process.env.PORT);
