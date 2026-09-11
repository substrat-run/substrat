import { resolve } from 'node:path';
import { defineConfig } from 'vitepress';
import { withMermaid } from 'vitepress-plugin-mermaid';
import { buildArtifacts, emitInto } from './llms.mjs';
import { bookArtifacts } from './book.mjs';
import { epubArtifacts } from './epub.mjs';
import { emitHeaders } from './headers.mjs';
import { changelogSidebar, guideSidebar } from './sidebar.mjs';

/**
 * The ticket0 support desk every page embeds — named once, because it is read
 * twice: the `<script>` tag below, and the CSP that has to allow it. A widget the
 * policy did not name would load and then fail silently.
 *
 * On by default and pointed at the live desk, so substrat.net carries the bubble on
 * every page: the whole dogfood is the widget on substrat.net answering out of
 * substrat.net's own `llms-full.txt`. `TICKET0_API=http://localhost:8874` aims a
 * local build at a local desk (`pnpm --filter @substrat-run/demo-ticket0 dev`), and
 * `TICKET0_WIDGET=0` builds without one. Off is the exception now, not on — this
 * array ships to production, and a person made that decision once, here.
 */
const WIDGET_API =
  process.env.TICKET0_WIDGET === '0'
    ? undefined
    : (process.env.TICKET0_API ?? 'https://ticket0.substrat.net');

export default withMermaid(defineConfig({
  title: 'Substrat',
  description:
    'The hard parts, hosted. A runtime-enforced substrate for building vertical B2B SaaS.',
  lastUpdated: true,

  /*
   * No `ignoreDeadLinks`, deliberately. `/book/read.html` is written in `buildEnd`
   * (book.mts) and used to be exempted here so a markdown link to it would build —
   * but building was never the problem: VitePress's SPA router intercepts a
   * same-origin link whose extension it does not recognise as a file (`.html` is one
   * of those), so the link routed client-side to a page the router has no chunk for
   * and rendered the 404. book/index.md points at it with a raw `<a target="_self">`
   * instead, which the router skips. Nothing checks a raw anchor, so the exemption
   * has no work left — and without it a markdown link to that route fails the build,
   * which is the right answer now that a markdown link is the bug.
   */

  /**
   * The ticket0 support widget, in every page's `<head>` (see `WIDGET_API`).
   *
   * A `<script>` in the head rather than a component in a layout slot: it is in the
   * built HTML, so the CSP guard in headers.mts sees the origin it has to allow, and
   * VitePress runs it once per real page load — the bubble then survives every
   * client-side navigation, with nothing to unmount and remount on the way.
   */
  head: WIDGET_API
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
    // The book's single-file editions (#1401): /book.txt and /book/read.html, the
    // same eleven chapters concatenated for printing, pandoc, or one-shot ingestion.
    // Emitted rather than checked in, so there is no second copy to drift — see book.mts.
    emitInto(siteConfig.outDir, bookArtifacts(siteConfig.srcDir));
    // And /book.epub — the same chapters packaged for a phone: a real EPUB 3 with a
    // cover, a table of contents and one file per chapter, so Apple Books and the rest
    // can remember where the reader got to. See epub.mts for the zip's own rules.
    emitInto(siteConfig.outDir, epubArtifacts(siteConfig.srcDir));
    // The `_headers` Cloudflare Pages serves the site with, including a CSP
    // whose script hashes are read back out of the HTML this build just wrote
    // (headers.mts explains why they cannot be written down). Emitted last: it
    // hashes the inline scripts on every page, and the twins above add none.
    // srcDir too: the signup forms name the desk they `fetch` as a `desk` attribute
    // (index.md, changelog/index.md), and that tag compiles away — the origin is
    // nowhere in the HTML this policy would otherwise be derived from.
    emitHeaders(siteConfig.outDir, siteConfig.srcDir, WIDGET_API);
  },

  themeConfig: {
    nav: [
      // First in the nav for the same reason it is first in the sidebar: it is the
      // only section with a reading order, and it is what a newcomer wants.
      { text: 'Book', link: '/book/', activeMatch: '/book/' },
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
      '/book/': guideSidebar(),
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
