/*---------------------------------------------------------------------------------------------
 *  Copyright (c) RoboAgent. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { child, childText, parseXml, XmlElement } from './xml';

export type SvdAccess = 'read-only' | 'write-only' | 'read-write' | 'writeOnce' | 'read-writeOnce';

export interface SvdEnumValue {
	readonly name: string;
	readonly value: number;
	readonly description?: string;
}

export interface SvdField {
	readonly name: string;
	readonly description?: string;
	readonly bitOffset: number;
	readonly bitWidth: number;
	readonly access?: SvdAccess;
	readonly enumeratedValues?: readonly SvdEnumValue[];
}

export interface SvdRegister {
	/** Full name inside the peripheral; cluster members are `CLUSTER.REG`. */
	readonly name: string;
	readonly description?: string;
	/** Byte offset from the peripheral's base address. */
	readonly offset: number;
	/** Width in bits. */
	readonly size: number;
	readonly access?: SvdAccess;
	readonly resetValue?: number;
	/** Set when reading the register has a side effect (e.g. clears flags). */
	readonly readAction?: string;
	readonly fields: readonly SvdField[];
}

export interface SvdPeripheral {
	readonly name: string;
	readonly description?: string;
	readonly groupName?: string;
	readonly baseAddress: number;
	readonly registers: readonly SvdRegister[];
}

export interface SvdDevice {
	readonly name: string;
	readonly description?: string;
	readonly peripherals: readonly SvdPeripheral[];
	/** Elements left out because their description was malformed (e.g. a bad `dim`). */
	readonly skipped?: readonly string[];
}

export class SvdError extends Error {
	constructor(message: string) {
		super(message);
		this.name = 'SvdError';
	}
}

/** Register properties inherited device → peripheral → cluster → register. */
interface Defaults {
	readonly size: number;
	readonly access?: SvdAccess;
	readonly resetValue?: number;
}

/** Hard cap on one `dim` array. */
const MAX_DIM = 1024;
/**
 * Everything one file may expand to (registers + fields + cluster instances), so nested `dim`s
 * cannot multiply into millions of objects (a few KB of hostile SVD would exhaust the heap).
 * The largest real STM32 SVDs expand to ~30 000.
 */
const MAX_EXPANDED = 300_000;
const MAX_CLUSTER_DEPTH = 8;

let expanded = 0;

function spend(n: number): void {
	expanded += n;
	if (expanded > MAX_EXPANDED) {
		throw new SvdError(`the file expands to more than ${MAX_EXPANDED} registers and fields`);
	}
}

/** SVD scaled integers: decimal, `0x…`, `#binary` (`x` = don't care, read as 0). */
export function parseSvdNumber(text: string | undefined): number | undefined {
	if (text === undefined) {
		return undefined;
	}
	const t = text.trim().toLowerCase();
	let value: number;
	if (/^0x[0-9a-f]+$/.test(t)) {
		value = parseInt(t.slice(2), 16);
	} else if (/^(#|0b)[01x]+$/.test(t)) {
		value = parseInt(t.replace(/^(#|0b)/, '').replace(/x/g, '0'), 2);
	} else if (/^\d+$/.test(t)) {
		value = parseInt(t, 10);
	} else {
		return undefined;
	}
	return Number.isSafeInteger(value) ? value : undefined;
}

const ACCESS = new Set<string>(['read-only', 'write-only', 'read-write', 'writeOnce', 'read-writeOnce']);

function readAccess(e: XmlElement): SvdAccess | undefined {
	const a = childText(e, 'access');
	return a && ACCESS.has(a) ? a as SvdAccess : undefined;
}

function readDefaults(e: XmlElement, inherited: Defaults): Defaults {
	const size = parseSvdNumber(childText(e, 'size'));
	const resetValue = parseSvdNumber(childText(e, 'resetValue'));
	const access = readAccess(e);
	const effectiveAccess = access ?? inherited.access;
	const effectiveReset = resetValue ?? inherited.resetValue;
	return {
		size: size ?? inherited.size,
		...effectiveAccess ? { access: effectiveAccess } : {},
		...effectiveReset !== undefined ? { resetValue: effectiveReset } : {},
	};
}

function cleanText(text: string | undefined): string | undefined {
	const t = text?.replace(/\s+/g, ' ').trim();
	return t || undefined;
}

/** {@link expandDimStrict}, but a malformed `dim` drops just that element (one bad register must not hide the whole device). */
function expandDim(e: XmlElement, name: string): { name: string; step: number; index: string }[] {
	try {
		return expandDimStrict(e, name);
	} catch (err) {
		if (err instanceof SvdError) {
			skippedElements.push(err.message);
			return [];
		}
		throw err;
	}
}

/** Elements dropped while parsing the current file (reported on the device). */
let skippedElements: string[] = [];

/** `dim` expansion: names and address steps for each element, or one plain element. */
function expandDimStrict(e: XmlElement, name: string): { name: string; step: number; index: string }[] {
	const dim = parseSvdNumber(childText(e, 'dim'));
	if (dim === undefined) {
		return [{ name, step: 0, index: '' }];
	}
	if (dim < 1 || dim > MAX_DIM) {
		throw new SvdError(`${name}: dim ${dim} out of range`);
	}
	const increment = parseSvdNumber(childText(e, 'dimIncrement')) ?? 0;
	const indexText = childText(e, 'dimIndex');
	let indices: string[];
	const range = indexText && /^(\d+)-(\d+)$/.exec(indexText.trim());
	const letters = indexText && /^([A-Z])-([A-Z])$/.exec(indexText.trim());
	if (range) {
		const from = Number(range[1]);
		indices = Array.from({ length: dim }, (_, k) => String(from + k));
	} else if (letters) {
		const from = letters[1].charCodeAt(0);
		const to = letters[2].charCodeAt(0);
		indices = Array.from({ length: Math.max(0, to - from + 1) }, (_, k) => String.fromCharCode(from + k));
	} else if (indexText) {
		indices = indexText.split(',').map(s => s.trim());
	} else {
		indices = Array.from({ length: dim }, (_, k) => String(k));
	}
	if (indices.length < dim) {
		throw new SvdError(`${name}: dimIndex has fewer entries than dim`);
	}
	return indices.slice(0, dim).map((index, k) => ({
		// `REG[%s]` is an array (REG0, REG1, …); `REG%s` a list.
		name: name.includes('[%s]') ? name.replace('[%s]', index) : name.replace('%s', index),
		step: k * increment,
		index,
	}));
}

function parseEnums(field: XmlElement): SvdEnumValue[] | undefined {
	const values: SvdEnumValue[] = [];
	for (const group of field.children.filter(c => c.name === 'enumeratedValues')) {
		for (const ev of group.children.filter(c => c.name === 'enumeratedValue')) {
			const name = childText(ev, 'name');
			const value = parseSvdNumber(childText(ev, 'value'));
			const description = cleanText(childText(ev, 'description'));
			if (name && value !== undefined) {
				values.push({ name, value, ...description ? { description } : {} });
			}
		}
	}
	return values.length ? values : undefined;
}

function parseFields(register: XmlElement, regSize: number, regName: string): SvdField[] {
	const fields: SvdField[] = [];
	const container = child(register, 'fields');
	for (const f of container?.children.filter(c => c.name === 'field') ?? []) {
		const baseName = childText(f, 'name');
		if (!baseName) {
			continue;
		}
		let bitOffset = parseSvdNumber(childText(f, 'bitOffset'));
		let bitWidth = parseSvdNumber(childText(f, 'bitWidth'));
		const lsb = parseSvdNumber(childText(f, 'lsb'));
		const msb = parseSvdNumber(childText(f, 'msb'));
		const range = /^\[(\d+):(\d+)\]$/.exec(childText(f, 'bitRange')?.trim() ?? '');
		if (bitOffset === undefined && lsb !== undefined && msb !== undefined) {
			bitOffset = lsb;
			bitWidth = msb - lsb + 1;
		} else if (bitOffset === undefined && range) {
			bitOffset = Number(range[2]);
			bitWidth = Number(range[1]) - Number(range[2]) + 1;
		}
		bitWidth ??= 1;
		if (bitOffset === undefined || bitWidth < 1 || bitOffset + bitWidth > Math.max(regSize, 64)) {
			throw new SvdError(`${regName}.${baseName}: invalid bit position`);
		}
		const description = cleanText(childText(f, 'description'));
		const access = readAccess(f);
		const enumeratedValues = parseEnums(f);
		const items = expandDim(f, baseName);
		spend(items.length);
		for (const item of items) {
			const offset = bitOffset + item.step;
			fields.push({ name: item.name, bitOffset: offset, bitWidth, ...description ? { description } : {}, ...access ? { access } : {}, ...enumeratedValues ? { enumeratedValues } : {} });
		}
	}
	return fields;
}

interface RawRegister extends SvdRegister {
	readonly derivedFrom?: string;
	readonly hasFields: boolean;
}

function parseRegisterBlock(container: XmlElement, defaults: Defaults, offset: number, prefix: string, out: RawRegister[], depth = 0): void {
	if (depth > MAX_CLUSTER_DEPTH) {
		throw new SvdError(`clusters nested deeper than ${MAX_CLUSTER_DEPTH}`);
	}
	for (const e of container.children) {
		if (e.name !== 'register' && e.name !== 'cluster') {
			continue;
		}
		const baseName = childText(e, 'name');
		const addressOffset = parseSvdNumber(childText(e, 'addressOffset'));
		if (!baseName || addressOffset === undefined) {
			continue;
		}
		const d = readDefaults(e, defaults);
		const items = expandDim(e, baseName);
		spend(items.length);
		for (const item of items) {
			const at = offset + addressOffset + item.step;
			if (e.name === 'cluster') {
				parseRegisterBlock(e, d, at, `${prefix}${item.name}.`, out, depth + 1);
				continue;
			}
			const description = cleanText(childText(e, 'description'));
			const readAction = childText(e, 'readAction');
			const fieldsElement = child(e, 'fields');
			out.push({
				name: `${prefix}${item.name}`,
				offset: at,
				size: d.size,
				fields: parseFields(e, d.size, item.name),
				hasFields: !!fieldsElement,
				...description ? { description } : {},
				...d.access ? { access: d.access } : {},
				...d.resetValue !== undefined ? { resetValue: d.resetValue } : {},
				...readAction ? { readAction } : {},
				...e.attributes.derivedFrom ? { derivedFrom: e.attributes.derivedFrom } : {},
			});
		}
	}
}

/**
 * Parses a CMSIS-SVD file into peripherals with absolute base addresses and fully expanded
 * registers and fields: inherited register properties, `derivedFrom` (peripherals and
 * registers), `dim` arrays and lists, and clusters.
 */
export function parseSvd(source: string): SvdDevice {
	const root = parseXml(source);
	skippedElements = [];
	expanded = 0;
	if (root.name !== 'device') {
		throw new SvdError(`not an SVD file (root element <${root.name}>)`);
	}
	const deviceDefaults = readDefaults(root, { size: 32 });
	const raw = new Map<string, { element: XmlElement; base: number; derivedFrom?: string }>();
	const order: string[] = [];
	for (const p of child(root, 'peripherals')?.children.filter(c => c.name === 'peripheral') ?? []) {
		const name = childText(p, 'name');
		const base = parseSvdNumber(childText(p, 'baseAddress'));
		if (!name || base === undefined) {
			continue;
		}
		const instances = expandDim(p, name);
		spend(instances.length);
		for (const item of instances) {
			raw.set(item.name, { element: p, base: base + item.step, ...p.attributes.derivedFrom ? { derivedFrom: p.attributes.derivedFrom } : {} });
			order.push(item.name);
		}
	}

	const resolved = new Map<string, SvdPeripheral>();
	const resolve = (name: string, seen: Set<string>): SvdPeripheral => {
		const done = resolved.get(name);
		if (done) {
			return done;
		}
		const entry = raw.get(name)!;
		if (seen.has(name)) {
			throw new SvdError(`derivedFrom cycle at ${name}`);
		}
		seen.add(name);
		const parent = entry.derivedFrom && raw.has(entry.derivedFrom) ? resolve(entry.derivedFrom, seen) : undefined;
		const e = entry.element;
		const defaults = readDefaults(e, deviceDefaults);
		const own: RawRegister[] = [];
		const regs = child(e, 'registers');
		if (regs) {
			parseRegisterBlock(regs, defaults, 0, '', own);
		}
		// A derived peripheral inherits the parent's registers; its own add to them or replace same-named ones.
		const ownRegisters = resolveRegisterDerivation(own);
		const ownNames = new Set(ownRegisters.map(r => r.name));
		const registers = parent ? [...parent.registers.filter(r => !ownNames.has(r.name)), ...ownRegisters] : ownRegisters;
		const description = cleanText(childText(e, 'description')) ?? parent?.description;
		const groupName = childText(e, 'groupName') ?? parent?.groupName;
		const peripheral: SvdPeripheral = { name, baseAddress: entry.base, registers, ...description ? { description } : {}, ...groupName ? { groupName } : {} };
		resolved.set(name, peripheral);
		return peripheral;
	};

	const description = cleanText(childText(root, 'description'));
	const peripherals = order.map(name => resolve(name, new Set()));
	return {
		name: childText(root, 'name') ?? 'unknown',
		...description ? { description } : {},
		peripherals,
		...skippedElements.length ? { skipped: skippedElements.slice(0, 50) } : {},
	};
}

/** Registers with `derivedFrom` take the fields (and missing properties) of a sibling register. */
function resolveRegisterDerivation(registers: readonly RawRegister[]): SvdRegister[] {
	const byName = new Map(registers.map(r => [r.name, r]));
	return registers.map(r => {
		const from = r.derivedFrom ? byName.get(r.derivedFrom) : undefined;
		const { derivedFrom: _d, hasFields, ...plain } = r;
		return from && !hasFields ? { ...plain, fields: from.fields, ...plain.description ? {} : from.description ? { description: from.description } : {} } : plain;
	});
}

/** Case-insensitive lookup of a peripheral. */
export function findPeripheral(device: SvdDevice, name: string): SvdPeripheral | undefined {
	const wanted = name.trim().toUpperCase();
	return device.peripherals.find(p => p.name.toUpperCase() === wanted);
}
