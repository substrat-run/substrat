/**
 * The test harness: one control plane, N shards, M routers, as real processes on localhost.
 *
 * Plays the scheduler's part too: `restart(name)` brings a shard back under the same name,
 * port and volume, which is what a StatefulSet does for a pod it lost.
 *
 * Every spawned process is tracked, and `stop()` SIGKILLs whatever is still alive (a
 * stopped one is continued first, so the kill is delivered) and then checks that nothing
 * survived — a leftover process on a shared machine is a failure of the run, not noise.
 */
import { fork, type ChildProcess } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as sleep } from 'node:timers/promises';
import { statefulSetMembers } from '../src/placement.js';

const SRC = fileURLToPath(new URL('../src/', import.meta.url));
const SPIKE = fileURLToPath(new URL('../', import.meta.url));

export interface ClusterOptions {
  shards: number;
  routers?: number;
  /** `off` runs the control: placement and routing with no lease (`control-plane.ts`). */
  leases?: 'on' | 'off';
  leaseTtlMs?: number;
  leaseMarginMs?: number;
  requestTimeoutMs?: number;
}

export interface FaultReport {
  at: string;
  text: string;
  node: string;
}

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.unref();
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const addr = srv.address();
      const port = typeof addr === 'object' && addr ? addr.port : 0;
      srv.close(() => resolve(port));
    });
  });
}

interface Proc {
  name: string;
  child: ChildProcess;
  env: Record<string, string>;
  file: string;
  port: number;
  log: string[];
  faults: FaultReport[];
}

export class Cluster {
  readonly dir = mkdtempSync(join(tmpdir(), 'k3s-sharding-'));
  readonly members: string[];
  private readonly procs = new Map<string, Proc>();
  private readonly everSpawned: ChildProcess[] = [];
  private cpUrl = '';

  constructor(readonly opts: ClusterOptions) {
    this.members = statefulSetMembers('todo', opts.shards);
  }

  private async spawn(name: string, file: string, env: Record<string, string>, port: number): Promise<Proc> {
    const log: string[] = [];
    const child = fork(join(SRC, file), [], {
      cwd: SPIKE,
      execArgv: ['--import', 'tsx'],
      env: { ...process.env, ...env, PORT: String(port), SPIKE_MAX_LIFE_MS: '240000' },
      stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    });
    this.everSpawned.push(child);
    child.stdout?.on('data', (d: Buffer) => log.push(d.toString()));
    child.stderr?.on('data', (d: Buffer) => log.push(d.toString()));
    const proc: Proc = { name, child, env, file, port, log, faults: [] };
    child.on('message', (m: Partial<FaultReport>) => {
      if (m.at) proc.faults.push(m as FaultReport);
    });
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`${name} did not start: ${log.join('')}`)), 30_000);
      child.on('message', (m: { ready?: string }) => {
        if (m.ready) {
          clearTimeout(timer);
          resolve();
        }
      });
      child.on('exit', (code, signal) => {
        clearTimeout(timer);
        reject(new Error(`${name} exited during start (${code ?? signal}): ${log.join('')}`));
      });
    });
    this.procs.set(name, proc);
    return proc;
  }

  async start(): Promise<this> {
    const cpPort = await freePort();
    this.cpUrl = `http://127.0.0.1:${cpPort}`;
    await this.spawn(
      'control-plane',
      'control-plane.ts',
      {
        CP_DIR: join(this.dir, 'control-plane'),
        LEASE_TTL_MS: String(this.opts.leaseTtlMs ?? 2000),
        LEASES: this.opts.leases ?? 'on',
      },
      cpPort,
    );
    const urls: Record<string, string> = {};
    await Promise.all(
      this.members.map(async (name) => {
        const port = await freePort();
        urls[name] = `http://127.0.0.1:${port}`;
        await this.spawn(
          name,
          'shard.ts',
          {
            NODE: name,
            CP_URL: this.cpUrl,
            VOLUME: join(this.dir, 'volumes'),
            LEASE_MARGIN_MS: String(this.opts.leaseMarginMs ?? 400),
            LEASES: this.opts.leases ?? 'on',
          },
          port,
        );
      }),
    );
    for (let i = 0; i < (this.opts.routers ?? 1); i++) {
      const name = `router-${i}`;
      await this.spawn(
        name,
        'router.ts',
        {
          ROUTER_NAME: name,
          MEMBERS: JSON.stringify(urls),
          REQUEST_TIMEOUT_MS: String(this.opts.requestTimeoutMs ?? 1500),
        },
        await freePort(),
      );
    }
    return this;
  }

  get controlPlane(): string {
    return this.cpUrl;
  }

  url(name: string): string {
    return `http://127.0.0.1:${this.proc(name).port}`;
  }

  private proc(name: string): Proc {
    const p = this.procs.get(name);
    if (!p) throw new Error(`no process ${name}`);
    return p;
  }

  log(name: string): string {
    return this.proc(name).log.join('');
  }

  /** Arm a fault: when the write with `text` reaches `point` on `name`, it signals itself. */
  arm(name: string, fault: { text: string; point: 'pre-write' | 'post-commit'; signal: NodeJS.Signals }): void {
    this.proc(name).child.send({ arm: fault });
  }

  /** Resolves once `name` reported reaching a fault point for `text`. */
  async reached(name: string, text: string, timeoutMs = 20_000): Promise<FaultReport> {
    const until = Date.now() + timeoutMs;
    while (Date.now() < until) {
      const hit = this.proc(name).faults.find((f) => f.text === text);
      if (hit) return hit;
      await sleep(10);
    }
    throw new Error(`${name} never reached the fault for ${text}: ${this.log(name)}`);
  }

  signal(name: string, sig: NodeJS.Signals): void {
    this.proc(name).child.kill(sig);
  }

  async exited(name: string, timeoutMs = 10_000): Promise<void> {
    const { child } = this.proc(name);
    if (child.exitCode !== null || child.signalCode !== null) return;
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`${name} did not exit`)), timeoutMs);
      child.once('exit', () => {
        clearTimeout(timer);
        resolve();
      });
    });
  }

  /** The StatefulSet's part: the same name, port and volume, a new process. */
  async restart(name: string): Promise<void> {
    const p = this.proc(name);
    await this.exited(name);
    this.procs.delete(name);
    await this.spawn(name, p.file, p.env, p.port);
  }

  async write(router: string, scope: string, text: string): Promise<{ status: number; json: Record<string, unknown> }> {
    const res = await fetch(`${this.url(router)}/scopes/${scope}/items`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'idempotency-key': `w:${text}` },
      body: JSON.stringify({ text }),
      signal: AbortSignal.timeout(30_000),
    });
    return { status: res.status, json: (await res.json()) as Record<string, unknown> };
  }

  async read(router: string, scope: string): Promise<{ texts: string[]; node: string; epoch: number }> {
    const res = await fetch(`${this.url(router)}/scopes/${scope}/items`, { signal: AbortSignal.timeout(30_000) });
    const json = (await res.json()) as { entries: Array<{ text: string }>; node: string; epoch: number };
    if (res.status !== 200) throw new Error(`read ${res.status}: ${JSON.stringify(json)}`);
    return { texts: json.entries.map((e) => e.text), node: json.node, epoch: json.epoch };
  }

  async lease(scope: string): Promise<{ holder: string; epoch: number; expires_at: number; now: number; data_on: string | null }> {
    const res = await fetch(`${this.cpUrl}/lease/${scope}`);
    return (await res.json()) as never;
  }

  async stop(): Promise<void> {
    for (const child of this.everSpawned) {
      if (child.exitCode === null && child.signalCode === null) {
        child.kill('SIGCONT');
        child.kill('SIGKILL');
      }
    }
    await Promise.all(
      this.everSpawned.map(
        (child) =>
          new Promise<void>((resolve) => {
            if (child.exitCode !== null || child.signalCode !== null) return resolve();
            child.once('exit', () => resolve());
          }),
      ),
    );
    const alive = this.everSpawned.filter((c) => c.pid !== undefined && isAlive(c.pid));
    rmSync(this.dir, { recursive: true, force: true });
    if (alive.length > 0) throw new Error(`processes survived the cluster: ${alive.map((c) => c.pid).join(', ')}`);
  }
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
