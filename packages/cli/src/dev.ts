/** Transparent local dev-script wrapper with an optional request-trace preload. */
import { spawn } from 'node:child_process';
import { constants } from 'node:os';
import { resolve } from 'node:path';

export interface DevOptions {
  dir?: string;
  trace?: boolean;
}

export async function dev(options: DevOptions = {}): Promise<number> {
  const project = resolve(options.dir ?? '.');
  const env = { ...process.env };
  if (options.trace !== false) {
    delete env.SUBSTRAT_DEV_TRACE_WARNED;
    // A missing/broken CLI preload must not stop the project's own dev script. The tiny
    // data-URL module catches its dynamic import error before Node loads the script.
    const preload = new URL('./dev-preload.js', import.meta.url).href;
    const source = `try{await import(${JSON.stringify(preload)})}catch(error){if(!process.env.SUBSTRAT_DEV_TRACE_WARNED){process.env.SUBSTRAT_DEV_TRACE_WARNED='1';process.stderr.write('warning: local request traces unavailable: '+String(error)+'\\n')}}`;
    const option = `--import=data:text/javascript;base64,${Buffer.from(source).toString('base64')}`;
    env.NODE_OPTIONS = env.NODE_OPTIONS ? `${env.NODE_OPTIONS} ${option}` : option;
    env.SUBSTRAT_DEV_TRACE_DIR = project;
  }

  // Give the script and its subprocesses one group. A dev script commonly runs through
  // pnpm -> concurrently -> tsx watch; signaling pnpm alone leaves the watcher alive.
  const grouped = process.platform !== 'win32';
  const child = spawn('pnpm', ['run', 'dev'], { cwd: project, env, stdio: 'inherit', detached: grouped, shell: process.platform === 'win32' });
  const forward = (signal: NodeJS.Signals) => {
    try {
      if (grouped && child.pid) process.kill(-child.pid, signal);
      else child.kill(signal);
    } catch {
      /* the dev script already exited */
    }
  };
  const onInt = () => forward('SIGINT');
  const onTerm = () => forward('SIGTERM');
  process.on('SIGINT', onInt);
  process.on('SIGTERM', onTerm);
  try {
    return await new Promise<number>((done) => {
      child.once('error', (error) => {
        process.stderr.write(`error: could not run dev script: ${error.message}\n`);
        done(127);
      });
      child.once('exit', (code, signal) => {
        done(code ?? (signal ? 128 + (constants.signals[signal] ?? 1) : 1));
      });
    });
  } finally {
    process.off('SIGINT', onInt);
    process.off('SIGTERM', onTerm);
  }
}
