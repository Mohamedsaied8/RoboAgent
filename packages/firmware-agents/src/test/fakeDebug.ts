/*---------------------------------------------------------------------------------------------
 *  Copyright (c) RoboAgent. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { readFileSync } from 'fs';
import * as path from 'path';
import { IProcessHandle, ProcessExit, SpawnOptions } from '../kernel/host';

/** A scripted long-lived process: tests push its output and see what was written to it. */
export class FakeProcess implements IProcessHandle {
	readonly pid = 4242;
	readonly written: string[] = [];
	readonly exited: Promise<ProcessExit>;
	private resolveExit!: (e: ProcessExit) => void;
	private done = false;

	constructor(private readonly options: SpawnOptions, private readonly onWrite?: (line: string, process: FakeProcess) => void) {
		this.exited = new Promise(r => this.resolveExit = r);
	}

	emit(stream: 'stdout' | 'stderr', text: string): void {
		if (!this.done) {
			this.options.onOutput?.(stream, text);
		}
	}

	write(text: string): void {
		if (this.done) {
			return;
		}
		this.written.push(text);
		for (const line of text.split('\n').filter(Boolean)) {
			this.onWrite?.(line, this);
		}
	}

	exit(exitCode: number | null): void {
		if (!this.done) {
			this.done = true;
			this.resolveExit({ exitCode });
		}
	}

	kill(): Promise<ProcessExit> {
		this.exit(null);
		return this.exited;
	}
}

/** OpenOCD's real start-up output with an ST-Link V2 and a Blue Pill (STM32F103C8T6), recorded 2026-10-15. */
export function openocdStartupLines(port = 46273): string[] {
	return [
		'xPack Open On-Chip Debugger 0.12.0+dev-02228-ge5888bda3-dirty (2025-10-04-22:42)',
		'Info : STLINK V2J48S7 (API v2) VID:PID 0483:3748',
		'Info : Target voltage: 3.280645',
		'Info : clock speed 950 kHz',
		'Info : SWD DPIDR 0x1ba01477',
		'Info : [stm32f1x.cpu] Cortex-M3 r1p1 processor detected',
		'Info : [stm32f1x.cpu] target has 6 breakpoints, 4 watchpoints',
		'Info : [stm32f1x.cpu] Examination succeed',
		'Info : [stm32f1x.cpu] starting gdb server on 0',
		`Info : Listening on port ${port} for gdb connections`,
	];
}

/** A fake OpenOCD that prints `lines` (stderr, as OpenOCD does) right after it starts, then stays up. */
export function fakeOpenOcd(options: SpawnOptions, lines: readonly string[], exitAfter?: number | null): FakeProcess {
	const p = new FakeProcess(options);
	setImmediate(() => {
		p.emit('stderr', lines.map(l => `${l}\n`).join(''));
		if (exitAfter !== undefined) {
			p.exit(exitAfter);
		}
	});
	return p;
}

interface Exchange {
	readonly command: string;
	readonly output: readonly string[];
}

/**
 * The recorded MI session (`> ` lines went to GDB, `< ` lines came back), split into one
 * exchange per command with the output that followed it.
 */
export function loadTranscript(name: string): Exchange[] {
	const text = readFileSync(path.resolve(__dirname, '..', '..', 'src', 'test', 'fixtures', name), 'utf8');
	const exchanges: { command: string; output: string[] }[] = [];
	let preamble: string[] = [];
	for (const line of text.split('\n')) {
		if (line.startsWith('> ')) {
			exchanges.push({ command: line.slice(2).replace(/^\d+/, ''), output: [] });
		} else if (line.startsWith('< ')) {
			(exchanges.at(-1)?.output ?? preamble).push(line.slice(2));
		}
	}
	preamble = [];
	return exchanges;
}

/** Normalises what may differ between the recording and a replay (the OS-assigned port). */
function normalize(command: string): string {
	return command.replace(/^-target-select remote 127\.0\.0\.1:\d+$/, '-target-select remote 127.0.0.1:PORT');
}

/**
 * GDB replaying a recorded session: each command must be the next one of the recording (else
 * the replay records a mismatch and answers with an MI error); its recorded output is sent back
 * with the new command's token.
 */
export class TranscriptGdb {
	readonly mismatches: string[] = [];
	private next = 0;

	constructor(private readonly exchanges: readonly Exchange[]) { }

	get remaining(): number {
		return this.exchanges.length - this.next;
	}

	spawn(options: SpawnOptions): FakeProcess {
		return new FakeProcess(options, (line, p) => {
			const m = /^(\d+)(.*)$/.exec(line);
			const token = m?.[1] ?? '';
			const command = m?.[2] ?? line;
			const expected = this.exchanges[this.next];
			if (!expected || normalize(expected.command) !== normalize(command)) {
				this.mismatches.push(`#${this.next + 1}: expected ${expected?.command ?? '(end of recording)'}, got ${command}`);
				setImmediate(() => p.emit('stdout', `${token}^error,msg="replay mismatch"\n(gdb) \n`));
				return;
			}
			this.next++;
			const out = expected.output.map(l => l.replace(/^\d+(?=[\^*+=])/, token)).map(l => `${l}\n`).join('');
			setImmediate(() => {
				p.emit('stdout', out);
				if (command === '-gdb-exit') {
					p.exit(0);
				}
			});
		});
	}
}

/**
 * A GDB answering from a function: `respond(command)` returns the MI lines to send back, where
 * `TOKEN` stands for the command's token. Default answers cover the session start-up.
 */
export function scriptedGdb(options: SpawnOptions, respond: (command: string) => string | undefined = () => undefined): FakeProcess {
	return new FakeProcess(options, (line, p) => {
		const [, token, command] = /^(\d+)(.*)$/.exec(line)!;
		const custom = respond(command);
		const reply = custom !== undefined ? custom
			: command.startsWith('-target-select') ? '*stopped,frame={addr="0x08000026"}\nTOKEN^connected'
				: command === '-gdb-exit' ? 'TOKEN^exit' : 'TOKEN^done';
		setImmediate(() => p.emit('stdout', `${reply.replace(/TOKEN/g, token)}\n(gdb) \n`));
	});
}
