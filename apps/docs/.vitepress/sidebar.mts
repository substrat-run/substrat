/**
 * The site's table of contents, in one place.
 *
 * This lives outside `config.mts` because it has a second reader: the llms.txt
 * emitter (#751) walks this same structure to build the machine-readable index.
 * A page added to the sidebar is therefore in `llms.txt` by construction, and a
 * page that is *not* in the sidebar is not a page — which is what
 * `--check` asserts, so the two can never disagree about what the docs contain.
 */

/**
 * The one page an agent should read before any other — the always-on rules, emitted
 * from `create-substrat`'s AGENTS.md by `pnpm lint:agent-rules`. Named here rather
 * than written twice, because `llms.txt` promotes it above its own index and a
 * silently-renamed page would leave that promotion pointing at a 404.
 */
export const START_HERE = '/guide/agent-rules';

/** The five pages every engine gets, in the same order, so a reader who learns one learns all. */
export function engineSidebar(slug: string, text: string) {
  return {
    text,
    collapsed: true,
    items: [
      { text: 'Overview', link: `/engines/${slug}/` },
      { text: 'Domain model & invariants', link: `/engines/${slug}/model` },
      { text: 'Operations & permissions', link: `/engines/${slug}/surface` },
      { text: 'Events', link: `/engines/${slug}/events` },
      { text: 'Composing & extending', link: `/engines/${slug}/composing` },
    ],
  };
}

export function guideSidebar() {
  return [
    {
      text: 'Introduction',
      items: [
        { text: 'What is Substrat?', link: '/guide/what-is-substrat' },
        { text: 'Why runtime enforcement?', link: '/guide/why-substrat' },
        { text: 'How Substrat compares', link: '/guide/comparisons' },
        { text: "What Substrat doesn't have (yet)", link: '/guide/what-substrat-lacks' },
        { text: 'FAQ', link: '/guide/faq' },
        { text: 'Architecture', link: '/guide/architecture' },
        { text: 'Getting started', link: '/guide/getting-started' },
        { text: 'Agent rules', link: START_HERE },
        { text: 'The Claude Code plugin', link: '/guide/agent-plugin' },
        { text: 'Running locally', link: '/guide/running-locally' },
        { text: 'Deploying a vertical', link: '/guide/deploying' },
        { text: 'Environments & previews', link: '/guide/environments-and-previews' },
        { text: 'Building for AI agents', link: '/guide/ai-agents' },
      ],
    },
    {
      text: 'Concepts',
      items: [
        { text: 'Tenants & scopes', link: '/concepts/tenancy' },
        { text: 'The platform layer', link: '/concepts/platform' },
        { text: 'Operations & the scope host', link: '/concepts/scope-host' },
        { text: 'Permissions', link: '/concepts/permissions' },
        { text: 'Authentication & identity', link: '/concepts/identity' },
        { text: 'Events & audit', link: '/concepts/events' },
        { text: 'Snapshots & test copies', link: '/concepts/snapshots' },
        { text: 'The deploy model', link: '/concepts/deploying' },
        { text: 'Reads & scaling', link: '/concepts/reads' },
        { text: 'The model', link: '/concepts/model' },
        { text: 'Lifecycles', link: '/concepts/lifecycle' },
        { text: 'Modules & the manifest', link: '/concepts/modules' },
        { text: 'What a good API looks like', link: '/concepts/api-design' },
        { text: 'Money', link: '/concepts/money' },
      ],
    },
    {
      text: 'Engines',
      items: [
        { text: 'What is an engine?', link: '/engines/' },
        engineSidebar('workorder', 'Work orders'),
        engineSidebar('booking', 'Bookings'),
        engineSidebar('invoicing', 'Invoicing'),
        engineSidebar('protocol', 'Protocols'),
        engineSidebar('invites', 'Invites'),
        engineSidebar('absence', 'Absence'),
        engineSidebar('metering', 'Metering'),
      ],
    },
    {
      text: 'Connectors',
      items: [
        { text: 'What is a connector?', link: '/connectors/' },
        { text: 'Scrive (e-signing)', link: '/connectors/scrive' },
      ],
    },
    {
      text: 'Verticals',
      items: [
        { text: 'What is a vertical?', link: '/verticals/' },
        { text: 'Callout (field service)', link: '/verticals/callout' },
        { text: 'Handlebar (bike workshop)', link: '/verticals/handlebar' },
        { text: 'Kallkälla (coffee shop)', link: '/verticals/shop' },
        { text: 'Meridian (HR)', link: '/verticals/meridian' },
        { text: 'RallyPoint (padel club)', link: '/verticals/rallypoint' },
        { text: 'Manyfold (headless CMS)', link: '/verticals/manyfold' },
      ],
    },
    {
      text: 'Platform',
      items: [
        { text: 'The platform surfaces', link: '/platform/' },
        { text: 'Control plane', link: '/platform/control-plane' },
        { text: 'Console', link: '/platform/console' },
        { text: 'Router', link: '/platform/router' },
        { text: 'Dashboard', link: '/platform/dashboard' },
      ],
    },
    {
      text: 'Package reference',
      items: [
        { text: '@substrat-run/contracts', link: '/reference/contracts' },
        { text: '@substrat-run/model-emit', link: '/reference/model-emit' },
        { text: '@substrat-run/kernel', link: '/reference/kernel' },
        { text: '@substrat-run/adapter-sqlite', link: '/reference/adapter-sqlite' },
        { text: '@substrat-run/adapter-cloudflare', link: '/reference/adapter-cloudflare' },
        { text: '@substrat-run/vertical-host', link: '/reference/vertical-host' },
        { text: '@substrat-run/vertical-auth', link: '/reference/vertical-auth' },
        { text: '@substrat-run/control-plane-api', link: '/reference/control-plane-api' },
        { text: '@substrat-run/contract-tests', link: '/reference/contract-tests' },
        { text: '@substrat-run/boundary-lint', link: '/reference/boundary-lint' },
        { text: '@substrat-run/oidc-rp', link: '/reference/oidc-rp' },
        { text: '@substrat-run/psl', link: '/reference/psl' },
        { text: '@substrat-run/cli', link: '/reference/cli' },
        { text: 'create-substrat', link: '/reference/create-substrat' },
      ],
    },
  ];
}

/** One page in the flattened table of contents. */
export interface IndexedPage {
  /** Site-absolute route, no extension: `/concepts/model`, `/engines/workorder/`. */
  link: string;
  /** The sidebar's own words for this page. */
  text: string;
  /** The engine group a nested page sits under, if any: `Work orders`. */
  group?: string;
  /** Source file relative to the docs root: `concepts/model.md`. */
  file: string;
}

export interface IndexedSection {
  text: string;
  pages: IndexedPage[];
}

/** A link's source file. `/engines/workorder/` → `engines/workorder/index.md`. */
export function fileForLink(link: string): string {
  const path = link.replace(/^\//, '');
  return path === '' || path.endsWith('/') ? `${path}index.md` : `${path}.md`;
}

/**
 * The sidebar, flattened to sections of pages. Engine sub-groups collapse into
 * their parent section carrying `group`, because "Work orders › Events" is the
 * name an agent needs — five pages all titled "Events" are not an index.
 */
export function tableOfContents(): IndexedSection[] {
  return guideSidebar().map((section) => {
    const pages: IndexedPage[] = [];
    for (const item of section.items) {
      if ('link' in item && item.link) {
        pages.push({ link: item.link, text: item.text, file: fileForLink(item.link) });
        continue;
      }
      for (const child of (item as { items: { text: string; link: string }[] }).items) {
        pages.push({
          link: child.link,
          text: child.text,
          group: item.text,
          file: fileForLink(child.link),
        });
      }
    }
    return { text: section.text, pages };
  });
}
