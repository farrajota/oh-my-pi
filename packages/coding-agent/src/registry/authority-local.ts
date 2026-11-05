import type { AuthorityStore, LocalClaim } from "./authority/types";
import type { DurableLocalBackingExpectation, DurableLocalPublishResult } from "./durable-state";
import { withAuthorityEffect } from "./authority/client";

const GENESIS_HASH = "0".repeat(64);

/** Async local:// publication coordinator backed by the root's common authority store. */
export class DurableLocalState {
	readonly #store: AuthorityStore;
	readonly #localId: string;

	constructor(store: AuthorityStore, localId: string) {
		if (!localId.trim()) throw new Error("Local id is required.");
		if (localId !== store.identity.owningSessionId) {
			throw new Error("Durable local state id must match its owning root session.");
		}
		this.#store = store;
		this.#localId = localId;
	}

	/** Bind child-local access to the exact root authority store. */
	isOwnedBy(store: AuthorityStore): boolean {
		return this.#store === store;
	}

	async current(): Promise<DurableLocalPublishResult | null> {
		const backing = await this.#store.localBacking(this.#localId);
		return backing ? Object.freeze({ version: backing.version, headHash: backing.headHash }) : null;
	}

	/**
	 * Reserve the exact predecessor before validating backing bytes or invoking the
	 * write callback. An uncertain callback never releases that unique claim.
	 */
	async publishWithEffect<T>(
		entryId: string,
		entryHash: string,
		expectedHeadHash: string,
		effect: () => Promise<T>,
		validateBacking?: (expectation: DurableLocalBackingExpectation) => boolean | Promise<boolean>,
	): Promise<T> {
		return withAuthorityEffect(this.#store, async () => {
			const claim = await this.#store.reserveLocal({
				localId: this.#localId,
				entryId,
				entryHash,
				expectedHeadHash,
			});

			const backing = await this.#store.localBacking(this.#localId);
			if (claim.previousHeadHash !== GENESIS_HASH) {
				let validationError: unknown;
				if (!backing || backing.headHash !== claim.previousHeadHash) {
					validationError = new Error(
						"local:// committed backing metadata does not match the reserved predecessor.",
					);
				} else if (!validateBacking) {
					validationError = new Error("local:// committed backing bytes require validation before publication.");
				} else {
					try {
						if (!(await validateBacking(backing)))
							validationError = new Error("local:// backing bytes do not match the committed durable head.");
					} catch (error) {
						validationError = error;
					}
				}
				if (validationError) {
					const detail = validationError instanceof Error ? validationError.message : String(validationError);
					await this.#store.quarantine(`Recovered local:// backing validation failed: ${detail}`);
				}
			}

			await this.#store.authorizeLocalEffect(claim);
			const effectClaim: LocalClaim = { ...claim, phase: "effect" };
			let value: T;
			try {
				value = await effect();
			} catch (effectError) {
				try {
					await this.#store.finalizeLocal(effectClaim, "uncertain");
				} catch (finalizeError) {
					throw new AggregateError(
						[effectError, finalizeError],
						"local:// write and uncertain-claim finalization both failed.",
					);
				}
				throw effectError;
			}

			await this.#store.finalizeLocal(effectClaim, "committed");
			return value;
		});
	}
}
