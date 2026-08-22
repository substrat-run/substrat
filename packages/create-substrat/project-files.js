/**
 * The generated project files — the configs a scaffold gets that are NOT in
 * `template/`, because they are computed rather than copied.
 *
 * Split out of `index.js` for one reason: `tools/template-sync.mjs` materializes
 * the template against the WORKSPACE (issue #878) and has to compile it under the
 * same configs a real scaffold gets. Two hand-kept copies of a tsconfig is the
 * drift class this repo has been bitten by repeatedly, so there is one copy and
 * both readers import it.
 *
 * `packageJson()` deliberately stays in `index.js`: it interpolates the emitted
 * pin block, and `tools/pins-emit.mts` writes that block into `index.js` by path.
 * The workspace check does not want those pins anyway — resolving `@substrat-run/*`
 * from npm is exactly what it is NOT doing.
 *
 * Dependency-free, like everything else in this package.
 */

export const TSCONFIG = `${JSON.stringify(
  {
    compilerOptions: {
      target: 'ES2022',
      module: 'NodeNext',
      moduleResolution: 'NodeNext',
      lib: ['ES2022'],
      strict: true,
      esModuleInterop: true,
      skipLibCheck: true,
      forceConsistentCasingInFileNames: true,
      noEmit: true,
      types: ['node'],
    },
    include: ['src', 'test'],
    // The worker and its Cloudflare-only stores compile against workers-types
    // under their own config (tsconfig.worker.json) — the node config must not
    // see them. `src/routes.ts` is deliberately NOT excluded: the shared route
    // table must typecheck under both, which is what keeps it host-agnostic.
    exclude: ['src/worker.ts', 'src/config-do.ts'],
  },
  null,
  2,
)}\n`;

export const VITEST_CONFIG = `import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
  },
});
`;
