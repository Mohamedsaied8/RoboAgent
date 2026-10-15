/*---------------------------------------------------------------------------------------------
 *  Copyright (c) RoboAgent. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { miString, MiTuple, parseMiLine, MiRecord } from './parser';

export class MiError extends Error {
	constructor(message: string, readonly kind: 'error' | 'timeout' | 'cancelled' | 'closed') {
		super(message);
		this.name = 'MiError';
	}
}

export interface MiResult {
	readonly resultClass: string;
	readonly results: MiTuple;
	/** Console (`~`) and target (`@`, e.g. OpenOCD `monitor` replies) output while the command ran. */
	readonly output: string;
}

export interface StopEvent {
	readonly reason?: string;
	readonly results: MiTuple;
}

export interface MiCommandOptions {
	readonly timeoutMs?: number;
	readonly signal?: AbortSignal;
}

interface Pending {
	readonly command: string;
	readonly output: string[];
	resolve(result: MiResult): void;
	reject(error: MiError): void;
}

interface StopWaiter {
	resolve(event: StopEvent): void;
	reject(error: MiError): void;
}

const DEFAULT_TIMEOUT_MS = 10_000;
/** Bytes kept for a line still being received; GDB never sends lines this long. */
const MAX_PARTIAL = 8 * 1024 * 1024;

/**
 * Talks GDB/MI over a text channel. Commands get numeric tokens, so replies are matched even
 * when GDB answers out of order; each has a timeout and can be cancelled. Tracks whether the
 * target is running from `*running` / `*stopped`. Stream output is attributed to the oldest
 * command still waiting (GDB runs commands one at a time).
 */
export class GdbMiClient {
	private nextToken = 1;
	private readonly pending = new Map<number, Pending>();
	private partial = '';
	private stopWaiters: StopWaiter[] = [];
	private closedReason: string | undefined;
	private _state: 'stopped' | 'running' | 'unknown' = 'unknown';
	private _lastStop: StopEvent | undefined;
	/** Console text that arrived with no command waiting (e.g. after `*stopped`). */
	private readonly unsolicited: string[] = [];

	constructor(
		private readonly write: (text: string) => void,
		private readonly onRecord?: (record: MiRecord) => void,
	) { }

	get state(): 'stopped' | 'running' | 'unknown' {
		return this._state;
	}

	get lastStop(): StopEvent | undefined {
		return this._lastStop;
	}

	/** Feeds raw stdout from GDB. */
	feed(chunk: string): void {
		const text = this.partial + chunk;
		const lines = text.split('\n');
		this.partial = lines.pop() ?? '';
		if (this.partial.length > MAX_PARTIAL) {
			this.partial = '';
		}
		for (const line of lines) {
			if (line.trim()) {
				this.handle(parseMiLine(line));
			}
		}
	}

	/** Takes the console text received outside any command. */
	drainUnsolicited(): string {
		return this.unsolicited.splice(0).join('');
	}

	/**
	 * Sends one MI command (without token) and resolves with its result record. `^error`
	 * rejects with the message GDB gave.
	 */
	send(command: string, options: MiCommandOptions = {}): Promise<MiResult> {
		if (this.closedReason !== undefined) {
			return Promise.reject(new MiError(`GDB is not running (${this.closedReason})`, 'closed'));
		}
		if (/[\r\n]/.test(command)) {
			return Promise.reject(new MiError('a debugger command cannot contain a line break', 'error'));
		}
		const token = this.nextToken++;
		return new Promise<MiResult>((resolve, reject) => {
			const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
			const cleanup = () => {
				clearTimeout(timer);
				options.signal?.removeEventListener('abort', onAbort);
				this.pending.delete(token);
			};
			const timer = setTimeout(() => {
				cleanup();
				reject(new MiError(`"${command.split(' ')[0]}" got no answer from GDB within ${timeoutMs} ms`, 'timeout'));
			}, timeoutMs);
			const onAbort = () => {
				cleanup();
				reject(new MiError('cancelled', 'cancelled'));
			};
			if (options.signal?.aborted) {
				onAbort();
				return;
			}
			options.signal?.addEventListener('abort', onAbort, { once: true });
			this.pending.set(token, {
				command,
				output: [],
				resolve: r => {
					cleanup();
					resolve(r);
				},
				reject: e => {
					cleanup();
					reject(e);
				},
			});
			this.write(`${token}${command}\n`);
		});
	}

	/**
	 * Waits for the next `*stopped`. Create the wait *before* sending the command that runs the
	 * target, or a fast stop could be missed: use {@link runUntilStop}.
	 */
	waitForStop(options: MiCommandOptions = {}): Promise<StopEvent> {
		if (this.closedReason !== undefined) {
			return Promise.reject(new MiError(`GDB is not running (${this.closedReason})`, 'closed'));
		}
		return new Promise<StopEvent>((resolve, reject) => {
			const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
			const waiter: StopWaiter = {
				resolve: e => {
					cleanup();
					resolve(e);
				},
				reject: e => {
					cleanup();
					reject(e);
				},
			};
			const cleanup = () => {
				clearTimeout(timer);
				options.signal?.removeEventListener('abort', onAbort);
				this.stopWaiters = this.stopWaiters.filter(w => w !== waiter);
			};
			const timer = setTimeout(() => waiter.reject(new MiError(`the target did not stop within ${timeoutMs} ms`, 'timeout')), timeoutMs);
			const onAbort = () => waiter.reject(new MiError('cancelled', 'cancelled'));
			if (options.signal?.aborted) {
				onAbort();
				return;
			}
			options.signal?.addEventListener('abort', onAbort, { once: true });
			this.stopWaiters.push(waiter);
		});
	}

	/** Sends a command that resumes the target and waits for it to stop again. */
	async runUntilStop(command: string, options: MiCommandOptions = {}): Promise<StopEvent> {
		const wait = new AbortController();
		const forward = () => wait.abort();
		options.signal?.addEventListener('abort', forward, { once: true });
		try {
			const stopped = this.waitForStop({ ...options, signal: wait.signal });
			stopped.catch(() => { }); // observed below; avoid an unhandled rejection if send fails first
			try {
				// The command's own reply (^running) gets the normal timeout, however short the stop wait is.
				await this.send(command, { ...options, timeoutMs: DEFAULT_TIMEOUT_MS });
			} catch (err) {
				wait.abort();
				throw err;
			}
			return await stopped;
		} finally {
			options.signal?.removeEventListener('abort', forward);
		}
	}

	/** Fails everything still waiting; later sends are refused. */
	close(reason: string): void {
		if (this.closedReason !== undefined) {
			return;
		}
		this.closedReason = reason;
		for (const p of [...this.pending.values()]) {
			p.reject(new MiError(`GDB exited (${reason}) while running "${p.command.split(' ')[0]}"`, 'closed'));
		}
		for (const w of [...this.stopWaiters]) {
			w.reject(new MiError(`GDB exited (${reason})`, 'closed'));
		}
		this._state = 'unknown';
	}

	private handle(record: MiRecord): void {
		this.onRecord?.(record);
		switch (record.kind) {
			case 'result': {
				const p = record.token !== undefined ? this.pending.get(record.token) : undefined;
				if (record.resultClass === 'running') {
					this._state = 'running';
				}
				if (!p) {
					return; // late reply to a command that timed out, or not ours
				}
				if (record.resultClass === 'error') {
					p.reject(new MiError(miString(record.results.msg) ?? 'GDB reported an error', 'error'));
				} else {
					p.resolve({ resultClass: record.resultClass, results: record.results, output: p.output.join('') });
				}
				return;
			}
			case 'exec':
				if (record.asyncClass === 'running') {
					this._state = 'running';
				} else if (record.asyncClass === 'stopped') {
					this._state = 'stopped';
					const reason = miString(record.results.reason);
					this._lastStop = { ...reason ? { reason } : {}, results: record.results };
					for (const w of [...this.stopWaiters]) {
						w.resolve(this._lastStop);
					}
				}
				return;
			case 'console':
			case 'target': {
				const oldest = this.pending.values().next();
				if (!oldest.done) {
					oldest.value.output.push(record.text);
				} else if (this.unsolicited.length < 200) {
					this.unsolicited.push(record.text);
				}
				return;
			}
			default:
				return;
		}
	}
}
