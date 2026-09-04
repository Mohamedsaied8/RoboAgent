/*---------------------------------------------------------------------------------------------
 *  Copyright (c) RoboAgent. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/*---------------------------------------------------------------------------------------------
 *  RoboAgent — the shared "RoboAgent" output channel. Every mode handler logs here so a user
 *  (or a bug report) has one place to look; notifications stay for things that need a decision.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';

let channel: vscode.OutputChannel | undefined;

export function getOutputChannel(): vscode.OutputChannel {
	channel ??= vscode.window.createOutputChannel('RoboAgent');
	return channel;
}

export function log(message: string): void {
	getOutputChannel().appendLine(`[${new Date().toISOString()}] ${message}`);
}

export function logError(message: string, error?: unknown): void {
	const detail = error instanceof Error ? ` ${error.message}` : error !== undefined ? ` ${String(error)}` : '';
	log(`ERROR ${message}${detail}`);
}
