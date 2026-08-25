import { ssrRenderAttrs } from "vue/server-renderer";
import { useSSRContext } from "vue";
import { _ as _export_sfc } from "./plugin-vue_export-helper.1tPrXgE0.js";
const __pageData = JSON.parse('{"title":"Invites engine","description":"","frontmatter":{},"headers":[],"relativePath":"engines/invites/index.md","filePath":"engines/invites/index.md","lastUpdated":1784457052000}');
const _sfc_main = { name: "engines/invites/index.md" };
function _sfc_ssrRender(_ctx, _push, _parent, _attrs, $props, $setup, $data, $options) {
  _push(`<div${ssrRenderAttrs(_attrs)}><h1 id="invites-engine" tabindex="-1">Invites engine <a class="header-anchor" href="#invites-engine" aria-label="Permalink to &quot;Invites engine&quot;">​</a></h1><p><code>@substrat-run/engine-invites</code> — how a person joins an organization they are not already in.</p><p>The engine owns the state machine. It does <strong>not</strong> own the membership: membership is tenant-wide directory state, so accepting an invitation asks the platform to add the member and a privileged executor effects it. The engine&#39;s job ends at <em>&quot;this person said yes&quot;</em>.</p><h2 id="why-it-exists" tabindex="-1">Why it exists <a class="header-anchor" href="#why-it-exists" aria-label="Permalink to &quot;Why it exists&quot;">​</a></h2><p>Every multi-tenant product eventually needs to let a customer add their own colleagues, and every one of them builds the same three mistakes:</p><ul><li>a lookup that confirms whether an address is already registered,</li><li>an invitation that grants access before anyone accepts it,</li><li>an unbounded, never-expiring standing offer.</li></ul><p>Each is a small convenience and a permanent leak. This engine is the shape that avoids them, once, for every vertical.</p><h2 id="the-two-properties-that-carry-it" tabindex="-1">The two properties that carry it <a class="header-anchor" href="#the-two-properties-that-carry-it" aria-label="Permalink to &quot;The two properties that carry it&quot;">​</a></h2><p><strong>Non-enumerable.</strong> Identifiers are stored hashed and never returned — not in a list, not in an event, not in an error message. A non-member, a decline, and an already-invited person are indistinguishable to the sender. The invite surface can never answer <em>&quot;is this person on the platform?&quot;</em>.</p><p><strong>Accept-required.</strong> An invitation confers nothing until the recipient acts, and accepting re-hashes the identifier they present. A leaked invitation id is therefore not a bearer token for someone else&#39;s invitation.</p><h2 id="how-these-pages-are-organized" tabindex="-1">How these pages are organized <a class="header-anchor" href="#how-these-pages-are-organized" aria-label="Permalink to &quot;How these pages are organized&quot;">​</a></h2><ul><li><a href="/engines/invites/model.html">Domain model &amp; invariants</a> — the state machine, and what the hashing buys</li><li><a href="/engines/invites/surface.html">Operations &amp; permissions</a> — the four operations, and why one of them checks nothing</li><li><a href="/engines/invites/events.html">Events</a> — what it emits, including the membership request</li><li><a href="/engines/invites/composing.html">Composing &amp; extending</a> — calling it from a vertical</li></ul></div>`);
}
const _sfc_setup = _sfc_main.setup;
_sfc_main.setup = (props, ctx) => {
  const ssrContext = useSSRContext();
  (ssrContext.modules || (ssrContext.modules = /* @__PURE__ */ new Set())).add("engines/invites/index.md");
  return _sfc_setup ? _sfc_setup(props, ctx) : void 0;
};
const index = /* @__PURE__ */ _export_sfc(_sfc_main, [["ssrRender", _sfc_ssrRender]]);
export {
  __pageData,
  index as default
};
