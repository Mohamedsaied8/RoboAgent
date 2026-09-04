/*---------------------------------------------------------------------------------------------
 *  Copyright (c) RoboAgent. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { materialize, ScaffoldError, toIdentifier } from '../modes/scaffold';
import { discoverArmToolchainDir, discoverIdfPath, discoverRos2Distro } from '../modes/toolchains';

suite('Scaffold (atomic materialize)', () => {
	let root: string;
	setup(async () => { root = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'roboagent-scaffold-')); });
	teardown(() => fs.promises.rm(root, { recursive: true, force: true }));

	const files = new Map([['a.txt', 'A'], ['dir/b.txt', 'B'], ['.vscode/settings.json', '{}\n']]);

	test('writes the file set into a new directory', async () => {
		const dest = path.join(root, 'proj');
		await materialize(dest, files);
		assert.strictEqual(await fs.promises.readFile(path.join(dest, 'dir', 'b.txt'), 'utf8'), 'B');
		assert.strictEqual(await fs.promises.readFile(path.join(dest, '.vscode', 'settings.json'), 'utf8'), '{}\n');
		// no staging leftovers
		assert.deepStrictEqual(await fs.promises.readdir(root), ['proj']);
	});

	test('accepts an existing empty directory, refuses a non-empty one', async () => {
		const empty = path.join(root, 'empty');
		await fs.promises.mkdir(empty);
		await materialize(empty, files);
		assert.ok(fs.existsSync(path.join(empty, 'a.txt')));
		await assert.rejects(materialize(empty, files), (e: ScaffoldError) => e.code === 'exists');
	});

	test('cancellation and beforeCommit failures leave nothing behind', async () => {
		const dest = path.join(root, 'cancelled');
		await assert.rejects(materialize(dest, files, { isCancelled: () => true }), (e: ScaffoldError) => e.code === 'cancelled');
		assert.ok(!fs.existsSync(dest));
		await assert.rejects(materialize(dest, files, { beforeCommit: async () => { throw new Error('generator exploded'); } }), (e: ScaffoldError) => e.code === 'io' && e.message.includes('generator exploded'));
		assert.ok(!fs.existsSync(dest));
		assert.deepStrictEqual(await fs.promises.readdir(root), []);
	});

	test('beforeCommit can add files to the staging directory', async () => {
		const dest = path.join(root, 'withcli');
		await materialize(dest, files, { beforeCommit: async staging => { await fs.promises.writeFile(path.join(staging, 'cli.txt'), 'from cli'); } });
		assert.strictEqual(await fs.promises.readFile(path.join(dest, 'cli.txt'), 'utf8'), 'from cli');
	});

	test('toIdentifier makes names C/CMake safe', () => {
		assert.strictEqual(toIdentifier('motor-ctrl'), 'motor_ctrl');
		assert.strictEqual(toIdentifier('My Project!'), 'my_project');
		assert.strictEqual(toIdentifier('42nodes'), 'p_42nodes');
	});
});

suite('Toolchain discovery', () => {
	let root: string;
	setup(async () => { root = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'roboagent-tc-')); });
	teardown(() => fs.promises.rm(root, { recursive: true, force: true }));

	test('setting wins; PATH means "no explicit dir"', async () => {
		assert.strictEqual(await discoverArmToolchainDir('/custom/bin', false), '/custom/bin');
		assert.strictEqual(await discoverArmToolchainDir('  ', true), undefined);
	});

	test('IDF path: setting must contain tools/idf.py, env is honoured, else undefined', async () => {
		const idf = path.join(root, 'esp-idf');
		await fs.promises.mkdir(path.join(idf, 'tools'), { recursive: true });
		await fs.promises.writeFile(path.join(idf, 'tools', 'idf.py'), '');
		assert.strictEqual(await discoverIdfPath(idf, {}), idf);
		assert.strictEqual(await discoverIdfPath(path.join(root, 'nope'), { IDF_PATH: idf }), idf);
		assert.strictEqual(await discoverIdfPath(undefined, { IDF_PATH: path.join(root, 'nope'), HOME: root }), undefined);
	});

	test('ROS 2 distro: setting only when installed, $ROS_DISTRO passes through', async () => {
		assert.strictEqual(await discoverRos2Distro('definitely_not_a_distro', { ROS_DISTRO: 'humble' }), 'humble');
		assert.strictEqual(await discoverRos2Distro(undefined, { ROS_DISTRO: 'jazzy' }), 'jazzy');
	});
});
