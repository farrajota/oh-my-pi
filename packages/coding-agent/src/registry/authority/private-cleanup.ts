export class AuthorityCleanupError extends AggregateError {
	readonly #history: unknown[];
	#physicalCleanup: (() => Promise<void>) | undefined;
	#callbacks: Array<{ release: () => Promise<void>; completed: boolean }> = [];
	#inFlight: Promise<void> | undefined;

	constructor(errors: readonly unknown[], message: string, cleanup: () => Promise<void>) {
		const history: unknown[] = [];
		for (const error of errors) if (!history.includes(error)) history.push(error);
		const primary = history[0];
		super(history, message, primary === undefined ? undefined : { cause: primary });
		this.#history = history;
		this.#physicalCleanup = cleanup;
		Object.defineProperty(this, "errors", { configurable: false, enumerable: false, writable: true, value: history });
		pendingOwners.add(this);
	}

	get pending(): boolean {
		return this.#physicalCleanup !== undefined || this.#callbacks.some(callback => !callback.completed);
	}

	afterCleanup(release: () => Promise<void>): void {
		if (!this.pending) throw new Error("Cannot register authority cleanup after cleanup has completed.");
		this.#callbacks.push({ release, completed: false });
		pendingOwners.add(this);
	}

	cleanup(): Promise<void> {
		if (this.#inFlight) return this.#inFlight;
		if (!this.pending) return Promise.resolve();
		const attempt = Promise.resolve().then(async () => {
			if (this.#physicalCleanup) {
				const cleanup = this.#physicalCleanup;
				try {
					await cleanup();
					if (this.#physicalCleanup === cleanup) this.#physicalCleanup = undefined;
				} catch (error) {
					this.#append(error);
					throw this;
				}
			}
			for (const callback of this.#callbacks) {
				if (callback.completed) continue;
				try {
					await callback.release();
					callback.completed = true;
				} catch (error) {
					this.#append(error);
					throw this;
				}
			}
			this.#callbacks = [];
			pendingOwners.delete(this);
		});
		const settled: Promise<void> = attempt.finally(() => {
			if (this.#inFlight === settled) this.#inFlight = undefined;
		});
		this.#inFlight = settled;
		return settled;
	}

	#append(error: unknown): void {
		if (this.#history.includes(error)) return;
		this.#history.push(error);
		Object.defineProperty(this, "errors", {
			configurable: false,
			enumerable: false,
			writable: true,
			value: this.#history,
		});
	}
}

const pendingOwners = new Set<AuthorityCleanupError>();

export async function withRetainedAuthorityCleanup<T>(run: () => Promise<T>, release: () => Promise<void>): Promise<T> {
	let result!: T;
	let operationError: unknown;
	let failed = false;
	try {
		result = await run();
	} catch (error) {
		failed = true;
		operationError = error;
	}
	if (failed && operationError instanceof AuthorityCleanupError && operationError.pending) {
		operationError.afterCleanup(release);
		throw operationError;
	}
	try {
		await release();
	} catch (releaseError) {
		const errors = failed ? [operationError, releaseError] : [releaseError];
		const owner = new AuthorityCleanupError(
			errors,
			failed ? "Authority operation and exclusion cleanup failed." : "Authority exclusion cleanup failed.",
			async () => {},
		);
		owner.afterCleanup(release);
		throw owner;
	}
	if (failed) throw operationError;
	return result;
}
