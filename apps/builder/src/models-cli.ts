/**
 * `pnpm builder models [--provider qwen]` — what this endpoint actually serves.
 *
 * Exists because "Model not exist." is otherwise a dead end: the credential is
 * good, the endpoint is right, and the only missing piece is a model id you have
 * no way to enumerate.
 */
import { loadEnvFiles } from './env.js';
import { DEFAULT_MODEL, listModels, ProviderError } from './providers.js';

async function main(): Promise<number> {
	const argv = process.argv.slice(2);
	const get = (flag: string): string | undefined => {
		const i = argv.indexOf(flag);
		return i === -1 ? undefined : argv[i + 1];
	};

	const root = get('--root') ?? process.env.INIT_CWD ?? process.cwd();
	loadEnvFiles(root);

	const spec = get('--model') ?? process.env.SUBSTRAT_BUILDER_MODEL ?? DEFAULT_MODEL;
	const provider = get('--provider') ?? spec.split(':')[0] ?? 'anthropic';

	try {
		const models = await listModels(provider);
		if (!models.length) {
			process.stdout.write(`${provider}: endpoint returned no models\n`);
			return 1;
		}
		process.stdout.write(`${provider} · ${models.length} models\n`);
		for (const id of models) process.stdout.write(`  ${id}\n`);
		process.stdout.write(`\n  pnpm builder dev --model ${provider}:<id>\n`);
		return 0;
	} catch (err) {
		if (err instanceof ProviderError) {
			process.stderr.write(`${err.message}\n`);
			return 2;
		}
		throw err;
	}
}

main().then(
	(code) => process.exit(code),
	(err: unknown) => {
		process.stderr.write(`${err instanceof Error ? (err.stack ?? err.message) : String(err)}\n`);
		process.exit(2);
	},
);
