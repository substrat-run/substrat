import { env } from 'cloudflare:test';

/** The directory, typed for the one call that rejects: a dump whose table name is no identifier. */
export const directory = () =>
  env.CONTROL_PLANE.get(env.CONTROL_PLANE.idFromName('control-plane')) as unknown as {
    importDump(tables: unknown): Promise<void>;
  };
export const BAD_DUMP = [{ name: 42 }];
export const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
