/*---------------------------------------------------------------------------------------------
 *  Copyright (c) RoboAgent. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { SvdField, SvdPeripheral, SvdRegister } from './svdParser';

export interface DecodedField {
	readonly name: string;
	/** `[msb:lsb]`, or `[bit]` for one bit. */
	readonly bits: string;
	readonly value: number;
	/** Name of the matching enumerated value, when the SVD defines one. */
	readonly meaning?: string;
}

export interface DecodedRegister {
	readonly name: string;
	readonly address: string;
	readonly value: string;
	readonly fields: readonly DecodedField[];
	/** Fields whose value differs from the reset value (names), when a reset value is known. */
	readonly changedFromReset?: readonly string[];
}

export interface SkippedRegister {
	readonly name: string;
	readonly reason: string;
}

export interface DecodedPeripheral {
	readonly name: string;
	readonly baseAddress: string;
	readonly description?: string;
	readonly registers: readonly DecodedRegister[];
	/** Registers not read: write-only, or reading them would change the hardware (e.g. clear flags). */
	readonly skipped: readonly SkippedRegister[];
}

export function hex(value: number, digits = 8): string {
	return `0x${(value >>> 0).toString(16).toUpperCase().padStart(digits, '0')}`;
}

export function fieldValue(field: SvdField, registerValue: number): number {
	// Fields can be 32 bits wide; use arithmetic instead of shifts that overflow.
	return Math.floor(registerValue / 2 ** field.bitOffset) % 2 ** field.bitWidth;
}

function bitsLabel(field: SvdField): string {
	return field.bitWidth === 1 ? `[${field.bitOffset}]` : `[${field.bitOffset + field.bitWidth - 1}:${field.bitOffset}]`;
}

const RECEIVE_DATA_REGISTER = /(?:^|\.)(?:DR|RDR|RXDR|RXDATA|RXFIFO|FIFO|DATA)$/i;

/**
 * Whether the debugger may read the register: never write-only ones, and never those whose read
 * has a side effect (`readAction`, e.g. a UART data register that pops the receive FIFO).
 */
export function readableRegister(register: SvdRegister): { ok: true } | { ok: false; reason: string } {
	if (register.access === 'write-only' || register.access === 'writeOnce') {
		return { ok: false, reason: 'write-only' };
	}
	if (register.readAction) {
		return { ok: false, reason: `reading it has a side effect (${register.readAction})` };
	}
	// Many vendor SVDs omit readAction on receive data registers (STM32 USART/SPI/I2C/ADC `DR`).
	if (RECEIVE_DATA_REGISTER.test(register.name)) {
		return { ok: false, reason: 'data register: reading it can pop a receive FIFO or clear status flags' };
	}
	if (![8, 16, 32].includes(register.size)) {
		return { ok: false, reason: `unsupported width ${register.size} bits` };
	}
	return { ok: true };
}

export function decodeRegister(peripheral: SvdPeripheral, register: SvdRegister, value: number): DecodedRegister {
	const fields = register.fields.map(f => {
		const v = fieldValue(f, value);
		const meaning = f.enumeratedValues?.find(e => e.value === v)?.name;
		return { name: f.name, bits: bitsLabel(f), value: v, ...meaning ? { meaning } : {} };
	});
	const reset = register.resetValue;
	const changed = reset === undefined ? undefined : register.fields.filter(f => fieldValue(f, value) !== fieldValue(f, reset)).map(f => f.name);
	return {
		name: register.name,
		address: hex(peripheral.baseAddress + register.offset),
		value: hex(value, register.size / 4),
		fields,
		...changed ? { changedFromReset: changed } : {},
	};
}

/** Little-endian unsigned value of `size` bits from `bytes`. */
export function readLittleEndian(bytes: Uint8Array, offset: number, sizeBits: number): number {
	let value = 0;
	for (let k = sizeBits / 8 - 1; k >= 0; k--) {
		value = value * 256 + bytes[offset + k];
	}
	return value;
}

/** Field-by-field difference between two decodes of the same peripheral. */
export function comparePeripheral(before: DecodedPeripheral, after: DecodedPeripheral): { register: string; field: string; before: number; after: number }[] {
	const out: { register: string; field: string; before: number; after: number }[] = [];
	const old = new Map(before.registers.map(r => [r.name, r]));
	for (const r of after.registers) {
		const o = old.get(r.name);
		if (!o) {
			continue;
		}
		const oldFields = new Map(o.fields.map(f => [f.name, f.value]));
		for (const f of r.fields) {
			const was = oldFields.get(f.name);
			if (was !== undefined && was !== f.value) {
				out.push({ register: r.name, field: f.name, before: was, after: f.value });
			}
		}
	}
	return out;
}
