import { URL } from 'node:url';
import type { FetchLike } from '@substrat-run/kernel';
import { quickXorHash } from '../src/quickxor.js';

/**
 * A stand-in for one SharePoint document library behind Graph, with a change feed.
 *
 * It models what the connector depends on and nothing more: items by id with a parent, the
 * `/delta` feed on the drive root (a full enumeration, then only what changed since a token —
 * and, as on SharePoint, a moved or renamed folder appears alone, without its descendants),
 * path addressing relative to an item id, simple uploads with a conflict behaviour, upload
 * sessions, and the token endpoint. What it cannot prove is that Graph answers in these shapes;
 * that is the live-tenant check.
 */

export const GRAPH = 'https://graph.example';
export const LOGIN = 'https://login.example';
export const DRIVE = 'drive-1';
export const APP_ID = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
const UPLOAD = 'https://upload.example/session/';

interface Item {
  id: string;
  name: string;
  parentId: string | null;
  kind: 'file' | 'folder' | 'root';
  content: Uint8Array;
  version: number;
  contentVersion: number;
  deleted: boolean;
  createdByApp: string | null;
  createdAt: string;
  mimeType: string;
  /** Changes at or below this sequence number are already reported to a token holder. */
  seq: number;
}

export interface Call {
  method: string;
  url: string;
  headers: Record<string, string>;
  bodyBytes: number;
}

export class FakeDrive {
  readonly calls: Call[] = [];
  private readonly items = new Map<string, Item>();
  private seq = 0;
  private nextId = 1;
  private sessions = new Map<string, { parentId: string; path: string[]; conflict: string; received: Uint8Array[]; size: number }>();
  /** Set to make the next matching request fail: return a status for a URL predicate. */
  failures: { when: (c: Call) => boolean; status: number; once?: boolean }[] = [];
  /**
   * Requests that Graph CARRIES OUT and whose answer is then lost — the network drops after the
   * write committed. The crash window a ledger cannot close on its own.
   */
  lostAnswers: { when: (c: Call) => boolean; once?: boolean }[] = [];
  /** Delta tokens older than this answer 410 (Graph's "resync required"). */
  expiredBefore = 0;
  /** Items whose size the drive leaves out, as Graph may. */
  sizeless = new Set<string>();
  /** Items per delta page — small, so every test pages. */
  pageSize = 3;
  /** A `nextLink` to hand back instead of the real one (the foreign-link test). */
  nextLinkOverride: string | null = null;
  now = new Date('2026-10-17T10:00:00Z');

  constructor() {
    this.items.set('root', this.item('root', 'root', null, 'root'));
  }

  private item(id: string, name: string, parentId: string | null, kind: Item['kind']): Item {
    return {
      id,
      name,
      parentId,
      kind,
      content: new Uint8Array(),
      version: 1,
      contentVersion: 1,
      deleted: false,
      createdByApp: null,
      createdAt: this.now.toISOString(),
      mimeType: 'text/plain',
      seq: ++this.seq,
    };
  }

  // ── what a person does in Teams ────────────────────────────────────────────

  mkdir(parentId: string, name: string): string {
    const id = `i${this.nextId++}`;
    this.items.set(id, this.item(id, name, parentId, 'folder'));
    return id;
  }
  put(parentId: string, name: string, content: string | Uint8Array, by: string | null = null): string {
    const id = `i${this.nextId++}`;
    const it = this.item(id, name, parentId, 'file');
    it.content = typeof content === 'string' ? new TextEncoder().encode(content) : content;
    it.createdByApp = by;
    this.items.set(id, it);
    return id;
  }
  edit(id: string, content: string) {
    const it = this.must(id);
    it.content = new TextEncoder().encode(content);
    it.version += 1;
    it.contentVersion += 1;
    it.seq = ++this.seq;
  }
  /** Change a stored file's bytes in place, as SharePoint does to an Office document it stores. */
  tamper(parentId: string, name: string, content: string) {
    const it = this.live().find((i) => i.parentId === parentId && i.name === name)!;
    it.content = new TextEncoder().encode(content);
  }
  rename(id: string, name: string) {
    const it = this.must(id);
    it.name = name;
    it.version += 1;
    it.seq = ++this.seq;
  }
  move(id: string, parentId: string) {
    const it = this.must(id);
    it.parentId = parentId;
    it.version += 1;
    it.seq = ++this.seq;
  }
  remove(id: string) {
    const it = this.must(id);
    it.deleted = true;
    it.seq = ++this.seq;
    // Descendants go with it, as in the recycle bin, but the feed reports the folder alone.
    for (const child of this.live()) if (this.isUnder(child.id, id)) child.deleted = true;
  }

  // ── what a test reads back ─────────────────────────────────────────────────

  childrenNamed(parentId: string): string[] {
    return this.live()
      .filter((i) => i.parentId === parentId)
      .map((i) => i.name)
      .sort();
  }
  text(parentId: string, name: string): string | undefined {
    const it = this.live().find((i) => i.parentId === parentId && i.name === name);
    return it ? new TextDecoder().decode(it.content) : undefined;
  }
  graphCalls(): Call[] {
    return this.calls.filter((c) => !c.url.includes('/oauth2/'));
  }

  // ── the HTTP surface ───────────────────────────────────────────────────────

  fetch: FetchLike = async (input, init) => {
    const body = init?.body;
    const call: Call = {
      method: init?.method ?? 'GET',
      url: input,
      headers: init?.headers ?? {},
      bodyBytes: typeof body === 'string' ? body.length : (body?.byteLength ?? 0),
    };
    this.calls.push(call);
    const failure = this.failures.find((f) => f.when(call));
    if (failure) {
      if (failure.once) this.failures.splice(this.failures.indexOf(failure), 1);
      return respond(failure.status, { error: { code: 'injected', message: `injected ${failure.status}` } });
    }
    try {
      const res = await this.route(call, body);
      const lost = this.lostAnswers.find((l) => l.when(call));
      if (lost) {
        if (lost.once) this.lostAnswers.splice(this.lostAnswers.indexOf(lost), 1);
        throw new TypeError('fetch failed: the connection closed before the answer arrived');
      }
      return res;
    } catch (e) {
      if (e instanceof Status) return respond(e.status, { error: { code: e.code, message: e.message } });
      throw e;
    }
  };

  private async route(call: Call, body: string | Uint8Array | undefined) {
    const { method, url } = call;
    if (url.startsWith(LOGIN) && url.includes('/oauth2/v2.0/token')) return respond(200, { access_token: 'TOKEN' });
    if (url.startsWith(UPLOAD)) return this.session(call, body);
    if (!url.startsWith(`${GRAPH}/v1.0/`)) throw new Status(404, 'noRoute', 'no route');
    if (call.headers.authorization !== 'Bearer TOKEN') throw new Status(401, 'unauthenticated', 'no token');
    const u = new URL(url);
    const path = u.pathname.slice('/v1.0/'.length);

    let m = /^sites\/[^/]+:\/sites\/Team\/drive\/root:\/(.+)$/.exec(path);
    if (m && method === 'GET') return respond(200, this.view(this.resolve('root', decodeSegments(m[1]!))));

    m = /^drives\/drive-1\/root\/delta$/.exec(path);
    if (m && method === 'GET') return this.delta(Number(u.searchParams.get('token') ?? '0'), Number(u.searchParams.get('skip') ?? '0'));

    m = /^drives\/drive-1\/items\/([^/:]+)\/children$/.exec(path);
    if (m && method === 'GET') {
      return respond(200, { value: this.live().filter((i) => i.parentId === m![1]).map((i) => this.view(i)) });
    }
    m = /^drives\/drive-1\/items\/([^/:]+)\/content$/.exec(path);
    if (m && method === 'GET') {
      const it = this.must(decodeURIComponent(m[1]!));
      return respond(200, it.content);
    }
    m = /^drives\/drive-1\/items\/([^/:]+):\/(.+):\/content$/.exec(path);
    if (m && method === 'PUT') {
      const conflict = u.searchParams.get('@microsoft.graph.conflictBehavior') ?? 'fail';
      const bytes = typeof body === 'string' ? new TextEncoder().encode(body) : (body ?? new Uint8Array());
      return respond(201, this.view(this.write(m[1]!, decodeSegments(m[2]!), bytes, conflict)));
    }
    m = /^drives\/drive-1\/items\/([^/:]+):\/(.+):\/createUploadSession$/.exec(path);
    if (m && method === 'POST') {
      const conflict = (JSON.parse(String(body)) as { item: Record<string, string> }).item['@microsoft.graph.conflictBehavior']!;
      const segments = decodeSegments(m[2]!);
      if (conflict === 'fail' && this.find(m[1]!, segments)) throw new Status(409, 'nameAlreadyExists', 'exists');
      const id = String(this.sessions.size + 1);
      this.sessions.set(id, { parentId: m[1]!, path: segments, conflict, received: [], size: 0 });
      return respond(200, { uploadUrl: `${UPLOAD}${id}` });
    }
    m = /^drives\/drive-1\/items\/([^/:]+):\/(.+)$/.exec(path);
    if (m && method === 'GET') return respond(200, this.view(this.resolve(m[1]!, decodeSegments(m[2]!))));
    m = /^drives\/drive-1\/items\/([^/:]+)$/.exec(path);
    if (m && method === 'GET') return respond(200, this.view(this.must(m[1]!)));
    throw new Status(404, 'noRoute', `no route for ${method}`);
  }

  private session(call: Call, body: string | Uint8Array | undefined) {
    if (call.headers.authorization) throw new Status(401, 'unauthenticated', 'an upload URL takes no token');
    const id = call.url.slice(UPLOAD.length);
    const s = this.sessions.get(id);
    if (!s) throw new Status(404, 'itemNotFound', 'no session');
    if (call.method === 'DELETE') {
      this.sessions.delete(id);
      return respond(204, {});
    }
    const range = /^bytes (\d+)-(\d+)\/(\d+)$/.exec(call.headers['content-range'] ?? '');
    if (!range) throw new Status(400, 'invalidRange', 'no range');
    const bytes = body as Uint8Array;
    s.received.push(bytes.slice());
    s.size += bytes.byteLength;
    const total = Number(range[3]);
    if (s.size < total) return respond(202, { nextExpectedRanges: [`${s.size}-`] });
    const all = new Uint8Array(total);
    let at = 0;
    for (const part of s.received) {
      all.set(part, at);
      at += part.byteLength;
    }
    this.sessions.delete(id);
    return respond(201, this.view(this.write(s.parentId, s.path, all, s.conflict)));
  }
  openSessions(): number {
    return this.sessions.size;
  }

  private write(parentId: string, segments: string[], bytes: Uint8Array, conflict: string): Item {
    let parent = this.must(parentId);
    for (const name of segments.slice(0, -1)) {
      const next = this.live().find((i) => i.parentId === parent.id && i.name === name);
      parent = next ?? this.must(this.mkdir(parent.id, name));
    }
    let name = segments.at(-1)!;
    const existing = this.live().find((i) => i.parentId === parent.id && i.name === name);
    if (existing && conflict === 'fail') throw new Status(409, 'nameAlreadyExists', 'exists');
    if (existing && conflict === 'replace') {
      existing.content = bytes;
      existing.version += 1;
      existing.contentVersion += 1;
      existing.seq = ++this.seq;
      return existing;
    }
    if (existing) {
      for (let n = 1; this.live().some((i) => i.parentId === parent.id && i.name === name); n += 1) {
        const dot = segments.at(-1)!.lastIndexOf('.');
        const base = segments.at(-1)!;
        name = dot > 0 ? `${base.slice(0, dot)} ${n}${base.slice(dot)}` : `${base} ${n}`;
      }
    }
    return this.must(this.put(parent.id, name, bytes, APP_ID));
  }

  private delta(token: number, skip: number) {
    if (token > 0 && token < this.expiredBefore) throw new Status(410, 'resyncRequired', 'resync');
    const changed = [...this.items.values()]
      .filter((i) => (token === 0 ? !i.deleted : i.seq > token))
      .sort((a, b) => a.seq - b.seq);
    const pageItems = changed.slice(skip, skip + this.pageSize);
    const more = skip + this.pageSize < changed.length;
    const link = `${GRAPH}/v1.0/drives/${DRIVE}/root/delta?token=${token}&skip=${skip + this.pageSize}`;
    return respond(200, {
      value: pageItems.map((i) => this.view(i)),
      ...(more
        ? { '@odata.nextLink': this.nextLinkOverride ?? link }
        : { '@odata.deltaLink': `${GRAPH}/v1.0/drives/${DRIVE}/root/delta?token=${this.seq}` }),
    });
  }

  private view(i: Item) {
    if (i.deleted) return { id: i.id, deleted: { state: 'deleted' }, parentReference: { driveId: DRIVE } };
    return {
      id: i.id,
      name: i.name,
      parentReference: { driveId: DRIVE, ...(i.parentId ? { id: i.parentId } : {}) },
      ...(i.kind === 'root'
        ? { root: {}, folder: {} }
        : i.kind === 'folder'
          ? { folder: { childCount: 0 } }
          : { file: { mimeType: i.mimeType, hashes: { quickXorHash: quickXorHash(i.content) } } }),
      ...(this.sizeless.has(i.id) ? {} : { size: i.content.byteLength }),
      eTag: `"{${i.id}},${i.version}"`,
      cTag: `"c:{${i.id}},${i.contentVersion}"`,
      lastModifiedDateTime: this.now.toISOString(),
      createdDateTime: i.createdAt,
      createdBy: i.createdByApp ? { application: { id: i.createdByApp } } : { user: { displayName: 'A person' } },
      webUrl: `https://acme.sharepoint.com/sites/Team/Shared%20Documents/${i.id}`,
    };
  }

  private live() {
    return [...this.items.values()].filter((i) => !i.deleted);
  }
  private must(id: string): Item {
    const it = this.items.get(id);
    if (!it || it.deleted) throw new Status(404, 'itemNotFound', 'not found');
    return it;
  }
  private find(parentId: string, segments: string[]): Item | undefined {
    let at: Item | undefined = this.must(parentId);
    for (const name of segments) {
      at = this.live().find((i) => i.parentId === at!.id && i.name === name);
      if (!at) return undefined;
    }
    return at;
  }
  private resolve(parentId: string, segments: string[]): Item {
    const it = this.find(parentId, segments);
    if (!it) throw new Status(404, 'itemNotFound', 'not found');
    return it;
  }
  private isUnder(id: string, ancestor: string): boolean {
    let at = this.items.get(id)?.parentId ?? null;
    while (at) {
      if (at === ancestor) return true;
      at = this.items.get(at)?.parentId ?? null;
    }
    return false;
  }
}

class Status extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

const decodeSegments = (raw: string) => raw.split('/').map(decodeURIComponent);

function respond(status: number, body: unknown) {
  const bytes = body instanceof Uint8Array ? body : new TextEncoder().encode(JSON.stringify(body));
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: () => null },
    json: async () => JSON.parse(new TextDecoder().decode(bytes)),
    text: async () => new TextDecoder().decode(bytes),
    arrayBuffer: async () => bytes.slice().buffer,
  };
}
