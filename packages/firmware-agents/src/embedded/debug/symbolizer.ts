/*---------------------------------------------------------------------------------------------
 *  Copyright (c) RoboAgent. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { IAgentHost } from '../../kernel/host';
import { hex } from '../svd/peripheralDecoder';

/** A code address resolved against an ELF. */
export interface Symbolized {
	readonly address: string;
	readonly function?: string;
	readonly file?: string;
	readonly line?: number;
}

const MAX_ADDRESSES = 64;

/**
 * Parses `gdb -batch` output of `echo @@<addr>\n` + `info line *<addr>` pairs: per address its
 * function and, when the ELF has line information, file and line.
 */
export function parseInfoLines(output: string): Map<number, Symbolized> {
	const out = new Map<number, Symbolized>();
	for (const block of output.split(/^@@/m).slice(1)) {
		const nl = block.indexOf('\n');
		const address = Number(block.slice(0, nl < 0 ? undefined : nl).trim());
		if (!Number.isSafeInteger(address)) {
			continue;
		}
		const text = block.slice(nl + 1).replace(/\s+/g, ' ');
		const withLine = /Line (\d+) of "([^"]+)"[^<]*<([^>+]+)(?:\+\d+)?>/.exec(text);
		const noLine = /address 0x[0-9a-fA-F]+ <([^>+]+)(?:\+\d+)?>/.exec(text);
		out.set(address, withLine
			? { address: hex(address), function: withLine[3], file: withLine[2], line: Number(withLine[1]) }
			: noLine ? { address: hex(address), function: noLine[1] } : { address: hex(address) });
	}
	return out;
}

/**
 * Resolves code addresses with GDB in batch mode (no target): the same GDB the debug session
 * uses, so no extra binutils are needed. `elf` is workspace-relative; scripts are never loaded.
 */
export async function symbolize(host: IAgentHost, gdb: string, elf: string, addresses: readonly number[], signal?: AbortSignal): Promise<Map<number, Symbolized>> {
	const unique = [...new Set(addresses.filter(a => Number.isSafeInteger(a) && a >= 0 && a <= 0xFFFFFFFF))].slice(0, MAX_ADDRESSES);
	if (!unique.length) {
		return new Map();
	}
	const args = ['-batch', '-nx', '-q', '-iex', 'set auto-load off', '-iex', 'set debuginfod enabled off', '-iex', 'set pagination off'];
	for (const a of unique) {
		args.push('-ex', `echo @@${hex(a)}\\n`, '-ex', `info line *${hex(a)}`);
	}
	// `--` keeps a file name that starts with "-" from being read as an option.
	args.push('--', elf);
	const r = await host.exec(gdb, args, { timeoutMs: 60_000, maxOutputBytes: 512 * 1024, ...signal ? { signal } : {} });
	return parseInfoLines(r.stdout);
}
