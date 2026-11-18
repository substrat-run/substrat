import { WorkerEntrypoint } from 'cloudflare:workers';
import { handleConnectorScriptCall, type Env as RouterEnv } from '../../router/src/worker.js';

/**
 * The router's `ConnectorCalls` entrypoint for the connector-script suite
 * (`test/connector-script.test.ts`), with the dispatch namespace stood in for by one service binding.
 *
 * `callScript` is the production function, `handleConnectorScriptCall`: it parses the target and
 * the call, refuses what does not cohere, builds the outbound policy and dispatches. The pool's
 * local runtime hosts no dispatch namespace, so `get` here reports the script name and the policy
 * it was handed to the suite's harness (`HARNESS`), answers `Worker not found` while the harness
 * says the script is not deployed, and otherwise fetches the script the suite bound (`SCRIPT`).
 *
 * `call`, the vertical-defined half, answers 501 exactly as the stub this replaced did: no other
 * suite in this package reaches it.
 */
interface StandInEnv {
  SCRIPT: Fetcher;
  HARNESS: Fetcher;
}

export class ConnectorCalls extends WorkerEntrypoint<StandInEnv> {
  call(): { status: number; body: unknown } {
    return { status: 501, body: { error: 'connector calls not available in tests' } };
  }

  callScript(target: unknown, request: unknown) {
    const { SCRIPT, HARNESS } = this.env;
    const dispatch = {
      get: (name: string, _args: unknown, options?: { outbound?: Record<string, unknown> }) => ({
        fetch: async (req: Request) => {
          const deployed = await HARNESS.fetch('https://harness/dispatch', {
            method: 'POST',
            body: JSON.stringify({ name, outbound: options?.outbound ?? null }),
          });
          if ((await deployed.text()) !== 'deployed') throw new Error('Worker not found.');
          return SCRIPT.fetch(req);
        },
      }),
    };
    return handleConnectorScriptCall({ DISPATCH: dispatch } as unknown as RouterEnv, target, request);
  }
}

export default { fetch: () => new Response('the router stand-in serves RPC only', { status: 404 }) };
