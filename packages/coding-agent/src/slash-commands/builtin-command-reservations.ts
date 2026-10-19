/**
 * Shares the registry-derived reserved names without making extension command
 * discovery import the full builtin registry and its lifecycle dependencies.
 */
export const builtinCommandReservations: { names: ReadonlySet<string> } = {
	names: new Set<string>(),
};
