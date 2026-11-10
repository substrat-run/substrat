/**
 * The theme vocabulary and its checks — what `branding.ts` applies on the way out of the
 * registry, and what the console's raw editor shows an operator before they save. Free of
 * dependencies for that reason, as `user-import-wire.ts` is: the browser imports this file.
 *
 * `THEMING.md` documents the same vocabulary for whoever (or whatever) writes a theme file.
 */

export interface ClientTheme {
  /** Buttons, links, focus — the brand color. */
  colorPrimary?: string;
  /** Text ON the primary color (the sign-in button's label). */
  colorPrimaryForeground?: string;
  /** The page behind the card. */
  colorBackground?: string;
  /** The card and panels. */
  colorPanel?: string;
  /** Input fields. */
  colorInput?: string;
  /** Body text. */
  colorText?: string;
  /** Secondary text and hints. */
  colorMutedText?: string;
  /** Hairlines: the card's edge, input borders, dividers. */
  colorBorder?: string;
  /** Error text. */
  colorDanger?: string;
  /** Which of the two built-in palettes the keys above are laid over. */
  colorScheme?: 'light' | 'dark';
  /** Corner radius for inputs and buttons; the card derives its own from this. */
  borderRadius?: string;
  /** Shown above the card title on the sign-in screen. */
  logoUrl?: string;
  /** Replaces the default "Substrat Auth" heading on the sign-in screen. */
  title?: string;
  /** Raw CSS for the hosted screens, under the rules `cssProblems` holds. */
  css?: string;
}

/** `#rgb` or `#rrggbb` — the only color form accepted, so a value can never smuggle CSS. */
const HEX_COLOR = /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/;

/** A pixel length for the corner radius: `0px` – `32px`. */
const RADIUS = /^(?:[0-9]|[12][0-9]|3[0-2])px$/;

const MAX_LOGO_URL = 2048;
/** A logo pasted inline is a whole image, where a URL is only its address. */
const MAX_LOGO_DATA = 256_000;
const MAX_CSS = 100_000;

/** At-rules a theme may use. Allowed by name because the one that matters, `@import`, fetches. */
const CSS_AT_RULES = new Set(['media', 'supports', 'keyframes', '-webkit-keyframes', 'font-face', 'container', 'layer']);

/**
 * Why this CSS may not be served on a sign-in screen; empty when it may.
 *
 * These pages hold a password field, and a stylesheet that can reach the network can read one:
 * `input[value^="a"] { background: url(https://…/a) }` reports each character as it is typed,
 * and React mirrors a controlled input's value into that attribute. So the whole rule is that a
 * theme makes no request of its own — images and fonts are inlined as `data:`, which cannot be
 * addressed anywhere. Everything else about the CSS is the operator's to decide.
 *
 * It reads the raw text rather than parsing, deliberately: a parser that disagrees with the
 * browser's is the bypass. Text in a comment or a string is judged like any other, and a
 * refusal it causes only costs rewording. A backslash is refused outright because a CSS escape
 * spells any of these words in characters this scan cannot see (`\75 rl(`).
 */
export function cssProblems(css: string): string[] {
  const problems: string[] = [];
  if (css.length > MAX_CSS) problems.push(`is ${css.length} characters; the limit is ${MAX_CSS}`);
  if (css.includes('\\')) problems.push('contains a backslash; CSS escapes are not allowed');
  if (css.includes('<')) problems.push('contains "<"; a stylesheet has no use for markup');
  for (const [, name] of css.matchAll(/@([a-zA-Z-]+)/g)) {
    if (!CSS_AT_RULES.has(name!.toLowerCase())) problems.push(`uses @${name}, which is not allowed`);
  }
  for (const [, target] of css.matchAll(/url\(\s*['"]?\s*([^'")\s]{0,32})/gi)) {
    if (!/^data:(?:image|font)\//i.test(target!)) {
      problems.push(`loads url(${target}…); images and fonts must be inlined as data:image/ or data:font/`);
    }
  }
  // `image-set("https://…")` and its relatives take a bare string, with no `url(` to find.
  for (const [match] of css.matchAll(/["']\s*(?:https?:)?\/\/[^"']{0,32}/gi)) {
    problems.push(`names an external address (${match.slice(1).trim()}…)`);
  }
  return problems;
}

/** How light a hex color is, 0 to 1, by the usual perceptual weights. */
function lightness(hex: string): number {
  const digits = hex.slice(1);
  const full = digits.length === 3 ? [...digits].map((d) => d + d).join('') : digits;
  const [r, g, b] = [0, 2, 4].map((at) => parseInt(full.slice(at, at + 2), 16)) as [number, number, number];
  return (0.299 * r + 0.587 * g + 0.114 * b) / 255;
}

/**
 * Which built-in palette a theme's unset keys come from: the one it asks for, else whichever
 * suits its card. That second half is what keeps a theme written when the default was dark
 * readable: it set a dark card and background and left the text to the default, which would
 * now be dark text on a dark card.
 */
export function schemeOf(theme: ClientTheme): 'light' | 'dark' {
  if (theme.colorScheme) return theme.colorScheme;
  const surface = theme.colorPanel ?? theme.colorBackground;
  return surface && lightness(surface) < 0.5 ? 'dark' : 'light';
}

const hexCheck = (v: unknown): string | null =>
  typeof v === 'string' && HEX_COLOR.test(v) ? null : 'must be a hex color like #0a6847';

/** One check per key; `null` means the value may be served. */
const THEME_CHECKS: Record<keyof ClientTheme, (v: unknown) => string | null> = {
  colorPrimary: hexCheck,
  colorPrimaryForeground: hexCheck,
  colorBackground: hexCheck,
  colorPanel: hexCheck,
  colorInput: hexCheck,
  colorText: hexCheck,
  colorMutedText: hexCheck,
  colorBorder: hexCheck,
  colorDanger: hexCheck,
  colorScheme: (v) => (v === 'light' || v === 'dark' ? null : 'must be "light" or "dark"'),
  borderRadius: (v) => (typeof v === 'string' && RADIUS.test(v) ? null : 'must be 0px to 32px'),
  logoUrl: (v) => {
    if (typeof v !== 'string') return 'must be a string';
    if (v.startsWith('https://')) return v.length <= MAX_LOGO_URL ? null : `is over ${MAX_LOGO_URL} characters`;
    if (v.startsWith('data:image/')) return v.length <= MAX_LOGO_DATA ? null : `is over ${MAX_LOGO_DATA} characters`;
    return 'must be https:// or data:image/';
  },
  title: (v) => (typeof v === 'string' && v.length >= 1 && v.length <= 60 ? null : 'must be 1 to 60 characters'),
  css: (v) => {
    if (typeof v !== 'string') return 'must be a string';
    return cssProblems(v).join('; ') || null;
  },
};

/**
 * Sanitize an operator-written theme object: keep each key that passes its own check, drop
 * the rest silently. Not all-or-nothing — that would let one invalid value discard nine valid
 * ones. Unknown keys are ignored, so a future key round-trips through an older issuer unharmed.
 */
export function sanitizeTheme(value: unknown): ClientTheme {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  const raw = value as Record<string, unknown>;
  const theme: Record<string, unknown> = {};
  for (const [key, check] of Object.entries(THEME_CHECKS)) {
    if (raw[key] !== undefined && check(raw[key]) === null) theme[key] = raw[key];
  }
  return theme as ClientTheme;
}

/**
 * Everything wrong with a theme file, one line per key — the loud half of `sanitizeTheme`, for
 * someone at a keyboard who would rather hear about it. An unknown key is a problem here and
 * not there, because at the moment of writing it is almost certainly a typo.
 */
export function themeProblems(value: unknown): string[] {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return ['a theme is a JSON object'];
  const problems: string[] = [];
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    const check = THEME_CHECKS[key as keyof ClientTheme];
    const problem = check ? check(entry) : 'is not a theme key';
    if (problem) problems.push(`${key} ${problem}`);
  }
  return problems;
}
