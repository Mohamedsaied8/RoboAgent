/*---------------------------------------------------------------------------------------------
 *  Copyright (c) RoboAgent. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as assert from 'assert';
import { ESP32_CHIPS, esp32DebugConfiguration, esp32IdfCommand, generateEsp32Project, isEsp32Chip } from '../modes/esp32/generator';

suite('ESP32 generator', () => {

	test('project layout: IDF CMake, main component, pinned target, vscode files', () => {
		const files = generateEsp32Project({ name: 'sensor-node', chip: 'esp32s3', template: 'hello_world' });
		assert.ok(files.get('CMakeLists.txt')!.includes('include($ENV{IDF_PATH}/tools/cmake/project.cmake)'));
		assert.ok(files.get('CMakeLists.txt')!.includes('project(sensor_node)'));
		assert.ok(files.get('main/CMakeLists.txt')!.includes('idf_component_register(SRCS "main.c"'));
		assert.ok(files.get('main/main.c')!.includes('void app_main(void)'));
		assert.ok(files.get('sdkconfig.defaults')!.includes('CONFIG_IDF_TARGET="esp32s3"'));
		assert.ok(files.get('.vscode/tasks.json')!.includes('set-target esp32s3'));
		for (const name of ['.vscode/settings.json', '.vscode/launch.json', '.vscode/tasks.json', '.vscode/c_cpp_properties.json']) {
			assert.doesNotThrow(() => JSON.parse(files.get(name)!), name);
		}
		assert.strictEqual(JSON.parse(files.get('.vscode/settings.json')!)['roboagent.mode'], 'esp32');
	});

	test('blink template and serial port setting', () => {
		const files = generateEsp32Project({ name: 'led', chip: 'esp32c3', template: 'blink', port: '/dev/ttyACM0' });
		assert.ok(files.get('main/main.c')!.includes('gpio_set_level'));
		assert.strictEqual(JSON.parse(files.get('.vscode/settings.json')!)['roboagent.esp32.port'], '/dev/ttyACM0');
		assert.ok(files.get('.vscode/tasks.json')!.includes('-p /dev/ttyACM0 flash'));
	});

	test('idf.py command composition sources export.sh and quotes paths', () => {
		assert.strictEqual(esp32IdfCommand('build'), '. "$IDF_PATH/export.sh" >/dev/null && idf.py build');
		assert.strictEqual(esp32IdfCommand('flash monitor', '/dev/ttyUSB0'), '. "$IDF_PATH/export.sh" >/dev/null && idf.py -p /dev/ttyUSB0 flash monitor');
		assert.strictEqual(esp32IdfCommand('build', undefined, '/home/me/esp idf'), `IDF_PATH='/home/me/esp idf'; export IDF_PATH; . "$IDF_PATH/export.sh" >/dev/null && idf.py build`);
	});

	test('chips and debug configuration', () => {
		assert.deepStrictEqual(ESP32_CHIPS.map(c => c.id), ['esp32', 'esp32s2', 'esp32s3', 'esp32c3', 'esp32c6', 'esp32h2']);
		assert.ok(isEsp32Chip('esp32c6') && !isEsp32Chip('esp8266'));
		assert.deepStrictEqual(esp32DebugConfiguration(), { type: 'gdbtarget', request: 'attach', name: 'Eclipse CDT GDB Adapter' });
	});
});
