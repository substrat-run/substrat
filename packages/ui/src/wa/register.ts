/**
 * Registers what `@substrat-run/ui/wa` draws. An app imports this once, before it renders.
 *
 * Web Awesome is reached through `@substrat-run/elements` alone, never as a dependency of
 * this package: pnpm keys a copy by its peers, so a second dependent with a different
 * `@types/node` gets a second copy, and the two then define the same custom elements, which
 * throws on load.
 */
import '@substrat-run/elements';
import '@substrat-run/elements/controls';
