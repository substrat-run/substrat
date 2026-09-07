---
# The marketing landing page. `layout: page` gives the shared VitePress nav +
# footer with a blank content area; the component below fills it. Component and
# copy live in .vitepress/theme/components/Marketing.vue.
#
# The `desk` attribute is not decoration. `headers.mts` derives the CSP by reading
# `desk="…"` out of the markdown the site is built from, so the beta form's origin
# reaches `connect-src` BECAUSE it is written here. Hard-coded inside the component
# it would be invisible to the policy, and the form would fail in the browser on
# production alone, with every build green.
layout: page
title: Substrat — the hard parts, hosted
aside: false
---

<Marketing desk="https://ticket0.substrat.net" />
