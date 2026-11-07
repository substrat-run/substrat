// What the scorer counts rather than judges, kept apart so it can be run over the archive.

// The operations that emit with no permission check, in their own body or in a helper they call.
// A total cannot say this: an operation with two paths emits twice and checks once.
export function emitsUnchecked(module) {
	const helpers = new Map([...module.matchAll(/^(?:export )?(?:async )?function (\w+)[\s\S]*?^}/gm), ...module.matchAll(/^(?:export )?const (\w+) = (?:async )?\([\s\S]*?^};?$/gm)].map((m) => [m[1], m[0]]));
	const reaching = (call) => {
		const names = new Set();
		for (let grew = true; grew;) {
			grew = false;
			for (const [name, body] of helpers) {
				if (names.has(name) || !(body.includes(call) || [...names].some((n) => new RegExp(`\\b${n}\\(`).test(body)))) continue;
				names.add(name);
				grew = true;
			}
		}
		return (body) => body.includes(call) || [...names].some((n) => new RegExp(`\\b${n}\\(`).test(body));
	};
	const emits = reaching('ctx.emit('), checks = reaching('ctx.check(');
	const parts = module.split(/^\s*'([\w-]+\/[\w-]+)':\s*/m);
	const operations = parts.slice(1).flatMap((v, i, all) => (i % 2 ? [] : [[v, all[i + 1].split(/^}\)/m)[0]]]));
	return operations.filter(([, body]) => emits(body) && !checks(body)).map(([name]) => name);
}
