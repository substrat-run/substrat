import { useSyncExternalStore } from 'react';
import type { AppOverlays, OverlayMarker, ReleaseMarker } from './api';

/**
 * The one overlay vocabulary every time chart draws (#1767): six kinds of fact, each with
 * one glyph and one line style, and ONE visibility switch per kind that every chart obeys.
 * Hiding "Pushed" on the app page hides it on Pulse too — a reader who turned a kind off
 * should not have to find it again on the next chart, and a chip that only governed the
 * chart it sat above would make two charts of the same window disagree about what happened.
 */
export const OVERLAY_KEYS = ['pushed', 'live', 'mig', 'fail', 'rec', 'stale'] as const;
export type OverlayKey = (typeof OVERLAY_KEYS)[number];
export type OverlayPrefs = Record<OverlayKey, boolean>;

export const OVERLAY_LABELS: Record<OverlayKey, string> = {
  pushed: 'Pushed',
  live: 'Went live',
  mig: 'Migrations',
  fail: 'Failed runs',
  rec: 'Recorded failures',
  stale: 'Stale spans',
};

export const OVERLAY_PREFS_KEY = 'substrat.observability.chart-overlays.v1';

const ALL_ON: OverlayPrefs = { pushed: true, live: true, mig: true, fail: true, rec: true, stale: true };

/** Stored prefs → a full set. Anything unreadable is "on": a chart must never start with a
 *  kind hidden that the reader did not hide. */
export function parseOverlayPrefs(raw: string | null): OverlayPrefs {
  try {
    const value: unknown = JSON.parse(raw ?? 'null');
    if (!value || typeof value !== 'object') return { ...ALL_ON };
    const out = { ...ALL_ON };
    for (const k of OVERLAY_KEYS) if ((value as Record<string, unknown>)[k] === false) out[k] = false;
    return out;
  } catch {
    return { ...ALL_ON };
  }
}

export const releaseKey = (m: Pick<ReleaseMarker, 'kind'>): 'pushed' | 'live' => (m.kind === 'pushed' ? 'pushed' : 'live');
export const markerKey = (m: Pick<OverlayMarker, 'kind'>): 'mig' | 'fail' | 'rec' =>
  m.kind === 'migration' ? 'mig' : m.kind === 'run-failed' ? 'fail' : 'rec';

/** The release markers and overlays a chart should draw under `prefs`. */
export function applyOverlayPrefs(
  prefs: OverlayPrefs,
  markers: ReleaseMarker[],
  overlays: AppOverlays | undefined,
): { markers: ReleaseMarker[]; overlays: AppOverlays | undefined } {
  return {
    markers: markers.filter((m) => prefs[releaseKey(m)]),
    overlays: overlays && {
      ...overlays,
      markers: overlays.markers.filter((m) => prefs[markerKey(m)]),
      spans: prefs.stale ? overlays.spans : [],
    },
  };
}

// One module-level store, so every chart mounted at once reads the same object and a
// toggle re-renders all of them. Storage is a convenience on top: it can be absent or
// throw (private windows, blocked site data), and the chips must work without it.
let current: OverlayPrefs | null = null;
const listeners = new Set<() => void>();

function read(): OverlayPrefs {
  if (current) return current;
  let raw: string | null = null;
  try {
    raw = globalThis.localStorage?.getItem(OVERLAY_PREFS_KEY) ?? null;
  } catch {
    raw = null;
  }
  current = parseOverlayPrefs(raw);
  return current;
}

export function setOverlayVisible(key: OverlayKey, on: boolean): void {
  current = { ...read(), [key]: on };
  try {
    globalThis.localStorage?.setItem(OVERLAY_PREFS_KEY, JSON.stringify(current));
  } catch {
    // Not persisted; the in-memory state still governs every chart on the page.
  }
  for (const l of listeners) l();
}

/** Drops the cached state — for tests, and for another tab's write (`storage` below). */
export function resetOverlayPrefs(): void {
  current = null;
  for (const l of listeners) l();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  const onStorage = (e: StorageEvent) => {
    if (e.key === OVERLAY_PREFS_KEY) resetOverlayPrefs();
  };
  globalThis.addEventListener?.('storage', onStorage);
  return () => {
    listeners.delete(listener);
    globalThis.removeEventListener?.('storage', onStorage);
  };
}

export function useOverlayPrefs(): OverlayPrefs {
  return useSyncExternalStore(subscribe, read, read);
}
