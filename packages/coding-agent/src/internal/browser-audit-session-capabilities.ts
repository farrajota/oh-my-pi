export const browserAuditActivationLiveness = Symbol("browser-audit-activation-liveness");

export type BrowserAuditToolCapability = object;

const sessionOptionCapabilities = new WeakMap<object, BrowserAuditToolCapability>();

type BrowserAuditActivationCapability = {
	readonly [browserAuditActivationLiveness]?: (capability: object) => boolean;
};

export function bindBrowserAuditSessionOptions(
	options: object,
	capability: BrowserAuditToolCapability | undefined,
): void {
	if (capability === undefined) return;
	if (sessionOptionCapabilities.has(options)) throw new Error("browser_audit: session capability is already bound");
	sessionOptionCapabilities.set(options, capability);
}

/** Only live broker activations may cross a trusted clone boundary. */
export function copyBrowserAuditSessionCapability(source: object, target: object): void {
	const capability = sessionOptionCapabilities.get(source);
	if (capability === undefined) return;
	const liveCapability = capability as BrowserAuditActivationCapability;
	const isLive = liveCapability[browserAuditActivationLiveness];
	if (typeof isLive !== "function" || !isLive(capability)) return;
	if (sessionOptionCapabilities.has(target)) throw new Error("browser_audit: session capability is already bound");
	sessionOptionCapabilities.set(target, capability);
}

export function takeBrowserAuditSessionCapability(options: object): BrowserAuditToolCapability | undefined {
	const capability = sessionOptionCapabilities.get(options);
	sessionOptionCapabilities.delete(options);
	return capability;
}
