/*---------------------------------------------------------------------------------------------
 *  Copyright (c) RoboAgent. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

export type DiagnosticSeverity = 'error' | 'warning' | 'note';
export type DiagnosticSource = 'compiler' | 'linker' | 'cmake' | 'make' | 'tool';

export interface Diagnostic {
	readonly severity: DiagnosticSeverity;
	readonly source: DiagnosticSource;
	readonly message: string;
	readonly file?: string;
	readonly line?: number;
	readonly column?: number;
	/** Warning option, e.g. `-Wunused-variable`. */
	readonly flag?: string;
	/** Linker memory problems: region name and overflow in bytes. */
	readonly region?: string;
	readonly overflowBytes?: number;
}

/** Longer lines are cut before matching: no real diagnostic is this long, and it bounds regex work. */
const MAX_LINE = 4096;

// A file path, optionally with a Windows drive (`C:\…`, `c:/…`).
const PATH = String.raw`(?:[A-Za-z]:)?[^\s:][^:]*`;

// path:line[:col]: severity: message — a trailing `[-Wflag]` is split off in code: a lazy message
// followed by an optional group and `$` backtracks quadratically.
const COMPILER = new RegExp(String.raw`^(?<file>${PATH}):(?<line>\d+)(?::(?<col>\d+))?:\s+(?<sev>fatal error|error|warning|note):\s+(?<msg>.*)$`);
const TRAILING_FLAG = /\s\[(-W[^\]\s]+)\]$/;
// arm-none-eabi-gcc: error: …, cc1: fatal error: …, collect2.exe: error: … (driver-level, no location)
const DRIVER = /^(?:.*[\\/])?(?:[\w.+-]*-)?(?:gcc|g\+\+|cc1|cc1plus|as|collect2)(?:\.exe)?:\s+(?<sev>fatal error|error|warning):\s+(?<msg>.*)$/;
// region `FLASH' overflowed by 1234 bytes
const REGION_OVERFLOW = /region [`'"]?(?<region>[\w.]+)['"]? overflowed by (?<bytes>\d+) bytes?/;
// section `.text' will not fit in region `FLASH'
const SECTION_NOFIT = /section [`'"]?(?<section>[\w.]+)['"]? will not fit in region [`'"]?(?<region>[\w.]+)['"]?/;
// `…: path:line: undefined reference to `x'` / `…/ld: obj.o:path:line: multiple definition of `x'`
const LINKER_SYMBOL = /(?<kind>undefined reference to|multiple definition of) [`'"](?<sym>[^'"`]+)['"]/;
const LINKER_LOCATION = /(?:^|[\s:])(?<file>(?:[A-Za-z]:)?[^\s:]+):(?<line>\d+):\s*(?:undefined reference|multiple definition)/;
// …/arm-none-eabi-ld: cannot find -lfoo, c:\…\ld.exe: …
const LD_ERROR = /(?:^|[\\/])(?:[\w.-]*-)?ld(?:\.bfd|\.gold)?(?:\.exe)?:\s+(?<msg>.+)$/;
// CMake Error at file:line (cmd): / CMake Error in file: / CMake Error: message
const CMAKE_AT = new RegExp(String.raw`^CMake (?<sev>Error|Warning)(?: \(dev\))? at (?<file>${PATH}):(?<line>\d+)(?: \((?<cmd>\w+)\))?:`);
const CMAKE_IN = new RegExp(String.raw`^CMake (?<sev>Error|Warning)(?: \(dev\))? in (?<file>${PATH}):\s*$`);
const CMAKE_PLAIN = /^CMake (?<sev>Error|Warning)(?: \(dev\))?:\s*(?<msg>.*)$/;
const MAKE_ERROR = /^g?make(?:\.exe)?(?:\[\d+\])?: \*\*\* (?<msg>.+)$/;
const NOT_FOUND = /^(?:\/bin\/sh: \d+: )?(?<cmd>[\w.+-]+): (?:command )?not found$/;

/**
 * Parses GCC / GNU ld / CMake / make output into structured diagnostics, deduplicated and in
 * order. CMake errors take their message from the indented lines that follow.
 */
export function parseBuildOutput(output: string, limit = 200): Diagnostic[] {
	const lines = output.split(/\r?\n/).map(l => l.slice(0, MAX_LINE).replace(/\x1b\[[0-9;]*[A-Za-z]/g, '').trimEnd());
	const out: Diagnostic[] = [];
	const seen = new Set<string>();
	const add = (d: Diagnostic) => {
		const key = `${d.severity}|${d.file}|${d.line}|${d.column}|${d.message}`;
		if (!seen.has(key) && out.length < limit) {
			seen.add(key);
			out.push(d);
		}
	};
	/** The indented block after a CMake message, joined; returns the index of its last line. */
	const cmakeDetail = (i: number): [string, number] => {
		const detail: string[] = [];
		while (i + 1 < lines.length && (/^\s+\S/.test(lines[i + 1]) || lines[i + 1].trim() === '') && detail.length < 10) {
			i++;
			if (lines[i].trim()) {
				detail.push(lines[i].trim());
			}
		}
		return [detail.join(' '), i];
	};
	const stripLdPrefix = (line: string) => line.replace(/^.*?\bld(?:\.bfd|\.gold)?(?:\.exe)?:\s*/, '');

	for (let i = 0; i < lines.length; i++) {
		const line = lines[i];
		let m: RegExpExecArray | null;

		if ((m = REGION_OVERFLOW.exec(line))) {
			add({ severity: 'error', source: 'linker', message: stripLdPrefix(line), region: m.groups!.region, overflowBytes: Number(m.groups!.bytes) });
		} else if ((m = SECTION_NOFIT.exec(line))) {
			add({ severity: 'error', source: 'linker', message: stripLdPrefix(line), region: m.groups!.region });
		} else if ((m = LINKER_SYMBOL.exec(line))) {
			const g = m.groups!;
			// The location, when there is one, comes right before the message.
			const loc = LINKER_LOCATION.exec(line.slice(0, m.index + g.kind.length));
			add({ severity: 'error', source: 'linker', message: `${g.kind} \`${g.sym}'`, ...loc ? { file: loc.groups!.file, line: Number(loc.groups!.line) } : {} });
		} else if ((m = COMPILER.exec(line))) {
			const g = m.groups!;
			const flag = TRAILING_FLAG.exec(g.msg);
			add({
				severity: g.sev === 'note' ? 'note' : g.sev === 'warning' ? 'warning' : 'error',
				source: 'compiler',
				message: (flag ? g.msg.slice(0, flag.index) : g.msg).trimEnd(),
				file: g.file,
				line: Number(g.line),
				...g.col ? { column: Number(g.col) } : {},
				...flag ? { flag: flag[1] } : {},
			});
		} else if ((m = CMAKE_AT.exec(line)) || (m = CMAKE_IN.exec(line))) {
			const g = m.groups!;
			const [detail, last] = cmakeDetail(i);
			i = last;
			add({ severity: g.sev === 'Error' ? 'error' : 'warning', source: 'cmake', message: `${g.cmd ? `${g.cmd}: ` : ''}${detail || 'CMake problem'}`, file: g.file, ...g.line ? { line: Number(g.line) } : {} });
		} else if ((m = CMAKE_PLAIN.exec(line))) {
			const g = m.groups!;
			const [detail, last] = cmakeDetail(i);
			i = last;
			add({ severity: g.sev === 'Error' ? 'error' : 'warning', source: 'cmake', message: [g.msg, detail].filter(Boolean).join(' ') || 'CMake problem' });
		} else if (/collect2(?:\.exe)?: error: ld returned \d+ exit status/.test(line)) {
			continue; // only summarises the linker errors already reported
		} else if ((m = DRIVER.exec(line))) {
			add({ severity: m.groups!.sev === 'warning' ? 'warning' : 'error', source: line.includes('collect2') ? 'linker' : 'compiler', message: m.groups!.msg });
		} else if ((m = LD_ERROR.exec(line)) && /error|cannot find|cannot open|not found|undefined/i.test(m.groups!.msg)) {
			add({ severity: 'error', source: 'linker', message: m.groups!.msg });
		} else if ((m = NOT_FOUND.exec(line))) {
			add({ severity: 'error', source: 'tool', message: `${m.groups!.cmd}: command not found` });
		} else if ((m = MAKE_ERROR.exec(line))) {
			add({ severity: 'error', source: 'make', message: m.groups!.msg });
		}
	}
	return out;
}

export function countBySeverity(diagnostics: readonly Diagnostic[]): Record<DiagnosticSeverity, number> {
	const counts = { error: 0, warning: 0, note: 0 };
	for (const d of diagnostics) {
		counts[d.severity]++;
	}
	return counts;
}
