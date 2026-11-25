/*---------------------------------------------------------------------------------------------
 *  Copyright (c) RoboAgent. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { ISerialConnection } from '../../kernel/host';

export type { ISerialConnection, ISerialPorts, SerialPortInfo } from '../../kernel/host';

export interface CaptureOptions {
	/** Longest capture. */
	readonly durationMs: number;
	/** Stop early (after a short grace period for trailing lines) when the text matches. */
	readonly until?: RegExp;
	/** Bytes kept; older output is dropped (the end matters most: that is where a crash is). */
	readonly maxChars?: number;
	/** Sent once the port is open (e.g. a console command for the firmware). */
	readonly send?: string;
	readonly signal?: AbortSignal;
}

export interface CaptureResult {
	readonly text: string;
	readonly chars: number;
	/** Characters dropped from the start because of `maxChars`. */
	readonly dropped: number;
	readonly stoppedBy: 'pattern' | 'timeout' | 'cancelled';
}

/** Default cap on captured serial text (a core dump of a busy ESP32 app is ~100 KB of base64). */
export const DEFAULT_CAPTURE_CHARS = 1024 * 1024;
const GRACE_MS = 400;

/** Reads from an open port until `until` matches (plus a grace period), the time is up, or cancel. */
export function captureSerial(connection: ISerialConnection, options: CaptureOptions): Promise<CaptureResult> {
	const maxChars = options.maxChars ?? DEFAULT_CAPTURE_CHARS;
	return new Promise<CaptureResult>(resolve => {
		// Chunks in an array (joined once at the end) and a short tail for the pattern: linear in
		// the amount of output, however large the cap.
		const chunks: string[] = [];
		let kept = 0;
		let total = 0;
		let dropped = 0;
		let tail = '';
		let done = false;
		let grace: ReturnType<typeof setTimeout> | undefined;
		const finish = (stoppedBy: CaptureResult['stoppedBy']) => {
			if (done) {
				return;
			}
			done = true;
			clearTimeout(timer);
			clearTimeout(grace);
			options.signal?.removeEventListener('abort', onAbort);
			listener.dispose();
			let text = chunks.join('');
			if (text.length > maxChars) {
				dropped += text.length - maxChars;
				text = text.slice(text.length - maxChars);
			}
			resolve({ text, chars: total, dropped, stoppedBy });
		};
		const onAbort = () => finish('cancelled');
		const listener = connection.onData(chunk => {
			if (done) {
				return;
			}
			total += chunk.length;
			chunks.push(chunk);
			kept += chunk.length;
			// Drop whole chunks from the front while the rest still covers the cap.
			while (chunks.length > 1 && kept - chunks[0].length >= maxChars) {
				const first = chunks.shift()!;
				kept -= first.length;
				dropped += first.length;
			}
			if (options.until && !grace) {
				const window = tail + chunk;
				options.until.lastIndex = 0;
				if (options.until.test(window)) {
					grace = setTimeout(() => finish('pattern'), GRACE_MS);
				}
				tail = window.slice(-256);
			}
		});
		const timer = setTimeout(() => finish('timeout'), Math.max(0, options.durationMs));
		if (options.signal?.aborted) {
			finish('cancelled');
			return;
		}
		options.signal?.addEventListener('abort', onAbort, { once: true });
		if (options.send) {
			connection.write(options.send).catch(() => undefined);
		}
	});
}

/** Output that ends an ESP-IDF crash report: the chip halts, reboots, waits for GDB, or finished its core dump. */
export const ESP_CRASH_END = /CPU halted\.|Rebooting\.\.\.|Entering gdb stub now\.|= CORE DUMP END =|Panic handler entered multiple times|Brownout detector was triggered/;
