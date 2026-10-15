/*---------------------------------------------------------------------------------------------
 *  Copyright (c) RoboAgent. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as path from 'path';
import { IDisposable, toDisposable } from '../../kernel/disposable';
import { IAgentHost, IProcessHandle } from '../../kernel/host';
import { BreakpointBudget } from '../arch/cortexM';
import { diagnoseProbeProblem } from '../flash/flashers';

export class DebugServerError extends Error {
	constructor(message: string, readonly log?: string) {
		super(message);
		this.name = 'DebugServerError';
	}
}

/** Facts OpenOCD printed while starting. */
export interface OpenOcdInfo {
	/** GDB port it listens on (localhost only). */
	readonly port: number;
	/** e.g. `STLINK V2J48S7 (API v2) VID:PID 0483:3748`. */
	readonly probe?: string;
	readonly targetVoltage?: number;
	/** e.g. `Cortex-M3 r1p1`. */
	readonly core?: string;
	readonly budget?: BreakpointBudget;
}

export interface OpenOcdStartOptions {
	/** Absolute path of the OpenOCD program. */
	readonly program: string;
	/** OpenOCD's own scripts folder (absolute, trusted). */
	readonly scriptsDir: string;
	/** Relative to `scriptsDir`, e.g. `interface/stlink.cfg`. */
	readonly interfaceScript: string;
	/** Relative to `scriptsDir`, e.g. `target/stm32f1x.cfg`. */
	readonly targetScript: string;
	readonly timeoutMs?: number;
	readonly signal?: AbortSignal;
}

const SCRIPT_NAME = /^[\w-]+(?:\/[\w.-]+)*\.cfg$/;
const MAX_LOG_LINES = 400;

/** Checks a script name from configuration or the model: relative, inside the scripts folder. */
export function checkScriptName(name: string): string {
	if (!SCRIPT_NAME.test(name) || name.split('/').includes('..')) {
		throw new DebugServerError(`"${name}" is not an OpenOCD script name (expected e.g. interface/stlink.cfg).`);
	}
	return name;
}

/**
 * Runs OpenOCD as a GDB server for one session (localhost, an OS-assigned port, no Tcl or telnet
 * server). Scripts are passed as absolute paths into OpenOCD's own scripts folder, and OpenOCD
 * runs *in* that folder, so `source [find …]` can never pick up a file from the project.
 */
export class OpenOcdServer {
	private readonly logLines: string[] = [];

	private constructor(private readonly handle: IProcessHandle, readonly info: OpenOcdInfo, log: readonly string[]) {
		this.logLines.push(...log);
	}

	static async start(host: IAgentHost, options: OpenOcdStartOptions): Promise<OpenOcdServer> {
		if (!host.spawn) {
			throw new DebugServerError('This host cannot run long-lived programs, so it cannot start a debug session.');
		}
		const scriptPath = (name: string) => path.join(options.scriptsDir, checkScriptName(name));
		const args = [
			'-s', options.scriptsDir,
			'-f', scriptPath(options.interfaceScript),
			'-f', scriptPath(options.targetScript),
			'-c', 'bindto 127.0.0.1',
			'-c', 'gdb_port 0',
			'-c', 'tcl_port disabled',
			'-c', 'telnet_port disabled',
			// GDB must not program flash behind the agent's back (`load`); flashing is a Dev-agent tool.
			'-c', 'gdb_flash_program disable',
		];
		const log: string[] = [];
		const partial = { stdout: '', stderr: '' };
		let onLine: ((line: string) => void) | undefined;
		const handle = host.spawn(options.program, args, {
			trustedCwd: options.scriptsDir,
			// A user-level OPENOCD_SCRIPTS could add a search folder ahead of the trusted one.
			unsetEnv: ['OPENOCD_SCRIPTS'],
			onOutput: (stream, chunk) => {
				const lines = (partial[stream] + chunk).split('\n');
				partial[stream] = lines.pop() ?? '';
				for (const raw of lines) {
					const line = raw.replace(/\r$/, '');
					log.push(line);
					if (log.length > MAX_LOG_LINES) {
						log.splice(0, log.length - MAX_LOG_LINES);
					}
					onLine?.(line);
				}
			},
		});

		const info: { port?: number; probe?: string; targetVoltage?: number; core?: string; budget?: BreakpointBudget } = {};
		const ready = new Promise<number>((resolve, reject) => {
			onLine = line => {
				let m: RegExpExecArray | null;
				if ((m = /Listening on port (\d+) for gdb connections/.exec(line))) {
					resolve(Number(m[1]));
				} else if ((m = /(?:STLINK|ST-LINK)\s+(\S+.*VID:PID\s+\S+)/i.exec(line))) {
					info.probe = `STLINK ${m[1]}`;
				} else if ((m = /Target voltage:\s*([\d.]+)/.exec(line))) {
					info.targetVoltage = Number(m[1]);
				} else if ((m = /(Cortex-M\S*\s+r\dp\d)\s+processor detected/.exec(line))) {
					info.core = m[1];
				} else if ((m = /target has (\d+) breakpoints, (\d+) watchpoints/.exec(line))) {
					info.budget = { breakpoints: Number(m[1]), watchpoints: Number(m[2]) };
				}
			};
			void handle.exited.then(e => reject(new DebugServerError(`OpenOCD stopped before it was ready (${e.spawnError ?? `exit ${e.exitCode}`}).`)));
		});

		const timeoutMs = options.timeoutMs ?? 20_000;
		let timer: ReturnType<typeof setTimeout> | undefined;
		let onAbort: (() => void) | undefined;
		const abort = new Promise<never>((_, reject) => {
			timer = setTimeout(() => reject(new DebugServerError(`OpenOCD was not ready within ${timeoutMs} ms.`)), timeoutMs);
			onAbort = () => reject(new DebugServerError('cancelled'));
			if (options.signal?.aborted) {
				onAbort();
			}
			options.signal?.addEventListener('abort', onAbort, { once: true });
		});
		abort.catch(() => { });
		ready.catch(() => { });
		try {
			info.port = await Promise.race([ready, abort]);
		} catch (err) {
			await handle.kill();
			const text = log.join('\n');
			const problem = diagnoseProbeProblem(text);
			const errors = log.filter(l => /^Error/.test(l)).slice(-5).join(' | ');
			throw new DebugServerError(`${err instanceof Error ? err.message : String(err)}${problem ? ` ${problem}` : ''}${errors ? ` OpenOCD said: ${errors}` : ''}`, text.slice(-4000));
		} finally {
			clearTimeout(timer);
			if (onAbort) {
				options.signal?.removeEventListener('abort', onAbort);
			}
		}
		return new OpenOcdServer(handle, { ...info, port: info.port }, log);
	}

	get exited(): Promise<unknown> {
		return this.handle.exited;
	}

	/** The last lines OpenOCD printed (for error reports). */
	tail(lines = 20): string {
		return this.logLines.slice(-lines).join('\n');
	}

	async stop(): Promise<void> {
		await this.handle.kill();
	}
}

/** One holder per probe, inside this process (several agents share one host). */
const probeOwners = new Map<string, string>();

export class ProbeBusyError extends Error {
	constructor(probe: string, owner: string) {
		super(`The ${probe} probe is in use by ${owner}; end that session first.`);
		this.name = 'ProbeBusyError';
	}
}

/** Takes the probe lock for `owner`; dispose to release. Throws {@link ProbeBusyError} when taken. */
export function acquireProbe(probe: string, owner: string): IDisposable {
	const current = probeOwners.get(probe);
	if (current !== undefined) {
		throw new ProbeBusyError(probe, current);
	}
	probeOwners.set(probe, owner);
	let released = false;
	return toDisposable(() => {
		if (!released && probeOwners.get(probe) === owner) {
			probeOwners.delete(probe);
		}
		released = true;
	});
}
