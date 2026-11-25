/*---------------------------------------------------------------------------------------------
 *  Copyright (c) RoboAgent. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as path from 'path';
import { IAgentHost } from '../../kernel/host';
import { debugRequirements, DependencyResolver } from '../../install/resolver';
import { TargetDescriptor } from '../target';
import { PROBES } from '../../install/probes';
import { checkScriptName } from './openocdServer';

/** OpenOCD interface scripts for the probes the agent knows (relative to OpenOCD's scripts folder). */
export const PROBE_INTERFACES: Readonly<Record<string, string>> = {
	'stlink': 'interface/stlink.cfg',
	'cmsis-dap': 'interface/cmsis-dap.cfg',
	'jlink': 'interface/jlink.cfg',
	'esp-usb-jtag': PROBES['esp-usb-jtag'].openocdInterface,
	'esp-prog': PROBES['esp-prog'].openocdInterface,
};

const ESP_PROBES = new Set(['esp-usb-jtag', 'esp-prog']);

export interface DebugStack {
	readonly openocd: string;
	readonly gdb: string;
	/** OpenOCD's own scripts folder (absolute, trusted). */
	readonly scriptsDir: string;
	readonly interfaceScript: string;
	readonly targetScript: string;
}

export class DebugStackError extends Error {
	constructor(message: string) {
		super(message);
		this.name = 'DebugStackError';
	}
}

/**
 * Where OpenOCD keeps its scripts relative to its program: the xPack layout
 * (`<root>/bin/openocd`, `<root>/openocd/scripts`) and the usual install prefix
 * (`<prefix>/bin/openocd`, `<prefix>/share/openocd/scripts`).
 */
export function openocdScriptCandidates(program: string): string[] {
	const root = path.dirname(path.dirname(program));
	return [path.join(root, 'openocd', 'scripts'), path.join(root, 'share', 'openocd', 'scripts')];
}

/**
 * Finds the programs and scripts a session needs, using the same checks as `check_debug_tools`
 * (tool store first, then PATH). Throws {@link DebugStackError} with the next step when
 * something is missing.
 */
export async function locateDebugStack(host: IAgentHost, target: TargetDescriptor, probe: string, signal?: AbortSignal): Promise<DebugStack> {
	const esp = target.vendor === 'esp32';
	const interfaceScript = PROBE_INTERFACES[probe];
	if (!interfaceScript) {
		throw new DebugStackError(`Unknown probe "${probe}" (known: ${Object.keys(PROBE_INTERFACES).join(', ')}).`);
	}
	if (esp !== ESP_PROBES.has(probe)) {
		throw new DebugStackError(esp
			? `${target.part} is debugged over JTAG with probe "esp-usb-jtag" (built-in USB-JTAG: S3, C3, C6, H2) or "esp-prog" (ESP-PROG / FTDI), or without a probe over the serial port (transport "serial").`
			: `Probe "${probe}" is for ESP32 boards; ${target.part} uses stlink, cmsis-dap or jlink.`);
	}
	// Espressif's OpenOCD: the chip's target script (board scripts also pick an interface).
	const targetScript = checkScriptName(esp ? `target/${target.part}.cfg` : target.openocdConfig ?? '');
	const serverId = esp ? 'openocd-esp32' : 'openocd';
	const deps = debugRequirements({ target }).filter(d => d.id === serverId || d.id === 'gdb');
	const report = await new DependencyResolver(host).check(deps, signal);
	const openocd = report.statuses.find(s => s.id === serverId);
	const gdb = report.statuses.find(s => s.id === 'gdb');
	if (!openocd?.ok || !gdb?.ok || !openocd.command || !gdb.command) {
		throw new DebugStackError(`The debug tools are not ready: ${report.next} Run ensure_debug_tools first.`);
	}
	if (!path.isAbsolute(openocd.command) || !path.isAbsolute(gdb.command)) {
		throw new DebugStackError('Could not resolve the absolute paths of OpenOCD and GDB; run ensure_debug_tools to install them into the tool store.');
	}
	const scriptsDir = await host.system?.trustedDataDir?.(openocdScriptCandidates(openocd.command));
	if (!scriptsDir) {
		throw new DebugStackError(`OpenOCD's scripts folder next to ${openocd.command} was not found, or it is not protected (it must be in the tool store or root-owned). Run ensure_debug_tools to use the tool store's OpenOCD.`);
	}
	return { openocd: openocd.command, gdb: gdb.command, scriptsDir, interfaceScript, targetScript };
}

/** The chip's GDB alone (serial GDB stub and core dumps need no OpenOCD). */
export async function locateGdb(host: IAgentHost, target: TargetDescriptor, signal?: AbortSignal): Promise<string> {
	const deps = debugRequirements({ target, transport: 'serial' }).filter(d => d.id === 'gdb');
	const report = await new DependencyResolver(host).check(deps, signal);
	const gdb = report.statuses.find(s => s.id === 'gdb');
	if (!gdb?.ok || !gdb.command) {
		throw new DebugStackError(`GDB for ${target.part} is not ready: ${report.next} Run ensure_debug_tools first.`);
	}
	if (!path.isAbsolute(gdb.command)) {
		throw new DebugStackError('Could not resolve the absolute path of GDB; run ensure_debug_tools to install it into the tool store.');
	}
	return gdb.command;
}
