/**
 * The little HTTP the three processes share: JSON in, JSON out, on localhost, and a `ready`
 * message to the parent once listening (with the port, since a test may ask for port 0).
 */
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';

export async function readText(req: IncomingMessage): Promise<string> {
  let raw = '';
  for await (const chunk of req) raw += chunk;
  return raw;
}

export async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  const raw = await readText(req);
  return raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
}

export function send(res: ServerResponse, status: number, payload: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(payload));
}

export function serveLocal(
  name: string,
  port: number,
  handle: (req: IncomingMessage, res: ServerResponse, path: string) => Promise<void>,
): void {
  const server = createServer((req, res) => {
    void handle(req, res, new URL(req.url ?? '/', 'http://localhost').pathname);
  });
  server.listen(port, '127.0.0.1', () => {
    const addr = server.address();
    process.send?.({ ready: name, port: typeof addr === 'object' && addr ? addr.port : port });
  });
}
