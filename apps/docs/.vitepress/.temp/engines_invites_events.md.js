import { ssrRenderAttrs, ssrRenderStyle } from "vue/server-renderer";
import { useSSRContext } from "vue";
import { _ as _export_sfc } from "./plugin-vue_export-helper.1tPrXgE0.js";
const __pageData = JSON.parse('{"title":"Invites: events","description":"","frontmatter":{},"headers":[],"relativePath":"engines/invites/events.md","filePath":"engines/invites/events.md","lastUpdated":1784457886000}');
const _sfc_main = { name: "engines/invites/events.md" };
function _sfc_ssrRender(_ctx, _push, _parent, _attrs, $props, $setup, $data, $options) {
  _push(`<div${ssrRenderAttrs(_attrs)}><h1 id="invites-events" tabindex="-1">Invites: events <a class="header-anchor" href="#invites-events" aria-label="Permalink to &quot;Invites: events&quot;">​</a></h1><table tabindex="0"><thead><tr><th>Type</th><th>When</th></tr></thead><tbody><tr><td><code>invites.sent</code></td><td>a new invitation is recorded</td></tr><tr><td><code>invites.accepted</code></td><td>the recipient accepts</td></tr><tr><td><code>invites.revoked</code></td><td>an unaccepted invitation is withdrawn</td></tr><tr><td><code>member.add-requested</code></td><td>on acceptance — the membership request</td></tr></tbody></table><p>All payloads are <code>piiClass: &#39;none&#39;</code> and <strong>contain no identifier</strong>. The event spine outlives the row it describes, so an address leaked here is leaked for as long as history is kept.</p><p><code>invites.accepted</code> carries <code>{ invitationId, orgId, roleKey, principal }</code>. The <code>principal</code> is who accepted — a ULID, so it names nobody outside the platform, and a vertical creating its own record for that person needs it. Without it the event would describe an acceptance by no one, which is precisely what the first vertical to consume it discovered.</p><h2 id="member-add-requested-is-the-interesting-one" tabindex="-1"><code>member.add-requested</code> is the interesting one <a class="header-anchor" href="#member-add-requested-is-the-interesting-one" aria-label="Permalink to &quot;\`member.add-requested\` is the interesting one&quot;">​</a></h2><p>The engine cannot write a membership tuple. Membership is tenant-wide directory state, outside this scope&#39;s transaction — so the engine <em>asks</em>, and a privileged <a href="/concepts/events.html#the-connector-seam">executor</a> effects it.</p><div class="language-ts vp-adaptive-theme"><button title="Copy Code" class="copy"></button><span class="lang">ts</span><pre class="shiki shiki-themes github-light github-dark vp-code" tabindex="0"><code><span class="line"><span style="${ssrRenderStyle({ "--shiki-light": "#24292E", "--shiki-dark": "#E1E4E8" })}">{</span></span>
<span class="line"><span style="${ssrRenderStyle({ "--shiki-light": "#24292E", "--shiki-dark": "#E1E4E8" })}">  principal,      </span><span style="${ssrRenderStyle({ "--shiki-light": "#6A737D", "--shiki-dark": "#6A737D" })}">// who accepted</span></span>
<span class="line"><span style="${ssrRenderStyle({ "--shiki-light": "#24292E", "--shiki-dark": "#E1E4E8" })}">  orgId,          </span><span style="${ssrRenderStyle({ "--shiki-light": "#6A737D", "--shiki-dark": "#6A737D" })}">// which organization</span></span>
<span class="line"><span style="${ssrRenderStyle({ "--shiki-light": "#24292E", "--shiki-dark": "#E1E4E8" })}">  tenantId,</span></span>
<span class="line"><span style="${ssrRenderStyle({ "--shiki-light": "#24292E", "--shiki-dark": "#E1E4E8" })}">  roleKey,        </span><span style="${ssrRenderStyle({ "--shiki-light": "#6A737D", "--shiki-dark": "#6A737D" })}">// what the invitation offered</span></span>
<span class="line"><span style="${ssrRenderStyle({ "--shiki-light": "#24292E", "--shiki-dark": "#E1E4E8" })}">  invitationId,   </span><span style="${ssrRenderStyle({ "--shiki-light": "#6A737D", "--shiki-dark": "#6A737D" })}">// provenance</span></span>
<span class="line"><span style="${ssrRenderStyle({ "--shiki-light": "#24292E", "--shiki-dark": "#E1E4E8" })}">}</span></span></code></pre></div><p>The payload is deliberately <strong>fat</strong>: the executor must never need a cross-module read to act on it.</p><p>This is also why acceptance is atomic in the way that matters. <code>ctx.emit</code> commits with the engine&#39;s own write, so an accept that fails leaves no event and therefore no membership. An in-scope cross-database write could not offer that — it could land in the directory and then be orphaned by the scope&#39;s rollback.</p></div>`);
}
const _sfc_setup = _sfc_main.setup;
_sfc_main.setup = (props, ctx) => {
  const ssrContext = useSSRContext();
  (ssrContext.modules || (ssrContext.modules = /* @__PURE__ */ new Set())).add("engines/invites/events.md");
  return _sfc_setup ? _sfc_setup(props, ctx) : void 0;
};
const events = /* @__PURE__ */ _export_sfc(_sfc_main, [["ssrRender", _sfc_ssrRender]]);
export {
  __pageData,
  events as default
};
