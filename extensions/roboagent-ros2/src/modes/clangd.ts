/*---------------------------------------------------------------------------------------------
 *  Copyright (c) RoboAgent. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/*---------------------------------------------------------------------------------------------
 *  RoboAgent — clangd (C/C++ IntelliSense) settings for firmware projects.
 *
 *  clangd asks the compiler named in compile_commands.json for its system headers (newlib, the
 *  target's include folders) only when that compiler matches `--query-driver`, because asking
 *  means running it. The allow-list names toolchain install folders with single-segment `*`
 *  wildcards only — no `**`, which could match `/opt/../home/<user>/<repo>/…` — so a project's
 *  compile_commands.json, compile_flags.txt or .clangd cannot make clangd run a "compiler"
 *  shipped inside the repository. (Settings in a workspace's .vscode/settings.json can still
 *  change clangd.arguments / clangd.path; clangd does not run in untrusted workspaces.)
 *--------------------------------------------------------------------------------------------*/

/** Arm GNU toolchains: distro packages, /opt installs, STM32CubeIDE, RoboAgent's tool store. */
export const ARM_QUERY_DRIVERS: readonly string[] = [
	'/usr/bin/arm-none-eabi-*',
	'/usr/local/bin/arm-none-eabi-*',
	'/opt/*/bin/arm-none-eabi-*',
	'/opt/st/stm32cubeide_*/plugins/*/tools/bin/arm-none-eabi-*',
	'${userHome}/.local/share/roboagent/tools/xpack-arm-none-eabi-gcc/*/*/bin/arm-none-eabi-*',
];

/** Espressif GCCs installed by ESP-IDF's tools (`~/.espressif/tools/<tool>/<version>/<tool>/bin`). */
export const ESP_QUERY_DRIVERS: readonly string[] = [
	'${userHome}/.espressif/tools/*-esp*-elf/*/*-esp*-elf/bin/*-esp*-elf-*',
];

export function queryDriverArgument(drivers: readonly string[]): string {
	return `--query-driver=${drivers.join(',')}`;
}
