/**
 * The model picker — and the §2.1 / D-53 disclosure surface.
 *
 * Every provider row answers three questions before a model can be chosen:
 * WHO runs the inference, WHERE (as precisely as the endpoint tells us), and
 * WHAT is sent there. The data note is deliberately on every provider, not
 * buried in settings: the customer's code is the payload, and the provider is a
 * subprocessor they are entitled to see named.
 */
import { useEffect, useState } from 'react';
import { api, type ProviderEntry } from './api.js';

export function ModelPicker(props: {
	current: string;
	onPicked: (spec: string) => void;
	onClose: () => void;
}) {
	const [providers, setProviders] = useState<ProviderEntry[] | null>(null);
	const [open, setOpen] = useState<string | null>(props.current.split(':')[0] ?? null);
	const [models, setModels] = useState<Record<string, string[] | 'loading' | Error>>({});
	const [free, setFree] = useState('');
	const [error, setError] = useState<string | null>(null);

	useEffect(() => {
		void api.providers().then(setProviders, (e: Error) => setError(e.message));
	}, []);

	async function expand(p: ProviderEntry): Promise<void> {
		setOpen(open === p.name ? null : p.name);
		if (p.listable && p.credential.set && models[p.name] === undefined) {
			setModels((m) => ({ ...m, [p.name]: 'loading' }));
			try {
				const { models: list } = await api.models(p.name);
				setModels((m) => ({ ...m, [p.name]: list }));
			} catch (e) {
				setModels((m) => ({ ...m, [p.name]: e as Error }));
			}
		}
	}

	async function pick(spec: string): Promise<void> {
		setError(null);
		try {
			await api.setModel(spec);
			props.onPicked(spec);
		} catch (e) {
			setError((e as Error).message);
		}
	}

	return (
		<div className="picker-backdrop" onClick={props.onClose}>
			<div className="picker" onClick={(e) => e.stopPropagation()}>
				<h2>Choose a model</h2>
				<div className="sub">
					The provider runs inference on the session's code and chat — where it runs is part of
					the choice. Current: <code>{props.current}</code>
				</div>

				{providers === null && <div>loading…</div>}
				{providers?.map((p) => {
					const list = models[p.name];
					return (
						<div className="provider" key={p.name}>
							<div className="provider-head" onClick={() => void expand(p)}>
								<span className="vendor">{p.hosting.vendor}</span>
								<span className="loc">{p.hosting.location}</span>
								<span className="spacer" style={{ flex: 1 }} />
								{p.credential.set ? (
									<span className="badge ok">credential set</span>
								) : (
									<span className="badge bad">{p.credential.envVar} missing</span>
								)}
							</div>
							{open === p.name && (
								<div className="provider-body">
									<div className="host">endpoint: {p.hosting.host}</div>
									<div className="data-note">{p.hosting.dataNote}</div>

									{p.pair && (
										<div className="auto-pair">
											<button
												className={`${p.name}:auto` === props.current ? 'current' : ''}
												onClick={() => void pick(`${p.name}:auto`)}
											>
												auto — {p.pair.fast} <span className="role">interview</span> ·{' '}
												{p.pair.strong} <span className="role">build</span>
											</button>
											<div className="loc">
												picks per phase: the fast model asks, the strong one writes code —
												or pick a single model below to override
											</div>
										</div>
									)}

									{list === 'loading' && <div className="loc">listing models…</div>}
									{list instanceof Error && <div className="err">{list.message}</div>}
									{Array.isArray(list) && (
										<div className="model-list">
											{list.map((id) => {
												const spec = `${p.name}:${id}`;
												return (
													<button
														key={id}
														className={spec === props.current ? 'current' : ''}
														onClick={() => void pick(spec)}
													>
														{id}
													</button>
												);
											})}
										</div>
									)}
									{!p.listable && p.suggested.length > 0 && (
										<>
											<div className="loc" style={{ marginBottom: 6 }}>
												suggested (this provider has no listable catalog):
											</div>
											<div className="model-list">
												{p.suggested.map((id) => {
													const spec = `${p.name}:${id}`;
													return (
														<button
															key={id}
															className={spec === props.current ? 'current' : ''}
															onClick={() => void pick(spec)}
														>
															{id}
														</button>
													);
												})}
											</div>
										</>
									)}

									<div className="free">
										<input
											placeholder={`model id for ${p.name}…`}
											value={free}
											onChange={(e) => setFree(e.target.value)}
											onKeyDown={(e) => {
												if (e.key === 'Enter' && free.trim())
													void pick(`${p.name}:${free.trim()}`);
											}}
										/>
										<button
											className="pill"
											disabled={!free.trim()}
											onClick={() => void pick(`${p.name}:${free.trim()}`)}
										>
											use
										</button>
									</div>
								</div>
							)}
						</div>
					);
				})}
				{error && <div className="err">{error}</div>}
			</div>
		</div>
	);
}
