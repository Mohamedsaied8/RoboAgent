/*---------------------------------------------------------------------------------------------
 *  Copyright (c) RoboAgent. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/*---------------------------------------------------------------------------------------------
 *  RoboAgent — reusable wizard steps (QuickPick / InputBox with Back + cancel semantics).
 *
 *  Every step resolves to the chosen value, {@link BACK} when the user pressed the Back button,
 *  or undefined when the step was dismissed (Escape / focus out) — the caller treats undefined
 *  as "cancel the whole wizard". Shared by the New-Project wizard and the per-mode Create
 *  wizards.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';

/** Sentinel returned by a step when the user pressed Back. */
export const BACK = Symbol('back');

export type StepResult<T> = T | typeof BACK | undefined;

export interface StepItem<T> extends vscode.QuickPickItem {
	value: T;
}

export interface PickStepOptions {
	readonly title: string;
	readonly step?: number;
	readonly totalSteps?: number;
	readonly placeholder?: string;
	readonly canGoBack?: boolean;
	/** Keep the typed filter text as a free-form answer (see {@link pickOrTypeStep}). */
	readonly matchOnDescription?: boolean;
}

/** One QuickPick step. */
export function pickStep<T>(options: PickStepOptions, items: StepItem<T>[], activeValue?: T): Promise<StepResult<T>> {
	return new Promise(resolve => {
		const qp = vscode.window.createQuickPick<StepItem<T>>();
		qp.title = options.title;
		qp.step = options.step;
		qp.totalSteps = options.totalSteps;
		qp.placeholder = options.placeholder;
		qp.matchOnDescription = options.matchOnDescription ?? false;
		qp.items = items;
		if (activeValue !== undefined) {
			const active = items.find(i => i.value === activeValue);
			if (active) { qp.activeItems = [active]; }
		}
		qp.ignoreFocusOut = true;
		qp.buttons = options.canGoBack ? [vscode.QuickInputButtons.Back] : [];
		let done = false;
		qp.onDidTriggerButton(b => {
			if (b === vscode.QuickInputButtons.Back) { done = true; resolve(BACK); qp.hide(); }
		});
		qp.onDidAccept(() => {
			const sel = qp.selectedItems[0];
			if (sel) { done = true; resolve(sel.value); qp.hide(); }
		});
		qp.onDidHide(() => { if (!done) { resolve(undefined); } qp.dispose(); });
		qp.show();
	});
}

/**
 * A searchable QuickPick that also accepts free text: when the filter matches nothing (or the
 * user accepts with no selection), the typed text itself is the answer. Used for the MCU picker.
 */
export function pickOrTypeStep(options: PickStepOptions, items: StepItem<string>[], validateFreeText: (v: string) => string | undefined, activeValue?: string): Promise<StepResult<string>> {
	return new Promise(resolve => {
		const qp = vscode.window.createQuickPick<StepItem<string>>();
		qp.title = options.title;
		qp.step = options.step;
		qp.totalSteps = options.totalSteps;
		qp.placeholder = options.placeholder;
		qp.matchOnDescription = true;
		qp.matchOnDetail = true;
		qp.items = items;
		if (activeValue !== undefined) {
			const active = items.find(i => i.value === activeValue);
			if (active) { qp.activeItems = [active]; } else { qp.value = activeValue; }
		}
		qp.ignoreFocusOut = true;
		qp.buttons = options.canGoBack ? [vscode.QuickInputButtons.Back] : [];
		let done = false;
		qp.onDidTriggerButton(b => {
			if (b === vscode.QuickInputButtons.Back) { done = true; resolve(BACK); qp.hide(); }
		});
		qp.onDidAccept(() => {
			const sel = qp.selectedItems[0];
			if (sel) { done = true; resolve(sel.value); qp.hide(); return; }
			const typed = qp.value.trim();
			const message = validateFreeText(typed);
			if (message) { qp.title = `${options.title} — ${message}`; return; }
			done = true; resolve(typed); qp.hide();
		});
		qp.onDidHide(() => { if (!done) { resolve(undefined); } qp.dispose(); });
		qp.show();
	});
}

/** A multi-select QuickPick step; resolves to the selected values (possibly empty). */
export function multiPickStep<T>(options: PickStepOptions, items: StepItem<T>[], preselected: readonly T[] = []): Promise<StepResult<T[]>> {
	return new Promise(resolve => {
		const qp = vscode.window.createQuickPick<StepItem<T>>();
		qp.title = options.title;
		qp.step = options.step;
		qp.totalSteps = options.totalSteps;
		qp.placeholder = options.placeholder;
		qp.canSelectMany = true;
		qp.items = items;
		qp.selectedItems = items.filter(i => preselected.includes(i.value));
		qp.ignoreFocusOut = true;
		qp.buttons = options.canGoBack ? [vscode.QuickInputButtons.Back] : [];
		let done = false;
		qp.onDidTriggerButton(b => {
			if (b === vscode.QuickInputButtons.Back) { done = true; resolve(BACK); qp.hide(); }
		});
		qp.onDidAccept(() => { done = true; resolve(qp.selectedItems.map(i => i.value)); qp.hide(); });
		qp.onDidHide(() => { if (!done) { resolve(undefined); } qp.dispose(); });
		qp.show();
	});
}

export interface InputStepOptions {
	readonly title: string;
	readonly step?: number;
	readonly totalSteps?: number;
	readonly prompt: string;
	readonly value?: string;
	readonly placeholder?: string;
	readonly canGoBack?: boolean;
	readonly validate: (value: string) => string | undefined;
}

/** One text-entry step with validation. */
export function inputStep(options: InputStepOptions): Promise<StepResult<string>> {
	return new Promise(resolve => {
		const ib = vscode.window.createInputBox();
		ib.title = options.title;
		ib.step = options.step;
		ib.totalSteps = options.totalSteps;
		ib.prompt = options.prompt;
		ib.placeholder = options.placeholder;
		ib.value = options.value ?? '';
		ib.ignoreFocusOut = true;
		ib.buttons = options.canGoBack ? [vscode.QuickInputButtons.Back] : [];
		let done = false;
		ib.onDidChangeValue(v => { ib.validationMessage = options.validate(v); });
		ib.onDidTriggerButton(b => {
			if (b === vscode.QuickInputButtons.Back) { done = true; resolve(BACK); ib.hide(); }
		});
		ib.onDidAccept(() => {
			const message = options.validate(ib.value);
			if (message) { ib.validationMessage = message; return; }
			done = true; resolve(ib.value); ib.hide();
		});
		ib.onDidHide(() => { if (!done) { resolve(undefined); } ib.dispose(); });
		ib.show();
	});
}

/** Folder picker (native dialog). Resolves to the folder path or undefined when cancelled. */
export async function pickFolder(title: string, openLabel: string, defaultUri?: vscode.Uri): Promise<string | undefined> {
	const picked = await vscode.window.showOpenDialog({ title, canSelectFolders: true, canSelectFiles: false, canSelectMany: false, openLabel, defaultUri });
	return picked?.[0]?.fsPath;
}

/** Project/package name rule shared by the wizards: identifier-ish, shell-safe. */
export function validateProjectName(value: string): string | undefined {
	return /^[A-Za-z][\w-]*$/.test(value.trim()) ? undefined : 'Use a letter followed by letters, digits, _ or -';
}
