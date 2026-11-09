/** How long after `compositionend` an Enter still belongs to the input method. Safari orders them late. */
export const COMPOSITION_GRACE_MS = 100;

export interface CompositionState {
  /** Between `compositionstart` and `compositionend`. */
  composing: boolean;
  /** The `timeStamp` of the last `compositionend`, or null before the first. */
  endedAt: number | null;
}

/**
 * True for an Enter that confirms an input method's candidate and must not send. `isComposing`
 * alone is not enough: WebKit reports `compositionend` before the keydown that caused it, so
 * that keydown says it is not composing. `keyCode` 229 and the grace window cover that order.
 */
export function isComposingEnter(event: Pick<KeyboardEvent, 'isComposing' | 'keyCode' | 'timeStamp'>, state: CompositionState): boolean {
  if (event.isComposing || event.keyCode === 229 || state.composing) return true;
  return state.endedAt !== null && event.timeStamp - state.endedAt < COMPOSITION_GRACE_MS;
}
