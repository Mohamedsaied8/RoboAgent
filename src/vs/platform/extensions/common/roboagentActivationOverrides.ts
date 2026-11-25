/*---------------------------------------------------------------------------------------------
 *  Copyright (c) RoboAgent. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { ExtensionIdentifier, IExtensionDescription } from './extensions.js';

/**
 * RoboAgent: narrower `workspaceContains` activation for bundled extensions whose own pattern is
 * too broad for a robotics IDE.
 *
 * The ESP-IDF extension activates on `workspaceContains:**\/CMakeLists.txt` — every CMake project,
 * so also STM32 and ROS2 ones — and then asks "No standard ESP-IDF project was found … activate
 * anyway?" and recommends clangd. It is limited to folders that look like ESP-IDF projects (the
 * markers RoboAgent's ESP32 mode detects). Its command events and the views in its own container
 * are kept, so ESP32-mode actions still activate it on demand; `onView:idfComponents` is dropped
 * because that view sits in the Explorer of every project.
 */
const DROPPED_EVENTS: ReadonlyMap<string, readonly string[]> = new Map([
	[ExtensionIdentifier.toKey('espressif.esp-idf-extension'), ['onView:idfComponents']],
]);

const WORKSPACE_CONTAINS_OVERRIDES: ReadonlyMap<string, readonly string[]> = new Map([
	[ExtensionIdentifier.toKey('espressif.esp-idf-extension'), [
		'sdkconfig',
		'sdkconfig.defaults',
		'main/CMakeLists.txt',
		'*/sdkconfig.defaults',
		'*/main/CMakeLists.txt',
	]],
]);

/** The activation events of `desc` as RoboAgent uses them (activation maps and `workspaceContains` checks). */
export function roboAgentActivationEvents(desc: Pick<IExtensionDescription, 'identifier' | 'activationEvents'>): readonly string[] | undefined {
	const override = WORKSPACE_CONTAINS_OVERRIDES.get(ExtensionIdentifier.toKey(desc.identifier));
	if (!override || !desc.activationEvents) {
		return desc.activationEvents;
	}
	const dropped = DROPPED_EVENTS.get(ExtensionIdentifier.toKey(desc.identifier)) ?? [];
	return [
		...desc.activationEvents.filter(e => !e.startsWith('workspaceContains:') && !dropped.includes(e)),
		...override.map(pattern => `workspaceContains:${pattern}`),
	];
}
