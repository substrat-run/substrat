/**
 * #2213: the runner suite is only worth running if a broken runner fails it. The
 * trivial driver passes every check, and each twin below breaks one rule and must fail
 * the check that names it — while still passing the rest, so the failure is that
 * rule's and not a side effect.
 */
import { describe, expect, it } from 'vitest';
import type { StoreRequest, StoreResponse } from '@substrat-run/contracts';
import type { ScopeStoreAddress, ScopeStoreRunner } from '@substrat-run/kernel';
import { counterScopeStoreRunner } from '../src/counter-runner.js';
import {
  scopeStoreRunnerChecks,
  scopeStoreRunnerContractSuite,
  type ScopeStoreRunnerFixture,
} from '../src/scope-store-runner-suite.js';

const counterFixture = (makeRunner: () => ScopeStoreRunner): ScopeStoreRunnerFixture => ({
  makeRunner,
  write: { operation: 'increment', input: { by: 1 } },
  writeRow: (n) => ({ operation: 'increment', input: { by: 1, subjectId: `subject-${n}` } }),
  writeSubject: (subjectId) => ({ operation: 'increment', input: { by: 1, subjectId } }),
  // Two rows of one subject: staged, they pass, and the commit refuses them.
  refusedStage: [{ name: 'counter', ddl: 'CREATE TABLE counter (subject TEXT, n INTEGER NOT NULL)', columns: ['subject', 'n'], rows: [['a', 1], ['a', 2]] }],
  read: { operation: 'read' },
});

scopeStoreRunnerContractSuite('counter', counterFixture(counterScopeStoreRunner));

/** The counter, with one operation answered differently. */
function overriding(
  override: (
    address: ScopeStoreAddress,
    request: StoreRequest,
    inner: ScopeStoreRunner,
  ) => Promise<StoreResponse> | undefined,
): () => ScopeStoreRunner {
  return () => {
    const inner = counterScopeStoreRunner();
    return {
      ...inner,
      invoke: (address, request) => override(address, request, inner) ?? inner.invoke(address, request),
    };
  };
}

const CHECK = {
  stop: 'a stop without a start resolves',
  envelope: 'a driver call answers the envelope, and an unknown operation answers its error',
  readBack: 'a write is read back on its own address',
  address: 'the object is keyed on the whole address: tenant, vertical, scope and binding',
  restart: 'a stop and a start serve the same repositories',
  size: 'substrat.size answers { bytes }',
  exportPage: 'substrat.export-page answers a chain that ends, one revision, and the same dump at any page size',
  pages: 'substrat.export-page cuts many rows into pages within maxBytes, and loses none between them',
  oneMoment: 'a chain is one moment: a wipe between two of its pages cannot tear it',
  commit: 'substrat.commit-stage replaces the whole object and answers the distinct tables it wrote',
  fragments: 'a stage spread over several pages commits whole, not only its first page',
  staged: 'a page already staged answers staged: false, and a gap is refused',
  newStage: 'page 0 of a new stage drops the old one, which then cannot stage or commit; discarding another id leaves the held stage',
  discard: 'substrat.discard-stage drops a stage, which then cannot commit, and leaves the object',
  revision: 'a commit and a wipe move the revision, and a read does not',
  stagedSize: 'substrat.size counts what is staged',
  dropped: 'a wipe and an erase drop every stage: its commit is refused, and nothing comes back',
  repeat: 'a commit asked again answers the same count and changes nothing; a stage never held is refused',
  atomic: 'a stage the driver refuses leaves the object as it was',
  erasedRevision: 'an erase that erased something moves the revision',
  wipe: 'substrat.wipe answers {} and leaves an empty object, also where nothing was written',
  erase: 'substrat.erase answers { erased }, and a repeat erases nothing more',
} as const;

/** The counter, blind to one field of the address: two addresses that differ only there share an object. */
const blindTo = (field: keyof ScopeStoreAddress) =>
  overriding((address, request, inner) => inner.invoke({ ...address, [field]: 'shared' }, request));

const answering = (operation: string, answer: StoreResponse) =>
  overriding((_address, request) => (request.operation === operation ? Promise.resolve(answer) : undefined));

/** Each twin breaks one rule, and names every check that rule reaches. */
const TWINS: { name: string; breaks: readonly string[]; makeRunner: () => ScopeStoreRunner }[] = [
  {
    name: 'a stop that needs a start',
    breaks: [CHECK.stop],
    makeRunner: () => {
      const inner = counterScopeStoreRunner();
      let started = false;
      return {
        ...inner,
        async start() {
          started = true;
        },
        async stop() {
          if (!started) throw new Error('stopped before it started');
        },
      };
    },
  },
  {
    // Nothing to read back, nothing for a commit to tell apart from its source, and no revision to move.
    name: 'a write that changes nothing',
    breaks: [CHECK.readBack, CHECK.exportPage, CHECK.pages, CHECK.commit, CHECK.revision, CHECK.stagedSize, CHECK.erasedRevision],
    makeRunner: answering('increment', { result: 0 }),
  },
  ...(['tenantId', 'vertical', 'scopeId', 'binding'] as const).map((field) => ({
    name: `an object keyed without the ${field}`,
    breaks: [CHECK.address],
    makeRunner: blindTo(field),
  })),
  {
    name: 'objects that live in the process it starts',
    breaks: [CHECK.restart],
    makeRunner: () => {
      let inner = counterScopeStoreRunner();
      return {
        driver: 'counter',
        async start() {},
        async stop() {
          inner = counterScopeStoreRunner();
        },
        invoke: (address, request) => inner.invoke(address, request),
      };
    },
  },
  {
    name: 'an unknown operation thrown, not answered',
    breaks: [CHECK.envelope],
    makeRunner: overriding((_address, request) => {
      if (request.operation === 'conformance-unknown-operation') throw new Error('unknown operation');
      return undefined;
    }),
  },
  {
    name: 'an unknown operation answered as a result',
    breaks: [CHECK.envelope],
    makeRunner: answering('conformance-unknown-operation', { result: null }),
  },
  {
    name: 'a size that is not { bytes }',
    breaks: [CHECK.size, CHECK.stagedSize],
    makeRunner: answering('substrat.size', { result: { size: 1 } }),
  },
  {
    // An empty dump also leaves nothing for a commit to restore, and a staged dump of itself empties the object.
    name: 'an export with no tables',
    breaks: [CHECK.exportPage, CHECK.pages, CHECK.commit, CHECK.fragments, CHECK.staged, CHECK.newStage, CHECK.revision, CHECK.stagedSize, CHECK.erasedRevision],
    makeRunner: answering('substrat.export-page', { result: { tables: [], next: null, revision: '1' } }),
  },
  {
    name: 'a revision that does not change on a write',
    breaks: [CHECK.exportPage, CHECK.oneMoment, CHECK.revision, CHECK.erasedRevision],
    makeRunner: overriding((address, request, inner) => {
      if (request.operation !== 'substrat.export-page') return undefined;
      return inner.invoke(address, request).then((response) =>
        'result' in response ? { result: { ...(response.result as object), revision: '0' } } : response,
      );
    }),
  },
  {
    // The commit runs, then the object's earlier content is added back: a merge of old and new.
    name: 'a commit that merges instead of replacing',
    breaks: [CHECK.commit, CHECK.fragments, CHECK.staged, CHECK.newStage, CHECK.repeat],
    makeRunner: overriding((address, request, inner) => {
      if (request.operation !== 'substrat.commit-stage') return undefined;
      return (async () => {
        const earlier = (await inner.invoke(address, { operation: 'read' })) as { result: number };
        const committed = await inner.invoke(address, request);
        if ('error' in committed) return committed;
        await inner.invoke(address, { operation: 'increment', input: { by: earlier.result } });
        return committed;
      })();
    }),
  },
  {
    name: 'a commit that miscounts the tables it wrote',
    breaks: [CHECK.commit, CHECK.fragments],
    makeRunner: overriding((address, request, inner) => {
      if (request.operation !== 'substrat.commit-stage') return undefined;
      return (async () => {
        const committed = await inner.invoke(address, request);
        return 'error' in committed ? committed : { result: { tables: 0 } };
      })();
    }),
  },
  {
    // The page is added to the object as it is staged, so a stage is seen before its commit.
    name: 'a stage that changes the object before the commit',
    breaks: [CHECK.commit, CHECK.discard, CHECK.revision, CHECK.dropped, CHECK.atomic],
    makeRunner: overriding((address, request, inner) => {
      if (request.operation !== 'substrat.stage-page') return undefined;
      return (async () => {
        await inner.invoke(address, { operation: 'increment', input: { by: 1 } });
        return inner.invoke(address, request);
      })();
    }),
  },
  {
    // A page sent again is staged a second time, at the next seq, and answered as new.
    name: 'a re-sent page that is held twice',
    breaks: [CHECK.staged],
    makeRunner: () => {
      const inner = counterScopeStoreRunner();
      const held = new Map<string, number>();
      return {
        ...inner,
        invoke(address, request) {
          const input = request.input as { stageId: string; seq: number } | undefined;
          if (request.operation !== 'substrat.stage-page' || !input) return inner.invoke(address, request);
          const key = JSON.stringify([address, input.stageId]);
          const count = held.get(key) ?? 0;
          if (input.seq !== 0 || count === 0) {
            held.set(key, input.seq === 0 ? 1 : count + 1);
            return inner.invoke(address, request);
          }
          held.set(key, count + 1);
          return inner.invoke(address, { ...request, input: { ...input, seq: count } });
        },
      };
    },
  },
  {
    name: 'a discard that says it dropped a stage and keeps it',
    breaks: [CHECK.newStage, CHECK.discard],
    makeRunner: answering('substrat.discard-stage', { result: { discarded: true } }),
  },
  {
    // Pages after the first are acknowledged and let go, so a commit keeps what page 0 held.
    name: 'a commit that keeps only the first page of a stage',
    breaks: [CHECK.fragments],
    makeRunner: () => {
      const inner = counterScopeStoreRunner();
      const held = new Map<string, number>();
      const current = new Map<string, string>();
      return {
        ...inner,
        invoke(address, request) {
          if (request.operation !== 'substrat.stage-page') return inner.invoke(address, request);
          const input = request.input as { stageId: string; seq: number };
          const key = JSON.stringify([address, input.stageId]);
          if (input.seq === 0) {
            if (!held.has(key)) held.set(key, 1);
            current.set(JSON.stringify(address), input.stageId);
            return inner.invoke(address, request);
          }
          // Only the stage the object holds has its pages let go; a dropped one is still refused.
          if (input.seq === held.get(key) && current.get(JSON.stringify(address)) === input.stageId) {
            held.set(key, input.seq + 1);
            return Promise.resolve({ result: { staged: true } });
          }
          return inner.invoke(address, request);
        },
      };
    },
  },
  {
    name: 'a cursor that skips a row',
    breaks: [CHECK.pages],
    makeRunner: overriding((address, request, inner) => {
      if (request.operation !== 'substrat.export-page') return undefined;
      return inner.invoke(address, request).then((response) => {
        if (!('result' in response)) return response;
        const page = response.result as { next: string | null };
        return { result: { ...page, next: page.next === null ? null : String(Number(page.next) + 1) } };
      });
    }),
  },
  {
    name: 'a page size that is ignored',
    breaks: [CHECK.pages],
    makeRunner: overriding((address, request, inner) =>
      request.operation === 'substrat.export-page'
        ? inner.invoke(address, { ...request, input: { ...(request.input as object), maxBytes: 1024 * 1024 } })
        : undefined,
    ),
  },
  {
    // Every stage is called the same, so a new one never replaces another, and another id is any id.
    name: 'a stage id that is ignored',
    breaks: [CHECK.newStage, CHECK.repeat],
    makeRunner: overriding((address, request, inner) =>
      /^substrat\.(stage-page|commit-stage|discard-stage)$/.test(request.operation)
        ? inner.invoke(address, { ...request, input: { ...(request.input as object), stageId: 'one-stage' } })
        : undefined,
    ),
  },
  ...(
    [
      ['a revision that a commit does not move', ['increment', 'substrat.wipe', 'substrat.erase'], [CHECK.revision]],
      ['a revision that a wipe does not move', ['increment', 'substrat.commit-stage', 'substrat.erase'], [CHECK.revision, CHECK.oneMoment]],
      ['a revision that an erase does not move', ['increment', 'substrat.commit-stage', 'substrat.wipe'], [CHECK.erasedRevision]],
    ] as const
  ).map(([name, moves, breaks]) => ({
    name,
    breaks: breaks as readonly string[],
    makeRunner: () => {
      const inner = counterScopeStoreRunner();
      const writes = new Map<string, number>();
      const committed = new Set<string>();
      return {
        ...inner,
        async invoke(address: ScopeStoreAddress, request: StoreRequest) {
          const key = JSON.stringify(address);
          const response = await inner.invoke(address, request);
          // A commit asked again changes nothing, so it moves nothing.
          const again = request.operation === 'substrat.commit-stage' && committed.has(JSON.stringify(request.input));
          if (request.operation === 'substrat.commit-stage') committed.add(JSON.stringify(request.input));
          if (moves.includes(request.operation as never) && 'result' in response && !again) writes.set(key, (writes.get(key) ?? 0) + 1);
          if (request.operation !== 'substrat.export-page' || !('result' in response)) return response;
          return { result: { ...(response.result as object), revision: String(writes.get(key) ?? 0) } };
        },
      };
    },
  })),
  ...(
    [
      ['a stage that survives a wipe', 'substrat.wipe'],
      ['a stage that survives an erase', 'substrat.erase'],
    ] as const
  ).map(([name, survives]) => ({
    name,
    breaks: [CHECK.dropped] as readonly string[],
    makeRunner: () => {
      const inner = counterScopeStoreRunner();
      const staged = new Map<string, StoreRequest[]>();
      return {
        ...inner,
        async invoke(address: ScopeStoreAddress, request: StoreRequest) {
          const key = JSON.stringify(address);
          const response = await inner.invoke(address, request);
          if (request.operation === 'substrat.stage-page' && 'result' in response) {
            const first = (request.input as { seq: number }).seq === 0;
            staged.set(key, [...(first ? [] : (staged.get(key) ?? [])), request]);
          } else if (request.operation === 'substrat.commit-stage' || request.operation === 'substrat.discard-stage') {
            staged.delete(key);
          } else if (request.operation === survives) {
            // The stage is put back as it was: what the operation dropped, the twin keeps.
            for (const again of staged.get(key) ?? []) await inner.invoke(address, again);
          }
          return response;
        },
      };
    },
  })),
  {
    name: 'a commit asked again that is refused',
    breaks: [CHECK.repeat],
    makeRunner: () => {
      const inner = counterScopeStoreRunner();
      const done = new Set<string>();
      return {
        ...inner,
        invoke(address, request) {
          if (request.operation !== 'substrat.commit-stage') return inner.invoke(address, request);
          const key = JSON.stringify([address, (request.input as { stageId: string }).stageId]);
          if (done.has(key)) return Promise.resolve({ error: { code: 'validation_failed', status: 400 } });
          done.add(key);
          return inner.invoke(address, request);
        },
      };
    },
  },
  {
    // One count for every fragment of every page, not for every distinct table.
    name: 'a commit that counts fragments, not distinct tables',
    breaks: [CHECK.fragments],
    makeRunner: () => {
      const inner = counterScopeStoreRunner();
      const pages = new Map<string, number>();
      return {
        ...inner,
        async invoke(address, request) {
          const response = await inner.invoke(address, request);
          if (!('result' in response)) return response;
          const input = request.input as { stageId?: string } | undefined;
          const key = JSON.stringify([address, input?.stageId]);
          if (request.operation === 'substrat.stage-page') pages.set(key, (pages.get(key) ?? 0) + 1);
          if (request.operation !== 'substrat.commit-stage') return response;
          return { result: { tables: (response.result as { tables: number }).tables * (pages.get(key) ?? 1) } };
        },
      };
    },
  },
  {
    name: 'a size that ignores what is staged',
    breaks: [CHECK.stagedSize],
    makeRunner: overriding((address, request, inner) => {
      if (request.operation !== 'substrat.size') return undefined;
      // The total of the object alone: the counter's own `read`.
      return inner.invoke(address, { operation: 'read' }).then((response) => ('result' in response ? { result: { bytes: response.result } } : response));
    }),
  },
  {
    // The cursor carries the revision it began with, so a write in between is not seen in it.
    name: 'a chain whose cursor echoes the revision it began with',
    breaks: [CHECK.oneMoment],
    makeRunner: () => {
      const inner = counterScopeStoreRunner();
      return {
        ...inner,
        async invoke(address: ScopeStoreAddress, request: StoreRequest) {
          if (request.operation !== 'substrat.export-page') return inner.invoke(address, request);
          const input = request.input as { cursor: string | null; maxBytes: number };
          const [began, position] = input.cursor === null ? [null, null] : input.cursor.split('|');
          const response = await inner.invoke(address, { ...request, input: { ...input, cursor: position } });
          if (!('result' in response)) return response;
          const page = response.result as { next: string | null; revision: string };
          const revision = began ?? page.revision;
          return { result: { ...page, revision, next: page.next === null ? null : `${revision}|${page.next}` } };
        },
      };
    },
  },
  {
    // A page sent again replaces the first: the commit holds the version that came last.
    name: 'a resent page that overwrites the first',
    breaks: [CHECK.staged],
    makeRunner: () => {
      const inner = counterScopeStoreRunner();
      return {
        ...inner,
        async invoke(address: ScopeStoreAddress, request: StoreRequest) {
          const input = request.input as { stageId: string; seq: number } | undefined;
          if (request.operation !== 'substrat.stage-page' || !input || input.seq !== 0) return inner.invoke(address, request);
          const first = await inner.invoke(address, request);
          if (!('result' in first) || (first.result as { staged: boolean }).staged) return first;
          // Held already: drop it and take this one in its place.
          await inner.invoke(address, { operation: 'substrat.discard-stage', input: { stageId: input.stageId } });
          await inner.invoke(address, request);
          return first;
        },
      };
    },
  },
  {
    // Every count it ever answered is kept for the stage id, so a wipe or a later commit ends nothing.
    name: 'a memory of every stage ever committed',
    breaks: [CHECK.repeat],
    makeRunner: () => {
      const inner = counterScopeStoreRunner();
      const counts = new Map<string, number>();
      return {
        ...inner,
        async invoke(address: ScopeStoreAddress, request: StoreRequest) {
          const response = await inner.invoke(address, request);
          if (request.operation !== 'substrat.commit-stage') return response;
          const key = JSON.stringify([address, (request.input as { stageId: string }).stageId]);
          if ('result' in response) counts.set(key, (response.result as { tables: number }).tables);
          else if (counts.has(key)) return { result: { tables: counts.get(key)! } };
          return response;
        },
      };
    },
  },
  {
    // The commit applies rows one by one: a row it then refuses leaves the rows before it behind.
    name: 'a commit that refuses a stage after it has changed the object',
    breaks: [CHECK.atomic],
    makeRunner: () => {
      const inner = counterScopeStoreRunner();
      return {
        ...inner,
        async invoke(address: ScopeStoreAddress, request: StoreRequest) {
          const response = await inner.invoke(address, request);
          // Only a refusal of the stage's content (400): a stage it does not hold (409) changes nothing.
          if (request.operation !== 'substrat.commit-stage' || !('error' in response) || response.error.status !== 400) return response;
          await inner.invoke(address, { operation: 'increment', input: { by: 1, subjectId: 'half-applied' } });
          return response;
        },
      };
    },
  },
  {
    // A stage id that was committed is taken as a new stage: the driver does not remember it was used.
    name: 'a stage id that is taken again after its commit',
    breaks: [CHECK.repeat],
    makeRunner: () => {
      const inner = counterScopeStoreRunner();
      const used = new Set<string>();
      return {
        ...inner,
        async invoke(address: ScopeStoreAddress, request: StoreRequest) {
          const stageId = (request.input as { stageId?: string } | undefined)?.stageId;
          const key = JSON.stringify([address, stageId]);
          if (request.operation === 'substrat.stage-page' && used.has(key)) return { result: { staged: true } };
          const response = await inner.invoke(address, request);
          if (request.operation === 'substrat.commit-stage' && 'result' in response) used.add(key);
          return response;
        },
      };
    },
  },
  {
    name: 'a wipe that keeps the data',
    breaks: [CHECK.revision, CHECK.dropped, CHECK.repeat, CHECK.wipe],
    makeRunner: answering('substrat.wipe', { result: {} }),
  },
  {
    name: 'a wipe that refuses an object nothing was written to',
    breaks: [CHECK.wipe],
    makeRunner: () => {
      const inner = counterScopeStoreRunner();
      const written = new Set<string>();
      return {
        ...inner,
        invoke(address, request) {
          const id = JSON.stringify(address);
          if (request.operation === 'substrat.wipe' && !written.has(id)) {
            return Promise.resolve({ error: { code: 'not_found', status: 404 } });
          }
          if (request.operation === 'increment' || request.operation === 'substrat.commit-stage') written.add(id);
          return inner.invoke(address, request);
        },
      };
    },
  },
  {
    name: 'an erase that counts again on a repeat',
    breaks: [CHECK.dropped, CHECK.erasedRevision, CHECK.erase],
    makeRunner: answering('substrat.erase', { result: { erased: 1 } }),
  },
];

describe('scope-store runner suite: each broken twin fails the rules it breaks (#2213)', () => {
  it('the suite has exactly the checks named here', () => {
    const names = scopeStoreRunnerChecks(counterFixture(counterScopeStoreRunner)).map((check) => check.name);
    expect(names).toEqual(Object.values(CHECK));
  });

  it('every check is broken by some twin', () => {
    const broken = new Set(TWINS.flatMap((twin) => twin.breaks));
    expect(Object.values(CHECK).filter((name) => !broken.has(name))).toEqual([]);
  });

  for (const twin of TWINS) {
    it(`fails ${twin.breaks.length === 1 ? 'one check' : 'its checks'}: ${twin.name}`, async () => {
      // Exactly the checks it breaks fail: the rest pass, so the failure is that rule's and not a side effect.
      const failed: string[] = [];
      for (const check of scopeStoreRunnerChecks(counterFixture(twin.makeRunner))) {
        await check.run().catch(() => failed.push(check.name));
      }
      expect(failed).toEqual(Object.values(CHECK).filter((name) => twin.breaks.includes(name)));
    });
  }
});

describe('drivers that are right in other ways pass every check', () => {
  /** A revision that is a hash of the content: the same state reads the same revision, and a commit of identical content moves nothing. */
  const hashRevision = (): ScopeStoreRunner => {
    const inner = counterScopeStoreRunner();
    return {
      ...inner,
      async invoke(address, request) {
        const response = await inner.invoke(address, request);
        if (request.operation !== 'substrat.export-page' || !('result' in response)) return response;
        const whole = await inner.invoke(address, { operation: 'substrat.export-page', input: { cursor: null, maxBytes: 1e9 } });
        const text = JSON.stringify((whole as { result: { tables: unknown } }).result.tables);
        let hash = 7;
        for (const ch of text) hash = (hash * 31 + ch.charCodeAt(0)) | 0;
        return { result: { ...(response.result as object), revision: `h${hash}` } };
      },
    };
  };

  /** A driver that refuses writes while a chain of its dump is open, as one that pins by locking does. */
  const lockingDuringChain = (): ScopeStoreRunner => {
    const inner = counterScopeStoreRunner();
    const open = new Set<string>();
    return {
      ...inner,
      async invoke(address, request) {
        const key = JSON.stringify(address);
        const writes = ['increment', 'substrat.wipe', 'substrat.erase', 'substrat.commit-stage'];
        if (open.has(key) && writes.includes(request.operation)) return { error: { code: 'conflict', status: 409 } };
        const response = await inner.invoke(address, request);
        if (request.operation === 'substrat.export-page' && 'result' in response) {
          if ((response.result as { next: string | null }).next === null) open.delete(key);
          else open.add(key);
        }
        return response;
      },
    };
  };

  for (const [name, makeRunner] of [
    ['a content-hash revision', hashRevision],
    ['one that refuses writes while a chain is open', lockingDuringChain],
  ] as const) {
    it(name, async () => {
      for (const check of scopeStoreRunnerChecks(counterFixture(makeRunner))) {
        await expect(check.run(), check.name).resolves.toBeUndefined();
      }
    });
  }
});
