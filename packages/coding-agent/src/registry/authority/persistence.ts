import { JsonlAuthorityPersistence } from "./jsonl-driver";
import { SqliteAuthorityPersistence } from "./sqlite-driver";
import type { AuthorityDriverOptions, AuthorityPersistence, JournalingBackend } from "./types";

const persistenceOpeners: Record<JournalingBackend, (options: AuthorityDriverOptions) => AuthorityPersistence> = {
	jsonl: options => new JsonlAuthorityPersistence(options),
	sqlite: options => new SqliteAuthorityPersistence(options),
};

export function openAuthorityPersistence(options: AuthorityDriverOptions): AuthorityPersistence {
	return persistenceOpeners[options.identity.backend](options);
}
