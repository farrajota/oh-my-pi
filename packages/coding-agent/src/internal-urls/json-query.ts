export function parseQuery(query: string): Array<string | number> {
	let input = query.trim();
	if (!input) return [];
	if (input.startsWith(".")) input = input.slice(1);
	if (!input) return [];

	const tokens: Array<string | number> = [];
	let i = 0;
	const isIdentChar = (ch: string) => /[A-Za-z0-9_-]/.test(ch);

	while (i < input.length) {
		const ch = input[i];
		if (ch === ".") {
			i++;
			continue;
		}
		if (ch === "[") {
			const closeIndex = input.indexOf("]", i + 1);
			if (closeIndex === -1) throw new Error(`Invalid query: missing ] in ${query}`);
			const raw = input.slice(i + 1, closeIndex).trim();
			if (!raw) throw new Error(`Invalid query: empty [] in ${query}`);
			const quote = raw[0];
			if ((quote === '"' || quote === "'") && raw.endsWith(quote)) {
				let inner = raw.slice(1, -1);
				inner = inner.replace(/\\(["'\\])/g, "$1");
				tokens.push(inner);
			} else if (/^\d+$/.test(raw)) {
				tokens.push(Number(raw));
			} else {
				tokens.push(raw);
			}
			i = closeIndex + 1;
			continue;
		}

		const start = i;
		while (i < input.length && isIdentChar(input[i])) i++;
		if (start === i) throw new Error(`Invalid query: unexpected token '${input[i]}' in ${query}`);
		tokens.push(input.slice(start, i));
	}

	return tokens;
}

export function applyQuery(data: unknown, query: string): unknown {
	const tokens = parseQuery(query);
	let current: unknown = data;
	for (const token of tokens) {
		if (current === null || current === undefined) return undefined;
		if (typeof token === "number") {
			if (!Array.isArray(current)) return undefined;
			current = current[token];
			continue;
		}
		if (typeof current !== "object") return undefined;
		current = (current as Record<string, unknown>)[token];
	}
	return current;
}

export function pathToQuery(urlPath: string): string {
	if (!urlPath || urlPath === "/") return "";
	const segments = urlPath.split("/").filter(Boolean);
	if (segments.length === 0) return "";

	const parts: string[] = [];
	for (const segment of segments) {
		let decoded = segment;
		try {
			decoded = decodeURIComponent(segment);
		} catch {
			decoded = segment;
		}
		const isIdentifier = /^[A-Za-z0-9_-]+$/.test(decoded);
		if (/^\d+$/.test(decoded)) parts.push(`[${decoded}]`);
		else if (isIdentifier) parts.push(`.${decoded}`);
		else {
			const escaped = decoded.replace(/\\/g, String.raw`\\`).replace(/'/g, String.raw`\'`);
			parts.push(`['${escaped}']`);
		}
	}
	return parts.join("");
}
