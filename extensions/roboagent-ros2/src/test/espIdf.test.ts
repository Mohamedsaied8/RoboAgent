/*---------------------------------------------------------------------------------------------
 *  Copyright (c) RoboAgent. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/*---------------------------------------------------------------------------------------------
 *  ESP-IDF discovery: every source `discoverEspIdf` consults, in order, against a temp HOME.
 *--------------------------------------------------------------------------------------------*/

import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { defaultEimIdfJsonPath, discoverEspIdf, isEspIdfCheckout, readEimIdfCheckouts, readEspIdfVersion } from '../modes/toolchains';

suite('ESP-IDF discovery', () => {
	let root: string;
	let home: string;
	setup(async () => {
		root = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'roboagent-espidf-'));
		home = path.join(root, 'home');
		await fs.promises.mkdir(home);
	});
	teardown(() => fs.promises.rm(root, { recursive: true, force: true }));

	/** A fake checkout: `tools/idf.py` plus, optionally, `tools/cmake/version.cmake`. */
	async function checkout(dir: string, version?: string): Promise<string> {
		await fs.promises.mkdir(path.join(dir, 'tools', 'cmake'), { recursive: true });
		await fs.promises.writeFile(path.join(dir, 'tools', 'idf.py'), '');
		if (version) {
			const [major, minor, patch] = version.split('.');
			await fs.promises.writeFile(path.join(dir, 'tools', 'cmake', 'version.cmake'),
				`set(IDF_VERSION_MAJOR ${major})\nset(IDF_VERSION_MINOR ${minor})\nset(IDF_VERSION_PATCH ${patch})\n`);
		}
		return dir;
	}

	async function eimJson(json: unknown, at = defaultEimIdfJsonPath(home, 'linux')): Promise<string> {
		await fs.promises.mkdir(path.dirname(at), { recursive: true });
		await fs.promises.writeFile(at, JSON.stringify(json));
		return at;
	}

	const env = (extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv => ({ HOME: home, ...extra });

	test('nothing installed → undefined', async () => {
		assert.strictEqual(await discoverEspIdf({ env: env(), platform: 'linux' }), undefined);
		assert.strictEqual(await isEspIdfCheckout(undefined), false);
		assert.strictEqual(await isEspIdfCheckout(home), false);
	});

	test('the roboagent.esp32.idfPath setting wins and the version is read from version.cmake', async () => {
		const idf = await checkout(path.join(root, 'idf-setting'), '5.3.1');
		await checkout(path.join(root, 'idf-env'), '5.1.0');
		const found = await discoverEspIdf({ configured: ` ${idf} `, env: env({ IDF_PATH: path.join(root, 'idf-env') }), platform: 'linux' });
		assert.deepStrictEqual(found, { idfPath: idf, source: 'setting', version: 'v5.3.1' });
	});

	test('an invalid setting falls through to $IDF_PATH', async () => {
		const idf = await checkout(path.join(root, 'idf-env'));
		const found = await discoverEspIdf({ configured: path.join(root, 'nope'), env: env({ IDF_PATH: idf }), platform: 'linux' });
		assert.strictEqual(found?.idfPath, idf);
		assert.strictEqual(found?.source, 'env');
		assert.strictEqual(found?.version, undefined);
	});

	test('the ESP-IDF extension current setup (idf.currentSetup) is honoured', async () => {
		const idf = await checkout(path.join(root, 'ext-setup'), '5.4.0');
		const found = await discoverEspIdf({ extensionSetup: idf, env: env(), platform: 'linux' });
		assert.strictEqual(found?.source, 'extension');
		assert.strictEqual(found?.version, 'v5.4.0');
	});

	test('Installation Manager registry: the selected install first, object form', async () => {
		const older = await checkout(path.join(home, '.espressif', 'v5.2.0', 'esp-idf'), '5.2.0');
		const newer = await checkout(path.join(home, '.espressif', 'v5.4.1', 'esp-idf'), '5.4.1');
		await eimJson({ idfSelectedId: 'esp-idf-old', idfInstalled: { 'esp-idf-old': { name: 'v5.2.0', path: older }, 'esp-idf-new': { name: 'v5.4.1', path: newer } } });
		const found = await discoverEspIdf({ env: env(), platform: 'linux' });
		assert.strictEqual(found?.idfPath, older);
		assert.strictEqual(found?.source, 'eim');
	});

	test('Installation Manager registry: newest by name when nothing is selected, array form, missing checkouts skipped', async () => {
		const good = await checkout(path.join(root, 'eim-good'), '5.3.2');
		await eimJson({ idfInstalled: [{ id: 'a', name: 'v5.3.2', path: good }, { id: 'b', name: 'v5.10.0', path: path.join(root, 'gone') }] });
		assert.deepStrictEqual(await readEimIdfCheckouts(defaultEimIdfJsonPath(home, 'linux')), [path.join(root, 'gone'), good]);
		const found = await discoverEspIdf({ env: env(), platform: 'linux' });
		assert.strictEqual(found?.idfPath, good);
		assert.strictEqual(found?.source, 'eim');
	});

	test('idf.eimIdfJsonPath overrides the registry location; malformed registries are ignored', async () => {
		const idf = await checkout(path.join(root, 'custom-eim'));
		const custom = await eimJson({ idfInstalled: { x: { path: idf } } }, path.join(root, 'elsewhere', 'eim_idf.json'));
		await eimJson('{not json', defaultEimIdfJsonPath(home, 'linux'));
		assert.deepStrictEqual(await readEimIdfCheckouts(defaultEimIdfJsonPath(home, 'linux')), []);
		assert.deepStrictEqual(await readEimIdfCheckouts(path.join(root, 'missing.json')), []);
		assert.strictEqual((await discoverEspIdf({ eimJsonPath: custom, env: env(), platform: 'linux' }))?.idfPath, idf);
		assert.strictEqual(await discoverEspIdf({ env: env(), platform: 'linux' }), undefined);
	});

	test('conventional homes: ~/esp/esp-idf, then the newest ~/esp/v*, then ~/.espressif/v*', async () => {
		const eimHome = await checkout(path.join(home, '.espressif', 'v5.0.0', 'esp-idf'));
		assert.strictEqual((await discoverEspIdf({ env: env(), platform: 'linux' }))?.idfPath, eimHome);

		await checkout(path.join(home, 'esp', 'v5.1.2', 'esp-idf'));
		const newest = await checkout(path.join(home, 'esp', 'v5.10.0', 'esp-idf'));
		const found = await discoverEspIdf({ env: env(), platform: 'linux' });
		assert.strictEqual(found?.idfPath, newest, 'numeric version ordering');
		assert.strictEqual(found?.source, 'home');

		const direct = await checkout(path.join(home, 'esp', 'esp-idf'));
		assert.strictEqual((await discoverEspIdf({ env: env(), platform: 'linux' }))?.idfPath, direct);
	});

	test('version.txt is the fallback for release archives', async () => {
		const idf = await checkout(path.join(root, 'release'));
		await fs.promises.writeFile(path.join(idf, 'version.txt'), 'v5.1.4\n');
		assert.strictEqual(await readEspIdfVersion(idf), 'v5.1.4');
		assert.strictEqual(await readEspIdfVersion(path.join(root, 'nowhere')), undefined);
	});

	test('the default registry path is platform specific', () => {
		assert.strictEqual(defaultEimIdfJsonPath('/home/u', 'linux'), '/home/u/.espressif/tools/eim_idf.json');
		assert.strictEqual(defaultEimIdfJsonPath('/home/u', 'darwin'), '/home/u/.espressif/tools/eim_idf.json');
		assert.strictEqual(defaultEimIdfJsonPath('C:\\Users\\u', 'win32'), 'C:\\Espressif\\tools\\eim_idf.json');
	});
});
