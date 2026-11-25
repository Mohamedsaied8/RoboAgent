/*---------------------------------------------------------------------------------------------
 *  Copyright (c) RoboAgent. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/*---------------------------------------------------------------------------------------------
 *  ESP-IDF core dumps in ELF format (the default since v5): printed on the UART as base64 lines
 *  between "CORE DUMP START/END" markers, or stored in the coredump flash partition. Layout
 *  (ESP-IDF v6.1 espcoredump/include_core_dump/esp_core_dump_types.h, src/core_dump_elf.c):
 *    header { u32 data_len; u32 version; u32 chip_rev }  ELF core file  checksum
 *  where the checksum is SHA-256 (version x.x.1.4) or CRC32 (1.2) over everything before it.
 *  The ELF core opens directly in the chip's GDB (`target core`): every FreeRTOS task becomes a
 *  thread. Its notes add what GDB cannot show: the crashed task, EXCCAUSE/EXCVADDR (Xtensa), the
 *  abort/assert text and the app's ELF SHA-256.
 *--------------------------------------------------------------------------------------------*/

import { createHash } from 'crypto';
import { redactSecrets } from '../../kernel/redact';
import { cleanSerialText } from './espPanicLog';

export class CoreDumpError extends Error {
	constructor(message: string) {
		super(message);
		this.name = 'CoreDumpError';
	}
}

export interface EspCoreDump {
	/** The ELF core file (what GDB loads). */
	readonly elf: Uint8Array;
	readonly version: { readonly chipId: number; readonly major: number; readonly minor: number };
	/** Chip revision ×100 (e.g. 100 = v1.0). */
	readonly chipRevision: number;
	readonly checksum: 'sha256' | 'crc32';
	/** SHA-256 of the app ELF that crashed (from the ESP_CORE_DUMP_INFO note), as far as stored. */
	readonly appElfSha256?: string;
	readonly crashedTaskTcb?: number;
	/** Xtensa: EXCCAUSE / EXCVADDR of the crash. */
	readonly exccause?: number;
	readonly excvaddr?: number;
	/** Text abort()/assert gave (ESP_PANIC_DETAILS note). */
	readonly panicDetails?: string;
	readonly isrContext?: boolean;
}

/** Biggest core dump accepted (ESP32 internal RAM is 520 KB; dumps hold task stacks and TCBs). */
export const MAX_CORE_DUMP_BYTES = 4 * 1024 * 1024;

const ELF_NOTE_TYPES = { info: 8266, extraInfo: 677, panicDetails: 679 } as const;

/**
 * Core dumps printed on the UART in `text`, in order (each decoded from its base64 lines). A
 * dump cut off before its END marker is skipped.
 */
export function extractUartCoreDumps(text: string): Uint8Array[] {
	const out: Uint8Array[] = [];
	let lines: string[] | undefined;
	let size = 0;
	for (const line of cleanSerialText(text).split('\n')) {
		if (line.includes('CORE DUMP START')) {
			lines = [];
			size = 0;
			continue;
		}
		if (!lines) {
			continue;
		}
		if (line.includes('CORE DUMP END')) {
			const chunks = lines.map(l => Buffer.from(l, 'base64'));
			out.push(new Uint8Array(Buffer.concat(chunks)));
			lines = undefined;
			continue;
		}
		const l = line.trim();
		if (!l) {
			continue;
		}
		// One base64 line of the dump is 64 characters; a longer line is not dump data.
		if (l.length > 4096 || !/^[A-Za-z0-9+/]+={0,2}$/.test(l)) {
			// Log output interleaved with the dump: the dump is unusable.
			lines = undefined;
			continue;
		}
		size += l.length;
		if (size > MAX_CORE_DUMP_BYTES * 4 / 3 + 1024) {
			lines = undefined;
			continue;
		}
		lines.push(l);
	}
	return out;
}

function crc32(data: Uint8Array): number {
	let crc = 0xFFFFFFFF;
	for (const byte of data) {
		crc ^= byte;
		for (let k = 0; k < 8; k++) {
			crc = (crc >>> 1) ^ (0xEDB88320 & -(crc & 1));
		}
	}
	return (crc ^ 0xFFFFFFFF) >>> 0;
}

/** Checks and splits a raw core dump image (UART or flash partition). */
export function parseCoreDump(image: Uint8Array): EspCoreDump {
	if (image.length < 12 + 52 + 4) {
		throw new CoreDumpError(`The core dump is too short (${image.length} bytes).`);
	}
	if (image.length > MAX_CORE_DUMP_BYTES) {
		throw new CoreDumpError(`The core dump is ${image.length} bytes; the limit is ${MAX_CORE_DUMP_BYTES}.`);
	}
	const view = new DataView(image.buffer, image.byteOffset, image.byteLength);
	const dataLength = view.getUint32(0, true);
	const versionWord = view.getUint32(4, true);
	const chipRevision = view.getUint32(8, true);
	const version = { chipId: versionWord >>> 16, major: (versionWord >>> 8) & 0xFF, minor: versionWord & 0xFF };
	if (version.major !== 1) {
		throw new CoreDumpError(`Core dump format ${version.major}.${version.minor} is not the ELF format (CONFIG_ESP_COREDUMP_DATA_FORMAT_ELF); only ELF core dumps are supported.`);
	}
	const checksum = version.minor >= 4 ? 'sha256' : 'crc32';
	const checksumLength = checksum === 'sha256' ? 32 : 4;
	if (dataLength !== image.length) {
		throw new CoreDumpError(`The core dump header says ${dataLength} bytes but ${image.length} were captured (cut off or mixed with other output?).`);
	}
	const body = image.subarray(0, image.length - checksumLength);
	const stored = image.subarray(image.length - checksumLength);
	const ok = checksum === 'sha256'
		? createHash('sha256').update(body).digest().equals(Buffer.from(stored))
		: crc32(body) === new DataView(stored.buffer, stored.byteOffset, 4).getUint32(0, true);
	if (!ok) {
		throw new CoreDumpError(`The core dump's ${checksum.toUpperCase()} checksum does not match: the dump is corrupted.`);
	}
	const elf = image.subarray(12, image.length - checksumLength);
	if (elf[0] !== 0x7F || elf[1] !== 0x45 || elf[2] !== 0x4C || elf[3] !== 0x46 || elf[4] !== 1 || elf[5] !== 1) {
		throw new CoreDumpError('The core dump does not contain a 32-bit little-endian ELF file.');
	}
	return { elf, version, chipRevision, checksum, ...readCoreNotes(elf) };
}

/** ESP-IDF's notes of an ELF core file (bounds-checked): crashed task, cause (Xtensa), abort text, app SHA. */
export function readCoreNotes(elf: Uint8Array): NoteFacts {
	const notes = readNotes(elf);
	// 0..63: EXCCAUSE; 64 + N: ESP-IDF pseudo cause N (≤ 7). Anything else (0xFFFF, or garbage in
	// abort()/assert/watchdog dumps, which have no exception frame) is no cause.
	if (notes.exccause !== undefined && notes.exccause >= 72) {
		delete notes.exccause;
		delete notes.excvaddr;
	}
	return notes;
}

type NoteFacts = Pick<EspCoreDump, 'appElfSha256' | 'crashedTaskTcb' | 'exccause' | 'excvaddr' | 'panicDetails' | 'isrContext'>;

/** Xtensa register indexes ESP-IDF uses in the extra-info note (xtensa_context.h / core-isa). */
const XT_REG_EXCCAUSE = 0xE8;
const XT_REG_EXCVADDR = 0xEE;

/** Reads ESP-IDF's notes from the ELF core's PT_NOTE segments (bounds-checked). */
function readNotes(elf: Uint8Array): { -readonly [K in keyof NoteFacts]: NoteFacts[K] } {
	const v = new DataView(elf.buffer, elf.byteOffset, elf.byteLength);
	const u32 = (off: number) => off + 4 <= elf.length ? v.getUint32(off, true) : undefined;
	const u16 = (off: number) => off + 2 <= elf.length ? v.getUint16(off, true) : undefined;
	const phoff = u32(28);
	const phentsize = u16(42);
	const phnum = u16(44);
	const facts: { -readonly [K in keyof NoteFacts]: NoteFacts[K] } = {};
	if (phoff === undefined || !phentsize || phnum === undefined || phentsize < 32) {
		return facts;
	}
	const machine = u16(18);
	const decoder = new TextDecoder('latin1');
	for (let k = 0; k < Math.min(phnum, 256); k++) {
		const ph = phoff + k * phentsize;
		if (u32(ph) !== 4 /* PT_NOTE */) {
			continue;
		}
		const offset = u32(ph + 4) ?? 0;
		const size = u32(ph + 16) ?? 0;
		const end = Math.min(elf.length, offset + size);
		for (let p = offset; p + 12 <= end;) {
			const namesz = u32(p)!;
			const descsz = u32(p + 4)!;
			const type = u32(p + 8)!;
			const nameAt = p + 12;
			const descAt = nameAt + ((namesz + 3) & ~3);
			const next = descAt + ((descsz + 3) & ~3);
			if (namesz > 64 || descsz > 64 * 1024 || next > end || next <= p) {
				break;
			}
			const desc = elf.subarray(descAt, descAt + descsz);
			const dv = new DataView(desc.buffer, desc.byteOffset, desc.byteLength);
			const word = (off: number) => off + 4 <= desc.length ? dv.getUint32(off, true) : undefined;
			if (type === ELF_NOTE_TYPES.info && desc.length > 4) {
				const sha = decoder.decode(desc.subarray(4)).replace(/\0.*$/s, '');
				if (/^[0-9a-fA-F]+$/.test(sha)) {
					facts.appElfSha256 = sha.toLowerCase();
				}
			} else if (type === ELF_NOTE_TYPES.extraInfo) {
				facts.crashedTaskTcb = word(0);
				if (machine === 94 /* EM_XTENSA */) {
					// { tcb; {idx,val} exccause; {idx,val} excvaddr; {idx,val} extra[16]; isr_context }
					for (let off = 4; off + 8 <= Math.min(desc.length, 4 + 18 * 8); off += 8) {
						const index = word(off);
						const value = word(off + 4);
						if (index === XT_REG_EXCCAUSE) {
							facts.exccause = value;
						} else if (index === XT_REG_EXCVADDR) {
							facts.excvaddr = value;
						}
					}
					const isr = word(4 + 18 * 8);
					if (isr !== undefined) {
						facts.isrContext = isr !== 0;
					}
				} else {
					const isr = word(4);
					if (isr !== undefined) {
						facts.isrContext = isr !== 0;
					}
				}
			} else if (type === ELF_NOTE_TYPES.panicDetails) {
				const text = redactSecrets(decoder.decode(desc).replace(/\0.*$/s, '').replace(/[\x00-\x08\x0b-\x1f\x7f]/g, '').trim());
				if (text) {
					facts.panicDetails = text.slice(0, 1000);
				}
			}
			p = next;
		}
	}
	return facts;
}
