import { describe, expect, it } from 'vitest';
import { digestOf, render } from '../src/render.js';

describe('render', () => {
  it('fills every placeholder, tolerating spaces inside the braces', () => {
    expect(render({ subject: 'Hi {{ name }}', text: 'Order {{id}}' }, { name: 'Ada', id: '7' })).toEqual({
      ok: true,
      message: { subject: 'Hi Ada', text: 'Order 7', html: '<p>Order 7</p>' },
    });
  });

  it('a declared html part is filled with escaped values', () => {
    const r = render({ subject: 's', text: 't', html: '<b>{{x}}</b>' }, { x: '<i>&"\'' });
    expect(r).toMatchObject({ ok: true, message: { html: '<b>&lt;i&gt;&amp;&quot;&#39;</b>' } });
  });

  it('paragraphs and line breaks of the text survive into the derived html', () => {
    const r = render({ subject: 's', text: 'a\nb\n\nc' }, {});
    expect(r).toMatchObject({ ok: true, message: { html: '<p>a<br>b</p>\n<p>c</p>' } });
  });

  it('names the first missing variable instead of rendering a blank', () => {
    expect(render({ subject: '{{a}}', text: '{{b}}' }, { b: 'x' })).toEqual({ ok: false, reason: 'missing_variable:a' });
  });

  it('a message whose every word was a blank variable is refused, not sent empty', () => {
    expect(render({ subject: '{{a}}', text: 'x' }, { a: '' })).toEqual({ ok: false, reason: 'empty_message:subject' });
    expect(render({ subject: 's', text: '{{a}}' }, { a: ' ' })).toEqual({ ok: false, reason: 'empty_message:text' });
  });

  it('a declared html part that renders empty is refused too, naming it', () => {
    expect(render({ subject: 's', text: 't', html: '{{b}}' }, { b: '' })).toEqual({ ok: false, reason: 'empty_message:html' });
  });

  it('a variable is filled once: a value that looks like a placeholder stays literal', () => {
    expect(render({ subject: '{{a}}', text: '{{b}}' }, { a: '{{b}}', b: 'B' })).toMatchObject({
      ok: true,
      message: { subject: '{{b}}', text: 'B' },
    });
  });
});

describe('digestOf', () => {
  const m = (subject: string, text: string, html = `<p>${text}</p>`) => ({ subject, text, html });

  it('a digest of one message is that message, untouched — its three parts and nothing else', () => {
    const only = m('Assigned: WO-1', 'You have WO-1.');
    const heldRow = { ...only, id: 'a held row carries more' };
    expect(digestOf([heldRow])).toStrictEqual(only);
  });

  it('several become one mail in order, under the first subject and a count, in no words of its own', () => {
    expect(digestOf([m('A', 'one'), m('B', 'two'), m('C', 'three')])).toEqual({
      subject: 'A (+2)',
      text: 'A\n\none\n\n----\n\nB\n\ntwo\n\n----\n\nC\n\nthree',
      html:
        '<section>\n<h2>A</h2>\n<p>one</p>\n</section>\n<hr>\n' +
        '<section>\n<h2>B</h2>\n<p>two</p>\n</section>\n<hr>\n' +
        '<section>\n<h2>C</h2>\n<p>three</p>\n</section>',
    });
  });

  it('a subject is header text, so it is escaped where it becomes a heading; the html it carries is kept', () => {
    const d = digestOf([m('<i>x</i> & y', 't', '<p>&lt;already&gt;</p>'), m('z', 't')]);
    expect(d.html).toContain('<h2>&lt;i&gt;x&lt;/i&gt; &amp; y</h2>\n<p>&lt;already&gt;</p>');
    expect(d.subject).toBe('<i>x</i> & y (+1)');
  });

  it('a whole-document template cannot nest: in a digest of several its text stands in, as one body', () => {
    const doc = m('A', 'one\n\nmore', '<!DOCTYPE html><html><head><style>p{}</style></head><body><p>one</p></body></html>');
    const d = digestOf([doc, m('B', 'two')]);
    expect(d.html).not.toMatch(/<!doctype|<html|<head|<body/i);
    expect(d.html).toContain('<h2>A</h2>\n<p>one</p>\n<p>more</p>');
    expect(d.html).toContain('<h2>B</h2>\n<p>two</p>');
    // Alone, it is that message, document and all.
    expect(digestOf([doc]).html).toBe(doc.html);
  });

  it('no messages is no digest: refused rather than sent empty', () => {
    expect(() => digestOf([])).toThrow(/at least one/);
  });
});
