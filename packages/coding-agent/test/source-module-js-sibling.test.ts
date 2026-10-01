import { describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";

const srcDir = path.join(import.meta.dir, "..", "src");

describe("source module layout", () => {
	// When the package lives under a node_modules path (global git installs, the sandbox image),
	// Bun resolves an extensionless import of `foo` to `foo.js` before `foo.ts`. A text-asset
	// `foo.js` beside module `foo.ts` then shadows the module and the bundle fails with
	// "No matching export". Eval preludes avoid this by naming the module prelude-definition.ts.
	it("has no TypeScript module sharing its basename with a .js file", () => {
		const shadowed: string[] = [];
		for (const file of new Bun.Glob("**/*.ts").scanSync({ cwd: srcDir })) {
			if (file.endsWith(".d.ts")) continue;
			const jsSibling = `${file.slice(0, -".ts".length)}.js`;
			if (fs.existsSync(path.join(srcDir, jsSibling))) shadowed.push(file);
		}
		expect(shadowed).toEqual([]);
	});
});
