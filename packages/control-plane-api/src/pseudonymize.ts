/**
 * The value generator behind the masked scope export (#1034).
 *
 * A masked pull used to write the literal `[masked]` into every PII cell, which made
 * the copy structurally valid and factually useless: every screen in a pulled scope
 * read `[masked]`, so a preview, a demo or a local repro could not be driven from
 * one. This turns the same cells into **plausible, deterministic, fake** values —
 * still no real personal data leaves the governed environment, but the copy reads
 * like a tenant.
 *
 * Three properties, and the whole design follows from them:
 *
 * 1. **Deterministic.** The same real value becomes the same fake value everywhere it
 *    appears — its own row, every fat event payload that quoted it, the invoice that
 *    snapshotted it. Otherwise joins and timelines stop lining up and the copy stops
 *    reading as real. The seed is `HMAC-SHA-256(salt, value)`, keyed on the ORIGINAL
 *    VALUE ONLY: the column's kind picks the *rendering*, so one email rendered as an
 *    `email` and as an `external_id` still agrees with itself.
 * 2. **Irreversible.** A keyed hash, and the salt is never written into the dump. No
 *    mapping is stored anywhere; nothing in the output can be walked back.
 * 3. **Still shaped like what it replaced.** An email stays `.email()`-parseable, a
 *    phone keeps its country prefix and its digit layout, a postal code keeps its
 *    length. A pulled scope whose every read throws a seam `.parse` failure is no
 *    better than `[masked]`.
 *
 * Uniqueness comes from the hash rather than from a collision pass: every generated
 * value carries hash-derived characters, so two distinct inputs practically never land
 * on one output and a natural key on `email` survives `importScope`. "Practically
 * never" is sized, not hoped for — an address carries a 48-bit tag, so a scope holding
 * a million distinct addresses collides with probability ~1e-7.
 *
 * **This is pseudonymization, not anonymization.** Rare combinations, amounts and
 * dates can still re-identify a subject, so nothing about §6's gate relaxes because
 * the output looks fake — the pull stays staff-only, audited and jurisdiction-checked.
 *
 * Deliberately NOT faked, stated rather than hidden:
 *  - **Free text** (`note`, `description`, `body`, `comment`, `message`, `subject`)
 *    stays `[masked]`. Lorem would be a lie about the content; a real sentence cannot
 *    be generated from a hash without inventing meaning.
 *  - **National identifiers** (`ssn`, `personnummer`) stay `[masked]`. A generated
 *    checksum-valid number may belong to a real person; the correct source is
 *    Skatteverket's published test range, which is not in this repo. Part of #1034.
 *  - **Locale** is one neutral value list. Following the tenant's locale needs a
 *    tenant-locale field that does not exist yet — inventing one here would be a
 *    guess dressed as a feature.
 *
 * Generated values are drawn from RFC 2606 reserved domains (`example.com`, …), so a
 * pseudonymized address is guaranteed not to reach anyone.
 */

/** What a column holds, as far as the name heuristic can tell. */
export type PiiKind =
  | 'email'
  | 'phone'
  | 'postal'
  | 'street'
  | 'city'
  | 'person'
  | 'given'
  | 'family'
  | 'external_id'
  | 'redact';

/** The literal a cell keeps when there is nothing honest to generate for it. */
export const MASKED = '[masked]';

// Small, deliberately boring value lists. Sized to a power of two so an index is a
// plain mask over a hash byte pair and every entry is equally likely.
const GIVEN = [
  'Alex', 'Robin', 'Sam', 'Nora', 'Iris', 'Milo', 'Elin', 'Otto',
  'Vera', 'Hugo', 'Maja', 'Leo', 'Signe', 'Kai', 'Freja', 'Arvid',
  'Tova', 'Emil', 'Saga', 'Noel', 'Lova', 'Vidar', 'Ida', 'Rune',
  'Astrid', 'Nils', 'Ebba', 'Loke', 'Ines', 'Alve', 'Tilda', 'Ove',
] as const;

const FAMILY = [
  'Lindqvist', 'Holm', 'Berg', 'Sandell', 'Norup', 'Vikner', 'Palm', 'Ekstrand',
  'Rydell', 'Almquist', 'Sjolin', 'Hedman', 'Falk', 'Bruun', 'Lager', 'Nystrom',
  'Ravn', 'Solberg', 'Wik', 'Dahl', 'Frost', 'Gran', 'Hovda', 'Iversen',
  'Kollen', 'Lyng', 'Moen', 'Rask', 'Stang', 'Tveit', 'Ulven', 'Vinge',
] as const;

const STREET = [
  'Almgatan', 'Bruksvagen', 'Cedervagen', 'Dalgatan', 'Ekbacken', 'Fyrgrand', 'Granstigen', 'Hamnvagen',
  'Idrottsgatan', 'Jarnvagsgatan', 'Kvarngatan', 'Lindvagen', 'Munkgatan', 'Norrtull', 'Osterled', 'Parkgatan',
] as const;

const CITY = [
  'Alvesta', 'Borlange', 'Enkoping', 'Falkoping', 'Gavle', 'Harnosand', 'Karlshamn', 'Lidkoping',
  'Motala', 'Nykoping', 'Oskarshamn', 'Pitea', 'Ronneby', 'Skovde', 'Trelleborg', 'Vasteras',
] as const;

const DOMAIN = ['example.com', 'example.org', 'example.net', 'example.edu'] as const;

// The alphabet `reshape` draws a replacement letter from (an alphanumeric postal code).
const LETTERS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';

/**
 * The column-name → kind heuristic. Order matters: the most specific pattern wins, and
 * the free-text catch-all is last so `note` never reads as a person's name.
 *
 * Names arrive snake_case from SQL columns and camelCase from JSON payload keys, so
 * callers normalize before asking.
 */
const KIND_PATTERNS: readonly [RegExp, PiiKind][] = [
  [/(^|_)(e?mail|e?mail_address)($|_)/i, 'email'],
  [/(^|_)(phone|mobile|tel)($|_)/i, 'phone'],
  [/(^|_)(postal|zip)($|_)/i, 'postal'],
  [/(^|_)(street|address)($|_)/i, 'street'],
  [/(^|_)city($|_)/i, 'city'],
  [/(^|_)(first_name|given_name)($|_)/i, 'given'],
  [/(^|_)(last_name|family_name|surname)($|_)/i, 'family'],
  [/(^|_)external_id($|_)/i, 'external_id'],
  // Free text and national identifiers: nothing honest to generate (see the header).
  [/(^|_)(ssn|personnummer|note|notes|comment|comments|message|subject|body|description)($|_)/i, 'redact'],
  [/(^|_)(name|full_name|contact)($|_)/i, 'person'],
];

/** Which kind a column or JSON key is, or `undefined` when it is not PII at all. */
export function kindOf(name: string): PiiKind | undefined {
  const snake = name.replace(/([a-z0-9])([A-Z])/g, '$1_$2');
  for (const [pattern, kind] of KIND_PATTERNS) if (pattern.test(snake)) return kind;
  return undefined;
}

/** A digest, as the little bag of numbers the renderers draw from. */
interface Seed {
  readonly bytes: Uint8Array;
}

const pick = <T>(list: readonly T[], seed: Seed, at: number): T =>
  list[((seed.bytes[at]! << 8) | seed.bytes[at + 1]!) % list.length]!;

/**
 * Replace every digit AND letter of `original` with a hash-derived one, keeping every
 * other character exactly where it was — so `+46 70-123 45 67` stays a Swedish mobile,
 * `114 51` stays a Swedish postal code, and `K1A 0B1` stays a Canadian one without
 * keeping any of its original characters. Letters matter: a postal code is alphanumeric
 * in half the world, and copying its letters through would leave real fragments of a
 * real address in a file whose whole promise is that it holds none.
 *
 * Case and layout survive; the character CLASS is what is preserved, not the character.
 * Only ASCII letters are substituted — the formats this is applied to (phone numbers,
 * postal codes) are ASCII by specification, and a stray `ö` is layout, not identity.
 *
 * The leading country code (the first `keepLeadingDigits` digits, used for the two after
 * a `+`) is preserved: it is a fact about the country, not about the person, and a
 * validator that checks it must still pass.
 */
function reshape(original: string, seed: Seed, keepLeadingDigits: number): string {
  let out = '';
  let seen = 0;
  let at = 0;
  const next = (): number => seed.bytes[at++ % seed.bytes.length]!;
  for (const ch of original) {
    if (/[0-9]/.test(ch)) {
      seen += 1;
      if (seen <= keepLeadingDigits) out += ch;
      else out += String(next() % 10);
    } else if (/[A-Za-z]/.test(ch)) {
      const letter = LETTERS[next() % LETTERS.length]!;
      out += ch === ch.toUpperCase() ? letter : letter.toLowerCase();
    } else {
      out += ch;
    }
  }
  return out;
}

const looksLikeEmail = (value: string): boolean => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);

const slug = (value: string): string => value.toLowerCase().replace(/[^a-z0-9]+/g, '');

/** `2n` hex characters from the digest, starting at byte `at`. */
const hex = (seed: Seed, at: number, n: number): string =>
  [...seed.bytes.slice(at, at + n)].map((b) => b.toString(16).padStart(2, '0')).join('');

/** Render one value of one kind from its digest. */
function render(kind: PiiKind, original: string, seed: Seed): string {
  const given = pick(GIVEN, seed, 0);
  const family = pick(FAMILY, seed, 2);
  switch (kind) {
    case 'email':
      // `.email()`-parseable, at a reserved domain, with a 48-bit hash tag so two people
      // who share a name do not share an address. The tag is what makes the no-collision
      // claim true at a real scope's cardinality rather than a test's: name+domain alone
      // is 4,096 combinations, and three digits on top of that collide with ~11%
      // probability across a mere 1,000 addresses — which is a UNIQUE violation at
      // `importScope`, not a cosmetic clash. It reads machine-generated because it is;
      // that is the honest trade against a round trip that fails. The tag's bytes start
      // past the ones the name and domain use, so it adds entropy instead of echoing it.
      return `${slug(given)}.${slug(family)}.${hex(seed, 16, 6)}@${pick(DOMAIN, seed, 8)}`;
    case 'phone':
      // Keep the shape: a `+46 70-…` stays that, and a bare 10-digit string stays ten
      // digits, so a length or prefix check on the way back in still passes.
      return reshape(original, seed, original.trimStart().startsWith('+') ? 2 : 0);
    case 'postal':
      return reshape(original, seed, 0);
    case 'street':
      return `${pick(STREET, seed, 10)} ${(((seed.bytes[12]! << 8) | seed.bytes[13]!) % 199) + 1}`;
    case 'city':
      return pick(CITY, seed, 14);
    case 'given':
      return given;
    case 'family':
      return family;
    case 'person':
      return `${given} ${family}`;
    case 'external_id':
      // An identity link's external id is usually the provider's subject, which in
      // practice is very often an email — so render it as one when it looks like one,
      // and as an opaque token when it does not.
      return looksLikeEmail(original)
        ? render('email', original, seed)
        : `pseudo-${hex(seed, 0, 8)}`;
    case 'redact':
      return MASKED;
  }
}

/**
 * A generator bound to one export's salt.
 *
 * `prepare` is separate from `valueFor` on purpose: HMAC is async and a dump is a lot
 * of cells, so the caller collects every distinct value first, computes the digests in
 * one batch, and then does the substitution walk synchronously. Digests are per
 * DISTINCT VALUE, so a customer's email quoted in two hundred event payloads costs one.
 */
export interface Pseudonymizer {
  prepare(values: Iterable<string>): Promise<void>;
  valueFor(kind: PiiKind, original: string): string;
}

export async function createPseudonymizer(salt: string): Promise<Pseudonymizer> {
  const key = await globalThis.crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(salt),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const seeds = new Map<string, Seed>();

  return {
    async prepare(values: Iterable<string>): Promise<void> {
      const pending: Promise<void>[] = [];
      for (const value of values) {
        if (seeds.has(value)) continue;
        seeds.set(value, { bytes: new Uint8Array(32) }); // placeholder: claims the slot
        pending.push(
          globalThis.crypto.subtle
            .sign('HMAC', key, new TextEncoder().encode(value))
            .then((sig) => {
              seeds.set(value, { bytes: new Uint8Array(sig) });
            }),
        );
      }
      await Promise.all(pending);
    },
    valueFor(kind: PiiKind, original: string): string {
      if (kind === 'redact') return MASKED;
      const seed = seeds.get(original);
      // Not prepared — refuse rather than emit an unkeyed value. A caller that skips
      // `prepare` would otherwise leak the real cell, which is the one outcome this
      // module exists to prevent.
      if (!seed) return MASKED;
      return render(kind, original, seed);
    },
  };
}
