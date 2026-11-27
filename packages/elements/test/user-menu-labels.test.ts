// @vitest-environment jsdom
/**
 * The user menu's words: every one replaceable, and layered on Web Awesome's translation
 * registry (the menu's own `labels`, then the registered language, then English). Its own file
 * because a registered translation is page-wide and would leak into the other suites.
 */
import { LocalizeController } from '@awesome.me/webawesome/dist/utilities/localize.js';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { Session } from '../src/session.js';
import type { SubUserMenu, UserMenuLabels } from '../src/user-menu.js';

let userMenu: typeof import('../src/user-menu.js');

beforeAll(async () => {
  userMenu = await import('../src/user-menu.js');
});

afterEach(() => {
  document.body.replaceChildren();
  document.documentElement.removeAttribute('lang');
});

const ADA: Session = { principal: 'p1', display: '«d:Ada»', email: '«d:ada»', team: '«d:team»' };

async function menuIn(parent: HTMLElement, props: Partial<SubUserMenu> = {}) {
  const menu = document.createElement('sub-user-menu') as SubUserMenu;
  Object.assign(menu, { sessionUrl: '', session: ADA, accountUrl: '/account', ...props });
  parent.append(menu);
  await menu.updateComplete;
  return menu;
}

/** What the menu says, in its text and the attributes that carry words. */
function spoken(menu: SubUserMenu): string {
  const out: string[] = [];
  const walker = document.createTreeWalker(menu.shadowRoot!, NodeFilter.SHOW_TEXT);
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    if (!node.parentElement?.closest('style')) out.push(node.textContent ?? '');
  }
  for (const el of menu.shadowRoot!.querySelectorAll('*')) {
    for (const attr of ['aria-label', 'aria-description', 'title', 'placeholder', 'label']) {
      const value = el.getAttribute(attr);
      if (value) out.push(value);
    }
  }
  return out.join(' ');
}

describe('<sub-user-menu> labels', () => {
  it('says nothing in English once every label is replaced, signed in or out', async () => {
    const labels = Object.fromEntries(
      Object.entries(userMenu.USER_MENU_LABELS).map(([key, value]) => [key, typeof value === 'function' ? () => `«${key}»` : `«${key}»`]),
    ) as unknown as UserMenuLabels;
    const said = [await menuIn(document.body, { labels }), await menuIn(document.body, { labels, session: null })].map(spoken).join(' ');

    expect(said.replace(/«[^»]*»/g, ' ').replace(/[^\p{L}]+/gu, ' ').trim()).toBe('');
    const seen = new Set([...said.matchAll(/«(\w+)»/g)].map(([, key]) => key));
    expect(Object.keys(userMenu.USER_MENU_LABELS).filter((key) => !seen.has(key))).toEqual([]);
  });

  it("registers its English in Web Awesome's registry, takes a registered language from the nearest lang, and hands it to Web Awesome", async () => {
    userMenu.registerUserMenuLabels('sv', { signOut: 'Logga ut', account: (name) => `Konto: ${name}` });
    const section = document.createElement('section');
    section.lang = 'sv-FI';
    document.body.append(section);
    const menu = await menuIn(section, { labels: { switchUser: 'Byt användare' } });

    const registry = new LocalizeController(menu);
    expect(registry.exists('sub-user-menu.signOut' as never, { lang: 'en', includeFallback: false })).toBe(true);

    const root = menu.shadowRoot!;
    expect(root.querySelector('[data-builtin="sign-out"]')!.textContent!.trim()).toBe('Logga ut');
    expect(root.querySelector('[data-builtin="switch-user"]')!.textContent!.trim()).toBe('Byt användare');
    expect(root.querySelector('.trigger')!.getAttribute('aria-label')).toBe('Konto: «d:Ada»');
    // A word Swedish does not register is English.
    expect(root.querySelector('[data-builtin="account"]')!.textContent!.trim()).toBe('Manage account');

    const langs = () => new Set([...root.querySelectorAll('*')].filter((el) => el.localName.startsWith('wa-')).map((el) => el.getAttribute('lang')));
    expect(langs()).toEqual(new Set(['sv-FI']));
    menu.lang = 'en';
    await menu.updateComplete;
    expect(langs()).toEqual(new Set(['en']));
    expect(root.querySelector('[data-builtin="sign-out"]')!.textContent!.trim()).toBe('Sign out');
  });
});
