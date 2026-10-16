import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { REVIEW_TEXT_SHOWN_MAX, type MigrationDiff, type MigrationEntry } from '@substrat-run/contracts';
import { PromoteMigrations } from '../src/components/PromoteMigrations';

/** #2322: the promote dialog shows each migration's declared moves and discards, as text. */
describe('PromoteMigrations: declared moves and discards', () => {
  let container: HTMLElement;
  let root: Root;

  beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });
  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  const diff = (added: MigrationEntry[], changed: MigrationEntry[] = []): MigrationDiff => ({
    baseline: 'version',
    added,
    changed,
    total: added.length + changed.length,
    truncated: false,
  });
  const show = (sql: MigrationDiff) => act(() => root.render(<PromoteMigrations section={{ digests: null, sql, enforced: false }} />));
  const text = () => container.textContent ?? '';

  it('lists a discard with its reason and a move with its target; a migration declaring none shows neither', () => {
    show(
      diff([
        { moduleId: 'desk', version: '0001', sql: 'SELECT 1;' },
        { moduleId: 'desk', version: '0002', sql: 'DROP TABLE legacy;', discards: { legacy: 'unused since 2024' }, moves: { 'a.b': 'c.d' } },
      ]),
    );
    expect(text()).toContain('This promote deliberately discards data in 1 place.');
    expect(text()).toContain('Discardslegacy— unused since 2024');
    expect(text()).toContain('Movesa.b → c.dverified when it runs');
    // The undeclared entry carries no declaration rows: exactly one of each kind on the page.
    expect(text().match(/Discardslegacy/g)).toHaveLength(1);
    expect(text().match(/Moves/g)).toHaveLength(1);
    // Visible without opening the collapsed SQL.
    const declared = [...container.querySelectorAll('details')][1]!;
    expect(declared.open).toBe(false);
    expect(declared.nextElementSibling?.textContent).toContain('unused since 2024');
  });

  it('shows no callout and no declaration rows for a set that declares nothing', () => {
    show(diff([{ moduleId: 'desk', version: '0001', sql: 'SELECT 1;' }]));
    expect(text()).not.toMatch(/discards data|Discards|Moves/);
  });

  it('renders a reason as text, never markup, with bidi controls made visible', () => {
    show(diff([{ moduleId: 'desk', version: '0002', sql: 's', discards: { 'a\u202Eb': '<img src=x onerror=alert(1)><b>bold</b>\u2066x' } }]));
    expect(container.querySelector('img')).toBeNull();
    expect(container.querySelector('b')).toBeNull();
    expect(text()).toContain('a<U+202E>b');
    expect(text()).toContain('<img src=x onerror=alert(1)><b>bold</b><U+2066>x');
    expect(text()).not.toMatch(/[\u202A-\u202E\u2066-\u2069]/);
  });

  it('cuts a long reason with an expander, and shows it whole on request', () => {
    const reason = 'r'.repeat(REVIEW_TEXT_SHOWN_MAX) + 'TAIL';
    show(diff([{ moduleId: 'desk', version: '0002', sql: 's', discards: { t: reason } }]));
    expect(text()).not.toContain('TAIL');
    const button = [...container.querySelectorAll('button')].find((b) => b.textContent === 'Show all')!;
    act(() => button.click());
    expect(text()).toContain(`${reason}Show less`);
  });

  it('groups a declarations-only edit apart from a SQL edit, and says what each means', () => {
    show(
      diff(
        [],
        [
          { moduleId: 'desk', version: '0001', sql: 'SELECT 0;', edited: 'sql' },
          { moduleId: 'desk', version: '0002', sql: 'SELECT 1;', edited: 'declarations', discards: { t: 'why' } },
        ],
      ),
    );
    expect(text()).toContain('Edited after shipping');
    expect(text()).toContain('Declarations edited after shipping');
    expect(text()).toContain('A scope that already ran it is unaffected; one that has not is held to these.');
  });

  it('makes every control, format and bidi character visible in the id, the SQL, a target and a reason (#2322 r1)', () => {
    const c = (...p: number[]) => String.fromCodePoint(...p);
    const hostile = c(0x1b, 0x9b, 0x7f, 0x202e, 0x200b, 0xfeff);
    const shown = '<U+001B><U+009B><U+007F><U+202E><U+200B><U+FEFF>';
    show(diff([{ moduleId: `desk${hostile}`, version: `0002${hostile}`, sql: `DROP TABLE t;${hostile}`, discards: { [`t${hostile}`]: `why${hostile}` } }]));
    expect(text()).toContain(`desk${shown} · 0002${shown}`);
    expect(container.querySelector('pre')?.textContent).toBe(`DROP TABLE t;${shown}`);
    expect(text()).toContain(`t${shown}— why${shown}`);
    expect(text()).not.toMatch(/[\p{Cc}\p{Cf}]/u);
  });

  it('shows a newline in an id or a target as a mark, and reads CRLF SQL as its lines (#2322 r2)', () => {
    show(diff([{ moduleId: 'desk', version: '0007\n+ desk 0008', sql: 'SELECT 1;\r\nSELECT 2;\rX', discards: { 'a\nb': 'why' }, moves: { 'c\td': 'e' } }]));
    expect(text()).toContain('desk · 0007<U+000A>+ desk 0008');
    expect(text()).toContain('a<U+000A>b— why');
    expect(text()).toContain('c<U+0009>d → e');
    expect(container.querySelector('pre')?.textContent).toBe('SELECT 1;\nSELECT 2;<U+000D>X');
  });

  it('cuts a reason of many short lines too, so its height is bounded (#2322 r1)', () => {
    const reason = Array.from({ length: 10 }, (_, i) => `line ${i}`).join('\n');
    show(diff([{ moduleId: 'desk', version: '0002', sql: 's', discards: { t: reason } }]));
    expect(text()).toContain('line 5…');
    expect(text()).not.toContain('line 6');
    act(() => [...container.querySelectorAll('button')].find((b) => b.textContent === 'Show all')!.click());
    expect(text()).toContain('line 9');
  });

  it('says "at least" when the answer is cut, and that a cut list cannot say when it shows none (#2322 r1)', () => {
    show({ ...diff([{ moduleId: 'desk', version: '0002', sql: 's', discards: { t: 'why' } }]), total: 300, truncated: true });
    expect(text()).toContain('deliberately discards data in at least 1 place.');
    show({ ...diff([{ moduleId: 'desk', version: '0002', sql: 's' }]), total: 300, truncated: true });
    expect(text()).toContain('This list is cut, so it cannot show whether a migration left out of it discards data.');
    expect(text()).not.toContain('Discards data');
  });

  it('says declarations were left out rather than showing none', () => {
    show({ ...diff([{ moduleId: 'desk', version: '0002', sql: null, declarationsLeftOut: true }]), truncated: true });
    expect(text()).toContain('Declares moves or discards that are left out');
  });
});
