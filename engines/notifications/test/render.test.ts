import { describe, expect, it } from 'vitest';
import { render } from '../src/render.js';

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
