import type { Theme } from 'vitepress';
import DefaultTheme from 'vitepress/theme';

// Geist, self-hosted. The design handoff pulled these from the Google Fonts CDN;
// Geist is SIL OFL, so we ship the files instead — no third-party request on
// every page load, and the docs render the same offline and in CI.
import '@fontsource/geist-sans/400.css';
import '@fontsource/geist-sans/500.css';
import '@fontsource/geist-sans/600.css';
import '@fontsource/geist-sans/700.css';
import '@fontsource/geist-mono/400.css';
import '@fontsource/geist-mono/500.css';
import '@fontsource/geist-mono/600.css';

// Design tokens, vendored verbatim from the handoff — the source of truth for
// every color, size and shadow below. Do not re-derive values here; edit the
// token file or take a new bundle from design. See ./tokens/README.md.
import './tokens/colors.css';
import './tokens/typography.css';
import './tokens/spacing.css';
import './tokens/effects.css';

// ...then teach VitePress to read them.
import './styles/vitepress.css';

import Marketing from './components/Marketing.vue';
import LayerStack from './components/LayerStack.vue';
import RuntimeTopology from './components/RuntimeTopology.vue';
import PermissionPipeline from './components/PermissionPipeline.vue';
import InstanceResolution from './components/InstanceResolution.vue';
import TenancyTree from './components/TenancyTree.vue';
import ReadPaths from './components/ReadPaths.vue';
import ConnectorLoop from './components/ConnectorLoop.vue';
import ScopeTopology from './components/ScopeTopology.vue';
import StateMachine from './components/StateMachine.vue';

export default {
  extends: DefaultTheme,
  enhanceApp({ app }) {
    app.component('Marketing', Marketing);
    app.component('LayerStack', LayerStack);
    app.component('RuntimeTopology', RuntimeTopology);
    app.component('PermissionPipeline', PermissionPipeline);
    app.component('InstanceResolution', InstanceResolution);
    app.component('TenancyTree', TenancyTree);
    app.component('ReadPaths', ReadPaths);
    app.component('ConnectorLoop', ConnectorLoop);
    app.component('ScopeTopology', ScopeTopology);
    app.component('StateMachine', StateMachine);
  },
} satisfies Theme;
