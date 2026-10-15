/*---------------------------------------------------------------------------------------------
 *  Copyright (c) RoboAgent. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/** Debug probes the agents support, by USB vendor:product id (what udev rules must grant). */
export type ProbeId = 'stlink' | 'esp-usb-jtag' | 'esp-prog' | 'cmsis-dap' | 'jlink';

export interface ProbeKind {
	readonly id: ProbeId;
	readonly label: string;
	/** `vvvv:pppp`, lower case. Any one being covered by a rule is enough for that model. */
	readonly usbIds: readonly string[];
	/** OpenOCD interface script for this probe. */
	readonly openocdInterface: string;
	/** Some probes are granted by USB product string instead of id (OpenOCD: `ATTRS{product}=="*CMSIS-DAP*"`). */
	readonly productMatch?: string;
}

export const PROBES: Readonly<Record<ProbeId, ProbeKind>> = {
	'stlink': {
		id: 'stlink',
		label: 'ST-Link (V2, V2-1, V3)',
		usbIds: ['0483:3744', '0483:3748', '0483:374b', '0483:374d', '0483:374e', '0483:374f', '0483:3752', '0483:3753', '0483:3754'],
		openocdInterface: 'interface/stlink.cfg',
	},
	'esp-usb-jtag': {
		id: 'esp-usb-jtag',
		label: 'ESP32 built-in USB-Serial-JTAG (S3, C3, C6, H2)',
		usbIds: ['303a:1001'],
		openocdInterface: 'interface/esp_usb_jtag.cfg',
	},
	'esp-prog': {
		id: 'esp-prog',
		label: 'ESP-PROG / FTDI FT2232H JTAG',
		usbIds: ['0403:6010', '0403:6014'],
		openocdInterface: 'interface/ftdi/esp32_devkitj_v1.cfg',
	},
	'cmsis-dap': {
		id: 'cmsis-dap',
		label: 'CMSIS-DAP (DAPLink, Picoprobe)',
		usbIds: ['0d28:0204', '2e8a:000c'],
		openocdInterface: 'interface/cmsis-dap.cfg',
		productMatch: 'CMSIS-DAP',
	},
	'jlink': {
		id: 'jlink',
		label: 'SEGGER J-Link',
		usbIds: ['1366:0101', '1366:0105', '1366:1015', '1366:1020', '1366:1051'],
		openocdInterface: 'interface/jlink.cfg',
	},
};

/** What a set of udev rules grants: USB ids, and USB product-string globs. */
export interface UdevGrants {
	readonly ids: Set<string>;
	readonly products: string[];
}

/** Rules limited to a probe's HID or serial side do not grant the USB device OpenOCD opens. */
const ONLY_SIDE_DEVICE = /\bKERNEL=="(hidraw|tty)|\bSUBSYSTEMS?=="(hidraw|tty)"/;

/** A rule line grants access only when it sets a mode, a group or the `uaccess` tag. */
const GRANTS_ACCESS = /\bMODE\s*:?=|\bGROUP\s*:?=|TAG\+?=\s*"uaccess"/;

/**
 * What one rules file grants. Joins `\`-continued lines, ignores comments, accepts `ATTR{…}` and
 * `ATTRS{…}`, expands `"a|b"` alternatives, and counts only lines that grant access.
 */
export function grantsInRuleFile(text: string, into: UdevGrants = { ids: new Set(), products: [] }): UdevGrants {
	const joined = text.replace(/\\\r?\n/g, ' ');
	for (const line of joined.split(/\r?\n/)) {
		if (line.trimStart().startsWith('#') || !GRANTS_ACCESS.test(line) || ONLY_SIDE_DEVICE.test(line)) {
			continue;
		}
		const vendor = /ATTRS?\{idVendor\}=="([0-9a-fA-F|]+)"/.exec(line);
		const product = /ATTRS?\{idProduct\}=="([0-9a-fA-F|]+)"/.exec(line);
		if (vendor && product) {
			for (const v of vendor[1].split('|')) {
				for (const p of product[1].split('|')) {
					into.ids.add(`${v}:${p}`.toLowerCase());
				}
			}
		}
		const name = /ATTRS?\{product\}=="([^"]+)"/.exec(line);
		if (name && !vendor) {
			into.products.push(name[1]);
		}
	}
	return into;
}

/**
 * Parses `grep -rH '' <rule dirs>` output (`<file>:<line>` for every line) file by file, so
 * continuation lines are only ever joined within their own file.
 */
export function grantsInGrepDump(dump: string): UdevGrants {
	const files = new Map<string, string[]>();
	for (const line of dump.split('\n')) {
		const m = /^(\/[^:]*\.rules):(.*)$/.exec(line);
		if (m) {
			let lines = files.get(m[1]);
			if (!lines) {
				lines = [];
				files.set(m[1], lines);
			}
			lines.push(m[2]);
		}
	}
	const grants: UdevGrants = { ids: new Set(), products: [] };
	for (const lines of files.values()) {
		grantsInRuleFile(lines.join('\n'), grants);
	}
	return grants;
}

/** Whether `grants` cover the probe (by id, or by a product glob such as `*CMSIS-DAP*`). */
export function probeCovered(probe: ProbeKind, grants: UdevGrants): boolean {
	if (probe.usbIds.some(id => grants.ids.has(id))) {
		return true;
	}
	const wanted = probe.productMatch;
	return !!wanted && grants.products.some(glob => new RegExp(`^${glob.split('*').map(p => p.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*')}$`, 'i').test(wanted) || glob.replace(/\*/g, '').toLowerCase() === wanted.toLowerCase());
}

/** `vvvv:pppp` pairs granted by one rules file (convenience for tests and simple callers). */
export function usbIdsInUdevRules(text: string): Set<string> {
	return grantsInRuleFile(text).ids;
}
