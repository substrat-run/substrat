/**
 * Two fake customer websites, so the widget can be driven across a REAL origin
 * boundary rather than same-origin against its own API.
 *
 * That distinction is the whole reason this file exists. A widget served from the
 * same host it calls proves nothing about CORS, about the desk's embedding allowlist,
 * or about the browser refusing a page that is not on it. These pages are served from
 * their own ports, so every call the widget makes is genuinely cross-origin.
 *
 * Two sites, because the two desks differ in the one way the product is about:
 * Substrat's assistant answers customers, Kestrel's drafts for a human. Same script,
 * same API, different grant.
 */
import { createServer } from 'node:http';

export interface SiteSpec {
  readonly port: number;
  readonly brand: string;
  readonly tagline: string;
  readonly accent: string;
  readonly note: string;
  /** Set to sign in as a known customer — the middle rung of trust. */
  readonly user?: string;
  readonly signature?: string;
}

function page(site: SiteSpec, apiOrigin: string): string {
  const identity =
    site.user && site.signature
      ? `\n          data-user="${site.user}"\n          data-signature="${site.signature}"`
      : '';
  return `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${site.brand}</title>
<style>
  :root{color-scheme:light dark}
  body{margin:0;font:16px/1.6 ui-sans-serif,system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;
       background:#fbfbfd;color:#111827}
  @media (prefers-color-scheme:dark){body{background:#0b0f19;color:#e5e7eb}}
  header{padding:18px 32px;border-bottom:1px solid #e5e7eb33;display:flex;align-items:center;gap:12px}
  .logo{width:26px;height:26px;border-radius:7px;background:${site.accent}}
  main{max-width:720px;margin:0 auto;padding:88px 32px 160px}
  h1{font-size:44px;line-height:1.12;letter-spacing:-.022em;margin:0 0 18px}
  .lede{font-size:19px;opacity:.72;margin:0 0 40px}
  .note{border:1px solid #e5e7eb55;border-radius:12px;padding:16px 18px;font-size:14px;opacity:.8;
        background:#ffffff0a}
  code{font:13px ui-monospace,SFMono-Regular,Menlo,monospace;background:#8881;padding:2px 5px;border-radius:4px}
</style></head>
<body>
  <header><span class="logo"></span><strong>${site.brand}</strong></header>
  <main>
    <h1>${site.tagline}</h1>
    <p class="lede">This is a stand-in for a customer's marketing site. Everything here is
      scenery — the only real thing on the page is the chat bubble in the corner.</p>
    <div class="note">${site.note}</div>
  </main>
  <script src="${apiOrigin}/widget.js" data-api="${apiOrigin}"${identity}></script>
</body></html>`;
}

export function startDemoSites(sites: SiteSpec[], apiOrigin: string): void {
  for (const site of sites) {
    const html = page(site, apiOrigin);
    createServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(html);
    }).listen(site.port);
    process.stdout.write(`  ${site.brand} on http://localhost:${site.port}\n`);
  }
}
