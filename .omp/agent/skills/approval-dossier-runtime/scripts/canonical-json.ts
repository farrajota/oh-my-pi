import { createHash } from "node:crypto";

export type JsonPrimitive = null | boolean | number | string;
export type JsonValue =
	| JsonPrimitive
	| readonly JsonValue[]
	| { readonly [key: string]: JsonValue };

export const MAX_JSON_DEPTH = 32;
export const MAX_JSON_ITEMS = 10_000;
export const MAX_CANONICAL_JSON_BYTES = 65_536;

export type CanonicalJsonLimits = Readonly<{
	maximum_bytes?: number;
	maximum_items?: number;
	maximum_depth?: number;
}>;

export class CanonicalJsonError extends TypeError {
	constructor(message: string) {
		super(message);
		this.name = "CanonicalJsonError";
	}
}

function resolvedLimits(
	limits: number | CanonicalJsonLimits,
): Readonly<{ maximumBytes: number; maximumItems: number; maximumDepth: number }> {
	const requested = typeof limits === "number" ? { maximum_bytes: limits } : limits;
	const maximumBytes = requested.maximum_bytes ?? MAX_CANONICAL_JSON_BYTES;
	const maximumItems = requested.maximum_items ?? MAX_JSON_ITEMS;
	const maximumDepth = requested.maximum_depth ?? MAX_JSON_DEPTH;
	if (![maximumBytes, maximumItems, maximumDepth].every((value) => Number.isSafeInteger(value) && value >= 0)) {
		throw new CanonicalJsonError("canonical JSON limit is invalid");
	}
	return { maximumBytes, maximumItems, maximumDepth };
}

export function canonicalizeValue(
	value: unknown,
	limits: number | CanonicalJsonLimits = MAX_CANONICAL_JSON_BYTES,
): JsonValue {
	const resolved = resolvedLimits(limits);
	const result = canonicalize(value, "$", 0, new Set<object>(), {
		items: 0,
		maximumItems: resolved.maximumItems,
		maximumDepth: resolved.maximumDepth,
	});
	if (Buffer.byteLength(JSON.stringify(result), "utf8") > resolved.maximumBytes) {
		throw new CanonicalJsonError("canonical JSON exceeds byte limit");
	}
	return result;
}

export function canonicalJson(
	value: unknown,
	limits: number | CanonicalJsonLimits = MAX_CANONICAL_JSON_BYTES,
): string {
	return JSON.stringify(canonicalizeValue(value, limits));
}

export function hashCanonicalJson(
	value: unknown,
	limits: number | CanonicalJsonLimits = MAX_CANONICAL_JSON_BYTES,
): string {
	return hashRawBytes(Buffer.from(canonicalJson(value, limits), "utf8"));
}

export function hashRawBytes(bytes: Uint8Array): string {
	return createHash("sha256").update(bytes).digest("hex");
}

function canonicalize(
	value: unknown,
	path: string,
	depth: number,
	active: Set<object>,
	state: { items: number; maximumItems: number; maximumDepth: number },
): JsonValue {
	if (depth > state.maximumDepth) throw new CanonicalJsonError(`JSON nesting exceeds limit at ${path}`);
	if (value === null || typeof value === "boolean" || typeof value === "string") return value;
	if (typeof value === "number") {
		if (!Number.isFinite(value)) throw new CanonicalJsonError(`non-finite number at ${path}`);
		return value;
	}
	if (typeof value !== "object") throw new CanonicalJsonError(`unsupported JSON value at ${path}`);
	if (active.has(value)) throw new CanonicalJsonError(`cyclic JSON value at ${path}`);
	active.add(value);
	try {
		if (Array.isArray(value)) {
			const descriptors = Object.getOwnPropertyDescriptors(value);
			const output: JsonValue[] = [];
			for (let index = 0; index < value.length; index += 1) {
				const descriptor = descriptors[String(index)];
				if (!descriptor || !("value" in descriptor)) throw new CanonicalJsonError(`sparse array or accessor at ${path}[${index}]`);
				state.items += 1;
				if (state.items > state.maximumItems) throw new CanonicalJsonError(`JSON item count exceeds limit at ${path}`);
				output.push(canonicalize(descriptor.value, `${path}[${index}]`, depth + 1, active, state));
			}
			for (const key of Reflect.ownKeys(value)) {
				if (key !== "length" && !(typeof key === "string" && /^(?:0|[1-9]\d*)$/.test(key))) {
					throw new CanonicalJsonError(`unsupported array property at ${path}`);
				}
			}
			return Object.freeze(output);
		}
		const prototype = Object.getPrototypeOf(value);
		if (prototype !== Object.prototype && prototype !== null) throw new CanonicalJsonError(`unsupported object prototype at ${path}`);
		if (Object.getOwnPropertySymbols(value).length > 0) throw new CanonicalJsonError(`symbol property at ${path}`);
		const descriptors = Object.getOwnPropertyDescriptors(value);
		const output: Record<string, JsonValue> = Object.create(null) as Record<string, JsonValue>;
		for (const key of Object.keys(descriptors).sort()) {
			const descriptor = descriptors[key];
			if (!descriptor || !("value" in descriptor) || !descriptor.enumerable) throw new CanonicalJsonError(`accessor property at ${path}.${key}`);
			state.items += 1;
			if (state.items > state.maximumItems) throw new CanonicalJsonError(`JSON item count exceeds limit at ${path}`);
			output[key] = canonicalize(descriptor.value, `${path}.${key}`, depth + 1, active, state);
		}
		return Object.freeze(output);
	} finally {
		active.delete(value);
	}
}
