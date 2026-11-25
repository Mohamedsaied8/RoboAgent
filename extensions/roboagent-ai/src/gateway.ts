/*---------------------------------------------------------------------------------------------
 *  Copyright (c) RoboAgent. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/*---------------------------------------------------------------------------------------------
 *  RoboAgent — client for the Robotics Corner AI chat gateway (pure, no vscode).
 *
 *  The gateway is the one behind https://www.roboticscorner.tech/roboagent: a Vercel AI SDK
 *  (v5) chat route. Request: `POST {id, messages: UIMessage[], trigger, messageId, mode}` where a
 *  UIMessage is `{id, role, parts: [{type: 'text', text}]}`. Response: an SSE "UI message stream"
 *  (`x-vercel-ai-ui-message-stream: v1`) of `data: {type: 'text-delta', delta, …}` events ending
 *  with `data: [DONE]`. The RoboAgent account's access token goes in `Authorization: Bearer`.
 *--------------------------------------------------------------------------------------------*/

export const DEFAULT_ENDPOINT = 'https://www.roboticscorner.tech/roboagent/api/chat';

export type Role = 'user' | 'assistant';

export interface ChatTurn {
	readonly role: Role;
	readonly text: string;
}

export interface UiMessage {
	readonly id: string;
	readonly role: Role;
	readonly parts: readonly { readonly type: 'text'; readonly text: string }[];
}

export interface ChatRequestBody {
	readonly id: string;
	readonly messages: readonly UiMessage[];
	readonly trigger: 'submit-message';
	readonly messageId: string;
	/** The website's modes: `code` answers with code/files, `plan` plans first. */
	readonly mode: 'code' | 'plan';
}

export type StreamEvent =
	| { readonly type: 'text'; readonly delta: string }
	| { readonly type: 'reasoning'; readonly delta: string }
	| { readonly type: 'finish'; readonly reason?: string };

/** An HTTP or stream-level failure; `status` is set for HTTP errors (401/403 mean "sign in again"). */
export class GatewayError extends Error {
	constructor(message: string, readonly status?: number) {
		super(message);
		this.name = 'GatewayError';
	}
}

function randomId(): string {
	return Math.random().toString(36).slice(2, 12) + Date.now().toString(36);
}

export function buildRequestBody(turns: readonly ChatTurn[], chatId: string = randomId(), mode: ChatRequestBody['mode'] = 'code'): ChatRequestBody {
	const messages = turns
		.filter(t => t.text.trim().length > 0)
		.map((t, i): UiMessage => ({ id: `${chatId}-${i}`, role: t.role, parts: [{ type: 'text', text: t.text }] }));
	const last = messages[messages.length - 1];
	return { id: chatId, messages, trigger: 'submit-message', messageId: last?.id ?? `${chatId}-0`, mode };
}

/** Attach a file to a prompt the way the website does: a fenced block tagged with its path. */
export function formatAttachment(path: string, content: string): string {
	return `\n\n\`\`\` path=${path.replace(/\s+/g, '_')}\n${content}\n\`\`\``;
}

/**
 * Parses an SSE UI-message stream. Chunks may split events anywhere; unknown event types are
 * ignored; an `error` event throws.
 */
export async function* parseUiMessageStream(chunks: AsyncIterable<Uint8Array | string>): AsyncGenerator<StreamEvent> {
	const decoder = new TextDecoder();
	let buffer = '';
	const handle = function* (block: string): Generator<StreamEvent, boolean> {
		for (const line of block.split(/\r?\n/)) {
			if (!line.startsWith('data:')) {
				continue;
			}
			const data = line.slice(5).trim();
			if (data === '[DONE]') {
				return true;
			}
			let event: { type?: string; delta?: string; errorText?: string; finishReason?: string };
			try {
				event = JSON.parse(data);
			} catch {
				continue;
			}
			switch (event.type) {
				case 'text-delta':
					if (event.delta) { yield { type: 'text', delta: event.delta }; }
					break;
				case 'reasoning-delta':
					if (event.delta) { yield { type: 'reasoning', delta: event.delta }; }
					break;
				case 'error':
					throw new GatewayError(event.errorText || 'The AI service reported an error.');
				case 'finish':
					yield { type: 'finish', reason: event.finishReason };
					break;
			}
		}
		return false;
	};
	for await (const chunk of chunks) {
		buffer += typeof chunk === 'string' ? chunk : decoder.decode(chunk, { stream: true });
		let separator: RegExpExecArray | null;
		while ((separator = /\r?\n\r?\n/.exec(buffer))) {
			const block = buffer.slice(0, separator.index);
			buffer = buffer.slice(separator.index + separator[0].length);
			if (yield* handle(block)) {
				return;
			}
		}
	}
	if (buffer.trim()) {
		yield* handle(buffer);
	}
}

export interface SendOptions {
	readonly endpoint: string;
	readonly accessToken: string;
	readonly body: ChatRequestBody;
	readonly signal?: AbortSignal;
	readonly fetchImpl?: typeof fetch;
	/** How long to wait for the response to start. */
	readonly responseTimeoutMs?: number;
	/** How long the stream may stay silent before it is given up. */
	readonly idleTimeoutMs?: number;
}

// The gateway's model can take over a minute before its first byte (68 s observed).
export const RESPONSE_TIMEOUT_MS = 180_000;
export const IDLE_TIMEOUT_MS = 180_000;

/** Sends a chat request and yields the streamed events. */
export async function* streamChat(options: SendOptions): AsyncGenerator<StreamEvent> {
	const doFetch = options.fetchImpl ?? fetch;
	// One controller covers the caller's cancellation and both timeouts.
	const controller = new AbortController();
	let timedOut: string | undefined;
	let timer: ReturnType<typeof setTimeout> | undefined;
	const arm = (ms: number, message: string) => {
		clearTimeout(timer);
		timer = setTimeout(() => { timedOut = message; controller.abort(); }, ms);
	};
	const onCallerAbort = () => controller.abort();
	options.signal?.addEventListener('abort', onCallerAbort);
	const timeoutError = () => new GatewayError(timedOut!);
	try {
		arm(options.responseTimeoutMs ?? RESPONSE_TIMEOUT_MS, 'The AI service did not respond in time. Try again in a moment.');
		let response: Response;
		try {
			response = await doFetch(options.endpoint, {
				method: 'POST',
				headers: {
					'Content-Type': 'application/json',
					'Accept': 'text/event-stream',
					'Authorization': `Bearer ${options.accessToken}`,
				},
				body: JSON.stringify(options.body),
				signal: controller.signal,
			});
		} catch (e) {
			throw timedOut ? timeoutError() : e;
		}
		yield* readResponse(response, options.idleTimeoutMs ?? IDLE_TIMEOUT_MS, arm, () => timedOut ? timeoutError() : undefined);
	} finally {
		clearTimeout(timer);
		options.signal?.removeEventListener('abort', onCallerAbort);
	}
}

async function* readResponse(response: Response, idleTimeoutMs: number, arm: (ms: number, message: string) => void, timeoutError: () => GatewayError | undefined): AsyncGenerator<StreamEvent> {
	if (!response.ok) {
		let detail = '';
		try {
			detail = (await response.text()).trim();
			const json = JSON.parse(detail) as { error?: string; message?: string };
			detail = json.error || json.message || detail;
		} catch {
			// keep the raw text
		}
		const html = /^\s*</.test(detail);
		throw new GatewayError(`The AI service returned HTTP ${response.status}${detail && !html ? `: ${detail.slice(0, 300)}` : ''}`, response.status);
	}
	if (!response.body) {
		throw new GatewayError('The AI service returned an empty response.');
	}
	const idleMessage = 'The AI service stopped responding in the middle of the answer.';
	arm(idleTimeoutMs, idleMessage);
	const body = response.body as unknown as AsyncIterable<Uint8Array>;
	const watched = async function* () {
		for await (const chunk of body) {
			arm(idleTimeoutMs, idleMessage);
			yield chunk;
		}
	};
	try {
		yield* parseUiMessageStream(watched());
	} catch (e) {
		throw timeoutError() ?? e;
	}
}
