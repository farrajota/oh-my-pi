import * as fs from "node:fs";
import * as path from "node:path";

/**
 * The one canonical form of a session transcript path for authority purposes: both the `authorityRoot` header stamp
 * and every ownership, adoption and relocation check use it, so a stamp and a later check can never disagree because
 * they canonicalized differently.
 *
 * It resolves through the native realpath (realpath(3); GetFinalPathNameByHandle on Windows), not Node's JS walk:
 * the native call maps subst and mapped network drives to their target and returns the on-disk case on
 * case-insensitive macOS volumes, where a JS walk keeps whatever spelling the caller used. The deepest existing
 * ancestor is resolved and the missing rest appended, so a stamp written before its directory exists equals the
 * canonical path once it does.
 */
export function canonicalAuthorityPathSync(file: string): string {
	const absolute = path.resolve(file);
	const missing: string[] = [];
	let current = absolute;
	for (;;) {
		try {
			return path.join(fs.realpathSync.native(current), ...missing.reverse());
		} catch (error) {
			const parent = path.dirname(current);
			if ((error as NodeJS.ErrnoException).code !== "ENOENT" || parent === current) throw error;
			missing.push(path.basename(current));
			current = parent;
		}
	}
}
