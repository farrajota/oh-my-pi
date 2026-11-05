/**
 * Whether a file or directory mode shows no group or other access. On Windows, Node synthesizes modes such as
 * 0o666 from the read-only attribute, so POSIX permission bits say nothing about access there; privacy relies on
 * the per-user profile directory ACLs and the check passes. Elsewhere any group or other bit is refused.
 */
export function hasPrivateMode(mode: number | bigint, platform: NodeJS.Platform = process.platform): boolean {
	if (platform === "win32") return true;
	return (BigInt(mode) & 0o077n) === 0n;
}
