/*---------------------------------------------------------------------------------------------
 *  Copyright (c) RoboAgent. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/*---------------------------------------------------------------------------------------------
 *  RoboAgent ROS2 Toolkit — extension entry point.
 *
 *  Wires the IDE surfaces an extension can own: the RoboAgent command set (WS1), the colcon
 *  Build Center task provider (WS3), Run/Debug with bundled/detected adapters (WS4), and the
 *  New-Project wizard (REQ-4 / WS8). Fork-only surfaces (status bar, Package-Explorer context
 *  menu) live in contrib/roboagent and invoke these commands.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { registerCommands } from './commands';
import { registerColconTasks } from './colconTasks';
import { registerCmake } from './cmake';
import { registerDebug } from './debug';
import { checkBundledExtensions } from './modes/bundledExtensions';
import { Esp32ModeProvider } from './modes/esp32/esp32ModeProvider';
import { registerModeCommands } from './modes/modeCommands';
import { Mode, ModeProvider } from './modes/modeProvider';
import { ModeService } from './modes/modeService';
import { getOutputChannel, log } from './modes/output';
import { Ros2ModeProvider } from './modes/ros2/ros2ModeProvider';
import { Stm32ModeProvider } from './modes/stm32/stm32ModeProvider';
import { VscodeModeHost } from './modes/vscodeModeHost';
import { registerNewProject } from './newProject';

export function activate(context: vscode.ExtensionContext): void {
	context.subscriptions.push(
		registerNewProject(context),
		registerColconTasks(),
		...registerCommands(context),
		...registerDebug(context),
	);
	// Generic CMake / single-file build-run (ported from roboagent-defaults).
	registerCmake(context);

	// Mode selector + Create/Build/Debug strategy (STM32 / ESP32 / ROS2). The fork's title-bar
	// toolbar (contrib/roboagent) invokes these commands and reads the context keys the
	// ModeService publishes.
	const host = new VscodeModeHost();
	const providers = new Map<Mode, ModeProvider>([
		['stm32', new Stm32ModeProvider(host)],
		['esp32', new Esp32ModeProvider(host)],
		['ros2', new Ros2ModeProvider(host)],
	]);
	const modeService = new ModeService(context, providers);
	context.subscriptions.push(getOutputChannel(), modeService, ...registerModeCommands(modeService, providers, host));
	log(`RoboAgent ROS2 Toolkit ${(context.extension.packageJSON as { version?: string }).version ?? ''} activated`);
	checkBundledExtensions();
	void modeService.initialize();
}

export function deactivate(): void {
	// Disposables are tracked on context.subscriptions.
}
