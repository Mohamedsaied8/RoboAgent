/*---------------------------------------------------------------------------------------------
 *  Copyright (c) RoboAgent. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/*---------------------------------------------------------------------------------------------
 *  GDB/MI output syntax (GDB manual, "GDB/MI Output Syntax"):
 *    output   → ( out-of-band-record )* [ result-record ] "(gdb)"
 *    result   → [token] "^" class ( "," variable "=" value )*
 *    async    → [token] ( "*" | "+" | "=" ) class ( "," variable "=" value )*
 *    stream   → ( "~" | "@" | "&" ) c-string
 *    value    → c-string | tuple "{…}" | list "[…]"
 *  Lists may hold values or results (`stack=[frame={…},frame={…}]`); results inside a list are
 *  kept as values (the names repeat). Unknown or malformed lines are returned as `unknown`, never thrown.
 *--------------------------------------------------------------------------------------------*/

export type MiValue = string | MiTuple | MiValue[];
export interface MiTuple {
	readonly [name: string]: MiValue;
}

export type MiRecord =
	| { readonly kind: 'result'; readonly token?: number; readonly resultClass: string; readonly results: MiTuple }
	| { readonly kind: 'exec' | 'status' | 'notify'; readonly token?: number; readonly asyncClass: string; readonly results: MiTuple }
	| { readonly kind: 'console' | 'target' | 'log'; readonly text: string }
	| { readonly kind: 'prompt' }
	| { readonly kind: 'unknown'; readonly line: string };

class MiSyntaxError extends Error { }

/** Longest line the parser accepts (a 4 KB memory read is ~8 KB of hex; register dumps are smaller). */
const MAX_LINE = 4 * 1024 * 1024;
const MAX_DEPTH = 64;

const utf8 = new TextDecoder('utf-8');

class Cursor {
	i = 0;
	constructor(readonly s: string) { }

	peek(): string {
		return this.s[this.i];
	}

	expect(ch: string): void {
		if (this.s[this.i] !== ch) {
			throw new MiSyntaxError(`expected "${ch}" at ${this.i}`);
		}
		this.i++;
	}

	/** A C string: `"…"` with \n \t \r \" \\ \e and octal escapes; octal bytes are decoded as UTF-8. */
	cString(): string {
		this.expect('"');
		const bytes: number[] = [];
		const pushText = (text: string) => {
			for (const b of new TextEncoder().encode(text)) {
				bytes.push(b);
			}
		};
		let start = this.i;
		for (; ;) {
			if (this.i >= this.s.length) {
				throw new MiSyntaxError('unterminated string');
			}
			const ch = this.s[this.i];
			if (ch === '"') {
				pushText(this.s.slice(start, this.i));
				this.i++;
				return utf8.decode(new Uint8Array(bytes));
			}
			if (ch !== '\\') {
				this.i++;
				continue;
			}
			pushText(this.s.slice(start, this.i));
			const next = this.s[this.i + 1];
			const octal = /^[0-7]{1,3}/.exec(this.s.slice(this.i + 1, this.i + 4));
			if (octal) {
				bytes.push(parseInt(octal[0], 8) & 0xFF);
				this.i += 1 + octal[0].length;
			} else {
				const map: Record<string, string> = { n: '\n', t: '\t', r: '\r', e: '\x1b', a: '\x07', b: '\b', f: '\f', v: '\v' };
				pushText(map[next] ?? next ?? '');
				this.i += 2;
			}
			start = this.i;
		}
	}

	variable(): string {
		const m = /^[A-Za-z_][\w-]*/.exec(this.s.slice(this.i, this.i + 128));
		if (!m) {
			throw new MiSyntaxError(`expected a name at ${this.i}`);
		}
		this.i += m[0].length;
		return m[0];
	}

	value(depth: number): MiValue {
		if (depth > MAX_DEPTH) {
			throw new MiSyntaxError('nesting too deep');
		}
		const ch = this.peek();
		if (ch === '"') {
			return this.cString();
		}
		if (ch === '{') {
			this.i++;
			const tuple = this.results('}', depth + 1);
			this.expect('}');
			return tuple;
		}
		if (ch === '[') {
			this.i++;
			const list: MiValue[] = [];
			while (this.peek() !== ']') {
				if (list.length) {
					this.expect(',');
				}
				const c = this.peek();
				if (c === '"' || c === '{' || c === '[') {
					list.push(this.value(depth + 1));
				} else {
					this.variable();
					this.expect('=');
					list.push(this.value(depth + 1));
				}
			}
			this.expect(']');
			return list;
		}
		throw new MiSyntaxError(`unexpected "${ch ?? 'end of line'}" at ${this.i}`);
	}

	/** `name=value,…` up to `end` (or the end of the line). Repeated names become a list. */
	results(end: string | undefined, depth: number): MiTuple {
		const out: Record<string, MiValue> = Object.create(null);
		const repeated = new Set<string>();
		let first = true;
		while (this.i < this.s.length && this.peek() !== end) {
			if (!first || (end === undefined && this.peek() === ',')) {
				this.expect(',');
			}
			first = false;
			const name = this.variable();
			this.expect('=');
			const value = this.value(depth);
			if (repeated.has(name)) {
				(out[name] as MiValue[]).push(value);
			} else if (out[name] !== undefined) {
				// e.g. a breakpoint with several locations: `bkpt={…},bkpt={…}`
				repeated.add(name);
				out[name] = [out[name], value];
			} else {
				out[name] = value;
			}
		}
		return out;
	}
}

/** Parses one line of GDB/MI output (without the newline). */
export function parseMiLine(line: string): MiRecord {
	const text = line.replace(/\r$/, '');
	if (/^\(gdb\)\s*$/.test(text)) {
		return { kind: 'prompt' };
	}
	if (text.length > MAX_LINE) {
		return { kind: 'unknown', line: `${text.slice(0, 200)}…` };
	}
	try {
		const streamKind = text[0] === '~' ? 'console' : text[0] === '@' ? 'target' : text[0] === '&' ? 'log' : undefined;
		if (streamKind) {
			const c = new Cursor(text);
			c.i = 1;
			return { kind: streamKind, text: c.cString() };
		}
		const m = /^(\d*)([\^*+=])([a-zA-Z][\w-]*)/.exec(text);
		if (!m) {
			return { kind: 'unknown', line: text };
		}
		const c = new Cursor(text);
		c.i = m[0].length;
		const results = c.results(undefined, 0);
		if (c.i !== text.length) {
			return { kind: 'unknown', line: text };
		}
		const token = m[1] ? Number(m[1]) : undefined;
		const base = token !== undefined && Number.isSafeInteger(token) ? { token } : {};
		if (m[2] === '^') {
			return { kind: 'result', ...base, resultClass: m[3], results };
		}
		const kind = m[2] === '*' ? 'exec' : m[2] === '+' ? 'status' : 'notify';
		return { kind, ...base, asyncClass: m[3], results };
	} catch (err) {
		if (err instanceof MiSyntaxError) {
			return { kind: 'unknown', line: text };
		}
		throw err;
	}
}

/** `value` when it is a string. */
export function miString(value: MiValue | undefined): string | undefined {
	return typeof value === 'string' ? value : undefined;
}

/** `value` when it is a tuple. */
export function miTuple(value: MiValue | undefined): MiTuple | undefined {
	return value !== undefined && typeof value === 'object' && !Array.isArray(value) ? value as MiTuple : undefined;
}

/** `value` as a list (a single value becomes a one-element list). */
export function miList(value: MiValue | undefined): MiValue[] {
	return value === undefined ? [] : Array.isArray(value) ? value : [value];
}

/**
 * Quotes a string as an MI C-string argument. Control characters are refused: a newline would
 * end the command and start another one (command injection).
 */
export function miQuote(value: string): string {
	if (/[\x00-\x1f\x7f]/.test(value)) {
		throw new Error('control characters are not allowed in debugger arguments');
	}
	return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}
