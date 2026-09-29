import { useEffect, useRef } from 'react';

/**
 * Escape closes the topmost layer, and only that one (#1921).
 *
 * The request panel, the record panel and the ⌘K overlay can be open at once — a request
 * opened from a record's timeline sits above the record. Each used to listen for Escape on
 * `window` itself, so one key press ran every close, each pushing its own history step.
 * Here there is one listener and a stack in open order: the newest layer handles the key.
 */
const layers: { current: () => void }[] = [];
let listening = false;

function onKey(e: KeyboardEvent): void {
  if (e.key !== 'Escape') return;
  const top = layers.at(-1);
  if (!top) return;
  e.preventDefault();
  top.current();
}

/** Register a layer while mounted; `onEscape` runs only while it is the topmost one. */
export function useEscapeLayer(onEscape: () => void): void {
  const handler = useRef(onEscape);
  handler.current = onEscape;
  useEffect(() => {
    layers.push(handler);
    if (!listening) {
      window.addEventListener('keydown', onKey);
      listening = true;
    }
    return () => {
      const i = layers.lastIndexOf(handler);
      if (i >= 0) layers.splice(i, 1);
      if (layers.length === 0 && listening) {
        window.removeEventListener('keydown', onKey);
        listening = false;
      }
    };
  }, []);
}
