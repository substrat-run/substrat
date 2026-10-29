/**
 * One HTTPS request over TLS this worker runs itself, presenting a client certificate
 * (docs/rfc/mtls-hop.md). A Worker's `fetch` takes no client certificate and `node:tls` ignores
 * one, so the relay opens a plain TCP socket and hands the bytes to rustls (`mtls-wasm/`), which
 * does the handshake with the certificate the caller sent and only the roots it was given.
 *
 * Split from the socket and the WASM module, which `mtls-socket.ts` binds, so the framing,
 * the bounds and the stages are driven by node tests over a fake socket and a fake engine.
 *
 * Deliberately small: one request per connection (`Connection: close`), no redirects, no
 * keep-alive, a response read only up to a bound. It is a hop for a handful of RP calls,
 * not an HTTP client.
 */

/** The TLS engine, as the WASM module exposes it. One per connection. */
export interface TlsEngine {
  /** Bytes read off the socket; returns the plaintext they completed, if any. Throws on a TLS error. */
  receive(data: Uint8Array): Uint8Array;
  /** Bytes to write to the socket now. */
  transmit(): Uint8Array;
  /** Plaintext to send once the handshake allows. */
  send(plaintext: Uint8Array): void;
  readonly handshaking: boolean;
  readonly protocol: string | undefined;
  free?(): void;
}

export type TlsEngineFactory = (host: string, rootPem: string, certPem: string, keyPem: string) => TlsEngine;

/** The socket, as `cloudflare:sockets` exposes it. */
export interface Socket {
  readonly opened: Promise<unknown>;
  readonly readable: ReadableStream<Uint8Array>;
  readonly writable: WritableStream<Uint8Array>;
  close(): Promise<void>;
}

export type SocketOpener = (host: string, port: number) => Socket;

/** Where a call got to, and how long it had taken by then. What a failure is reported against. */
export type MtlsStageName = 'tls.config' | 'tcp.open' | 'tls.handshake' | 'http.response';

export interface MtlsStage {
  stage: MtlsStageName;
  ms: number;
  protocol?: string;
  status?: number;
}

export interface MtlsRequest {
  host: string;
  port?: number;
  method: 'POST';
  path: string;
  body: string;
  rootPem: string;
  certPem: string;
  keyPem: string;
}

export interface MtlsResponse {
  status: number;
  /** The response body as text, read up to the bound. */
  text: string;
  stages: MtlsStage[];
}

/** A call that did not get an answer: the stage it failed in, and the stages it passed. */
export class MtlsFailure extends Error {
  constructor(
    readonly stage: MtlsStageName,
    message: string,
    readonly stages: MtlsStage[],
  ) {
    super(message);
    this.name = 'MtlsFailure';
  }
}

export interface MtlsClientOptions {
  openSocket: SocketOpener;
  tls: TlsEngineFactory;
  /** Whole-call deadline. */
  deadlineMs: number;
  /** The response is read up to this many bytes; a longer one fails rather than truncating. */
  maxResponseBytes: number;
  now?: () => number;
}

const encoder = new TextEncoder();
const decoder = new TextDecoder();

export function mtlsClient(options: MtlsClientOptions) {
  const now = options.now ?? (() => Date.now());

  return async function call(request: MtlsRequest): Promise<MtlsResponse> {
    const started = now();
    const stages: MtlsStage[] = [];
    const mark = (stage: MtlsStageName, extra: Partial<MtlsStage> = {}) => stages.push({ stage, ms: now() - started, ...extra });
    const fail = (stage: MtlsStageName, e: unknown): never => {
      throw new MtlsFailure(stage, e instanceof Error ? e.message : String(e), stages);
    };

    let engine: TlsEngine;
    try {
      engine = options.tls(request.host, request.rootPem, request.certPem, request.keyPem);
    } catch (e) {
      return fail('tls.config', e);
    }
    mark('tls.config');

    let socket: Socket | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let stage: MtlsStageName = 'tcp.open';
    const deadline = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`no answer within ${options.deadlineMs} ms`)), options.deadlineMs);
    });

    const exchange = async (): Promise<MtlsResponse> => {
      socket = options.openSocket(request.host, request.port ?? 443);
      await socket.opened;
      mark('tcp.open');
      stage = 'tls.handshake';

      const writer = socket.writable.getWriter();
      const reader = socket.readable.getReader();
      const flush = async () => {
        const out = engine.transmit();
        if (out.length) await writer.write(out);
      };

      engine.send(encoder.encode(requestHead(request) + request.body));
      await flush();

      const chunks: Uint8Array[] = [];
      let received = 0;
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        const plain = engine.receive(value);
        if (stage === 'tls.handshake' && !engine.handshaking) {
          mark('tls.handshake', { protocol: engine.protocol });
          stage = 'http.response';
        }
        if (plain.length) {
          received += plain.length;
          if (received > options.maxResponseBytes) throw new Error(`response larger than ${options.maxResponseBytes} bytes`);
          chunks.push(plain);
        }
        await flush();
      }
      if (stage === 'tls.handshake') throw new Error('the connection closed before the handshake finished');
      const { status, text } = parseResponse(concat(chunks));
      mark('http.response', { status });
      return { status, text, stages };
    };

    try {
      return await Promise.race([exchange(), deadline]);
    } catch (e) {
      if (e instanceof MtlsFailure) throw e;
      return fail(stage, e);
    } finally {
      clearTimeout(timer);
      await socket?.close().catch(() => undefined);
      engine.free?.();
    }
  };
}

function requestHead(request: MtlsRequest): string {
  const length = encoder.encode(request.body).length;
  return (
    `${request.method} ${request.path} HTTP/1.1\r\n` +
    `Host: ${request.host}\r\n` +
    'Content-Type: application/json\r\n' +
    'Accept: application/json\r\n' +
    `Content-Length: ${length}\r\n` +
    'Connection: close\r\n\r\n'
  );
}

function concat(parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

/**
 * An HTTP/1.1 response read to the close: the status line, then a body framed by
 * `Content-Length`, by chunked transfer encoding, or by the close itself.
 *
 * Framed on BYTES, decoded last: both lengths count bytes, and a BankID `collect` answer
 * carries a person's name, so slicing decoded text by them would cut off "Åsa".
 */
export function parseResponse(bytes: Uint8Array): { status: number; text: string } {
  const split = indexOfCrlf(bytes, 0, true);
  if (split < 0) throw new Error('the response had no header terminator');
  const head = decoder.decode(bytes.subarray(0, split));
  const rest = bytes.subarray(split + 4);
  const status = Number(/^HTTP\/1\.[01] (\d{3})/.exec(head)?.[1]);
  if (!Number.isInteger(status)) throw new Error('the response had no status line');
  const header = (name: string) => new RegExp(`^${name}:\\s*(.+)$`, 'im').exec(head)?.[1]?.trim();
  if (/chunked/i.test(header('transfer-encoding') ?? '')) return { status, text: decoder.decode(dechunk(rest)) };
  const length = Number(header('content-length'));
  return { status, text: decoder.decode(Number.isInteger(length) ? rest.subarray(0, length) : rest) };
}

/** The index of the next CRLF (or, with `double`, CRLFCRLF) at or after `from`; -1 if none. */
function indexOfCrlf(bytes: Uint8Array, from: number, double = false): number {
  for (let i = from; i + (double ? 3 : 1) < bytes.length; i++) {
    if (bytes[i] !== 13 || bytes[i + 1] !== 10) continue;
    if (!double || (bytes[i + 2] === 13 && bytes[i + 3] === 10)) return i;
  }
  return -1;
}

function dechunk(body: Uint8Array): Uint8Array {
  const parts: Uint8Array[] = [];
  let at = 0;
  for (;;) {
    const lineEnd = indexOfCrlf(body, at);
    if (lineEnd < 0) throw new Error('a chunk size line was cut off');
    const size = parseInt(decoder.decode(body.subarray(at, lineEnd)), 16);
    if (!Number.isFinite(size)) throw new Error('a chunk size was not a number');
    if (size === 0) return concat(parts);
    parts.push(body.subarray(lineEnd + 2, lineEnd + 2 + size));
    at = lineEnd + 2 + size + 2;
  }
}
