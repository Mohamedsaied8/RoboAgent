/*---------------------------------------------------------------------------------------------
 *  Copyright (c) RoboAgent. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

export interface SizeEntry {
	readonly text: number;
	readonly data: number;
	readonly bss: number;
	readonly file: string;
}

export interface SizeReport {
	/** One row per ELF (or per object, for a static library). */
	readonly entries: readonly SizeEntry[];
	/** Flash used: `.text` + `.data` (initialised data is stored in flash and copied to RAM). */
	readonly flashBytes: number;
	/** Static RAM used: `.data` + `.bss` (stack and heap come on top). */
	readonly ramBytes: number;
	readonly flashPercent?: number;
	readonly ramPercent?: number;
	readonly flashTotalBytes?: number;
	readonly ramTotalBytes?: number;
}

/**
 * Parses Berkeley-format `size` output:
 * ```
 *    text    data     bss     dec     hex filename
 *     424       8    1568    2000     7d0 app.elf
 * ```
 * For a static library `size` prints one row per member, `... (ex libfoo.a)`.
 */
export function parseBerkeleySize(output: string): SizeEntry[] {
	const entries: SizeEntry[] = [];
	for (const raw of output.split(/\r?\n/)) {
		// Trim in code and cap the length: `(.+?)\s*$` on a long whitespace run is quadratic.
		const line = raw.slice(0, 4096).trim();
		const m = /^(\d+)\s+(\d+)\s+(\d+)\s+\d+\s+[0-9a-f]+\s+(\S.*)$/i.exec(line);
		if (m) {
			entries.push({ text: Number(m[1]), data: Number(m[2]), bss: Number(m[3]), file: m[4] });
		}
	}
	return entries;
}

const pct = (used: number, total: number) => Math.round(used / total * 1000) / 10;

export function summarizeSize(entries: readonly SizeEntry[], flashKb?: number, ramKb?: number): SizeReport {
	const text = entries.reduce((s, e) => s + e.text, 0);
	const data = entries.reduce((s, e) => s + e.data, 0);
	const bss = entries.reduce((s, e) => s + e.bss, 0);
	const flashBytes = text + data;
	const ramBytes = data + bss;
	return {
		entries,
		flashBytes,
		ramBytes,
		...flashKb ? { flashTotalBytes: flashKb * 1024, flashPercent: pct(flashBytes, flashKb * 1024) } : {},
		...ramKb ? { ramTotalBytes: ramKb * 1024, ramPercent: pct(ramBytes, ramKb * 1024) } : {},
	};
}
