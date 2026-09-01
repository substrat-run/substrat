import { resolve } from 'node:path';
import { defineConfig } from 'vitepress';
import { withMermaid } from 'vitepress-plugin-mermaid';
import { buildArtifacts, emitInto } from './llms.mjs';
import { emitHeaders } from './headers.mjs';
import { changelogSidebar, guideSidebar } from './sidebar.mjs';

/**
 * Where the opt-in ticket0 widget is served from — named once, because it is
 * read twice: the `<script>` tag below, and the CSP that has to allow it.
 * A widget the policy did not name would load and then fail silently.
 */
const WIDGET_API = process.env.TICKET0_API ?? 'http://localhost:8874';

export default withMermaid(defineConfig({
  title: 'Substrat',
  description:
    'The hard parts, hosted. A runtime-enforced substrate for building vertical B2B SaaS.',
  lastUpdated: true,

  /**
   * The ticket0 support widget — OPT-IN, and off unless asked for.
   *
   * `TICKET0_WIDGET=1 pnpm --filter @substrat-run/docs dev` embeds the demo desk's
   * chat bubble on the real documentation site, which is the whole dogfood: the widget
   * on substrat.net answering out of substrat.net's own `llms-full.txt`.
   *
   * Gated on the variable rather than checked in unconditionally because this array is
   * also what ships to production. A support widget on the live site is a decision for
   * a person to make deliberately, not a side effect of a demo landing.
   */
  head: process.env.TICKET0_WIDGET
    ? [['script', { src: `${WIDGET_API}/widget.js`, 'data-api': WIDGET_API, defer: '' }]]
    : [],

  // The package's own changelog is not a docs page. It was being built and
  // served at /CHANGELOG, where nothing linked to it and nothing indexed it.
  srcExclude: ['CHANGELOG.md'],

  vite: {
    // mermaid ships ESM that default-imports CJS deps (dayjs); without
    // pre-bundling, the browser throws and the whole app fails to mount.
    optimizeDeps: { include: ['mermaid', 'dayjs'] },
  },

  // The machine-readable surface (#751): llms.txt, llms-full.txt and a .md twin
  // of every page, written into the built site. It lives here rather than in a
  // standalone script so it reads the same sidebar the nav renders and the same
  // srcDir VitePress just built — there is no second list of pages to forget.
  // `pnpm lint:llms --check` runs the identical code and fails on a mismatch.
  buildEnd(siteConfig) {
    const repoRoot = resolve(siteConfig.srcDir, '../..');
    emitInto(siteConfig.outDir, buildArtifacts(siteConfig.srcDir, repoRoot));
    // The `_headers` Cloudflare Pages serves the site with, including a CSP
    // whose script hashes are read back out of the HTML this build just wrote
    // (headers.mts explains why they cannot be written down). Emitted last: it
    // hashes the inline scripts on every page, and the twins above add none.
    // srcDir too: a page can mount the widget itself (`<Ticket0Widget desk="…" />` in
    // guide/support.md), and that tag compiles away — the origin is nowhere in the HTML
    // this policy would otherwise be derived from.
    emitHeaders(
      siteConfig.outDir,
      siteConfig.srcDir,
      process.env.TICKET0_WIDGET ? WIDGET_API : undefined,
    );
  },

  themeConfig: {
    nav: [
      { text: 'Guide', link: '/guide/what-is-substrat', activeMatch: '/guide/' },
      { text: 'Concepts', link: '/concepts/tenancy', activeMatch: '/concepts/' },
      { text: 'Engines', link: '/engines/', activeMatch: '/engines/' },
      { text: 'Connectors', link: '/connectors/', activeMatch: '/connectors/' },
      { text: 'Verticals', link: '/verticals/', activeMatch: '/verticals/' },
      { text: 'Platform', link: '/platform/', activeMatch: '/platform/' },
      { text: 'Reference', link: '/reference/contracts', activeMatch: '/reference/' },
      // Last, and deliberately apart from the sections a reader takes in order: the
      // changelog is dated, not sequenced. Its sidebar is read from the directory
      // (sidebar.mts), so Monday's entry reaches the nav with nothing else to remember.
      { text: 'Changelog', link: '/changelog/', activeMatch: '/changelog/' },
    ],

    sidebar: {
      '/guide/': guideSidebar(),
      '/concepts/': guideSidebar(),
      '/engines/': guideSidebar(),
      '/connectors/': guideSidebar(),
      '/verticals/': guideSidebar(),
      '/platform/': guideSidebar(),
      '/reference/': guideSidebar(),
      '/changelog/': changelogSidebar(),
    },

    outline: { level: [2, 3] },

    socialLinks: [{ icon: 'github', link: 'https://github.com/substrat-run/substrat' }],

    search: {
      provider: 'local',
    },

    footer: {
      message: 'The hard parts, hosted.',
    },
  },
}));
