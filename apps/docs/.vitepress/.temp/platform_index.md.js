import { ssrRenderAttrs } from "vue/server-renderer";
import { useSSRContext } from "vue";
import { _ as _export_sfc } from "./plugin-vue_export-helper.1tPrXgE0.js";
const __pageData = JSON.parse('{"title":"The platform surfaces","description":"","frontmatter":{},"headers":[],"relativePath":"platform/index.md","filePath":"platform/index.md","lastUpdated":1784804439000}');
const _sfc_main = { name: "platform/index.md" };
function _sfc_ssrRender(_ctx, _push, _parent, _attrs, $props, $setup, $data, $options) {
  _push(`<div${ssrRenderAttrs(_attrs)}><h1 id="the-platform-surfaces" tabindex="-1">The platform surfaces <a class="header-anchor" href="#the-platform-surfaces" aria-label="Permalink to &quot;The platform surfaces&quot;">​</a></h1><p>The <a href="/engines/">engines</a> and <a href="/verticals/">verticals</a> are what a tenant <em>runs</em>. This section is the machinery that runs <em>them</em> — the deployments and control surfaces that turn &quot;a vertical&quot; into &quot;a vertical serving a customer at a hostname.&quot; Four pieces, each its own deployment:</p><table tabindex="0"><thead><tr><th>Surface</th><th>Audience</th><th>Answers</th></tr></thead><tbody><tr><td><a href="/platform/control-plane.html">Control plane</a></td><td>the platform</td><td>the shared directory every vertical registers against — tenants, scopes, roles, entitlements, the admin log</td></tr><tr><td><a href="/platform/console.html">Console</a></td><td>Substrat operators</td><td><em>run the platform</em> — the whole fleet, every tenant, provisioning, the audit log</td></tr><tr><td><a href="/platform/router.html">Router</a></td><td>inbound traffic</td><td><code>hostname → (tenant, scope, surface)</code>, then dispatch — one worker in front of every vertical</td></tr><tr><td><a href="/platform/dashboard.html">Dashboard</a></td><td>a customer&#39;s admin</td><td><em>run my org</em> — self-service tenant + apps, seeing only their own tenant</td></tr></tbody></table><p>The split that matters most is <strong>Console vs Dashboard</strong>: same underlying platform, opposite audience and blast radius. The Console is the operator&#39;s back office (all tenants, staff SSO); the Dashboard is the customer&#39;s home (one tenant, customer sign-up). &quot;Console&quot; reads as a back-office tool; &quot;dashboard&quot; reads as the customer&#39;s home — the naming is deliberate, and neither takes the word &quot;portal&quot;, which the docs reserve for a <em>vertical&#39;s</em> own end-user surface.</p><p>These are <strong>private deployments</strong>, not published packages. They are documented here because they are how the platform actually runs — the same architecture the <a href="/concepts/platform.html">concepts</a> and <a href="/reference/adapter-cloudflare.html">reference</a> sections describe, made concrete.</p><div class="tip custom-block"><p class="custom-block-title">Where deploy fits</p><p>A vertical reaches these surfaces via <a href="/guide/deploying.html"><code>substrat push</code></a>: the push lands a pending version in the control plane, an operator admits it in the Console, and the Router serves it once a scope is bound.</p></div></div>`);
}
const _sfc_setup = _sfc_main.setup;
_sfc_main.setup = (props, ctx) => {
  const ssrContext = useSSRContext();
  (ssrContext.modules || (ssrContext.modules = /* @__PURE__ */ new Set())).add("platform/index.md");
  return _sfc_setup ? _sfc_setup(props, ctx) : void 0;
};
const index = /* @__PURE__ */ _export_sfc(_sfc_main, [["ssrRender", _sfc_ssrRender]]);
export {
  __pageData,
  index as default
};
