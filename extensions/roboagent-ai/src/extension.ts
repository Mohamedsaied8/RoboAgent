/*---------------------------------------------------------------------------------------------
 *  Copyright (c) RoboAgent. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/*---------------------------------------------------------------------------------------------
 *  RoboAgent AI — the Chat panel's default participant and the "RoboAgent" language model,
 *  both backed by the Robotics Corner AI gateway (see gateway.ts) and authorised with the
 *  signed-in RoboAgent account (the workbench's `roboagent` authentication provider).
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { buildRequestBody, ChatTurn, DEFAULT_ENDPOINT, formatAttachment, GatewayError, streamChat } from './gateway';

const AUTH_PROVIDER_ID = 'roboagent';
const PARTICIPANT_ID = 'roboagent.default';
const SIGN_IN_COMMAND = 'roboagent.signIn';
const MAX_ATTACHMENT_BYTES = 300 * 1024;

let output: vscode.LogOutputChannel | undefined;

function log(message: string): void {
	output?.info(message);
}

function endpoint(): string {
	return vscode.workspace.getConfiguration('roboagent.ai').get<string>('endpoint')?.trim() || DEFAULT_ENDPOINT;
}

async function accessToken(): Promise<string | undefined> {
	try {
		return (await vscode.authentication.getSession(AUTH_PROVIDER_ID, [], { silent: true }))?.accessToken;
	} catch (e) {
		log(`getSession(${AUTH_PROVIDER_ID}) failed: ${e instanceof Error ? e.message : String(e)}`);
		return undefined;
	}
}

// --- Chat participant ------------------------------------------------------------------------

async function referenceText(reference: vscode.ChatPromptReference): Promise<string | undefined> {
	const value = reference.value;
	try {
		if (value instanceof vscode.Uri) {
			const bytes = await vscode.workspace.fs.readFile(value);
			if (bytes.byteLength > MAX_ATTACHMENT_BYTES || bytes.includes(0)) {
				return undefined;
			}
			return formatAttachment(vscode.workspace.asRelativePath(value), new TextDecoder().decode(bytes));
		}
		if (value instanceof vscode.Location) {
			const document = await vscode.workspace.openTextDocument(value.uri);
			const range = value.range.isEmpty ? undefined : value.range;
			const label = `${vscode.workspace.asRelativePath(value.uri)}${range ? `#L${range.start.line + 1}-L${range.end.line + 1}` : ''}`;
			return formatAttachment(label, document.getText(range));
		}
		if (typeof value === 'string') {
			return `\n\n${value}`;
		}
	} catch (e) {
		log(`Could not read reference ${reference.id}: ${e instanceof Error ? e.message : String(e)}`);
	}
	return undefined;
}

function responseText(turn: vscode.ChatResponseTurn): string {
	return turn.response
		.map(part => part instanceof vscode.ChatResponseMarkdownPart ? part.value.value : '')
		.join('');
}

async function toTurns(request: vscode.ChatRequest, context: vscode.ChatContext): Promise<ChatTurn[]> {
	const turns: ChatTurn[] = [];
	for (const turn of context.history) {
		if (turn.participant !== PARTICIPANT_ID) {
			continue;
		}
		if (turn instanceof vscode.ChatRequestTurn) {
			turns.push({ role: 'user', text: turn.prompt });
		} else if (turn instanceof vscode.ChatResponseTurn) {
			turns.push({ role: 'assistant', text: responseText(turn) });
		}
	}
	let prompt = request.prompt;
	for (const reference of request.references) {
		prompt += await referenceText(reference) ?? '';
	}
	turns.push({ role: 'user', text: prompt });
	return turns;
}

function signInPrompt(stream: vscode.ChatResponseStream, message: string): vscode.ChatResult {
	stream.markdown(message);
	stream.button({ command: SIGN_IN_COMMAND, title: vscode.l10n.t('Sign In to RoboAgent') });
	return {};
}

const handleChatRequest: vscode.ChatRequestHandler = async (request, context, stream, token) => {
	const bearer = await accessToken();
	if (!bearer) {
		return signInPrompt(stream, vscode.l10n.t('Sign in with your RoboAgent account (roboticscorner.tech/roboagent) to use the AI assistant.'));
	}

	const abort = new AbortController();
	const cancel = token.onCancellationRequested(() => abort.abort());
	stream.progress(vscode.l10n.t('Thinking…'));
	try {
		const body = buildRequestBody(await toTurns(request, context));
		log(`chat request: ${body.messages.length} message(s) to ${endpoint()}`);
		for await (const event of streamChat({ endpoint: endpoint(), accessToken: bearer, body, signal: abort.signal })) {
			if (event.type === 'text') {
				stream.markdown(event.delta);
			}
		}
		return {};
	} catch (e) {
		if (token.isCancellationRequested) {
			return {};
		}
		if (e instanceof GatewayError && (e.status === 401 || e.status === 403)) {
			return signInPrompt(stream, vscode.l10n.t('Your RoboAgent session was not accepted by the AI service. Sign in again to continue.'));
		}
		const message = e instanceof Error ? e.message : String(e);
		log(`chat request failed: ${message}`);
		return { errorDetails: { message: vscode.l10n.t('RoboAgent AI request failed: {0}', message) } };
	} finally {
		cancel.dispose();
	}
};

// --- Language model provider -----------------------------------------------------------------

/** `isDefault` / `isUserSelectable` come from the `chatProvider` proposal: the chat panel only sends requests with a default (or picked) model. */
const MODEL: vscode.LanguageModelChatInformation & { readonly isDefault: boolean; readonly isUserSelectable: boolean } = {
	id: 'roboagent',
	name: 'RoboAgent',
	family: 'roboagent',
	version: '1.0.0',
	tooltip: 'The Robotics Corner RoboAgent model',
	maxInputTokens: 128000,
	maxOutputTokens: 16000,
	// Agent mode only offers models that declare tool calling. RoboAgent AI answers without tools;
	// declaring it keeps the model usable in every chat mode.
	capabilities: { toolCalling: true },
	isDefault: true,
	isUserSelectable: true,
};

function messageText(message: vscode.LanguageModelChatRequestMessage): string {
	return message.content.map(part => part instanceof vscode.LanguageModelTextPart ? part.value : '').join('');
}

const modelProvider: vscode.LanguageModelChatProvider = {
	provideLanguageModelChatInformation: () => [MODEL],

	async provideLanguageModelChatResponse(_model, messages, _options, progress, token) {
		const bearer = await accessToken();
		if (!bearer) {
			throw new Error(vscode.l10n.t('Sign in to RoboAgent to use the RoboAgent model.'));
		}
		const turns: ChatTurn[] = messages.map(m => ({ role: m.role === vscode.LanguageModelChatMessageRole.Assistant ? 'assistant' : 'user', text: messageText(m) }));
		const abort = new AbortController();
		const cancel = token.onCancellationRequested(() => abort.abort());
		try {
			for await (const event of streamChat({ endpoint: endpoint(), accessToken: bearer, body: buildRequestBody(turns), signal: abort.signal })) {
				if (event.type === 'text') {
					progress.report(new vscode.LanguageModelTextPart(event.delta));
				}
			}
		} finally {
			cancel.dispose();
		}
	},

	async provideTokenCount(_model, text) {
		const value = typeof text === 'string' ? text : messageText(text);
		return Math.ceil(value.length / 4);
	},
};

export function activate(context: vscode.ExtensionContext): void {
	output = vscode.window.createOutputChannel('RoboAgent AI', { log: true });
	const participant = vscode.chat.createChatParticipant(PARTICIPANT_ID, handleChatRequest);
	participant.iconPath = new vscode.ThemeIcon('hubot');
	context.subscriptions.push(
		output,
		participant,
		vscode.lm.registerLanguageModelChatProvider('roboagent', modelProvider),
	);
	log('RoboAgent AI activated');
}

export function deactivate(): void {
	// Disposables are tracked on context.subscriptions.
}
