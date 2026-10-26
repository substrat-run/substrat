import { createInterface } from 'node:readline';

export interface PromptIo {
  input: NodeJS.ReadableStream;
  output: NodeJS.WritableStream;
  terminal: boolean;
  /** What Ctrl+C does. Default: stop the command, exit code 130, as an interrupted shell command does. */
  onInterrupt: () => void;
}

const processIo = (): PromptIo => ({
  input: process.stdin,
  output: process.stdout,
  terminal: Boolean(process.stdin.isTTY),
  onInterrupt: () => {
    process.stdout.write('\n');
    process.exit(130);
  },
});

/**
 * Prompt for a plain (non-secret) value; `undefined` when stdin ends before an answer.
 *
 * readline closes on EOF WITHOUT calling the question callback, so a promise that only
 * settles there never settles: the event loop drains and Node exits 0 in the middle of the
 * command (a `substrat login` from an agent or piped stdin "succeeded" and saved nothing).
 * Settling on 'close' makes the end of input an answer every caller must handle.
 *
 * Ctrl+C is not an end of input. On a terminal, readline with no 'SIGINT' listener closes the
 * interface, which would read as "no answer" and let the command carry on: a push asked whether
 * to pin its workspace would go on to upload. So Ctrl+C stops the command instead.
 */
export function ask(question: string, io: Partial<PromptIo> = {}): Promise<string | undefined> {
  const { input, output, terminal, onInterrupt } = { ...processIo(), ...io };
  const rl = createInterface({ input, output, terminal });
  return new Promise((resolve) => {
    rl.on('SIGINT', () => {
      rl.removeAllListeners('close');
      rl.close();
      onInterrupt();
    });
    rl.question(question, (answer) => {
      resolve(answer.trim()); // before close(), whose listener would otherwise settle first
      rl.close();
    });
    rl.on('close', () => resolve(undefined));
  });
}
