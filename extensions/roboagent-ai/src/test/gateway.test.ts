/*---------------------------------------------------------------------------------------------
 *  Copyright (c) RoboAgent. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as assert from 'assert';
import { buildRequestBody, formatAttachment, GatewayError, parseUiMessageStream, StreamEvent, streamChat } from '../gateway';

async function collect(events: AsyncIterable<StreamEvent>): Promise<StreamEvent[]> {
	const out: StreamEvent[] = [];
	for await (const event of events) {
		out.push(event);
	}
	return out;
}

async function* chunks(...parts: string[]): AsyncGenerator<Uint8Array> {
	for (const part of parts) {
		yield new TextEncoder().encode(part);
	}
}

/** The stream the live gateway returned for "Reply with exactly: OK". */
const SAMPLE = [
	'data: {"type":"start","messageId":"2dwsTTZoBPknfa9Q"}',
	'data: {"type":"start-step"}',
	'data: {"type":"reasoning-start","id":"reasoning-0"}',
	'data: {"type":"reasoning-delta","id":"reasoning-0","delta":"The user wants OK."}',
	'data: {"type":"reasoning-end","id":"reasoning-0"}',
	'data: {"type":"text-start","id":"txt-0"}',
	'data: {"type":"text-delta","id":"txt-0","delta":"O"}',
	'data: {"type":"text-delta","id":"txt-0","delta":"K"}',
	'data: {"type":"text-end","id":"txt-0"}',
	'data: {"type":"finish-step"}',
	'data: {"type":"finish","finishReason":"stop"}',
	'data: [DONE]',
].join('\n\n') + '\n\n';

suite('RoboAgent AI gateway', () => {

	test('request body is a Vercel AI SDK UI-message request', () => {
		const body = buildRequestBody([{ role: 'user', text: 'hi' }, { role: 'assistant', text: '' }, { role: 'assistant', text: 'hello' }, { role: 'user', text: 'blink an LED' }], 'chat1');
		assert.deepStrictEqual(body, {
			id: 'chat1',
			messages: [
				{ id: 'chat1-0', role: 'user', parts: [{ type: 'text', text: 'hi' }] },
				{ id: 'chat1-1', role: 'assistant', parts: [{ type: 'text', text: 'hello' }] },
				{ id: 'chat1-2', role: 'user', parts: [{ type: 'text', text: 'blink an LED' }] },
			],
			trigger: 'submit-message',
			messageId: 'chat1-2',
			mode: 'code',
		});
	});

	test('attachments use the website\'s path-tagged fence', () => {
		assert.strictEqual(formatAttachment('Sources/my main.c', 'int x;'), '\n\n``` path=Sources/my_main.c\nint x;\n```');
	});

	test('stream: text and reasoning deltas, finish, stops at [DONE], survives arbitrary chunking and CRLF', async () => {
		const expected: StreamEvent[] = [
			{ type: 'reasoning', delta: 'The user wants OK.' },
			{ type: 'text', delta: 'O' },
			{ type: 'text', delta: 'K' },
			{ type: 'finish', reason: 'stop' },
		];
		assert.deepStrictEqual(await collect(parseUiMessageStream(chunks(SAMPLE))), expected);
		const pieces = SAMPLE.match(/[\s\S]{1,7}/g)!;
		assert.deepStrictEqual(await collect(parseUiMessageStream(chunks(...pieces))), expected);
		assert.deepStrictEqual(await collect(parseUiMessageStream(chunks(SAMPLE.replace(/\n/g, '\r\n') + 'data: {"type":"text-delta","delta":"ignored after DONE"}\n\n'))), expected);
	});

	test('stream error events throw', async () => {
		await assert.rejects(collect(parseUiMessageStream(chunks('data: {"type":"error","errorText":"quota exceeded"}\n\n'))), (e: unknown) => e instanceof GatewayError && e.message === 'quota exceeded');
	});

	test('streamChat sends the bearer token and maps HTTP errors', async () => {
		let seen: { url: string; init: RequestInit } | undefined;
		const ok: typeof fetch = async (url, init) => {
			seen = { url: String(url), init: init! };
			return new Response(SAMPLE, { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
		};
		const body = buildRequestBody([{ role: 'user', text: 'x' }], 'c');
		const events = await collect(streamChat({ endpoint: 'https://example.test/api/chat', accessToken: 'tok', body, fetchImpl: ok }));
		assert.strictEqual(events.filter(e => e.type === 'text').map(e => (e as { delta: string }).delta).join(''), 'OK');
		assert.strictEqual(seen!.url, 'https://example.test/api/chat');
		assert.strictEqual((seen!.init.headers as Record<string, string>)['Authorization'], 'Bearer tok');
		assert.deepStrictEqual(JSON.parse(String(seen!.init.body)), body);

		const unauthorized: typeof fetch = async () => new Response('{"error":"invalid token"}', { status: 401 });
		await assert.rejects(collect(streamChat({ endpoint: 'x', accessToken: 'bad', body, fetchImpl: unauthorized })),
			(e: unknown) => e instanceof GatewayError && e.status === 401 && e.message === 'The AI service returned HTTP 401: invalid token');
		const gatewayDown: typeof fetch = async () => new Response('<html>503</html>', { status: 503 });
		await assert.rejects(collect(streamChat({ endpoint: 'x', accessToken: 't', body, fetchImpl: gatewayDown })),
			(e: unknown) => e instanceof GatewayError && e.message === 'The AI service returned HTTP 503');
	});

	test('streamChat gives up when the service does not answer or goes silent', async () => {
		const body = buildRequestBody([{ role: 'user', text: 'x' }], 'c');
		const hanging: typeof fetch = (_url, init) => new Promise((_resolve, reject) => {
			init!.signal!.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
		});
		await assert.rejects(collect(streamChat({ endpoint: 'x', accessToken: 't', body, fetchImpl: hanging, responseTimeoutMs: 50 })),
			(e: unknown) => e instanceof GatewayError && e.message.startsWith('The AI service did not respond in time'));

		const stalls: typeof fetch = async (_url, init) => new Response(new ReadableStream<Uint8Array>({
			start(controller) {
				controller.enqueue(new TextEncoder().encode('data: {"type":"text-delta","delta":"Hel"}\n\n'));
				init!.signal!.addEventListener('abort', () => controller.error(new DOMException('aborted', 'AbortError')));
			}
		}), { status: 200 });
		const seen: StreamEvent[] = [];
		await assert.rejects((async () => { for await (const e of streamChat({ endpoint: 'x', accessToken: 't', body, fetchImpl: stalls, idleTimeoutMs: 50 })) { seen.push(e); } })(),
			(e: unknown) => e instanceof GatewayError && e.message.startsWith('The AI service stopped responding'));
		assert.deepStrictEqual(seen, [{ type: 'text', delta: 'Hel' }]);

		const caller = new AbortController();
		const cancelled = collect(streamChat({ endpoint: 'x', accessToken: 't', body, fetchImpl: hanging, signal: caller.signal, responseTimeoutMs: 5000 }));
		caller.abort();
		await assert.rejects(cancelled, (e: unknown) => !(e instanceof GatewayError));
	});
});
