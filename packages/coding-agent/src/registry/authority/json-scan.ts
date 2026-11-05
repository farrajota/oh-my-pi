import * as fs from "node:fs";
import { AUTHORITY_JSONL_MAX_FRAME_LINE_BYTES } from "./jsonl-layout";

/*
 * Structure of one large JSON document stored as a single line of a file (a seeded JSONL header embeds a whole
 * export; a snapshot holds every current row; a segment index every receipt), located without parsing the line
 * whole. Only the bytes of one member or one array element are buffered at a time, so memory is bounded by the
 * largest element rather than the line. Every element a caller captures is one frame's worth of data (a row,
 * control, receipt or frame) or one legacy-v1 journal record, which readers take entry by entry from the seed's
 * `legacy.entries` because that member as a whole is the entire legacy journal. An element longer than the
 * frame-line cap is therefore refused as hostile or corrupt before it is buffered whole. Values are still parsed
 * with JSON.parse, member by member, which keeps the exact property order and number handling of parsing the whole line.
 */

/** Absolute file offsets `[start, end)` of one JSON value. */
export interface JsonRange {
	readonly start: number;
	readonly end: number;
}

const QUOTE = 0x22;
const BACKSLASH = 0x5c;
const COMMA = 0x2c;
const COLON = 0x3a;
const OPEN_OBJECT = 0x7b;
const CLOSE_OBJECT = 0x7d;
const OPEN_ARRAY = 0x5b;
const CLOSE_ARRAY = 0x5d;
const CHUNK_BYTES = 4 * 1024 * 1024;

function assertElementWithinCap(bytes: number): void {
	if (bytes > AUTHORITY_JSONL_MAX_FRAME_LINE_BYTES) {
		throw new Error(
			`Authority JSON document has an element longer than the ${AUTHORITY_JSONL_MAX_FRAME_LINE_BYTES}-byte frame-line cap; it is corrupt or hostile and is not read.`,
		);
	}
}

function isWhitespace(byte: number): boolean {
	return byte === 0x20 || byte === 0x09 || byte === 0x0a || byte === 0x0d;
}

class JsonCursor {
	readonly #fd: number;
	readonly #end: number;
	#buffer: Buffer;
	#view: Buffer;
	/** Absolute offset of `#buffer[0]`. */
	#base: number;
	/** Absolute offset of the next unread byte. */
	#position: number;
	/** Absolute offset whose bytes must stay buffered (the start of a value being captured). */
	#mark: number | undefined;

	constructor(fd: number, range: JsonRange) {
		this.#fd = fd;
		this.#end = range.end;
		this.#buffer = Buffer.allocUnsafe(Math.max(1, Math.min(CHUNK_BYTES, range.end - range.start)));
		this.#view = this.#buffer.subarray(0, 0);
		this.#base = range.start;
		this.#position = range.start;
	}

	get position(): number {
		return this.#position;
	}

	/** Buffers more bytes, keeping everything from the mark (or the position); false at the end of the range. */
	#refill(): boolean {
		if (this.#mark !== undefined) assertElementWithinCap(this.#base + this.#view.length - this.#mark);
		const keep = Math.min(this.#mark ?? this.#position, this.#position);
		const kept = this.#base + this.#view.length - keep;
		if (keep > this.#base) {
			this.#buffer.copy(this.#buffer, 0, keep - this.#base, this.#view.length);
			this.#base = keep;
		}
		if (kept === this.#buffer.length) {
			const grown = Buffer.allocUnsafe(this.#buffer.length * 2);
			this.#buffer.copy(grown, 0, 0, kept);
			this.#buffer = grown;
		}
		const wanted = Math.min(this.#buffer.length - kept, this.#end - (this.#base + kept));
		if (wanted <= 0) {
			this.#view = this.#buffer.subarray(0, kept);
			return false;
		}
		let read = 0;
		while (read < wanted) {
			const count = fs.readSync(this.#fd, this.#buffer, kept + read, wanted - read, this.#base + kept + read);
			if (count <= 0) throw new Error("Authority JSON document ended before its recorded length.");
			read += count;
		}
		this.#view = this.#buffer.subarray(0, kept + read);
		return true;
	}

	/** The byte at the position, or -1 at the end of the range. */
	peek(): number {
		if (this.#position - this.#base >= this.#view.length && !this.#refill()) return -1;
		return this.#view[this.#position - this.#base]!;
	}

	skipWhitespace(): void {
		for (;;) {
			const byte = this.peek();
			if (byte === -1 || !isWhitespace(byte)) return;
			this.#position++;
		}
	}

	expect(byte: number, what: string): void {
		this.skipWhitespace();
		if (this.peek() !== byte) throw new Error(`Authority JSON document is malformed: expected ${what}.`);
		this.#position++;
	}

	/** After an opening quote: moves past the closing quote, honouring escapes. */
	#skipStringBody(): void {
		let relative = this.#position - this.#base;
		for (;;) {
			const view = this.#view;
			const quote = view.indexOf(QUOTE, relative);
			const limit = quote < 0 ? view.length : quote;
			const escape = limit > relative ? view.subarray(relative, limit).indexOf(BACKSLASH) : -1;
			if (escape >= 0) {
				const at = relative + escape;
				if (at + 1 < view.length) {
					relative = at + 2;
					continue;
				}
				this.#position = this.#base + at;
				if (!this.#refill()) throw new Error("Authority JSON document ends inside a string.");
				relative = this.#position - this.#base + 2;
				continue;
			}
			if (quote >= 0) {
				this.#position = this.#base + quote + 1;
				return;
			}
			this.#position = this.#base + view.length;
			if (!this.#refill()) throw new Error("Authority JSON document ends inside a string.");
			relative = this.#position - this.#base;
		}
	}

	/** Moves past one complete value (after leading whitespace) and returns its range. */
	skipValue(): JsonRange {
		this.skipWhitespace();
		const start = this.#position;
		const first = this.peek();
		if (first === -1) throw new Error("Authority JSON document is missing a value.");
		if (first === QUOTE) {
			this.#position++;
			this.#skipStringBody();
		} else if (first === OPEN_OBJECT || first === OPEN_ARRAY) {
			let depth = 0;
			for (;;) {
				const view = this.#view;
				let index = this.#position - this.#base;
				let closed = false;
				let atQuote = false;
				while (index < view.length) {
					const byte = view[index]!;
					if (byte === QUOTE) {
						atQuote = true;
						break;
					}
					if (byte === OPEN_OBJECT || byte === OPEN_ARRAY) depth++;
					else if ((byte === CLOSE_OBJECT || byte === CLOSE_ARRAY) && --depth === 0) {
						index++;
						closed = true;
						break;
					}
					index++;
				}
				this.#position = this.#base + index;
				if (closed) break;
				if (atQuote) {
					this.#position++;
					this.#skipStringBody();
					continue;
				}
				if (!this.#refill()) throw new Error("Authority JSON document ends inside a value.");
			}
		} else {
			for (;;) {
				const byte = this.peek();
				if (byte === -1 || byte === COMMA || byte === CLOSE_OBJECT || byte === CLOSE_ARRAY || isWhitespace(byte))
					break;
				this.#position++;
			}
			if (this.#position === start) throw new Error("Authority JSON document is malformed.");
		}
		return { start, end: this.#position };
	}

	/** Moves past one value and returns its text, buffering only that value. */
	captureValue(): string {
		this.skipWhitespace();
		this.#mark = this.#position;
		try {
			const range = this.skipValue();
			assertElementWithinCap(range.end - range.start);
			return this.#view.toString("utf8", range.start - this.#base, range.end - this.#base);
		} finally {
			this.#mark = undefined;
		}
	}

	/** Reads the separator after a member or element: true when another follows, false at the closing byte. */
	next(close: number): boolean {
		this.skipWhitespace();
		const byte = this.peek();
		if (byte === COMMA) {
			this.#position++;
			return true;
		}
		if (byte === close) {
			this.#position++;
			return false;
		}
		throw new Error("Authority JSON document is malformed: expected a separator.");
	}

	atClose(close: number): boolean {
		this.skipWhitespace();
		if (this.peek() !== close) return false;
		this.#position++;
		return true;
	}
}

function parseText(text: string): unknown {
	try {
		return JSON.parse(text);
	} catch {
		throw new Error("Authority JSON document contains an invalid value.");
	}
}

/**
 * Members of the JSON object at `range`, by name, in document order. A repeated name keeps its last value, as
 * JSON.parse does. Only ranges are recorded; values are read with `readJsonValue` or `jsonArrayElements`.
 */
export function jsonObjectMembers(fd: number, range: JsonRange): Map<string, JsonRange> {
	const cursor = new JsonCursor(fd, range);
	const members = new Map<string, JsonRange>();
	cursor.expect(OPEN_OBJECT, "an object");
	if (!cursor.atClose(CLOSE_OBJECT)) {
		do {
			cursor.skipWhitespace();
			if (cursor.peek() !== QUOTE) throw new Error("Authority JSON document is malformed: expected a member name.");
			const name = parseText(cursor.captureValue());
			if (typeof name !== "string") throw new Error("Authority JSON document is malformed: expected a member name.");
			cursor.expect(COLON, "a colon");
			const value = cursor.skipValue();
			members.delete(name);
			members.set(name, value);
		} while (cursor.next(CLOSE_OBJECT));
	}
	cursor.skipWhitespace();
	if (cursor.position !== range.end) throw new Error("Authority JSON document has trailing bytes.");
	return members;
}

/** Parses the (small) value at `range`. */
export function readJsonValue(fd: number, range: JsonRange): unknown {
	return parseText(new JsonCursor(fd, range).captureValue());
}

/** Whether the value at `range` is a JSON array (its first byte is `[`). */
export function isJsonArray(fd: number, range: JsonRange): boolean {
	const cursor = new JsonCursor(fd, range);
	cursor.skipWhitespace();
	return cursor.peek() === OPEN_ARRAY;
}

/** Whether the value at `range` is a JSON object (its first byte is `{`). */
export function isJsonObject(fd: number, range: JsonRange): boolean {
	const cursor = new JsonCursor(fd, range);
	cursor.skipWhitespace();
	return cursor.peek() === OPEN_OBJECT;
}

/** Parsed elements of the JSON array at `range`, one at a time. */
export function* jsonArrayElements(fd: number, range: JsonRange): Generator<unknown> {
	const cursor = new JsonCursor(fd, range);
	cursor.expect(OPEN_ARRAY, "an array");
	if (cursor.atClose(CLOSE_ARRAY)) return;
	do yield parseText(cursor.captureValue());
	while (cursor.next(CLOSE_ARRAY));
}

/** Offset just past the first newline at or after `from` (bounded by `length`), or -1 when there is none. */
export function lineEnd(fd: number, from: number, length: number): number {
	const chunk = Buffer.allocUnsafe(Math.max(1, Math.min(CHUNK_BYTES, length - from)));
	for (let position = from; position < length;) {
		const read = fs.readSync(fd, chunk, 0, Math.min(chunk.length, length - position), position);
		if (read <= 0) throw new Error("Authority JSONL ended before its observed length.");
		const newline = chunk.subarray(0, read).indexOf(0x0a);
		if (newline >= 0) return position + newline + 1;
		position += read;
	}
	return -1;
}
