// @vitest-environment jsdom
/**
 * `useRequest` (#3244): a refresh over a shown answer keeps it — no skeleton, no empty flash,
 * and a failed refresh is not an error over data that is still on screen — while a new key
 * (another team) starts over from loading rather than captioning it with the old answer.
 */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { useRequest, type Request } from '../src/hooks/use-request';

let container: HTMLDivElement;
let root: Root;
beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

/** Each read is a promise the test settles by hand. */
function reads() {
  const queue: { resolve: (v: string) => void; reject: (e: unknown) => void }[] = [];
  const load = () => new Promise<string>((resolve, reject) => queue.push({ resolve, reject }));
  return { load, queue };
}

function mount(load: () => Promise<string>, key: string) {
  const seen: Request<string>[] = [];
  function Probe({ k }: { k: string }) {
    seen.push(useRequest(load, [k]));
    return null;
  }
  act(() => root.render(<Probe k={key} />));
  return { seen, rekey: (k: string) => act(() => root.render(<Probe k={k} />)), last: () => seen[seen.length - 1]! };
}

it('keeps the shown answer through a reload, and through a failed one', async () => {
  const { load, queue } = reads();
  const h = mount(load, 'team-a');
  await act(async () => queue[0]!.resolve('rows'));
  expect(h.last().state).toEqual({ state: 'ok', value: 'rows' });

  const from = h.seen.length;
  let reloaded!: Promise<void>;
  act(() => void (reloaded = h.last().reload()));
  await act(async () => {
    queue[1]!.reject(new Error('poll missed'));
    await reloaded;
  });
  expect(h.seen.slice(from).map((r) => r.state)).toEqual(h.seen.slice(from).map(() => ({ state: 'ok', value: 'rows' })));
});

it('a new key starts over from loading, and the old key’s late answer is dropped', async () => {
  const { load, queue } = reads();
  const h = mount(load, 'team-a');
  await act(async () => queue[0]!.resolve('a-rows'));
  h.rekey('team-b');
  expect(h.last().state).toEqual({ state: 'loading' });
  h.rekey('team-c');
  await act(async () => queue[1]!.resolve('b-rows'));
  expect(h.last().state).toEqual({ state: 'loading' });
  await act(async () => {
    queue[2]!.resolve('c-rows');
  });
  expect(h.last().state).toEqual({ state: 'ok', value: 'c-rows' });
});

it('a retry from an error goes back to loading, then to the answer', async () => {
  const { load, queue } = reads();
  const h = mount(load, 'team-a');
  await act(async () => queue[0]!.reject(new Error('down')));
  expect(h.last().state.state).toBe('error');
  act(() => void h.last().reload());
  expect(h.last().state).toEqual({ state: 'loading' });
  await act(async () => queue[1]!.resolve('rows'));
  expect(h.last().state).toEqual({ state: 'ok', value: 'rows' });
});
