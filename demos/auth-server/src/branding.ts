import { z } from 'zod';
import type { SqlExec } from './introspect.js';

/**
 * Per-client theming for the hosted OIDC pages (`/login`, `/signup`, `/consent`).
 *
 * A relying party's operator styles the screens their users are sent to by putting a
 * `theme` object into the client's free-form `metadata` — the column the registry already
 * has, written through the existing admin PATCH, so there is no second write path and no
 * migration. This module is the READ side both runtimes share (the Durable Object and the
 * node dev server), exactly as `admin-api.ts` is for the admin surface.
 *
 * The vocabulary is deliberately Clerk-shaped (`colorPrimary`, `borderRadius`, …): it is
 * the best-known theming contract in the auth space, and a developer who has themed Clerk
 * should not need docs here. Each key maps onto one CSS custom property in the SPA's
 * `tokens.css` (the mapping lives in `app/src/api.ts`, beside the fetch).
 *
 * Two decisions that are security posture, not style:
 *
 *  - **The public read returns ONLY the sanitized theme** — never the client's name, icon
 *    or existence. `public-client-prelogin` resolves a client id to a name only inside a
 *    validly SIGNED authorize query, precisely so the registry cannot be enumerated by a
 *    stranger; a branding endpoint that answered "unknown client" differently from "no
 *    theme" would be the oracle that design refused. So unknown, disabled and unthemed
 *    clients all answer `{ theme: {} }`, indistinguishably.
 *  - **Every value is validated on the way out, key by key.** Metadata is operator-written
 *    JSON; these values land in CSS custom properties and an <img src>. A key that fails
 *    its check is dropped while the rest survive — a typo in one color must not turn the
 *    whole login screen back to defaults.
 */

/** `#rgb` or `#rrggbb` — the only color form accepted, so a value can never smuggle CSS. */
const hexColor = z.string().regex(/^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/);

/** A pixel length for the corner radius: `0px` – `32px`. */
const radius = z.string().regex(/^(?:[0-9]|[12][0-9]|3[0-2])px$/);

/** The logo must be https (or a data: image, which cannot reach the network at all). */
const logoUrl = z
  .string()
  .max(2048)
  .refine((v) => v.startsWith('https://') || v.startsWith('data:image/'), {
    message: 'logoUrl must be https:// or data:image/',
  });

/**
 * The theme vocabulary, v1. Every key optional; unknown keys are ignored rather than
 * refused, so a future key round-trips through an older issuer unharmed.
 */
export const clientThemeSchema = z.object({
  /** Buttons, links, focus — the brand color. */
  colorPrimary: hexColor,
  /** Text ON the primary color (the sign-in button's label). */
  colorPrimaryForeground: hexColor,
  /** The page behind the card. */
  colorBackground: hexColor,
  /** The card and panels. */
  colorPanel: hexColor,
  /** Input fields. */
  colorInput: hexColor,
  /** Body text. */
  colorText: hexColor,
  /** Secondary text and hints. */
  colorMutedText: hexColor,
  /** Corner radius for inputs and buttons; the card derives its own from this. */
  borderRadius: radius,
  /** Shown above the card title on the sign-in screen. */
  logoUrl,
  /** Replaces the default "Substrat Auth" heading on the sign-in screen. */
  title: z.string().min(1).max(60),
});

export type ClientTheme = Partial<z.infer<typeof clientThemeSchema>>;

/**
 * Sanitize an operator-written theme object: keep each key that passes its own check, drop
 * the rest silently. Not a whole-object `safeParse` — that would let one invalid value
 * discard nine valid ones.
 */
export function sanitizeTheme(value: unknown): ClientTheme {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  const raw = value as Record<string, unknown>;
  const theme: Record<string, string> = {};
  for (const [key, schema] of Object.entries(clientThemeSchema.shape)) {
    if (raw[key] === undefined) continue;
    const parsed = (schema as z.ZodType<string>).safeParse(raw[key]);
    if (parsed.success) theme[key] = parsed.data;
  }
  return theme as ClientTheme;
}

/**
 * The public branding answer for a client id: `{ theme }`, always 200-shaped. Unknown id,
 * disabled client, absent or malformed metadata all yield `{ theme: {} }` — deliberately
 * indistinguishable (see the header).
 */
export function clientBranding(sql: SqlExec, clientId: string | null | undefined): { theme: ClientTheme } {
  if (!clientId) return { theme: {} };
  const row = sql
    .exec('SELECT metadata, disabled FROM oauth_client WHERE client_id = ?', clientId)
    .toArray()[0] as { metadata: string | null; disabled: number | null } | undefined;
  if (!row || row.disabled) return { theme: {} };
  if (!row.metadata) return { theme: {} };
  let metadata: unknown;
  try {
    metadata = JSON.parse(row.metadata);
  } catch {
    return { theme: {} };
  }
  const theme = (metadata as Record<string, unknown> | null)?.theme;
  return { theme: sanitizeTheme(theme) };
}
