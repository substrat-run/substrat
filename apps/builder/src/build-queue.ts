/**
 * Who may build a vertical right now (#2795).
 *
 * A source build runs in a sandbox of its own (`build:<buildId>`), so two builds have
 * nothing to fight over unless they build the SAME vertical: then they write the same
 * project entry and, for a hosted repository, push to the same branch. So builds are
 * serialized per vertical and nowhere else, and a build that finds its vertical taken
 * WAITS for it rather than being refused. The refusal is what turned every overlap in a
 * workspace — another vertical's deploy, a preview, a studio turn — into a red merge
 * nobody re-ran, since nothing between the builder and a CI job retried it.
 *
 * The wait is bounded, and running out of it is the one refusal left: the caller reads
 * it as the 409 it always was, which the CLI retries.
 */

/**
 * How long a build waits for its vertical before it is refused. Short on purpose: the wait
 * and the build both happen before the caller sees a response header, and Node's `fetch`
 * (which the CLI submits with) gives up on a response with no headers after five minutes.
 * Longer contention is the CLI's to ride out, by retrying the refusal.
 */
export const BUILD_WAIT_MS = 2 * 60_000;
/** How often a waiting build looks again at a studio operation holding its project. */
export const BUILD_POLL_MS = 1_000;

/** The refusal a build gets when its wait runs out — the words the CLI retries on. */
export const BUILD_BUSY = 'project operation already in progress';

/** The wait ran out; the vertical is still being built, or worked on in the studio. */
export class BuildWaitExpired extends Error {
	constructor() {
		super(BUILD_BUSY);
	}
}

export class BuildQueue {
	#tails = new Map<string, Promise<void>>();
	readonly #building = new Set<string>();

	constructor(private readonly opts: { waitMs: number; pollMs: number } = { waitMs: BUILD_WAIT_MS, pollMs: BUILD_POLL_MS }) {}

	/** Whether a build of this vertical is running (not merely waiting). */
	building(key: string): boolean {
		return this.#building.has(key);
	}

	/**
	 * Run `fn` once every earlier build of `key` has ended and `blocked()` is false — a
	 * studio operation on the same project, which is not a build and so is not queued here.
	 */
	async run<T>(key: string, blocked: () => boolean, fn: () => Promise<T>): Promise<T> {
		const prev = this.#tails.get(key) ?? Promise.resolve();
		let release!: () => void;
		const mine = new Promise<void>((resolve) => { release = resolve; });
		// The next build waits for this one AND everything before it: a build that gives up
		// waiting releases its own place, never the place of the build it was waiting on.
		const tail = prev.then(() => mine);
		this.#tails.set(key, tail);
		// Forgotten once the whole chain has run, not when this build stops waiting: a build
		// that gives up while an earlier one runs must leave that one queued in front.
		void tail.then(() => { if (this.#tails.get(key) === tail) this.#tails.delete(key); });
		const deadline = Date.now() + this.opts.waitMs;
		try {
			if (!(await before(prev, this.opts.waitMs))) throw new BuildWaitExpired();
			while (blocked()) {
				if (Date.now() >= deadline) throw new BuildWaitExpired();
				await new Promise((resolve) => setTimeout(resolve, this.opts.pollMs));
			}
			this.#building.add(key);
			try {
				return await fn();
			} finally {
				this.#building.delete(key);
			}
		} finally {
			release();
		}
	}
}

/** Whether `p` settled within `ms`; the timer is cleared either way. */
async function before(p: Promise<void>, ms: number): Promise<boolean> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	try {
		return await Promise.race([
			p.then(() => true),
			new Promise<boolean>((resolve) => { timer = setTimeout(() => resolve(false), ms); }),
		]);
	} finally {
		if (timer !== undefined) clearTimeout(timer);
	}
}
