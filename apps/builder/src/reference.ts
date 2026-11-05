/**
 * The reference verticals every host hands the generator (`GeneratorInput.references`),
 * relative to the platform checkout. Both are compiled against the workspace on
 * every PR — the template by #878's template-check, todo as a workspace member —
 * so copying from them cannot teach an API that no longer exists: the failure
 * skill prose has, and the reason these are code and not a skill.
 *
 * - `template` — the create-substrat template: the harness (host, seed,
 *   provisioning, server, routes, personas).
 * - `todo` — the model-first reference vertical: concept → model → module, with
 *   per-list sharing (join, ctx.link to the owner, ctx.grant/ctx.revoke).
 */
export const REFERENCE_DIRS = {
	template: 'packages/create-substrat/template',
	todo: 'demos/todo',
} as const;
