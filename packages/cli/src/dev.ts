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
    // A missing/broken CLI preload must not stop the project's own dev script. The tiny
    // data-URL module catches its dynamic import error before Node loads the script.
    const preload = new URL('./dev-preload.js', import.meta.url).href;
    const source = `try{await import(${JSON.stringify(preload)})}catch(error){process.stderr.write('warning: local request traces unavailable: '+String(error)+'\\n')}`;
    const option = `--import=data:text/javascript,${encodeURIComponent(source)}`;
    env.NODE_OPTIONS = env.NODE_OPTIONS ? `${env.NODE_OPTIONS} ${option}` : option;
    env.SUBSTRAT_DEV_TRACE_DIR = project;
  }

  const child = spawn('pnpm', ['run', 'dev'], { cwd: project, env, stdio: 'inherit' });
  const forward = (signal: NodeJS.Signals) => child.kill(signal);
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
