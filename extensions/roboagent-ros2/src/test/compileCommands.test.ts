/*---------------------------------------------------------------------------------------------
 *  Copyright (c) RoboAgent. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/*---------------------------------------------------------------------------------------------
 *  Task board A14: clangd had no compilation database in a colcon workspace (colcon builds each
 *  package in build/<pkg> and exported nothing), so ROS2 C++ had no IntelliSense.
 *--------------------------------------------------------------------------------------------*/

import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { compileCommandEntries, mergeColconCompileCommands } from '../compileCommands';

async function workspace(packages: Record<string, unknown>): Promise<string> {
	const ws = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'roboagent-ccdb-'));
	for (const [pkg, database] of Object.entries(packages)) {
		await fs.promises.mkdir(path.join(ws, 'build', pkg), { recursive: true });
		await fs.promises.writeFile(path.join(ws, 'build', pkg, 'compile_commands.json'), typeof database === 'string' ? database : JSON.stringify(database));
	}
	return ws;
}

const talker = { directory: '/ws/build/talker', command: '/usr/bin/c++ -I/opt/ros/humble/include -o t.o -c /ws/src/talker/src/talker.cpp', file: '/ws/src/talker/src/talker.cpp', output: 't.o' };
const listener = { directory: '/ws/build/listener', arguments: ['/usr/bin/c++', '-c', '/ws/src/listener/src/listener.cpp'], file: '/ws/src/listener/src/listener.cpp' };

suite('colcon compile_commands.json for clangd', () => {

	test('entries: standard fields only, malformed entries dropped', () => {
		assert.deepStrictEqual(compileCommandEntries([
			{ ...talker, extra: 'dropped' },
			listener,
			{ directory: '/ws', file: 'no-command.cpp' },
			{ directory: '/ws', file: 'bad-args.cpp', arguments: ['c++', 1] },
			null,
			'text',
		]), [talker, listener]);
		assert.deepStrictEqual(compileCommandEntries({ not: 'an array' }), []);
	});

	test('merges every package into build/compile_commands.json; broken databases are skipped', async () => {
		const ws = await workspace({ talker: [talker], listener: [listener], broken: '[{"directory": ' });
		try {
			assert.strictEqual(await mergeColconCompileCommands(ws), 2);
			const merged = JSON.parse(await fs.promises.readFile(path.join(ws, 'build', 'compile_commands.json'), 'utf8'));
			assert.deepStrictEqual(merged, [listener, talker]);
			// Unchanged on the next build: not rewritten (clangd would re-index otherwise).
			assert.strictEqual(await mergeColconCompileCommands(ws), 0);
			assert.deepStrictEqual((await fs.promises.readdir(path.join(ws, 'build'))).sort(), ['broken', 'compile_commands.json', 'listener', 'talker']);
		} finally {
			await fs.promises.rm(ws, { recursive: true, force: true });
		}
	});

	test('nothing to merge, a symlinked target, or a symlinked build folder: nothing is written', async () => {
		const empty = await workspace({ py_pkg: '' });
		const linked = await workspace({ talker: [talker] });
		const outside = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'roboagent-ccdb-outside-'));
		const linkedBuild = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'roboagent-ccdb-'));
		try {
			await fs.promises.writeFile(path.join(outside, 'mine.json'), 'keep');
			await fs.promises.symlink(path.join(outside, 'mine.json'), path.join(linked, 'build', 'compile_commands.json'));
			await fs.promises.symlink(path.join(linked, 'build'), path.join(linkedBuild, 'build'));
			assert.deepStrictEqual(
				[await mergeColconCompileCommands(empty), await mergeColconCompileCommands(linked), await mergeColconCompileCommands(linkedBuild), await fs.promises.readFile(path.join(outside, 'mine.json'), 'utf8')],
				[undefined, undefined, undefined, 'keep']);
		} finally {
			for (const dir of [empty, linked, outside, linkedBuild]) {
				await fs.promises.rm(dir, { recursive: true, force: true });
			}
		}
	});
});
