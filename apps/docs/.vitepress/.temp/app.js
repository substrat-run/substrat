import { ssrRenderAttrs, ssrRenderSlot, ssrInterpolate, ssrRenderAttr, ssrRenderList, ssrRenderComponent, ssrRenderVNode, ssrRenderClass, renderToString } from "vue/server-renderer";
import { getCurrentInstance, hasInjectionContext, inject, watch, getCurrentScope, onScopeDispose, onMounted, nextTick, isRef, toValue, toRef as toRef$1, readonly, customRef, ref, shallowRef, watchEffect, computed, unref, reactive, onUnmounted, markRaw, defineComponent, h, toRaw, mergeProps, useSSRContext, watchPostEffect, onUpdated, resolveComponent, createVNode, resolveDynamicComponent, withCtx, renderSlot, createTextVNode, toDisplayString, openBlock, createBlock, createCommentVNode, Fragment, renderList, defineAsyncComponent, provide, toHandlers, withKeys, onBeforeUnmount, useSlots, createSSRApp } from "vue";
import mermaid from "mermaid";
import { _ as _export_sfc } from "./plugin-vue_export-helper.1tPrXgE0.js";
const init = async (externalDiagrams) => {
  try {
    if (mermaid.registerExternalDiagrams)
      await mermaid.registerExternalDiagrams(externalDiagrams);
  } catch (e) {
    console.error(e);
  }
};
const render$1 = async (id, code, config) => {
  mermaid.initialize(config);
  const { svg } = await mermaid.render(id, code);
  return svg;
};
function deserializeFunctions(r) {
  return Array.isArray(r) ? r.map(deserializeFunctions) : typeof r == "object" && r !== null ? Object.keys(r).reduce((t, n) => (t[n] = deserializeFunctions(r[n]), t), {}) : typeof r == "string" && r.startsWith("_vp-fn_") ? new Function(`return ${r.slice(7)}`)() : r;
}
const siteData = deserializeFunctions(JSON.parse(`{"lang":"en-US","dir":"ltr","title":"Substrat","description":"The hard parts, hosted. A runtime-enforced substrate for building vertical B2B SaaS.","base":"/","head":[],"router":{"prefetchLinks":true},"appearance":true,"themeConfig":{"nav":[{"text":"Guide","link":"/guide/what-is-substrat","activeMatch":"/guide/"},{"text":"Concepts","link":"/concepts/tenancy","activeMatch":"/concepts/"},{"text":"Engines","link":"/engines/","activeMatch":"/engines/"},{"text":"Connectors","link":"/connectors/","activeMatch":"/connectors/"},{"text":"Verticals","link":"/verticals/","activeMatch":"/verticals/"},{"text":"Platform","link":"/platform/","activeMatch":"/platform/"},{"text":"Reference","link":"/reference/contracts","activeMatch":"/reference/"},{"text":"Changelog","link":"/changelog/","activeMatch":"/changelog/"}],"sidebar":{"/guide/":[{"text":"Introduction","items":[{"text":"What is Substrat?","link":"/guide/what-is-substrat"},{"text":"Why runtime enforcement?","link":"/guide/why-substrat"},{"text":"How Substrat compares","link":"/guide/comparisons"},{"text":"What Substrat doesn't have (yet)","link":"/guide/what-substrat-lacks"},{"text":"FAQ","link":"/guide/faq"},{"text":"Architecture","link":"/guide/architecture"},{"text":"Getting started","link":"/guide/getting-started"},{"text":"Agent rules","link":"/guide/agent-rules"},{"text":"The Claude Code plugin","link":"/guide/agent-plugin"},{"text":"Running locally","link":"/guide/running-locally"},{"text":"Deploying a vertical","link":"/guide/deploying"},{"text":"Environments & previews","link":"/guide/environments-and-previews"},{"text":"Building for AI agents","link":"/guide/ai-agents"},{"text":"Where AI mistakes stop","link":"/guide/ai-guardrails"}]},{"text":"Concepts","items":[{"text":"Tenants & scopes","link":"/concepts/tenancy"},{"text":"The platform layer","link":"/concepts/platform"},{"text":"Operations & the scope host","link":"/concepts/scope-host"},{"text":"Permissions","link":"/concepts/permissions"},{"text":"Authentication & identity","link":"/concepts/identity"},{"text":"Events & audit","link":"/concepts/events"},{"text":"Snapshots & test copies","link":"/concepts/snapshots"},{"text":"The deploy model","link":"/concepts/deploying"},{"text":"Reads & scaling","link":"/concepts/reads"},{"text":"The model","link":"/concepts/model"},{"text":"Lifecycles","link":"/concepts/lifecycle"},{"text":"Modules & the manifest","link":"/concepts/modules"},{"text":"What a good API looks like","link":"/concepts/api-design"},{"text":"Money","link":"/concepts/money"}]},{"text":"Engines","items":[{"text":"What is an engine?","link":"/engines/"},{"text":"Work orders","collapsed":true,"items":[{"text":"Overview","link":"/engines/workorder/"},{"text":"Domain model & invariants","link":"/engines/workorder/model"},{"text":"Operations & permissions","link":"/engines/workorder/surface"},{"text":"Events","link":"/engines/workorder/events"},{"text":"Composing & extending","link":"/engines/workorder/composing"}]},{"text":"Bookings","collapsed":true,"items":[{"text":"Overview","link":"/engines/booking/"},{"text":"Domain model & invariants","link":"/engines/booking/model"},{"text":"Operations & permissions","link":"/engines/booking/surface"},{"text":"Events","link":"/engines/booking/events"},{"text":"Composing & extending","link":"/engines/booking/composing"}]},{"text":"Invoicing","collapsed":true,"items":[{"text":"Overview","link":"/engines/invoicing/"},{"text":"Domain model & invariants","link":"/engines/invoicing/model"},{"text":"Operations & permissions","link":"/engines/invoicing/surface"},{"text":"Events","link":"/engines/invoicing/events"},{"text":"Composing & extending","link":"/engines/invoicing/composing"}]},{"text":"Protocols","collapsed":true,"items":[{"text":"Overview","link":"/engines/protocol/"},{"text":"Domain model & invariants","link":"/engines/protocol/model"},{"text":"Operations & permissions","link":"/engines/protocol/surface"},{"text":"Events","link":"/engines/protocol/events"},{"text":"Composing & extending","link":"/engines/protocol/composing"}]},{"text":"Invites","collapsed":true,"items":[{"text":"Overview","link":"/engines/invites/"},{"text":"Domain model & invariants","link":"/engines/invites/model"},{"text":"Operations & permissions","link":"/engines/invites/surface"},{"text":"Events","link":"/engines/invites/events"},{"text":"Composing & extending","link":"/engines/invites/composing"}]},{"text":"Absence","collapsed":true,"items":[{"text":"Overview","link":"/engines/absence/"},{"text":"Domain model & invariants","link":"/engines/absence/model"},{"text":"Operations & permissions","link":"/engines/absence/surface"},{"text":"Events","link":"/engines/absence/events"},{"text":"Composing & extending","link":"/engines/absence/composing"}]},{"text":"Metering","collapsed":true,"items":[{"text":"Overview","link":"/engines/metering/"},{"text":"Domain model & invariants","link":"/engines/metering/model"},{"text":"Operations & permissions","link":"/engines/metering/surface"},{"text":"Events","link":"/engines/metering/events"},{"text":"Composing & extending","link":"/engines/metering/composing"}]}]},{"text":"Connectors","items":[{"text":"What is a connector?","link":"/connectors/"},{"text":"Scrive (e-signing)","link":"/connectors/scrive"}]},{"text":"Verticals","items":[{"text":"What is a vertical?","link":"/verticals/"},{"text":"Callout (field service)","link":"/verticals/callout"},{"text":"Handlebar (bike workshop)","link":"/verticals/handlebar"},{"text":"Kallkälla (coffee shop)","link":"/verticals/shop"},{"text":"Meridian (HR)","link":"/verticals/meridian"},{"text":"RallyPoint (padel club)","link":"/verticals/rallypoint"},{"text":"Manyfold (headless CMS)","link":"/verticals/manyfold"}]},{"text":"Platform","items":[{"text":"The platform surfaces","link":"/platform/"},{"text":"Control plane","link":"/platform/control-plane"},{"text":"Console","link":"/platform/console"},{"text":"Router","link":"/platform/router"},{"text":"Dashboard","link":"/platform/dashboard"}]},{"text":"Package reference","items":[{"text":"@substrat-run/contracts","link":"/reference/contracts"},{"text":"@substrat-run/model-emit","link":"/reference/model-emit"},{"text":"@substrat-run/kernel","link":"/reference/kernel"},{"text":"@substrat-run/adapter-sqlite","link":"/reference/adapter-sqlite"},{"text":"@substrat-run/adapter-cloudflare","link":"/reference/adapter-cloudflare"},{"text":"@substrat-run/vertical-host","link":"/reference/vertical-host"},{"text":"@substrat-run/vertical-auth","link":"/reference/vertical-auth"},{"text":"@substrat-run/control-plane-api","link":"/reference/control-plane-api"},{"text":"@substrat-run/contract-tests","link":"/reference/contract-tests"},{"text":"@substrat-run/boundary-lint","link":"/reference/boundary-lint"},{"text":"@substrat-run/oidc-rp","link":"/reference/oidc-rp"},{"text":"@substrat-run/dev-issuer","link":"/reference/dev-issuer"},{"text":"@substrat-run/psl","link":"/reference/psl"},{"text":"@substrat-run/cli","link":"/reference/cli"},{"text":"create-substrat","link":"/reference/create-substrat"}]}],"/concepts/":[{"text":"Introduction","items":[{"text":"What is Substrat?","link":"/guide/what-is-substrat"},{"text":"Why runtime enforcement?","link":"/guide/why-substrat"},{"text":"How Substrat compares","link":"/guide/comparisons"},{"text":"What Substrat doesn't have (yet)","link":"/guide/what-substrat-lacks"},{"text":"FAQ","link":"/guide/faq"},{"text":"Architecture","link":"/guide/architecture"},{"text":"Getting started","link":"/guide/getting-started"},{"text":"Agent rules","link":"/guide/agent-rules"},{"text":"The Claude Code plugin","link":"/guide/agent-plugin"},{"text":"Running locally","link":"/guide/running-locally"},{"text":"Deploying a vertical","link":"/guide/deploying"},{"text":"Environments & previews","link":"/guide/environments-and-previews"},{"text":"Building for AI agents","link":"/guide/ai-agents"},{"text":"Where AI mistakes stop","link":"/guide/ai-guardrails"}]},{"text":"Concepts","items":[{"text":"Tenants & scopes","link":"/concepts/tenancy"},{"text":"The platform layer","link":"/concepts/platform"},{"text":"Operations & the scope host","link":"/concepts/scope-host"},{"text":"Permissions","link":"/concepts/permissions"},{"text":"Authentication & identity","link":"/concepts/identity"},{"text":"Events & audit","link":"/concepts/events"},{"text":"Snapshots & test copies","link":"/concepts/snapshots"},{"text":"The deploy model","link":"/concepts/deploying"},{"text":"Reads & scaling","link":"/concepts/reads"},{"text":"The model","link":"/concepts/model"},{"text":"Lifecycles","link":"/concepts/lifecycle"},{"text":"Modules & the manifest","link":"/concepts/modules"},{"text":"What a good API looks like","link":"/concepts/api-design"},{"text":"Money","link":"/concepts/money"}]},{"text":"Engines","items":[{"text":"What is an engine?","link":"/engines/"},{"text":"Work orders","collapsed":true,"items":[{"text":"Overview","link":"/engines/workorder/"},{"text":"Domain model & invariants","link":"/engines/workorder/model"},{"text":"Operations & permissions","link":"/engines/workorder/surface"},{"text":"Events","link":"/engines/workorder/events"},{"text":"Composing & extending","link":"/engines/workorder/composing"}]},{"text":"Bookings","collapsed":true,"items":[{"text":"Overview","link":"/engines/booking/"},{"text":"Domain model & invariants","link":"/engines/booking/model"},{"text":"Operations & permissions","link":"/engines/booking/surface"},{"text":"Events","link":"/engines/booking/events"},{"text":"Composing & extending","link":"/engines/booking/composing"}]},{"text":"Invoicing","collapsed":true,"items":[{"text":"Overview","link":"/engines/invoicing/"},{"text":"Domain model & invariants","link":"/engines/invoicing/model"},{"text":"Operations & permissions","link":"/engines/invoicing/surface"},{"text":"Events","link":"/engines/invoicing/events"},{"text":"Composing & extending","link":"/engines/invoicing/composing"}]},{"text":"Protocols","collapsed":true,"items":[{"text":"Overview","link":"/engines/protocol/"},{"text":"Domain model & invariants","link":"/engines/protocol/model"},{"text":"Operations & permissions","link":"/engines/protocol/surface"},{"text":"Events","link":"/engines/protocol/events"},{"text":"Composing & extending","link":"/engines/protocol/composing"}]},{"text":"Invites","collapsed":true,"items":[{"text":"Overview","link":"/engines/invites/"},{"text":"Domain model & invariants","link":"/engines/invites/model"},{"text":"Operations & permissions","link":"/engines/invites/surface"},{"text":"Events","link":"/engines/invites/events"},{"text":"Composing & extending","link":"/engines/invites/composing"}]},{"text":"Absence","collapsed":true,"items":[{"text":"Overview","link":"/engines/absence/"},{"text":"Domain model & invariants","link":"/engines/absence/model"},{"text":"Operations & permissions","link":"/engines/absence/surface"},{"text":"Events","link":"/engines/absence/events"},{"text":"Composing & extending","link":"/engines/absence/composing"}]},{"text":"Metering","collapsed":true,"items":[{"text":"Overview","link":"/engines/metering/"},{"text":"Domain model & invariants","link":"/engines/metering/model"},{"text":"Operations & permissions","link":"/engines/metering/surface"},{"text":"Events","link":"/engines/metering/events"},{"text":"Composing & extending","link":"/engines/metering/composing"}]}]},{"text":"Connectors","items":[{"text":"What is a connector?","link":"/connectors/"},{"text":"Scrive (e-signing)","link":"/connectors/scrive"}]},{"text":"Verticals","items":[{"text":"What is a vertical?","link":"/verticals/"},{"text":"Callout (field service)","link":"/verticals/callout"},{"text":"Handlebar (bike workshop)","link":"/verticals/handlebar"},{"text":"Kallkälla (coffee shop)","link":"/verticals/shop"},{"text":"Meridian (HR)","link":"/verticals/meridian"},{"text":"RallyPoint (padel club)","link":"/verticals/rallypoint"},{"text":"Manyfold (headless CMS)","link":"/verticals/manyfold"}]},{"text":"Platform","items":[{"text":"The platform surfaces","link":"/platform/"},{"text":"Control plane","link":"/platform/control-plane"},{"text":"Console","link":"/platform/console"},{"text":"Router","link":"/platform/router"},{"text":"Dashboard","link":"/platform/dashboard"}]},{"text":"Package reference","items":[{"text":"@substrat-run/contracts","link":"/reference/contracts"},{"text":"@substrat-run/model-emit","link":"/reference/model-emit"},{"text":"@substrat-run/kernel","link":"/reference/kernel"},{"text":"@substrat-run/adapter-sqlite","link":"/reference/adapter-sqlite"},{"text":"@substrat-run/adapter-cloudflare","link":"/reference/adapter-cloudflare"},{"text":"@substrat-run/vertical-host","link":"/reference/vertical-host"},{"text":"@substrat-run/vertical-auth","link":"/reference/vertical-auth"},{"text":"@substrat-run/control-plane-api","link":"/reference/control-plane-api"},{"text":"@substrat-run/contract-tests","link":"/reference/contract-tests"},{"text":"@substrat-run/boundary-lint","link":"/reference/boundary-lint"},{"text":"@substrat-run/oidc-rp","link":"/reference/oidc-rp"},{"text":"@substrat-run/dev-issuer","link":"/reference/dev-issuer"},{"text":"@substrat-run/psl","link":"/reference/psl"},{"text":"@substrat-run/cli","link":"/reference/cli"},{"text":"create-substrat","link":"/reference/create-substrat"}]}],"/engines/":[{"text":"Introduction","items":[{"text":"What is Substrat?","link":"/guide/what-is-substrat"},{"text":"Why runtime enforcement?","link":"/guide/why-substrat"},{"text":"How Substrat compares","link":"/guide/comparisons"},{"text":"What Substrat doesn't have (yet)","link":"/guide/what-substrat-lacks"},{"text":"FAQ","link":"/guide/faq"},{"text":"Architecture","link":"/guide/architecture"},{"text":"Getting started","link":"/guide/getting-started"},{"text":"Agent rules","link":"/guide/agent-rules"},{"text":"The Claude Code plugin","link":"/guide/agent-plugin"},{"text":"Running locally","link":"/guide/running-locally"},{"text":"Deploying a vertical","link":"/guide/deploying"},{"text":"Environments & previews","link":"/guide/environments-and-previews"},{"text":"Building for AI agents","link":"/guide/ai-agents"},{"text":"Where AI mistakes stop","link":"/guide/ai-guardrails"}]},{"text":"Concepts","items":[{"text":"Tenants & scopes","link":"/concepts/tenancy"},{"text":"The platform layer","link":"/concepts/platform"},{"text":"Operations & the scope host","link":"/concepts/scope-host"},{"text":"Permissions","link":"/concepts/permissions"},{"text":"Authentication & identity","link":"/concepts/identity"},{"text":"Events & audit","link":"/concepts/events"},{"text":"Snapshots & test copies","link":"/concepts/snapshots"},{"text":"The deploy model","link":"/concepts/deploying"},{"text":"Reads & scaling","link":"/concepts/reads"},{"text":"The model","link":"/concepts/model"},{"text":"Lifecycles","link":"/concepts/lifecycle"},{"text":"Modules & the manifest","link":"/concepts/modules"},{"text":"What a good API looks like","link":"/concepts/api-design"},{"text":"Money","link":"/concepts/money"}]},{"text":"Engines","items":[{"text":"What is an engine?","link":"/engines/"},{"text":"Work orders","collapsed":true,"items":[{"text":"Overview","link":"/engines/workorder/"},{"text":"Domain model & invariants","link":"/engines/workorder/model"},{"text":"Operations & permissions","link":"/engines/workorder/surface"},{"text":"Events","link":"/engines/workorder/events"},{"text":"Composing & extending","link":"/engines/workorder/composing"}]},{"text":"Bookings","collapsed":true,"items":[{"text":"Overview","link":"/engines/booking/"},{"text":"Domain model & invariants","link":"/engines/booking/model"},{"text":"Operations & permissions","link":"/engines/booking/surface"},{"text":"Events","link":"/engines/booking/events"},{"text":"Composing & extending","link":"/engines/booking/composing"}]},{"text":"Invoicing","collapsed":true,"items":[{"text":"Overview","link":"/engines/invoicing/"},{"text":"Domain model & invariants","link":"/engines/invoicing/model"},{"text":"Operations & permissions","link":"/engines/invoicing/surface"},{"text":"Events","link":"/engines/invoicing/events"},{"text":"Composing & extending","link":"/engines/invoicing/composing"}]},{"text":"Protocols","collapsed":true,"items":[{"text":"Overview","link":"/engines/protocol/"},{"text":"Domain model & invariants","link":"/engines/protocol/model"},{"text":"Operations & permissions","link":"/engines/protocol/surface"},{"text":"Events","link":"/engines/protocol/events"},{"text":"Composing & extending","link":"/engines/protocol/composing"}]},{"text":"Invites","collapsed":true,"items":[{"text":"Overview","link":"/engines/invites/"},{"text":"Domain model & invariants","link":"/engines/invites/model"},{"text":"Operations & permissions","link":"/engines/invites/surface"},{"text":"Events","link":"/engines/invites/events"},{"text":"Composing & extending","link":"/engines/invites/composing"}]},{"text":"Absence","collapsed":true,"items":[{"text":"Overview","link":"/engines/absence/"},{"text":"Domain model & invariants","link":"/engines/absence/model"},{"text":"Operations & permissions","link":"/engines/absence/surface"},{"text":"Events","link":"/engines/absence/events"},{"text":"Composing & extending","link":"/engines/absence/composing"}]},{"text":"Metering","collapsed":true,"items":[{"text":"Overview","link":"/engines/metering/"},{"text":"Domain model & invariants","link":"/engines/metering/model"},{"text":"Operations & permissions","link":"/engines/metering/surface"},{"text":"Events","link":"/engines/metering/events"},{"text":"Composing & extending","link":"/engines/metering/composing"}]}]},{"text":"Connectors","items":[{"text":"What is a connector?","link":"/connectors/"},{"text":"Scrive (e-signing)","link":"/connectors/scrive"}]},{"text":"Verticals","items":[{"text":"What is a vertical?","link":"/verticals/"},{"text":"Callout (field service)","link":"/verticals/callout"},{"text":"Handlebar (bike workshop)","link":"/verticals/handlebar"},{"text":"Kallkälla (coffee shop)","link":"/verticals/shop"},{"text":"Meridian (HR)","link":"/verticals/meridian"},{"text":"RallyPoint (padel club)","link":"/verticals/rallypoint"},{"text":"Manyfold (headless CMS)","link":"/verticals/manyfold"}]},{"text":"Platform","items":[{"text":"The platform surfaces","link":"/platform/"},{"text":"Control plane","link":"/platform/control-plane"},{"text":"Console","link":"/platform/console"},{"text":"Router","link":"/platform/router"},{"text":"Dashboard","link":"/platform/dashboard"}]},{"text":"Package reference","items":[{"text":"@substrat-run/contracts","link":"/reference/contracts"},{"text":"@substrat-run/model-emit","link":"/reference/model-emit"},{"text":"@substrat-run/kernel","link":"/reference/kernel"},{"text":"@substrat-run/adapter-sqlite","link":"/reference/adapter-sqlite"},{"text":"@substrat-run/adapter-cloudflare","link":"/reference/adapter-cloudflare"},{"text":"@substrat-run/vertical-host","link":"/reference/vertical-host"},{"text":"@substrat-run/vertical-auth","link":"/reference/vertical-auth"},{"text":"@substrat-run/control-plane-api","link":"/reference/control-plane-api"},{"text":"@substrat-run/contract-tests","link":"/reference/contract-tests"},{"text":"@substrat-run/boundary-lint","link":"/reference/boundary-lint"},{"text":"@substrat-run/oidc-rp","link":"/reference/oidc-rp"},{"text":"@substrat-run/dev-issuer","link":"/reference/dev-issuer"},{"text":"@substrat-run/psl","link":"/reference/psl"},{"text":"@substrat-run/cli","link":"/reference/cli"},{"text":"create-substrat","link":"/reference/create-substrat"}]}],"/connectors/":[{"text":"Introduction","items":[{"text":"What is Substrat?","link":"/guide/what-is-substrat"},{"text":"Why runtime enforcement?","link":"/guide/why-substrat"},{"text":"How Substrat compares","link":"/guide/comparisons"},{"text":"What Substrat doesn't have (yet)","link":"/guide/what-substrat-lacks"},{"text":"FAQ","link":"/guide/faq"},{"text":"Architecture","link":"/guide/architecture"},{"text":"Getting started","link":"/guide/getting-started"},{"text":"Agent rules","link":"/guide/agent-rules"},{"text":"The Claude Code plugin","link":"/guide/agent-plugin"},{"text":"Running locally","link":"/guide/running-locally"},{"text":"Deploying a vertical","link":"/guide/deploying"},{"text":"Environments & previews","link":"/guide/environments-and-previews"},{"text":"Building for AI agents","link":"/guide/ai-agents"},{"text":"Where AI mistakes stop","link":"/guide/ai-guardrails"}]},{"text":"Concepts","items":[{"text":"Tenants & scopes","link":"/concepts/tenancy"},{"text":"The platform layer","link":"/concepts/platform"},{"text":"Operations & the scope host","link":"/concepts/scope-host"},{"text":"Permissions","link":"/concepts/permissions"},{"text":"Authentication & identity","link":"/concepts/identity"},{"text":"Events & audit","link":"/concepts/events"},{"text":"Snapshots & test copies","link":"/concepts/snapshots"},{"text":"The deploy model","link":"/concepts/deploying"},{"text":"Reads & scaling","link":"/concepts/reads"},{"text":"The model","link":"/concepts/model"},{"text":"Lifecycles","link":"/concepts/lifecycle"},{"text":"Modules & the manifest","link":"/concepts/modules"},{"text":"What a good API looks like","link":"/concepts/api-design"},{"text":"Money","link":"/concepts/money"}]},{"text":"Engines","items":[{"text":"What is an engine?","link":"/engines/"},{"text":"Work orders","collapsed":true,"items":[{"text":"Overview","link":"/engines/workorder/"},{"text":"Domain model & invariants","link":"/engines/workorder/model"},{"text":"Operations & permissions","link":"/engines/workorder/surface"},{"text":"Events","link":"/engines/workorder/events"},{"text":"Composing & extending","link":"/engines/workorder/composing"}]},{"text":"Bookings","collapsed":true,"items":[{"text":"Overview","link":"/engines/booking/"},{"text":"Domain model & invariants","link":"/engines/booking/model"},{"text":"Operations & permissions","link":"/engines/booking/surface"},{"text":"Events","link":"/engines/booking/events"},{"text":"Composing & extending","link":"/engines/booking/composing"}]},{"text":"Invoicing","collapsed":true,"items":[{"text":"Overview","link":"/engines/invoicing/"},{"text":"Domain model & invariants","link":"/engines/invoicing/model"},{"text":"Operations & permissions","link":"/engines/invoicing/surface"},{"text":"Events","link":"/engines/invoicing/events"},{"text":"Composing & extending","link":"/engines/invoicing/composing"}]},{"text":"Protocols","collapsed":true,"items":[{"text":"Overview","link":"/engines/protocol/"},{"text":"Domain model & invariants","link":"/engines/protocol/model"},{"text":"Operations & permissions","link":"/engines/protocol/surface"},{"text":"Events","link":"/engines/protocol/events"},{"text":"Composing & extending","link":"/engines/protocol/composing"}]},{"text":"Invites","collapsed":true,"items":[{"text":"Overview","link":"/engines/invites/"},{"text":"Domain model & invariants","link":"/engines/invites/model"},{"text":"Operations & permissions","link":"/engines/invites/surface"},{"text":"Events","link":"/engines/invites/events"},{"text":"Composing & extending","link":"/engines/invites/composing"}]},{"text":"Absence","collapsed":true,"items":[{"text":"Overview","link":"/engines/absence/"},{"text":"Domain model & invariants","link":"/engines/absence/model"},{"text":"Operations & permissions","link":"/engines/absence/surface"},{"text":"Events","link":"/engines/absence/events"},{"text":"Composing & extending","link":"/engines/absence/composing"}]},{"text":"Metering","collapsed":true,"items":[{"text":"Overview","link":"/engines/metering/"},{"text":"Domain model & invariants","link":"/engines/metering/model"},{"text":"Operations & permissions","link":"/engines/metering/surface"},{"text":"Events","link":"/engines/metering/events"},{"text":"Composing & extending","link":"/engines/metering/composing"}]}]},{"text":"Connectors","items":[{"text":"What is a connector?","link":"/connectors/"},{"text":"Scrive (e-signing)","link":"/connectors/scrive"}]},{"text":"Verticals","items":[{"text":"What is a vertical?","link":"/verticals/"},{"text":"Callout (field service)","link":"/verticals/callout"},{"text":"Handlebar (bike workshop)","link":"/verticals/handlebar"},{"text":"Kallkälla (coffee shop)","link":"/verticals/shop"},{"text":"Meridian (HR)","link":"/verticals/meridian"},{"text":"RallyPoint (padel club)","link":"/verticals/rallypoint"},{"text":"Manyfold (headless CMS)","link":"/verticals/manyfold"}]},{"text":"Platform","items":[{"text":"The platform surfaces","link":"/platform/"},{"text":"Control plane","link":"/platform/control-plane"},{"text":"Console","link":"/platform/console"},{"text":"Router","link":"/platform/router"},{"text":"Dashboard","link":"/platform/dashboard"}]},{"text":"Package reference","items":[{"text":"@substrat-run/contracts","link":"/reference/contracts"},{"text":"@substrat-run/model-emit","link":"/reference/model-emit"},{"text":"@substrat-run/kernel","link":"/reference/kernel"},{"text":"@substrat-run/adapter-sqlite","link":"/reference/adapter-sqlite"},{"text":"@substrat-run/adapter-cloudflare","link":"/reference/adapter-cloudflare"},{"text":"@substrat-run/vertical-host","link":"/reference/vertical-host"},{"text":"@substrat-run/vertical-auth","link":"/reference/vertical-auth"},{"text":"@substrat-run/control-plane-api","link":"/reference/control-plane-api"},{"text":"@substrat-run/contract-tests","link":"/reference/contract-tests"},{"text":"@substrat-run/boundary-lint","link":"/reference/boundary-lint"},{"text":"@substrat-run/oidc-rp","link":"/reference/oidc-rp"},{"text":"@substrat-run/dev-issuer","link":"/reference/dev-issuer"},{"text":"@substrat-run/psl","link":"/reference/psl"},{"text":"@substrat-run/cli","link":"/reference/cli"},{"text":"create-substrat","link":"/reference/create-substrat"}]}],"/verticals/":[{"text":"Introduction","items":[{"text":"What is Substrat?","link":"/guide/what-is-substrat"},{"text":"Why runtime enforcement?","link":"/guide/why-substrat"},{"text":"How Substrat compares","link":"/guide/comparisons"},{"text":"What Substrat doesn't have (yet)","link":"/guide/what-substrat-lacks"},{"text":"FAQ","link":"/guide/faq"},{"text":"Architecture","link":"/guide/architecture"},{"text":"Getting started","link":"/guide/getting-started"},{"text":"Agent rules","link":"/guide/agent-rules"},{"text":"The Claude Code plugin","link":"/guide/agent-plugin"},{"text":"Running locally","link":"/guide/running-locally"},{"text":"Deploying a vertical","link":"/guide/deploying"},{"text":"Environments & previews","link":"/guide/environments-and-previews"},{"text":"Building for AI agents","link":"/guide/ai-agents"},{"text":"Where AI mistakes stop","link":"/guide/ai-guardrails"}]},{"text":"Concepts","items":[{"text":"Tenants & scopes","link":"/concepts/tenancy"},{"text":"The platform layer","link":"/concepts/platform"},{"text":"Operations & the scope host","link":"/concepts/scope-host"},{"text":"Permissions","link":"/concepts/permissions"},{"text":"Authentication & identity","link":"/concepts/identity"},{"text":"Events & audit","link":"/concepts/events"},{"text":"Snapshots & test copies","link":"/concepts/snapshots"},{"text":"The deploy model","link":"/concepts/deploying"},{"text":"Reads & scaling","link":"/concepts/reads"},{"text":"The model","link":"/concepts/model"},{"text":"Lifecycles","link":"/concepts/lifecycle"},{"text":"Modules & the manifest","link":"/concepts/modules"},{"text":"What a good API looks like","link":"/concepts/api-design"},{"text":"Money","link":"/concepts/money"}]},{"text":"Engines","items":[{"text":"What is an engine?","link":"/engines/"},{"text":"Work orders","collapsed":true,"items":[{"text":"Overview","link":"/engines/workorder/"},{"text":"Domain model & invariants","link":"/engines/workorder/model"},{"text":"Operations & permissions","link":"/engines/workorder/surface"},{"text":"Events","link":"/engines/workorder/events"},{"text":"Composing & extending","link":"/engines/workorder/composing"}]},{"text":"Bookings","collapsed":true,"items":[{"text":"Overview","link":"/engines/booking/"},{"text":"Domain model & invariants","link":"/engines/booking/model"},{"text":"Operations & permissions","link":"/engines/booking/surface"},{"text":"Events","link":"/engines/booking/events"},{"text":"Composing & extending","link":"/engines/booking/composing"}]},{"text":"Invoicing","collapsed":true,"items":[{"text":"Overview","link":"/engines/invoicing/"},{"text":"Domain model & invariants","link":"/engines/invoicing/model"},{"text":"Operations & permissions","link":"/engines/invoicing/surface"},{"text":"Events","link":"/engines/invoicing/events"},{"text":"Composing & extending","link":"/engines/invoicing/composing"}]},{"text":"Protocols","collapsed":true,"items":[{"text":"Overview","link":"/engines/protocol/"},{"text":"Domain model & invariants","link":"/engines/protocol/model"},{"text":"Operations & permissions","link":"/engines/protocol/surface"},{"text":"Events","link":"/engines/protocol/events"},{"text":"Composing & extending","link":"/engines/protocol/composing"}]},{"text":"Invites","collapsed":true,"items":[{"text":"Overview","link":"/engines/invites/"},{"text":"Domain model & invariants","link":"/engines/invites/model"},{"text":"Operations & permissions","link":"/engines/invites/surface"},{"text":"Events","link":"/engines/invites/events"},{"text":"Composing & extending","link":"/engines/invites/composing"}]},{"text":"Absence","collapsed":true,"items":[{"text":"Overview","link":"/engines/absence/"},{"text":"Domain model & invariants","link":"/engines/absence/model"},{"text":"Operations & permissions","link":"/engines/absence/surface"},{"text":"Events","link":"/engines/absence/events"},{"text":"Composing & extending","link":"/engines/absence/composing"}]},{"text":"Metering","collapsed":true,"items":[{"text":"Overview","link":"/engines/metering/"},{"text":"Domain model & invariants","link":"/engines/metering/model"},{"text":"Operations & permissions","link":"/engines/metering/surface"},{"text":"Events","link":"/engines/metering/events"},{"text":"Composing & extending","link":"/engines/metering/composing"}]}]},{"text":"Connectors","items":[{"text":"What is a connector?","link":"/connectors/"},{"text":"Scrive (e-signing)","link":"/connectors/scrive"}]},{"text":"Verticals","items":[{"text":"What is a vertical?","link":"/verticals/"},{"text":"Callout (field service)","link":"/verticals/callout"},{"text":"Handlebar (bike workshop)","link":"/verticals/handlebar"},{"text":"Kallkälla (coffee shop)","link":"/verticals/shop"},{"text":"Meridian (HR)","link":"/verticals/meridian"},{"text":"RallyPoint (padel club)","link":"/verticals/rallypoint"},{"text":"Manyfold (headless CMS)","link":"/verticals/manyfold"}]},{"text":"Platform","items":[{"text":"The platform surfaces","link":"/platform/"},{"text":"Control plane","link":"/platform/control-plane"},{"text":"Console","link":"/platform/console"},{"text":"Router","link":"/platform/router"},{"text":"Dashboard","link":"/platform/dashboard"}]},{"text":"Package reference","items":[{"text":"@substrat-run/contracts","link":"/reference/contracts"},{"text":"@substrat-run/model-emit","link":"/reference/model-emit"},{"text":"@substrat-run/kernel","link":"/reference/kernel"},{"text":"@substrat-run/adapter-sqlite","link":"/reference/adapter-sqlite"},{"text":"@substrat-run/adapter-cloudflare","link":"/reference/adapter-cloudflare"},{"text":"@substrat-run/vertical-host","link":"/reference/vertical-host"},{"text":"@substrat-run/vertical-auth","link":"/reference/vertical-auth"},{"text":"@substrat-run/control-plane-api","link":"/reference/control-plane-api"},{"text":"@substrat-run/contract-tests","link":"/reference/contract-tests"},{"text":"@substrat-run/boundary-lint","link":"/reference/boundary-lint"},{"text":"@substrat-run/oidc-rp","link":"/reference/oidc-rp"},{"text":"@substrat-run/dev-issuer","link":"/reference/dev-issuer"},{"text":"@substrat-run/psl","link":"/reference/psl"},{"text":"@substrat-run/cli","link":"/reference/cli"},{"text":"create-substrat","link":"/reference/create-substrat"}]}],"/platform/":[{"text":"Introduction","items":[{"text":"What is Substrat?","link":"/guide/what-is-substrat"},{"text":"Why runtime enforcement?","link":"/guide/why-substrat"},{"text":"How Substrat compares","link":"/guide/comparisons"},{"text":"What Substrat doesn't have (yet)","link":"/guide/what-substrat-lacks"},{"text":"FAQ","link":"/guide/faq"},{"text":"Architecture","link":"/guide/architecture"},{"text":"Getting started","link":"/guide/getting-started"},{"text":"Agent rules","link":"/guide/agent-rules"},{"text":"The Claude Code plugin","link":"/guide/agent-plugin"},{"text":"Running locally","link":"/guide/running-locally"},{"text":"Deploying a vertical","link":"/guide/deploying"},{"text":"Environments & previews","link":"/guide/environments-and-previews"},{"text":"Building for AI agents","link":"/guide/ai-agents"},{"text":"Where AI mistakes stop","link":"/guide/ai-guardrails"}]},{"text":"Concepts","items":[{"text":"Tenants & scopes","link":"/concepts/tenancy"},{"text":"The platform layer","link":"/concepts/platform"},{"text":"Operations & the scope host","link":"/concepts/scope-host"},{"text":"Permissions","link":"/concepts/permissions"},{"text":"Authentication & identity","link":"/concepts/identity"},{"text":"Events & audit","link":"/concepts/events"},{"text":"Snapshots & test copies","link":"/concepts/snapshots"},{"text":"The deploy model","link":"/concepts/deploying"},{"text":"Reads & scaling","link":"/concepts/reads"},{"text":"The model","link":"/concepts/model"},{"text":"Lifecycles","link":"/concepts/lifecycle"},{"text":"Modules & the manifest","link":"/concepts/modules"},{"text":"What a good API looks like","link":"/concepts/api-design"},{"text":"Money","link":"/concepts/money"}]},{"text":"Engines","items":[{"text":"What is an engine?","link":"/engines/"},{"text":"Work orders","collapsed":true,"items":[{"text":"Overview","link":"/engines/workorder/"},{"text":"Domain model & invariants","link":"/engines/workorder/model"},{"text":"Operations & permissions","link":"/engines/workorder/surface"},{"text":"Events","link":"/engines/workorder/events"},{"text":"Composing & extending","link":"/engines/workorder/composing"}]},{"text":"Bookings","collapsed":true,"items":[{"text":"Overview","link":"/engines/booking/"},{"text":"Domain model & invariants","link":"/engines/booking/model"},{"text":"Operations & permissions","link":"/engines/booking/surface"},{"text":"Events","link":"/engines/booking/events"},{"text":"Composing & extending","link":"/engines/booking/composing"}]},{"text":"Invoicing","collapsed":true,"items":[{"text":"Overview","link":"/engines/invoicing/"},{"text":"Domain model & invariants","link":"/engines/invoicing/model"},{"text":"Operations & permissions","link":"/engines/invoicing/surface"},{"text":"Events","link":"/engines/invoicing/events"},{"text":"Composing & extending","link":"/engines/invoicing/composing"}]},{"text":"Protocols","collapsed":true,"items":[{"text":"Overview","link":"/engines/protocol/"},{"text":"Domain model & invariants","link":"/engines/protocol/model"},{"text":"Operations & permissions","link":"/engines/protocol/surface"},{"text":"Events","link":"/engines/protocol/events"},{"text":"Composing & extending","link":"/engines/protocol/composing"}]},{"text":"Invites","collapsed":true,"items":[{"text":"Overview","link":"/engines/invites/"},{"text":"Domain model & invariants","link":"/engines/invites/model"},{"text":"Operations & permissions","link":"/engines/invites/surface"},{"text":"Events","link":"/engines/invites/events"},{"text":"Composing & extending","link":"/engines/invites/composing"}]},{"text":"Absence","collapsed":true,"items":[{"text":"Overview","link":"/engines/absence/"},{"text":"Domain model & invariants","link":"/engines/absence/model"},{"text":"Operations & permissions","link":"/engines/absence/surface"},{"text":"Events","link":"/engines/absence/events"},{"text":"Composing & extending","link":"/engines/absence/composing"}]},{"text":"Metering","collapsed":true,"items":[{"text":"Overview","link":"/engines/metering/"},{"text":"Domain model & invariants","link":"/engines/metering/model"},{"text":"Operations & permissions","link":"/engines/metering/surface"},{"text":"Events","link":"/engines/metering/events"},{"text":"Composing & extending","link":"/engines/metering/composing"}]}]},{"text":"Connectors","items":[{"text":"What is a connector?","link":"/connectors/"},{"text":"Scrive (e-signing)","link":"/connectors/scrive"}]},{"text":"Verticals","items":[{"text":"What is a vertical?","link":"/verticals/"},{"text":"Callout (field service)","link":"/verticals/callout"},{"text":"Handlebar (bike workshop)","link":"/verticals/handlebar"},{"text":"Kallkälla (coffee shop)","link":"/verticals/shop"},{"text":"Meridian (HR)","link":"/verticals/meridian"},{"text":"RallyPoint (padel club)","link":"/verticals/rallypoint"},{"text":"Manyfold (headless CMS)","link":"/verticals/manyfold"}]},{"text":"Platform","items":[{"text":"The platform surfaces","link":"/platform/"},{"text":"Control plane","link":"/platform/control-plane"},{"text":"Console","link":"/platform/console"},{"text":"Router","link":"/platform/router"},{"text":"Dashboard","link":"/platform/dashboard"}]},{"text":"Package reference","items":[{"text":"@substrat-run/contracts","link":"/reference/contracts"},{"text":"@substrat-run/model-emit","link":"/reference/model-emit"},{"text":"@substrat-run/kernel","link":"/reference/kernel"},{"text":"@substrat-run/adapter-sqlite","link":"/reference/adapter-sqlite"},{"text":"@substrat-run/adapter-cloudflare","link":"/reference/adapter-cloudflare"},{"text":"@substrat-run/vertical-host","link":"/reference/vertical-host"},{"text":"@substrat-run/vertical-auth","link":"/reference/vertical-auth"},{"text":"@substrat-run/control-plane-api","link":"/reference/control-plane-api"},{"text":"@substrat-run/contract-tests","link":"/reference/contract-tests"},{"text":"@substrat-run/boundary-lint","link":"/reference/boundary-lint"},{"text":"@substrat-run/oidc-rp","link":"/reference/oidc-rp"},{"text":"@substrat-run/dev-issuer","link":"/reference/dev-issuer"},{"text":"@substrat-run/psl","link":"/reference/psl"},{"text":"@substrat-run/cli","link":"/reference/cli"},{"text":"create-substrat","link":"/reference/create-substrat"}]}],"/reference/":[{"text":"Introduction","items":[{"text":"What is Substrat?","link":"/guide/what-is-substrat"},{"text":"Why runtime enforcement?","link":"/guide/why-substrat"},{"text":"How Substrat compares","link":"/guide/comparisons"},{"text":"What Substrat doesn't have (yet)","link":"/guide/what-substrat-lacks"},{"text":"FAQ","link":"/guide/faq"},{"text":"Architecture","link":"/guide/architecture"},{"text":"Getting started","link":"/guide/getting-started"},{"text":"Agent rules","link":"/guide/agent-rules"},{"text":"The Claude Code plugin","link":"/guide/agent-plugin"},{"text":"Running locally","link":"/guide/running-locally"},{"text":"Deploying a vertical","link":"/guide/deploying"},{"text":"Environments & previews","link":"/guide/environments-and-previews"},{"text":"Building for AI agents","link":"/guide/ai-agents"},{"text":"Where AI mistakes stop","link":"/guide/ai-guardrails"}]},{"text":"Concepts","items":[{"text":"Tenants & scopes","link":"/concepts/tenancy"},{"text":"The platform layer","link":"/concepts/platform"},{"text":"Operations & the scope host","link":"/concepts/scope-host"},{"text":"Permissions","link":"/concepts/permissions"},{"text":"Authentication & identity","link":"/concepts/identity"},{"text":"Events & audit","link":"/concepts/events"},{"text":"Snapshots & test copies","link":"/concepts/snapshots"},{"text":"The deploy model","link":"/concepts/deploying"},{"text":"Reads & scaling","link":"/concepts/reads"},{"text":"The model","link":"/concepts/model"},{"text":"Lifecycles","link":"/concepts/lifecycle"},{"text":"Modules & the manifest","link":"/concepts/modules"},{"text":"What a good API looks like","link":"/concepts/api-design"},{"text":"Money","link":"/concepts/money"}]},{"text":"Engines","items":[{"text":"What is an engine?","link":"/engines/"},{"text":"Work orders","collapsed":true,"items":[{"text":"Overview","link":"/engines/workorder/"},{"text":"Domain model & invariants","link":"/engines/workorder/model"},{"text":"Operations & permissions","link":"/engines/workorder/surface"},{"text":"Events","link":"/engines/workorder/events"},{"text":"Composing & extending","link":"/engines/workorder/composing"}]},{"text":"Bookings","collapsed":true,"items":[{"text":"Overview","link":"/engines/booking/"},{"text":"Domain model & invariants","link":"/engines/booking/model"},{"text":"Operations & permissions","link":"/engines/booking/surface"},{"text":"Events","link":"/engines/booking/events"},{"text":"Composing & extending","link":"/engines/booking/composing"}]},{"text":"Invoicing","collapsed":true,"items":[{"text":"Overview","link":"/engines/invoicing/"},{"text":"Domain model & invariants","link":"/engines/invoicing/model"},{"text":"Operations & permissions","link":"/engines/invoicing/surface"},{"text":"Events","link":"/engines/invoicing/events"},{"text":"Composing & extending","link":"/engines/invoicing/composing"}]},{"text":"Protocols","collapsed":true,"items":[{"text":"Overview","link":"/engines/protocol/"},{"text":"Domain model & invariants","link":"/engines/protocol/model"},{"text":"Operations & permissions","link":"/engines/protocol/surface"},{"text":"Events","link":"/engines/protocol/events"},{"text":"Composing & extending","link":"/engines/protocol/composing"}]},{"text":"Invites","collapsed":true,"items":[{"text":"Overview","link":"/engines/invites/"},{"text":"Domain model & invariants","link":"/engines/invites/model"},{"text":"Operations & permissions","link":"/engines/invites/surface"},{"text":"Events","link":"/engines/invites/events"},{"text":"Composing & extending","link":"/engines/invites/composing"}]},{"text":"Absence","collapsed":true,"items":[{"text":"Overview","link":"/engines/absence/"},{"text":"Domain model & invariants","link":"/engines/absence/model"},{"text":"Operations & permissions","link":"/engines/absence/surface"},{"text":"Events","link":"/engines/absence/events"},{"text":"Composing & extending","link":"/engines/absence/composing"}]},{"text":"Metering","collapsed":true,"items":[{"text":"Overview","link":"/engines/metering/"},{"text":"Domain model & invariants","link":"/engines/metering/model"},{"text":"Operations & permissions","link":"/engines/metering/surface"},{"text":"Events","link":"/engines/metering/events"},{"text":"Composing & extending","link":"/engines/metering/composing"}]}]},{"text":"Connectors","items":[{"text":"What is a connector?","link":"/connectors/"},{"text":"Scrive (e-signing)","link":"/connectors/scrive"}]},{"text":"Verticals","items":[{"text":"What is a vertical?","link":"/verticals/"},{"text":"Callout (field service)","link":"/verticals/callout"},{"text":"Handlebar (bike workshop)","link":"/verticals/handlebar"},{"text":"Kallkälla (coffee shop)","link":"/verticals/shop"},{"text":"Meridian (HR)","link":"/verticals/meridian"},{"text":"RallyPoint (padel club)","link":"/verticals/rallypoint"},{"text":"Manyfold (headless CMS)","link":"/verticals/manyfold"}]},{"text":"Platform","items":[{"text":"The platform surfaces","link":"/platform/"},{"text":"Control plane","link":"/platform/control-plane"},{"text":"Console","link":"/platform/console"},{"text":"Router","link":"/platform/router"},{"text":"Dashboard","link":"/platform/dashboard"}]},{"text":"Package reference","items":[{"text":"@substrat-run/contracts","link":"/reference/contracts"},{"text":"@substrat-run/model-emit","link":"/reference/model-emit"},{"text":"@substrat-run/kernel","link":"/reference/kernel"},{"text":"@substrat-run/adapter-sqlite","link":"/reference/adapter-sqlite"},{"text":"@substrat-run/adapter-cloudflare","link":"/reference/adapter-cloudflare"},{"text":"@substrat-run/vertical-host","link":"/reference/vertical-host"},{"text":"@substrat-run/vertical-auth","link":"/reference/vertical-auth"},{"text":"@substrat-run/control-plane-api","link":"/reference/control-plane-api"},{"text":"@substrat-run/contract-tests","link":"/reference/contract-tests"},{"text":"@substrat-run/boundary-lint","link":"/reference/boundary-lint"},{"text":"@substrat-run/oidc-rp","link":"/reference/oidc-rp"},{"text":"@substrat-run/dev-issuer","link":"/reference/dev-issuer"},{"text":"@substrat-run/psl","link":"/reference/psl"},{"text":"@substrat-run/cli","link":"/reference/cli"},{"text":"create-substrat","link":"/reference/create-substrat"}]}],"/changelog/":[{"text":"Changelog","items":[{"text":"What this is","link":"/changelog/"},{"text":"2026","collapsed":false,"items":[{"text":"Week 34, 2026","link":"/changelog/2026-w34"}]}]}]},"outline":{"level":[2,3]},"socialLinks":[{"icon":"github","link":"https://github.com/substrat-run/substrat"}],"search":{"provider":"local"},"footer":{"message":"The hard parts, hosted."}},"locales":{},"scrollOffset":134,"cleanUrls":false}`));
function tryOnScopeDispose(fn) {
  if (getCurrentScope()) {
    onScopeDispose(fn);
    return true;
  }
  return false;
}
const localProvidedStateMap = /* @__PURE__ */ new WeakMap();
const injectLocal = (...args) => {
  var _a;
  const key = args[0];
  const instance = (_a = getCurrentInstance()) == null ? void 0 : _a.proxy;
  if (instance == null && !hasInjectionContext())
    throw new Error("injectLocal must be called in setup");
  if (instance && localProvidedStateMap.has(instance) && key in localProvidedStateMap.get(instance))
    return localProvidedStateMap.get(instance)[key];
  return inject(...args);
};
const isClient = typeof window !== "undefined" && typeof document !== "undefined";
typeof WorkerGlobalScope !== "undefined" && globalThis instanceof WorkerGlobalScope;
const notNullish = (val) => val != null;
const toString = Object.prototype.toString;
const isObject = (val) => toString.call(val) === "[object Object]";
const noop = () => {
};
const isIOS = /* @__PURE__ */ getIsIOS();
function getIsIOS() {
  var _a, _b;
  return isClient && ((_a = window == null ? void 0 : window.navigator) == null ? void 0 : _a.userAgent) && (/iP(?:ad|hone|od)/.test(window.navigator.userAgent) || ((_b = window == null ? void 0 : window.navigator) == null ? void 0 : _b.maxTouchPoints) > 2 && /iPad|Macintosh/.test(window == null ? void 0 : window.navigator.userAgent));
}
function createFilterWrapper(filter, fn) {
  function wrapper(...args) {
    return new Promise((resolve, reject) => {
      Promise.resolve(filter(() => fn.apply(this, args), { fn, thisArg: this, args })).then(resolve).catch(reject);
    });
  }
  return wrapper;
}
const bypassFilter = (invoke) => {
  return invoke();
};
function debounceFilter(ms, options = {}) {
  let timer;
  let maxTimer;
  let lastRejector = noop;
  const _clearTimeout = (timer2) => {
    clearTimeout(timer2);
    lastRejector();
    lastRejector = noop;
  };
  let lastInvoker;
  const filter = (invoke) => {
    const duration = toValue(ms);
    const maxDuration = toValue(options.maxWait);
    if (timer)
      _clearTimeout(timer);
    if (duration <= 0 || maxDuration !== void 0 && maxDuration <= 0) {
      if (maxTimer) {
        _clearTimeout(maxTimer);
        maxTimer = null;
      }
      return Promise.resolve(invoke());
    }
    return new Promise((resolve, reject) => {
      lastRejector = options.rejectOnCancel ? reject : resolve;
      lastInvoker = invoke;
      if (maxDuration && !maxTimer) {
        maxTimer = setTimeout(() => {
          if (timer)
            _clearTimeout(timer);
          maxTimer = null;
          resolve(lastInvoker());
        }, maxDuration);
      }
      timer = setTimeout(() => {
        if (maxTimer)
          _clearTimeout(maxTimer);
        maxTimer = null;
        resolve(invoke());
      }, duration);
    });
  };
  return filter;
}
function throttleFilter(...args) {
  let lastExec = 0;
  let timer;
  let isLeading = true;
  let lastRejector = noop;
  let lastValue;
  let ms;
  let trailing;
  let leading;
  let rejectOnCancel;
  if (!isRef(args[0]) && typeof args[0] === "object")
    ({ delay: ms, trailing = true, leading = true, rejectOnCancel = false } = args[0]);
  else
    [ms, trailing = true, leading = true, rejectOnCancel = false] = args;
  const clear = () => {
    if (timer) {
      clearTimeout(timer);
      timer = void 0;
      lastRejector();
      lastRejector = noop;
    }
  };
  const filter = (_invoke) => {
    const duration = toValue(ms);
    const elapsed = Date.now() - lastExec;
    const invoke = () => {
      return lastValue = _invoke();
    };
    clear();
    if (duration <= 0) {
      lastExec = Date.now();
      return invoke();
    }
    if (elapsed > duration && (leading || !isLeading)) {
      lastExec = Date.now();
      invoke();
    } else if (trailing) {
      lastValue = new Promise((resolve, reject) => {
        lastRejector = rejectOnCancel ? reject : resolve;
        timer = setTimeout(() => {
          lastExec = Date.now();
          isLeading = true;
          resolve(invoke());
          clear();
        }, Math.max(0, duration - elapsed));
      });
    }
    if (!leading && !timer)
      timer = setTimeout(() => isLeading = true, duration);
    isLeading = false;
    return lastValue;
  };
  return filter;
}
function pausableFilter(extendFilter = bypassFilter, options = {}) {
  const {
    initialState = "active"
  } = options;
  const isActive2 = toRef(initialState === "active");
  function pause() {
    isActive2.value = false;
  }
  function resume() {
    isActive2.value = true;
  }
  const eventFilter = (...args) => {
    if (isActive2.value)
      extendFilter(...args);
  };
  return { isActive: readonly(isActive2), pause, resume, eventFilter };
}
function pxValue(px) {
  return px.endsWith("rem") ? Number.parseFloat(px) * 16 : Number.parseFloat(px);
}
function getLifeCycleTarget(target) {
  return getCurrentInstance();
}
function toArray(value) {
  return Array.isArray(value) ? value : [value];
}
function toRef(...args) {
  if (args.length !== 1)
    return toRef$1(...args);
  const r = args[0];
  return typeof r === "function" ? readonly(customRef(() => ({ get: r, set: noop }))) : ref(r);
}
function useDebounceFn(fn, ms = 200, options = {}) {
  return createFilterWrapper(
    debounceFilter(ms, options),
    fn
  );
}
function useThrottleFn(fn, ms = 200, trailing = false, leading = true, rejectOnCancel = false) {
  return createFilterWrapper(
    throttleFilter(ms, trailing, leading, rejectOnCancel),
    fn
  );
}
function watchWithFilter(source2, cb, options = {}) {
  const {
    eventFilter = bypassFilter,
    ...watchOptions
  } = options;
  return watch(
    source2,
    createFilterWrapper(
      eventFilter,
      cb
    ),
    watchOptions
  );
}
function watchPausable(source2, cb, options = {}) {
  const {
    eventFilter: filter,
    initialState = "active",
    ...watchOptions
  } = options;
  const { eventFilter, pause, resume, isActive: isActive2 } = pausableFilter(filter, { initialState });
  const stop = watchWithFilter(
    source2,
    cb,
    {
      ...watchOptions,
      eventFilter
    }
  );
  return { stop, pause, resume, isActive: isActive2 };
}
function tryOnMounted(fn, sync = true, target) {
  const instance = getLifeCycleTarget();
  if (instance)
    onMounted(fn, target);
  else if (sync)
    fn();
  else
    nextTick(fn);
}
function watchDebounced(source2, cb, options = {}) {
  const {
    debounce = 0,
    maxWait = void 0,
    ...watchOptions
  } = options;
  return watchWithFilter(
    source2,
    cb,
    {
      ...watchOptions,
      eventFilter: debounceFilter(debounce, { maxWait })
    }
  );
}
function watchImmediate(source2, cb, options) {
  return watch(
    source2,
    cb,
    {
      ...options,
      immediate: true
    }
  );
}
function computedAsync(evaluationCallback, initialState, optionsOrRef) {
  let options;
  if (isRef(optionsOrRef)) {
    options = {
      evaluating: optionsOrRef
    };
  } else {
    options = {};
  }
  const {
    lazy = false,
    evaluating = void 0,
    shallow = true,
    onError = noop
  } = options;
  const started = shallowRef(!lazy);
  const current = shallow ? shallowRef(initialState) : ref(initialState);
  let counter = 0;
  watchEffect(async (onInvalidate) => {
    if (!started.value)
      return;
    counter++;
    const counterAtBeginning = counter;
    let hasFinished = false;
    if (evaluating) {
      Promise.resolve().then(() => {
        evaluating.value = true;
      });
    }
    try {
      const result = await evaluationCallback((cancelCallback) => {
        onInvalidate(() => {
          if (evaluating)
            evaluating.value = false;
          if (!hasFinished)
            cancelCallback();
        });
      });
      if (counterAtBeginning === counter)
        current.value = result;
    } catch (e) {
      onError(e);
    } finally {
      if (evaluating && counterAtBeginning === counter)
        evaluating.value = false;
      hasFinished = true;
    }
  });
  if (lazy) {
    return computed(() => {
      started.value = true;
      return current.value;
    });
  } else {
    return current;
  }
}
const defaultWindow = isClient ? window : void 0;
function unrefElement(elRef) {
  var _a;
  const plain = toValue(elRef);
  return (_a = plain == null ? void 0 : plain.$el) != null ? _a : plain;
}
function useEventListener(...args) {
  const cleanups = [];
  const cleanup = () => {
    cleanups.forEach((fn) => fn());
    cleanups.length = 0;
  };
  const register = (el, event, listener, options) => {
    el.addEventListener(event, listener, options);
    return () => el.removeEventListener(event, listener, options);
  };
  const firstParamTargets = computed(() => {
    const test = toArray(toValue(args[0])).filter((e) => e != null);
    return test.every((e) => typeof e !== "string") ? test : void 0;
  });
  const stopWatch = watchImmediate(
    () => {
      var _a, _b;
      return [
        (_b = (_a = firstParamTargets.value) == null ? void 0 : _a.map((e) => unrefElement(e))) != null ? _b : [defaultWindow].filter((e) => e != null),
        toArray(toValue(firstParamTargets.value ? args[1] : args[0])),
        toArray(unref(firstParamTargets.value ? args[2] : args[1])),
        // @ts-expect-error - TypeScript gets the correct types, but somehow still complains
        toValue(firstParamTargets.value ? args[3] : args[2])
      ];
    },
    ([raw_targets, raw_events, raw_listeners, raw_options]) => {
      cleanup();
      if (!(raw_targets == null ? void 0 : raw_targets.length) || !(raw_events == null ? void 0 : raw_events.length) || !(raw_listeners == null ? void 0 : raw_listeners.length))
        return;
      const optionsClone = isObject(raw_options) ? { ...raw_options } : raw_options;
      cleanups.push(
        ...raw_targets.flatMap(
          (el) => raw_events.flatMap(
            (event) => raw_listeners.map((listener) => register(el, event, listener, optionsClone))
          )
        )
      );
    },
    { flush: "post" }
  );
  const stop = () => {
    stopWatch();
    cleanup();
  };
  tryOnScopeDispose(cleanup);
  return stop;
}
function useMounted() {
  const isMounted = shallowRef(false);
  const instance = getCurrentInstance();
  if (instance) {
    onMounted(() => {
      isMounted.value = true;
    }, instance);
  }
  return isMounted;
}
function useSupported(callback) {
  const isMounted = useMounted();
  return computed(() => {
    isMounted.value;
    return Boolean(callback());
  });
}
function createKeyPredicate(keyFilter) {
  if (typeof keyFilter === "function")
    return keyFilter;
  else if (typeof keyFilter === "string")
    return (event) => event.key === keyFilter;
  else if (Array.isArray(keyFilter))
    return (event) => keyFilter.includes(event.key);
  return () => true;
}
function onKeyStroke(...args) {
  let key;
  let handler;
  let options = {};
  if (args.length === 3) {
    key = args[0];
    handler = args[1];
    options = args[2];
  } else if (args.length === 2) {
    if (typeof args[1] === "object") {
      key = true;
      handler = args[0];
      options = args[1];
    } else {
      key = args[0];
      handler = args[1];
    }
  } else {
    key = true;
    handler = args[0];
  }
  const {
    target = defaultWindow,
    eventName = "keydown",
    passive = false,
    dedupe = false
  } = options;
  const predicate = createKeyPredicate(key);
  const listener = (e) => {
    if (e.repeat && toValue(dedupe))
      return;
    if (predicate(e))
      handler(e);
  };
  return useEventListener(target, eventName, listener, passive);
}
const ssrWidthSymbol = Symbol("vueuse-ssr-width");
function useSSRWidth() {
  const ssrWidth = hasInjectionContext() ? injectLocal(ssrWidthSymbol, null) : null;
  return typeof ssrWidth === "number" ? ssrWidth : void 0;
}
function useMediaQuery(query, options = {}) {
  const { window: window2 = defaultWindow, ssrWidth = useSSRWidth() } = options;
  const isSupported = useSupported(() => window2 && "matchMedia" in window2 && typeof window2.matchMedia === "function");
  const ssrSupport = shallowRef(typeof ssrWidth === "number");
  const mediaQuery = shallowRef();
  const matches = shallowRef(false);
  const handler = (event) => {
    matches.value = event.matches;
  };
  watchEffect(() => {
    if (ssrSupport.value) {
      ssrSupport.value = !isSupported.value;
      const queryStrings = toValue(query).split(",");
      matches.value = queryStrings.some((queryString) => {
        const not = queryString.includes("not all");
        const minWidth = queryString.match(/\(\s*min-width:\s*(-?\d+(?:\.\d*)?[a-z]+\s*)\)/);
        const maxWidth = queryString.match(/\(\s*max-width:\s*(-?\d+(?:\.\d*)?[a-z]+\s*)\)/);
        let res = Boolean(minWidth || maxWidth);
        if (minWidth && res) {
          res = ssrWidth >= pxValue(minWidth[1]);
        }
        if (maxWidth && res) {
          res = ssrWidth <= pxValue(maxWidth[1]);
        }
        return not ? !res : res;
      });
      return;
    }
    if (!isSupported.value)
      return;
    mediaQuery.value = window2.matchMedia(toValue(query));
    matches.value = mediaQuery.value.matches;
  });
  useEventListener(mediaQuery, "change", handler, { passive: true });
  return computed(() => matches.value);
}
const _global = typeof globalThis !== "undefined" ? globalThis : typeof window !== "undefined" ? window : typeof global !== "undefined" ? global : typeof self !== "undefined" ? self : {};
const globalKey = "__vueuse_ssr_handlers__";
const handlers = /* @__PURE__ */ getHandlers();
function getHandlers() {
  if (!(globalKey in _global))
    _global[globalKey] = _global[globalKey] || {};
  return _global[globalKey];
}
function getSSRHandler(key, fallback) {
  return handlers[key] || fallback;
}
function usePreferredDark(options) {
  return useMediaQuery("(prefers-color-scheme: dark)", options);
}
function guessSerializerType(rawInit) {
  return rawInit == null ? "any" : rawInit instanceof Set ? "set" : rawInit instanceof Map ? "map" : rawInit instanceof Date ? "date" : typeof rawInit === "boolean" ? "boolean" : typeof rawInit === "string" ? "string" : typeof rawInit === "object" ? "object" : !Number.isNaN(rawInit) ? "number" : "any";
}
const StorageSerializers = {
  boolean: {
    read: (v) => v === "true",
    write: (v) => String(v)
  },
  object: {
    read: (v) => JSON.parse(v),
    write: (v) => JSON.stringify(v)
  },
  number: {
    read: (v) => Number.parseFloat(v),
    write: (v) => String(v)
  },
  any: {
    read: (v) => v,
    write: (v) => String(v)
  },
  string: {
    read: (v) => v,
    write: (v) => String(v)
  },
  map: {
    read: (v) => new Map(JSON.parse(v)),
    write: (v) => JSON.stringify(Array.from(v.entries()))
  },
  set: {
    read: (v) => new Set(JSON.parse(v)),
    write: (v) => JSON.stringify(Array.from(v))
  },
  date: {
    read: (v) => new Date(v),
    write: (v) => v.toISOString()
  }
};
const customStorageEventName = "vueuse-storage";
function useStorage(key, defaults, storage, options = {}) {
  var _a;
  const {
    flush = "pre",
    deep = true,
    listenToStorageChanges = true,
    writeDefaults = true,
    mergeDefaults = false,
    shallow,
    window: window2 = defaultWindow,
    eventFilter,
    onError = (e) => {
      console.error(e);
    },
    initOnMounted
  } = options;
  const data = (shallow ? shallowRef : ref)(typeof defaults === "function" ? defaults() : defaults);
  const keyComputed = computed(() => toValue(key));
  if (!storage) {
    try {
      storage = getSSRHandler("getDefaultStorage", () => {
        var _a2;
        return (_a2 = defaultWindow) == null ? void 0 : _a2.localStorage;
      })();
    } catch (e) {
      onError(e);
    }
  }
  if (!storage)
    return data;
  const rawInit = toValue(defaults);
  const type = guessSerializerType(rawInit);
  const serializer = (_a = options.serializer) != null ? _a : StorageSerializers[type];
  const { pause: pauseWatch, resume: resumeWatch } = watchPausable(
    data,
    () => write(data.value),
    { flush, deep, eventFilter }
  );
  watch(keyComputed, () => update(), { flush });
  if (window2 && listenToStorageChanges) {
    tryOnMounted(() => {
      if (storage instanceof Storage)
        useEventListener(window2, "storage", update, { passive: true });
      else
        useEventListener(window2, customStorageEventName, updateFromCustomEvent);
      if (initOnMounted)
        update();
    });
  }
  if (!initOnMounted)
    update();
  function dispatchWriteEvent(oldValue, newValue) {
    if (window2) {
      const payload = {
        key: keyComputed.value,
        oldValue,
        newValue,
        storageArea: storage
      };
      window2.dispatchEvent(storage instanceof Storage ? new StorageEvent("storage", payload) : new CustomEvent(customStorageEventName, {
        detail: payload
      }));
    }
  }
  function write(v) {
    try {
      const oldValue = storage.getItem(keyComputed.value);
      if (v == null) {
        dispatchWriteEvent(oldValue, null);
        storage.removeItem(keyComputed.value);
      } else {
        const serialized = serializer.write(v);
        if (oldValue !== serialized) {
          storage.setItem(keyComputed.value, serialized);
          dispatchWriteEvent(oldValue, serialized);
        }
      }
    } catch (e) {
      onError(e);
    }
  }
  function read(event) {
    const rawValue = event ? event.newValue : storage.getItem(keyComputed.value);
    if (rawValue == null) {
      if (writeDefaults && rawInit != null)
        storage.setItem(keyComputed.value, serializer.write(rawInit));
      return rawInit;
    } else if (!event && mergeDefaults) {
      const value = serializer.read(rawValue);
      if (typeof mergeDefaults === "function")
        return mergeDefaults(value, rawInit);
      else if (type === "object" && !Array.isArray(value))
        return { ...rawInit, ...value };
      return value;
    } else if (typeof rawValue !== "string") {
      return rawValue;
    } else {
      return serializer.read(rawValue);
    }
  }
  function update(event) {
    if (event && event.storageArea !== storage)
      return;
    if (event && event.key == null) {
      data.value = rawInit;
      return;
    }
    if (event && event.key !== keyComputed.value)
      return;
    pauseWatch();
    try {
      if ((event == null ? void 0 : event.newValue) !== serializer.write(data.value))
        data.value = read(event);
    } catch (e) {
      onError(e);
    } finally {
      if (event)
        nextTick(resumeWatch);
      else
        resumeWatch();
    }
  }
  function updateFromCustomEvent(event) {
    update(event.detail);
  }
  return data;
}
const CSS_DISABLE_TRANS = "*,*::before,*::after{-webkit-transition:none!important;-moz-transition:none!important;-o-transition:none!important;-ms-transition:none!important;transition:none!important}";
function useColorMode(options = {}) {
  const {
    selector = "html",
    attribute = "class",
    initialValue = "auto",
    window: window2 = defaultWindow,
    storage,
    storageKey = "vueuse-color-scheme",
    listenToStorageChanges = true,
    storageRef,
    emitAuto,
    disableTransition = true
  } = options;
  const modes = {
    auto: "",
    light: "light",
    dark: "dark",
    ...options.modes || {}
  };
  const preferredDark = usePreferredDark({ window: window2 });
  const system = computed(() => preferredDark.value ? "dark" : "light");
  const store = storageRef || (storageKey == null ? toRef(initialValue) : useStorage(storageKey, initialValue, storage, { window: window2, listenToStorageChanges }));
  const state = computed(() => store.value === "auto" ? system.value : store.value);
  const updateHTMLAttrs = getSSRHandler(
    "updateHTMLAttrs",
    (selector2, attribute2, value) => {
      const el = typeof selector2 === "string" ? window2 == null ? void 0 : window2.document.querySelector(selector2) : unrefElement(selector2);
      if (!el)
        return;
      const classesToAdd = /* @__PURE__ */ new Set();
      const classesToRemove = /* @__PURE__ */ new Set();
      let attributeToChange = null;
      if (attribute2 === "class") {
        const current = value.split(/\s/g);
        Object.values(modes).flatMap((i) => (i || "").split(/\s/g)).filter(Boolean).forEach((v) => {
          if (current.includes(v))
            classesToAdd.add(v);
          else
            classesToRemove.add(v);
        });
      } else {
        attributeToChange = { key: attribute2, value };
      }
      if (classesToAdd.size === 0 && classesToRemove.size === 0 && attributeToChange === null)
        return;
      let style;
      if (disableTransition) {
        style = window2.document.createElement("style");
        style.appendChild(document.createTextNode(CSS_DISABLE_TRANS));
        window2.document.head.appendChild(style);
      }
      for (const c of classesToAdd) {
        el.classList.add(c);
      }
      for (const c of classesToRemove) {
        el.classList.remove(c);
      }
      if (attributeToChange) {
        el.setAttribute(attributeToChange.key, attributeToChange.value);
      }
      if (disableTransition) {
        window2.getComputedStyle(style).opacity;
        document.head.removeChild(style);
      }
    }
  );
  function defaultOnChanged(mode) {
    var _a;
    updateHTMLAttrs(selector, attribute, (_a = modes[mode]) != null ? _a : mode);
  }
  function onChanged(mode) {
    if (options.onChanged)
      options.onChanged(mode, defaultOnChanged);
    else
      defaultOnChanged(mode);
  }
  watch(state, onChanged, { flush: "post", immediate: true });
  tryOnMounted(() => onChanged(state.value));
  const auto = computed({
    get() {
      return emitAuto ? store.value : state.value;
    },
    set(v) {
      store.value = v;
    }
  });
  return Object.assign(auto, { store, system, state });
}
function useDark(options = {}) {
  const {
    valueDark = "dark",
    valueLight = ""
  } = options;
  const mode = useColorMode({
    ...options,
    onChanged: (mode2, defaultHandler) => {
      var _a;
      if (options.onChanged)
        (_a = options.onChanged) == null ? void 0 : _a.call(options, mode2 === "dark", defaultHandler, mode2);
      else
        defaultHandler(mode2);
    },
    modes: {
      dark: valueDark,
      light: valueLight
    }
  });
  const system = computed(() => mode.system.value);
  const isDark = computed({
    get() {
      return mode.value === "dark";
    },
    set(v) {
      const modeVal = v ? "dark" : "light";
      if (system.value === modeVal)
        mode.value = "auto";
      else
        mode.value = modeVal;
    }
  });
  return isDark;
}
function resolveElement(el) {
  if (typeof Window !== "undefined" && el instanceof Window)
    return el.document.documentElement;
  if (typeof Document !== "undefined" && el instanceof Document)
    return el.documentElement;
  return el;
}
const ARRIVED_STATE_THRESHOLD_PIXELS = 1;
function useScroll(element, options = {}) {
  const {
    throttle = 0,
    idle = 200,
    onStop = noop,
    onScroll = noop,
    offset = {
      left: 0,
      right: 0,
      top: 0,
      bottom: 0
    },
    eventListenerOptions = {
      capture: false,
      passive: true
    },
    behavior = "auto",
    window: window2 = defaultWindow,
    onError = (e) => {
      console.error(e);
    }
  } = options;
  const internalX = shallowRef(0);
  const internalY = shallowRef(0);
  const x = computed({
    get() {
      return internalX.value;
    },
    set(x2) {
      scrollTo2(x2, void 0);
    }
  });
  const y = computed({
    get() {
      return internalY.value;
    },
    set(y2) {
      scrollTo2(void 0, y2);
    }
  });
  function scrollTo2(_x, _y) {
    var _a, _b, _c, _d;
    if (!window2)
      return;
    const _element = toValue(element);
    if (!_element)
      return;
    (_c = _element instanceof Document ? window2.document.body : _element) == null ? void 0 : _c.scrollTo({
      top: (_a = toValue(_y)) != null ? _a : y.value,
      left: (_b = toValue(_x)) != null ? _b : x.value,
      behavior: toValue(behavior)
    });
    const scrollContainer = ((_d = _element == null ? void 0 : _element.document) == null ? void 0 : _d.documentElement) || (_element == null ? void 0 : _element.documentElement) || _element;
    if (x != null)
      internalX.value = scrollContainer.scrollLeft;
    if (y != null)
      internalY.value = scrollContainer.scrollTop;
  }
  const isScrolling = shallowRef(false);
  const arrivedState = reactive({
    left: true,
    right: false,
    top: true,
    bottom: false
  });
  const directions = reactive({
    left: false,
    right: false,
    top: false,
    bottom: false
  });
  const onScrollEnd = (e) => {
    if (!isScrolling.value)
      return;
    isScrolling.value = false;
    directions.left = false;
    directions.right = false;
    directions.top = false;
    directions.bottom = false;
    onStop(e);
  };
  const onScrollEndDebounced = useDebounceFn(onScrollEnd, throttle + idle);
  const setArrivedState = (target) => {
    var _a;
    if (!window2)
      return;
    const el = ((_a = target == null ? void 0 : target.document) == null ? void 0 : _a.documentElement) || (target == null ? void 0 : target.documentElement) || unrefElement(target);
    const { display, flexDirection, direction } = getComputedStyle(el);
    const directionMultipler = direction === "rtl" ? -1 : 1;
    const scrollLeft = el.scrollLeft;
    directions.left = scrollLeft < internalX.value;
    directions.right = scrollLeft > internalX.value;
    const left = Math.abs(scrollLeft * directionMultipler) <= (offset.left || 0);
    const right = Math.abs(scrollLeft * directionMultipler) + el.clientWidth >= el.scrollWidth - (offset.right || 0) - ARRIVED_STATE_THRESHOLD_PIXELS;
    if (display === "flex" && flexDirection === "row-reverse") {
      arrivedState.left = right;
      arrivedState.right = left;
    } else {
      arrivedState.left = left;
      arrivedState.right = right;
    }
    internalX.value = scrollLeft;
    let scrollTop = el.scrollTop;
    if (target === window2.document && !scrollTop)
      scrollTop = window2.document.body.scrollTop;
    directions.top = scrollTop < internalY.value;
    directions.bottom = scrollTop > internalY.value;
    const top = Math.abs(scrollTop) <= (offset.top || 0);
    const bottom = Math.abs(scrollTop) + el.clientHeight >= el.scrollHeight - (offset.bottom || 0) - ARRIVED_STATE_THRESHOLD_PIXELS;
    if (display === "flex" && flexDirection === "column-reverse") {
      arrivedState.top = bottom;
      arrivedState.bottom = top;
    } else {
      arrivedState.top = top;
      arrivedState.bottom = bottom;
    }
    internalY.value = scrollTop;
  };
  const onScrollHandler = (e) => {
    var _a;
    if (!window2)
      return;
    const eventTarget = (_a = e.target.documentElement) != null ? _a : e.target;
    setArrivedState(eventTarget);
    isScrolling.value = true;
    onScrollEndDebounced(e);
    onScroll(e);
  };
  useEventListener(
    element,
    "scroll",
    throttle ? useThrottleFn(onScrollHandler, throttle, true, false) : onScrollHandler,
    eventListenerOptions
  );
  tryOnMounted(() => {
    try {
      const _element = toValue(element);
      if (!_element)
        return;
      setArrivedState(_element);
    } catch (e) {
      onError(e);
    }
  });
  useEventListener(
    element,
    "scrollend",
    onScrollEnd,
    eventListenerOptions
  );
  return {
    x,
    y,
    isScrolling,
    arrivedState,
    directions,
    measure() {
      const _element = toValue(element);
      if (window2 && _element)
        setArrivedState(_element);
    }
  };
}
function useLocalStorage(key, initialValue, options = {}) {
  const { window: window2 = defaultWindow } = options;
  return useStorage(key, initialValue, window2 == null ? void 0 : window2.localStorage, options);
}
function checkOverflowScroll(ele) {
  const style = window.getComputedStyle(ele);
  if (style.overflowX === "scroll" || style.overflowY === "scroll" || style.overflowX === "auto" && ele.clientWidth < ele.scrollWidth || style.overflowY === "auto" && ele.clientHeight < ele.scrollHeight) {
    return true;
  } else {
    const parent = ele.parentNode;
    if (!parent || parent.tagName === "BODY")
      return false;
    return checkOverflowScroll(parent);
  }
}
function preventDefault(rawEvent) {
  const e = rawEvent || window.event;
  const _target = e.target;
  if (checkOverflowScroll(_target))
    return false;
  if (e.touches.length > 1)
    return true;
  if (e.preventDefault)
    e.preventDefault();
  return false;
}
const elInitialOverflow = /* @__PURE__ */ new WeakMap();
function useScrollLock(element, initialState = false) {
  const isLocked = shallowRef(initialState);
  let stopTouchMoveListener = null;
  let initialOverflow = "";
  watch(toRef(element), (el) => {
    const target = resolveElement(toValue(el));
    if (target) {
      const ele = target;
      if (!elInitialOverflow.get(ele))
        elInitialOverflow.set(ele, ele.style.overflow);
      if (ele.style.overflow !== "hidden")
        initialOverflow = ele.style.overflow;
      if (ele.style.overflow === "hidden")
        return isLocked.value = true;
      if (isLocked.value)
        return ele.style.overflow = "hidden";
    }
  }, {
    immediate: true
  });
  const lock = () => {
    const el = resolveElement(toValue(element));
    if (!el || isLocked.value)
      return;
    if (isIOS) {
      stopTouchMoveListener = useEventListener(
        el,
        "touchmove",
        (e) => {
          preventDefault(e);
        },
        { passive: false }
      );
    }
    el.style.overflow = "hidden";
    isLocked.value = true;
  };
  const unlock = () => {
    const el = resolveElement(toValue(element));
    if (!el || !isLocked.value)
      return;
    if (isIOS)
      stopTouchMoveListener == null ? void 0 : stopTouchMoveListener();
    el.style.overflow = initialOverflow;
    elInitialOverflow.delete(el);
    isLocked.value = false;
  };
  tryOnScopeDispose(unlock);
  return computed({
    get() {
      return isLocked.value;
    },
    set(v) {
      if (v)
        lock();
      else unlock();
    }
  });
}
function useSessionStorage(key, initialValue, options = {}) {
  const { window: window2 = defaultWindow } = options;
  return useStorage(key, initialValue, window2 == null ? void 0 : window2.sessionStorage, options);
}
function useWindowScroll(options = {}) {
  const { window: window2 = defaultWindow, ...rest } = options;
  return useScroll(window2, rest);
}
function useWindowSize(options = {}) {
  const {
    window: window2 = defaultWindow,
    initialWidth = Number.POSITIVE_INFINITY,
    initialHeight = Number.POSITIVE_INFINITY,
    listenOrientation = true,
    includeScrollbar = true,
    type = "inner"
  } = options;
  const width = shallowRef(initialWidth);
  const height = shallowRef(initialHeight);
  const update = () => {
    if (window2) {
      if (type === "outer") {
        width.value = window2.outerWidth;
        height.value = window2.outerHeight;
      } else if (type === "visual" && window2.visualViewport) {
        const { width: visualViewportWidth, height: visualViewportHeight, scale } = window2.visualViewport;
        width.value = Math.round(visualViewportWidth * scale);
        height.value = Math.round(visualViewportHeight * scale);
      } else if (includeScrollbar) {
        width.value = window2.innerWidth;
        height.value = window2.innerHeight;
      } else {
        width.value = window2.document.documentElement.clientWidth;
        height.value = window2.document.documentElement.clientHeight;
      }
    }
  };
  update();
  tryOnMounted(update);
  const listenerOptions = { passive: true };
  useEventListener("resize", update, listenerOptions);
  if (window2 && type === "visual" && window2.visualViewport) {
    useEventListener(window2.visualViewport, "resize", update, listenerOptions);
  }
  if (listenOrientation) {
    const matches = useMediaQuery("(orientation: portrait)");
    watch(matches, () => update());
  }
  return { width, height };
}
const __vite_import_meta_env__ = {};
const EXTERNAL_URL_RE = /^(?:[a-z]+:|\/\/)/i;
const APPEARANCE_KEY = "vitepress-theme-appearance";
const HASH_RE = /#.*$/;
const HASH_OR_QUERY_RE = /[?#].*$/;
const INDEX_OR_EXT_RE = /(?:(^|\/)index)?\.(?:md|html)$/;
const inBrowser = typeof document !== "undefined";
const notFoundPageData = {
  relativePath: "404.md",
  filePath: "",
  title: "404",
  description: "Not Found",
  headers: [],
  frontmatter: { sidebar: false, layout: "page" },
  lastUpdated: 0,
  isNotFound: true
};
function isActive(currentPath, matchPath, asRegex = false) {
  if (matchPath === void 0) {
    return false;
  }
  currentPath = normalize(`/${currentPath}`);
  if (asRegex) {
    return new RegExp(matchPath).test(currentPath);
  }
  if (normalize(matchPath) !== currentPath) {
    return false;
  }
  const hashMatch = matchPath.match(HASH_RE);
  if (hashMatch) {
    return (inBrowser ? location.hash : "") === hashMatch[0];
  }
  return true;
}
function normalize(path) {
  return decodeURI(path).replace(HASH_OR_QUERY_RE, "").replace(INDEX_OR_EXT_RE, "$1");
}
function isExternal(path) {
  return EXTERNAL_URL_RE.test(path);
}
function getLocaleForPath(siteData2, relativePath) {
  return Object.keys((siteData2 == null ? void 0 : siteData2.locales) || {}).find((key) => key !== "root" && !isExternal(key) && isActive(relativePath, `/${key}/`, true)) || "root";
}
function resolveSiteDataByRoute(siteData2, relativePath) {
  var _a, _b, _c, _d, _e, _f, _g;
  const localeIndex = getLocaleForPath(siteData2, relativePath);
  return Object.assign({}, siteData2, {
    localeIndex,
    lang: ((_a = siteData2.locales[localeIndex]) == null ? void 0 : _a.lang) ?? siteData2.lang,
    dir: ((_b = siteData2.locales[localeIndex]) == null ? void 0 : _b.dir) ?? siteData2.dir,
    title: ((_c = siteData2.locales[localeIndex]) == null ? void 0 : _c.title) ?? siteData2.title,
    titleTemplate: ((_d = siteData2.locales[localeIndex]) == null ? void 0 : _d.titleTemplate) ?? siteData2.titleTemplate,
    description: ((_e = siteData2.locales[localeIndex]) == null ? void 0 : _e.description) ?? siteData2.description,
    head: mergeHead(siteData2.head, ((_f = siteData2.locales[localeIndex]) == null ? void 0 : _f.head) ?? []),
    themeConfig: {
      ...siteData2.themeConfig,
      ...(_g = siteData2.locales[localeIndex]) == null ? void 0 : _g.themeConfig
    }
  });
}
function createTitle(siteData2, pageData) {
  const title = pageData.title || siteData2.title;
  const template = pageData.titleTemplate ?? siteData2.titleTemplate;
  if (typeof template === "string" && template.includes(":title")) {
    return template.replace(/:title/g, title);
  }
  const templateString = createTitleTemplate(siteData2.title, template);
  if (title === templateString.slice(3)) {
    return title;
  }
  return `${title}${templateString}`;
}
function createTitleTemplate(siteTitle, template) {
  if (template === false) {
    return "";
  }
  if (template === true || template === void 0) {
    return ` | ${siteTitle}`;
  }
  if (siteTitle === template) {
    return "";
  }
  return ` | ${template}`;
}
function hasTag(head, tag) {
  const [tagType, tagAttrs] = tag;
  if (tagType !== "meta")
    return false;
  const keyAttr = Object.entries(tagAttrs)[0];
  if (keyAttr == null)
    return false;
  return head.some(([type, attrs]) => type === tagType && attrs[keyAttr[0]] === keyAttr[1]);
}
function mergeHead(prev, curr) {
  return [...prev.filter((tagAttrs) => !hasTag(curr, tagAttrs)), ...curr];
}
const INVALID_CHAR_REGEX = /[\u0000-\u001F"#$&*+,:;<=>?[\]^`{|}\u007F]/g;
const DRIVE_LETTER_REGEX = /^[a-z]:/i;
function sanitizeFileName(name) {
  const match = DRIVE_LETTER_REGEX.exec(name);
  const driveLetter = match ? match[0] : "";
  return driveLetter + name.slice(driveLetter.length).replace(INVALID_CHAR_REGEX, "_").replace(/(^|\/)_+(?=[^/]*$)/, "$1");
}
const KNOWN_EXTENSIONS = /* @__PURE__ */ new Set();
function treatAsHtml(filename) {
  var _a;
  if (KNOWN_EXTENSIONS.size === 0) {
    const extraExts = typeof process === "object" && ((_a = process.env) == null ? void 0 : _a.VITE_EXTRA_EXTENSIONS) || (__vite_import_meta_env__ == null ? void 0 : __vite_import_meta_env__.VITE_EXTRA_EXTENSIONS) || "";
    ("3g2,3gp,aac,ai,apng,au,avif,bin,bmp,cer,class,conf,crl,css,csv,dll,doc,eps,epub,exe,gif,gz,ics,ief,jar,jpe,jpeg,jpg,js,json,jsonld,m4a,man,mid,midi,mjs,mov,mp2,mp3,mp4,mpe,mpeg,mpg,mpp,oga,ogg,ogv,ogx,opus,otf,p10,p7c,p7m,p7s,pdf,png,ps,qt,roff,rtf,rtx,ser,svg,t,tif,tiff,tr,ts,tsv,ttf,txt,vtt,wav,weba,webm,webp,woff,woff2,xhtml,xml,yaml,yml,zip" + (extraExts && typeof extraExts === "string" ? "," + extraExts : "")).split(",").forEach((ext2) => KNOWN_EXTENSIONS.add(ext2));
  }
  const ext = filename.split(".").pop();
  return ext == null || !KNOWN_EXTENSIONS.has(ext.toLowerCase());
}
function escapeRegExp(str) {
  return str.replace(/[|\\{}()[\]^$+*?.]/g, "\\$&").replace(/-/g, "\\x2d");
}
const dataSymbol = Symbol();
const siteDataRef = shallowRef(siteData);
function initData(route) {
  const site = computed(() => resolveSiteDataByRoute(siteDataRef.value, route.data.relativePath));
  const appearance = site.value.appearance;
  const isDark = appearance === "force-dark" ? ref(true) : appearance === "force-auto" ? usePreferredDark() : appearance ? useDark({
    storageKey: APPEARANCE_KEY,
    initialValue: () => appearance === "dark" ? "dark" : "auto",
    ...typeof appearance === "object" ? appearance : {}
  }) : ref(false);
  const hashRef = ref(inBrowser ? location.hash : "");
  if (inBrowser) {
    window.addEventListener("hashchange", () => {
      hashRef.value = location.hash;
    });
  }
  watch(() => route.data, () => {
    hashRef.value = inBrowser ? location.hash : "";
  });
  return {
    site,
    theme: computed(() => site.value.themeConfig),
    page: computed(() => route.data),
    frontmatter: computed(() => route.data.frontmatter),
    params: computed(() => route.data.params),
    lang: computed(() => site.value.lang),
    dir: computed(() => route.data.frontmatter.dir || site.value.dir),
    localeIndex: computed(() => site.value.localeIndex || "root"),
    title: computed(() => createTitle(site.value, route.data)),
    description: computed(() => route.data.description || site.value.description),
    isDark,
    hash: computed(() => hashRef.value)
  };
}
function useData$1() {
  const data = inject(dataSymbol);
  if (!data) {
    throw new Error("vitepress data not properly injected in app");
  }
  return data;
}
function joinPath(base, path) {
  return `${base}${path}`.replace(/\/+/g, "/");
}
function withBase(path) {
  return EXTERNAL_URL_RE.test(path) || !path.startsWith("/") ? path : joinPath(siteDataRef.value.base, path);
}
function pathToFile(path) {
  let pagePath = path.replace(/\.html$/, "");
  pagePath = decodeURIComponent(pagePath);
  pagePath = pagePath.replace(/\/$/, "/index");
  {
    if (inBrowser) {
      const base = "/";
      pagePath = sanitizeFileName(pagePath.slice(base.length).replace(/\//g, "_") || "index") + ".md";
      let pageHash = __VP_HASH_MAP__[pagePath.toLowerCase()];
      if (!pageHash) {
        pagePath = pagePath.endsWith("_index.md") ? pagePath.slice(0, -9) + ".md" : pagePath.slice(0, -3) + "_index.md";
        pageHash = __VP_HASH_MAP__[pagePath.toLowerCase()];
      }
      if (!pageHash)
        return null;
      pagePath = `${base}${"assets"}/${pagePath}.${pageHash}.js`;
    } else {
      pagePath = `./${sanitizeFileName(pagePath.slice(1).replace(/\//g, "_"))}.md.js`;
    }
  }
  return pagePath;
}
let contentUpdatedCallbacks = [];
function onContentUpdated(fn) {
  contentUpdatedCallbacks.push(fn);
  onUnmounted(() => {
    contentUpdatedCallbacks = contentUpdatedCallbacks.filter((f) => f !== fn);
  });
}
function getScrollOffset() {
  let scrollOffset = siteDataRef.value.scrollOffset;
  let offset = 0;
  let padding = 24;
  if (typeof scrollOffset === "object" && "padding" in scrollOffset) {
    padding = scrollOffset.padding;
    scrollOffset = scrollOffset.selector;
  }
  if (typeof scrollOffset === "number") {
    offset = scrollOffset;
  } else if (typeof scrollOffset === "string") {
    offset = tryOffsetSelector(scrollOffset, padding);
  } else if (Array.isArray(scrollOffset)) {
    for (const selector of scrollOffset) {
      const res = tryOffsetSelector(selector, padding);
      if (res) {
        offset = res;
        break;
      }
    }
  }
  return offset;
}
function tryOffsetSelector(selector, padding) {
  const el = document.querySelector(selector);
  if (!el)
    return 0;
  const bot = el.getBoundingClientRect().bottom;
  if (bot < 0)
    return 0;
  return bot + padding;
}
const RouterSymbol = Symbol();
const fakeHost = "http://a.com";
const getDefaultRoute = () => ({
  path: "/",
  component: null,
  data: notFoundPageData
});
function createRouter(loadPageModule, fallbackComponent) {
  const route = reactive(getDefaultRoute());
  const router = {
    route,
    go
  };
  async function go(href = inBrowser ? location.href : "/") {
    var _a, _b;
    href = normalizeHref(href);
    if (await ((_a = router.onBeforeRouteChange) == null ? void 0 : _a.call(router, href)) === false)
      return;
    if (inBrowser && href !== normalizeHref(location.href)) {
      history.replaceState({ scrollPosition: window.scrollY }, "");
      history.pushState({}, "", href);
    }
    await loadPage(href);
    await ((_b = router.onAfterRouteChange ?? router.onAfterRouteChanged) == null ? void 0 : _b(href));
  }
  let latestPendingPath = null;
  async function loadPage(href, scrollPosition = 0, isRetry = false) {
    var _a, _b;
    if (await ((_a = router.onBeforePageLoad) == null ? void 0 : _a.call(router, href)) === false)
      return;
    const targetLoc = new URL(href, fakeHost);
    const pendingPath = latestPendingPath = targetLoc.pathname;
    try {
      let page = await loadPageModule(pendingPath);
      if (!page) {
        throw new Error(`Page not found: ${pendingPath}`);
      }
      if (latestPendingPath === pendingPath) {
        latestPendingPath = null;
        const { default: comp, __pageData } = page;
        if (!comp) {
          throw new Error(`Invalid route component: ${comp}`);
        }
        await ((_b = router.onAfterPageLoad) == null ? void 0 : _b.call(router, href));
        route.path = inBrowser ? pendingPath : withBase(pendingPath);
        route.component = markRaw(comp);
        route.data = true ? markRaw(__pageData) : readonly(__pageData);
        if (inBrowser) {
          nextTick(() => {
            let actualPathname = siteDataRef.value.base + __pageData.relativePath.replace(/(?:(^|\/)index)?\.md$/, "$1");
            if (!siteDataRef.value.cleanUrls && !actualPathname.endsWith("/")) {
              actualPathname += ".html";
            }
            if (actualPathname !== targetLoc.pathname) {
              targetLoc.pathname = actualPathname;
              href = actualPathname + targetLoc.search + targetLoc.hash;
              history.replaceState({}, "", href);
            }
            if (targetLoc.hash && !scrollPosition) {
              let target = null;
              try {
                target = document.getElementById(decodeURIComponent(targetLoc.hash).slice(1));
              } catch (e) {
                console.warn(e);
              }
              if (target) {
                scrollTo(target, targetLoc.hash);
                return;
              }
            }
            window.scrollTo(0, scrollPosition);
          });
        }
      }
    } catch (err) {
      if (!/fetch|Page not found/.test(err.message) && !/^\/404(\.html|\/)?$/.test(href)) {
        console.error(err);
      }
      if (!isRetry) {
        try {
          const res = await fetch(siteDataRef.value.base + "hashmap.json");
          window.__VP_HASH_MAP__ = await res.json();
          await loadPage(href, scrollPosition, true);
          return;
        } catch (e) {
        }
      }
      if (latestPendingPath === pendingPath) {
        latestPendingPath = null;
        route.path = inBrowser ? pendingPath : withBase(pendingPath);
        route.component = fallbackComponent ? markRaw(fallbackComponent) : null;
        const relativePath = inBrowser ? pendingPath.replace(/(^|\/)$/, "$1index").replace(/(\.html)?$/, ".md").replace(/^\//, "") : "404.md";
        route.data = { ...notFoundPageData, relativePath };
      }
    }
  }
  if (inBrowser) {
    if (history.state === null) {
      history.replaceState({}, "");
    }
    window.addEventListener("click", (e) => {
      if (e.defaultPrevented || !(e.target instanceof Element) || e.target.closest("button") || // temporary fix for docsearch action buttons
      e.button !== 0 || e.ctrlKey || e.shiftKey || e.altKey || e.metaKey)
        return;
      const link2 = e.target.closest("a");
      if (!link2 || link2.closest(".vp-raw") || link2.hasAttribute("download") || link2.hasAttribute("target"))
        return;
      const linkHref = link2.getAttribute("href") ?? (link2 instanceof SVGAElement ? link2.getAttribute("xlink:href") : null);
      if (linkHref == null)
        return;
      const { href, origin, pathname, hash, search } = new URL(linkHref, link2.baseURI);
      const currentUrl = new URL(location.href);
      if (origin === currentUrl.origin && treatAsHtml(pathname)) {
        e.preventDefault();
        if (pathname === currentUrl.pathname && search === currentUrl.search) {
          if (hash !== currentUrl.hash) {
            history.pushState({}, "", href);
            window.dispatchEvent(new HashChangeEvent("hashchange", {
              oldURL: currentUrl.href,
              newURL: href
            }));
          }
          if (hash) {
            scrollTo(link2, hash, link2.classList.contains("header-anchor"));
          } else {
            window.scrollTo(0, 0);
          }
        } else {
          go(href);
        }
      }
    }, { capture: true });
    window.addEventListener("popstate", async (e) => {
      var _a;
      if (e.state === null)
        return;
      const href = normalizeHref(location.href);
      await loadPage(href, e.state && e.state.scrollPosition || 0);
      await ((_a = router.onAfterRouteChange ?? router.onAfterRouteChanged) == null ? void 0 : _a(href));
    });
    window.addEventListener("hashchange", (e) => {
      e.preventDefault();
    });
  }
  return router;
}
function useRouter() {
  const router = inject(RouterSymbol);
  if (!router) {
    throw new Error("useRouter() is called without provider.");
  }
  return router;
}
function useRoute() {
  return useRouter().route;
}
function scrollTo(el, hash, smooth = false) {
  let target = null;
  try {
    target = el.classList.contains("header-anchor") ? el : document.getElementById(decodeURIComponent(hash).slice(1));
  } catch (e) {
    console.warn(e);
  }
  if (target) {
    let scrollToTarget = function() {
      if (!smooth || Math.abs(targetTop - window.scrollY) > window.innerHeight)
        window.scrollTo(0, targetTop);
      else
        window.scrollTo({ left: 0, top: targetTop, behavior: "smooth" });
    };
    const targetPadding = parseInt(window.getComputedStyle(target).paddingTop, 10);
    const targetTop = window.scrollY + target.getBoundingClientRect().top - getScrollOffset() + targetPadding;
    requestAnimationFrame(scrollToTarget);
  }
}
function normalizeHref(href) {
  const url = new URL(href, fakeHost);
  url.pathname = url.pathname.replace(/(^|\/)index(\.html)?$/, "$1");
  if (siteDataRef.value.cleanUrls)
    url.pathname = url.pathname.replace(/\.html$/, "");
  else if (!url.pathname.endsWith("/") && !url.pathname.endsWith(".html"))
    url.pathname += ".html";
  return url.pathname + url.search + url.hash;
}
const runCbs = () => contentUpdatedCallbacks.forEach((fn) => fn());
const Content = defineComponent({
  name: "VitePressContent",
  props: {
    as: { type: [Object, String], default: "div" }
  },
  setup(props) {
    const route = useRoute();
    const { frontmatter, site } = useData$1();
    watch(frontmatter, runCbs, { deep: true, flush: "post" });
    return () => h(props.as, site.value.contentProps ?? { style: { position: "relative" } }, [
      route.component ? h(route.component, {
        onVnodeMounted: runCbs,
        onVnodeUpdated: runCbs,
        onVnodeUnmounted: runCbs
      }) : "404 Page Not Found"
    ]);
  }
});
const _sfc_main$1h = {
  __name: "Mermaid",
  __ssrInlineRender: true,
  props: {
    graph: {
      type: String,
      required: true
    },
    id: {
      type: String,
      required: true
    },
    class: {
      type: String,
      required: false,
      default: "mermaid"
    }
  },
  setup(__props) {
    const pluginSettings = ref({
      securityLevel: "loose",
      startOnLoad: false,
      externalDiagrams: []
    });
    const { page } = useData$1();
    const { frontmatter } = toRaw(page.value);
    const mermaidPageTheme = frontmatter.mermaidTheme || "";
    const props = __props;
    const svg = ref(null);
    let mut = null;
    onMounted(async () => {
      var _a;
      await init(pluginSettings.value.externalDiagrams);
      let settings = await import("./virtual_mermaid-config.CM0F1BUC.js");
      if (settings == null ? void 0 : settings.default) pluginSettings.value = settings.default;
      mut = new MutationObserver(async () => await renderChart());
      mut.observe(document.documentElement, { attributes: true });
      await renderChart();
      const hasImages = ((_a = /<img([\w\W]+?)>/.exec(decodeURIComponent(props.graph))) == null ? void 0 : _a.length) > 0;
      if (hasImages)
        setTimeout(() => {
          let imgElements = document.getElementsByTagName("img");
          let imgs = Array.from(imgElements);
          if (imgs.length) {
            Promise.all(
              imgs.filter((img) => !img.complete).map(
                (img) => new Promise((resolve) => {
                  img.onload = img.onerror = resolve;
                })
              )
            ).then(async () => {
              await renderChart();
            });
          }
        }, 100);
    });
    onUnmounted(() => mut.disconnect());
    const renderChart = async () => {
      const hasDarkClass = document.documentElement.classList.contains("dark");
      let mermaidConfig = {
        ...pluginSettings.value
      };
      if (mermaidPageTheme) mermaidConfig.theme = mermaidPageTheme;
      if (hasDarkClass) mermaidConfig.theme = "dark";
      let svgCode = await render$1(
        props.id,
        decodeURIComponent(props.graph),
        mermaidConfig
      );
      const salt = Math.random().toString(36).substring(7);
      svg.value = `${svgCode} <span style="display: none">${salt}</span>`;
    };
    return (_ctx, _push, _parent, _attrs) => {
      _push(`<div${ssrRenderAttrs(mergeProps({
        class: props.class
      }, _attrs))}>${svg.value ?? ""}</div>`);
    };
  }
};
const _sfc_setup$1h = _sfc_main$1h.setup;
_sfc_main$1h.setup = (props, ctx) => {
  const ssrContext = useSSRContext();
  (ssrContext.modules || (ssrContext.modules = /* @__PURE__ */ new Set())).add("../../node_modules/.pnpm/vitepress-plugin-mermaid@2.0.17_mermaid@11.16.0_vitepress@1.6.4_@algolia+client-search@_3258bc7e2d60bb5ec7978a313188e60c/node_modules/vitepress-plugin-mermaid/dist/Mermaid.vue");
  return _sfc_setup$1h ? _sfc_setup$1h(props, ctx) : void 0;
};
const _sfc_main$1g = /* @__PURE__ */ defineComponent({
  __name: "VPBadge",
  __ssrInlineRender: true,
  props: {
    text: {},
    type: { default: "tip" }
  },
  setup(__props) {
    return (_ctx, _push, _parent, _attrs) => {
      _push(`<span${ssrRenderAttrs(mergeProps({
        class: ["VPBadge", __props.type]
      }, _attrs))}>`);
      ssrRenderSlot(_ctx.$slots, "default", {}, () => {
        _push(`${ssrInterpolate(__props.text)}`);
      }, _push, _parent);
      _push(`</span>`);
    };
  }
});
const _sfc_setup$1g = _sfc_main$1g.setup;
_sfc_main$1g.setup = (props, ctx) => {
  const ssrContext = useSSRContext();
  (ssrContext.modules || (ssrContext.modules = /* @__PURE__ */ new Set())).add("../../node_modules/.pnpm/vitepress@1.6.4_@algolia+client-search@5.55.2_@types+node@24.13.3_@types+react@18.3.31__6511206dab6d3da37418cf3428952e99/node_modules/vitepress/dist/client/theme-default/components/VPBadge.vue");
  return _sfc_setup$1g ? _sfc_setup$1g(props, ctx) : void 0;
};
const _sfc_main$1f = /* @__PURE__ */ defineComponent({
  __name: "VPBackdrop",
  __ssrInlineRender: true,
  props: {
    show: { type: Boolean }
  },
  setup(__props) {
    return (_ctx, _push, _parent, _attrs) => {
      if (__props.show) {
        _push(`<div${ssrRenderAttrs(mergeProps({ class: "VPBackdrop" }, _attrs))} data-v-aa9426c6></div>`);
      } else {
        _push(`<!---->`);
      }
    };
  }
});
const _sfc_setup$1f = _sfc_main$1f.setup;
_sfc_main$1f.setup = (props, ctx) => {
  const ssrContext = useSSRContext();
  (ssrContext.modules || (ssrContext.modules = /* @__PURE__ */ new Set())).add("../../node_modules/.pnpm/vitepress@1.6.4_@algolia+client-search@5.55.2_@types+node@24.13.3_@types+react@18.3.31__6511206dab6d3da37418cf3428952e99/node_modules/vitepress/dist/client/theme-default/components/VPBackdrop.vue");
  return _sfc_setup$1f ? _sfc_setup$1f(props, ctx) : void 0;
};
const VPBackdrop = /* @__PURE__ */ _export_sfc(_sfc_main$1f, [["__scopeId", "data-v-aa9426c6"]]);
const useData = useData$1;
function throttleAndDebounce(fn, delay) {
  let timeoutId;
  let called = false;
  return () => {
    if (timeoutId)
      clearTimeout(timeoutId);
    if (!called) {
      fn();
      (called = true) && setTimeout(() => called = false, delay);
    } else
      timeoutId = setTimeout(fn, delay);
  };
}
function ensureStartingSlash(path) {
  return path.startsWith("/") ? path : `/${path}`;
}
function normalizeLink$1(url) {
  const { pathname, search, hash, protocol: protocol2 } = new URL(url, "http://a.com");
  if (isExternal(url) || url.startsWith("#") || !protocol2.startsWith("http") || !treatAsHtml(pathname))
    return url;
  const { site } = useData();
  const normalizedPath = pathname.endsWith("/") || pathname.endsWith(".html") ? url : url.replace(/(?:(^\.+)\/)?.*$/, `$1${pathname.replace(/(\.md)?$/, site.value.cleanUrls ? "" : ".html")}${search}${hash}`);
  return withBase(normalizedPath);
}
function useLangs({ correspondingLink = false } = {}) {
  const { site, localeIndex, page, theme: theme2, hash } = useData();
  const currentLang = computed(() => {
    var _a, _b;
    return {
      label: (_a = site.value.locales[localeIndex.value]) == null ? void 0 : _a.label,
      link: ((_b = site.value.locales[localeIndex.value]) == null ? void 0 : _b.link) || (localeIndex.value === "root" ? "/" : `/${localeIndex.value}/`)
    };
  });
  const localeLinks = computed(() => Object.entries(site.value.locales).flatMap(([key, value]) => currentLang.value.label === value.label ? [] : {
    text: value.label,
    link: normalizeLink(value.link || (key === "root" ? "/" : `/${key}/`), theme2.value.i18nRouting !== false && correspondingLink, page.value.relativePath.slice(currentLang.value.link.length - 1), !site.value.cleanUrls) + hash.value
  }));
  return { localeLinks, currentLang };
}
function normalizeLink(link2, addPath, path, addExt) {
  return addPath ? link2.replace(/\/$/, "") + ensureStartingSlash(path.replace(/(^|\/)index\.md$/, "$1").replace(/\.md$/, addExt ? ".html" : "")) : link2;
}
const _sfc_main$1e = /* @__PURE__ */ defineComponent({
  __name: "NotFound",
  __ssrInlineRender: true,
  setup(__props) {
    const { theme: theme2 } = useData();
    const { currentLang } = useLangs();
    return (_ctx, _push, _parent, _attrs) => {
      var _a, _b, _c, _d, _e;
      _push(`<div${ssrRenderAttrs(mergeProps({ class: "NotFound" }, _attrs))} data-v-86012be7><p class="code" data-v-86012be7>${ssrInterpolate(((_a = unref(theme2).notFound) == null ? void 0 : _a.code) ?? "404")}</p><h1 class="title" data-v-86012be7>${ssrInterpolate(((_b = unref(theme2).notFound) == null ? void 0 : _b.title) ?? "PAGE NOT FOUND")}</h1><div class="divider" data-v-86012be7></div><blockquote class="quote" data-v-86012be7>${ssrInterpolate(((_c = unref(theme2).notFound) == null ? void 0 : _c.quote) ?? "But if you don't change your direction, and if you keep looking, you may end up where you are heading.")}</blockquote><div class="action" data-v-86012be7><a class="link"${ssrRenderAttr("href", unref(withBase)(unref(currentLang).link))}${ssrRenderAttr("aria-label", ((_d = unref(theme2).notFound) == null ? void 0 : _d.linkLabel) ?? "go to home")} data-v-86012be7>${ssrInterpolate(((_e = unref(theme2).notFound) == null ? void 0 : _e.linkText) ?? "Take me home")}</a></div></div>`);
    };
  }
});
const _sfc_setup$1e = _sfc_main$1e.setup;
_sfc_main$1e.setup = (props, ctx) => {
  const ssrContext = useSSRContext();
  (ssrContext.modules || (ssrContext.modules = /* @__PURE__ */ new Set())).add("../../node_modules/.pnpm/vitepress@1.6.4_@algolia+client-search@5.55.2_@types+node@24.13.3_@types+react@18.3.31__6511206dab6d3da37418cf3428952e99/node_modules/vitepress/dist/client/theme-default/NotFound.vue");
  return _sfc_setup$1e ? _sfc_setup$1e(props, ctx) : void 0;
};
const NotFound = /* @__PURE__ */ _export_sfc(_sfc_main$1e, [["__scopeId", "data-v-86012be7"]]);
function getSidebar(_sidebar, path) {
  if (Array.isArray(_sidebar))
    return addBase(_sidebar);
  if (_sidebar == null)
    return [];
  path = ensureStartingSlash(path);
  const dir = Object.keys(_sidebar).sort((a, b) => {
    return b.split("/").length - a.split("/").length;
  }).find((dir2) => {
    return path.startsWith(ensureStartingSlash(dir2));
  });
  const sidebar = dir ? _sidebar[dir] : [];
  return Array.isArray(sidebar) ? addBase(sidebar) : addBase(sidebar.items, sidebar.base);
}
function getSidebarGroups(sidebar) {
  const groups = [];
  let lastGroupIndex = 0;
  for (const index in sidebar) {
    const item = sidebar[index];
    if (item.items) {
      lastGroupIndex = groups.push(item);
      continue;
    }
    if (!groups[lastGroupIndex]) {
      groups.push({ items: [] });
    }
    groups[lastGroupIndex].items.push(item);
  }
  return groups;
}
function getFlatSideBarLinks(sidebar) {
  const links = [];
  function recursivelyExtractLinks(items) {
    for (const item of items) {
      if (item.text && item.link) {
        links.push({
          text: item.text,
          link: item.link,
          docFooterText: item.docFooterText
        });
      }
      if (item.items) {
        recursivelyExtractLinks(item.items);
      }
    }
  }
  recursivelyExtractLinks(sidebar);
  return links;
}
function hasActiveLink(path, items) {
  if (Array.isArray(items)) {
    return items.some((item) => hasActiveLink(path, item));
  }
  return isActive(path, items.link) ? true : items.items ? hasActiveLink(path, items.items) : false;
}
function addBase(items, _base) {
  return [...items].map((_item) => {
    const item = { ..._item };
    const base = item.base || _base;
    if (base && item.link)
      item.link = base + item.link;
    if (item.items)
      item.items = addBase(item.items, base);
    return item;
  });
}
function useSidebar() {
  const { frontmatter, page, theme: theme2 } = useData();
  const is960 = useMediaQuery("(min-width: 960px)");
  const isOpen = ref(false);
  const _sidebar = computed(() => {
    const sidebarConfig = theme2.value.sidebar;
    const relativePath = page.value.relativePath;
    return sidebarConfig ? getSidebar(sidebarConfig, relativePath) : [];
  });
  const sidebar = ref(_sidebar.value);
  watch(_sidebar, (next, prev) => {
    if (JSON.stringify(next) !== JSON.stringify(prev))
      sidebar.value = _sidebar.value;
  });
  const hasSidebar = computed(() => {
    return frontmatter.value.sidebar !== false && sidebar.value.length > 0 && frontmatter.value.layout !== "home";
  });
  const leftAside = computed(() => {
    if (hasAside)
      return frontmatter.value.aside == null ? theme2.value.aside === "left" : frontmatter.value.aside === "left";
    return false;
  });
  const hasAside = computed(() => {
    if (frontmatter.value.layout === "home")
      return false;
    if (frontmatter.value.aside != null)
      return !!frontmatter.value.aside;
    return theme2.value.aside !== false;
  });
  const isSidebarEnabled = computed(() => hasSidebar.value && is960.value);
  const sidebarGroups = computed(() => {
    return hasSidebar.value ? getSidebarGroups(sidebar.value) : [];
  });
  function open() {
    isOpen.value = true;
  }
  function close() {
    isOpen.value = false;
  }
  function toggle() {
    isOpen.value ? close() : open();
  }
  return {
    isOpen,
    sidebar,
    sidebarGroups,
    hasSidebar,
    hasAside,
    leftAside,
    isSidebarEnabled,
    open,
    close,
    toggle
  };
}
function useCloseSidebarOnEscape(isOpen, close) {
  let triggerElement;
  watchEffect(() => {
    triggerElement = isOpen.value ? document.activeElement : void 0;
  });
  onMounted(() => {
    window.addEventListener("keyup", onEscape);
  });
  onUnmounted(() => {
    window.removeEventListener("keyup", onEscape);
  });
  function onEscape(e) {
    if (e.key === "Escape" && isOpen.value) {
      close();
      triggerElement == null ? void 0 : triggerElement.focus();
    }
  }
}
function useSidebarControl(item) {
  const { page, hash } = useData();
  const collapsed = ref(false);
  const collapsible = computed(() => {
    return item.value.collapsed != null;
  });
  const isLink = computed(() => {
    return !!item.value.link;
  });
  const isActiveLink = ref(false);
  const updateIsActiveLink = () => {
    isActiveLink.value = isActive(page.value.relativePath, item.value.link);
  };
  watch([page, item, hash], updateIsActiveLink);
  onMounted(updateIsActiveLink);
  const hasActiveLink$1 = computed(() => {
    if (isActiveLink.value) {
      return true;
    }
    return item.value.items ? hasActiveLink(page.value.relativePath, item.value.items) : false;
  });
  const hasChildren = computed(() => {
    return !!(item.value.items && item.value.items.length);
  });
  watchEffect(() => {
    collapsed.value = !!(collapsible.value && item.value.collapsed);
  });
  watchPostEffect(() => {
    (isActiveLink.value || hasActiveLink$1.value) && (collapsed.value = false);
  });
  function toggle() {
    if (collapsible.value) {
      collapsed.value = !collapsed.value;
    }
  }
  return {
    collapsed,
    collapsible,
    isLink,
    isActiveLink,
    hasActiveLink: hasActiveLink$1,
    hasChildren,
    toggle
  };
}
function useAside() {
  const { hasSidebar } = useSidebar();
  const is960 = useMediaQuery("(min-width: 960px)");
  const is1280 = useMediaQuery("(min-width: 1280px)");
  const isAsideEnabled = computed(() => {
    if (!is1280.value && !is960.value) {
      return false;
    }
    return hasSidebar.value ? is1280.value : is960.value;
  });
  return {
    isAsideEnabled
  };
}
const ignoreRE = /\b(?:VPBadge|header-anchor|footnote-ref|ignore-header)\b/;
const resolvedHeaders = [];
function resolveTitle(theme2) {
  return typeof theme2.outline === "object" && !Array.isArray(theme2.outline) && theme2.outline.label || theme2.outlineTitle || "On this page";
}
function getHeaders(range) {
  const headers = [
    ...document.querySelectorAll(".VPDoc :where(h1,h2,h3,h4,h5,h6)")
  ].filter((el) => el.id && el.hasChildNodes()).map((el) => {
    const level = Number(el.tagName[1]);
    return {
      element: el,
      title: serializeHeader(el),
      link: "#" + el.id,
      level
    };
  });
  return resolveHeaders(headers, range);
}
function serializeHeader(h2) {
  let ret = "";
  for (const node of h2.childNodes) {
    if (node.nodeType === 1) {
      if (ignoreRE.test(node.className))
        continue;
      ret += node.textContent;
    } else if (node.nodeType === 3) {
      ret += node.textContent;
    }
  }
  return ret.trim();
}
function resolveHeaders(headers, range) {
  if (range === false) {
    return [];
  }
  const levelsRange = (typeof range === "object" && !Array.isArray(range) ? range.level : range) || 2;
  const [high, low] = typeof levelsRange === "number" ? [levelsRange, levelsRange] : levelsRange === "deep" ? [2, 6] : levelsRange;
  return buildTree(headers, high, low);
}
function useActiveAnchor(container, marker) {
  const { isAsideEnabled } = useAside();
  const onScroll = throttleAndDebounce(setActiveLink, 100);
  let prevActiveLink = null;
  onMounted(() => {
    requestAnimationFrame(setActiveLink);
    window.addEventListener("scroll", onScroll);
  });
  onUpdated(() => {
    activateLink(location.hash);
  });
  onUnmounted(() => {
    window.removeEventListener("scroll", onScroll);
  });
  function setActiveLink() {
    if (!isAsideEnabled.value) {
      return;
    }
    const scrollY = window.scrollY;
    const innerHeight = window.innerHeight;
    const offsetHeight = document.body.offsetHeight;
    const isBottom = Math.abs(scrollY + innerHeight - offsetHeight) < 1;
    const headers = resolvedHeaders.map(({ element, link: link2 }) => ({
      link: link2,
      top: getAbsoluteTop(element)
    })).filter(({ top }) => !Number.isNaN(top)).sort((a, b) => a.top - b.top);
    if (!headers.length) {
      activateLink(null);
      return;
    }
    if (scrollY < 1) {
      activateLink(null);
      return;
    }
    if (isBottom) {
      activateLink(headers[headers.length - 1].link);
      return;
    }
    let activeLink = null;
    for (const { link: link2, top } of headers) {
      if (top > scrollY + getScrollOffset() + 4) {
        break;
      }
      activeLink = link2;
    }
    activateLink(activeLink);
  }
  function activateLink(hash) {
    if (prevActiveLink) {
      prevActiveLink.classList.remove("active");
    }
    if (hash == null) {
      prevActiveLink = null;
    } else {
      prevActiveLink = container.value.querySelector(`a[href="${decodeURIComponent(hash)}"]`);
    }
    const activeLink = prevActiveLink;
    if (activeLink) {
      activeLink.classList.add("active");
      marker.value.style.top = activeLink.offsetTop + 39 + "px";
      marker.value.style.opacity = "1";
    } else {
      marker.value.style.top = "33px";
      marker.value.style.opacity = "0";
    }
  }
}
function getAbsoluteTop(element) {
  let offsetTop = 0;
  while (element !== document.body) {
    if (element === null) {
      return NaN;
    }
    offsetTop += element.offsetTop;
    element = element.offsetParent;
  }
  return offsetTop;
}
function buildTree(data, min, max) {
  resolvedHeaders.length = 0;
  const result = [];
  const stack = [];
  data.forEach((item) => {
    const node = { ...item, children: [] };
    let parent = stack[stack.length - 1];
    while (parent && parent.level >= node.level) {
      stack.pop();
      parent = stack[stack.length - 1];
    }
    if (node.element.classList.contains("ignore-header") || parent && "shouldIgnore" in parent) {
      stack.push({ level: node.level, shouldIgnore: true });
      return;
    }
    if (node.level > max || node.level < min)
      return;
    resolvedHeaders.push({ element: node.element, link: node.link });
    if (parent)
      parent.children.push(node);
    else
      result.push(node);
    stack.push(node);
  });
  return result;
}
const _sfc_main$1d = /* @__PURE__ */ defineComponent({
  __name: "VPDocOutlineItem",
  __ssrInlineRender: true,
  props: {
    headers: {},
    root: { type: Boolean }
  },
  setup(__props) {
    return (_ctx, _push, _parent, _attrs) => {
      const _component_VPDocOutlineItem = resolveComponent("VPDocOutlineItem", true);
      _push(`<ul${ssrRenderAttrs(mergeProps({
        class: ["VPDocOutlineItem", __props.root ? "root" : "nested"]
      }, _attrs))} data-v-44c24382><!--[-->`);
      ssrRenderList(__props.headers, ({ children, link: link2, title }) => {
        _push(`<li data-v-44c24382><a class="outline-link"${ssrRenderAttr("href", link2)}${ssrRenderAttr("title", title)} data-v-44c24382>${ssrInterpolate(title)}</a>`);
        if (children == null ? void 0 : children.length) {
          _push(ssrRenderComponent(_component_VPDocOutlineItem, { headers: children }, null, _parent));
        } else {
          _push(`<!---->`);
        }
        _push(`</li>`);
      });
      _push(`<!--]--></ul>`);
    };
  }
});
const _sfc_setup$1d = _sfc_main$1d.setup;
_sfc_main$1d.setup = (props, ctx) => {
  const ssrContext = useSSRContext();
  (ssrContext.modules || (ssrContext.modules = /* @__PURE__ */ new Set())).add("../../node_modules/.pnpm/vitepress@1.6.4_@algolia+client-search@5.55.2_@types+node@24.13.3_@types+react@18.3.31__6511206dab6d3da37418cf3428952e99/node_modules/vitepress/dist/client/theme-default/components/VPDocOutlineItem.vue");
  return _sfc_setup$1d ? _sfc_setup$1d(props, ctx) : void 0;
};
const VPDocOutlineItem = /* @__PURE__ */ _export_sfc(_sfc_main$1d, [["__scopeId", "data-v-44c24382"]]);
const _sfc_main$1c = /* @__PURE__ */ defineComponent({
  __name: "VPDocAsideOutline",
  __ssrInlineRender: true,
  setup(__props) {
    const { frontmatter, theme: theme2 } = useData();
    const headers = shallowRef([]);
    onContentUpdated(() => {
      headers.value = getHeaders(frontmatter.value.outline ?? theme2.value.outline);
    });
    const container = ref();
    const marker = ref();
    useActiveAnchor(container, marker);
    return (_ctx, _push, _parent, _attrs) => {
      _push(`<nav${ssrRenderAttrs(mergeProps({
        "aria-labelledby": "doc-outline-aria-label",
        class: ["VPDocAsideOutline", { "has-outline": headers.value.length > 0 }],
        ref_key: "container",
        ref: container
      }, _attrs))} data-v-56565041><div class="content" data-v-56565041><div class="outline-marker" data-v-56565041></div><div aria-level="2" class="outline-title" id="doc-outline-aria-label" role="heading" data-v-56565041>${ssrInterpolate(unref(resolveTitle)(unref(theme2)))}</div>`);
      _push(ssrRenderComponent(VPDocOutlineItem, {
        headers: headers.value,
        root: true
      }, null, _parent));
      _push(`</div></nav>`);
    };
  }
});
const _sfc_setup$1c = _sfc_main$1c.setup;
_sfc_main$1c.setup = (props, ctx) => {
  const ssrContext = useSSRContext();
  (ssrContext.modules || (ssrContext.modules = /* @__PURE__ */ new Set())).add("../../node_modules/.pnpm/vitepress@1.6.4_@algolia+client-search@5.55.2_@types+node@24.13.3_@types+react@18.3.31__6511206dab6d3da37418cf3428952e99/node_modules/vitepress/dist/client/theme-default/components/VPDocAsideOutline.vue");
  return _sfc_setup$1c ? _sfc_setup$1c(props, ctx) : void 0;
};
const VPDocAsideOutline = /* @__PURE__ */ _export_sfc(_sfc_main$1c, [["__scopeId", "data-v-56565041"]]);
const _sfc_main$1b = /* @__PURE__ */ defineComponent({
  __name: "VPDocAsideCarbonAds",
  __ssrInlineRender: true,
  props: {
    carbonAds: {}
  },
  setup(__props) {
    const VPCarbonAds = () => null;
    return (_ctx, _push, _parent, _attrs) => {
      _push(`<div${ssrRenderAttrs(mergeProps({ class: "VPDocAsideCarbonAds" }, _attrs))}>`);
      _push(ssrRenderComponent(unref(VPCarbonAds), { "carbon-ads": __props.carbonAds }, null, _parent));
      _push(`</div>`);
    };
  }
});
const _sfc_setup$1b = _sfc_main$1b.setup;
_sfc_main$1b.setup = (props, ctx) => {
  const ssrContext = useSSRContext();
  (ssrContext.modules || (ssrContext.modules = /* @__PURE__ */ new Set())).add("../../node_modules/.pnpm/vitepress@1.6.4_@algolia+client-search@5.55.2_@types+node@24.13.3_@types+react@18.3.31__6511206dab6d3da37418cf3428952e99/node_modules/vitepress/dist/client/theme-default/components/VPDocAsideCarbonAds.vue");
  return _sfc_setup$1b ? _sfc_setup$1b(props, ctx) : void 0;
};
const _sfc_main$1a = /* @__PURE__ */ defineComponent({
  __name: "VPDocAside",
  __ssrInlineRender: true,
  setup(__props) {
    const { theme: theme2 } = useData();
    return (_ctx, _push, _parent, _attrs) => {
      _push(`<div${ssrRenderAttrs(mergeProps({ class: "VPDocAside" }, _attrs))} data-v-44ef1f61>`);
      ssrRenderSlot(_ctx.$slots, "aside-top", {}, null, _push, _parent);
      ssrRenderSlot(_ctx.$slots, "aside-outline-before", {}, null, _push, _parent);
      _push(ssrRenderComponent(VPDocAsideOutline, null, null, _parent));
      ssrRenderSlot(_ctx.$slots, "aside-outline-after", {}, null, _push, _parent);
      _push(`<div class="spacer" data-v-44ef1f61></div>`);
      ssrRenderSlot(_ctx.$slots, "aside-ads-before", {}, null, _push, _parent);
      if (unref(theme2).carbonAds) {
        _push(ssrRenderComponent(_sfc_main$1b, {
          "carbon-ads": unref(theme2).carbonAds
        }, null, _parent));
      } else {
        _push(`<!---->`);
      }
      ssrRenderSlot(_ctx.$slots, "aside-ads-after", {}, null, _push, _parent);
      ssrRenderSlot(_ctx.$slots, "aside-bottom", {}, null, _push, _parent);
      _push(`</div>`);
    };
  }
});
const _sfc_setup$1a = _sfc_main$1a.setup;
_sfc_main$1a.setup = (props, ctx) => {
  const ssrContext = useSSRContext();
  (ssrContext.modules || (ssrContext.modules = /* @__PURE__ */ new Set())).add("../../node_modules/.pnpm/vitepress@1.6.4_@algolia+client-search@5.55.2_@types+node@24.13.3_@types+react@18.3.31__6511206dab6d3da37418cf3428952e99/node_modules/vitepress/dist/client/theme-default/components/VPDocAside.vue");
  return _sfc_setup$1a ? _sfc_setup$1a(props, ctx) : void 0;
};
const VPDocAside = /* @__PURE__ */ _export_sfc(_sfc_main$1a, [["__scopeId", "data-v-44ef1f61"]]);
function useEditLink() {
  const { theme: theme2, page } = useData();
  return computed(() => {
    const { text = "Edit this page", pattern = "" } = theme2.value.editLink || {};
    let url;
    if (typeof pattern === "function") {
      url = pattern(page.value);
    } else {
      url = pattern.replace(/:path/g, page.value.filePath);
    }
    return { url, text };
  });
}
function usePrevNext() {
  const { page, theme: theme2, frontmatter } = useData();
  return computed(() => {
    var _a, _b, _c, _d, _e, _f, _g, _h;
    const sidebar = getSidebar(theme2.value.sidebar, page.value.relativePath);
    const links = getFlatSideBarLinks(sidebar);
    const candidates = uniqBy(links, (link2) => link2.link.replace(/[?#].*$/, ""));
    const index = candidates.findIndex((link2) => {
      return isActive(page.value.relativePath, link2.link);
    });
    const hidePrev = ((_a = theme2.value.docFooter) == null ? void 0 : _a.prev) === false && !frontmatter.value.prev || frontmatter.value.prev === false;
    const hideNext = ((_b = theme2.value.docFooter) == null ? void 0 : _b.next) === false && !frontmatter.value.next || frontmatter.value.next === false;
    return {
      prev: hidePrev ? void 0 : {
        text: (typeof frontmatter.value.prev === "string" ? frontmatter.value.prev : typeof frontmatter.value.prev === "object" ? frontmatter.value.prev.text : void 0) ?? ((_c = candidates[index - 1]) == null ? void 0 : _c.docFooterText) ?? ((_d = candidates[index - 1]) == null ? void 0 : _d.text),
        link: (typeof frontmatter.value.prev === "object" ? frontmatter.value.prev.link : void 0) ?? ((_e = candidates[index - 1]) == null ? void 0 : _e.link)
      },
      next: hideNext ? void 0 : {
        text: (typeof frontmatter.value.next === "string" ? frontmatter.value.next : typeof frontmatter.value.next === "object" ? frontmatter.value.next.text : void 0) ?? ((_f = candidates[index + 1]) == null ? void 0 : _f.docFooterText) ?? ((_g = candidates[index + 1]) == null ? void 0 : _g.text),
        link: (typeof frontmatter.value.next === "object" ? frontmatter.value.next.link : void 0) ?? ((_h = candidates[index + 1]) == null ? void 0 : _h.link)
      }
    };
  });
}
function uniqBy(array, keyFn) {
  const seen = /* @__PURE__ */ new Set();
  return array.filter((item) => {
    const k = keyFn(item);
    return seen.has(k) ? false : seen.add(k);
  });
}
const _sfc_main$19 = /* @__PURE__ */ defineComponent({
  __name: "VPLink",
  __ssrInlineRender: true,
  props: {
    tag: {},
    href: {},
    noIcon: { type: Boolean },
    target: {},
    rel: {}
  },
  setup(__props) {
    const props = __props;
    const tag = computed(() => props.tag ?? (props.href ? "a" : "span"));
    const isExternal2 = computed(
      () => props.href && EXTERNAL_URL_RE.test(props.href) || props.target === "_blank"
    );
    return (_ctx, _push, _parent, _attrs) => {
      ssrRenderVNode(_push, createVNode(resolveDynamicComponent(tag.value), mergeProps({
        class: ["VPLink", {
          link: __props.href,
          "vp-external-link-icon": isExternal2.value,
          "no-icon": __props.noIcon
        }],
        href: __props.href ? unref(normalizeLink$1)(__props.href) : void 0,
        target: __props.target ?? (isExternal2.value ? "_blank" : void 0),
        rel: __props.rel ?? (isExternal2.value ? "noreferrer" : void 0)
      }, _attrs), {
        default: withCtx((_, _push2, _parent2, _scopeId) => {
          if (_push2) {
            ssrRenderSlot(_ctx.$slots, "default", {}, null, _push2, _parent2, _scopeId);
          } else {
            return [
              renderSlot(_ctx.$slots, "default")
            ];
          }
        }),
        _: 3
      }), _parent);
    };
  }
});
const _sfc_setup$19 = _sfc_main$19.setup;
_sfc_main$19.setup = (props, ctx) => {
  const ssrContext = useSSRContext();
  (ssrContext.modules || (ssrContext.modules = /* @__PURE__ */ new Set())).add("../../node_modules/.pnpm/vitepress@1.6.4_@algolia+client-search@5.55.2_@types+node@24.13.3_@types+react@18.3.31__6511206dab6d3da37418cf3428952e99/node_modules/vitepress/dist/client/theme-default/components/VPLink.vue");
  return _sfc_setup$19 ? _sfc_setup$19(props, ctx) : void 0;
};
const _sfc_main$18 = /* @__PURE__ */ defineComponent({
  __name: "VPDocFooterLastUpdated",
  __ssrInlineRender: true,
  setup(__props) {
    const { theme: theme2, page, lang } = useData();
    const date = computed(
      () => new Date(page.value.lastUpdated)
    );
    const isoDatetime = computed(() => date.value.toISOString());
    const datetime = ref("");
    onMounted(() => {
      watchEffect(() => {
        var _a, _b, _c;
        datetime.value = new Intl.DateTimeFormat(
          ((_b = (_a = theme2.value.lastUpdated) == null ? void 0 : _a.formatOptions) == null ? void 0 : _b.forceLocale) ? lang.value : void 0,
          ((_c = theme2.value.lastUpdated) == null ? void 0 : _c.formatOptions) ?? {
            dateStyle: "short",
            timeStyle: "short"
          }
        ).format(date.value);
      });
    });
    return (_ctx, _push, _parent, _attrs) => {
      var _a;
      _push(`<p${ssrRenderAttrs(mergeProps({ class: "VPLastUpdated" }, _attrs))} data-v-47ec8860>${ssrInterpolate(((_a = unref(theme2).lastUpdated) == null ? void 0 : _a.text) || unref(theme2).lastUpdatedText || "Last updated")}: <time${ssrRenderAttr("datetime", isoDatetime.value)} data-v-47ec8860>${ssrInterpolate(datetime.value)}</time></p>`);
    };
  }
});
const _sfc_setup$18 = _sfc_main$18.setup;
_sfc_main$18.setup = (props, ctx) => {
  const ssrContext = useSSRContext();
  (ssrContext.modules || (ssrContext.modules = /* @__PURE__ */ new Set())).add("../../node_modules/.pnpm/vitepress@1.6.4_@algolia+client-search@5.55.2_@types+node@24.13.3_@types+react@18.3.31__6511206dab6d3da37418cf3428952e99/node_modules/vitepress/dist/client/theme-default/components/VPDocFooterLastUpdated.vue");
  return _sfc_setup$18 ? _sfc_setup$18(props, ctx) : void 0;
};
const VPDocFooterLastUpdated = /* @__PURE__ */ _export_sfc(_sfc_main$18, [["__scopeId", "data-v-47ec8860"]]);
const _sfc_main$17 = /* @__PURE__ */ defineComponent({
  __name: "VPDocFooter",
  __ssrInlineRender: true,
  setup(__props) {
    const { theme: theme2, page, frontmatter } = useData();
    const editLink = useEditLink();
    const control = usePrevNext();
    const hasEditLink = computed(
      () => theme2.value.editLink && frontmatter.value.editLink !== false
    );
    const hasLastUpdated = computed(() => page.value.lastUpdated);
    const showFooter = computed(
      () => hasEditLink.value || hasLastUpdated.value || control.value.prev || control.value.next
    );
    return (_ctx, _push, _parent, _attrs) => {
      var _a, _b, _c, _d;
      if (showFooter.value) {
        _push(`<footer${ssrRenderAttrs(mergeProps({ class: "VPDocFooter" }, _attrs))} data-v-fc8b1b75>`);
        ssrRenderSlot(_ctx.$slots, "doc-footer-before", {}, null, _push, _parent);
        if (hasEditLink.value || hasLastUpdated.value) {
          _push(`<div class="edit-info" data-v-fc8b1b75>`);
          if (hasEditLink.value) {
            _push(`<div class="edit-link" data-v-fc8b1b75>`);
            _push(ssrRenderComponent(_sfc_main$19, {
              class: "edit-link-button",
              href: unref(editLink).url,
              "no-icon": true
            }, {
              default: withCtx((_, _push2, _parent2, _scopeId) => {
                if (_push2) {
                  _push2(`<span class="vpi-square-pen edit-link-icon" data-v-fc8b1b75${_scopeId}></span> ${ssrInterpolate(unref(editLink).text)}`);
                } else {
                  return [
                    createVNode("span", { class: "vpi-square-pen edit-link-icon" }),
                    createTextVNode(" " + toDisplayString(unref(editLink).text), 1)
                  ];
                }
              }),
              _: 1
            }, _parent));
            _push(`</div>`);
          } else {
            _push(`<!---->`);
          }
          if (hasLastUpdated.value) {
            _push(`<div class="last-updated" data-v-fc8b1b75>`);
            _push(ssrRenderComponent(VPDocFooterLastUpdated, null, null, _parent));
            _push(`</div>`);
          } else {
            _push(`<!---->`);
          }
          _push(`</div>`);
        } else {
          _push(`<!---->`);
        }
        if (((_a = unref(control).prev) == null ? void 0 : _a.link) || ((_b = unref(control).next) == null ? void 0 : _b.link)) {
          _push(`<nav class="prev-next" aria-labelledby="doc-footer-aria-label" data-v-fc8b1b75><span class="visually-hidden" id="doc-footer-aria-label" data-v-fc8b1b75>Pager</span><div class="pager" data-v-fc8b1b75>`);
          if ((_c = unref(control).prev) == null ? void 0 : _c.link) {
            _push(ssrRenderComponent(_sfc_main$19, {
              class: "pager-link prev",
              href: unref(control).prev.link
            }, {
              default: withCtx((_, _push2, _parent2, _scopeId) => {
                var _a2, _b2;
                if (_push2) {
                  _push2(`<span class="desc" data-v-fc8b1b75${_scopeId}>${(((_a2 = unref(theme2).docFooter) == null ? void 0 : _a2.prev) || "Previous page") ?? ""}</span><span class="title" data-v-fc8b1b75${_scopeId}>${unref(control).prev.text ?? ""}</span>`);
                } else {
                  return [
                    createVNode("span", {
                      class: "desc",
                      innerHTML: ((_b2 = unref(theme2).docFooter) == null ? void 0 : _b2.prev) || "Previous page"
                    }, null, 8, ["innerHTML"]),
                    createVNode("span", {
                      class: "title",
                      innerHTML: unref(control).prev.text
                    }, null, 8, ["innerHTML"])
                  ];
                }
              }),
              _: 1
            }, _parent));
          } else {
            _push(`<!---->`);
          }
          _push(`</div><div class="pager" data-v-fc8b1b75>`);
          if ((_d = unref(control).next) == null ? void 0 : _d.link) {
            _push(ssrRenderComponent(_sfc_main$19, {
              class: "pager-link next",
              href: unref(control).next.link
            }, {
              default: withCtx((_, _push2, _parent2, _scopeId) => {
                var _a2, _b2;
                if (_push2) {
                  _push2(`<span class="desc" data-v-fc8b1b75${_scopeId}>${(((_a2 = unref(theme2).docFooter) == null ? void 0 : _a2.next) || "Next page") ?? ""}</span><span class="title" data-v-fc8b1b75${_scopeId}>${unref(control).next.text ?? ""}</span>`);
                } else {
                  return [
                    createVNode("span", {
                      class: "desc",
                      innerHTML: ((_b2 = unref(theme2).docFooter) == null ? void 0 : _b2.next) || "Next page"
                    }, null, 8, ["innerHTML"]),
                    createVNode("span", {
                      class: "title",
                      innerHTML: unref(control).next.text
                    }, null, 8, ["innerHTML"])
                  ];
                }
              }),
              _: 1
            }, _parent));
          } else {
            _push(`<!---->`);
          }
          _push(`</div></nav>`);
        } else {
          _push(`<!---->`);
        }
        _push(`</footer>`);
      } else {
        _push(`<!---->`);
      }
    };
  }
});
const _sfc_setup$17 = _sfc_main$17.setup;
_sfc_main$17.setup = (props, ctx) => {
  const ssrContext = useSSRContext();
  (ssrContext.modules || (ssrContext.modules = /* @__PURE__ */ new Set())).add("../../node_modules/.pnpm/vitepress@1.6.4_@algolia+client-search@5.55.2_@types+node@24.13.3_@types+react@18.3.31__6511206dab6d3da37418cf3428952e99/node_modules/vitepress/dist/client/theme-default/components/VPDocFooter.vue");
  return _sfc_setup$17 ? _sfc_setup$17(props, ctx) : void 0;
};
const VPDocFooter = /* @__PURE__ */ _export_sfc(_sfc_main$17, [["__scopeId", "data-v-fc8b1b75"]]);
const _sfc_main$16 = /* @__PURE__ */ defineComponent({
  __name: "VPDoc",
  __ssrInlineRender: true,
  setup(__props) {
    const { theme: theme2 } = useData();
    const route = useRoute();
    const { hasSidebar, hasAside, leftAside } = useSidebar();
    const pageName = computed(
      () => route.path.replace(/[./]+/g, "_").replace(/_html$/, "")
    );
    return (_ctx, _push, _parent, _attrs) => {
      const _component_Content = resolveComponent("Content");
      _push(`<div${ssrRenderAttrs(mergeProps({
        class: ["VPDoc", { "has-sidebar": unref(hasSidebar), "has-aside": unref(hasAside) }]
      }, _attrs))} data-v-938ee5df>`);
      ssrRenderSlot(_ctx.$slots, "doc-top", {}, null, _push, _parent);
      _push(`<div class="container" data-v-938ee5df>`);
      if (unref(hasAside)) {
        _push(`<div class="${ssrRenderClass([{ "left-aside": unref(leftAside) }, "aside"])}" data-v-938ee5df><div class="aside-curtain" data-v-938ee5df></div><div class="aside-container" data-v-938ee5df><div class="aside-content" data-v-938ee5df>`);
        _push(ssrRenderComponent(VPDocAside, null, {
          "aside-top": withCtx((_, _push2, _parent2, _scopeId) => {
            if (_push2) {
              ssrRenderSlot(_ctx.$slots, "aside-top", {}, null, _push2, _parent2, _scopeId);
            } else {
              return [
                renderSlot(_ctx.$slots, "aside-top", {}, void 0, true)
              ];
            }
          }),
          "aside-bottom": withCtx((_, _push2, _parent2, _scopeId) => {
            if (_push2) {
              ssrRenderSlot(_ctx.$slots, "aside-bottom", {}, null, _push2, _parent2, _scopeId);
            } else {
              return [
                renderSlot(_ctx.$slots, "aside-bottom", {}, void 0, true)
              ];
            }
          }),
          "aside-outline-before": withCtx((_, _push2, _parent2, _scopeId) => {
            if (_push2) {
              ssrRenderSlot(_ctx.$slots, "aside-outline-before", {}, null, _push2, _parent2, _scopeId);
            } else {
              return [
                renderSlot(_ctx.$slots, "aside-outline-before", {}, void 0, true)
              ];
            }
          }),
          "aside-outline-after": withCtx((_, _push2, _parent2, _scopeId) => {
            if (_push2) {
              ssrRenderSlot(_ctx.$slots, "aside-outline-after", {}, null, _push2, _parent2, _scopeId);
            } else {
              return [
                renderSlot(_ctx.$slots, "aside-outline-after", {}, void 0, true)
              ];
            }
          }),
          "aside-ads-before": withCtx((_, _push2, _parent2, _scopeId) => {
            if (_push2) {
              ssrRenderSlot(_ctx.$slots, "aside-ads-before", {}, null, _push2, _parent2, _scopeId);
            } else {
              return [
                renderSlot(_ctx.$slots, "aside-ads-before", {}, void 0, true)
              ];
            }
          }),
          "aside-ads-after": withCtx((_, _push2, _parent2, _scopeId) => {
            if (_push2) {
              ssrRenderSlot(_ctx.$slots, "aside-ads-after", {}, null, _push2, _parent2, _scopeId);
            } else {
              return [
                renderSlot(_ctx.$slots, "aside-ads-after", {}, void 0, true)
              ];
            }
          }),
          _: 3
        }, _parent));
        _push(`</div></div></div>`);
      } else {
        _push(`<!---->`);
      }
      _push(`<div class="content" data-v-938ee5df><div class="content-container" data-v-938ee5df>`);
      ssrRenderSlot(_ctx.$slots, "doc-before", {}, null, _push, _parent);
      _push(`<main class="main" data-v-938ee5df>`);
      _push(ssrRenderComponent(_component_Content, {
        class: ["vp-doc", [
          pageName.value,
          unref(theme2).externalLinkIcon && "external-link-icon-enabled"
        ]]
      }, null, _parent));
      _push(`</main>`);
      _push(ssrRenderComponent(VPDocFooter, null, {
        "doc-footer-before": withCtx((_, _push2, _parent2, _scopeId) => {
          if (_push2) {
            ssrRenderSlot(_ctx.$slots, "doc-footer-before", {}, null, _push2, _parent2, _scopeId);
          } else {
            return [
              renderSlot(_ctx.$slots, "doc-footer-before", {}, void 0, true)
            ];
          }
        }),
        _: 3
      }, _parent));
      ssrRenderSlot(_ctx.$slots, "doc-after", {}, null, _push, _parent);
      _push(`</div></div></div>`);
      ssrRenderSlot(_ctx.$slots, "doc-bottom", {}, null, _push, _parent);
      _push(`</div>`);
    };
  }
});
const _sfc_setup$16 = _sfc_main$16.setup;
_sfc_main$16.setup = (props, ctx) => {
  const ssrContext = useSSRContext();
  (ssrContext.modules || (ssrContext.modules = /* @__PURE__ */ new Set())).add("../../node_modules/.pnpm/vitepress@1.6.4_@algolia+client-search@5.55.2_@types+node@24.13.3_@types+react@18.3.31__6511206dab6d3da37418cf3428952e99/node_modules/vitepress/dist/client/theme-default/components/VPDoc.vue");
  return _sfc_setup$16 ? _sfc_setup$16(props, ctx) : void 0;
};
const VPDoc = /* @__PURE__ */ _export_sfc(_sfc_main$16, [["__scopeId", "data-v-938ee5df"]]);
const _sfc_main$15 = /* @__PURE__ */ defineComponent({
  __name: "VPButton",
  __ssrInlineRender: true,
  props: {
    tag: {},
    size: { default: "medium" },
    theme: { default: "brand" },
    text: {},
    href: {},
    target: {},
    rel: {}
  },
  setup(__props) {
    const props = __props;
    const isExternal2 = computed(
      () => props.href && EXTERNAL_URL_RE.test(props.href)
    );
    const component = computed(() => {
      return props.tag || (props.href ? "a" : "button");
    });
    return (_ctx, _push, _parent, _attrs) => {
      ssrRenderVNode(_push, createVNode(resolveDynamicComponent(component.value), mergeProps({
        class: ["VPButton", [__props.size, __props.theme]],
        href: __props.href ? unref(normalizeLink$1)(__props.href) : void 0,
        target: props.target ?? (isExternal2.value ? "_blank" : void 0),
        rel: props.rel ?? (isExternal2.value ? "noreferrer" : void 0)
      }, _attrs), {
        default: withCtx((_, _push2, _parent2, _scopeId) => {
          if (_push2) {
            _push2(`${ssrInterpolate(__props.text)}`);
          } else {
            return [
              createTextVNode(toDisplayString(__props.text), 1)
            ];
          }
        }),
        _: 1
      }), _parent);
    };
  }
});
const _sfc_setup$15 = _sfc_main$15.setup;
_sfc_main$15.setup = (props, ctx) => {
  const ssrContext = useSSRContext();
  (ssrContext.modules || (ssrContext.modules = /* @__PURE__ */ new Set())).add("../../node_modules/.pnpm/vitepress@1.6.4_@algolia+client-search@5.55.2_@types+node@24.13.3_@types+react@18.3.31__6511206dab6d3da37418cf3428952e99/node_modules/vitepress/dist/client/theme-default/components/VPButton.vue");
  return _sfc_setup$15 ? _sfc_setup$15(props, ctx) : void 0;
};
const VPButton = /* @__PURE__ */ _export_sfc(_sfc_main$15, [["__scopeId", "data-v-08fbbe55"]]);
const _sfc_main$14 = /* @__PURE__ */ defineComponent({
  ...{ inheritAttrs: false },
  __name: "VPImage",
  __ssrInlineRender: true,
  props: {
    image: {},
    alt: {}
  },
  setup(__props) {
    return (_ctx, _push, _parent, _attrs) => {
      const _component_VPImage = resolveComponent("VPImage", true);
      if (__props.image) {
        _push(`<!--[-->`);
        if (typeof __props.image === "string" || "src" in __props.image) {
          _push(`<img${ssrRenderAttrs(mergeProps({ class: "VPImage" }, typeof __props.image === "string" ? _ctx.$attrs : { ...__props.image, ..._ctx.$attrs }, {
            src: unref(withBase)(typeof __props.image === "string" ? __props.image : __props.image.src),
            alt: __props.alt ?? (typeof __props.image === "string" ? "" : __props.image.alt || "")
          }))} data-v-c4c380f8>`);
        } else {
          _push(`<!--[-->`);
          _push(ssrRenderComponent(_component_VPImage, mergeProps({
            class: "dark",
            image: __props.image.dark,
            alt: __props.image.alt
          }, _ctx.$attrs), null, _parent));
          _push(ssrRenderComponent(_component_VPImage, mergeProps({
            class: "light",
            image: __props.image.light,
            alt: __props.image.alt
          }, _ctx.$attrs), null, _parent));
          _push(`<!--]-->`);
        }
        _push(`<!--]-->`);
      } else {
        _push(`<!---->`);
      }
    };
  }
});
const _sfc_setup$14 = _sfc_main$14.setup;
_sfc_main$14.setup = (props, ctx) => {
  const ssrContext = useSSRContext();
  (ssrContext.modules || (ssrContext.modules = /* @__PURE__ */ new Set())).add("../../node_modules/.pnpm/vitepress@1.6.4_@algolia+client-search@5.55.2_@types+node@24.13.3_@types+react@18.3.31__6511206dab6d3da37418cf3428952e99/node_modules/vitepress/dist/client/theme-default/components/VPImage.vue");
  return _sfc_setup$14 ? _sfc_setup$14(props, ctx) : void 0;
};
const VPImage = /* @__PURE__ */ _export_sfc(_sfc_main$14, [["__scopeId", "data-v-c4c380f8"]]);
const _sfc_main$13 = /* @__PURE__ */ defineComponent({
  __name: "VPHero",
  __ssrInlineRender: true,
  props: {
    name: {},
    text: {},
    tagline: {},
    image: {},
    actions: {}
  },
  setup(__props) {
    const heroImageSlotExists = inject("hero-image-slot-exists");
    return (_ctx, _push, _parent, _attrs) => {
      _push(`<div${ssrRenderAttrs(mergeProps({
        class: ["VPHero", { "has-image": __props.image || unref(heroImageSlotExists) }]
      }, _attrs))} data-v-f0222abb><div class="container" data-v-f0222abb><div class="main" data-v-f0222abb>`);
      ssrRenderSlot(_ctx.$slots, "home-hero-info-before", {}, null, _push, _parent);
      ssrRenderSlot(_ctx.$slots, "home-hero-info", {}, () => {
        _push(`<h1 class="heading" data-v-f0222abb>`);
        if (__props.name) {
          _push(`<span class="name clip" data-v-f0222abb>${__props.name ?? ""}</span>`);
        } else {
          _push(`<!---->`);
        }
        if (__props.text) {
          _push(`<span class="text" data-v-f0222abb>${__props.text ?? ""}</span>`);
        } else {
          _push(`<!---->`);
        }
        _push(`</h1>`);
        if (__props.tagline) {
          _push(`<p class="tagline" data-v-f0222abb>${__props.tagline ?? ""}</p>`);
        } else {
          _push(`<!---->`);
        }
      }, _push, _parent);
      ssrRenderSlot(_ctx.$slots, "home-hero-info-after", {}, null, _push, _parent);
      if (__props.actions) {
        _push(`<div class="actions" data-v-f0222abb><!--[-->`);
        ssrRenderList(__props.actions, (action) => {
          _push(`<div class="action" data-v-f0222abb>`);
          _push(ssrRenderComponent(VPButton, {
            tag: "a",
            size: "medium",
            theme: action.theme,
            text: action.text,
            href: action.link,
            target: action.target,
            rel: action.rel
          }, null, _parent));
          _push(`</div>`);
        });
        _push(`<!--]--></div>`);
      } else {
        _push(`<!---->`);
      }
      ssrRenderSlot(_ctx.$slots, "home-hero-actions-after", {}, null, _push, _parent);
      _push(`</div>`);
      if (__props.image || unref(heroImageSlotExists)) {
        _push(`<div class="image" data-v-f0222abb><div class="image-container" data-v-f0222abb><div class="image-bg" data-v-f0222abb></div>`);
        ssrRenderSlot(_ctx.$slots, "home-hero-image", {}, () => {
          if (__props.image) {
            _push(ssrRenderComponent(VPImage, {
              class: "image-src",
              image: __props.image
            }, null, _parent));
          } else {
            _push(`<!---->`);
          }
        }, _push, _parent);
        _push(`</div></div>`);
      } else {
        _push(`<!---->`);
      }
      _push(`</div></div>`);
    };
  }
});
const _sfc_setup$13 = _sfc_main$13.setup;
_sfc_main$13.setup = (props, ctx) => {
  const ssrContext = useSSRContext();
  (ssrContext.modules || (ssrContext.modules = /* @__PURE__ */ new Set())).add("../../node_modules/.pnpm/vitepress@1.6.4_@algolia+client-search@5.55.2_@types+node@24.13.3_@types+react@18.3.31__6511206dab6d3da37418cf3428952e99/node_modules/vitepress/dist/client/theme-default/components/VPHero.vue");
  return _sfc_setup$13 ? _sfc_setup$13(props, ctx) : void 0;
};
const VPHero = /* @__PURE__ */ _export_sfc(_sfc_main$13, [["__scopeId", "data-v-f0222abb"]]);
const _sfc_main$12 = /* @__PURE__ */ defineComponent({
  __name: "VPHomeHero",
  __ssrInlineRender: true,
  setup(__props) {
    const { frontmatter: fm } = useData();
    return (_ctx, _push, _parent, _attrs) => {
      if (unref(fm).hero) {
        _push(ssrRenderComponent(VPHero, mergeProps({
          class: "VPHomeHero",
          name: unref(fm).hero.name,
          text: unref(fm).hero.text,
          tagline: unref(fm).hero.tagline,
          image: unref(fm).hero.image,
          actions: unref(fm).hero.actions
        }, _attrs), {
          "home-hero-info-before": withCtx((_, _push2, _parent2, _scopeId) => {
            if (_push2) {
              ssrRenderSlot(_ctx.$slots, "home-hero-info-before", {}, null, _push2, _parent2, _scopeId);
            } else {
              return [
                renderSlot(_ctx.$slots, "home-hero-info-before")
              ];
            }
          }),
          "home-hero-info": withCtx((_, _push2, _parent2, _scopeId) => {
            if (_push2) {
              ssrRenderSlot(_ctx.$slots, "home-hero-info", {}, null, _push2, _parent2, _scopeId);
            } else {
              return [
                renderSlot(_ctx.$slots, "home-hero-info")
              ];
            }
          }),
          "home-hero-info-after": withCtx((_, _push2, _parent2, _scopeId) => {
            if (_push2) {
              ssrRenderSlot(_ctx.$slots, "home-hero-info-after", {}, null, _push2, _parent2, _scopeId);
            } else {
              return [
                renderSlot(_ctx.$slots, "home-hero-info-after")
              ];
            }
          }),
          "home-hero-actions-after": withCtx((_, _push2, _parent2, _scopeId) => {
            if (_push2) {
              ssrRenderSlot(_ctx.$slots, "home-hero-actions-after", {}, null, _push2, _parent2, _scopeId);
            } else {
              return [
                renderSlot(_ctx.$slots, "home-hero-actions-after")
              ];
            }
          }),
          "home-hero-image": withCtx((_, _push2, _parent2, _scopeId) => {
            if (_push2) {
              ssrRenderSlot(_ctx.$slots, "home-hero-image", {}, null, _push2, _parent2, _scopeId);
            } else {
              return [
                renderSlot(_ctx.$slots, "home-hero-image")
              ];
            }
          }),
          _: 3
        }, _parent));
      } else {
        _push(`<!---->`);
      }
    };
  }
});
const _sfc_setup$12 = _sfc_main$12.setup;
_sfc_main$12.setup = (props, ctx) => {
  const ssrContext = useSSRContext();
  (ssrContext.modules || (ssrContext.modules = /* @__PURE__ */ new Set())).add("../../node_modules/.pnpm/vitepress@1.6.4_@algolia+client-search@5.55.2_@types+node@24.13.3_@types+react@18.3.31__6511206dab6d3da37418cf3428952e99/node_modules/vitepress/dist/client/theme-default/components/VPHomeHero.vue");
  return _sfc_setup$12 ? _sfc_setup$12(props, ctx) : void 0;
};
const _sfc_main$11 = /* @__PURE__ */ defineComponent({
  __name: "VPFeature",
  __ssrInlineRender: true,
  props: {
    icon: {},
    title: {},
    details: {},
    link: {},
    linkText: {},
    rel: {},
    target: {}
  },
  setup(__props) {
    return (_ctx, _push, _parent, _attrs) => {
      _push(ssrRenderComponent(_sfc_main$19, mergeProps({
        class: "VPFeature",
        href: __props.link,
        rel: __props.rel,
        target: __props.target,
        "no-icon": true,
        tag: __props.link ? "a" : "div"
      }, _attrs), {
        default: withCtx((_, _push2, _parent2, _scopeId) => {
          if (_push2) {
            _push2(`<article class="box" data-v-5e4516dd${_scopeId}>`);
            if (typeof __props.icon === "object" && __props.icon.wrap) {
              _push2(`<div class="icon" data-v-5e4516dd${_scopeId}>`);
              _push2(ssrRenderComponent(VPImage, {
                image: __props.icon,
                alt: __props.icon.alt,
                height: __props.icon.height || 48,
                width: __props.icon.width || 48
              }, null, _parent2, _scopeId));
              _push2(`</div>`);
            } else if (typeof __props.icon === "object") {
              _push2(ssrRenderComponent(VPImage, {
                image: __props.icon,
                alt: __props.icon.alt,
                height: __props.icon.height || 48,
                width: __props.icon.width || 48
              }, null, _parent2, _scopeId));
            } else if (__props.icon) {
              _push2(`<div class="icon" data-v-5e4516dd${_scopeId}>${__props.icon ?? ""}</div>`);
            } else {
              _push2(`<!---->`);
            }
            _push2(`<h2 class="title" data-v-5e4516dd${_scopeId}>${__props.title ?? ""}</h2>`);
            if (__props.details) {
              _push2(`<p class="details" data-v-5e4516dd${_scopeId}>${__props.details ?? ""}</p>`);
            } else {
              _push2(`<!---->`);
            }
            if (__props.linkText) {
              _push2(`<div class="link-text" data-v-5e4516dd${_scopeId}><p class="link-text-value" data-v-5e4516dd${_scopeId}>${ssrInterpolate(__props.linkText)} <span class="vpi-arrow-right link-text-icon" data-v-5e4516dd${_scopeId}></span></p></div>`);
            } else {
              _push2(`<!---->`);
            }
            _push2(`</article>`);
          } else {
            return [
              createVNode("article", { class: "box" }, [
                typeof __props.icon === "object" && __props.icon.wrap ? (openBlock(), createBlock("div", {
                  key: 0,
                  class: "icon"
                }, [
                  createVNode(VPImage, {
                    image: __props.icon,
                    alt: __props.icon.alt,
                    height: __props.icon.height || 48,
                    width: __props.icon.width || 48
                  }, null, 8, ["image", "alt", "height", "width"])
                ])) : typeof __props.icon === "object" ? (openBlock(), createBlock(VPImage, {
                  key: 1,
                  image: __props.icon,
                  alt: __props.icon.alt,
                  height: __props.icon.height || 48,
                  width: __props.icon.width || 48
                }, null, 8, ["image", "alt", "height", "width"])) : __props.icon ? (openBlock(), createBlock("div", {
                  key: 2,
                  class: "icon",
                  innerHTML: __props.icon
                }, null, 8, ["innerHTML"])) : createCommentVNode("", true),
                createVNode("h2", {
                  class: "title",
                  innerHTML: __props.title
                }, null, 8, ["innerHTML"]),
                __props.details ? (openBlock(), createBlock("p", {
                  key: 3,
                  class: "details",
                  innerHTML: __props.details
                }, null, 8, ["innerHTML"])) : createCommentVNode("", true),
                __props.linkText ? (openBlock(), createBlock("div", {
                  key: 4,
                  class: "link-text"
                }, [
                  createVNode("p", { class: "link-text-value" }, [
                    createTextVNode(toDisplayString(__props.linkText) + " ", 1),
                    createVNode("span", { class: "vpi-arrow-right link-text-icon" })
                  ])
                ])) : createCommentVNode("", true)
              ])
            ];
          }
        }),
        _: 1
      }, _parent));
    };
  }
});
const _sfc_setup$11 = _sfc_main$11.setup;
_sfc_main$11.setup = (props, ctx) => {
  const ssrContext = useSSRContext();
  (ssrContext.modules || (ssrContext.modules = /* @__PURE__ */ new Set())).add("../../node_modules/.pnpm/vitepress@1.6.4_@algolia+client-search@5.55.2_@types+node@24.13.3_@types+react@18.3.31__6511206dab6d3da37418cf3428952e99/node_modules/vitepress/dist/client/theme-default/components/VPFeature.vue");
  return _sfc_setup$11 ? _sfc_setup$11(props, ctx) : void 0;
};
const VPFeature = /* @__PURE__ */ _export_sfc(_sfc_main$11, [["__scopeId", "data-v-5e4516dd"]]);
const _sfc_main$10 = /* @__PURE__ */ defineComponent({
  __name: "VPFeatures",
  __ssrInlineRender: true,
  props: {
    features: {}
  },
  setup(__props) {
    const props = __props;
    const grid = computed(() => {
      const length = props.features.length;
      if (!length) {
        return;
      } else if (length === 2) {
        return "grid-2";
      } else if (length === 3) {
        return "grid-3";
      } else if (length % 3 === 0) {
        return "grid-6";
      } else if (length > 3) {
        return "grid-4";
      }
    });
    return (_ctx, _push, _parent, _attrs) => {
      if (__props.features) {
        _push(`<div${ssrRenderAttrs(mergeProps({ class: "VPFeatures" }, _attrs))} data-v-951fcbdc><div class="container" data-v-951fcbdc><div class="items" data-v-951fcbdc><!--[-->`);
        ssrRenderList(__props.features, (feature) => {
          _push(`<div class="${ssrRenderClass([[grid.value], "item"])}" data-v-951fcbdc>`);
          _push(ssrRenderComponent(VPFeature, {
            icon: feature.icon,
            title: feature.title,
            details: feature.details,
            link: feature.link,
            "link-text": feature.linkText,
            rel: feature.rel,
            target: feature.target
          }, null, _parent));
          _push(`</div>`);
        });
        _push(`<!--]--></div></div></div>`);
      } else {
        _push(`<!---->`);
      }
    };
  }
});
const _sfc_setup$10 = _sfc_main$10.setup;
_sfc_main$10.setup = (props, ctx) => {
  const ssrContext = useSSRContext();
  (ssrContext.modules || (ssrContext.modules = /* @__PURE__ */ new Set())).add("../../node_modules/.pnpm/vitepress@1.6.4_@algolia+client-search@5.55.2_@types+node@24.13.3_@types+react@18.3.31__6511206dab6d3da37418cf3428952e99/node_modules/vitepress/dist/client/theme-default/components/VPFeatures.vue");
  return _sfc_setup$10 ? _sfc_setup$10(props, ctx) : void 0;
};
const VPFeatures = /* @__PURE__ */ _export_sfc(_sfc_main$10, [["__scopeId", "data-v-951fcbdc"]]);
const _sfc_main$$ = /* @__PURE__ */ defineComponent({
  __name: "VPHomeFeatures",
  __ssrInlineRender: true,
  setup(__props) {
    const { frontmatter: fm } = useData();
    return (_ctx, _push, _parent, _attrs) => {
      if (unref(fm).features) {
        _push(ssrRenderComponent(VPFeatures, mergeProps({
          class: "VPHomeFeatures",
          features: unref(fm).features
        }, _attrs), null, _parent));
      } else {
        _push(`<!---->`);
      }
    };
  }
});
const _sfc_setup$$ = _sfc_main$$.setup;
_sfc_main$$.setup = (props, ctx) => {
  const ssrContext = useSSRContext();
  (ssrContext.modules || (ssrContext.modules = /* @__PURE__ */ new Set())).add("../../node_modules/.pnpm/vitepress@1.6.4_@algolia+client-search@5.55.2_@types+node@24.13.3_@types+react@18.3.31__6511206dab6d3da37418cf3428952e99/node_modules/vitepress/dist/client/theme-default/components/VPHomeFeatures.vue");
  return _sfc_setup$$ ? _sfc_setup$$(props, ctx) : void 0;
};
const _sfc_main$_ = /* @__PURE__ */ defineComponent({
  __name: "VPHomeContent",
  __ssrInlineRender: true,
  setup(__props) {
    const { width: vw } = useWindowSize({
      initialWidth: 0,
      includeScrollbar: false
    });
    return (_ctx, _push, _parent, _attrs) => {
      _push(`<div${ssrRenderAttrs(mergeProps({
        class: "vp-doc container",
        style: unref(vw) ? { "--vp-offset": `calc(50% - ${unref(vw) / 2}px)` } : {}
      }, _attrs))} data-v-99be18f8>`);
      ssrRenderSlot(_ctx.$slots, "default", {}, null, _push, _parent);
      _push(`</div>`);
    };
  }
});
const _sfc_setup$_ = _sfc_main$_.setup;
_sfc_main$_.setup = (props, ctx) => {
  const ssrContext = useSSRContext();
  (ssrContext.modules || (ssrContext.modules = /* @__PURE__ */ new Set())).add("../../node_modules/.pnpm/vitepress@1.6.4_@algolia+client-search@5.55.2_@types+node@24.13.3_@types+react@18.3.31__6511206dab6d3da37418cf3428952e99/node_modules/vitepress/dist/client/theme-default/components/VPHomeContent.vue");
  return _sfc_setup$_ ? _sfc_setup$_(props, ctx) : void 0;
};
const VPHomeContent = /* @__PURE__ */ _export_sfc(_sfc_main$_, [["__scopeId", "data-v-99be18f8"]]);
const _sfc_main$Z = /* @__PURE__ */ defineComponent({
  __name: "VPHome",
  __ssrInlineRender: true,
  setup(__props) {
    const { frontmatter, theme: theme2 } = useData();
    return (_ctx, _push, _parent, _attrs) => {
      const _component_Content = resolveComponent("Content");
      _push(`<div${ssrRenderAttrs(mergeProps({
        class: ["VPHome", {
          "external-link-icon-enabled": unref(theme2).externalLinkIcon
        }]
      }, _attrs))} data-v-a1f9ffb3>`);
      ssrRenderSlot(_ctx.$slots, "home-hero-before", {}, null, _push, _parent);
      _push(ssrRenderComponent(_sfc_main$12, null, {
        "home-hero-info-before": withCtx((_, _push2, _parent2, _scopeId) => {
          if (_push2) {
            ssrRenderSlot(_ctx.$slots, "home-hero-info-before", {}, null, _push2, _parent2, _scopeId);
          } else {
            return [
              renderSlot(_ctx.$slots, "home-hero-info-before", {}, void 0, true)
            ];
          }
        }),
        "home-hero-info": withCtx((_, _push2, _parent2, _scopeId) => {
          if (_push2) {
            ssrRenderSlot(_ctx.$slots, "home-hero-info", {}, null, _push2, _parent2, _scopeId);
          } else {
            return [
              renderSlot(_ctx.$slots, "home-hero-info", {}, void 0, true)
            ];
          }
        }),
        "home-hero-info-after": withCtx((_, _push2, _parent2, _scopeId) => {
          if (_push2) {
            ssrRenderSlot(_ctx.$slots, "home-hero-info-after", {}, null, _push2, _parent2, _scopeId);
          } else {
            return [
              renderSlot(_ctx.$slots, "home-hero-info-after", {}, void 0, true)
            ];
          }
        }),
        "home-hero-actions-after": withCtx((_, _push2, _parent2, _scopeId) => {
          if (_push2) {
            ssrRenderSlot(_ctx.$slots, "home-hero-actions-after", {}, null, _push2, _parent2, _scopeId);
          } else {
            return [
              renderSlot(_ctx.$slots, "home-hero-actions-after", {}, void 0, true)
            ];
          }
        }),
        "home-hero-image": withCtx((_, _push2, _parent2, _scopeId) => {
          if (_push2) {
            ssrRenderSlot(_ctx.$slots, "home-hero-image", {}, null, _push2, _parent2, _scopeId);
          } else {
            return [
              renderSlot(_ctx.$slots, "home-hero-image", {}, void 0, true)
            ];
          }
        }),
        _: 3
      }, _parent));
      ssrRenderSlot(_ctx.$slots, "home-hero-after", {}, null, _push, _parent);
      ssrRenderSlot(_ctx.$slots, "home-features-before", {}, null, _push, _parent);
      _push(ssrRenderComponent(_sfc_main$$, null, null, _parent));
      ssrRenderSlot(_ctx.$slots, "home-features-after", {}, null, _push, _parent);
      if (unref(frontmatter).markdownStyles !== false) {
        _push(ssrRenderComponent(VPHomeContent, null, {
          default: withCtx((_, _push2, _parent2, _scopeId) => {
            if (_push2) {
              _push2(ssrRenderComponent(_component_Content, null, null, _parent2, _scopeId));
            } else {
              return [
                createVNode(_component_Content)
              ];
            }
          }),
          _: 1
        }, _parent));
      } else {
        _push(ssrRenderComponent(_component_Content, null, null, _parent));
      }
      _push(`</div>`);
    };
  }
});
const _sfc_setup$Z = _sfc_main$Z.setup;
_sfc_main$Z.setup = (props, ctx) => {
  const ssrContext = useSSRContext();
  (ssrContext.modules || (ssrContext.modules = /* @__PURE__ */ new Set())).add("../../node_modules/.pnpm/vitepress@1.6.4_@algolia+client-search@5.55.2_@types+node@24.13.3_@types+react@18.3.31__6511206dab6d3da37418cf3428952e99/node_modules/vitepress/dist/client/theme-default/components/VPHome.vue");
  return _sfc_setup$Z ? _sfc_setup$Z(props, ctx) : void 0;
};
const VPHome = /* @__PURE__ */ _export_sfc(_sfc_main$Z, [["__scopeId", "data-v-a1f9ffb3"]]);
const _sfc_main$Y = {};
function _sfc_ssrRender$1(_ctx, _push, _parent, _attrs) {
  const _component_Content = resolveComponent("Content");
  _push(`<div${ssrRenderAttrs(mergeProps({ class: "VPPage" }, _attrs))}>`);
  ssrRenderSlot(_ctx.$slots, "page-top", {}, null, _push, _parent);
  _push(ssrRenderComponent(_component_Content, null, null, _parent));
  ssrRenderSlot(_ctx.$slots, "page-bottom", {}, null, _push, _parent);
  _push(`</div>`);
}
const _sfc_setup$Y = _sfc_main$Y.setup;
_sfc_main$Y.setup = (props, ctx) => {
  const ssrContext = useSSRContext();
  (ssrContext.modules || (ssrContext.modules = /* @__PURE__ */ new Set())).add("../../node_modules/.pnpm/vitepress@1.6.4_@algolia+client-search@5.55.2_@types+node@24.13.3_@types+react@18.3.31__6511206dab6d3da37418cf3428952e99/node_modules/vitepress/dist/client/theme-default/components/VPPage.vue");
  return _sfc_setup$Y ? _sfc_setup$Y(props, ctx) : void 0;
};
const VPPage = /* @__PURE__ */ _export_sfc(_sfc_main$Y, [["ssrRender", _sfc_ssrRender$1]]);
const _sfc_main$X = /* @__PURE__ */ defineComponent({
  __name: "VPContent",
  __ssrInlineRender: true,
  setup(__props) {
    const { page, frontmatter } = useData();
    const { hasSidebar } = useSidebar();
    return (_ctx, _push, _parent, _attrs) => {
      _push(`<div${ssrRenderAttrs(mergeProps({
        class: ["VPContent", {
          "has-sidebar": unref(hasSidebar),
          "is-home": unref(frontmatter).layout === "home"
        }],
        id: "VPContent"
      }, _attrs))} data-v-9c0a2ba9>`);
      if (unref(page).isNotFound) {
        ssrRenderSlot(_ctx.$slots, "not-found", {}, () => {
          _push(ssrRenderComponent(NotFound, null, null, _parent));
        }, _push, _parent);
      } else if (unref(frontmatter).layout === "page") {
        _push(ssrRenderComponent(VPPage, null, {
          "page-top": withCtx((_, _push2, _parent2, _scopeId) => {
            if (_push2) {
              ssrRenderSlot(_ctx.$slots, "page-top", {}, null, _push2, _parent2, _scopeId);
            } else {
              return [
                renderSlot(_ctx.$slots, "page-top", {}, void 0, true)
              ];
            }
          }),
          "page-bottom": withCtx((_, _push2, _parent2, _scopeId) => {
            if (_push2) {
              ssrRenderSlot(_ctx.$slots, "page-bottom", {}, null, _push2, _parent2, _scopeId);
            } else {
              return [
                renderSlot(_ctx.$slots, "page-bottom", {}, void 0, true)
              ];
            }
          }),
          _: 3
        }, _parent));
      } else if (unref(frontmatter).layout === "home") {
        _push(ssrRenderComponent(VPHome, null, {
          "home-hero-before": withCtx((_, _push2, _parent2, _scopeId) => {
            if (_push2) {
              ssrRenderSlot(_ctx.$slots, "home-hero-before", {}, null, _push2, _parent2, _scopeId);
            } else {
              return [
                renderSlot(_ctx.$slots, "home-hero-before", {}, void 0, true)
              ];
            }
          }),
          "home-hero-info-before": withCtx((_, _push2, _parent2, _scopeId) => {
            if (_push2) {
              ssrRenderSlot(_ctx.$slots, "home-hero-info-before", {}, null, _push2, _parent2, _scopeId);
            } else {
              return [
                renderSlot(_ctx.$slots, "home-hero-info-before", {}, void 0, true)
              ];
            }
          }),
          "home-hero-info": withCtx((_, _push2, _parent2, _scopeId) => {
            if (_push2) {
              ssrRenderSlot(_ctx.$slots, "home-hero-info", {}, null, _push2, _parent2, _scopeId);
            } else {
              return [
                renderSlot(_ctx.$slots, "home-hero-info", {}, void 0, true)
              ];
            }
          }),
          "home-hero-info-after": withCtx((_, _push2, _parent2, _scopeId) => {
            if (_push2) {
              ssrRenderSlot(_ctx.$slots, "home-hero-info-after", {}, null, _push2, _parent2, _scopeId);
            } else {
              return [
                renderSlot(_ctx.$slots, "home-hero-info-after", {}, void 0, true)
              ];
            }
          }),
          "home-hero-actions-after": withCtx((_, _push2, _parent2, _scopeId) => {
            if (_push2) {
              ssrRenderSlot(_ctx.$slots, "home-hero-actions-after", {}, null, _push2, _parent2, _scopeId);
            } else {
              return [
                renderSlot(_ctx.$slots, "home-hero-actions-after", {}, void 0, true)
              ];
            }
          }),
          "home-hero-image": withCtx((_, _push2, _parent2, _scopeId) => {
            if (_push2) {
              ssrRenderSlot(_ctx.$slots, "home-hero-image", {}, null, _push2, _parent2, _scopeId);
            } else {
              return [
                renderSlot(_ctx.$slots, "home-hero-image", {}, void 0, true)
              ];
            }
          }),
          "home-hero-after": withCtx((_, _push2, _parent2, _scopeId) => {
            if (_push2) {
              ssrRenderSlot(_ctx.$slots, "home-hero-after", {}, null, _push2, _parent2, _scopeId);
            } else {
              return [
                renderSlot(_ctx.$slots, "home-hero-after", {}, void 0, true)
              ];
            }
          }),
          "home-features-before": withCtx((_, _push2, _parent2, _scopeId) => {
            if (_push2) {
              ssrRenderSlot(_ctx.$slots, "home-features-before", {}, null, _push2, _parent2, _scopeId);
            } else {
              return [
                renderSlot(_ctx.$slots, "home-features-before", {}, void 0, true)
              ];
            }
          }),
          "home-features-after": withCtx((_, _push2, _parent2, _scopeId) => {
            if (_push2) {
              ssrRenderSlot(_ctx.$slots, "home-features-after", {}, null, _push2, _parent2, _scopeId);
            } else {
              return [
                renderSlot(_ctx.$slots, "home-features-after", {}, void 0, true)
              ];
            }
          }),
          _: 3
        }, _parent));
      } else if (unref(frontmatter).layout && unref(frontmatter).layout !== "doc") {
        ssrRenderVNode(_push, createVNode(resolveDynamicComponent(unref(frontmatter).layout), null, null), _parent);
      } else {
        _push(ssrRenderComponent(VPDoc, null, {
          "doc-top": withCtx((_, _push2, _parent2, _scopeId) => {
            if (_push2) {
              ssrRenderSlot(_ctx.$slots, "doc-top", {}, null, _push2, _parent2, _scopeId);
            } else {
              return [
                renderSlot(_ctx.$slots, "doc-top", {}, void 0, true)
              ];
            }
          }),
          "doc-bottom": withCtx((_, _push2, _parent2, _scopeId) => {
            if (_push2) {
              ssrRenderSlot(_ctx.$slots, "doc-bottom", {}, null, _push2, _parent2, _scopeId);
            } else {
              return [
                renderSlot(_ctx.$slots, "doc-bottom", {}, void 0, true)
              ];
            }
          }),
          "doc-footer-before": withCtx((_, _push2, _parent2, _scopeId) => {
            if (_push2) {
              ssrRenderSlot(_ctx.$slots, "doc-footer-before", {}, null, _push2, _parent2, _scopeId);
            } else {
              return [
                renderSlot(_ctx.$slots, "doc-footer-before", {}, void 0, true)
              ];
            }
          }),
          "doc-before": withCtx((_, _push2, _parent2, _scopeId) => {
            if (_push2) {
              ssrRenderSlot(_ctx.$slots, "doc-before", {}, null, _push2, _parent2, _scopeId);
            } else {
              return [
                renderSlot(_ctx.$slots, "doc-before", {}, void 0, true)
              ];
            }
          }),
          "doc-after": withCtx((_, _push2, _parent2, _scopeId) => {
            if (_push2) {
              ssrRenderSlot(_ctx.$slots, "doc-after", {}, null, _push2, _parent2, _scopeId);
            } else {
              return [
                renderSlot(_ctx.$slots, "doc-after", {}, void 0, true)
              ];
            }
          }),
          "aside-top": withCtx((_, _push2, _parent2, _scopeId) => {
            if (_push2) {
              ssrRenderSlot(_ctx.$slots, "aside-top", {}, null, _push2, _parent2, _scopeId);
            } else {
              return [
                renderSlot(_ctx.$slots, "aside-top", {}, void 0, true)
              ];
            }
          }),
          "aside-outline-before": withCtx((_, _push2, _parent2, _scopeId) => {
            if (_push2) {
              ssrRenderSlot(_ctx.$slots, "aside-outline-before", {}, null, _push2, _parent2, _scopeId);
            } else {
              return [
                renderSlot(_ctx.$slots, "aside-outline-before", {}, void 0, true)
              ];
            }
          }),
          "aside-outline-after": withCtx((_, _push2, _parent2, _scopeId) => {
            if (_push2) {
              ssrRenderSlot(_ctx.$slots, "aside-outline-after", {}, null, _push2, _parent2, _scopeId);
            } else {
              return [
                renderSlot(_ctx.$slots, "aside-outline-after", {}, void 0, true)
              ];
            }
          }),
          "aside-ads-before": withCtx((_, _push2, _parent2, _scopeId) => {
            if (_push2) {
              ssrRenderSlot(_ctx.$slots, "aside-ads-before", {}, null, _push2, _parent2, _scopeId);
            } else {
              return [
                renderSlot(_ctx.$slots, "aside-ads-before", {}, void 0, true)
              ];
            }
          }),
          "aside-ads-after": withCtx((_, _push2, _parent2, _scopeId) => {
            if (_push2) {
              ssrRenderSlot(_ctx.$slots, "aside-ads-after", {}, null, _push2, _parent2, _scopeId);
            } else {
              return [
                renderSlot(_ctx.$slots, "aside-ads-after", {}, void 0, true)
              ];
            }
          }),
          "aside-bottom": withCtx((_, _push2, _parent2, _scopeId) => {
            if (_push2) {
              ssrRenderSlot(_ctx.$slots, "aside-bottom", {}, null, _push2, _parent2, _scopeId);
            } else {
              return [
                renderSlot(_ctx.$slots, "aside-bottom", {}, void 0, true)
              ];
            }
          }),
          _: 3
        }, _parent));
      }
      _push(`</div>`);
    };
  }
});
const _sfc_setup$X = _sfc_main$X.setup;
_sfc_main$X.setup = (props, ctx) => {
  const ssrContext = useSSRContext();
  (ssrContext.modules || (ssrContext.modules = /* @__PURE__ */ new Set())).add("../../node_modules/.pnpm/vitepress@1.6.4_@algolia+client-search@5.55.2_@types+node@24.13.3_@types+react@18.3.31__6511206dab6d3da37418cf3428952e99/node_modules/vitepress/dist/client/theme-default/components/VPContent.vue");
  return _sfc_setup$X ? _sfc_setup$X(props, ctx) : void 0;
};
const VPContent = /* @__PURE__ */ _export_sfc(_sfc_main$X, [["__scopeId", "data-v-9c0a2ba9"]]);
const _sfc_main$W = /* @__PURE__ */ defineComponent({
  __name: "VPFooter",
  __ssrInlineRender: true,
  setup(__props) {
    const { theme: theme2, frontmatter } = useData();
    const { hasSidebar } = useSidebar();
    return (_ctx, _push, _parent, _attrs) => {
      if (unref(theme2).footer && unref(frontmatter).footer !== false) {
        _push(`<footer${ssrRenderAttrs(mergeProps({
          class: ["VPFooter", { "has-sidebar": unref(hasSidebar) }]
        }, _attrs))} data-v-c171ced7><div class="container" data-v-c171ced7>`);
        if (unref(theme2).footer.message) {
          _push(`<p class="message" data-v-c171ced7>${unref(theme2).footer.message ?? ""}</p>`);
        } else {
          _push(`<!---->`);
        }
        if (unref(theme2).footer.copyright) {
          _push(`<p class="copyright" data-v-c171ced7>${unref(theme2).footer.copyright ?? ""}</p>`);
        } else {
          _push(`<!---->`);
        }
        _push(`</div></footer>`);
      } else {
        _push(`<!---->`);
      }
    };
  }
});
const _sfc_setup$W = _sfc_main$W.setup;
_sfc_main$W.setup = (props, ctx) => {
  const ssrContext = useSSRContext();
  (ssrContext.modules || (ssrContext.modules = /* @__PURE__ */ new Set())).add("../../node_modules/.pnpm/vitepress@1.6.4_@algolia+client-search@5.55.2_@types+node@24.13.3_@types+react@18.3.31__6511206dab6d3da37418cf3428952e99/node_modules/vitepress/dist/client/theme-default/components/VPFooter.vue");
  return _sfc_setup$W ? _sfc_setup$W(props, ctx) : void 0;
};
const VPFooter = /* @__PURE__ */ _export_sfc(_sfc_main$W, [["__scopeId", "data-v-c171ced7"]]);
function useLocalNav() {
  const { theme: theme2, frontmatter } = useData();
  const headers = shallowRef([]);
  const hasLocalNav = computed(() => {
    return headers.value.length > 0;
  });
  onContentUpdated(() => {
    headers.value = getHeaders(frontmatter.value.outline ?? theme2.value.outline);
  });
  return {
    headers,
    hasLocalNav
  };
}
const _sfc_main$V = /* @__PURE__ */ defineComponent({
  __name: "VPLocalNavOutlineDropdown",
  __ssrInlineRender: true,
  props: {
    headers: {},
    navHeight: {}
  },
  setup(__props) {
    const { theme: theme2 } = useData();
    const open = ref(false);
    const vh = ref(0);
    const main = ref();
    ref();
    function closeOnClickOutside(e) {
      var _a;
      if (!((_a = main.value) == null ? void 0 : _a.contains(e.target))) {
        open.value = false;
      }
    }
    watch(open, (value) => {
      if (value) {
        document.addEventListener("click", closeOnClickOutside);
        return;
      }
      document.removeEventListener("click", closeOnClickOutside);
    });
    onKeyStroke("Escape", () => {
      open.value = false;
    });
    onContentUpdated(() => {
      open.value = false;
    });
    return (_ctx, _push, _parent, _attrs) => {
      _push(`<div${ssrRenderAttrs(mergeProps({
        class: "VPLocalNavOutlineDropdown",
        style: { "--vp-vh": vh.value + "px" },
        ref_key: "main",
        ref: main
      }, _attrs))} data-v-19bbb3e3>`);
      if (__props.headers.length > 0) {
        _push(`<button class="${ssrRenderClass({ open: open.value })}" data-v-19bbb3e3><span class="menu-text" data-v-19bbb3e3>${ssrInterpolate(unref(resolveTitle)(unref(theme2)))}</span><span class="vpi-chevron-right icon" data-v-19bbb3e3></span></button>`);
      } else {
        _push(`<button data-v-19bbb3e3>${ssrInterpolate(unref(theme2).returnToTopLabel || "Return to top")}</button>`);
      }
      if (open.value) {
        _push(`<div class="items" data-v-19bbb3e3><div class="header" data-v-19bbb3e3><a class="top-link" href="#" data-v-19bbb3e3>${ssrInterpolate(unref(theme2).returnToTopLabel || "Return to top")}</a></div><div class="outline" data-v-19bbb3e3>`);
        _push(ssrRenderComponent(VPDocOutlineItem, { headers: __props.headers }, null, _parent));
        _push(`</div></div>`);
      } else {
        _push(`<!---->`);
      }
      _push(`</div>`);
    };
  }
});
const _sfc_setup$V = _sfc_main$V.setup;
_sfc_main$V.setup = (props, ctx) => {
  const ssrContext = useSSRContext();
  (ssrContext.modules || (ssrContext.modules = /* @__PURE__ */ new Set())).add("../../node_modules/.pnpm/vitepress@1.6.4_@algolia+client-search@5.55.2_@types+node@24.13.3_@types+react@18.3.31__6511206dab6d3da37418cf3428952e99/node_modules/vitepress/dist/client/theme-default/components/VPLocalNavOutlineDropdown.vue");
  return _sfc_setup$V ? _sfc_setup$V(props, ctx) : void 0;
};
const VPLocalNavOutlineDropdown = /* @__PURE__ */ _export_sfc(_sfc_main$V, [["__scopeId", "data-v-19bbb3e3"]]);
const _sfc_main$U = /* @__PURE__ */ defineComponent({
  __name: "VPLocalNav",
  __ssrInlineRender: true,
  props: {
    open: { type: Boolean }
  },
  emits: ["open-menu"],
  setup(__props) {
    const { theme: theme2, frontmatter } = useData();
    const { hasSidebar } = useSidebar();
    const { headers } = useLocalNav();
    const { y } = useWindowScroll();
    const navHeight = ref(0);
    onMounted(() => {
      navHeight.value = parseInt(
        getComputedStyle(document.documentElement).getPropertyValue(
          "--vp-nav-height"
        )
      );
    });
    onContentUpdated(() => {
      headers.value = getHeaders(frontmatter.value.outline ?? theme2.value.outline);
    });
    const empty = computed(() => {
      return headers.value.length === 0;
    });
    const emptyAndNoSidebar = computed(() => {
      return empty.value && !hasSidebar.value;
    });
    const classes = computed(() => {
      return {
        VPLocalNav: true,
        "has-sidebar": hasSidebar.value,
        empty: empty.value,
        fixed: emptyAndNoSidebar.value
      };
    });
    return (_ctx, _push, _parent, _attrs) => {
      if (unref(frontmatter).layout !== "home" && (!emptyAndNoSidebar.value || unref(y) >= navHeight.value)) {
        _push(`<div${ssrRenderAttrs(mergeProps({ class: classes.value }, _attrs))} data-v-9dffd3b3><div class="container" data-v-9dffd3b3>`);
        if (unref(hasSidebar)) {
          _push(`<button class="menu"${ssrRenderAttr("aria-expanded", __props.open)} aria-controls="VPSidebarNav" data-v-9dffd3b3><span class="vpi-align-left menu-icon" data-v-9dffd3b3></span><span class="menu-text" data-v-9dffd3b3>${ssrInterpolate(unref(theme2).sidebarMenuLabel || "Menu")}</span></button>`);
        } else {
          _push(`<!---->`);
        }
        _push(ssrRenderComponent(VPLocalNavOutlineDropdown, {
          headers: unref(headers),
          navHeight: navHeight.value
        }, null, _parent));
        _push(`</div></div>`);
      } else {
        _push(`<!---->`);
      }
    };
  }
});
const _sfc_setup$U = _sfc_main$U.setup;
_sfc_main$U.setup = (props, ctx) => {
  const ssrContext = useSSRContext();
  (ssrContext.modules || (ssrContext.modules = /* @__PURE__ */ new Set())).add("../../node_modules/.pnpm/vitepress@1.6.4_@algolia+client-search@5.55.2_@types+node@24.13.3_@types+react@18.3.31__6511206dab6d3da37418cf3428952e99/node_modules/vitepress/dist/client/theme-default/components/VPLocalNav.vue");
  return _sfc_setup$U ? _sfc_setup$U(props, ctx) : void 0;
};
const VPLocalNav = /* @__PURE__ */ _export_sfc(_sfc_main$U, [["__scopeId", "data-v-9dffd3b3"]]);
function useNav() {
  const isScreenOpen = ref(false);
  function openScreen() {
    isScreenOpen.value = true;
    window.addEventListener("resize", closeScreenOnTabletWindow);
  }
  function closeScreen() {
    isScreenOpen.value = false;
    window.removeEventListener("resize", closeScreenOnTabletWindow);
  }
  function toggleScreen() {
    isScreenOpen.value ? closeScreen() : openScreen();
  }
  function closeScreenOnTabletWindow() {
    window.outerWidth >= 768 && closeScreen();
  }
  const route = useRoute();
  watch(() => route.path, closeScreen);
  return {
    isScreenOpen,
    openScreen,
    closeScreen,
    toggleScreen
  };
}
const _sfc_main$T = {};
function _sfc_ssrRender(_ctx, _push, _parent, _attrs) {
  _push(`<button${ssrRenderAttrs(mergeProps({
    class: "VPSwitch",
    type: "button",
    role: "switch"
  }, _attrs))} data-v-42e0fd20><span class="check" data-v-42e0fd20>`);
  if (_ctx.$slots.default) {
    _push(`<span class="icon" data-v-42e0fd20>`);
    ssrRenderSlot(_ctx.$slots, "default", {}, null, _push, _parent);
    _push(`</span>`);
  } else {
    _push(`<!---->`);
  }
  _push(`</span></button>`);
}
const _sfc_setup$T = _sfc_main$T.setup;
_sfc_main$T.setup = (props, ctx) => {
  const ssrContext = useSSRContext();
  (ssrContext.modules || (ssrContext.modules = /* @__PURE__ */ new Set())).add("../../node_modules/.pnpm/vitepress@1.6.4_@algolia+client-search@5.55.2_@types+node@24.13.3_@types+react@18.3.31__6511206dab6d3da37418cf3428952e99/node_modules/vitepress/dist/client/theme-default/components/VPSwitch.vue");
  return _sfc_setup$T ? _sfc_setup$T(props, ctx) : void 0;
};
const VPSwitch = /* @__PURE__ */ _export_sfc(_sfc_main$T, [["ssrRender", _sfc_ssrRender], ["__scopeId", "data-v-42e0fd20"]]);
const _sfc_main$S = /* @__PURE__ */ defineComponent({
  __name: "VPSwitchAppearance",
  __ssrInlineRender: true,
  setup(__props) {
    const { isDark, theme: theme2 } = useData();
    const toggleAppearance = inject("toggle-appearance", () => {
      isDark.value = !isDark.value;
    });
    const switchTitle = ref("");
    watchPostEffect(() => {
      switchTitle.value = isDark.value ? theme2.value.lightModeSwitchTitle || "Switch to light theme" : theme2.value.darkModeSwitchTitle || "Switch to dark theme";
    });
    return (_ctx, _push, _parent, _attrs) => {
      _push(ssrRenderComponent(VPSwitch, mergeProps({
        title: switchTitle.value,
        class: "VPSwitchAppearance",
        "aria-checked": unref(isDark),
        onClick: unref(toggleAppearance)
      }, _attrs), {
        default: withCtx((_, _push2, _parent2, _scopeId) => {
          if (_push2) {
            _push2(`<span class="vpi-sun sun" data-v-dd85c4fe${_scopeId}></span><span class="vpi-moon moon" data-v-dd85c4fe${_scopeId}></span>`);
          } else {
            return [
              createVNode("span", { class: "vpi-sun sun" }),
              createVNode("span", { class: "vpi-moon moon" })
            ];
          }
        }),
        _: 1
      }, _parent));
    };
  }
});
const _sfc_setup$S = _sfc_main$S.setup;
_sfc_main$S.setup = (props, ctx) => {
  const ssrContext = useSSRContext();
  (ssrContext.modules || (ssrContext.modules = /* @__PURE__ */ new Set())).add("../../node_modules/.pnpm/vitepress@1.6.4_@algolia+client-search@5.55.2_@types+node@24.13.3_@types+react@18.3.31__6511206dab6d3da37418cf3428952e99/node_modules/vitepress/dist/client/theme-default/components/VPSwitchAppearance.vue");
  return _sfc_setup$S ? _sfc_setup$S(props, ctx) : void 0;
};
const VPSwitchAppearance = /* @__PURE__ */ _export_sfc(_sfc_main$S, [["__scopeId", "data-v-dd85c4fe"]]);
const _sfc_main$R = /* @__PURE__ */ defineComponent({
  __name: "VPNavBarAppearance",
  __ssrInlineRender: true,
  setup(__props) {
    const { site } = useData();
    return (_ctx, _push, _parent, _attrs) => {
      if (unref(site).appearance && unref(site).appearance !== "force-dark" && unref(site).appearance !== "force-auto") {
        _push(`<div${ssrRenderAttrs(mergeProps({ class: "VPNavBarAppearance" }, _attrs))} data-v-610618b7>`);
        _push(ssrRenderComponent(VPSwitchAppearance, null, null, _parent));
        _push(`</div>`);
      } else {
        _push(`<!---->`);
      }
    };
  }
});
const _sfc_setup$R = _sfc_main$R.setup;
_sfc_main$R.setup = (props, ctx) => {
  const ssrContext = useSSRContext();
  (ssrContext.modules || (ssrContext.modules = /* @__PURE__ */ new Set())).add("../../node_modules/.pnpm/vitepress@1.6.4_@algolia+client-search@5.55.2_@types+node@24.13.3_@types+react@18.3.31__6511206dab6d3da37418cf3428952e99/node_modules/vitepress/dist/client/theme-default/components/VPNavBarAppearance.vue");
  return _sfc_setup$R ? _sfc_setup$R(props, ctx) : void 0;
};
const VPNavBarAppearance = /* @__PURE__ */ _export_sfc(_sfc_main$R, [["__scopeId", "data-v-610618b7"]]);
const focusedElement = ref();
let active = false;
let listeners = 0;
function useFlyout(options) {
  const focus = ref(false);
  if (inBrowser) {
    !active && activateFocusTracking();
    listeners++;
    const unwatch = watch(focusedElement, (el) => {
      var _a, _b, _c;
      if (el === options.el.value || ((_a = options.el.value) == null ? void 0 : _a.contains(el))) {
        focus.value = true;
        (_b = options.onFocus) == null ? void 0 : _b.call(options);
      } else {
        focus.value = false;
        (_c = options.onBlur) == null ? void 0 : _c.call(options);
      }
    });
    onUnmounted(() => {
      unwatch();
      listeners--;
      if (!listeners) {
        deactivateFocusTracking();
      }
    });
  }
  return readonly(focus);
}
function activateFocusTracking() {
  document.addEventListener("focusin", handleFocusIn);
  active = true;
  focusedElement.value = document.activeElement;
}
function deactivateFocusTracking() {
  document.removeEventListener("focusin", handleFocusIn);
}
function handleFocusIn() {
  focusedElement.value = document.activeElement;
}
const _sfc_main$Q = /* @__PURE__ */ defineComponent({
  __name: "VPMenuLink",
  __ssrInlineRender: true,
  props: {
    item: {}
  },
  setup(__props) {
    const { page } = useData();
    return (_ctx, _push, _parent, _attrs) => {
      _push(`<div${ssrRenderAttrs(mergeProps({ class: "VPMenuLink" }, _attrs))} data-v-ea28bd5d>`);
      _push(ssrRenderComponent(_sfc_main$19, {
        class: {
          active: unref(isActive)(
            unref(page).relativePath,
            __props.item.activeMatch || __props.item.link,
            !!__props.item.activeMatch
          )
        },
        href: __props.item.link,
        target: __props.item.target,
        rel: __props.item.rel,
        "no-icon": __props.item.noIcon
      }, {
        default: withCtx((_, _push2, _parent2, _scopeId) => {
          if (_push2) {
            _push2(`<span data-v-ea28bd5d${_scopeId}>${__props.item.text ?? ""}</span>`);
          } else {
            return [
              createVNode("span", {
                innerHTML: __props.item.text
              }, null, 8, ["innerHTML"])
            ];
          }
        }),
        _: 1
      }, _parent));
      _push(`</div>`);
    };
  }
});
const _sfc_setup$Q = _sfc_main$Q.setup;
_sfc_main$Q.setup = (props, ctx) => {
  const ssrContext = useSSRContext();
  (ssrContext.modules || (ssrContext.modules = /* @__PURE__ */ new Set())).add("../../node_modules/.pnpm/vitepress@1.6.4_@algolia+client-search@5.55.2_@types+node@24.13.3_@types+react@18.3.31__6511206dab6d3da37418cf3428952e99/node_modules/vitepress/dist/client/theme-default/components/VPMenuLink.vue");
  return _sfc_setup$Q ? _sfc_setup$Q(props, ctx) : void 0;
};
const VPMenuLink = /* @__PURE__ */ _export_sfc(_sfc_main$Q, [["__scopeId", "data-v-ea28bd5d"]]);
const _sfc_main$P = /* @__PURE__ */ defineComponent({
  __name: "VPMenuGroup",
  __ssrInlineRender: true,
  props: {
    text: {},
    items: {}
  },
  setup(__props) {
    return (_ctx, _push, _parent, _attrs) => {
      _push(`<div${ssrRenderAttrs(mergeProps({ class: "VPMenuGroup" }, _attrs))} data-v-a28caf57>`);
      if (__props.text) {
        _push(`<p class="title" data-v-a28caf57>${ssrInterpolate(__props.text)}</p>`);
      } else {
        _push(`<!---->`);
      }
      _push(`<!--[-->`);
      ssrRenderList(__props.items, (item) => {
        _push(`<!--[-->`);
        if ("link" in item) {
          _push(ssrRenderComponent(VPMenuLink, { item }, null, _parent));
        } else {
          _push(`<!---->`);
        }
        _push(`<!--]-->`);
      });
      _push(`<!--]--></div>`);
    };
  }
});
const _sfc_setup$P = _sfc_main$P.setup;
_sfc_main$P.setup = (props, ctx) => {
  const ssrContext = useSSRContext();
  (ssrContext.modules || (ssrContext.modules = /* @__PURE__ */ new Set())).add("../../node_modules/.pnpm/vitepress@1.6.4_@algolia+client-search@5.55.2_@types+node@24.13.3_@types+react@18.3.31__6511206dab6d3da37418cf3428952e99/node_modules/vitepress/dist/client/theme-default/components/VPMenuGroup.vue");
  return _sfc_setup$P ? _sfc_setup$P(props, ctx) : void 0;
};
const VPMenuGroup = /* @__PURE__ */ _export_sfc(_sfc_main$P, [["__scopeId", "data-v-a28caf57"]]);
const _sfc_main$O = /* @__PURE__ */ defineComponent({
  __name: "VPMenu",
  __ssrInlineRender: true,
  props: {
    items: {}
  },
  setup(__props) {
    return (_ctx, _push, _parent, _attrs) => {
      _push(`<div${ssrRenderAttrs(mergeProps({ class: "VPMenu" }, _attrs))} data-v-e9030899>`);
      if (__props.items) {
        _push(`<div class="items" data-v-e9030899><!--[-->`);
        ssrRenderList(__props.items, (item) => {
          _push(`<!--[-->`);
          if ("link" in item) {
            _push(ssrRenderComponent(VPMenuLink, { item }, null, _parent));
          } else if ("component" in item) {
            ssrRenderVNode(_push, createVNode(resolveDynamicComponent(item.component), mergeProps({ ref_for: true }, item.props), null), _parent);
          } else {
            _push(ssrRenderComponent(VPMenuGroup, {
              text: item.text,
              items: item.items
            }, null, _parent));
          }
          _push(`<!--]-->`);
        });
        _push(`<!--]--></div>`);
      } else {
        _push(`<!---->`);
      }
      ssrRenderSlot(_ctx.$slots, "default", {}, null, _push, _parent);
      _push(`</div>`);
    };
  }
});
const _sfc_setup$O = _sfc_main$O.setup;
_sfc_main$O.setup = (props, ctx) => {
  const ssrContext = useSSRContext();
  (ssrContext.modules || (ssrContext.modules = /* @__PURE__ */ new Set())).add("../../node_modules/.pnpm/vitepress@1.6.4_@algolia+client-search@5.55.2_@types+node@24.13.3_@types+react@18.3.31__6511206dab6d3da37418cf3428952e99/node_modules/vitepress/dist/client/theme-default/components/VPMenu.vue");
  return _sfc_setup$O ? _sfc_setup$O(props, ctx) : void 0;
};
const VPMenu = /* @__PURE__ */ _export_sfc(_sfc_main$O, [["__scopeId", "data-v-e9030899"]]);
const _sfc_main$N = /* @__PURE__ */ defineComponent({
  __name: "VPFlyout",
  __ssrInlineRender: true,
  props: {
    icon: {},
    button: {},
    label: {},
    items: {}
  },
  setup(__props) {
    const open = ref(false);
    const el = ref();
    useFlyout({ el, onBlur });
    function onBlur() {
      open.value = false;
    }
    return (_ctx, _push, _parent, _attrs) => {
      _push(`<div${ssrRenderAttrs(mergeProps({
        class: "VPFlyout",
        ref_key: "el",
        ref: el
      }, _attrs))} data-v-b3fbc84e><button type="button" class="button" aria-haspopup="true"${ssrRenderAttr("aria-expanded", open.value)}${ssrRenderAttr("aria-label", __props.label)} data-v-b3fbc84e>`);
      if (__props.button || __props.icon) {
        _push(`<span class="text" data-v-b3fbc84e>`);
        if (__props.icon) {
          _push(`<span class="${ssrRenderClass([__props.icon, "option-icon"])}" data-v-b3fbc84e></span>`);
        } else {
          _push(`<!---->`);
        }
        if (__props.button) {
          _push(`<span data-v-b3fbc84e>${__props.button ?? ""}</span>`);
        } else {
          _push(`<!---->`);
        }
        _push(`<span class="vpi-chevron-down text-icon" data-v-b3fbc84e></span></span>`);
      } else {
        _push(`<span class="vpi-more-horizontal icon" data-v-b3fbc84e></span>`);
      }
      _push(`</button><div class="menu" data-v-b3fbc84e>`);
      _push(ssrRenderComponent(VPMenu, { items: __props.items }, {
        default: withCtx((_, _push2, _parent2, _scopeId) => {
          if (_push2) {
            ssrRenderSlot(_ctx.$slots, "default", {}, null, _push2, _parent2, _scopeId);
          } else {
            return [
              renderSlot(_ctx.$slots, "default", {}, void 0, true)
            ];
          }
        }),
        _: 3
      }, _parent));
      _push(`</div></div>`);
    };
  }
});
const _sfc_setup$N = _sfc_main$N.setup;
_sfc_main$N.setup = (props, ctx) => {
  const ssrContext = useSSRContext();
  (ssrContext.modules || (ssrContext.modules = /* @__PURE__ */ new Set())).add("../../node_modules/.pnpm/vitepress@1.6.4_@algolia+client-search@5.55.2_@types+node@24.13.3_@types+react@18.3.31__6511206dab6d3da37418cf3428952e99/node_modules/vitepress/dist/client/theme-default/components/VPFlyout.vue");
  return _sfc_setup$N ? _sfc_setup$N(props, ctx) : void 0;
};
const VPFlyout = /* @__PURE__ */ _export_sfc(_sfc_main$N, [["__scopeId", "data-v-b3fbc84e"]]);
const _sfc_main$M = /* @__PURE__ */ defineComponent({
  __name: "VPSocialLink",
  __ssrInlineRender: true,
  props: {
    icon: {},
    link: {},
    ariaLabel: {}
  },
  setup(__props) {
    var _a;
    const props = __props;
    const el = ref();
    onMounted(async () => {
      var _a2;
      await nextTick();
      const span = (_a2 = el.value) == null ? void 0 : _a2.children[0];
      if (span instanceof HTMLElement && span.className.startsWith("vpi-social-") && (getComputedStyle(span).maskImage || getComputedStyle(span).webkitMaskImage) === "none") {
        span.style.setProperty(
          "--icon",
          `url('https://api.iconify.design/simple-icons/${props.icon}.svg')`
        );
      }
    });
    const svg = computed(() => {
      if (typeof props.icon === "object") return props.icon.svg;
      return `<span class="vpi-social-${props.icon}"></span>`;
    });
    {
      typeof props.icon === "string" && ((_a = useSSRContext()) == null ? void 0 : _a.vpSocialIcons.add(props.icon));
    }
    return (_ctx, _push, _parent, _attrs) => {
      _push(`<a${ssrRenderAttrs(mergeProps({
        ref_key: "el",
        ref: el,
        class: "VPSocialLink no-icon",
        href: __props.link,
        "aria-label": __props.ariaLabel ?? (typeof __props.icon === "string" ? __props.icon : ""),
        target: "_blank",
        rel: "noopener"
      }, _attrs))} data-v-cbd4aa76>${svg.value ?? ""}</a>`);
    };
  }
});
const _sfc_setup$M = _sfc_main$M.setup;
_sfc_main$M.setup = (props, ctx) => {
  const ssrContext = useSSRContext();
  (ssrContext.modules || (ssrContext.modules = /* @__PURE__ */ new Set())).add("../../node_modules/.pnpm/vitepress@1.6.4_@algolia+client-search@5.55.2_@types+node@24.13.3_@types+react@18.3.31__6511206dab6d3da37418cf3428952e99/node_modules/vitepress/dist/client/theme-default/components/VPSocialLink.vue");
  return _sfc_setup$M ? _sfc_setup$M(props, ctx) : void 0;
};
const VPSocialLink = /* @__PURE__ */ _export_sfc(_sfc_main$M, [["__scopeId", "data-v-cbd4aa76"]]);
const _sfc_main$L = /* @__PURE__ */ defineComponent({
  __name: "VPSocialLinks",
  __ssrInlineRender: true,
  props: {
    links: {}
  },
  setup(__props) {
    return (_ctx, _push, _parent, _attrs) => {
      _push(`<div${ssrRenderAttrs(mergeProps({ class: "VPSocialLinks" }, _attrs))} data-v-e35739ae><!--[-->`);
      ssrRenderList(__props.links, ({ link: link2, icon, ariaLabel }) => {
        _push(ssrRenderComponent(VPSocialLink, {
          key: link2,
          icon,
          link: link2,
          ariaLabel
        }, null, _parent));
      });
      _push(`<!--]--></div>`);
    };
  }
});
const _sfc_setup$L = _sfc_main$L.setup;
_sfc_main$L.setup = (props, ctx) => {
  const ssrContext = useSSRContext();
  (ssrContext.modules || (ssrContext.modules = /* @__PURE__ */ new Set())).add("../../node_modules/.pnpm/vitepress@1.6.4_@algolia+client-search@5.55.2_@types+node@24.13.3_@types+react@18.3.31__6511206dab6d3da37418cf3428952e99/node_modules/vitepress/dist/client/theme-default/components/VPSocialLinks.vue");
  return _sfc_setup$L ? _sfc_setup$L(props, ctx) : void 0;
};
const VPSocialLinks = /* @__PURE__ */ _export_sfc(_sfc_main$L, [["__scopeId", "data-v-e35739ae"]]);
const _sfc_main$K = /* @__PURE__ */ defineComponent({
  __name: "VPNavBarExtra",
  __ssrInlineRender: true,
  setup(__props) {
    const { site, theme: theme2 } = useData();
    const { localeLinks, currentLang } = useLangs({ correspondingLink: true });
    const hasExtraContent = computed(
      () => localeLinks.value.length && currentLang.value.label || site.value.appearance || theme2.value.socialLinks
    );
    return (_ctx, _push, _parent, _attrs) => {
      if (hasExtraContent.value) {
        _push(ssrRenderComponent(VPFlyout, mergeProps({
          class: "VPNavBarExtra",
          label: "extra navigation"
        }, _attrs), {
          default: withCtx((_, _push2, _parent2, _scopeId) => {
            if (_push2) {
              if (unref(localeLinks).length && unref(currentLang).label) {
                _push2(`<div class="group translations" data-v-1d10e0f7${_scopeId}><p class="trans-title" data-v-1d10e0f7${_scopeId}>${ssrInterpolate(unref(currentLang).label)}</p><!--[-->`);
                ssrRenderList(unref(localeLinks), (locale) => {
                  _push2(ssrRenderComponent(VPMenuLink, { item: locale }, null, _parent2, _scopeId));
                });
                _push2(`<!--]--></div>`);
              } else {
                _push2(`<!---->`);
              }
              if (unref(site).appearance && unref(site).appearance !== "force-dark" && unref(site).appearance !== "force-auto") {
                _push2(`<div class="group" data-v-1d10e0f7${_scopeId}><div class="item appearance" data-v-1d10e0f7${_scopeId}><p class="label" data-v-1d10e0f7${_scopeId}>${ssrInterpolate(unref(theme2).darkModeSwitchLabel || "Appearance")}</p><div class="appearance-action" data-v-1d10e0f7${_scopeId}>`);
                _push2(ssrRenderComponent(VPSwitchAppearance, null, null, _parent2, _scopeId));
                _push2(`</div></div></div>`);
              } else {
                _push2(`<!---->`);
              }
              if (unref(theme2).socialLinks) {
                _push2(`<div class="group" data-v-1d10e0f7${_scopeId}><div class="item social-links" data-v-1d10e0f7${_scopeId}>`);
                _push2(ssrRenderComponent(VPSocialLinks, {
                  class: "social-links-list",
                  links: unref(theme2).socialLinks
                }, null, _parent2, _scopeId));
                _push2(`</div></div>`);
              } else {
                _push2(`<!---->`);
              }
            } else {
              return [
                unref(localeLinks).length && unref(currentLang).label ? (openBlock(), createBlock("div", {
                  key: 0,
                  class: "group translations"
                }, [
                  createVNode("p", { class: "trans-title" }, toDisplayString(unref(currentLang).label), 1),
                  (openBlock(true), createBlock(Fragment, null, renderList(unref(localeLinks), (locale) => {
                    return openBlock(), createBlock(VPMenuLink, {
                      key: locale.link,
                      item: locale
                    }, null, 8, ["item"]);
                  }), 128))
                ])) : createCommentVNode("", true),
                unref(site).appearance && unref(site).appearance !== "force-dark" && unref(site).appearance !== "force-auto" ? (openBlock(), createBlock("div", {
                  key: 1,
                  class: "group"
                }, [
                  createVNode("div", { class: "item appearance" }, [
                    createVNode("p", { class: "label" }, toDisplayString(unref(theme2).darkModeSwitchLabel || "Appearance"), 1),
                    createVNode("div", { class: "appearance-action" }, [
                      createVNode(VPSwitchAppearance)
                    ])
                  ])
                ])) : createCommentVNode("", true),
                unref(theme2).socialLinks ? (openBlock(), createBlock("div", {
                  key: 2,
                  class: "group"
                }, [
                  createVNode("div", { class: "item social-links" }, [
                    createVNode(VPSocialLinks, {
                      class: "social-links-list",
                      links: unref(theme2).socialLinks
                    }, null, 8, ["links"])
                  ])
                ])) : createCommentVNode("", true)
              ];
            }
          }),
          _: 1
        }, _parent));
      } else {
        _push(`<!---->`);
      }
    };
  }
});
const _sfc_setup$K = _sfc_main$K.setup;
_sfc_main$K.setup = (props, ctx) => {
  const ssrContext = useSSRContext();
  (ssrContext.modules || (ssrContext.modules = /* @__PURE__ */ new Set())).add("../../node_modules/.pnpm/vitepress@1.6.4_@algolia+client-search@5.55.2_@types+node@24.13.3_@types+react@18.3.31__6511206dab6d3da37418cf3428952e99/node_modules/vitepress/dist/client/theme-default/components/VPNavBarExtra.vue");
  return _sfc_setup$K ? _sfc_setup$K(props, ctx) : void 0;
};
const VPNavBarExtra = /* @__PURE__ */ _export_sfc(_sfc_main$K, [["__scopeId", "data-v-1d10e0f7"]]);
const _sfc_main$J = /* @__PURE__ */ defineComponent({
  __name: "VPNavBarHamburger",
  __ssrInlineRender: true,
  props: {
    active: { type: Boolean }
  },
  emits: ["click"],
  setup(__props) {
    return (_ctx, _push, _parent, _attrs) => {
      _push(`<button${ssrRenderAttrs(mergeProps({
        type: "button",
        class: ["VPNavBarHamburger", { active: __props.active }],
        "aria-label": "mobile navigation",
        "aria-expanded": __props.active,
        "aria-controls": "VPNavScreen"
      }, _attrs))} data-v-295bc804><span class="container" data-v-295bc804><span class="top" data-v-295bc804></span><span class="middle" data-v-295bc804></span><span class="bottom" data-v-295bc804></span></span></button>`);
    };
  }
});
const _sfc_setup$J = _sfc_main$J.setup;
_sfc_main$J.setup = (props, ctx) => {
  const ssrContext = useSSRContext();
  (ssrContext.modules || (ssrContext.modules = /* @__PURE__ */ new Set())).add("../../node_modules/.pnpm/vitepress@1.6.4_@algolia+client-search@5.55.2_@types+node@24.13.3_@types+react@18.3.31__6511206dab6d3da37418cf3428952e99/node_modules/vitepress/dist/client/theme-default/components/VPNavBarHamburger.vue");
  return _sfc_setup$J ? _sfc_setup$J(props, ctx) : void 0;
};
const VPNavBarHamburger = /* @__PURE__ */ _export_sfc(_sfc_main$J, [["__scopeId", "data-v-295bc804"]]);
const _sfc_main$I = /* @__PURE__ */ defineComponent({
  __name: "VPNavBarMenuLink",
  __ssrInlineRender: true,
  props: {
    item: {}
  },
  setup(__props) {
    const { page } = useData();
    return (_ctx, _push, _parent, _attrs) => {
      _push(ssrRenderComponent(_sfc_main$19, mergeProps({
        class: {
          VPNavBarMenuLink: true,
          active: unref(isActive)(
            unref(page).relativePath,
            __props.item.activeMatch || __props.item.link,
            !!__props.item.activeMatch
          )
        },
        href: __props.item.link,
        target: __props.item.target,
        rel: __props.item.rel,
        "no-icon": __props.item.noIcon,
        tabindex: "0"
      }, _attrs), {
        default: withCtx((_, _push2, _parent2, _scopeId) => {
          if (_push2) {
            _push2(`<span data-v-4979adc3${_scopeId}>${__props.item.text ?? ""}</span>`);
          } else {
            return [
              createVNode("span", {
                innerHTML: __props.item.text
              }, null, 8, ["innerHTML"])
            ];
          }
        }),
        _: 1
      }, _parent));
    };
  }
});
const _sfc_setup$I = _sfc_main$I.setup;
_sfc_main$I.setup = (props, ctx) => {
  const ssrContext = useSSRContext();
  (ssrContext.modules || (ssrContext.modules = /* @__PURE__ */ new Set())).add("../../node_modules/.pnpm/vitepress@1.6.4_@algolia+client-search@5.55.2_@types+node@24.13.3_@types+react@18.3.31__6511206dab6d3da37418cf3428952e99/node_modules/vitepress/dist/client/theme-default/components/VPNavBarMenuLink.vue");
  return _sfc_setup$I ? _sfc_setup$I(props, ctx) : void 0;
};
const VPNavBarMenuLink = /* @__PURE__ */ _export_sfc(_sfc_main$I, [["__scopeId", "data-v-4979adc3"]]);
const _sfc_main$H = /* @__PURE__ */ defineComponent({
  __name: "VPNavBarMenuGroup",
  __ssrInlineRender: true,
  props: {
    item: {}
  },
  setup(__props) {
    const props = __props;
    const { page } = useData();
    const isChildActive = (navItem) => {
      if ("component" in navItem) return false;
      if ("link" in navItem) {
        return isActive(
          page.value.relativePath,
          navItem.link,
          !!props.item.activeMatch
        );
      }
      return navItem.items.some(isChildActive);
    };
    const childrenActive = computed(() => isChildActive(props.item));
    return (_ctx, _push, _parent, _attrs) => {
      _push(ssrRenderComponent(VPFlyout, mergeProps({
        class: {
          VPNavBarMenuGroup: true,
          active: unref(isActive)(unref(page).relativePath, __props.item.activeMatch, !!__props.item.activeMatch) || childrenActive.value
        },
        button: __props.item.text,
        items: __props.item.items
      }, _attrs), null, _parent));
    };
  }
});
const _sfc_setup$H = _sfc_main$H.setup;
_sfc_main$H.setup = (props, ctx) => {
  const ssrContext = useSSRContext();
  (ssrContext.modules || (ssrContext.modules = /* @__PURE__ */ new Set())).add("../../node_modules/.pnpm/vitepress@1.6.4_@algolia+client-search@5.55.2_@types+node@24.13.3_@types+react@18.3.31__6511206dab6d3da37418cf3428952e99/node_modules/vitepress/dist/client/theme-default/components/VPNavBarMenuGroup.vue");
  return _sfc_setup$H ? _sfc_setup$H(props, ctx) : void 0;
};
const _sfc_main$G = /* @__PURE__ */ defineComponent({
  __name: "VPNavBarMenu",
  __ssrInlineRender: true,
  setup(__props) {
    const { theme: theme2 } = useData();
    return (_ctx, _push, _parent, _attrs) => {
      if (unref(theme2).nav) {
        _push(`<nav${ssrRenderAttrs(mergeProps({
          "aria-labelledby": "main-nav-aria-label",
          class: "VPNavBarMenu"
        }, _attrs))} data-v-3dfc6661><span id="main-nav-aria-label" class="visually-hidden" data-v-3dfc6661> Main Navigation </span><!--[-->`);
        ssrRenderList(unref(theme2).nav, (item) => {
          _push(`<!--[-->`);
          if ("link" in item) {
            _push(ssrRenderComponent(VPNavBarMenuLink, { item }, null, _parent));
          } else if ("component" in item) {
            ssrRenderVNode(_push, createVNode(resolveDynamicComponent(item.component), mergeProps({ ref_for: true }, item.props), null), _parent);
          } else {
            _push(ssrRenderComponent(_sfc_main$H, { item }, null, _parent));
          }
          _push(`<!--]-->`);
        });
        _push(`<!--]--></nav>`);
      } else {
        _push(`<!---->`);
      }
    };
  }
});
const _sfc_setup$G = _sfc_main$G.setup;
_sfc_main$G.setup = (props, ctx) => {
  const ssrContext = useSSRContext();
  (ssrContext.modules || (ssrContext.modules = /* @__PURE__ */ new Set())).add("../../node_modules/.pnpm/vitepress@1.6.4_@algolia+client-search@5.55.2_@types+node@24.13.3_@types+react@18.3.31__6511206dab6d3da37418cf3428952e99/node_modules/vitepress/dist/client/theme-default/components/VPNavBarMenu.vue");
  return _sfc_setup$G ? _sfc_setup$G(props, ctx) : void 0;
};
const VPNavBarMenu = /* @__PURE__ */ _export_sfc(_sfc_main$G, [["__scopeId", "data-v-3dfc6661"]]);
function createSearchTranslate(defaultTranslations) {
  const { localeIndex, theme: theme2 } = useData();
  function translate(key) {
    var _a, _b, _c;
    const keyPath = key.split(".");
    const themeObject = (_a = theme2.value.search) == null ? void 0 : _a.options;
    const isObject2 = themeObject && typeof themeObject === "object";
    const locales = isObject2 && ((_c = (_b = themeObject.locales) == null ? void 0 : _b[localeIndex.value]) == null ? void 0 : _c.translations) || null;
    const translations = isObject2 && themeObject.translations || null;
    let localeResult = locales;
    let translationResult = translations;
    let defaultResult = defaultTranslations;
    const lastKey = keyPath.pop();
    for (const k of keyPath) {
      let fallbackResult = null;
      const foundInFallback = defaultResult == null ? void 0 : defaultResult[k];
      if (foundInFallback) {
        fallbackResult = defaultResult = foundInFallback;
      }
      const foundInTranslation = translationResult == null ? void 0 : translationResult[k];
      if (foundInTranslation) {
        fallbackResult = translationResult = foundInTranslation;
      }
      const foundInLocale = localeResult == null ? void 0 : localeResult[k];
      if (foundInLocale) {
        fallbackResult = localeResult = foundInLocale;
      }
      if (!foundInFallback) {
        defaultResult = fallbackResult;
      }
      if (!foundInTranslation) {
        translationResult = fallbackResult;
      }
      if (!foundInLocale) {
        localeResult = fallbackResult;
      }
    }
    return (localeResult == null ? void 0 : localeResult[lastKey]) ?? (translationResult == null ? void 0 : translationResult[lastKey]) ?? (defaultResult == null ? void 0 : defaultResult[lastKey]) ?? "";
  }
  return translate;
}
const _sfc_main$F = /* @__PURE__ */ defineComponent({
  __name: "VPNavBarSearchButton",
  __ssrInlineRender: true,
  setup(__props) {
    const defaultTranslations = {
      button: {
        buttonText: "Search",
        buttonAriaLabel: "Search"
      }
    };
    const translate = createSearchTranslate(defaultTranslations);
    return (_ctx, _push, _parent, _attrs) => {
      _push(`<button${ssrRenderAttrs(mergeProps({
        type: "button",
        class: "DocSearch DocSearch-Button",
        "aria-label": unref(translate)("button.buttonAriaLabel")
      }, _attrs))}><span class="DocSearch-Button-Container"><span class="vp-icon DocSearch-Search-Icon"></span><span class="DocSearch-Button-Placeholder">${ssrInterpolate(unref(translate)("button.buttonText"))}</span></span><span class="DocSearch-Button-Keys"><kbd class="DocSearch-Button-Key"></kbd><kbd class="DocSearch-Button-Key">K</kbd></span></button>`);
    };
  }
});
const _sfc_setup$F = _sfc_main$F.setup;
_sfc_main$F.setup = (props, ctx) => {
  const ssrContext = useSSRContext();
  (ssrContext.modules || (ssrContext.modules = /* @__PURE__ */ new Set())).add("../../node_modules/.pnpm/vitepress@1.6.4_@algolia+client-search@5.55.2_@types+node@24.13.3_@types+react@18.3.31__6511206dab6d3da37418cf3428952e99/node_modules/vitepress/dist/client/theme-default/components/VPNavBarSearchButton.vue");
  return _sfc_setup$F ? _sfc_setup$F(props, ctx) : void 0;
};
const _sfc_main$E = /* @__PURE__ */ defineComponent({
  __name: "VPNavBarSearch",
  __ssrInlineRender: true,
  setup(__props) {
    const VPLocalSearchBox = defineAsyncComponent(() => import("./VPLocalSearchBox.CiLaTALV.js"));
    const VPAlgoliaSearchBox = () => null;
    const { theme: theme2 } = useData();
    const loaded = ref(false);
    const actuallyLoaded = ref(false);
    onMounted(() => {
      {
        return;
      }
    });
    function load() {
      if (!loaded.value) {
        loaded.value = true;
        setTimeout(poll, 16);
      }
    }
    function poll() {
      const e = new Event("keydown");
      e.key = "k";
      e.metaKey = true;
      window.dispatchEvent(e);
      setTimeout(() => {
        if (!document.querySelector(".DocSearch-Modal")) {
          poll();
        }
      }, 16);
    }
    function isEditingContent(event) {
      const element = event.target;
      const tagName = element.tagName;
      return element.isContentEditable || tagName === "INPUT" || tagName === "SELECT" || tagName === "TEXTAREA";
    }
    const showSearch = ref(false);
    {
      onKeyStroke("k", (event) => {
        if (event.ctrlKey || event.metaKey) {
          event.preventDefault();
          showSearch.value = true;
        }
      });
      onKeyStroke("/", (event) => {
        if (!isEditingContent(event)) {
          event.preventDefault();
          showSearch.value = true;
        }
      });
    }
    const provider2 = "local";
    return (_ctx, _push, _parent, _attrs) => {
      var _a;
      _push(`<div${ssrRenderAttrs(mergeProps({ class: "VPNavBarSearch" }, _attrs))}>`);
      if (unref(provider2) === "local") {
        _push(`<!--[-->`);
        if (showSearch.value) {
          _push(ssrRenderComponent(unref(VPLocalSearchBox), {
            onClose: ($event) => showSearch.value = false
          }, null, _parent));
        } else {
          _push(`<!---->`);
        }
        _push(`<div id="local-search">`);
        _push(ssrRenderComponent(_sfc_main$F, {
          onClick: ($event) => showSearch.value = true
        }, null, _parent));
        _push(`</div><!--]-->`);
      } else if (unref(provider2) === "algolia") {
        _push(`<!--[-->`);
        if (loaded.value) {
          _push(ssrRenderComponent(unref(VPAlgoliaSearchBox), {
            algolia: ((_a = unref(theme2).search) == null ? void 0 : _a.options) ?? unref(theme2).algolia,
            onVnodeBeforeMount: ($event) => actuallyLoaded.value = true
          }, null, _parent));
        } else {
          _push(`<!---->`);
        }
        if (!actuallyLoaded.value) {
          _push(`<div id="docsearch">`);
          _push(ssrRenderComponent(_sfc_main$F, { onClick: load }, null, _parent));
          _push(`</div>`);
        } else {
          _push(`<!---->`);
        }
        _push(`<!--]-->`);
      } else {
        _push(`<!---->`);
      }
      _push(`</div>`);
    };
  }
});
const _sfc_setup$E = _sfc_main$E.setup;
_sfc_main$E.setup = (props, ctx) => {
  const ssrContext = useSSRContext();
  (ssrContext.modules || (ssrContext.modules = /* @__PURE__ */ new Set())).add("../../node_modules/.pnpm/vitepress@1.6.4_@algolia+client-search@5.55.2_@types+node@24.13.3_@types+react@18.3.31__6511206dab6d3da37418cf3428952e99/node_modules/vitepress/dist/client/theme-default/components/VPNavBarSearch.vue");
  return _sfc_setup$E ? _sfc_setup$E(props, ctx) : void 0;
};
const _sfc_main$D = /* @__PURE__ */ defineComponent({
  __name: "VPNavBarSocialLinks",
  __ssrInlineRender: true,
  setup(__props) {
    const { theme: theme2 } = useData();
    return (_ctx, _push, _parent, _attrs) => {
      if (unref(theme2).socialLinks) {
        _push(ssrRenderComponent(VPSocialLinks, mergeProps({
          class: "VPNavBarSocialLinks",
          links: unref(theme2).socialLinks
        }, _attrs), null, _parent));
      } else {
        _push(`<!---->`);
      }
    };
  }
});
const _sfc_setup$D = _sfc_main$D.setup;
_sfc_main$D.setup = (props, ctx) => {
  const ssrContext = useSSRContext();
  (ssrContext.modules || (ssrContext.modules = /* @__PURE__ */ new Set())).add("../../node_modules/.pnpm/vitepress@1.6.4_@algolia+client-search@5.55.2_@types+node@24.13.3_@types+react@18.3.31__6511206dab6d3da37418cf3428952e99/node_modules/vitepress/dist/client/theme-default/components/VPNavBarSocialLinks.vue");
  return _sfc_setup$D ? _sfc_setup$D(props, ctx) : void 0;
};
const VPNavBarSocialLinks = /* @__PURE__ */ _export_sfc(_sfc_main$D, [["__scopeId", "data-v-b00545a2"]]);
const _sfc_main$C = /* @__PURE__ */ defineComponent({
  __name: "VPNavBarTitle",
  __ssrInlineRender: true,
  setup(__props) {
    const { site, theme: theme2 } = useData();
    const { hasSidebar } = useSidebar();
    const { currentLang } = useLangs();
    const link2 = computed(
      () => {
        var _a;
        return typeof theme2.value.logoLink === "string" ? theme2.value.logoLink : (_a = theme2.value.logoLink) == null ? void 0 : _a.link;
      }
    );
    const rel = computed(
      () => {
        var _a;
        return typeof theme2.value.logoLink === "string" ? void 0 : (_a = theme2.value.logoLink) == null ? void 0 : _a.rel;
      }
    );
    const target = computed(
      () => {
        var _a;
        return typeof theme2.value.logoLink === "string" ? void 0 : (_a = theme2.value.logoLink) == null ? void 0 : _a.target;
      }
    );
    return (_ctx, _push, _parent, _attrs) => {
      _push(`<div${ssrRenderAttrs(mergeProps({
        class: ["VPNavBarTitle", { "has-sidebar": unref(hasSidebar) }]
      }, _attrs))} data-v-34917422><a class="title"${ssrRenderAttr("href", link2.value ?? unref(normalizeLink$1)(unref(currentLang).link))}${ssrRenderAttr("rel", rel.value)}${ssrRenderAttr("target", target.value)} data-v-34917422>`);
      ssrRenderSlot(_ctx.$slots, "nav-bar-title-before", {}, null, _push, _parent);
      if (unref(theme2).logo) {
        _push(ssrRenderComponent(VPImage, {
          class: "logo",
          image: unref(theme2).logo
        }, null, _parent));
      } else {
        _push(`<!---->`);
      }
      if (unref(theme2).siteTitle) {
        _push(`<span data-v-34917422>${unref(theme2).siteTitle ?? ""}</span>`);
      } else if (unref(theme2).siteTitle === void 0) {
        _push(`<span data-v-34917422>${ssrInterpolate(unref(site).title)}</span>`);
      } else {
        _push(`<!---->`);
      }
      ssrRenderSlot(_ctx.$slots, "nav-bar-title-after", {}, null, _push, _parent);
      _push(`</a></div>`);
    };
  }
});
const _sfc_setup$C = _sfc_main$C.setup;
_sfc_main$C.setup = (props, ctx) => {
  const ssrContext = useSSRContext();
  (ssrContext.modules || (ssrContext.modules = /* @__PURE__ */ new Set())).add("../../node_modules/.pnpm/vitepress@1.6.4_@algolia+client-search@5.55.2_@types+node@24.13.3_@types+react@18.3.31__6511206dab6d3da37418cf3428952e99/node_modules/vitepress/dist/client/theme-default/components/VPNavBarTitle.vue");
  return _sfc_setup$C ? _sfc_setup$C(props, ctx) : void 0;
};
const VPNavBarTitle = /* @__PURE__ */ _export_sfc(_sfc_main$C, [["__scopeId", "data-v-34917422"]]);
const _sfc_main$B = /* @__PURE__ */ defineComponent({
  __name: "VPNavBarTranslations",
  __ssrInlineRender: true,
  setup(__props) {
    const { theme: theme2 } = useData();
    const { localeLinks, currentLang } = useLangs({ correspondingLink: true });
    return (_ctx, _push, _parent, _attrs) => {
      if (unref(localeLinks).length && unref(currentLang).label) {
        _push(ssrRenderComponent(VPFlyout, mergeProps({
          class: "VPNavBarTranslations",
          icon: "vpi-languages",
          label: unref(theme2).langMenuLabel || "Change language"
        }, _attrs), {
          default: withCtx((_, _push2, _parent2, _scopeId) => {
            if (_push2) {
              _push2(`<div class="items" data-v-e9a1e497${_scopeId}><p class="title" data-v-e9a1e497${_scopeId}>${ssrInterpolate(unref(currentLang).label)}</p><!--[-->`);
              ssrRenderList(unref(localeLinks), (locale) => {
                _push2(ssrRenderComponent(VPMenuLink, { item: locale }, null, _parent2, _scopeId));
              });
              _push2(`<!--]--></div>`);
            } else {
              return [
                createVNode("div", { class: "items" }, [
                  createVNode("p", { class: "title" }, toDisplayString(unref(currentLang).label), 1),
                  (openBlock(true), createBlock(Fragment, null, renderList(unref(localeLinks), (locale) => {
                    return openBlock(), createBlock(VPMenuLink, {
                      key: locale.link,
                      item: locale
                    }, null, 8, ["item"]);
                  }), 128))
                ])
              ];
            }
          }),
          _: 1
        }, _parent));
      } else {
        _push(`<!---->`);
      }
    };
  }
});
const _sfc_setup$B = _sfc_main$B.setup;
_sfc_main$B.setup = (props, ctx) => {
  const ssrContext = useSSRContext();
  (ssrContext.modules || (ssrContext.modules = /* @__PURE__ */ new Set())).add("../../node_modules/.pnpm/vitepress@1.6.4_@algolia+client-search@5.55.2_@types+node@24.13.3_@types+react@18.3.31__6511206dab6d3da37418cf3428952e99/node_modules/vitepress/dist/client/theme-default/components/VPNavBarTranslations.vue");
  return _sfc_setup$B ? _sfc_setup$B(props, ctx) : void 0;
};
const VPNavBarTranslations = /* @__PURE__ */ _export_sfc(_sfc_main$B, [["__scopeId", "data-v-e9a1e497"]]);
const _sfc_main$A = /* @__PURE__ */ defineComponent({
  __name: "VPNavBar",
  __ssrInlineRender: true,
  props: {
    isScreenOpen: { type: Boolean }
  },
  emits: ["toggle-screen"],
  setup(__props) {
    const props = __props;
    const { y } = useWindowScroll();
    const { hasSidebar } = useSidebar();
    const { frontmatter } = useData();
    const classes = ref({});
    watchPostEffect(() => {
      classes.value = {
        "has-sidebar": hasSidebar.value,
        "home": frontmatter.value.layout === "home",
        "top": y.value === 0,
        "screen-open": props.isScreenOpen
      };
    });
    return (_ctx, _push, _parent, _attrs) => {
      _push(`<div${ssrRenderAttrs(mergeProps({
        class: ["VPNavBar", classes.value]
      }, _attrs))} data-v-0a42f181><div class="wrapper" data-v-0a42f181><div class="container" data-v-0a42f181><div class="title" data-v-0a42f181>`);
      _push(ssrRenderComponent(VPNavBarTitle, null, {
        "nav-bar-title-before": withCtx((_, _push2, _parent2, _scopeId) => {
          if (_push2) {
            ssrRenderSlot(_ctx.$slots, "nav-bar-title-before", {}, null, _push2, _parent2, _scopeId);
          } else {
            return [
              renderSlot(_ctx.$slots, "nav-bar-title-before", {}, void 0, true)
            ];
          }
        }),
        "nav-bar-title-after": withCtx((_, _push2, _parent2, _scopeId) => {
          if (_push2) {
            ssrRenderSlot(_ctx.$slots, "nav-bar-title-after", {}, null, _push2, _parent2, _scopeId);
          } else {
            return [
              renderSlot(_ctx.$slots, "nav-bar-title-after", {}, void 0, true)
            ];
          }
        }),
        _: 3
      }, _parent));
      _push(`</div><div class="content" data-v-0a42f181><div class="content-body" data-v-0a42f181>`);
      ssrRenderSlot(_ctx.$slots, "nav-bar-content-before", {}, null, _push, _parent);
      _push(ssrRenderComponent(_sfc_main$E, { class: "search" }, null, _parent));
      _push(ssrRenderComponent(VPNavBarMenu, { class: "menu" }, null, _parent));
      _push(ssrRenderComponent(VPNavBarTranslations, { class: "translations" }, null, _parent));
      _push(ssrRenderComponent(VPNavBarAppearance, { class: "appearance" }, null, _parent));
      _push(ssrRenderComponent(VPNavBarSocialLinks, { class: "social-links" }, null, _parent));
      _push(ssrRenderComponent(VPNavBarExtra, { class: "extra" }, null, _parent));
      ssrRenderSlot(_ctx.$slots, "nav-bar-content-after", {}, null, _push, _parent);
      _push(ssrRenderComponent(VPNavBarHamburger, {
        class: "hamburger",
        active: __props.isScreenOpen,
        onClick: ($event) => _ctx.$emit("toggle-screen")
      }, null, _parent));
      _push(`</div></div></div></div><div class="divider" data-v-0a42f181><div class="divider-line" data-v-0a42f181></div></div></div>`);
    };
  }
});
const _sfc_setup$A = _sfc_main$A.setup;
_sfc_main$A.setup = (props, ctx) => {
  const ssrContext = useSSRContext();
  (ssrContext.modules || (ssrContext.modules = /* @__PURE__ */ new Set())).add("../../node_modules/.pnpm/vitepress@1.6.4_@algolia+client-search@5.55.2_@types+node@24.13.3_@types+react@18.3.31__6511206dab6d3da37418cf3428952e99/node_modules/vitepress/dist/client/theme-default/components/VPNavBar.vue");
  return _sfc_setup$A ? _sfc_setup$A(props, ctx) : void 0;
};
const VPNavBar = /* @__PURE__ */ _export_sfc(_sfc_main$A, [["__scopeId", "data-v-0a42f181"]]);
const _sfc_main$z = /* @__PURE__ */ defineComponent({
  __name: "VPNavScreenAppearance",
  __ssrInlineRender: true,
  setup(__props) {
    const { site, theme: theme2 } = useData();
    return (_ctx, _push, _parent, _attrs) => {
      if (unref(site).appearance && unref(site).appearance !== "force-dark" && unref(site).appearance !== "force-auto") {
        _push(`<div${ssrRenderAttrs(mergeProps({ class: "VPNavScreenAppearance" }, _attrs))} data-v-1619ed8f><p class="text" data-v-1619ed8f>${ssrInterpolate(unref(theme2).darkModeSwitchLabel || "Appearance")}</p>`);
        _push(ssrRenderComponent(VPSwitchAppearance, null, null, _parent));
        _push(`</div>`);
      } else {
        _push(`<!---->`);
      }
    };
  }
});
const _sfc_setup$z = _sfc_main$z.setup;
_sfc_main$z.setup = (props, ctx) => {
  const ssrContext = useSSRContext();
  (ssrContext.modules || (ssrContext.modules = /* @__PURE__ */ new Set())).add("../../node_modules/.pnpm/vitepress@1.6.4_@algolia+client-search@5.55.2_@types+node@24.13.3_@types+react@18.3.31__6511206dab6d3da37418cf3428952e99/node_modules/vitepress/dist/client/theme-default/components/VPNavScreenAppearance.vue");
  return _sfc_setup$z ? _sfc_setup$z(props, ctx) : void 0;
};
const VPNavScreenAppearance = /* @__PURE__ */ _export_sfc(_sfc_main$z, [["__scopeId", "data-v-1619ed8f"]]);
const _sfc_main$y = /* @__PURE__ */ defineComponent({
  __name: "VPNavScreenMenuLink",
  __ssrInlineRender: true,
  props: {
    item: {}
  },
  setup(__props) {
    const closeScreen = inject("close-screen");
    return (_ctx, _push, _parent, _attrs) => {
      _push(ssrRenderComponent(_sfc_main$19, mergeProps({
        class: "VPNavScreenMenuLink",
        href: __props.item.link,
        target: __props.item.target,
        rel: __props.item.rel,
        "no-icon": __props.item.noIcon,
        onClick: unref(closeScreen)
      }, _attrs), {
        default: withCtx((_, _push2, _parent2, _scopeId) => {
          if (_push2) {
            _push2(`<span data-v-d63a03a3${_scopeId}>${__props.item.text ?? ""}</span>`);
          } else {
            return [
              createVNode("span", {
                innerHTML: __props.item.text
              }, null, 8, ["innerHTML"])
            ];
          }
        }),
        _: 1
      }, _parent));
    };
  }
});
const _sfc_setup$y = _sfc_main$y.setup;
_sfc_main$y.setup = (props, ctx) => {
  const ssrContext = useSSRContext();
  (ssrContext.modules || (ssrContext.modules = /* @__PURE__ */ new Set())).add("../../node_modules/.pnpm/vitepress@1.6.4_@algolia+client-search@5.55.2_@types+node@24.13.3_@types+react@18.3.31__6511206dab6d3da37418cf3428952e99/node_modules/vitepress/dist/client/theme-default/components/VPNavScreenMenuLink.vue");
  return _sfc_setup$y ? _sfc_setup$y(props, ctx) : void 0;
};
const VPNavScreenMenuLink = /* @__PURE__ */ _export_sfc(_sfc_main$y, [["__scopeId", "data-v-d63a03a3"]]);
const _sfc_main$x = /* @__PURE__ */ defineComponent({
  __name: "VPNavScreenMenuGroupLink",
  __ssrInlineRender: true,
  props: {
    item: {}
  },
  setup(__props) {
    const closeScreen = inject("close-screen");
    return (_ctx, _push, _parent, _attrs) => {
      _push(ssrRenderComponent(_sfc_main$19, mergeProps({
        class: "VPNavScreenMenuGroupLink",
        href: __props.item.link,
        target: __props.item.target,
        rel: __props.item.rel,
        "no-icon": __props.item.noIcon,
        onClick: unref(closeScreen)
      }, _attrs), {
        default: withCtx((_, _push2, _parent2, _scopeId) => {
          if (_push2) {
            _push2(`<span data-v-d8eed5f1${_scopeId}>${__props.item.text ?? ""}</span>`);
          } else {
            return [
              createVNode("span", {
                innerHTML: __props.item.text
              }, null, 8, ["innerHTML"])
            ];
          }
        }),
        _: 1
      }, _parent));
    };
  }
});
const _sfc_setup$x = _sfc_main$x.setup;
_sfc_main$x.setup = (props, ctx) => {
  const ssrContext = useSSRContext();
  (ssrContext.modules || (ssrContext.modules = /* @__PURE__ */ new Set())).add("../../node_modules/.pnpm/vitepress@1.6.4_@algolia+client-search@5.55.2_@types+node@24.13.3_@types+react@18.3.31__6511206dab6d3da37418cf3428952e99/node_modules/vitepress/dist/client/theme-default/components/VPNavScreenMenuGroupLink.vue");
  return _sfc_setup$x ? _sfc_setup$x(props, ctx) : void 0;
};
const VPNavScreenMenuGroupLink = /* @__PURE__ */ _export_sfc(_sfc_main$x, [["__scopeId", "data-v-d8eed5f1"]]);
const _sfc_main$w = /* @__PURE__ */ defineComponent({
  __name: "VPNavScreenMenuGroupSection",
  __ssrInlineRender: true,
  props: {
    text: {},
    items: {}
  },
  setup(__props) {
    return (_ctx, _push, _parent, _attrs) => {
      _push(`<div${ssrRenderAttrs(mergeProps({ class: "VPNavScreenMenuGroupSection" }, _attrs))} data-v-31ea5c92>`);
      if (__props.text) {
        _push(`<p class="title" data-v-31ea5c92>${ssrInterpolate(__props.text)}</p>`);
      } else {
        _push(`<!---->`);
      }
      _push(`<!--[-->`);
      ssrRenderList(__props.items, (item) => {
        _push(ssrRenderComponent(VPNavScreenMenuGroupLink, {
          key: item.text,
          item
        }, null, _parent));
      });
      _push(`<!--]--></div>`);
    };
  }
});
const _sfc_setup$w = _sfc_main$w.setup;
_sfc_main$w.setup = (props, ctx) => {
  const ssrContext = useSSRContext();
  (ssrContext.modules || (ssrContext.modules = /* @__PURE__ */ new Set())).add("../../node_modules/.pnpm/vitepress@1.6.4_@algolia+client-search@5.55.2_@types+node@24.13.3_@types+react@18.3.31__6511206dab6d3da37418cf3428952e99/node_modules/vitepress/dist/client/theme-default/components/VPNavScreenMenuGroupSection.vue");
  return _sfc_setup$w ? _sfc_setup$w(props, ctx) : void 0;
};
const VPNavScreenMenuGroupSection = /* @__PURE__ */ _export_sfc(_sfc_main$w, [["__scopeId", "data-v-31ea5c92"]]);
const _sfc_main$v = /* @__PURE__ */ defineComponent({
  __name: "VPNavScreenMenuGroup",
  __ssrInlineRender: true,
  props: {
    text: {},
    items: {}
  },
  setup(__props) {
    const props = __props;
    const isOpen = ref(false);
    const groupId = computed(
      () => `NavScreenGroup-${props.text.replace(" ", "-").toLowerCase()}`
    );
    return (_ctx, _push, _parent, _attrs) => {
      _push(`<div${ssrRenderAttrs(mergeProps({
        class: ["VPNavScreenMenuGroup", { open: isOpen.value }]
      }, _attrs))} data-v-88ada2f2><button class="button"${ssrRenderAttr("aria-controls", groupId.value)}${ssrRenderAttr("aria-expanded", isOpen.value)} data-v-88ada2f2><span class="button-text" data-v-88ada2f2>${__props.text ?? ""}</span><span class="vpi-plus button-icon" data-v-88ada2f2></span></button><div${ssrRenderAttr("id", groupId.value)} class="items" data-v-88ada2f2><!--[-->`);
      ssrRenderList(__props.items, (item) => {
        _push(`<!--[-->`);
        if ("link" in item) {
          _push(`<div class="item" data-v-88ada2f2>`);
          _push(ssrRenderComponent(VPNavScreenMenuGroupLink, { item }, null, _parent));
          _push(`</div>`);
        } else if ("component" in item) {
          _push(`<div class="item" data-v-88ada2f2>`);
          ssrRenderVNode(_push, createVNode(resolveDynamicComponent(item.component), mergeProps({ ref_for: true }, item.props, { "screen-menu": "" }), null), _parent);
          _push(`</div>`);
        } else {
          _push(`<div class="group" data-v-88ada2f2>`);
          _push(ssrRenderComponent(VPNavScreenMenuGroupSection, {
            text: item.text,
            items: item.items
          }, null, _parent));
          _push(`</div>`);
        }
        _push(`<!--]-->`);
      });
      _push(`<!--]--></div></div>`);
    };
  }
});
const _sfc_setup$v = _sfc_main$v.setup;
_sfc_main$v.setup = (props, ctx) => {
  const ssrContext = useSSRContext();
  (ssrContext.modules || (ssrContext.modules = /* @__PURE__ */ new Set())).add("../../node_modules/.pnpm/vitepress@1.6.4_@algolia+client-search@5.55.2_@types+node@24.13.3_@types+react@18.3.31__6511206dab6d3da37418cf3428952e99/node_modules/vitepress/dist/client/theme-default/components/VPNavScreenMenuGroup.vue");
  return _sfc_setup$v ? _sfc_setup$v(props, ctx) : void 0;
};
const VPNavScreenMenuGroup = /* @__PURE__ */ _export_sfc(_sfc_main$v, [["__scopeId", "data-v-88ada2f2"]]);
const _sfc_main$u = /* @__PURE__ */ defineComponent({
  __name: "VPNavScreenMenu",
  __ssrInlineRender: true,
  setup(__props) {
    const { theme: theme2 } = useData();
    return (_ctx, _push, _parent, _attrs) => {
      if (unref(theme2).nav) {
        _push(`<nav${ssrRenderAttrs(mergeProps({ class: "VPNavScreenMenu" }, _attrs))}><!--[-->`);
        ssrRenderList(unref(theme2).nav, (item) => {
          _push(`<!--[-->`);
          if ("link" in item) {
            _push(ssrRenderComponent(VPNavScreenMenuLink, { item }, null, _parent));
          } else if ("component" in item) {
            ssrRenderVNode(_push, createVNode(resolveDynamicComponent(item.component), mergeProps({ ref_for: true }, item.props, { "screen-menu": "" }), null), _parent);
          } else {
            _push(ssrRenderComponent(VPNavScreenMenuGroup, {
              text: item.text || "",
              items: item.items
            }, null, _parent));
          }
          _push(`<!--]-->`);
        });
        _push(`<!--]--></nav>`);
      } else {
        _push(`<!---->`);
      }
    };
  }
});
const _sfc_setup$u = _sfc_main$u.setup;
_sfc_main$u.setup = (props, ctx) => {
  const ssrContext = useSSRContext();
  (ssrContext.modules || (ssrContext.modules = /* @__PURE__ */ new Set())).add("../../node_modules/.pnpm/vitepress@1.6.4_@algolia+client-search@5.55.2_@types+node@24.13.3_@types+react@18.3.31__6511206dab6d3da37418cf3428952e99/node_modules/vitepress/dist/client/theme-default/components/VPNavScreenMenu.vue");
  return _sfc_setup$u ? _sfc_setup$u(props, ctx) : void 0;
};
const _sfc_main$t = /* @__PURE__ */ defineComponent({
  __name: "VPNavScreenSocialLinks",
  __ssrInlineRender: true,
  setup(__props) {
    const { theme: theme2 } = useData();
    return (_ctx, _push, _parent, _attrs) => {
      if (unref(theme2).socialLinks) {
        _push(ssrRenderComponent(VPSocialLinks, mergeProps({
          class: "VPNavScreenSocialLinks",
          links: unref(theme2).socialLinks
        }, _attrs), null, _parent));
      } else {
        _push(`<!---->`);
      }
    };
  }
});
const _sfc_setup$t = _sfc_main$t.setup;
_sfc_main$t.setup = (props, ctx) => {
  const ssrContext = useSSRContext();
  (ssrContext.modules || (ssrContext.modules = /* @__PURE__ */ new Set())).add("../../node_modules/.pnpm/vitepress@1.6.4_@algolia+client-search@5.55.2_@types+node@24.13.3_@types+react@18.3.31__6511206dab6d3da37418cf3428952e99/node_modules/vitepress/dist/client/theme-default/components/VPNavScreenSocialLinks.vue");
  return _sfc_setup$t ? _sfc_setup$t(props, ctx) : void 0;
};
const _sfc_main$s = /* @__PURE__ */ defineComponent({
  __name: "VPNavScreenTranslations",
  __ssrInlineRender: true,
  setup(__props) {
    const { localeLinks, currentLang } = useLangs({ correspondingLink: true });
    const isOpen = ref(false);
    return (_ctx, _push, _parent, _attrs) => {
      if (unref(localeLinks).length && unref(currentLang).label) {
        _push(`<div${ssrRenderAttrs(mergeProps({
          class: ["VPNavScreenTranslations", { open: isOpen.value }]
        }, _attrs))} data-v-e2afd81e><button class="title" data-v-e2afd81e><span class="vpi-languages icon lang" data-v-e2afd81e></span> ${ssrInterpolate(unref(currentLang).label)} <span class="vpi-chevron-down icon chevron" data-v-e2afd81e></span></button><ul class="list" data-v-e2afd81e><!--[-->`);
        ssrRenderList(unref(localeLinks), (locale) => {
          _push(`<li class="item" data-v-e2afd81e>`);
          _push(ssrRenderComponent(_sfc_main$19, {
            class: "link",
            href: locale.link
          }, {
            default: withCtx((_, _push2, _parent2, _scopeId) => {
              if (_push2) {
                _push2(`${ssrInterpolate(locale.text)}`);
              } else {
                return [
                  createTextVNode(toDisplayString(locale.text), 1)
                ];
              }
            }),
            _: 2
          }, _parent));
          _push(`</li>`);
        });
        _push(`<!--]--></ul></div>`);
      } else {
        _push(`<!---->`);
      }
    };
  }
});
const _sfc_setup$s = _sfc_main$s.setup;
_sfc_main$s.setup = (props, ctx) => {
  const ssrContext = useSSRContext();
  (ssrContext.modules || (ssrContext.modules = /* @__PURE__ */ new Set())).add("../../node_modules/.pnpm/vitepress@1.6.4_@algolia+client-search@5.55.2_@types+node@24.13.3_@types+react@18.3.31__6511206dab6d3da37418cf3428952e99/node_modules/vitepress/dist/client/theme-default/components/VPNavScreenTranslations.vue");
  return _sfc_setup$s ? _sfc_setup$s(props, ctx) : void 0;
};
const VPNavScreenTranslations = /* @__PURE__ */ _export_sfc(_sfc_main$s, [["__scopeId", "data-v-e2afd81e"]]);
const _sfc_main$r = /* @__PURE__ */ defineComponent({
  __name: "VPNavScreen",
  __ssrInlineRender: true,
  props: {
    open: { type: Boolean }
  },
  setup(__props) {
    const screen = ref(null);
    useScrollLock(inBrowser ? document.body : null);
    return (_ctx, _push, _parent, _attrs) => {
      if (__props.open) {
        _push(`<div${ssrRenderAttrs(mergeProps({
          class: "VPNavScreen",
          ref_key: "screen",
          ref: screen,
          id: "VPNavScreen"
        }, _attrs))} data-v-89fa89f2><div class="container" data-v-89fa89f2>`);
        ssrRenderSlot(_ctx.$slots, "nav-screen-content-before", {}, null, _push, _parent);
        _push(ssrRenderComponent(_sfc_main$u, { class: "menu" }, null, _parent));
        _push(ssrRenderComponent(VPNavScreenTranslations, { class: "translations" }, null, _parent));
        _push(ssrRenderComponent(VPNavScreenAppearance, { class: "appearance" }, null, _parent));
        _push(ssrRenderComponent(_sfc_main$t, { class: "social-links" }, null, _parent));
        ssrRenderSlot(_ctx.$slots, "nav-screen-content-after", {}, null, _push, _parent);
        _push(`</div></div>`);
      } else {
        _push(`<!---->`);
      }
    };
  }
});
const _sfc_setup$r = _sfc_main$r.setup;
_sfc_main$r.setup = (props, ctx) => {
  const ssrContext = useSSRContext();
  (ssrContext.modules || (ssrContext.modules = /* @__PURE__ */ new Set())).add("../../node_modules/.pnpm/vitepress@1.6.4_@algolia+client-search@5.55.2_@types+node@24.13.3_@types+react@18.3.31__6511206dab6d3da37418cf3428952e99/node_modules/vitepress/dist/client/theme-default/components/VPNavScreen.vue");
  return _sfc_setup$r ? _sfc_setup$r(props, ctx) : void 0;
};
const VPNavScreen = /* @__PURE__ */ _export_sfc(_sfc_main$r, [["__scopeId", "data-v-89fa89f2"]]);
const _sfc_main$q = /* @__PURE__ */ defineComponent({
  __name: "VPNav",
  __ssrInlineRender: true,
  setup(__props) {
    const { isScreenOpen, closeScreen, toggleScreen } = useNav();
    const { frontmatter } = useData();
    const hasNavbar = computed(() => {
      return frontmatter.value.navbar !== false;
    });
    provide("close-screen", closeScreen);
    watchEffect(() => {
      if (inBrowser) {
        document.documentElement.classList.toggle("hide-nav", !hasNavbar.value);
      }
    });
    return (_ctx, _push, _parent, _attrs) => {
      if (hasNavbar.value) {
        _push(`<header${ssrRenderAttrs(mergeProps({ class: "VPNav" }, _attrs))} data-v-f10156b5>`);
        _push(ssrRenderComponent(VPNavBar, {
          "is-screen-open": unref(isScreenOpen),
          onToggleScreen: unref(toggleScreen)
        }, {
          "nav-bar-title-before": withCtx((_, _push2, _parent2, _scopeId) => {
            if (_push2) {
              ssrRenderSlot(_ctx.$slots, "nav-bar-title-before", {}, null, _push2, _parent2, _scopeId);
            } else {
              return [
                renderSlot(_ctx.$slots, "nav-bar-title-before", {}, void 0, true)
              ];
            }
          }),
          "nav-bar-title-after": withCtx((_, _push2, _parent2, _scopeId) => {
            if (_push2) {
              ssrRenderSlot(_ctx.$slots, "nav-bar-title-after", {}, null, _push2, _parent2, _scopeId);
            } else {
              return [
                renderSlot(_ctx.$slots, "nav-bar-title-after", {}, void 0, true)
              ];
            }
          }),
          "nav-bar-content-before": withCtx((_, _push2, _parent2, _scopeId) => {
            if (_push2) {
              ssrRenderSlot(_ctx.$slots, "nav-bar-content-before", {}, null, _push2, _parent2, _scopeId);
            } else {
              return [
                renderSlot(_ctx.$slots, "nav-bar-content-before", {}, void 0, true)
              ];
            }
          }),
          "nav-bar-content-after": withCtx((_, _push2, _parent2, _scopeId) => {
            if (_push2) {
              ssrRenderSlot(_ctx.$slots, "nav-bar-content-after", {}, null, _push2, _parent2, _scopeId);
            } else {
              return [
                renderSlot(_ctx.$slots, "nav-bar-content-after", {}, void 0, true)
              ];
            }
          }),
          _: 3
        }, _parent));
        _push(ssrRenderComponent(VPNavScreen, { open: unref(isScreenOpen) }, {
          "nav-screen-content-before": withCtx((_, _push2, _parent2, _scopeId) => {
            if (_push2) {
              ssrRenderSlot(_ctx.$slots, "nav-screen-content-before", {}, null, _push2, _parent2, _scopeId);
            } else {
              return [
                renderSlot(_ctx.$slots, "nav-screen-content-before", {}, void 0, true)
              ];
            }
          }),
          "nav-screen-content-after": withCtx((_, _push2, _parent2, _scopeId) => {
            if (_push2) {
              ssrRenderSlot(_ctx.$slots, "nav-screen-content-after", {}, null, _push2, _parent2, _scopeId);
            } else {
              return [
                renderSlot(_ctx.$slots, "nav-screen-content-after", {}, void 0, true)
              ];
            }
          }),
          _: 3
        }, _parent));
        _push(`</header>`);
      } else {
        _push(`<!---->`);
      }
    };
  }
});
const _sfc_setup$q = _sfc_main$q.setup;
_sfc_main$q.setup = (props, ctx) => {
  const ssrContext = useSSRContext();
  (ssrContext.modules || (ssrContext.modules = /* @__PURE__ */ new Set())).add("../../node_modules/.pnpm/vitepress@1.6.4_@algolia+client-search@5.55.2_@types+node@24.13.3_@types+react@18.3.31__6511206dab6d3da37418cf3428952e99/node_modules/vitepress/dist/client/theme-default/components/VPNav.vue");
  return _sfc_setup$q ? _sfc_setup$q(props, ctx) : void 0;
};
const VPNav = /* @__PURE__ */ _export_sfc(_sfc_main$q, [["__scopeId", "data-v-f10156b5"]]);
const _sfc_main$p = /* @__PURE__ */ defineComponent({
  __name: "VPSidebarItem",
  __ssrInlineRender: true,
  props: {
    item: {},
    depth: {}
  },
  setup(__props) {
    const props = __props;
    const {
      collapsed,
      collapsible,
      isLink,
      isActiveLink,
      hasActiveLink: hasActiveLink2,
      hasChildren,
      toggle
    } = useSidebarControl(computed(() => props.item));
    const sectionTag = computed(() => hasChildren.value ? "section" : `div`);
    const linkTag = computed(() => isLink.value ? "a" : "div");
    const textTag = computed(() => {
      return !hasChildren.value ? "p" : props.depth + 2 === 7 ? "p" : `h${props.depth + 2}`;
    });
    const itemRole = computed(() => isLink.value ? void 0 : "button");
    const classes = computed(() => [
      [`level-${props.depth}`],
      { collapsible: collapsible.value },
      { collapsed: collapsed.value },
      { "is-link": isLink.value },
      { "is-active": isActiveLink.value },
      { "has-active": hasActiveLink2.value }
    ]);
    function onItemInteraction(e) {
      if ("key" in e && e.key !== "Enter") {
        return;
      }
      !props.item.link && toggle();
    }
    function onCaretClick() {
      props.item.link && toggle();
    }
    return (_ctx, _push, _parent, _attrs) => {
      const _component_VPSidebarItem = resolveComponent("VPSidebarItem", true);
      ssrRenderVNode(_push, createVNode(resolveDynamicComponent(sectionTag.value), mergeProps({
        class: ["VPSidebarItem", classes.value]
      }, _attrs), {
        default: withCtx((_, _push2, _parent2, _scopeId) => {
          if (_push2) {
            if (__props.item.text) {
              _push2(`<div class="item"${ssrRenderAttr("role", itemRole.value)}${ssrRenderAttr("tabindex", __props.item.items && 0)} data-v-3b4a13c4${_scopeId}><div class="indicator" data-v-3b4a13c4${_scopeId}></div>`);
              if (__props.item.link) {
                _push2(ssrRenderComponent(_sfc_main$19, {
                  tag: linkTag.value,
                  class: "link",
                  href: __props.item.link,
                  rel: __props.item.rel,
                  target: __props.item.target
                }, {
                  default: withCtx((_2, _push3, _parent3, _scopeId2) => {
                    if (_push3) {
                      ssrRenderVNode(_push3, createVNode(resolveDynamicComponent(textTag.value), { class: "text" }, null), _parent3, _scopeId2);
                    } else {
                      return [
                        (openBlock(), createBlock(resolveDynamicComponent(textTag.value), {
                          class: "text",
                          innerHTML: __props.item.text
                        }, null, 8, ["innerHTML"]))
                      ];
                    }
                  }),
                  _: 1
                }, _parent2, _scopeId));
              } else {
                ssrRenderVNode(_push2, createVNode(resolveDynamicComponent(textTag.value), { class: "text" }, null), _parent2, _scopeId);
              }
              if (__props.item.collapsed != null && __props.item.items && __props.item.items.length) {
                _push2(`<div class="caret" role="button" aria-label="toggle section" tabindex="0" data-v-3b4a13c4${_scopeId}><span class="vpi-chevron-right caret-icon" data-v-3b4a13c4${_scopeId}></span></div>`);
              } else {
                _push2(`<!---->`);
              }
              _push2(`</div>`);
            } else {
              _push2(`<!---->`);
            }
            if (__props.item.items && __props.item.items.length) {
              _push2(`<div class="items" data-v-3b4a13c4${_scopeId}>`);
              if (__props.depth < 5) {
                _push2(`<!--[-->`);
                ssrRenderList(__props.item.items, (i) => {
                  _push2(ssrRenderComponent(_component_VPSidebarItem, {
                    key: i.text,
                    item: i,
                    depth: __props.depth + 1
                  }, null, _parent2, _scopeId));
                });
                _push2(`<!--]-->`);
              } else {
                _push2(`<!---->`);
              }
              _push2(`</div>`);
            } else {
              _push2(`<!---->`);
            }
          } else {
            return [
              __props.item.text ? (openBlock(), createBlock("div", mergeProps({
                key: 0,
                class: "item",
                role: itemRole.value
              }, toHandlers(
                __props.item.items ? { click: onItemInteraction, keydown: onItemInteraction } : {},
                true
              ), {
                tabindex: __props.item.items && 0
              }), [
                createVNode("div", { class: "indicator" }),
                __props.item.link ? (openBlock(), createBlock(_sfc_main$19, {
                  key: 0,
                  tag: linkTag.value,
                  class: "link",
                  href: __props.item.link,
                  rel: __props.item.rel,
                  target: __props.item.target
                }, {
                  default: withCtx(() => [
                    (openBlock(), createBlock(resolveDynamicComponent(textTag.value), {
                      class: "text",
                      innerHTML: __props.item.text
                    }, null, 8, ["innerHTML"]))
                  ]),
                  _: 1
                }, 8, ["tag", "href", "rel", "target"])) : (openBlock(), createBlock(resolveDynamicComponent(textTag.value), {
                  key: 1,
                  class: "text",
                  innerHTML: __props.item.text
                }, null, 8, ["innerHTML"])),
                __props.item.collapsed != null && __props.item.items && __props.item.items.length ? (openBlock(), createBlock("div", {
                  key: 2,
                  class: "caret",
                  role: "button",
                  "aria-label": "toggle section",
                  onClick: onCaretClick,
                  onKeydown: withKeys(onCaretClick, ["enter"]),
                  tabindex: "0"
                }, [
                  createVNode("span", { class: "vpi-chevron-right caret-icon" })
                ], 32)) : createCommentVNode("", true)
              ], 16, ["role", "tabindex"])) : createCommentVNode("", true),
              __props.item.items && __props.item.items.length ? (openBlock(), createBlock("div", {
                key: 1,
                class: "items"
              }, [
                __props.depth < 5 ? (openBlock(true), createBlock(Fragment, { key: 0 }, renderList(__props.item.items, (i) => {
                  return openBlock(), createBlock(_component_VPSidebarItem, {
                    key: i.text,
                    item: i,
                    depth: __props.depth + 1
                  }, null, 8, ["item", "depth"]);
                }), 128)) : createCommentVNode("", true)
              ])) : createCommentVNode("", true)
            ];
          }
        }),
        _: 1
      }), _parent);
    };
  }
});
const _sfc_setup$p = _sfc_main$p.setup;
_sfc_main$p.setup = (props, ctx) => {
  const ssrContext = useSSRContext();
  (ssrContext.modules || (ssrContext.modules = /* @__PURE__ */ new Set())).add("../../node_modules/.pnpm/vitepress@1.6.4_@algolia+client-search@5.55.2_@types+node@24.13.3_@types+react@18.3.31__6511206dab6d3da37418cf3428952e99/node_modules/vitepress/dist/client/theme-default/components/VPSidebarItem.vue");
  return _sfc_setup$p ? _sfc_setup$p(props, ctx) : void 0;
};
const VPSidebarItem = /* @__PURE__ */ _export_sfc(_sfc_main$p, [["__scopeId", "data-v-3b4a13c4"]]);
const _sfc_main$o = /* @__PURE__ */ defineComponent({
  __name: "VPSidebarGroup",
  __ssrInlineRender: true,
  props: {
    items: {}
  },
  setup(__props) {
    const disableTransition = ref(true);
    let timer = null;
    onMounted(() => {
      timer = setTimeout(() => {
        timer = null;
        disableTransition.value = false;
      }, 300);
    });
    onBeforeUnmount(() => {
      if (timer != null) {
        clearTimeout(timer);
        timer = null;
      }
    });
    return (_ctx, _push, _parent, _attrs) => {
      _push(`<!--[-->`);
      ssrRenderList(__props.items, (item) => {
        _push(`<div class="${ssrRenderClass([{ "no-transition": disableTransition.value }, "group"])}" data-v-25bb723b>`);
        _push(ssrRenderComponent(VPSidebarItem, {
          item,
          depth: 0
        }, null, _parent));
        _push(`</div>`);
      });
      _push(`<!--]-->`);
    };
  }
});
const _sfc_setup$o = _sfc_main$o.setup;
_sfc_main$o.setup = (props, ctx) => {
  const ssrContext = useSSRContext();
  (ssrContext.modules || (ssrContext.modules = /* @__PURE__ */ new Set())).add("../../node_modules/.pnpm/vitepress@1.6.4_@algolia+client-search@5.55.2_@types+node@24.13.3_@types+react@18.3.31__6511206dab6d3da37418cf3428952e99/node_modules/vitepress/dist/client/theme-default/components/VPSidebarGroup.vue");
  return _sfc_setup$o ? _sfc_setup$o(props, ctx) : void 0;
};
const VPSidebarGroup = /* @__PURE__ */ _export_sfc(_sfc_main$o, [["__scopeId", "data-v-25bb723b"]]);
const _sfc_main$n = /* @__PURE__ */ defineComponent({
  __name: "VPSidebar",
  __ssrInlineRender: true,
  props: {
    open: { type: Boolean }
  },
  setup(__props) {
    const { sidebarGroups, hasSidebar } = useSidebar();
    const props = __props;
    const navEl = ref(null);
    const isLocked = useScrollLock(inBrowser ? document.body : null);
    watch(
      [props, navEl],
      () => {
        var _a;
        if (props.open) {
          isLocked.value = true;
          (_a = navEl.value) == null ? void 0 : _a.focus();
        } else isLocked.value = false;
      },
      { immediate: true, flush: "post" }
    );
    const key = ref(0);
    watch(
      sidebarGroups,
      () => {
        key.value += 1;
      },
      { deep: true }
    );
    return (_ctx, _push, _parent, _attrs) => {
      if (unref(hasSidebar)) {
        _push(`<aside${ssrRenderAttrs(mergeProps({
          class: ["VPSidebar", { open: __props.open }],
          ref_key: "navEl",
          ref: navEl
        }, _attrs))} data-v-23ce5d6c><div class="curtain" data-v-23ce5d6c></div><nav class="nav" id="VPSidebarNav" aria-labelledby="sidebar-aria-label" tabindex="-1" data-v-23ce5d6c><span class="visually-hidden" id="sidebar-aria-label" data-v-23ce5d6c> Sidebar Navigation </span>`);
        ssrRenderSlot(_ctx.$slots, "sidebar-nav-before", {}, null, _push, _parent);
        _push(ssrRenderComponent(VPSidebarGroup, {
          items: unref(sidebarGroups),
          key: key.value
        }, null, _parent));
        ssrRenderSlot(_ctx.$slots, "sidebar-nav-after", {}, null, _push, _parent);
        _push(`</nav></aside>`);
      } else {
        _push(`<!---->`);
      }
    };
  }
});
const _sfc_setup$n = _sfc_main$n.setup;
_sfc_main$n.setup = (props, ctx) => {
  const ssrContext = useSSRContext();
  (ssrContext.modules || (ssrContext.modules = /* @__PURE__ */ new Set())).add("../../node_modules/.pnpm/vitepress@1.6.4_@algolia+client-search@5.55.2_@types+node@24.13.3_@types+react@18.3.31__6511206dab6d3da37418cf3428952e99/node_modules/vitepress/dist/client/theme-default/components/VPSidebar.vue");
  return _sfc_setup$n ? _sfc_setup$n(props, ctx) : void 0;
};
const VPSidebar = /* @__PURE__ */ _export_sfc(_sfc_main$n, [["__scopeId", "data-v-23ce5d6c"]]);
const _sfc_main$m = /* @__PURE__ */ defineComponent({
  __name: "VPSkipLink",
  __ssrInlineRender: true,
  setup(__props) {
    const { theme: theme2 } = useData();
    const route = useRoute();
    const backToTop = ref();
    watch(() => route.path, () => backToTop.value.focus());
    return (_ctx, _push, _parent, _attrs) => {
      _push(`<!--[--><span tabindex="-1" data-v-4f1ce43e></span><a href="#VPContent" class="VPSkipLink visually-hidden" data-v-4f1ce43e>${ssrInterpolate(unref(theme2).skipToContentLabel || "Skip to content")}</a><!--]-->`);
    };
  }
});
const _sfc_setup$m = _sfc_main$m.setup;
_sfc_main$m.setup = (props, ctx) => {
  const ssrContext = useSSRContext();
  (ssrContext.modules || (ssrContext.modules = /* @__PURE__ */ new Set())).add("../../node_modules/.pnpm/vitepress@1.6.4_@algolia+client-search@5.55.2_@types+node@24.13.3_@types+react@18.3.31__6511206dab6d3da37418cf3428952e99/node_modules/vitepress/dist/client/theme-default/components/VPSkipLink.vue");
  return _sfc_setup$m ? _sfc_setup$m(props, ctx) : void 0;
};
const VPSkipLink = /* @__PURE__ */ _export_sfc(_sfc_main$m, [["__scopeId", "data-v-4f1ce43e"]]);
const _sfc_main$l = /* @__PURE__ */ defineComponent({
  __name: "Layout",
  __ssrInlineRender: true,
  setup(__props) {
    const {
      isOpen: isSidebarOpen,
      open: openSidebar,
      close: closeSidebar
    } = useSidebar();
    const route = useRoute();
    watch(() => route.path, closeSidebar);
    useCloseSidebarOnEscape(isSidebarOpen, closeSidebar);
    const { frontmatter } = useData();
    const slots = useSlots();
    const heroImageSlotExists = computed(() => !!slots["home-hero-image"]);
    provide("hero-image-slot-exists", heroImageSlotExists);
    return (_ctx, _push, _parent, _attrs) => {
      const _component_Content = resolveComponent("Content");
      if (unref(frontmatter).layout !== false) {
        _push(`<div${ssrRenderAttrs(mergeProps({
          class: ["Layout", unref(frontmatter).pageClass]
        }, _attrs))} data-v-2e1513f4>`);
        ssrRenderSlot(_ctx.$slots, "layout-top", {}, null, _push, _parent);
        _push(ssrRenderComponent(VPSkipLink, null, null, _parent));
        _push(ssrRenderComponent(VPBackdrop, {
          class: "backdrop",
          show: unref(isSidebarOpen),
          onClick: unref(closeSidebar)
        }, null, _parent));
        _push(ssrRenderComponent(VPNav, null, {
          "nav-bar-title-before": withCtx((_, _push2, _parent2, _scopeId) => {
            if (_push2) {
              ssrRenderSlot(_ctx.$slots, "nav-bar-title-before", {}, null, _push2, _parent2, _scopeId);
            } else {
              return [
                renderSlot(_ctx.$slots, "nav-bar-title-before", {}, void 0, true)
              ];
            }
          }),
          "nav-bar-title-after": withCtx((_, _push2, _parent2, _scopeId) => {
            if (_push2) {
              ssrRenderSlot(_ctx.$slots, "nav-bar-title-after", {}, null, _push2, _parent2, _scopeId);
            } else {
              return [
                renderSlot(_ctx.$slots, "nav-bar-title-after", {}, void 0, true)
              ];
            }
          }),
          "nav-bar-content-before": withCtx((_, _push2, _parent2, _scopeId) => {
            if (_push2) {
              ssrRenderSlot(_ctx.$slots, "nav-bar-content-before", {}, null, _push2, _parent2, _scopeId);
            } else {
              return [
                renderSlot(_ctx.$slots, "nav-bar-content-before", {}, void 0, true)
              ];
            }
          }),
          "nav-bar-content-after": withCtx((_, _push2, _parent2, _scopeId) => {
            if (_push2) {
              ssrRenderSlot(_ctx.$slots, "nav-bar-content-after", {}, null, _push2, _parent2, _scopeId);
            } else {
              return [
                renderSlot(_ctx.$slots, "nav-bar-content-after", {}, void 0, true)
              ];
            }
          }),
          "nav-screen-content-before": withCtx((_, _push2, _parent2, _scopeId) => {
            if (_push2) {
              ssrRenderSlot(_ctx.$slots, "nav-screen-content-before", {}, null, _push2, _parent2, _scopeId);
            } else {
              return [
                renderSlot(_ctx.$slots, "nav-screen-content-before", {}, void 0, true)
              ];
            }
          }),
          "nav-screen-content-after": withCtx((_, _push2, _parent2, _scopeId) => {
            if (_push2) {
              ssrRenderSlot(_ctx.$slots, "nav-screen-content-after", {}, null, _push2, _parent2, _scopeId);
            } else {
              return [
                renderSlot(_ctx.$slots, "nav-screen-content-after", {}, void 0, true)
              ];
            }
          }),
          _: 3
        }, _parent));
        _push(ssrRenderComponent(VPLocalNav, {
          open: unref(isSidebarOpen),
          onOpenMenu: unref(openSidebar)
        }, null, _parent));
        _push(ssrRenderComponent(VPSidebar, { open: unref(isSidebarOpen) }, {
          "sidebar-nav-before": withCtx((_, _push2, _parent2, _scopeId) => {
            if (_push2) {
              ssrRenderSlot(_ctx.$slots, "sidebar-nav-before", {}, null, _push2, _parent2, _scopeId);
            } else {
              return [
                renderSlot(_ctx.$slots, "sidebar-nav-before", {}, void 0, true)
              ];
            }
          }),
          "sidebar-nav-after": withCtx((_, _push2, _parent2, _scopeId) => {
            if (_push2) {
              ssrRenderSlot(_ctx.$slots, "sidebar-nav-after", {}, null, _push2, _parent2, _scopeId);
            } else {
              return [
                renderSlot(_ctx.$slots, "sidebar-nav-after", {}, void 0, true)
              ];
            }
          }),
          _: 3
        }, _parent));
        _push(ssrRenderComponent(VPContent, null, {
          "page-top": withCtx((_, _push2, _parent2, _scopeId) => {
            if (_push2) {
              ssrRenderSlot(_ctx.$slots, "page-top", {}, null, _push2, _parent2, _scopeId);
            } else {
              return [
                renderSlot(_ctx.$slots, "page-top", {}, void 0, true)
              ];
            }
          }),
          "page-bottom": withCtx((_, _push2, _parent2, _scopeId) => {
            if (_push2) {
              ssrRenderSlot(_ctx.$slots, "page-bottom", {}, null, _push2, _parent2, _scopeId);
            } else {
              return [
                renderSlot(_ctx.$slots, "page-bottom", {}, void 0, true)
              ];
            }
          }),
          "not-found": withCtx((_, _push2, _parent2, _scopeId) => {
            if (_push2) {
              ssrRenderSlot(_ctx.$slots, "not-found", {}, null, _push2, _parent2, _scopeId);
            } else {
              return [
                renderSlot(_ctx.$slots, "not-found", {}, void 0, true)
              ];
            }
          }),
          "home-hero-before": withCtx((_, _push2, _parent2, _scopeId) => {
            if (_push2) {
              ssrRenderSlot(_ctx.$slots, "home-hero-before", {}, null, _push2, _parent2, _scopeId);
            } else {
              return [
                renderSlot(_ctx.$slots, "home-hero-before", {}, void 0, true)
              ];
            }
          }),
          "home-hero-info-before": withCtx((_, _push2, _parent2, _scopeId) => {
            if (_push2) {
              ssrRenderSlot(_ctx.$slots, "home-hero-info-before", {}, null, _push2, _parent2, _scopeId);
            } else {
              return [
                renderSlot(_ctx.$slots, "home-hero-info-before", {}, void 0, true)
              ];
            }
          }),
          "home-hero-info": withCtx((_, _push2, _parent2, _scopeId) => {
            if (_push2) {
              ssrRenderSlot(_ctx.$slots, "home-hero-info", {}, null, _push2, _parent2, _scopeId);
            } else {
              return [
                renderSlot(_ctx.$slots, "home-hero-info", {}, void 0, true)
              ];
            }
          }),
          "home-hero-info-after": withCtx((_, _push2, _parent2, _scopeId) => {
            if (_push2) {
              ssrRenderSlot(_ctx.$slots, "home-hero-info-after", {}, null, _push2, _parent2, _scopeId);
            } else {
              return [
                renderSlot(_ctx.$slots, "home-hero-info-after", {}, void 0, true)
              ];
            }
          }),
          "home-hero-actions-after": withCtx((_, _push2, _parent2, _scopeId) => {
            if (_push2) {
              ssrRenderSlot(_ctx.$slots, "home-hero-actions-after", {}, null, _push2, _parent2, _scopeId);
            } else {
              return [
                renderSlot(_ctx.$slots, "home-hero-actions-after", {}, void 0, true)
              ];
            }
          }),
          "home-hero-image": withCtx((_, _push2, _parent2, _scopeId) => {
            if (_push2) {
              ssrRenderSlot(_ctx.$slots, "home-hero-image", {}, null, _push2, _parent2, _scopeId);
            } else {
              return [
                renderSlot(_ctx.$slots, "home-hero-image", {}, void 0, true)
              ];
            }
          }),
          "home-hero-after": withCtx((_, _push2, _parent2, _scopeId) => {
            if (_push2) {
              ssrRenderSlot(_ctx.$slots, "home-hero-after", {}, null, _push2, _parent2, _scopeId);
            } else {
              return [
                renderSlot(_ctx.$slots, "home-hero-after", {}, void 0, true)
              ];
            }
          }),
          "home-features-before": withCtx((_, _push2, _parent2, _scopeId) => {
            if (_push2) {
              ssrRenderSlot(_ctx.$slots, "home-features-before", {}, null, _push2, _parent2, _scopeId);
            } else {
              return [
                renderSlot(_ctx.$slots, "home-features-before", {}, void 0, true)
              ];
            }
          }),
          "home-features-after": withCtx((_, _push2, _parent2, _scopeId) => {
            if (_push2) {
              ssrRenderSlot(_ctx.$slots, "home-features-after", {}, null, _push2, _parent2, _scopeId);
            } else {
              return [
                renderSlot(_ctx.$slots, "home-features-after", {}, void 0, true)
              ];
            }
          }),
          "doc-footer-before": withCtx((_, _push2, _parent2, _scopeId) => {
            if (_push2) {
              ssrRenderSlot(_ctx.$slots, "doc-footer-before", {}, null, _push2, _parent2, _scopeId);
            } else {
              return [
                renderSlot(_ctx.$slots, "doc-footer-before", {}, void 0, true)
              ];
            }
          }),
          "doc-before": withCtx((_, _push2, _parent2, _scopeId) => {
            if (_push2) {
              ssrRenderSlot(_ctx.$slots, "doc-before", {}, null, _push2, _parent2, _scopeId);
            } else {
              return [
                renderSlot(_ctx.$slots, "doc-before", {}, void 0, true)
              ];
            }
          }),
          "doc-after": withCtx((_, _push2, _parent2, _scopeId) => {
            if (_push2) {
              ssrRenderSlot(_ctx.$slots, "doc-after", {}, null, _push2, _parent2, _scopeId);
            } else {
              return [
                renderSlot(_ctx.$slots, "doc-after", {}, void 0, true)
              ];
            }
          }),
          "doc-top": withCtx((_, _push2, _parent2, _scopeId) => {
            if (_push2) {
              ssrRenderSlot(_ctx.$slots, "doc-top", {}, null, _push2, _parent2, _scopeId);
            } else {
              return [
                renderSlot(_ctx.$slots, "doc-top", {}, void 0, true)
              ];
            }
          }),
          "doc-bottom": withCtx((_, _push2, _parent2, _scopeId) => {
            if (_push2) {
              ssrRenderSlot(_ctx.$slots, "doc-bottom", {}, null, _push2, _parent2, _scopeId);
            } else {
              return [
                renderSlot(_ctx.$slots, "doc-bottom", {}, void 0, true)
              ];
            }
          }),
          "aside-top": withCtx((_, _push2, _parent2, _scopeId) => {
            if (_push2) {
              ssrRenderSlot(_ctx.$slots, "aside-top", {}, null, _push2, _parent2, _scopeId);
            } else {
              return [
                renderSlot(_ctx.$slots, "aside-top", {}, void 0, true)
              ];
            }
          }),
          "aside-bottom": withCtx((_, _push2, _parent2, _scopeId) => {
            if (_push2) {
              ssrRenderSlot(_ctx.$slots, "aside-bottom", {}, null, _push2, _parent2, _scopeId);
            } else {
              return [
                renderSlot(_ctx.$slots, "aside-bottom", {}, void 0, true)
              ];
            }
          }),
          "aside-outline-before": withCtx((_, _push2, _parent2, _scopeId) => {
            if (_push2) {
              ssrRenderSlot(_ctx.$slots, "aside-outline-before", {}, null, _push2, _parent2, _scopeId);
            } else {
              return [
                renderSlot(_ctx.$slots, "aside-outline-before", {}, void 0, true)
              ];
            }
          }),
          "aside-outline-after": withCtx((_, _push2, _parent2, _scopeId) => {
            if (_push2) {
              ssrRenderSlot(_ctx.$slots, "aside-outline-after", {}, null, _push2, _parent2, _scopeId);
            } else {
              return [
                renderSlot(_ctx.$slots, "aside-outline-after", {}, void 0, true)
              ];
            }
          }),
          "aside-ads-before": withCtx((_, _push2, _parent2, _scopeId) => {
            if (_push2) {
              ssrRenderSlot(_ctx.$slots, "aside-ads-before", {}, null, _push2, _parent2, _scopeId);
            } else {
              return [
                renderSlot(_ctx.$slots, "aside-ads-before", {}, void 0, true)
              ];
            }
          }),
          "aside-ads-after": withCtx((_, _push2, _parent2, _scopeId) => {
            if (_push2) {
              ssrRenderSlot(_ctx.$slots, "aside-ads-after", {}, null, _push2, _parent2, _scopeId);
            } else {
              return [
                renderSlot(_ctx.$slots, "aside-ads-after", {}, void 0, true)
              ];
            }
          }),
          _: 3
        }, _parent));
        _push(ssrRenderComponent(VPFooter, null, null, _parent));
        ssrRenderSlot(_ctx.$slots, "layout-bottom", {}, null, _push, _parent);
        _push(`</div>`);
      } else {
        _push(ssrRenderComponent(_component_Content, _attrs, null, _parent));
      }
    };
  }
});
const _sfc_setup$l = _sfc_main$l.setup;
_sfc_main$l.setup = (props, ctx) => {
  const ssrContext = useSSRContext();
  (ssrContext.modules || (ssrContext.modules = /* @__PURE__ */ new Set())).add("../../node_modules/.pnpm/vitepress@1.6.4_@algolia+client-search@5.55.2_@types+node@24.13.3_@types+react@18.3.31__6511206dab6d3da37418cf3428952e99/node_modules/vitepress/dist/client/theme-default/Layout.vue");
  return _sfc_setup$l ? _sfc_setup$l(props, ctx) : void 0;
};
const Layout = /* @__PURE__ */ _export_sfc(_sfc_main$l, [["__scopeId", "data-v-2e1513f4"]]);
const GridSettings = {
  xmini: [[0, 2]],
  mini: [],
  small: [
    [920, 6],
    [768, 5],
    [640, 4],
    [480, 3],
    [0, 2]
  ],
  medium: [
    [960, 5],
    [832, 4],
    [640, 3],
    [480, 2]
  ],
  big: [
    [832, 3],
    [640, 2]
  ]
};
function useSponsorsGrid({ el, size = "medium" }) {
  const onResize = throttleAndDebounce(manage, 100);
  onMounted(() => {
    manage();
    window.addEventListener("resize", onResize);
  });
  onUnmounted(() => {
    window.removeEventListener("resize", onResize);
  });
  function manage() {
    adjustSlots(el.value, size);
  }
}
function adjustSlots(el, size) {
  const tsize = el.children.length;
  const asize = el.querySelectorAll(".vp-sponsor-grid-item:not(.empty)").length;
  const grid = setGrid(el, size, asize);
  manageSlots(el, grid, tsize, asize);
}
function setGrid(el, size, items) {
  const settings = GridSettings[size];
  const screen = window.innerWidth;
  let grid = 1;
  settings.some(([breakpoint, value]) => {
    if (screen >= breakpoint) {
      grid = items < value ? items : value;
      return true;
    }
  });
  setGridData(el, grid);
  return grid;
}
function setGridData(el, value) {
  el.dataset.vpGrid = String(value);
}
function manageSlots(el, grid, tsize, asize) {
  const diff = tsize - asize;
  const rem = asize % grid;
  const drem = rem === 0 ? rem : grid - rem;
  neutralizeSlots(el, drem - diff);
}
function neutralizeSlots(el, count) {
  if (count === 0) {
    return;
  }
  count > 0 ? addSlots(el, count) : removeSlots(el, count * -1);
}
function addSlots(el, count) {
  for (let i = 0; i < count; i++) {
    const slot = document.createElement("div");
    slot.classList.add("vp-sponsor-grid-item", "empty");
    el.append(slot);
  }
}
function removeSlots(el, count) {
  for (let i = 0; i < count; i++) {
    el.removeChild(el.lastElementChild);
  }
}
const _sfc_main$k = /* @__PURE__ */ defineComponent({
  __name: "VPSponsorsGrid",
  __ssrInlineRender: true,
  props: {
    size: { default: "medium" },
    data: {}
  },
  setup(__props) {
    const props = __props;
    const el = ref(null);
    useSponsorsGrid({ el, size: props.size });
    return (_ctx, _push, _parent, _attrs) => {
      _push(`<div${ssrRenderAttrs(mergeProps({
        class: ["VPSponsorsGrid vp-sponsor-grid", [__props.size]],
        ref_key: "el",
        ref: el
      }, _attrs))}><!--[-->`);
      ssrRenderList(__props.data, (sponsor) => {
        _push(`<div class="vp-sponsor-grid-item"><a class="vp-sponsor-grid-link"${ssrRenderAttr("href", sponsor.url)} target="_blank" rel="sponsored noopener"><article class="vp-sponsor-grid-box"><h4 class="visually-hidden">${ssrInterpolate(sponsor.name)}</h4><img class="vp-sponsor-grid-image"${ssrRenderAttr("src", sponsor.img)}${ssrRenderAttr("alt", sponsor.name)}></article></a></div>`);
      });
      _push(`<!--]--></div>`);
    };
  }
});
const _sfc_setup$k = _sfc_main$k.setup;
_sfc_main$k.setup = (props, ctx) => {
  const ssrContext = useSSRContext();
  (ssrContext.modules || (ssrContext.modules = /* @__PURE__ */ new Set())).add("../../node_modules/.pnpm/vitepress@1.6.4_@algolia+client-search@5.55.2_@types+node@24.13.3_@types+react@18.3.31__6511206dab6d3da37418cf3428952e99/node_modules/vitepress/dist/client/theme-default/components/VPSponsorsGrid.vue");
  return _sfc_setup$k ? _sfc_setup$k(props, ctx) : void 0;
};
const _sfc_main$j = /* @__PURE__ */ defineComponent({
  __name: "VPSponsors",
  __ssrInlineRender: true,
  props: {
    mode: { default: "normal" },
    tier: {},
    size: {},
    data: {}
  },
  setup(__props) {
    const props = __props;
    const sponsors = computed(() => {
      const isSponsors = props.data.some((s) => {
        return "items" in s;
      });
      if (isSponsors) {
        return props.data;
      }
      return [
        { tier: props.tier, size: props.size, items: props.data }
      ];
    });
    return (_ctx, _push, _parent, _attrs) => {
      _push(`<div${ssrRenderAttrs(mergeProps({
        class: ["VPSponsors vp-sponsor", [__props.mode]]
      }, _attrs))}><!--[-->`);
      ssrRenderList(sponsors.value, (sponsor, index) => {
        _push(`<section class="vp-sponsor-section">`);
        if (sponsor.tier) {
          _push(`<h3 class="vp-sponsor-tier">${ssrInterpolate(sponsor.tier)}</h3>`);
        } else {
          _push(`<!---->`);
        }
        _push(ssrRenderComponent(_sfc_main$k, {
          size: sponsor.size,
          data: sponsor.items
        }, null, _parent));
        _push(`</section>`);
      });
      _push(`<!--]--></div>`);
    };
  }
});
const _sfc_setup$j = _sfc_main$j.setup;
_sfc_main$j.setup = (props, ctx) => {
  const ssrContext = useSSRContext();
  (ssrContext.modules || (ssrContext.modules = /* @__PURE__ */ new Set())).add("../../node_modules/.pnpm/vitepress@1.6.4_@algolia+client-search@5.55.2_@types+node@24.13.3_@types+react@18.3.31__6511206dab6d3da37418cf3428952e99/node_modules/vitepress/dist/client/theme-default/components/VPSponsors.vue");
  return _sfc_setup$j ? _sfc_setup$j(props, ctx) : void 0;
};
const _sfc_main$i = /* @__PURE__ */ defineComponent({
  __name: "VPDocAsideSponsors",
  __ssrInlineRender: true,
  props: {
    tier: {},
    size: {},
    data: {}
  },
  setup(__props) {
    return (_ctx, _push, _parent, _attrs) => {
      _push(`<div${ssrRenderAttrs(mergeProps({ class: "VPDocAsideSponsors" }, _attrs))}>`);
      _push(ssrRenderComponent(_sfc_main$j, {
        mode: "aside",
        tier: __props.tier,
        size: __props.size,
        data: __props.data
      }, null, _parent));
      _push(`</div>`);
    };
  }
});
const _sfc_setup$i = _sfc_main$i.setup;
_sfc_main$i.setup = (props, ctx) => {
  const ssrContext = useSSRContext();
  (ssrContext.modules || (ssrContext.modules = /* @__PURE__ */ new Set())).add("../../node_modules/.pnpm/vitepress@1.6.4_@algolia+client-search@5.55.2_@types+node@24.13.3_@types+react@18.3.31__6511206dab6d3da37418cf3428952e99/node_modules/vitepress/dist/client/theme-default/components/VPDocAsideSponsors.vue");
  return _sfc_setup$i ? _sfc_setup$i(props, ctx) : void 0;
};
const _sfc_main$h = /* @__PURE__ */ defineComponent({
  __name: "VPHomeSponsors",
  __ssrInlineRender: true,
  props: {
    message: {},
    actionText: { default: "Become a sponsor" },
    actionLink: {},
    data: {}
  },
  setup(__props) {
    return (_ctx, _push, _parent, _attrs) => {
      _push(`<section${ssrRenderAttrs(mergeProps({ class: "VPHomeSponsors" }, _attrs))} data-v-59320fcb><div class="container" data-v-59320fcb><div class="header" data-v-59320fcb><div class="love" data-v-59320fcb><span class="vpi-heart icon" data-v-59320fcb></span></div>`);
      if (__props.message) {
        _push(`<h2 class="message" data-v-59320fcb>${ssrInterpolate(__props.message)}</h2>`);
      } else {
        _push(`<!---->`);
      }
      _push(`</div><div class="sponsors" data-v-59320fcb>`);
      _push(ssrRenderComponent(_sfc_main$j, { data: __props.data }, null, _parent));
      _push(`</div>`);
      if (__props.actionLink) {
        _push(`<div class="action" data-v-59320fcb>`);
        _push(ssrRenderComponent(VPButton, {
          theme: "sponsor",
          text: __props.actionText,
          href: __props.actionLink
        }, null, _parent));
        _push(`</div>`);
      } else {
        _push(`<!---->`);
      }
      _push(`</div></section>`);
    };
  }
});
const _sfc_setup$h = _sfc_main$h.setup;
_sfc_main$h.setup = (props, ctx) => {
  const ssrContext = useSSRContext();
  (ssrContext.modules || (ssrContext.modules = /* @__PURE__ */ new Set())).add("../../node_modules/.pnpm/vitepress@1.6.4_@algolia+client-search@5.55.2_@types+node@24.13.3_@types+react@18.3.31__6511206dab6d3da37418cf3428952e99/node_modules/vitepress/dist/client/theme-default/components/VPHomeSponsors.vue");
  return _sfc_setup$h ? _sfc_setup$h(props, ctx) : void 0;
};
const _sfc_main$g = /* @__PURE__ */ defineComponent({
  __name: "VPTeamMembersItem",
  __ssrInlineRender: true,
  props: {
    size: { default: "medium" },
    member: {}
  },
  setup(__props) {
    return (_ctx, _push, _parent, _attrs) => {
      _push(`<article${ssrRenderAttrs(mergeProps({
        class: ["VPTeamMembersItem", [__props.size]]
      }, _attrs))} data-v-696d1064><div class="profile" data-v-696d1064><figure class="avatar" data-v-696d1064><img class="avatar-img"${ssrRenderAttr("src", __props.member.avatar)}${ssrRenderAttr("alt", __props.member.name)} data-v-696d1064></figure><div class="data" data-v-696d1064><h1 class="name" data-v-696d1064>${ssrInterpolate(__props.member.name)}</h1>`);
      if (__props.member.title || __props.member.org) {
        _push(`<p class="affiliation" data-v-696d1064>`);
        if (__props.member.title) {
          _push(`<span class="title" data-v-696d1064>${ssrInterpolate(__props.member.title)}</span>`);
        } else {
          _push(`<!---->`);
        }
        if (__props.member.title && __props.member.org) {
          _push(`<span class="at" data-v-696d1064> @ </span>`);
        } else {
          _push(`<!---->`);
        }
        if (__props.member.org) {
          _push(ssrRenderComponent(_sfc_main$19, {
            class: ["org", { link: __props.member.orgLink }],
            href: __props.member.orgLink,
            "no-icon": ""
          }, {
            default: withCtx((_, _push2, _parent2, _scopeId) => {
              if (_push2) {
                _push2(`${ssrInterpolate(__props.member.org)}`);
              } else {
                return [
                  createTextVNode(toDisplayString(__props.member.org), 1)
                ];
              }
            }),
            _: 1
          }, _parent));
        } else {
          _push(`<!---->`);
        }
        _push(`</p>`);
      } else {
        _push(`<!---->`);
      }
      if (__props.member.desc) {
        _push(`<p class="desc" data-v-696d1064>${__props.member.desc ?? ""}</p>`);
      } else {
        _push(`<!---->`);
      }
      if (__props.member.links) {
        _push(`<div class="links" data-v-696d1064>`);
        _push(ssrRenderComponent(VPSocialLinks, {
          links: __props.member.links
        }, null, _parent));
        _push(`</div>`);
      } else {
        _push(`<!---->`);
      }
      _push(`</div></div>`);
      if (__props.member.sponsor) {
        _push(`<div class="sp" data-v-696d1064>`);
        _push(ssrRenderComponent(_sfc_main$19, {
          class: "sp-link",
          href: __props.member.sponsor,
          "no-icon": ""
        }, {
          default: withCtx((_, _push2, _parent2, _scopeId) => {
            if (_push2) {
              _push2(`<span class="vpi-heart sp-icon" data-v-696d1064${_scopeId}></span> ${ssrInterpolate(__props.member.actionText || "Sponsor")}`);
            } else {
              return [
                createVNode("span", { class: "vpi-heart sp-icon" }),
                createTextVNode(" " + toDisplayString(__props.member.actionText || "Sponsor"), 1)
              ];
            }
          }),
          _: 1
        }, _parent));
        _push(`</div>`);
      } else {
        _push(`<!---->`);
      }
      _push(`</article>`);
    };
  }
});
const _sfc_setup$g = _sfc_main$g.setup;
_sfc_main$g.setup = (props, ctx) => {
  const ssrContext = useSSRContext();
  (ssrContext.modules || (ssrContext.modules = /* @__PURE__ */ new Set())).add("../../node_modules/.pnpm/vitepress@1.6.4_@algolia+client-search@5.55.2_@types+node@24.13.3_@types+react@18.3.31__6511206dab6d3da37418cf3428952e99/node_modules/vitepress/dist/client/theme-default/components/VPTeamMembersItem.vue");
  return _sfc_setup$g ? _sfc_setup$g(props, ctx) : void 0;
};
const VPTeamMembersItem = /* @__PURE__ */ _export_sfc(_sfc_main$g, [["__scopeId", "data-v-696d1064"]]);
const _sfc_main$f = /* @__PURE__ */ defineComponent({
  __name: "VPTeamMembers",
  __ssrInlineRender: true,
  props: {
    size: { default: "medium" },
    members: {}
  },
  setup(__props) {
    const props = __props;
    const classes = computed(() => [props.size, `count-${props.members.length}`]);
    return (_ctx, _push, _parent, _attrs) => {
      _push(`<div${ssrRenderAttrs(mergeProps({
        class: ["VPTeamMembers", classes.value]
      }, _attrs))} data-v-f93070ea><div class="container" data-v-f93070ea><!--[-->`);
      ssrRenderList(__props.members, (member) => {
        _push(`<div class="item" data-v-f93070ea>`);
        _push(ssrRenderComponent(VPTeamMembersItem, {
          size: __props.size,
          member
        }, null, _parent));
        _push(`</div>`);
      });
      _push(`<!--]--></div></div>`);
    };
  }
});
const _sfc_setup$f = _sfc_main$f.setup;
_sfc_main$f.setup = (props, ctx) => {
  const ssrContext = useSSRContext();
  (ssrContext.modules || (ssrContext.modules = /* @__PURE__ */ new Set())).add("../../node_modules/.pnpm/vitepress@1.6.4_@algolia+client-search@5.55.2_@types+node@24.13.3_@types+react@18.3.31__6511206dab6d3da37418cf3428952e99/node_modules/vitepress/dist/client/theme-default/components/VPTeamMembers.vue");
  return _sfc_setup$f ? _sfc_setup$f(props, ctx) : void 0;
};
const _sfc_main$e = {};
const _sfc_setup$e = _sfc_main$e.setup;
_sfc_main$e.setup = (props, ctx) => {
  const ssrContext = useSSRContext();
  (ssrContext.modules || (ssrContext.modules = /* @__PURE__ */ new Set())).add("../../node_modules/.pnpm/vitepress@1.6.4_@algolia+client-search@5.55.2_@types+node@24.13.3_@types+react@18.3.31__6511206dab6d3da37418cf3428952e99/node_modules/vitepress/dist/client/theme-default/components/VPTeamPage.vue");
  return _sfc_setup$e ? _sfc_setup$e(props, ctx) : void 0;
};
const _sfc_main$d = {};
const _sfc_setup$d = _sfc_main$d.setup;
_sfc_main$d.setup = (props, ctx) => {
  const ssrContext = useSSRContext();
  (ssrContext.modules || (ssrContext.modules = /* @__PURE__ */ new Set())).add("../../node_modules/.pnpm/vitepress@1.6.4_@algolia+client-search@5.55.2_@types+node@24.13.3_@types+react@18.3.31__6511206dab6d3da37418cf3428952e99/node_modules/vitepress/dist/client/theme-default/components/VPTeamPageSection.vue");
  return _sfc_setup$d ? _sfc_setup$d(props, ctx) : void 0;
};
const _sfc_main$c = {};
const _sfc_setup$c = _sfc_main$c.setup;
_sfc_main$c.setup = (props, ctx) => {
  const ssrContext = useSSRContext();
  (ssrContext.modules || (ssrContext.modules = /* @__PURE__ */ new Set())).add("../../node_modules/.pnpm/vitepress@1.6.4_@algolia+client-search@5.55.2_@types+node@24.13.3_@types+react@18.3.31__6511206dab6d3da37418cf3428952e99/node_modules/vitepress/dist/client/theme-default/components/VPTeamPageTitle.vue");
  return _sfc_setup$c ? _sfc_setup$c(props, ctx) : void 0;
};
const theme = {
  Layout,
  enhanceApp: ({ app }) => {
    app.component("Badge", _sfc_main$1g);
  }
};
const sample = `// The vertical's own operation, composing the work-order engine.
const createWorkOrderOp = async (ctx, input) => {
  assertAllowed(await ctx.check(WO.create));

  const facility = ctx.sql.query(
    'SELECT * FROM callout_facilities WHERE id = ?',
    [input.facilityId],
  )[0];
  if (!facility) throw new Error(\`facility not found: \${input.facilityId}\`);

  return createWorkOrder(ctx, {          // the engine's in-scope function,
    facility: ref('facility', facility.id),   // inside YOUR transaction
    customer: ref('customer', facility.customer_id),
    kind: input.kind,
    title: input.title,
  });
};`;
const repo = "https://github.com/substrat-run/substrat";
const _sfc_main$b = /* @__PURE__ */ defineComponent({
  __name: "Marketing",
  __ssrInlineRender: true,
  setup(__props) {
    const layers = [
      {
        key: "kernel",
        name: "Kernel",
        desc: "Everything true of every B2B SaaS, nothing true of any particular one: identity, nested tenancy, permissions, events & audit, GDPR machinery. Owns no domain entities."
      },
      {
        key: "engine",
        name: "Engines",
        desc: "Shared domain machinery — work orders, invoicing, protocols — that owns invariants: state machines are declared and can’t skip states, exported invoices are immutable, every mutation emits an event."
      },
      {
        key: "vertical",
        name: "Verticals",
        desc: "The actual products — your code. Vocabulary, workflows, screens, pricing. The layer where AI tools do their best work, because mistakes there are cosmetic."
      }
    ];
    const cannots = [
      [
        "Reach another tenant’s data",
        "Data access only exists as capability-scoped operations minted for one (tenant, scope) pair — a mismatch fails closed."
      ],
      [
        "Skip the audit log",
        "Events are stamped with tenant, scope, actor, and timestamp below the API surface. Calling code cannot forge or suppress them."
      ],
      [
        "Emit unclassified PII",
        "Every event carries a mandatory piiClass; a PII-classed event without a data-subject key fails validation, so GDPR erasure is always possible."
      ],
      [
        "Bypass the permission model",
        "Operations run inside the scope’s execution domain; every allow carries the proof path that granted it. The secure default is deny everything."
      ]
    ];
    const ops = [
      [
        "Test copies of any app",
        "Snapshot a running app’s data into an independent copy — try the risky thing on real data, then throw the copy away. Copies expire on a TTL and are reaped automatically.",
        "/concepts/snapshots"
      ],
      [
        "Fearless upgrades",
        "An update that changes the schema snapshots the data first, automatically — so a bad migration has a rollback point. A code-only update just rebinds.",
        "/concepts/snapshots#the-one-rule-everything-follows"
      ],
      [
        "Real data on your laptop, governed",
        "substrat scope pull writes a real SQLite file your local harness runs unchanged — audited, jurisdiction-checked, and masked by default. Full fidelity is an explicit break-glass.",
        "/concepts/snapshots#where-the-data-goes-and-doesn-t"
      ]
    ];
    const demos = [
      ["RallyPoint", "Padel club", "engine", "Court booking as allocation over an interval rather than a state machine — the lost race rejected with no locking code anywhere, multi-venue tenancy, and a player who holds no role at all reaching their own booking through an entity-narrowed grant.", "/verticals/rallypoint"],
      ["Meridian", "HR", "kernel", "The shape-breaker: no engine exists for its core domain, so leave, time and expenses are vertical code on the kernel alone. Multi-country scopes diverging from one codebase, and one role-adaptive app serving employee and manager in the same surface.", "/verticals/meridian"],
      ["Callout", "Field service", "vertical", "The canonical composition — a Swedish service & installation firm where two engines cooperate through events with zero imports between them. Runs on SQLite locally and deployed on Cloudflare from one codebase.", "/verticals/"]
    ];
    const pkgs = [
      ["@substrat-run/contracts", "Zod contract schemas — the source of truth", "Working"],
      ["@substrat-run/kernel", "Scope-host contract + tuple permission checker", "Working"],
      ["@substrat-run/adapter-sqlite", "Pure-SQLite scope host — local dev, CI, self-host", "Working"],
      ["@substrat-run/adapter-cloudflare", "Durable-Object scope host — production", "Working"],
      ["@substrat-run/contract-tests", "The conformance suite both adapters pass unchanged", "Working"],
      ["@substrat-run/model-emit", "DDL and state machines emitted from your declared model, and the reader that checks it", "Working"],
      ["@substrat-run/vertical-host", "The platform surface a hosted vertical mounts", "Working"],
      ["@substrat-run/cli", "substrat login / push — authenticated deploy", "Working"],
      ["@substrat-run/engine-workorder", "Work orders, time & material", "Seed"],
      ["@substrat-run/engine-booking", "Reservations — resource × interval, one allocation invariant, no locks", "Seed"],
      ["@substrat-run/engine-invoicing", "Invoice basis, immutable exports", "Seed"],
      ["@substrat-run/engine-protocol", "Checklists & protocols", "Seed"],
      ["@substrat-run/engine-invites", "Invitations — verified hashed identifier, accept-required", "Seed"],
      ["@substrat-run/engine-absence", "Leave and absence — balances as an entry ledger", "Seed"],
      ["@substrat-run/engine-metering", "Usage readings folded into billable meters", "Seed"]
    ];
    const didnt = [
      [
        "No tenant filter",
        "There is no WHERE tenant_id to forget. ctx.sql reaches this scope’s own database and cannot address another."
      ],
      [
        "No audit call",
        "The engine emitted a work-order event stamped with tenant, scope, actor and time — below this code, which cannot forge or suppress it."
      ],
      [
        "No transaction management",
        "The operation is the transaction. The throw on line 8 rolls back the rows, the events, and any platform intent it had enqueued."
      ],
      [
        "No lock, no retry loop",
        "One operation runs in this scope at a time, to completion. Read-modify-write needs no ceremony."
      ],
      [
        "No fork of the engine",
        "createWorkOrder is a plain export called inside the vertical’s own handler — extension by composition, so upgrading the engine stays an upgrade."
      ]
    ];
    const forAgents = [
      [
        "Derived, not generated",
        "Entities, operations and state machines are declared once; the DDL and the model artifact are emitted by code, and CI fails on drift. Cheaper than a model in tokens, latency and exactness — and smaller to hold in context afterwards.",
        "/concepts/model"
      ],
      [
        "An oracle the build didn’t write",
        "Code comes from the model; tests come from the human-approved concept. Two independent derivations, and the disagreement between them is the product. A suite written after the handlers can only agree with whatever got built.",
        "/guide/ai-agents#the-second-opinion-two-descriptions-that-can-disagree"
      ],
      [
        "Bring your own model",
        "Design and build run in your agent — Claude Code, Cursor, opencode — against skills that ship in the project. Your tokens, your model, and a repo that boots on SQLite with no platform in the loop.",
        "/guide/ai-agents#bring-your-own-model-bring-your-own-agent"
      ],
      [
        "Every PR gets a copy of production",
        "Open a pull request and the platform forks the production scope, runs that PR’s own migrations against the copy, and posts the URL. Reviewing a migration diff is a checkpoint; watching it run on real data is what makes it honest.",
        "/guide/environments-and-previews"
      ]
    ];
    return (_ctx, _push, _parent, _attrs) => {
      _push(`<div${ssrRenderAttrs(mergeProps({ class: "mkt" }, _attrs))} data-v-9d488e08><section class="bleed hero" data-v-9d488e08><div class="wrap hero-inner" data-v-9d488e08><span class="badge badge-info" data-v-9d488e08><span class="dot" data-v-9d488e08></span>Pre-release 0.x — working end to end on two adapters </span><h1 data-v-9d488e08>The hard parts, hosted.</h1><p class="lede" data-v-9d488e08> AI made building vertical B2B software fast — except multi-tenancy, identity, permissions, audit, and GDPR. Substrat owns those parts and enforces them at runtime, so small teams can build production-grade SaaS on top without the speed being fatal. </p><div class="cta-row" data-v-9d488e08><a class="btn btn-primary" href="/guide/getting-started" data-v-9d488e08>Get started</a><a class="btn btn-secondary" href="/guide/why-substrat" data-v-9d488e08>Why runtime enforcement</a><code class="cmd" data-v-9d488e08>npm create substrat my-app</code></div></div></section><section class="wrap section" data-v-9d488e08><div class="kicker" data-v-9d488e08>What you write</div><h2 data-v-9d488e08>One operation, whole.</h2><p class="muted lede-narrow" data-v-9d488e08> This is the entire handler. Everything in the right-hand column happened anyway — not because the code asked for it, but because it could not avoid it. </p><div class="split" data-v-9d488e08><pre class="code" data-v-9d488e08><code data-v-9d488e08>${ssrInterpolate(sample)}</code></pre><ul class="didnt" data-v-9d488e08><!--[-->`);
      ssrRenderList(didnt, ([title, desc]) => {
        _push(`<li data-v-9d488e08><span class="didnt-title" data-v-9d488e08>${ssrInterpolate(title)}</span><span class="muted sm" data-v-9d488e08>${ssrInterpolate(desc)}</span></li>`);
      });
      _push(`<!--]--></ul></div></section><section class="wrap section" data-v-9d488e08><div class="kicker" data-v-9d488e08>The idea in three layers</div><h2 data-v-9d488e08>We build the substrate. You build the verticals.</h2><div class="grid-3" data-v-9d488e08><!--[-->`);
      ssrRenderList(layers, (l) => {
        _push(`<div class="layer-card" data-v-9d488e08><div class="${ssrRenderClass([`layer-${l.key}`, "layer-bar"])}" data-v-9d488e08></div><div class="layer-body" data-v-9d488e08><div class="layer-head" data-v-9d488e08><span class="layer-name" data-v-9d488e08>${ssrInterpolate(l.name)}</span><code class="tag" data-v-9d488e08>--layer-${ssrInterpolate(l.key)}</code></div><p class="muted" data-v-9d488e08>${ssrInterpolate(l.desc)}</p></div></div>`);
      });
      _push(`<!--]--></div></section><section class="bleed band" data-v-9d488e08><div class="wrap section" data-v-9d488e08><div class="kicker" data-v-9d488e08>Enforced at runtime</div><h2 data-v-9d488e08>Code built on Substrat cannot:</h2><p class="muted lede-narrow" data-v-9d488e08> None of this depends on the discipline of the code above it — which is the point, because increasingly that code is written by an agent. </p><div class="grid-2" data-v-9d488e08><!--[-->`);
      ssrRenderList(cannots, ([title, desc]) => {
        _push(`<div class="cannot" data-v-9d488e08><span class="x" data-v-9d488e08>✕</span><div data-v-9d488e08><div class="cannot-title" data-v-9d488e08>${ssrInterpolate(title)}</div><div class="muted sm" data-v-9d488e08>${ssrInterpolate(desc)}</div></div></div>`);
      });
      _push(`<!--]--></div></div></section><section class="wrap section" data-v-9d488e08><div class="kicker" data-v-9d488e08>Day-2 operations, day one</div><h2 data-v-9d488e08>The ops a platform team would build — built in.</h2><p class="muted lede-narrow" data-v-9d488e08> Every app is one tenant’s scope with its own database, so the operations story is a platform primitive, not a runbook. </p><div class="grid-2" data-v-9d488e08><!--[-->`);
      ssrRenderList(ops, ([title, desc, href]) => {
        _push(`<a class="cannot op"${ssrRenderAttr("href", href)} data-v-9d488e08><span class="check" data-v-9d488e08>✓</span><div data-v-9d488e08><div class="cannot-title" data-v-9d488e08>${ssrInterpolate(title)}</div><div class="muted sm" data-v-9d488e08>${ssrInterpolate(desc)}</div></div></a>`);
      });
      _push(`<!--]--></div></section><section class="bleed band" data-v-9d488e08><div class="wrap section" data-v-9d488e08><div class="kicker" data-v-9d488e08>Built for agents, on purpose</div><h2 data-v-9d488e08>The layer AI is worst at is the layer that’s already written.</h2><p class="muted lede-narrow" data-v-9d488e08> Tenancy, auth, migrations and compliance are where models fail and where failure is catastrophic. Screens, forms and workflows are where they excel and where failure is cosmetic. Substrat draws the line between them and enforces it — then does four more things most “AI-friendly” claims skip. </p><div class="grid-2" data-v-9d488e08><!--[-->`);
      ssrRenderList(forAgents, ([title, desc, href]) => {
        _push(`<a class="cannot op"${ssrRenderAttr("href", href)} data-v-9d488e08><span class="check" data-v-9d488e08>✓</span><div data-v-9d488e08><div class="cannot-title" data-v-9d488e08>${ssrInterpolate(title)}</div><div class="muted sm" data-v-9d488e08>${ssrInterpolate(desc)}</div></div></a>`);
      });
      _push(`<!--]--></div></div></section><section class="wrap section" data-v-9d488e08><div class="kicker" data-v-9d488e08>Reference verticals</div><h2 data-v-9d488e08>The same kernel, three businesses.</h2><div class="grid-3" data-v-9d488e08><!--[-->`);
      ssrRenderList(demos, ([name, kind, layer, desc, href]) => {
        _push(`<a class="demo-card"${ssrRenderAttr("href", href)} data-v-9d488e08><div class="demo-head" data-v-9d488e08><span class="${ssrRenderClass([`layer-${layer}`, "swatch"])}" data-v-9d488e08></span><span class="demo-name" data-v-9d488e08>${ssrInterpolate(name)}</span><span class="demo-kind" data-v-9d488e08>${ssrInterpolate(kind)}</span></div><p class="muted sm" data-v-9d488e08>${ssrInterpolate(desc)}</p></a>`);
      });
      _push(`<!--]--></div></section><section class="bleed band" data-v-9d488e08><div class="wrap section" data-v-9d488e08><div class="kicker" data-v-9d488e08>Current status</div><h2 data-v-9d488e08>What exists today</h2><div class="pkg-table" data-v-9d488e08><!--[-->`);
      ssrRenderList(pkgs, ([pkg, desc, status]) => {
        _push(`<div class="pkg-row" data-v-9d488e08><code class="pkg-name" data-v-9d488e08>${ssrInterpolate(pkg)}</code><span class="muted sm pkg-desc" data-v-9d488e08>${ssrInterpolate(desc)}</span><span class="${ssrRenderClass([status === "Working" ? "badge-success" : "badge-neutral", "badge"])}" data-v-9d488e08>${ssrInterpolate(status.toLowerCase())}</span></div>`);
      });
      _push(`<!--]--></div></div></section><section class="wrap section" data-v-9d488e08><div class="kicker" data-v-9d488e08>The honest half</div><h2 data-v-9d488e08>Where Substrat is the wrong answer.</h2><p class="muted lede-narrow" data-v-9d488e08> Single-tenant internal tools, one scale-heavy tenant, deep-domain products like payroll or core banking, and anything where the foundation isn’t your binding constraint — reach for something else, and the docs will say so rather than sell around it. </p><p class="muted lede-narrow" data-v-9d488e08> There is also a list of what we don’t have: one production connector, no certifications yet, no search, no localization, no report builder. Almost every gap is breadth; almost every strength is depth of guarantee. That’s the honest shape of a young platform, and it says plainly who shouldn’t buy yet. </p><div class="cta-row" data-v-9d488e08><a class="btn btn-secondary" href="/guide/what-substrat-lacks" data-v-9d488e08>What Substrat doesn’t have (yet)</a><a class="btn btn-secondary" href="/guide/comparisons" data-v-9d488e08>How Substrat compares</a><a class="btn btn-secondary" href="/guide/faq" data-v-9d488e08>FAQ</a></div></section><section class="bleed cta" data-v-9d488e08><div class="wrap cta-inner" data-v-9d488e08><div class="cta-copy" data-v-9d488e08><div class="cta-bars" data-v-9d488e08><span class="cta-bar layer-vertical" data-v-9d488e08></span><span class="cta-bar layer-engine" data-v-9d488e08></span><span class="cta-bar layer-kernel" data-v-9d488e08></span></div><div class="cta-title" data-v-9d488e08>Build the vertical.<br data-v-9d488e08>The substrate holds.</div></div><div class="cta-actions" data-v-9d488e08><a class="btn btn-primary" href="/guide/getting-started" data-v-9d488e08>Get started</a><a class="btn btn-ondark"${ssrRenderAttr("href", repo)} data-v-9d488e08>View on GitHub</a></div></div></section></div>`);
    };
  }
});
const _sfc_setup$b = _sfc_main$b.setup;
_sfc_main$b.setup = (props, ctx) => {
  const ssrContext = useSSRContext();
  (ssrContext.modules || (ssrContext.modules = /* @__PURE__ */ new Set())).add(".vitepress/theme/components/Marketing.vue");
  return _sfc_setup$b ? _sfc_setup$b(props, ctx) : void 0;
};
const Marketing = /* @__PURE__ */ _export_sfc(_sfc_main$b, [["__scopeId", "data-v-9d488e08"]]);
const verticals = {
  name: "Verticals",
  role: "Everything a user touches — the businesses themselves.",
  owner: "own vocabulary · screens · pricing · roles",
  chips: [
    ["Callout", "field service"],
    ["RallyPoint", "padel club"],
    ["Handlebar", "bike workshop"],
    ["Kallkälla", "coffee shop"],
    ["Meridian", "HR"],
    ["Manyfold", "headless CMS"]
  ]
};
const engines = {
  name: "Engines",
  role: "Headless domain machinery that owns invariants. Star topology — they talk to the kernel, never to each other.",
  owner: "own invariants · versioned · never forked",
  chips: [
    ["workorder", "one state machine · append-only time + material"],
    ["booking", "resource × interval × capacity · one allocation, no locks"],
    ["invoicing", "consumes billable events · immutable once exported"],
    ["protocol", "checklists + signed docs · freeze → immutable, hashed"],
    ["invites", "hashed identifier · accept-required · non-enumerable"]
  ]
};
const adapters = {
  name: "Adapters",
  role: "Scope hosts — the interchangeable ground the kernel is seated on.",
  owner: "swappable · escrowable · self-hostable",
  chips: [
    ["adapter-sqlite", "dev · CI · self-host / escrow"],
    ["adapter-cloudflare", "production · Durable-Object per scope"],
    ["adapter-email", "notification transport · CF Email + mock"]
  ]
};
const connectors = {
  name: "Connectors",
  role: "The outside world, at the edges. React to events on the spine — host code, never module code.",
  owner: "no fetch inside a module — ever",
  chips: [
    ["Scrive eSign", "signatures-requested → BankID signing → recorded back"],
    ["…more", "one port per capability"]
  ]
};
const kernel = {
  name: "Kernel",
  role: "The substrate. Everything true of <em>every</em> B2B SaaS — and nothing true of any one.",
  owner: "owns no domain entities",
  bits: [
    "Identity",
    "Nested tenancy",
    "Permissions + grants",
    "Events / audit spine",
    "Migrations",
    "GDPR machinery",
    "Notifications",
    "Jobs",
    "Billing entitlements",
    "Module system",
    "Attachment contracts",
    "App shell"
  ],
  ctxLabel: "Every operation runs inside",
  ctx: ["ctx.sql", "ctx.check", "ctx.emit", "ctx.link"],
  note: "No customer table, no work-order table. It offers attachment contracts that bind to opaque (entityType, entityId) refs the vertical defines."
};
const theLine = {
  label: "the line",
  above: "AI velocity — mistakes are cosmetic (a wrong screen)",
  below: "humans + runtime guarantees — mistakes are catastrophic (a tenant leak)"
};
const seams = {
  verticalToEngine: "composes engines in-scope, same transaction",
  engineToKernel: "<b>&darr;</b> ctx (sql · check · emit · link) &nbsp;·&nbsp; events + audit <b>&uarr;</b>",
  kernelToAdapter: "same kernel semantics on any ground — one contract-test suite gates them all"
};
const lawsHead = "The four rules that hold it together";
const laws = [
  ["Kernel owns no domain entities.", "It provides the spine; verticals define what the entities mean."],
  ["Star topology.", "Engines cooperate through fat events and opaque refs — never by importing each other. N contracts, not N²."],
  ["Enforced at runtime.", "Guarantees are defaults of the substrate, not config a builder — human or AI — can get wrong."],
  ["No forking.", "If a vertical ever needs to fork an engine, the engine drew its line wrong."]
];
const _sfc_main$a = /* @__PURE__ */ defineComponent({
  __name: "LayerStack",
  __ssrInlineRender: true,
  setup(__props) {
    return (_ctx, _push, _parent, _attrs) => {
      _push(`<div${ssrRenderAttrs(mergeProps({ class: "layerstack" }, _attrs))} data-v-dbb3f63b><section class="layer layer--vertical" data-v-dbb3f63b><div class="rail" data-v-dbb3f63b><p class="lname" data-v-dbb3f63b>${ssrInterpolate(unref(verticals).name)}</p><p class="lrole" data-v-dbb3f63b>${unref(verticals).role ?? ""}</p><p class="lowner" data-v-dbb3f63b>${ssrInterpolate(unref(verticals).owner)}</p></div><div class="chips" data-v-dbb3f63b><!--[-->`);
      ssrRenderList(unref(verticals).chips, ([name, sub]) => {
        _push(`<span class="chip" data-v-dbb3f63b><b data-v-dbb3f63b>${ssrInterpolate(name)}</b><em data-v-dbb3f63b>${ssrInterpolate(sub)}</em></span>`);
      });
      _push(`<!--]--></div></section><div class="theline" data-v-dbb3f63b><span data-v-dbb3f63b>${ssrInterpolate(unref(theLine).label)}</span></div><div class="sides" data-v-dbb3f63b><span class="up" data-v-dbb3f63b><b data-v-dbb3f63b>Above ↑</b> ${ssrInterpolate(unref(theLine).above)}</span><span class="down" data-v-dbb3f63b><b data-v-dbb3f63b>↓ Below</b> ${ssrInterpolate(unref(theLine).below)}</span></div><p class="seam" data-v-dbb3f63b>${ssrInterpolate(unref(seams).verticalToEngine)}</p><section class="layer layer--engine" data-v-dbb3f63b><div class="rail" data-v-dbb3f63b><p class="lname" data-v-dbb3f63b>${ssrInterpolate(unref(engines).name)}</p><p class="lrole" data-v-dbb3f63b>${unref(engines).role ?? ""}</p><p class="lowner" data-v-dbb3f63b>${ssrInterpolate(unref(engines).owner)}</p></div><div class="chips" data-v-dbb3f63b><!--[-->`);
      ssrRenderList(unref(engines).chips, ([name, sub]) => {
        _push(`<span class="chip" data-v-dbb3f63b><b data-v-dbb3f63b>${ssrInterpolate(name)}</b><em data-v-dbb3f63b>${ssrInterpolate(sub)}</em></span>`);
      });
      _push(`<!--]--></div></section><p class="seam" data-v-dbb3f63b>${unref(seams).engineToKernel ?? ""}</p><section class="layer layer--kernel bedrock" data-v-dbb3f63b><div class="rail" data-v-dbb3f63b><p class="lname" data-v-dbb3f63b>${ssrInterpolate(unref(kernel).name)}</p><p class="lrole" data-v-dbb3f63b>${unref(kernel).role ?? ""}</p><p class="lowner" data-v-dbb3f63b>${ssrInterpolate(unref(kernel).owner)}</p></div><div data-v-dbb3f63b><div class="chips kbits" data-v-dbb3f63b><!--[-->`);
      ssrRenderList(unref(kernel).bits, (b) => {
        _push(`<span class="kchip" data-v-dbb3f63b>${ssrInterpolate(b)}</span>`);
      });
      _push(`<!--]--></div><div class="ctx" data-v-dbb3f63b><span class="ctxlabel" data-v-dbb3f63b>${ssrInterpolate(unref(kernel).ctxLabel)}</span><!--[-->`);
      ssrRenderList(unref(kernel).ctx, (c) => {
        _push(`<code data-v-dbb3f63b>${ssrInterpolate(c)}</code>`);
      });
      _push(`<!--]--></div><p class="knote" data-v-dbb3f63b>${ssrInterpolate(unref(kernel).note)}</p></div></section><p class="seam" data-v-dbb3f63b>${ssrInterpolate(unref(seams).kernelToAdapter)}</p><section class="layer layer--adapter" data-v-dbb3f63b><div class="rail" data-v-dbb3f63b><p class="lname" data-v-dbb3f63b>${ssrInterpolate(unref(adapters).name)}</p><p class="lrole" data-v-dbb3f63b>${unref(adapters).role ?? ""}</p><p class="lowner" data-v-dbb3f63b>${ssrInterpolate(unref(adapters).owner)}</p></div><div class="chips" data-v-dbb3f63b><!--[-->`);
      ssrRenderList(unref(adapters).chips, ([name, sub]) => {
        _push(`<span class="chip" data-v-dbb3f63b><b data-v-dbb3f63b>${ssrInterpolate(name)}</b><em data-v-dbb3f63b>${ssrInterpolate(sub)}</em></span>`);
      });
      _push(`<!--]--></div></section><section class="layer layer--connector edge" data-v-dbb3f63b><div class="rail" data-v-dbb3f63b><p class="lname" data-v-dbb3f63b>${ssrInterpolate(unref(connectors).name)}</p><p class="lrole" data-v-dbb3f63b>${unref(connectors).role ?? ""}</p><p class="lowner" data-v-dbb3f63b>${ssrInterpolate(unref(connectors).owner)}</p></div><div class="chips" data-v-dbb3f63b><!--[-->`);
      ssrRenderList(unref(connectors).chips, ([name, sub]) => {
        _push(`<span class="chip" data-v-dbb3f63b><b data-v-dbb3f63b>${ssrInterpolate(name)}</b><em data-v-dbb3f63b>${ssrInterpolate(sub)}</em></span>`);
      });
      _push(`<!--]--></div></section><div class="laws" data-v-dbb3f63b><p class="lawshead" data-v-dbb3f63b>${ssrInterpolate(unref(lawsHead))}</p><ol data-v-dbb3f63b><!--[-->`);
      ssrRenderList(unref(laws), ([head, body], i) => {
        _push(`<li data-v-dbb3f63b><span class="n" data-v-dbb3f63b>${ssrInterpolate(i + 1)}</span><span data-v-dbb3f63b><b data-v-dbb3f63b>${ssrInterpolate(head)}</b> ${ssrInterpolate(body)}</span></li>`);
      });
      _push(`<!--]--></ol></div></div>`);
    };
  }
});
const _sfc_setup$a = _sfc_main$a.setup;
_sfc_main$a.setup = (props, ctx) => {
  const ssrContext = useSSRContext();
  (ssrContext.modules || (ssrContext.modules = /* @__PURE__ */ new Set())).add(".vitepress/theme/components/LayerStack.vue");
  return _sfc_setup$a ? _sfc_setup$a(props, ctx) : void 0;
};
const LayerStack = /* @__PURE__ */ _export_sfc(_sfc_main$a, [["__scopeId", "data-v-dbb3f63b"]]);
const headings = {
  flow: "How a request travels",
  dbs: "The three databases",
  provisioning: "How the databases get created"
};
const steps = [
  {
    n: 1,
    kind: "edge",
    title: "Browser hits a hostname",
    body: "A tenant, a vertical, and a surface — all encoded in the name.",
    mono: "acme.callout.substrat.run"
  },
  {
    n: 2,
    kind: "router",
    title: "The router resolves the door",
    body: "One kernel-owned worker in front of every vertical. Its only binding is the control plane — it reads the directory to turn hostname → (tenant, scope, vertical, surface). It finds the door; it cannot open a scope even by mistake.",
    touches: "cp"
  },
  {
    n: 3,
    kind: "compute",
    title: "Header handshake, then dispatch",
    body: "Every client x-substrat-* header is stripped; the router asserts the resolved node plus a shared secret, then dispatches to the vertical worker. The vertical has no public route — the router is the only way in."
  },
  {
    n: 4,
    kind: "compute",
    title: "Vertical worker resolves who you are",
    body: "The vertical worker holds no state between requests. It resolves your session to a principal in the tenant’s own identity database.",
    touches: "id"
  },
  {
    n: 5,
    kind: "compute",
    title: "Open the scope, run the operation",
    body: "Gate the scope’s lifecycle & tenancy, then invoke() runs the operation inside the scope’s own SQLite, in one transaction — permission check first, mutation emits an event, the outbox drains to consumers and connectors. Roll back on any throw.",
    touches: "sc"
  },
  {
    n: 6,
    kind: "edge",
    title: "Response travels back up",
    body: "Back through the router, the one place that knows the tenant — so it meters the request there, one datapoint per call."
  }
];
const dbs = [
  {
    key: "cp",
    card: "Directory",
    name: "Control-plane DB",
    count: "one per environment",
    items: ["Tenant registry & scope lifecycle", "Roles, tenant grants, entitlements", "Hostnames, verticals & versions", "Connections (ciphertext only)", "The admin audit log"],
    tag: "Knows which door — never what’s behind it. A single singleton DO."
  },
  {
    key: "id",
    card: "Application / auth",
    name: "Identity DB",
    count: "one per tenant",
    items: ["Users, sessions, credentials", "Its own auth engine, own SQLite", "The login → principal map", "The owner seat, set at provision"],
    tag: "Separate DO, separate storage — one tenant’s users can’t leak to another."
  },
  {
    key: "sc",
    card: "Business data",
    name: "Scope DB",
    count: "one per scope",
    items: ["The vertical’s entities & kernel spine", "Events, outbox, entity links", "Applied migrations", "Scope-level grants & permissions"],
    tag: "Where ctx.sql runs — one transaction per operation."
  }
];
const touchLabel = {
  cp: "reads → Control-plane DB",
  id: "reads → Identity DB (this tenant)",
  sc: "reads + writes → Scope DB (this scope)"
};
const kindLabel = {
  edge: "edge",
  router: "kernel worker · 1 per env",
  compute: "compute"
};
const provKey = "The trick: <b>a Durable Object’s database springs into existence the first time you address it by id.</b> There is no <code>CREATE DATABASE</code> and no migration server — provisioning is just addressing a new DO and letting it build itself.";
const prov = [
  ["Write the directory row.", "The coordinator records the new scope in the control plane — the door now exists, gated by the tenant."],
  ["Address the Scope DO.", "The moment it’s named, its SQLite is born. A lazy migration builds the kernel spine and runs the vertical’s own module migrations in order — a PITR bookmark taken before each pass."],
  ["Project permissions in.", "The tenant’s current roles and grants are copied into the fresh scope so it can decide access from its own storage — then the migration frontier is recorded back to the directory."],
  ["Identity DB, likewise.", "The tenant’s Identity DO is created on first address — tables on construction, the owner seat set at provision, waiting to be claimed by the first login."]
];
const isolation = {
  head: "Why the shared control plane isn’t a shared blast radius",
  paragraphs: [
    "A normal vertical runs <b>“CP-less” on the hot path</b>: it decides permissions from the scope’s <em>own</em> storage and trusts the node the router asserted — the shared control plane is <b>off the request path entirely</b>. It still owns provisioning and the audit spine, but a request serving one tenant never touches another tenant’s data, or the shared directory, to answer.",
    "The result: the same kernel guarantees, a per-tenant database, and a shared control plane whose failure can’t read or corrupt a running scope. <b>Isolation is the default, not a configuration you can forget.</b>"
  ]
};
const diagram = {
  aria: "A request travels from the browser to the router, which reads the control-plane Durable Object to resolve the hostname, then dispatches to the vertical worker. The worker reads the tenant’s Identity Durable Object and opens the Scope Durable Object, where the operation runs. The response returns along a dashed path back through the router.",
  browser: { title: "Browser", mono: "acme.callout.substrat.run" },
  toRouter: "the request",
  router: {
    tag: "cloudflare edge",
    title: "Router",
    sub: ["One per environment.", "Finds the door; cannot open it."],
    chip: "kernel only"
  },
  toControlPlane: "hostname → node",
  controlPlane: {
    tag: "durable object",
    title: "Control-plane DO",
    sub: ["The directory.", "One per environment."],
    chip: "kernel only"
  },
  toWorker: "dispatch · asserts the node + ROUTER_SECRET",
  worker: {
    tag: "worker · one per version",
    title: "The vertical worker",
    sub: "Your pushed bundle. No public route, no state between requests."
  },
  toIdentity: "session → principal",
  identity: {
    tag: "durable object",
    title: "Identity DO",
    sub: ["One per tenant.", "Users, sessions, the owner seat."],
    chip: "kernel only"
  },
  toScope: "getScope() · invoke()",
  scope: {
    tag: "durable object",
    title: "Scope DO",
    sub: "Its own SQLite. One operation at a time."
  },
  ret: "response · metered at the router"
};
const residency = {
  intro: "One bundle, two execution environments. The worker is trusted with addressing and never with data; the scope holds the data and cannot reach the network.",
  worker: [
    { dot: "k", title: "Kernel host", detail: "getScope() · permission gate · metering" },
    { dot: "v", title: "Vertical HTTP", detail: "routes, error envelope, session → principal" },
    { dot: "v", title: "Connector code", detail: "the only place fetch() is allowed to exist" }
  ],
  scope: [
    { dot: "v", text: "Vertical operations — ctx.check(), then ctx.sql" },
    { dot: "e", text: "Engine functions — the same transaction" },
    { dot: "k", text: "Kernel spine — events, outbox, links, migrations" }
  ]
};
const _sfc_main$9 = /* @__PURE__ */ defineComponent({
  __name: "RuntimeTopology",
  __ssrInlineRender: true,
  setup(__props) {
    return (_ctx, _push, _parent, _attrs) => {
      _push(`<div${ssrRenderAttrs(mergeProps({ class: "topo" }, _attrs))} data-v-7c7e2298><p class="subhead" data-v-7c7e2298>${ssrInterpolate(unref(headings).flow)}</p><figure class="fig" data-v-7c7e2298><svg viewBox="0 0 700 812" role="img"${ssrRenderAttr("aria-label", unref(diagram).aria)} data-v-7c7e2298><defs data-v-7c7e2298><marker id="rt-arw" viewBox="0 0 9 7" refX="8" refY="3.5" markerWidth="7" markerHeight="6" orient="auto" data-v-7c7e2298><polygon class="mk" points="0 0, 9 3.5, 0 7" data-v-7c7e2298></polygon></marker></defs><path class="flowline back" d="M40 520 H16 V64 H30" marker-end="url(#rt-arw)" data-v-7c7e2298></path><text class="t-rot" x="32" y="300" text-anchor="middle" transform="rotate(-90 32 300)" data-v-7c7e2298>${ssrInterpolate(unref(diagram).ret)}</text><rect class="fbox" x="40" y="36" width="250" height="56" rx="10" data-v-7c7e2298></rect><text class="t-title" x="58" y="62" data-v-7c7e2298>${ssrInterpolate(unref(diagram).browser.title)}</text><text class="t-mono" x="58" y="81" data-v-7c7e2298>${ssrInterpolate(unref(diagram).browser.mono)}</text><path class="flowline" d="M165 98 V142" marker-end="url(#rt-arw)" data-v-7c7e2298></path><text class="t-arw" x="177" y="124" data-v-7c7e2298>${ssrInterpolate(unref(diagram).toRouter)}</text><rect class="fbox" x="40" y="148" width="250" height="128" rx="10" data-v-7c7e2298></rect><text class="t-tag" x="58" y="170" data-v-7c7e2298>${ssrInterpolate(unref(diagram).router.tag)}</text><text class="t-title" x="58" y="192" data-v-7c7e2298>${ssrInterpolate(unref(diagram).router.title)}</text><!--[-->`);
      ssrRenderList(unref(diagram).router.sub, (l, i) => {
        _push(`<text class="t-sub" x="58"${ssrRenderAttr("y", 212 + i * 17)} data-v-7c7e2298>${ssrInterpolate(l)}</text>`);
      });
      _push(`<!--]--><rect class="fchip fchip--k" x="58" y="240" width="98" height="22" rx="6" data-v-7c7e2298></rect><circle class="ldot ldot--k" cx="70" cy="251" r="3.5" data-v-7c7e2298></circle><text class="t-chip t-chip--k" x="80" y="255" data-v-7c7e2298>${ssrInterpolate(unref(diagram).router.chip)}</text><path class="flowline" d="M296 212 H400" marker-end="url(#rt-arw)" data-v-7c7e2298></path><text class="t-arw" x="348" y="200" text-anchor="middle" data-v-7c7e2298>${ssrInterpolate(unref(diagram).toControlPlane)}</text><rect class="fbox" x="410" y="148" width="250" height="128" rx="10" data-v-7c7e2298></rect><text class="t-tag" x="428" y="170" data-v-7c7e2298>${ssrInterpolate(unref(diagram).controlPlane.tag)}</text><text class="t-title" x="428" y="192" data-v-7c7e2298>${ssrInterpolate(unref(diagram).controlPlane.title)}</text><!--[-->`);
      ssrRenderList(unref(diagram).controlPlane.sub, (l, i) => {
        _push(`<text class="t-sub" x="428"${ssrRenderAttr("y", 212 + i * 17)} data-v-7c7e2298>${ssrInterpolate(l)}</text>`);
      });
      _push(`<!--]--><rect class="fchip fchip--k" x="428" y="240" width="98" height="22" rx="6" data-v-7c7e2298></rect><circle class="ldot ldot--k" cx="440" cy="251" r="3.5" data-v-7c7e2298></circle><text class="t-chip t-chip--k" x="450" y="255" data-v-7c7e2298>${ssrInterpolate(unref(diagram).controlPlane.chip)}</text><path class="flowline" d="M165 282 V326" marker-end="url(#rt-arw)" data-v-7c7e2298></path><text class="t-arw" x="177" y="308" data-v-7c7e2298>${ssrInterpolate(unref(diagram).toWorker)}</text><rect class="fbox" x="40" y="332" width="620" height="220" rx="10" data-v-7c7e2298></rect><text class="t-tag" x="58" y="354" data-v-7c7e2298>${ssrInterpolate(unref(diagram).worker.tag)}</text><text class="t-title" x="58" y="376" data-v-7c7e2298>${ssrInterpolate(unref(diagram).worker.title)}</text><text class="t-sub" x="58" y="396" data-v-7c7e2298>${ssrInterpolate(unref(diagram).worker.sub)}</text><!--[-->`);
      ssrRenderList(unref(residency).worker, (pane, i) => {
        _push(`<g data-v-7c7e2298><rect class="fpane" x="58"${ssrRenderAttr("y", 406 + i * 44)} width="584" height="40" rx="8" data-v-7c7e2298></rect><circle class="${ssrRenderClass(["ldot--" + pane.dot, "ldot"])}" cx="74"${ssrRenderAttr("cy", 420 + i * 44)} r="4.5" data-v-7c7e2298></circle><text class="t-mid" x="88"${ssrRenderAttr("y", 424 + i * 44)} data-v-7c7e2298>${ssrInterpolate(pane.title)}</text><text class="t-sub" x="88"${ssrRenderAttr("y", 440 + i * 44)} data-v-7c7e2298>${ssrInterpolate(pane.detail)}</text></g>`);
      });
      _push(`<!--]--><path class="flowline" d="M160 558 V600" marker-end="url(#rt-arw)" data-v-7c7e2298></path><text class="t-arw" x="172" y="580" data-v-7c7e2298>${ssrInterpolate(unref(diagram).toIdentity)}</text><path class="flowline" d="M485 558 V600" marker-end="url(#rt-arw)" data-v-7c7e2298></path><text class="t-arw" x="473" y="580" text-anchor="end" data-v-7c7e2298>${ssrInterpolate(unref(diagram).toScope)}</text><rect class="fbox" x="40" y="606" width="240" height="128" rx="10" data-v-7c7e2298></rect><text class="t-tag" x="58" y="628" data-v-7c7e2298>${ssrInterpolate(unref(diagram).identity.tag)}</text><text class="t-title" x="58" y="650" data-v-7c7e2298>${ssrInterpolate(unref(diagram).identity.title)}</text><!--[-->`);
      ssrRenderList(unref(diagram).identity.sub, (l, i) => {
        _push(`<text class="t-sub" x="58"${ssrRenderAttr("y", 670 + i * 17)} data-v-7c7e2298>${ssrInterpolate(l)}</text>`);
      });
      _push(`<!--]--><rect class="fchip fchip--k" x="58" y="698" width="98" height="22" rx="6" data-v-7c7e2298></rect><circle class="ldot ldot--k" cx="70" cy="709" r="3.5" data-v-7c7e2298></circle><text class="t-chip t-chip--k" x="80" y="713" data-v-7c7e2298>${ssrInterpolate(unref(diagram).identity.chip)}</text><rect class="fbox" x="310" y="606" width="350" height="176" rx="10" data-v-7c7e2298></rect><text class="t-tag" x="328" y="628" data-v-7c7e2298>${ssrInterpolate(unref(diagram).scope.tag)}</text><text class="t-title" x="328" y="650" data-v-7c7e2298>${ssrInterpolate(unref(diagram).scope.title)}</text><text class="t-sub" x="328" y="670" data-v-7c7e2298>${ssrInterpolate(unref(diagram).scope.sub)}</text><!--[-->`);
      ssrRenderList(unref(residency).scope, (row, i) => {
        _push(`<g data-v-7c7e2298><rect class="${ssrRenderClass(["fchip--" + row.dot, "fchip"])}" x="328"${ssrRenderAttr("y", 680 + i * 28)} width="314" height="24" rx="6" data-v-7c7e2298></rect><circle class="${ssrRenderClass(["ldot--" + row.dot, "ldot"])}" cx="344"${ssrRenderAttr("cy", 692 + i * 28)} r="4" data-v-7c7e2298></circle><text class="t-sub" x="358"${ssrRenderAttr("y", 696 + i * 28)} data-v-7c7e2298>${ssrInterpolate(row.text)}</text></g>`);
      });
      _push(`<!--]--></svg><figcaption data-v-7c7e2298>${ssrInterpolate(unref(residency).intro)}</figcaption></figure><div class="flow" data-v-7c7e2298><!--[-->`);
      ssrRenderList(unref(steps), (s) => {
        _push(`<div class="${ssrRenderClass([{ last: s.n === unref(steps).length }, "step"])}" data-v-7c7e2298><div class="gutter" data-v-7c7e2298><span class="badge" data-v-7c7e2298>${ssrInterpolate(s.n)}</span><span class="spine" data-v-7c7e2298></span></div><div class="body" data-v-7c7e2298><p class="stitle" data-v-7c7e2298>${ssrInterpolate(s.title)} <span class="${ssrRenderClass(["kind--" + s.kind, "kind"])}" data-v-7c7e2298>${ssrInterpolate(unref(kindLabel)[s.kind])}</span></p><p class="sbody" data-v-7c7e2298>${ssrInterpolate(s.body)}</p>`);
        if (s.mono) {
          _push(`<code class="mono" data-v-7c7e2298>${ssrInterpolate(s.mono)}</code>`);
        } else {
          _push(`<!---->`);
        }
        if (s.touches) {
          _push(`<span class="touch" data-v-7c7e2298><span class="${ssrRenderClass(["dot--" + s.touches, "dot"])}" data-v-7c7e2298></span>${ssrInterpolate(unref(touchLabel)[s.touches])}</span>`);
        } else {
          _push(`<!---->`);
        }
        _push(`</div></div>`);
      });
      _push(`<!--]--></div><p class="subhead" data-v-7c7e2298>${ssrInterpolate(unref(headings).dbs)}</p><div class="dbs" data-v-7c7e2298><!--[-->`);
      ssrRenderList(unref(dbs), (d) => {
        _push(`<div class="${ssrRenderClass(["db--" + d.key, "db"])}" data-v-7c7e2298><svg class="cyl" viewBox="0 0 30 34" fill="none" stroke="currentColor" stroke-width="1.6" aria-hidden="true" data-v-7c7e2298><ellipse cx="15" cy="6" rx="12" ry="4.5" data-v-7c7e2298></ellipse><path d="M3 6v22c0 2.5 5.4 4.5 12 4.5s12-2 12-4.5V6" data-v-7c7e2298></path><path d="M3 17c0 2.5 5.4 4.5 12 4.5s12-2 12-4.5" opacity=".55" data-v-7c7e2298></path></svg><p class="dbcard" data-v-7c7e2298>${ssrInterpolate(d.card)}</p><p class="dbname" data-v-7c7e2298>${ssrInterpolate(d.name)}</p><span class="count" data-v-7c7e2298>${ssrInterpolate(d.count)}</span><ul data-v-7c7e2298><!--[-->`);
        ssrRenderList(d.items, (it) => {
          _push(`<li data-v-7c7e2298>${ssrInterpolate(it)}</li>`);
        });
        _push(`<!--]--></ul><p class="dbtag" data-v-7c7e2298>${ssrInterpolate(d.tag)}</p></div>`);
      });
      _push(`<!--]--></div><p class="subhead" data-v-7c7e2298>${ssrInterpolate(unref(headings).provisioning)}</p><div class="prov" data-v-7c7e2298><p class="key" data-v-7c7e2298>${unref(provKey) ?? ""}</p><div class="psteps" data-v-7c7e2298><!--[-->`);
      ssrRenderList(unref(prov), ([head, body], i) => {
        _push(`<div class="pstep" data-v-7c7e2298><span class="pn" data-v-7c7e2298>${ssrInterpolate(i + 1)}</span><p data-v-7c7e2298><b data-v-7c7e2298>${ssrInterpolate(head)}</b> ${ssrInterpolate(body)}</p></div>`);
      });
      _push(`<!--]--></div></div><div class="iso" data-v-7c7e2298><p class="isohead" data-v-7c7e2298>${ssrInterpolate(unref(isolation).head)}</p><!--[-->`);
      ssrRenderList(unref(isolation).paragraphs, (para, i) => {
        _push(`<p data-v-7c7e2298>${para ?? ""}</p>`);
      });
      _push(`<!--]--></div></div>`);
    };
  }
});
const _sfc_setup$9 = _sfc_main$9.setup;
_sfc_main$9.setup = (props, ctx) => {
  const ssrContext = useSSRContext();
  (ssrContext.modules || (ssrContext.modules = /* @__PURE__ */ new Set())).add(".vitepress/theme/components/RuntimeTopology.vue");
  return _sfc_setup$9 ? _sfc_setup$9(props, ctx) : void 0;
};
const RuntimeTopology = /* @__PURE__ */ _export_sfc(_sfc_main$9, [["__scopeId", "data-v-7c7e2298"]]);
const aria$5 = "Permissions are declared in TypeScript. From there one branch renders PERMISSIONS.md for human review and CI drift-checking; the other rides the deploy manifest through admission, provisioning, and finally ctx.check at runtime.";
const source = {
  tag: "authored",
  title: "Declared in TypeScript",
  sub: ["module manifests → keys + descriptions", "roles → templates · entity grants → shapes"]
};
const toReview = "renders";
const review = {
  tag: "checkpoint · a human reads this",
  title: "pnpm lint:permissions",
  sub: ["emits PERMISSIONS.md, the review artifact", "CI --check fails the build on drift"]
};
const stages = [
  {
    edge: "substrat push",
    tag: "ships",
    title: "The deploy manifest",
    sub: ["the surface rides along as a registry", "content-hashed → digests.permission"]
  },
  {
    edge: "promote",
    tag: "gate",
    title: "Admission",
    sub: ["a real diff between two versions", "a widened surface is visible, not implicit"]
  },
  {
    edge: "at write time",
    tag: "per tenant",
    title: "Provisioning",
    sub: ["role templates projected into each", "tenant's own _substrat_roles"]
  },
  {
    edge: "every operation",
    tag: "runtime",
    title: "ctx.check",
    sub: ["reads scope-local tables only", "absent or empty projection = deny"]
  }
];
const caption$6 = "The branch off the top ends in a person: PERMISSIONS.md exists to be read in a diff, and CI going red is what makes the reading unskippable — it is not itself the approval.";
const BOX_W = 330;
const BOX_H$1 = 88;
const PITCH = 128;
const X = 30;
const _sfc_main$8 = /* @__PURE__ */ defineComponent({
  __name: "PermissionPipeline",
  __ssrInlineRender: true,
  setup(__props) {
    const top = (i) => 30 + i * PITCH;
    return (_ctx, _push, _parent, _attrs) => {
      _push(`<figure${ssrRenderAttrs(mergeProps({ class: "fig" }, _attrs))} data-v-1a1d47be><svg${ssrRenderAttr("viewBox", `0 0 700 ${30 + unref(stages).length * PITCH + BOX_H$1 + 20}`)} role="img"${ssrRenderAttr("aria-label", unref(aria$5))} data-v-1a1d47be><defs data-v-1a1d47be><marker id="pp-arw" viewBox="0 0 9 7" refX="8" refY="3.5" markerWidth="7" markerHeight="6" orient="auto" data-v-1a1d47be><polygon class="mk" points="0 0, 9 3.5, 0 7" data-v-1a1d47be></polygon></marker></defs><rect class="pbox pbox--source"${ssrRenderAttr("x", X)}${ssrRenderAttr("y", top(0))}${ssrRenderAttr("width", BOX_W)}${ssrRenderAttr("height", BOX_H$1)} rx="10" data-v-1a1d47be></rect><text class="t-tag"${ssrRenderAttr("x", X + 18)}${ssrRenderAttr("y", top(0) + 22)} data-v-1a1d47be>${ssrInterpolate(unref(source).tag)}</text><text class="t-title"${ssrRenderAttr("x", X + 18)}${ssrRenderAttr("y", top(0) + 44)} data-v-1a1d47be>${ssrInterpolate(unref(source).title)}</text><!--[-->`);
      ssrRenderList(unref(source).sub, (l, j) => {
        _push(`<text class="t-sub"${ssrRenderAttr("x", X + 18)}${ssrRenderAttr("y", top(0) + 62 + j * 16)} data-v-1a1d47be>${ssrInterpolate(l)}</text>`);
      });
      _push(`<!--]--><path class="flowline dashed"${ssrRenderAttr("d", `M${X + BOX_W} ${top(0) + BOX_H$1 / 2} H${X + BOX_W + 34}`)} marker-end="url(#pp-arw)" data-v-1a1d47be></path><text class="t-edge"${ssrRenderAttr("x", X + BOX_W + 17)}${ssrRenderAttr("y", top(0) + BOX_H$1 / 2 - 9)} text-anchor="middle" data-v-1a1d47be>${ssrInterpolate(unref(toReview))}</text><rect class="pbox pbox--review"${ssrRenderAttr("x", X + BOX_W + 42)}${ssrRenderAttr("y", top(0))} width="268"${ssrRenderAttr("height", BOX_H$1)} rx="10" data-v-1a1d47be></rect><text class="t-tag t-tag--review"${ssrRenderAttr("x", X + BOX_W + 60)}${ssrRenderAttr("y", top(0) + 22)} data-v-1a1d47be>${ssrInterpolate(unref(review).tag)}</text><text class="t-title"${ssrRenderAttr("x", X + BOX_W + 60)}${ssrRenderAttr("y", top(0) + 44)} data-v-1a1d47be>${ssrInterpolate(unref(review).title)}</text><!--[-->`);
      ssrRenderList(unref(review).sub, (l, j) => {
        _push(`<text class="t-sub"${ssrRenderAttr("x", X + BOX_W + 60)}${ssrRenderAttr("y", top(0) + 62 + j * 16)} data-v-1a1d47be>${ssrInterpolate(l)}</text>`);
      });
      _push(`<!--]--><!--[-->`);
      ssrRenderList(unref(stages), (s, i) => {
        _push(`<g data-v-1a1d47be><path class="flowline"${ssrRenderAttr("d", `M${X + 44} ${top(i) + BOX_H$1} V${top(i + 1) - 4}`)} marker-end="url(#pp-arw)" data-v-1a1d47be></path><text class="t-edge"${ssrRenderAttr("x", X + 56)}${ssrRenderAttr("y", top(i) + BOX_H$1 + 26)} data-v-1a1d47be>${ssrInterpolate(s.edge)}</text><rect class="${ssrRenderClass([{ "pbox--runtime": i === unref(stages).length - 1 }, "pbox"])}"${ssrRenderAttr("x", X)}${ssrRenderAttr("y", top(i + 1))}${ssrRenderAttr("width", BOX_W)}${ssrRenderAttr("height", BOX_H$1)} rx="10" data-v-1a1d47be></rect><text class="t-tag"${ssrRenderAttr("x", X + 18)}${ssrRenderAttr("y", top(i + 1) + 22)} data-v-1a1d47be>${ssrInterpolate(s.tag)}</text><text class="t-title"${ssrRenderAttr("x", X + 18)}${ssrRenderAttr("y", top(i + 1) + 44)} data-v-1a1d47be>${ssrInterpolate(s.title)}</text><!--[-->`);
        ssrRenderList(s.sub, (l, j) => {
          _push(`<text class="t-sub"${ssrRenderAttr("x", X + 18)}${ssrRenderAttr("y", top(i + 1) + 62 + j * 16)} data-v-1a1d47be>${ssrInterpolate(l)}</text>`);
        });
        _push(`<!--]--></g>`);
      });
      _push(`<!--]--></svg><figcaption data-v-1a1d47be>${ssrInterpolate(unref(caption$6))}</figcaption></figure>`);
    };
  }
});
const _sfc_setup$8 = _sfc_main$8.setup;
_sfc_main$8.setup = (props, ctx) => {
  const ssrContext = useSSRContext();
  (ssrContext.modules || (ssrContext.modules = /* @__PURE__ */ new Set())).add(".vitepress/theme/components/PermissionPipeline.vue");
  return _sfc_setup$8 ? _sfc_setup$8(props, ctx) : void 0;
};
const PermissionPipeline = /* @__PURE__ */ _export_sfc(_sfc_main$8, [["__scopeId", "data-v-1a1d47be"]]);
const aria$4 = "A hostname resolves to a scope, never to a version. The scope is bound to a version id, and that binding is the only mutable link. The version id resolves to an immutable deploymentRef. Prod, test and preview differ only in what moves the binding.";
const chain = [
  {
    tag: "stable",
    title: "Hostname",
    sub: "names a scope, never a version",
    git: "a checkout path",
    mutable: false
  },
  {
    tag: "the thing that is named",
    title: "Scope",
    sub: "one isolation domain, one database",
    git: "—",
    mutable: false
  },
  {
    tag: "immutable",
    title: "Version id → deploymentRef",
    sub: "a pushed build never changes",
    git: "a commit sha",
    mutable: false
  }
];
const edges = ["resolves to", "currently bound to"];
const binding = {
  title: "the binding",
  detail: "bindScopeVersion — mutable by design",
  git: "a branch ref"
};
const environments = [
  ["prod", "an explicit, acknowledged promote — cascades across a shared vertical’s tenants"],
  ["test", "every merge to main, one scope, ungated, driven from CI"],
  ["preview", "each push to the PR — its own scope, so it can never inherit prod’s binding"]
];
const caption$5 = "Nothing else names an environment. “prod” and “test” are the same shape — a stable scope and a stable hostname whose binding moves; only the trigger and how gated it is differ.";
const _sfc_main$7 = /* @__PURE__ */ defineComponent({
  __name: "InstanceResolution",
  __ssrInlineRender: true,
  setup(__props) {
    return (_ctx, _push, _parent, _attrs) => {
      _push(`<figure${ssrRenderAttrs(mergeProps({ class: "fig" }, _attrs))} data-v-9e17acc7><svg viewBox="0 0 700 470" role="img"${ssrRenderAttr("aria-label", unref(aria$4))} data-v-9e17acc7><defs data-v-9e17acc7><marker id="ir-arw" viewBox="0 0 9 7" refX="8" refY="3.5" markerWidth="7" markerHeight="6" orient="auto" data-v-9e17acc7><polygon class="mk" points="0 0, 9 3.5, 0 7" data-v-9e17acc7></polygon></marker></defs><!--[-->`);
      ssrRenderList(unref(chain), (c, i) => {
        _push(`<g data-v-9e17acc7><rect class="${ssrRenderClass([{ "ibox--immutable": c.tag === "immutable" }, "ibox"])}" x="30"${ssrRenderAttr("y", 30 + i * 118)} width="380" height="82" rx="10" data-v-9e17acc7></rect><text class="t-tag" x="48"${ssrRenderAttr("y", 52 + i * 118)} data-v-9e17acc7>${ssrInterpolate(c.tag)}</text><text class="t-title" x="48"${ssrRenderAttr("y", 74 + i * 118)} data-v-9e17acc7>${ssrInterpolate(c.title)}</text><text class="t-sub" x="48"${ssrRenderAttr("y", 94 + i * 118)} data-v-9e17acc7>${ssrInterpolate(c.sub)}</text><text class="t-git" x="392"${ssrRenderAttr("y", 52 + i * 118)} text-anchor="end" data-v-9e17acc7>${ssrInterpolate(c.git)}</text></g>`);
      });
      _push(`<!--]--><path class="flowline" d="M100 112 V144" marker-end="url(#ir-arw)" data-v-9e17acc7></path><text class="t-edge" x="112" y="132" data-v-9e17acc7>${ssrInterpolate(unref(edges)[0])}</text><path class="flowline moves" d="M100 230 V262" marker-end="url(#ir-arw)" data-v-9e17acc7></path><text class="t-edge t-edge--moves" x="112" y="250" data-v-9e17acc7>${ssrInterpolate(unref(edges)[1])}</text><rect class="mbox" x="230" y="212" width="290" height="52" rx="9" data-v-9e17acc7></rect><text class="t-mtitle" x="248" y="234" data-v-9e17acc7>${ssrInterpolate(unref(binding).title)} — ${ssrInterpolate(unref(binding).git)}</text><text class="t-sub" x="248" y="252" data-v-9e17acc7>${ssrInterpolate(unref(binding).detail)}</text><text class="t-tag" x="30" y="386" data-v-9e17acc7>what moves the binding</text><!--[-->`);
      ssrRenderList(unref(environments), (e, i) => {
        _push(`<g data-v-9e17acc7><text class="t-env" x="30"${ssrRenderAttr("y", 410 + i * 20)} data-v-9e17acc7>${ssrInterpolate(e[0])}</text><text class="t-sub" x="106"${ssrRenderAttr("y", 410 + i * 20)} data-v-9e17acc7>${ssrInterpolate(e[1])}</text></g>`);
      });
      _push(`<!--]--></svg><figcaption data-v-9e17acc7>${ssrInterpolate(unref(caption$5))}</figcaption></figure>`);
    };
  }
});
const _sfc_setup$7 = _sfc_main$7.setup;
_sfc_main$7.setup = (props, ctx) => {
  const ssrContext = useSSRContext();
  (ssrContext.modules || (ssrContext.modules = /* @__PURE__ */ new Set())).add(".vitepress/theme/components/InstanceResolution.vue");
  return _sfc_setup$7 ? _sfc_setup$7(props, ctx) : void 0;
};
const InstanceResolution = /* @__PURE__ */ _export_sfc(_sfc_main$7, [["__scopeId", "data-v-9e17acc7"]]);
const aria$3 = "A tenant is a billing and identity boundary containing one or more scopes. Each scope is its own database and its own consistency domain, with its own kind, jurisdiction and bound vertical version. Nothing joins across the boundary between two scopes.";
const tenant = {
  tag: "billing · identity · the contract",
  title: "Tenant",
  sub: "slug · status · one Identity DO for all its people",
  note: "Holds no operational rows of its own."
};
const scopes$1 = [
  { slug: "stockholm", kind: "branch", note: "active · eu" },
  { slug: "göteborg", kind: "branch", note: "active · eu" },
  { slug: "malmö", kind: "branch", note: "provisioning" }
];
const scopeFacts = [
  "its own database — one SQLite file, or one Durable Object",
  "one operation at a time, run to completion",
  "kind is your vocabulary: brf, branch, brand, clinic…",
  "jurisdiction and bound version are fixed per scope"
];
const barrier = "No query crosses these lines. There is no join between two scopes.";
const deeper = "parentScopeId is null on every scope today. The column exists so a deeper tree is an addition rather than a migration.";
const caption$4 = "The tenant is who you bill and who can log in. The scope is where data lives and where consistency is decided — which is why isolation is a property of the substrate here, not a WHERE clause somebody has to remember.";
const _sfc_main$6 = /* @__PURE__ */ defineComponent({
  __name: "TenancyTree",
  __ssrInlineRender: true,
  setup(__props) {
    return (_ctx, _push, _parent, _attrs) => {
      _push(`<figure${ssrRenderAttrs(mergeProps({ class: "fig" }, _attrs))} data-v-640a3f61><svg viewBox="0 0 700 430" role="img"${ssrRenderAttr("aria-label", unref(aria$3))} data-v-640a3f61><defs data-v-640a3f61><marker id="tt-arw" viewBox="0 0 9 7" refX="8" refY="3.5" markerWidth="7" markerHeight="6" orient="auto" data-v-640a3f61><polygon class="mk" points="0 0, 9 3.5, 0 7" data-v-640a3f61></polygon></marker></defs><rect class="tbox" x="24" y="24" width="652" height="252" rx="14" data-v-640a3f61></rect><text class="t-tag" x="46" y="50" data-v-640a3f61>${ssrInterpolate(unref(tenant).tag)}</text><text class="t-title" x="46" y="72" data-v-640a3f61>${ssrInterpolate(unref(tenant).title)}</text><text class="t-sub" x="46" y="92" data-v-640a3f61>${ssrInterpolate(unref(tenant).sub)}</text><text class="t-note" x="46" y="110" data-v-640a3f61>${ssrInterpolate(unref(tenant).note)}</text><path class="flowline" d="M64 118 V136 H558" data-v-640a3f61></path><!--[-->`);
      ssrRenderList(unref(scopes$1), (s, i) => {
        _push(`<g data-v-640a3f61><path class="flowline"${ssrRenderAttr("d", `M${142 + i * 208} 136 V152`)} marker-end="url(#tt-arw)" data-v-640a3f61></path><rect class="sbox"${ssrRenderAttr("x", 46 + i * 208)} y="158" width="192" height="94" rx="10" data-v-640a3f61></rect><svg${ssrRenderAttr("x", 56 + i * 208)} y="170" width="20" height="24" viewBox="0 0 30 34" fill="none" stroke="currentColor" stroke-width="1.8" class="cyl" aria-hidden="true" data-v-640a3f61><ellipse cx="15" cy="6" rx="12" ry="4.5" data-v-640a3f61></ellipse><path d="M3 6v22c0 2.5 5.4 4.5 12 4.5s12-2 12-4.5V6" data-v-640a3f61></path><path d="M3 17c0 2.5 5.4 4.5 12 4.5s12-2 12-4.5" opacity=".55" data-v-640a3f61></path></svg><text class="t-slug"${ssrRenderAttr("x", 84 + i * 208)} y="186" data-v-640a3f61>${ssrInterpolate(s.slug)}</text><text class="t-sub"${ssrRenderAttr("x", 62 + i * 208)} y="216" data-v-640a3f61>kind: ${ssrInterpolate(s.kind)}</text><text class="t-note"${ssrRenderAttr("x", 62 + i * 208)} y="234" data-v-640a3f61>${ssrInterpolate(s.note)}</text></g>`);
      });
      _push(`<!--]--><path class="barrier" d="M246 150 V262" data-v-640a3f61></path><path class="barrier" d="M454 150 V262" data-v-640a3f61></path><text class="t-barrier" x="350" y="296" text-anchor="middle" data-v-640a3f61>${ssrInterpolate(unref(barrier))}</text><text class="t-tag" x="24" y="330" data-v-640a3f61>every scope is</text><!--[-->`);
      ssrRenderList(unref(scopeFacts), (f, i) => {
        _push(`<text class="t-sub" x="24"${ssrRenderAttr("y", 350 + i * 17)} data-v-640a3f61>· ${ssrInterpolate(f)}</text>`);
      });
      _push(`<!--]--></svg><figcaption data-v-640a3f61>${ssrInterpolate(unref(deeper))} ${ssrInterpolate(unref(caption$4))}</figcaption></figure>`);
    };
  }
});
const _sfc_setup$6 = _sfc_main$6.setup;
_sfc_main$6.setup = (props, ctx) => {
  const ssrContext = useSSRContext();
  (ssrContext.modules || (ssrContext.modules = /* @__PURE__ */ new Set())).add(".vitepress/theme/components/TenancyTree.vue");
  return _sfc_setup$6 ? _sfc_setup$6(props, ctx) : void 0;
};
const TenancyTree = /* @__PURE__ */ _export_sfc(_sfc_main$6, [["__scopeId", "data-v-640a3f61"]]);
const aria$2 = "Three read paths at increasing distance from the scope. An in-scope read is a local indexed query with no staleness. An external read model is fed by events and is eventually consistent. The history tier is fed by export and is not a read tier for interactive use.";
const paths = [
  {
    n: 1,
    title: "In-scope read",
    latency: "µs",
    consistency: "serializable",
    use: "everything interactive",
    how: "a projection table in the scope’s own database, committed with the write that caused it",
    inside: true
  },
  {
    n: 2,
    title: "External read model",
    latency: "ms",
    consistency: "eventually consistent",
    use: "a scope whose reads outgrow its executor",
    how: "fed by events off the spine",
    inside: false
  },
  {
    n: 3,
    title: "History tier",
    latency: "seconds",
    consistency: "eventually consistent",
    use: "reporting, audit, cross-scope",
    how: "exported to Iceberg / R2 SQL",
    inside: false
  }
];
const boundary = "the scope boundary — everything below it is allowed to be behind";
const caption$3 = "Distance from the boundary is the staleness. Path 1 has none — there is no second store, because the projection commits with the write that caused it. Path 3 is not a read tier for anything a person is waiting on.";
const _sfc_main$5 = /* @__PURE__ */ defineComponent({
  __name: "ReadPaths",
  __ssrInlineRender: true,
  setup(__props) {
    return (_ctx, _push, _parent, _attrs) => {
      _push(`<figure${ssrRenderAttrs(mergeProps({ class: "fig" }, _attrs))} data-v-250526d2><svg viewBox="0 0 700 446" role="img"${ssrRenderAttr("aria-label", unref(aria$2))} data-v-250526d2><defs data-v-250526d2><marker id="rp-arw" viewBox="0 0 9 7" refX="8" refY="3.5" markerWidth="7" markerHeight="6" orient="auto" data-v-250526d2><polygon class="mk" points="0 0, 9 3.5, 0 7" data-v-250526d2></polygon></marker></defs><rect class="scope" x="24" y="24" width="652" height="172" rx="12" data-v-250526d2></rect><text class="t-scope" x="44" y="52" data-v-250526d2>Scope</text><text class="t-sub" x="44" y="72" data-v-250526d2>its own database · one operation at a time</text><rect class="pbox pbox--inside" x="44" y="92" width="612" height="84" rx="10" data-v-250526d2></rect><text class="t-n" x="60" y="118" data-v-250526d2>${ssrInterpolate(unref(paths)[0].n)}</text><text class="t-ptitle" x="78" y="118" data-v-250526d2>${ssrInterpolate(unref(paths)[0].title)}</text><text class="t-sub" x="60" y="138" data-v-250526d2>${ssrInterpolate(unref(paths)[0].how)}</text><text class="t-meta" x="60" y="162" data-v-250526d2>${ssrInterpolate(unref(paths)[0].latency)} · ${ssrInterpolate(unref(paths)[0].consistency)}</text><text class="t-use" x="640" y="162" text-anchor="end" data-v-250526d2>${ssrInterpolate(unref(paths)[0].use)}</text><path class="barrier" d="M24 216 H676" data-v-250526d2></path><text class="t-tag t-tag--scope" x="350" y="210" text-anchor="middle" data-v-250526d2>${ssrInterpolate(unref(boundary))}</text><!--[-->`);
      ssrRenderList(unref(paths).slice(1), (p, i) => {
        _push(`<g data-v-250526d2><path class="flowline"${ssrRenderAttr("d", `M100 ${i === 0 ? 216 : 332 + (i - 1) * 96} V${248 + i * 96 - 4}`)} marker-end="url(#rp-arw)" data-v-250526d2></path><rect class="pbox pbox--outside" x="44"${ssrRenderAttr("y", 248 + i * 96)} width="612" height="84" rx="10" data-v-250526d2></rect><text class="t-n" x="60"${ssrRenderAttr("y", 274 + i * 96)} data-v-250526d2>${ssrInterpolate(p.n)}</text><text class="t-ptitle" x="78"${ssrRenderAttr("y", 274 + i * 96)} data-v-250526d2>${ssrInterpolate(p.title)}</text><text class="t-sub" x="60"${ssrRenderAttr("y", 294 + i * 96)} data-v-250526d2>${ssrInterpolate(p.how)}</text><text class="t-meta" x="60"${ssrRenderAttr("y", 318 + i * 96)} data-v-250526d2>${ssrInterpolate(p.latency)} · ${ssrInterpolate(p.consistency)}</text><text class="t-use" x="640"${ssrRenderAttr("y", 318 + i * 96)} text-anchor="end" data-v-250526d2>${ssrInterpolate(p.use)}</text></g>`);
      });
      _push(`<!--]--></svg><figcaption data-v-250526d2>${ssrInterpolate(unref(caption$3))}</figcaption></figure>`);
    };
  }
});
const _sfc_setup$5 = _sfc_main$5.setup;
_sfc_main$5.setup = (props, ctx) => {
  const ssrContext = useSSRContext();
  (ssrContext.modules || (ssrContext.modules = /* @__PURE__ */ new Set())).add(".vitepress/theme/components/ReadPaths.vue");
  return _sfc_setup$5 ? _sfc_setup$5(props, ctx) : void 0;
};
const ReadPaths = /* @__PURE__ */ _export_sfc(_sfc_main$5, [["__scopeId", "data-v-250526d2"]]);
const aria$1 = "The Scope Durable Object delegates an outbox delivery up to the connector runtime in the vertical worker, which opens the sealed credential and calls the provider with a bound fetch. The provider’s callback returns to the worker, which reopens the scope through getConnectorScope with the connection as its subject.";
const scope = {
  tag: "durable object",
  title: "Scope DO",
  sub: ["The operation committed;", "the event is in the outbox."],
  chip: "no fetch() here — the lint forbids it"
};
const runtime = {
  tag: "worker",
  title: "Connector runtime",
  sub: ["Opens the sealed credential", "for this tenant."],
  chip: "fetch bound to the connection · retry"
};
const provider = {
  tag: "outside the platform",
  title: "The provider",
  sub: "Scrive, Fortnox, a bank.",
  chip: "never sees a principal"
};
const arrows = {
  out: "delegates the delivery",
  back: "getConnectorScope()",
  send: "sends the document",
  callback: "the provider calls back"
};
const caption$2 = "A provider’s callback is not a person, so it cannot hold a principal. The connection itself is the subject: getConnectorScope opens a stub whose authority is that connection’s own grants, narrowed by construction to one tenant and one vertical.";
const _sfc_main$4 = /* @__PURE__ */ defineComponent({
  __name: "ConnectorLoop",
  __ssrInlineRender: true,
  setup(__props) {
    return (_ctx, _push, _parent, _attrs) => {
      _push(`<figure${ssrRenderAttrs(mergeProps({ class: "fig" }, _attrs))} data-v-9b3e73a8><svg viewBox="0 0 700 380" role="img"${ssrRenderAttr("aria-label", unref(aria$1))} data-v-9b3e73a8><defs data-v-9b3e73a8><marker id="cl-arw" viewBox="0 0 9 7" refX="8" refY="3.5" markerWidth="7" markerHeight="6" orient="auto" data-v-9b3e73a8><polygon class="mk" points="0 0, 9 3.5, 0 7" data-v-9b3e73a8></polygon></marker></defs><rect class="fbox" x="40" y="36" width="300" height="120" rx="10" data-v-9b3e73a8></rect><text class="t-tag" x="58" y="58" data-v-9b3e73a8>${ssrInterpolate(unref(scope).tag)}</text><text class="t-title" x="58" y="80" data-v-9b3e73a8>${ssrInterpolate(unref(scope).title)}</text><!--[-->`);
      ssrRenderList(unref(scope).sub, (l, i) => {
        _push(`<text class="t-sub" x="58"${ssrRenderAttr("y", 100 + i * 17)} data-v-9b3e73a8>${ssrInterpolate(l)}</text>`);
      });
      _push(`<!--]--><rect class="fchip fchip--v" x="58" y="126" width="264" height="26" rx="6" data-v-9b3e73a8></rect><circle class="ldot ldot--v" cx="74" cy="139" r="4" data-v-9b3e73a8></circle><text class="t-sub" x="88" y="143" data-v-9b3e73a8>${ssrInterpolate(unref(scope).chip)}</text><path class="flowline" d="M130 162 V226" marker-end="url(#cl-arw)" data-v-9b3e73a8></path><text class="t-arw" x="142" y="190" data-v-9b3e73a8>${ssrInterpolate(unref(arrows).out)}</text><path class="flowline" d="M280 226 V162" marker-end="url(#cl-arw)" data-v-9b3e73a8></path><text class="t-arw" x="268" y="214" text-anchor="end" data-v-9b3e73a8>${ssrInterpolate(unref(arrows).back)}</text><rect class="fbox" x="40" y="236" width="300" height="120" rx="10" data-v-9b3e73a8></rect><text class="t-tag" x="58" y="258" data-v-9b3e73a8>${ssrInterpolate(unref(runtime).tag)}</text><text class="t-title" x="58" y="280" data-v-9b3e73a8>${ssrInterpolate(unref(runtime).title)}</text><!--[-->`);
      ssrRenderList(unref(runtime).sub, (l, i) => {
        _push(`<text class="t-sub" x="58"${ssrRenderAttr("y", 300 + i * 17)} data-v-9b3e73a8>${ssrInterpolate(l)}</text>`);
      });
      _push(`<!--]--><rect class="fchip fchip--k" x="58" y="326" width="264" height="26" rx="6" data-v-9b3e73a8></rect><circle class="ldot ldot--k" cx="74" cy="339" r="4" data-v-9b3e73a8></circle><text class="t-sub" x="88" y="343" data-v-9b3e73a8>${ssrInterpolate(unref(runtime).chip)}</text><path class="flowline" d="M346 268 L396 200" marker-end="url(#cl-arw)" data-v-9b3e73a8></path><text class="t-arw" x="530" y="124" text-anchor="middle" data-v-9b3e73a8>${ssrInterpolate(unref(arrows).send)}</text><path class="flowline" d="M396 232 L346 310" marker-end="url(#cl-arw)" data-v-9b3e73a8></path><text class="t-arw" x="530" y="280" text-anchor="middle" data-v-9b3e73a8>${ssrInterpolate(unref(arrows).callback)}</text><rect class="fbox outside" x="400" y="136" width="260" height="120" rx="10" data-v-9b3e73a8></rect><text class="t-tag" x="418" y="158" data-v-9b3e73a8>${ssrInterpolate(unref(provider).tag)}</text><text class="t-title" x="418" y="180" data-v-9b3e73a8>${ssrInterpolate(unref(provider).title)}</text><text class="t-sub" x="418" y="200" data-v-9b3e73a8>${ssrInterpolate(unref(provider).sub)}</text><rect class="fpane" x="418" y="210" width="200" height="26" rx="6" data-v-9b3e73a8></rect><text class="t-sub" x="432" y="227" data-v-9b3e73a8>${ssrInterpolate(unref(provider).chip)}</text></svg><figcaption data-v-9b3e73a8>${ssrInterpolate(unref(caption$2))}</figcaption></figure>`);
    };
  }
});
const _sfc_setup$4 = _sfc_main$4.setup;
_sfc_main$4.setup = (props, ctx) => {
  const ssrContext = useSSRContext();
  (ssrContext.modules || (ssrContext.modules = /* @__PURE__ */ new Set())).add(".vitepress/theme/components/ConnectorLoop.vue");
  return _sfc_setup$4 ? _sfc_setup$4(props, ctx) : void 0;
};
const ConnectorLoop = /* @__PURE__ */ _export_sfc(_sfc_main$4, [["__scopeId", "data-v-9b3e73a8"]]);
const aria = "Vertical code reaches a scope host through the kernel API only. The host hands out capability stubs for individual scopes, each with its own database and ACL and its own serialized executor. Every scope emits kernel-stamped events into one shared event spine.";
const vertical = {
  tag: "your code",
  title: "Vertical",
  sub: "TypeScript · often AI-built"
};
const toHost = "@substrat-run/kernel API only";
const host = {
  tag: "kernel",
  title: "Scope host",
  mono: "getScope(principal, tenant, scope)"
};
const toScopes = "holding a stub is the authorization";
const scopes = [
  {
    tag: "one isolation domain",
    title: "Scope · branch #1",
    sub: ["its own database + ACL", "serialized — one op at a time"]
  },
  {
    tag: "one isolation domain",
    title: "Scope · branch #240",
    sub: ["its own database + ACL", "serialized — one op at a time"]
  }
];
const toSpine = "events, kernel-stamped";
const spine = {
  tag: "kernel-owned",
  title: "Event spine",
  sub: "audit · reporting · integrations"
};
const caption$1 = "The same shape on every adapter — one SQLite file per scope locally, one Durable Object per scope in production. Nothing above the stub can widen its own reach.";
const _sfc_main$3 = /* @__PURE__ */ defineComponent({
  __name: "ScopeTopology",
  __ssrInlineRender: true,
  setup(__props) {
    return (_ctx, _push, _parent, _attrs) => {
      _push(`<figure${ssrRenderAttrs(mergeProps({ class: "fig" }, _attrs))} data-v-b04ae98f><svg viewBox="0 0 700 626" role="img"${ssrRenderAttr("aria-label", unref(aria))} data-v-b04ae98f><defs data-v-b04ae98f><marker id="st-arw" viewBox="0 0 9 7" refX="8" refY="3.5" markerWidth="7" markerHeight="6" orient="auto" data-v-b04ae98f><polygon class="mk" points="0 0, 9 3.5, 0 7" data-v-b04ae98f></polygon></marker></defs><rect class="fbox fbox--v" x="180" y="30" width="340" height="86" rx="10" data-v-b04ae98f></rect><text class="t-tag" x="198" y="52" data-v-b04ae98f>${ssrInterpolate(unref(vertical).tag)}</text><text class="t-title" x="198" y="74" data-v-b04ae98f>${ssrInterpolate(unref(vertical).title)}</text><text class="t-sub" x="198" y="94" data-v-b04ae98f>${ssrInterpolate(unref(vertical).sub)}</text><path class="flowline" d="M350 122 V162" marker-end="url(#st-arw)" data-v-b04ae98f></path><text class="t-arw" x="362" y="148" data-v-b04ae98f>${ssrInterpolate(unref(toHost))}</text><rect class="fbox fbox--k" x="140" y="172" width="420" height="94" rx="10" data-v-b04ae98f></rect><text class="t-tag" x="158" y="194" data-v-b04ae98f>${ssrInterpolate(unref(host).tag)}</text><text class="t-title" x="158" y="216" data-v-b04ae98f>${ssrInterpolate(unref(host).title)}</text><text class="t-mono" x="158" y="240" data-v-b04ae98f>${ssrInterpolate(unref(host).mono)}</text><path class="flowline" d="M250 272 L168 310" marker-end="url(#st-arw)" data-v-b04ae98f></path><path class="flowline" d="M450 272 L532 310" marker-end="url(#st-arw)" data-v-b04ae98f></path><text class="t-arw" x="350" y="298" text-anchor="middle" data-v-b04ae98f>${ssrInterpolate(unref(toScopes))}</text><!--[-->`);
      ssrRenderList(unref(scopes), (s, i) => {
        _push(`<g data-v-b04ae98f><rect class="fbox fbox--k"${ssrRenderAttr("x", 40 + i * 340)} y="320" width="280" height="130" rx="10" data-v-b04ae98f></rect><text class="t-tag"${ssrRenderAttr("x", 58 + i * 340)} y="342" data-v-b04ae98f>${ssrInterpolate(s.tag)}</text><text class="t-title"${ssrRenderAttr("x", 58 + i * 340)} y="364" data-v-b04ae98f>${ssrInterpolate(s.title)}</text><!--[-->`);
        ssrRenderList(s.sub, (l, j) => {
          _push(`<text class="t-sub"${ssrRenderAttr("x", 58 + i * 340)}${ssrRenderAttr("y", 384 + j * 17)} data-v-b04ae98f>${ssrInterpolate(l)}</text>`);
        });
        _push(`<!--]--></g>`);
      });
      _push(`<!--]--><path class="flowline" d="M180 456 L246 510" marker-end="url(#st-arw)" data-v-b04ae98f></path><path class="flowline" d="M520 456 L454 510" marker-end="url(#st-arw)" data-v-b04ae98f></path><text class="t-arw" x="350" y="492" text-anchor="middle" data-v-b04ae98f>${ssrInterpolate(unref(toSpine))}</text><rect class="fbox fbox--k" x="140" y="520" width="420" height="86" rx="10" data-v-b04ae98f></rect><text class="t-tag" x="158" y="542" data-v-b04ae98f>${ssrInterpolate(unref(spine).tag)}</text><text class="t-title" x="158" y="564" data-v-b04ae98f>${ssrInterpolate(unref(spine).title)}</text><text class="t-sub" x="158" y="584" data-v-b04ae98f>${ssrInterpolate(unref(spine).sub)}</text></svg><figcaption data-v-b04ae98f>${ssrInterpolate(unref(caption$1))}</figcaption></figure>`);
    };
  }
});
const _sfc_setup$3 = _sfc_main$3.setup;
_sfc_main$3.setup = (props, ctx) => {
  const ssrContext = useSSRContext();
  (ssrContext.modules || (ssrContext.modules = /* @__PURE__ */ new Set())).add(".vitepress/theme/components/ScopeTopology.vue");
  return _sfc_setup$3 ? _sfc_setup$3(props, ctx) : void 0;
};
const ScopeTopology = /* @__PURE__ */ _export_sfc(_sfc_main$3, [["__scopeId", "data-v-b04ae98f"]]);
const lifecycles$2 = {
  reservation: {
    field: "state",
    initial: "held",
    states: {
      cancelled: {
        terminal: true
      },
      completed: {
        terminal: true
      },
      confirmed: {
        on: {
          "booking/cancel": "cancelled",
          "booking/complete": "completed",
          "booking/no-show": "no_show",
          "booking/start": "in_service"
        },
        allow: [
          "booking/join",
          "booking/move",
          "booking/open"
        ]
      },
      expired: {
        terminal: true
      },
      held: {
        on: {
          "booking/cancel": "cancelled",
          "booking/confirm": "confirmed",
          "booking/expire": "expired"
        },
        allow: [
          "booking/join",
          "booking/move",
          "booking/open"
        ]
      },
      in_service: {
        on: {
          "booking/complete": "completed",
          "booking/no-show": "no_show"
        }
      },
      no_show: {
        terminal: true
      }
    }
  }
};
const booking = {
  lifecycles: lifecycles$2
};
const lifecycles$1 = {
  underlag: {
    field: "status",
    initial: "open",
    states: {
      exported: {
        terminal: true
      },
      open: {
        on: {
          "invoicing/export": "exported"
        }
      }
    }
  }
};
const invoicing = {
  lifecycles: lifecycles$1
};
const lifecycles = {
  workorder: {
    field: "status",
    initial: "planned",
    states: {
      closed: {
        terminal: true
      },
      completed: {
        on: {
          "workorder/close": "closed"
        }
      },
      in_progress: {
        on: {
          "workorder/complete": "completed"
        },
        allow: [
          "workorder/report-material",
          "workorder/report-time"
        ],
        extensible: true
      },
      planned: {
        on: {
          "workorder/start": "in_progress"
        },
        allow: [
          "workorder/assign",
          "workorder/report-material",
          "workorder/report-time"
        ]
      }
    }
  }
};
const workorder = {
  lifecycles
};
function fromModel(model, entity) {
  var _a;
  const machine = (_a = model.lifecycles) == null ? void 0 : _a[entity];
  if (!machine) throw new Error(`model.json declares no lifecycle for '${entity}'`);
  return machine;
}
const verb = (operationId) => operationId.includes("/") ? operationId.slice(operationId.indexOf("/") + 1) : operationId;
const edgesOf = (m) => Object.entries(m.states).flatMap(
  ([from, s]) => Object.entries(s.on ?? {}).map(([op, to]) => ({ from, to, op }))
);
function longestPath(m, edges2) {
  const walk = (at, seen) => {
    const next = edges2.filter((e) => e.from === at && !seen.includes(e.to)).map((e) => walk(e.to, [...seen, e.to]));
    return next.reduce((best, p) => p.length > best.length ? p : best, []).length ? [at, ...next.reduce((b, p) => p.length > b.length ? p : b, [])] : [at];
  };
  return walk(m.initial, [m.initial]);
}
function layout(m) {
  const edges2 = edgesOf(m);
  const spine2 = longestPath(m, edges2);
  const onSpine = new Set(spine2);
  const spineEdges = [];
  for (let i = 0; i < spine2.length - 1; i++) {
    const e = edges2.find((x) => x.from === spine2[i] && x.to === spine2[i + 1]);
    if (e) spineEdges.push(e);
  }
  const rest = edges2.filter((e) => !spineEdges.includes(e));
  return {
    spine: spine2,
    spineEdges,
    branches: rest.filter((e) => !onSpine.has(e.to)),
    rejoins: rest.filter((e) => onSpine.has(e.to))
  };
}
const absence = {
  field: "status",
  initial: "requested",
  states: {
    requested: {
      on: {
        "absence/approve": "approved",
        "absence/reject": "rejected",
        "absence/cancel": "cancelled"
      }
    },
    approved: { on: { "absence/cancel": "cancelled" } },
    rejected: { terminal: true },
    cancelled: { terminal: true }
  }
};
const protocol = {
  field: "status",
  initial: "open",
  states: {
    open: {
      on: {
        "protocol/request-signatures": "pending_signature",
        "protocol/sign": "signed",
        "protocol/void": "voided"
      }
    },
    pending_signature: {
      on: {
        "protocol/complete-signing": "signed",
        "protocol/cancel-signature-requests": "open",
        "protocol/void": "voided"
      }
    },
    signed: { on: { "protocol/void": "voided" } },
    voided: { terminal: true }
  }
};
const invites = {
  field: "state",
  initial: "invited",
  states: {
    invited: {
      on: {
        "invites/accept": "accepted",
        "invites/revoke": "revoked",
        "invites/expire": "expired"
      }
    },
    accepted: { terminal: true },
    revoked: { terminal: true },
    expired: { terminal: true }
  }
};
const DIAGRAMS = {
  workorder: { entity: "workorder", machine: fromModel(workorder, "workorder"), declared: true },
  booking: { entity: "reservation", machine: fromModel(booking, "reservation"), declared: true },
  invoicing: { entity: "underlag", machine: fromModel(invoicing, "underlag"), declared: true },
  absence: { entity: "absence request", machine: absence, declared: false },
  protocol: { entity: "protocol", machine: protocol, declared: false },
  invites: { entity: "invitation", machine: invites, declared: false }
};
function diagramFor(engine) {
  const d = DIAGRAMS[engine];
  if (!d) throw new Error(`no state machine registered for engine '${engine}'`);
  return d;
}
const emittedNote = "Drawn from the engine’s declared lifecycle in model.json — the same artifact lint:model --check gates, so this picture cannot drift from the code.";
const transcribedNote = "This engine declares no lifecycle yet, so the machine above is transcribed from its status enum and guard clauses. Nothing re-checks it — treat it as documentation, not as the contract.";
const BOX_H = 44;
const BRANCH_PITCH = 56;
const GAP = 42;
const SPINE_X = 100;
const SPINE_W = 200;
const BRANCH_X = 392;
const BRANCH_W = 236;
const _sfc_main$2 = /* @__PURE__ */ defineComponent({
  __name: "StateMachine",
  __ssrInlineRender: true,
  props: {
    engine: {}
  },
  setup(__props) {
    const props = __props;
    const view = computed(() => {
      const d = diagramFor(props.engine);
      const l = layout(d.machine);
      const branchesOf = (state) => l.branches.filter((b) => b.from === state);
      const rows = l.spine.map((state, i) => ({ state, i, branches: branchesOf(state) }));
      let y = 30;
      const placed = rows.map((r) => {
        const at = y;
        y += Math.max(1, r.branches.length) * BRANCH_PITCH + GAP;
        return { ...r, y: at };
      });
      const yOf = (state) => {
        var _a;
        return ((_a = placed.find((p) => p.state === state)) == null ? void 0 : _a.y) ?? 0;
      };
      return {
        d,
        machine: d.machine,
        placed,
        spineEdges: l.spineEdges.map((e, i) => ({
          ...e,
          from: placed[i].y + BOX_H,
          to: placed[i + 1].y
        })),
        rejoins: l.rejoins.map((e, i) => ({
          ...e,
          y1: yOf(e.from) + BOX_H / 2,
          y2: yOf(e.to) + BOX_H / 2,
          x: 74 - i * 22
        })),
        terminal: (s) => {
          var _a;
          return Boolean((_a = d.machine.states[s]) == null ? void 0 : _a.terminal);
        },
        // Out of the drawing on purpose: these operations are legal in a state and
        // move nothing, so they are not edges. Rendering them beside the spine put
        // two unrelated labels in the same place and read as though they were.
        allows: Object.entries(d.machine.states).filter(([, st]) => {
          var _a;
          return (_a = st.allow) == null ? void 0 : _a.length;
        }).map(([state, st]) => ({ state, ops: st.allow.map(verb) })),
        height: y - GAP + 20,
        aria: `The ${d.entity} state machine on ${d.machine.field}. It runs ${l.spine.join(", then ")}. ` + (l.branches.length ? `States leaving that run: ${l.branches.map((b) => `${b.from} to ${b.to} on ${verb(b.op)}`).join("; ")}.` : "No state leaves that run.")
      };
    });
    return (_ctx, _push, _parent, _attrs) => {
      _push(`<figure${ssrRenderAttrs(mergeProps({ class: "fig" }, _attrs))} data-v-c501c284><svg${ssrRenderAttr("viewBox", `0 0 700 ${view.value.height}`)} role="img"${ssrRenderAttr("aria-label", view.value.aria)} data-v-c501c284><defs data-v-c501c284><marker id="sm-arw" viewBox="0 0 9 7" refX="8" refY="3.5" markerWidth="7" markerHeight="6" orient="auto" data-v-c501c284><polygon class="mk" points="0 0, 9 3.5, 0 7" data-v-c501c284></polygon></marker></defs><!--[-->`);
      ssrRenderList(view.value.rejoins, (r) => {
        _push(`<g data-v-c501c284><path class="flowline dashed"${ssrRenderAttr("d", `M${SPINE_X} ${r.y1} H${r.x} V${r.y2} H${SPINE_X - 4}`)} marker-end="url(#sm-arw)" data-v-c501c284></path><text class="t-edge"${ssrRenderAttr("x", r.x - 6)}${ssrRenderAttr("y", (r.y1 + r.y2) / 2)} text-anchor="end" data-v-c501c284>${ssrInterpolate(unref(verb)(r.op))}</text></g>`);
      });
      _push(`<!--]--><!--[-->`);
      ssrRenderList(view.value.placed, (p) => {
        _push(`<g data-v-c501c284><rect class="${ssrRenderClass([{ "sbox--terminal": view.value.terminal(p.state), "sbox--initial": p.i === 0 }, "sbox"])}"${ssrRenderAttr("x", SPINE_X)}${ssrRenderAttr("y", p.y)}${ssrRenderAttr("width", SPINE_W)}${ssrRenderAttr("height", BOX_H)} rx="9" data-v-c501c284></rect><text class="t-state"${ssrRenderAttr("x", SPINE_X + 16)}${ssrRenderAttr("y", p.y + 27)} data-v-c501c284>${ssrInterpolate(p.state)}</text><!--[-->`);
        ssrRenderList(p.branches, (b, j) => {
          _push(`<g data-v-c501c284><path class="flowline"${ssrRenderAttr("d", `M${SPINE_X + SPINE_W} ${p.y + BOX_H / 2} H${BRANCH_X - 40} V${p.y + j * BRANCH_PITCH + BOX_H / 2} H${BRANCH_X - 4}`)} marker-end="url(#sm-arw)" data-v-c501c284></path><text class="t-edge"${ssrRenderAttr("x", SPINE_X + SPINE_W + 10)}${ssrRenderAttr("y", p.y + j * BRANCH_PITCH + BOX_H / 2 - 6)} data-v-c501c284>${ssrInterpolate(unref(verb)(b.op))}</text><rect class="${ssrRenderClass([{ "sbox--terminal": view.value.terminal(b.to) }, "sbox sbox--off"])}"${ssrRenderAttr("x", BRANCH_X)}${ssrRenderAttr("y", p.y + j * BRANCH_PITCH)}${ssrRenderAttr("width", BRANCH_W)}${ssrRenderAttr("height", BOX_H)} rx="9" data-v-c501c284></rect><text class="t-state"${ssrRenderAttr("x", BRANCH_X + 16)}${ssrRenderAttr("y", p.y + j * BRANCH_PITCH + 27)} data-v-c501c284>${ssrInterpolate(b.to)}</text></g>`);
        });
        _push(`<!--]--></g>`);
      });
      _push(`<!--]--><!--[-->`);
      ssrRenderList(view.value.spineEdges, (e) => {
        _push(`<g data-v-c501c284><path class="flowline"${ssrRenderAttr("d", `M${SPINE_X + 44} ${e.from} V${e.to - 4}`)} marker-end="url(#sm-arw)" data-v-c501c284></path><text class="t-edge"${ssrRenderAttr("x", SPINE_X + 54)}${ssrRenderAttr("y", e.from + 20)} data-v-c501c284>${ssrInterpolate(unref(verb)(e.op))}</text></g>`);
      });
      _push(`<!--]--></svg>`);
      if (view.value.allows.length) {
        _push(`<ul class="allows" data-v-c501c284><!--[-->`);
        ssrRenderList(view.value.allows, (a) => {
          _push(`<li data-v-c501c284><code data-v-c501c284>${ssrInterpolate(a.state)}</code> admits ${ssrInterpolate(a.ops.join(" · "))} — none of which move it </li>`);
        });
        _push(`<!--]--></ul>`);
      } else {
        _push(`<!---->`);
      }
      _push(`<figcaption data-v-c501c284><code data-v-c501c284>${ssrInterpolate(view.value.machine.field)}</code> · starts at <code data-v-c501c284>${ssrInterpolate(view.value.machine.initial)}</code>. ${ssrInterpolate(view.value.d.declared ? unref(emittedNote) : unref(transcribedNote))}</figcaption></figure>`);
    };
  }
});
const _sfc_setup$2 = _sfc_main$2.setup;
_sfc_main$2.setup = (props, ctx) => {
  const ssrContext = useSSRContext();
  (ssrContext.modules || (ssrContext.modules = /* @__PURE__ */ new Set())).add(".vitepress/theme/components/StateMachine.vue");
  return _sfc_setup$2 ? _sfc_setup$2(props, ctx) : void 0;
};
const StateMachine = /* @__PURE__ */ _export_sfc(_sfc_main$2, [["__scopeId", "data-v-c501c284"]]);
const above = {
  name: "What an agent writes",
  verdict: "Mistakes are cosmetic",
  chips: ["screens", "forms", "workflows", "reports", "pricing", "vocabulary"]
};
const below = {
  name: "What the substrate owns",
  verdict: "Mistakes are catastrophic",
  chips: ["tenancy", "auth", "migrations", "integrations", "audit", "compliance"]
};
const caption = 'The layer where models are weakest is the layer where mistakes are fatal. So the split is structural rather than instructional: prompting a model to "be careful with tenancy" is a suggestion, and a `getScope` call that fails closed on a mismatched pair is a fact.';
const captionHtml = caption.replace(/`([^`]+)`/g, "<code>$1</code>");
const _sfc_main$1 = /* @__PURE__ */ defineComponent({
  __name: "BlastRadius",
  __ssrInlineRender: true,
  setup(__props) {
    return (_ctx, _push, _parent, _attrs) => {
      _push(`<figure${ssrRenderAttrs(mergeProps({ class: "blast" }, _attrs))} data-v-22f9850e><section class="side side--above" data-v-22f9850e><header data-v-22f9850e><h3 data-v-22f9850e>${ssrInterpolate(unref(above).name)}</h3><span class="verdict" data-v-22f9850e>${ssrInterpolate(unref(above).verdict)}</span></header><div class="chips" data-v-22f9850e><!--[-->`);
      ssrRenderList(unref(above).chips, (c) => {
        _push(`<span class="chip" data-v-22f9850e>${ssrInterpolate(c)}</span>`);
      });
      _push(`<!--]--></div></section><div class="divider" data-v-22f9850e><span class="label" data-v-22f9850e>${ssrInterpolate(unref(theLine).label)}</span><span class="rule" aria-hidden="true" data-v-22f9850e></span><span class="label" data-v-22f9850e>guarantees below · velocity above</span></div><section class="side side--below" data-v-22f9850e><header data-v-22f9850e><h3 data-v-22f9850e>${ssrInterpolate(unref(below).name)}</h3><span class="verdict" data-v-22f9850e>${ssrInterpolate(unref(below).verdict)}</span></header><div class="chips" data-v-22f9850e><!--[-->`);
      ssrRenderList(unref(below).chips, (c) => {
        _push(`<span class="chip" data-v-22f9850e>${ssrInterpolate(c)}</span>`);
      });
      _push(`<!--]--></div></section><figcaption data-v-22f9850e>${unref(captionHtml) ?? ""}</figcaption></figure>`);
    };
  }
});
const _sfc_setup$1 = _sfc_main$1.setup;
_sfc_main$1.setup = (props, ctx) => {
  const ssrContext = useSSRContext();
  (ssrContext.modules || (ssrContext.modules = /* @__PURE__ */ new Set())).add(".vitepress/theme/components/BlastRadius.vue");
  return _sfc_setup$1 ? _sfc_setup$1(props, ctx) : void 0;
};
const BlastRadius = /* @__PURE__ */ _export_sfc(_sfc_main$1, [["__scopeId", "data-v-22f9850e"]]);
const guards = [
  {
    when: "Compile",
    title: "Invalid states don't typecheck",
    body: "A narrow, aggressively typed SDK means a small hallucination surface. A <code>ScopeId</code> will not typecheck where a <code>TenantId</code> is expected, so an agent cannot swap them silently. A permission <code>Decision</code> is either <code>{ allowed: true, proof }</code> or <code>{ allowed: false, checked, node }</code> — an unexplained allow is unrepresentable. An event without a <code>piiClass</code> doesn't parse, and a PII-classed event without a <code>subjectId</code> doesn't either.",
    stops: "ID confusion, silent allows, unclassified personal data."
  },
  {
    when: "Bound",
    title: "The shortcut is told apart from the sanctioned path",
    body: "Most guardrails fail loud. The layer rules are the ones that fail <em>silently</em> — a raw <code>SELECT</code> against an engine's private table returns the right rows, the test passes, and nothing tells you that engine can now never ship a migration. <code>boundary-lint</code> is the only thing that can see it.",
    stops: "Raw DB access, cross-module reads, forged audit rows, ambient secrets."
  },
  {
    when: "Derive",
    title: "What can be derived is never generated",
    body: "Wherever an artifact can be <em>derived</em>, it is derived by code, not by a model. Entities are declared once; the DDL, the API surface, the browser client and the permission table are emitted from that declaration, and CI re-emits each and fails on drift. Code generated by code beats code generated by a model on tokens, latency and exactness at once.",
    stops: "Hand-edits to shipped SQL, drifted clients, a widened role merging unseen."
  },
  {
    when: "Judge",
    title: "The build may not edit its own oracle",
    body: "Models fail quietly and inconsistently rather than loudly, and you cannot prompt that away — so the architecture has to catch it. Every defect worth catching is two descriptions disagreeing. Once the code is derived from the model it can no longer contradict it, so the second description has to come from somewhere else entirely.",
    stops: "A suite that ratifies a wrong model perfectly and forever."
  },
  {
    when: "Review",
    title: "Two things an agent never self-approves",
    body: "Schema migrations and permission definitions stay under human review even in a fully agent-driven shop. Both are read as a diff, and CI re-emits the artifact and fails on drift — which is what makes the reading unskippable. The red build is not the approval; it is what stops the approval being skipped.",
    stops: "A destructive migration or a quietly widened role reaching main."
  },
  {
    when: "Rehearse",
    title: "A running copy of production to be wrong in",
    body: "Reviewing a migration diff is a checkpoint. Watching that migration run against a copy of the real data is what makes the checkpoint honest. Crossing a migration-digest boundary snapshots the prior state first — the digest comparison is the gate, not a flag someone remembers to pass.",
    stops: "Version 2 landing on version 1's live data."
  }
];
const _sfc_main = /* @__PURE__ */ defineComponent({
  __name: "GuardPath",
  __ssrInlineRender: true,
  setup(__props) {
    return (_ctx, _push, _parent, _attrs) => {
      _push(`<ol${ssrRenderAttrs(mergeProps({ class: "path" }, _attrs))} data-v-09497dac><!--[-->`);
      ssrRenderList(unref(guards), (g, i) => {
        _push(`<li class="guard" data-v-09497dac><div class="stage" data-v-09497dac><span class="num" data-v-09497dac>${ssrInterpolate(String(i + 1).padStart(2, "0"))}</span><span class="when" data-v-09497dac>${ssrInterpolate(g.when)}</span></div><div class="body" data-v-09497dac><h3 data-v-09497dac>${ssrInterpolate(g.title)}</h3><p class="prose" data-v-09497dac>${g.body ?? ""}</p><p class="stops" data-v-09497dac><b data-v-09497dac>Stops</b><span data-v-09497dac>${ssrInterpolate(g.stops)}</span></p></div></li>`);
      });
      _push(`<!--]--></ol>`);
    };
  }
});
const _sfc_setup = _sfc_main.setup;
_sfc_main.setup = (props, ctx) => {
  const ssrContext = useSSRContext();
  (ssrContext.modules || (ssrContext.modules = /* @__PURE__ */ new Set())).add(".vitepress/theme/components/GuardPath.vue");
  return _sfc_setup ? _sfc_setup(props, ctx) : void 0;
};
const GuardPath = /* @__PURE__ */ _export_sfc(_sfc_main, [["__scopeId", "data-v-09497dac"]]);
const RawTheme = {
  extends: theme,
  enhanceApp({ app }) {
    app.component("Marketing", Marketing);
    app.component("LayerStack", LayerStack);
    app.component("RuntimeTopology", RuntimeTopology);
    app.component("PermissionPipeline", PermissionPipeline);
    app.component("InstanceResolution", InstanceResolution);
    app.component("TenancyTree", TenancyTree);
    app.component("ReadPaths", ReadPaths);
    app.component("ConnectorLoop", ConnectorLoop);
    app.component("ScopeTopology", ScopeTopology);
    app.component("StateMachine", StateMachine);
    app.component("BlastRadius", BlastRadius);
    app.component("GuardPath", GuardPath);
  }
};
const ClientOnly = defineComponent({
  setup(_, { slots }) {
    const show = ref(false);
    onMounted(() => {
      show.value = true;
    });
    return () => show.value && slots.default ? slots.default() : null;
  }
});
function useCodeGroups() {
  if (inBrowser) {
    window.addEventListener("click", (e) => {
      var _a;
      const el = e.target;
      if (el.matches(".vp-code-group input")) {
        const group = (_a = el.parentElement) == null ? void 0 : _a.parentElement;
        if (!group)
          return;
        const i = Array.from(group.querySelectorAll("input")).indexOf(el);
        if (i < 0)
          return;
        const blocks = group.querySelector(".blocks");
        if (!blocks)
          return;
        const current = Array.from(blocks.children).find((child) => child.classList.contains("active"));
        if (!current)
          return;
        const next = blocks.children[i];
        if (!next || current === next)
          return;
        current.classList.remove("active");
        next.classList.add("active");
        const label = group == null ? void 0 : group.querySelector(`label[for="${el.id}"]`);
        label == null ? void 0 : label.scrollIntoView({ block: "nearest" });
      }
    });
  }
}
function useCopyCode() {
  if (inBrowser) {
    const timeoutIdMap = /* @__PURE__ */ new WeakMap();
    window.addEventListener("click", (e) => {
      var _a;
      const el = e.target;
      if (el.matches('div[class*="language-"] > button.copy')) {
        const parent = el.parentElement;
        const sibling = (_a = el.nextElementSibling) == null ? void 0 : _a.nextElementSibling;
        if (!parent || !sibling) {
          return;
        }
        const isShell = /language-(shellscript|shell|bash|sh|zsh)/.test(parent.className);
        const ignoredNodes = [".vp-copy-ignore", ".diff.remove"];
        const clone = sibling.cloneNode(true);
        clone.querySelectorAll(ignoredNodes.join(",")).forEach((node) => node.remove());
        let text = clone.textContent || "";
        if (isShell) {
          text = text.replace(/^ *(\$|>) /gm, "").trim();
        }
        copyToClipboard(text).then(() => {
          el.classList.add("copied");
          clearTimeout(timeoutIdMap.get(el));
          const timeoutId = setTimeout(() => {
            el.classList.remove("copied");
            el.blur();
            timeoutIdMap.delete(el);
          }, 2e3);
          timeoutIdMap.set(el, timeoutId);
        });
      }
    });
  }
}
async function copyToClipboard(text) {
  try {
    return navigator.clipboard.writeText(text);
  } catch {
    const element = document.createElement("textarea");
    const previouslyFocusedElement = document.activeElement;
    element.value = text;
    element.setAttribute("readonly", "");
    element.style.contain = "strict";
    element.style.position = "absolute";
    element.style.left = "-9999px";
    element.style.fontSize = "12pt";
    const selection = document.getSelection();
    const originalRange = selection ? selection.rangeCount > 0 && selection.getRangeAt(0) : null;
    document.body.appendChild(element);
    element.select();
    element.selectionStart = 0;
    element.selectionEnd = text.length;
    document.execCommand("copy");
    document.body.removeChild(element);
    if (originalRange) {
      selection.removeAllRanges();
      selection.addRange(originalRange);
    }
    if (previouslyFocusedElement) {
      previouslyFocusedElement.focus();
    }
  }
}
function useUpdateHead(route, siteDataByRouteRef) {
  let isFirstUpdate = true;
  let managedHeadElements = [];
  const updateHeadTags = (newTags) => {
    if (isFirstUpdate) {
      isFirstUpdate = false;
      newTags.forEach((tag) => {
        const headEl = createHeadElement(tag);
        for (const el of document.head.children) {
          if (el.isEqualNode(headEl)) {
            managedHeadElements.push(el);
            return;
          }
        }
      });
      return;
    }
    const newElements = newTags.map(createHeadElement);
    managedHeadElements.forEach((oldEl, oldIndex) => {
      const matchedIndex = newElements.findIndex((newEl) => newEl == null ? void 0 : newEl.isEqualNode(oldEl ?? null));
      if (matchedIndex !== -1) {
        delete newElements[matchedIndex];
      } else {
        oldEl == null ? void 0 : oldEl.remove();
        delete managedHeadElements[oldIndex];
      }
    });
    newElements.forEach((el) => el && document.head.appendChild(el));
    managedHeadElements = [...managedHeadElements, ...newElements].filter(Boolean);
  };
  watchEffect(() => {
    const pageData = route.data;
    const siteData2 = siteDataByRouteRef.value;
    const pageDescription = pageData && pageData.description;
    const frontmatterHead = pageData && pageData.frontmatter.head || [];
    const title = createTitle(siteData2, pageData);
    if (title !== document.title) {
      document.title = title;
    }
    const description = pageDescription || siteData2.description;
    let metaDescriptionElement = document.querySelector(`meta[name=description]`);
    if (metaDescriptionElement) {
      if (metaDescriptionElement.getAttribute("content") !== description) {
        metaDescriptionElement.setAttribute("content", description);
      }
    } else {
      createHeadElement(["meta", { name: "description", content: description }]);
    }
    updateHeadTags(mergeHead(siteData2.head, filterOutHeadDescription(frontmatterHead)));
  });
}
function createHeadElement([tag, attrs, innerHTML]) {
  const el = document.createElement(tag);
  for (const key in attrs) {
    el.setAttribute(key, attrs[key]);
  }
  if (innerHTML) {
    el.innerHTML = innerHTML;
  }
  if (tag === "script" && attrs.async == null) {
    el.async = false;
  }
  return el;
}
function isMetaDescription(headConfig) {
  return headConfig[0] === "meta" && headConfig[1] && headConfig[1].name === "description";
}
function filterOutHeadDescription(head) {
  return head.filter((h2) => !isMetaDescription(h2));
}
const hasFetched = /* @__PURE__ */ new Set();
const createLink = () => document.createElement("link");
const viaDOM = (url) => {
  const link2 = createLink();
  link2.rel = `prefetch`;
  link2.href = url;
  document.head.appendChild(link2);
};
const viaXHR = (url) => {
  const req = new XMLHttpRequest();
  req.open("GET", url, req.withCredentials = true);
  req.send();
};
let link;
const doFetch = inBrowser && (link = createLink()) && link.relList && link.relList.supports && link.relList.supports("prefetch") ? viaDOM : viaXHR;
function usePrefetch() {
  if (!inBrowser) {
    return;
  }
  if (!window.IntersectionObserver) {
    return;
  }
  let conn;
  if ((conn = navigator.connection) && (conn.saveData || /2g/.test(conn.effectiveType))) {
    return;
  }
  const rIC = window.requestIdleCallback || setTimeout;
  let observer = null;
  const observeLinks = () => {
    if (observer) {
      observer.disconnect();
    }
    observer = new IntersectionObserver((entries) => {
      entries.forEach((entry) => {
        if (entry.isIntersecting) {
          const link2 = entry.target;
          observer.unobserve(link2);
          const { pathname } = link2;
          if (!hasFetched.has(pathname)) {
            hasFetched.add(pathname);
            const pageChunkPath = pathToFile(pathname);
            if (pageChunkPath)
              doFetch(pageChunkPath);
          }
        }
      });
    });
    rIC(() => {
      document.querySelectorAll("#app a").forEach((link2) => {
        const { hostname, pathname } = new URL(link2.href instanceof SVGAnimatedString ? link2.href.animVal : link2.href, link2.baseURI);
        const extMatch = pathname.match(/\.\w+$/);
        if (extMatch && extMatch[0] !== ".html") {
          return;
        }
        if (
          // only prefetch same tab navigation, since a new tab will load
          // the lean js chunk instead.
          link2.target !== "_blank" && // only prefetch inbound links
          hostname === location.hostname
        ) {
          if (pathname !== location.pathname) {
            observer.observe(link2);
          } else {
            hasFetched.add(pathname);
          }
        }
      });
    });
  };
  onMounted(observeLinks);
  const route = useRoute();
  watch(() => route.path, observeLinks);
  onUnmounted(() => {
    observer && observer.disconnect();
  });
}
function resolveThemeExtends(theme2) {
  if (theme2.extends) {
    const base = resolveThemeExtends(theme2.extends);
    return {
      ...base,
      ...theme2,
      async enhanceApp(ctx) {
        if (base.enhanceApp)
          await base.enhanceApp(ctx);
        if (theme2.enhanceApp)
          await theme2.enhanceApp(ctx);
      }
    };
  }
  return theme2;
}
const Theme = resolveThemeExtends(RawTheme);
const VitePressApp = defineComponent({
  name: "VitePressApp",
  setup() {
    const { site, lang, dir } = useData$1();
    onMounted(() => {
      watchEffect(() => {
        document.documentElement.lang = lang.value;
        document.documentElement.dir = dir.value;
      });
    });
    if (site.value.router.prefetchLinks) {
      usePrefetch();
    }
    useCopyCode();
    useCodeGroups();
    if (Theme.setup)
      Theme.setup();
    return () => h(Theme.Layout);
  }
});
async function createApp() {
  globalThis.__VITEPRESS__ = true;
  const router = newRouter();
  const app = newApp();
  app.provide(RouterSymbol, router);
  const data = initData(router.route);
  app.provide(dataSymbol, data);
  app.component("Mermaid", _sfc_main$1h);
  app.component("Content", Content);
  app.component("ClientOnly", ClientOnly);
  Object.defineProperties(app.config.globalProperties, {
    $frontmatter: {
      get() {
        return data.frontmatter.value;
      }
    },
    $params: {
      get() {
        return data.page.value.params;
      }
    }
  });
  if (Theme.enhanceApp) {
    await Theme.enhanceApp({
      app,
      router,
      siteData: siteDataRef
    });
  }
  return { app, router, data };
}
function newApp() {
  return createSSRApp(VitePressApp);
}
function newRouter() {
  let isInitialPageLoad = inBrowser;
  return createRouter((path) => {
    let pageFilePath = pathToFile(path);
    let pageModule = null;
    if (pageFilePath) {
      if (isInitialPageLoad) {
        pageFilePath = pageFilePath.replace(/\.js$/, ".lean.js");
      }
      if (false) ;
      else {
        pageModule = import(
          /*@vite-ignore*/
          pageFilePath
        );
      }
    }
    if (inBrowser) {
      isInitialPageLoad = false;
    }
    return pageModule;
  }, Theme.NotFound);
}
if (inBrowser) {
  createApp().then(({ app, router, data }) => {
    router.go().then(() => {
      useUpdateHead(router.route, data.site);
      app.mount("#app");
    });
  });
}
async function render(path) {
  const { app, router } = await createApp();
  await router.go(path);
  const ctx = { content: "", vpSocialIcons: /* @__PURE__ */ new Set() };
  ctx.content = await renderToString(app, ctx);
  return ctx;
}
export {
  tryOnScopeDispose as a,
  useData as b,
  computedAsync as c,
  useSessionStorage as d,
  useLocalStorage as e,
  useRouter as f,
  createSearchTranslate as g,
  useEventListener as h,
  useScrollLock as i,
  dataSymbol as j,
  inBrowser as k,
  escapeRegExp as l,
  notNullish as n,
  onKeyStroke as o,
  pathToFile as p,
  render,
  toArray as t,
  unrefElement as u,
  watchDebounced as w
};
