/*---------------------------------------------------------------------------------------------
 *  Copyright (c) RoboAgent. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { IAgentHost } from '../../kernel/host';
import { BuildArtifacts } from '../build/buildSystems';
import { ProjectInfo } from '../project';

export interface FlashOptions {
	/** Image to flash (workspace-relative); default: the only / first ELF of the build. */
	readonly artifact?: string;
	/** OpenOCD interface script, e.g. `stlink` (ST-Link V2/V3), `cmsis-dap`, `jlink`. */
	readonly probe?: string;
	/** Serial port for ESP32 / PlatformIO uploads, e.g. `/dev/ttyUSB0`. */
	readonly port?: string;
	readonly environment?: string;
	readonly signal?: AbortSignal;
}

export interface FlashResult {
	readonly ok: boolean;
	readonly flasher: string;
	readonly command: string;
	readonly exitCode: number | null;
	readonly verified: boolean;
	/** Plain-language cause when the output shows a known failure (no probe, no target power, …). */
	readonly problem?: string;
	readonly outputTail: string;
	readonly spawnError?: string;
}

export type ImagePick = { readonly ok: true; readonly image: string } | { readonly ok: false; readonly reason: string };

/** Port: one way to put an image on the target (Strategy). */
export interface IFlasher {
	readonly id: string;
	/** The image this flasher would use from the build output, or why it cannot flash. */
	pickImage(artifacts: BuildArtifacts, options: FlashOptions): ImagePick;
	flash(host: IAgentHost, project: ProjectInfo, image: string, options: FlashOptions): Promise<FlashResult>;
}

const FLASH_TIMEOUT_MS = 5 * 60 * 1000;

const KNOWN_PROBLEMS: readonly [RegExp, string][] = [
	// Checked first: OpenOCD prints LIBUSB_ERROR_ACCESS *and then* "open failed".
	[/LIBUSB_ERROR_ACCESS|permission denied/i, 'The probe is present but not accessible: install the udev rules for the probe (or run as a user in the plugdev group).'],
	[/open failed|unable to open|no st-?link (?:found|detected)|couldn't find any st-?link|LIBUSB_ERROR_NOT_FOUND|Couldn't find any ST-Link/i, 'No debug probe found: is the ST-Link (or other probe) plugged in, and do the udev rules allow access?'],
	[/target voltage may be too low|Target voltage .*0\.0|unknown chip id|init mode failed|Failed to read memory|Error: Error connecting DP/i, 'The probe cannot talk to the chip: check target power, SWDIO/SWCLK/GND wiring, and that BOOT0/reset are not holding it.'],
	[/Can't find (?:interface|target)\/|couldn't open .*\.cfg/i, 'OpenOCD cannot find a config script: the interface or target name is wrong for this OpenOCD install.'],
	[/A fatal error occurred: Failed to connect|No serial data received|could not open port/i, 'Cannot reach the ESP32 over serial: check the port, the cable, and whether the board needs BOOT held during reset.'],
];

function diagnose(output: string): string | undefined {
	return KNOWN_PROBLEMS.find(([re]) => re.test(output))?.[1];
}

/**
 * Path relative to the project directory, which is where the flash command runs. Never starts
 * with `-`, so a file named like an option cannot be taken for one.
 */
function relativeToProject(project: ProjectInfo, path: string): string {
	const prefix = project.dir === '.' ? '' : `${project.dir.replace(/\/+$/, '')}/`;
	const rel = prefix && path.startsWith(prefix) ? path.slice(prefix.length) : path;
	return rel.startsWith('-') ? `./${rel}` : rel;
}

abstract class CommandFlasher implements IFlasher {
	abstract readonly id: string;
	abstract pickImage(artifacts: BuildArtifacts, options: FlashOptions): ImagePick;
	protected abstract commands(project: ProjectInfo, image: string, options: FlashOptions): readonly (readonly [string, string[]])[];
	protected abstract isVerified(output: string): boolean;

	async flash(host: IAgentHost, project: ProjectInfo, image: string, options: FlashOptions): Promise<FlashResult> {
		let output = '';
		let last: { command: string; exitCode: number | null; spawnError?: string } = { command: '', exitCode: null };
		for (const [program, args] of this.commands(project, image, options)) {
			const r = await host.exec(program, args, {
				cwd: project.dir,
				timeoutMs: FLASH_TIMEOUT_MS,
				...options.signal ? { signal: options.signal } : {},
			});
			output += `${r.stdout}\n${r.stderr}\n`;
			last = { command: [program, ...args].join(' '), exitCode: r.exitCode, ...r.spawnError ? { spawnError: r.spawnError } : {} };
			if (r.exitCode !== 0 || r.spawnError) {
				break;
			}
		}
		const ok = last.exitCode === 0 && !last.spawnError;
		const problem = ok ? undefined : diagnose(output);
		return {
			ok,
			flasher: this.id,
			command: last.command,
			exitCode: last.exitCode,
			verified: ok && this.isVerified(output),
			...problem ? { problem } : {},
			outputTail: output.length > 3000 ? `…${output.slice(-3000)}` : output,
			...last.spawnError ? { spawnError: last.spawnError } : {},
		};
	}
}

/** Characters that would break out of OpenOCD's Tcl `program {…}` argument. */
const UNSAFE_TCL = /[{}\[\]$;\\\n\r"]/;

/** OpenOCD `program <elf> verify reset exit` over ST-Link (or another interface). */
export class OpenOcdFlasher extends CommandFlasher {
	readonly id = 'openocd';

	/** `flashBase` is where a raw `.bin` goes (ELF and HEX carry their own addresses). */
	constructor(private readonly targetConfig: string, private readonly flashBase?: string) {
		super();
	}

	pickImage(artifacts: BuildArtifacts, options: FlashOptions): ImagePick {
		const image = options.artifact ?? artifacts.elf[0] ?? artifacts.hex[0];
		if (!image) {
			return { ok: false, reason: 'No ELF or HEX image found; build an executable first (a static library cannot be flashed).' };
		}
		if (/\.bin$/i.test(image) && !this.flashBase) {
			return { ok: false, reason: 'A raw .bin has no load address; flash the ELF or HEX instead.' };
		}
		if (!/\.(elf|hex|bin)$/i.test(image)) {
			return { ok: false, reason: `"${image}" is not an ELF, HEX or BIN image.` };
		}
		if (UNSAFE_TCL.test(image)) {
			return { ok: false, reason: `The image path "${image}" contains characters OpenOCD cannot take safely; rename it.` };
		}
		return { ok: true, image };
	}

	private probeScript(options: FlashOptions): string {
		return `interface/${(options.probe ?? 'stlink').replace(/[^\w.-]/g, '')}.cfg`;
	}

	protected commands(project: ProjectInfo, image: string, options: FlashOptions): readonly (readonly [string, string[]])[] {
		const offset = /\.bin$/i.test(image) && this.flashBase ? ` ${this.flashBase}` : '';
		return [['openocd', ['-f', this.probeScript(options), '-f', this.targetConfig, '-c', `program {${relativeToProject(project, image)}}${offset} verify reset exit`]]];
	}

	/**
	 * OpenOCD resolves `-f interface/x.cfg` against the working directory before its own script
	 * folders, so a project that ships such a file would run its own Tcl. Refuse instead.
	 */
	override async flash(host: IAgentHost, project: ProjectInfo, image: string, options: FlashOptions): Promise<FlashResult> {
		for (const script of [this.probeScript(options), this.targetConfig]) {
			const local = project.dir === '.' ? script : `${project.dir}/${script}`;
			if (await host.fs.exists(local)) {
				return { ok: false, flasher: this.id, command: '', exitCode: null, verified: false, outputTail: '', problem: `The project contains "${local}", which OpenOCD would load instead of its own "${script}". Rename or remove it, or flash with st-flash.` };
			}
		}
		return super.flash(host, project, image, options);
	}

	protected isVerified(output: string): boolean {
		return /\*\* Verified OK \*\*/.test(output);
	}
}

/** stlink-tools `st-flash`: writes a raw binary at the flash base, converting the ELF first if needed. */
export class StFlashFlasher extends CommandFlasher {
	readonly id = 'st-flash';

	constructor(private readonly objcopy = 'arm-none-eabi-objcopy', private readonly flashBase = '0x08000000') {
		super();
	}

	pickImage(artifacts: BuildArtifacts, options: FlashOptions): ImagePick {
		// The ELF is what the build just produced; a .bin next to it may be older.
		const image = options.artifact ?? artifacts.elf[0] ?? artifacts.bin[0];
		if (image && !/\.(elf|bin)$/i.test(image)) {
			return { ok: false, reason: `st-flash takes an ELF (converted) or a raw BIN, not "${image}".` };
		}
		return image ? { ok: true, image } : { ok: false, reason: 'No ELF or BIN image found; build an executable first.' };
	}

	protected commands(project: ProjectInfo, image: string): readonly (readonly [string, string[]])[] {
		const rel = relativeToProject(project, image);
		if (rel.toLowerCase().endsWith('.elf')) {
			const bin = rel.replace(/\.elf$/i, '.bin');
			return [[this.objcopy, ['-O', 'binary', rel, bin]], ['st-flash', ['--reset', 'write', bin, this.flashBase]]];
		}
		return [['st-flash', ['--reset', 'write', rel, this.flashBase]]];
	}

	protected isVerified(output: string): boolean {
		return /Flash written and verified|jolly good/i.test(output);
	}
}

/** ESP-IDF `idf.py flash` (esptool with the project's own partition and offset table). */
export class EspIdfFlasher extends CommandFlasher {
	readonly id = 'idf.py';

	pickImage(artifacts: BuildArtifacts): ImagePick {
		return artifacts.bin.length || artifacts.elf.length ? { ok: true, image: 'build' } : { ok: false, reason: 'No build output; run the build first.' };
	}

	protected commands(_project: ProjectInfo, _image: string, options: FlashOptions): readonly (readonly [string, string[]])[] {
		return [['idf.py', [...options.port ? ['-p', options.port] : [], 'flash']]];
	}

	protected isVerified(output: string): boolean {
		return /Hash of data verified/i.test(output);
	}
}

/** PlatformIO `pio run -t upload` (uses the uploader configured in platformio.ini). */
export class PlatformIoFlasher extends CommandFlasher {
	readonly id = 'pio';

	pickImage(artifacts: BuildArtifacts): ImagePick {
		return artifacts.elf.length || artifacts.bin.length ? { ok: true, image: '.pio/build' } : { ok: false, reason: 'No build output; run the build first.' };
	}

	protected commands(_project: ProjectInfo, _image: string, options: FlashOptions): readonly (readonly [string, string[]])[] {
		return [['pio', ['run', '-t', 'upload', ...options.environment ? ['-e', options.environment] : [], ...options.port ? ['--upload-port', options.port] : []]]];
	}

	protected isVerified(output: string): boolean {
		return /Verified OK|Hash of data verified|\[SUCCESS\]/i.test(output);
	}
}

