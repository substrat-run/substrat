import { DurableObject } from 'cloudflare:workers';
import { sqlCubeStore, type CubeStore, type StoredBlock } from '@substrat-run/control-plane-api';

/**
 * Where the control plane keeps closed blocks of log counts (#1877) — the store behind the
 * cube cache, one object per deployed script.
 *
 * Per script rather than one for the platform, because a script is what a block is counted
 * over: every tenant of a vertical reads the same blocks, so they share an object, and a
 * busy vertical does not queue behind every other one. The logic is `sqlCubeStore`, tested
 * on SQLite in `control-plane-api`; this class only gives it this object's SQL.
 */
export class ObservabilityCacheDO extends DurableObject {
  #store = sqlCubeStore(this.ctx.storage.sql);

  async get(keys: string[]): Promise<Array<[string, StoredBlock<unknown>]>> {
    return [...(await this.#store.get(keys))];
  }

  async put(key: string, block: StoredBlock<unknown>, blockStart: number): Promise<void> {
    await this.#store.put(key, block, blockStart);
  }
}

/** The script a block key names — the key reads `kind|service|grain|start`. */
const serviceOf = (key: string): string => key.split('|')[1] ?? '';

/**
 * The cube store over those objects: each key goes to its script's object, and a read of
 * blocks from several scripts asks each object once.
 */
export function durableCubeStore(ns: DurableObjectNamespace<ObservabilityCacheDO>): CubeStore {
  const stubOf = (service: string) => ns.get(ns.idFromName(service));
  return {
    async get(keys) {
      const byService = new Map<string, string[]>();
      for (const k of keys) byService.set(serviceOf(k), [...(byService.get(serviceOf(k)) ?? []), k]);
      const answers = await Promise.all([...byService].map(([service, ks]) => stubOf(service).get(ks)));
      return new Map(answers.flat());
    },
    async put(key, block, blockStart) {
      await stubOf(serviceOf(key)).put(key, block, blockStart);
    },
  };
}
