import { describe, expect, it } from 'vitest';
import { conceptPage, conceptSections } from '../src/concept.js';
import { fitToolOutput, shapeForModel } from '../src/ask.js';

describe('published application description', () => {
  it('indexes headings without interpreting fenced examples as sections', () => {
    const sections = conceptSections('Introduction\n\n# Desk\n\nWork orders.\n\n```md\n## Example\n```\n\n## Approvals\n\nManagers approve.');
    expect(sections.map(({ id, title }) => ({ id, title }))).toEqual([
      { id: 's0', title: 'Overview' }, { id: 's1', title: 'Desk' }, { id: 's2', title: 'Approvals' },
    ]);
    expect(sections[1]!.text).toContain('## Example');
    expect(conceptPage('# Desk\n\nWork orders.').section).toBeNull();
    expect(() => conceptPage('# Desk\n\nWork orders.', 'missing')).toThrow(/section not found/);
  });

  it('makes the end of long sections reachable without Ask silently cutting their text', () => {
    const body = '🙂'.repeat(5_100) + ' The final rule.';
    const document = `# Rules\n\n${body}`;
    const paragraphs: string[] = [];
    const offsets: number[] = [];
    for (let offset: number | null = 0; offset !== null;) {
      offsets.push(offset);
      const page = conceptPage(document, 's0', offset);
      expect(fitToolOutput(shapeForModel(page))).toEqual(page);
      paragraphs.push(...page.section!.paragraphs);
      offset = page.nextOffset;
    }
    expect(offsets).toEqual([0, 20, 40]);
    expect(paragraphs.join('')).toBe(body);
    expect(paragraphs.every((p) => p.length <= 500)).toBe(true);
    expect(shapeForModel(paragraphs)).toEqual(paragraphs);
  });

  it('pages long indexes too, without repeating them in section answers', () => {
    const document = Array.from({ length: 25 }, (_, i) => `## Rule ${i}\n\nBody ${i}`).join('\n\n');
    const first = conceptPage(document);
    expect(first.sections).toHaveLength(20);
    expect(first.nextOffset).toBe(20);
    const next = conceptPage(document, undefined, first.nextOffset!);
    expect(next.sections[0]).toEqual({ id: 's20', title: 'Rule 20' });
    expect(next.nextOffset).toBeNull();
    expect(conceptPage(document, 's24')).toMatchObject({ sections: [], section: { paragraphs: ['Body 24'] } });
    const wideIndex = conceptPage(Array.from({ length: 25 }, () => `## ${'字'.repeat(500)}\n\nBody`).join('\n\n'));
    expect(fitToolOutput(shapeForModel(wideIndex))).toEqual(wideIndex);
  });

  it('redacts secrets before splitting across fragment and section boundaries', () => {
    const prefix = 'A '.repeat(248);
    const token = 'api_key=example-only';
    const page = conceptPage(`# Rules\n\n${prefix}${token}\n\n-----BEGIN PRIVATE KEY-----\n## private\nsecret bytes\n-----END PRIVATE KEY-----`, 's0');
    expect(page.section!.paragraphs.join('')).toBe(`${prefix}api_key=[secret][key]`);
    expect(JSON.stringify(page)).not.toContain('secret bytes');
  });
});
