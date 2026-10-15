/*---------------------------------------------------------------------------------------------
 *  Copyright (c) RoboAgent. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/*---------------------------------------------------------------------------------------------
 *  @network — real downloads from the vendors into a temporary tool store, verified against the
 *  pinned SHA-256 values. Opt-in: FWAGENT_NETWORK_TESTS=1 (about 90 MB: OpenOCD, Espressif
 *  OpenOCD, the ESP32-S3 GDB) or =full (adds the ~300 MB Arm GNU toolchain for arm-none-eabi-gdb).
 *--------------------------------------------------------------------------------------------*/

import * as assert from 'assert';
import { createHash } from 'crypto';
import { mkdirSync, promises as fs } from 'fs';
import * as os from 'os';
import * as path from 'path';
import { NodeAgentHost } from '../adapters/node/nodeAgentHost';
import { currentPlatform, NodeToolStore } from '../adapters/node/nodeToolStore';
import { DefaultTargetCatalog } from '../embedded/target';
import { TOOL_MANIFEST } from '../install/manifest';
import { debugRequirements, DependencyResolver } from '../install/resolver';

const mode = process.env.FWAGENT_NETWORK_TESTS;

suite('@network self-install from the real vendor downloads', function () {

	let tmp: string;

	suiteSetup(function () {
		if (!mode || process.platform === 'win32' || !currentPlatform()) {
			this.skip();
		}
	});

	setup(async () => {
		tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'fwagents-net-'));
	});

	teardown(async () => {
		await fs.rm(tmp, { recursive: true, force: true });
	});

	// Workspace and tool store side by side: the host refuses a store inside the workspace.
	const hostWith = (store: NodeToolStore) => {
		const ws = path.join(tmp, 'ws');
		mkdirSync(ws, { recursive: true });
		return new NodeAgentHost({ root: ws, toolStore: store, write: () => { } });
	};

	test('ESP32-S3: Espressif OpenOCD and the Xtensa GDB install, verify and run; a second run downloads nothing', async function () {
		this.timeout(600_000);
		const store = new NodeToolStore({ root: path.join(tmp, 'store') });
		const host = hostWith(store);
		const deps = debugRequirements({ target: new DefaultTargetCatalog().resolve('esp32s3')! }).filter(d => d.id === 'openocd-esp32' || d.id === 'gdb');
		const report = await new DependencyResolver(host).ensureUserSpace(deps);
		assert.deepStrictEqual(report.installed.map(i => [i.id, i.ok, i.action]), [['openocd-esp32', true, 'downloaded'], ['gdb', true, 'downloaded']], JSON.stringify(report.installed));
		assert.strictEqual(report.ok, true, JSON.stringify(report.statuses));
		assert.match(report.statuses[0].version ?? '', /esp32/i);
		assert.match(report.statuses[1].version ?? '', /GNU gdb/);
		const again = await new DependencyResolver(host).ensureUserSpace(deps);
		assert.deepStrictEqual(again.installed, []);
		// The pinned rules hash matches the real file shipped in the vendor archive.
		const rules = TOOL_MANIFEST['openocd-esp32'].files!.udevRules!;
		const content = await store.readFile('openocd-esp32', TOOL_MANIFEST['openocd-esp32'].version, rules.path);
		assert.strictEqual(createHash('sha256').update(content, 'utf8').digest('hex'), rules.sha256);
	});

	test('STM32: upstream OpenOCD from xPack installs and runs (and the Arm GDB in "full" mode)', async function () {
		this.timeout(1_800_000);
		const store = new NodeToolStore({ root: path.join(tmp, 'store') });
		const host = hostWith(store);
		const deps = debugRequirements().filter(d => d.id === 'openocd' || (mode === 'full' && d.id === 'gdb'));
		const report = await new DependencyResolver(host).ensureUserSpace(deps);
		const ocd = report.statuses.find(s => s.id === 'openocd')!;
		assert.ok(ocd.ok, JSON.stringify(report));
		// Either the system's OpenOCD (already on PATH) or the freshly installed xPack one.
		assert.match(ocd.version ?? '', /Open On-Chip Debugger/);
		if (mode === 'full') {
			const gdb = report.statuses.find(s => s.id === 'gdb')!;
			assert.ok(gdb.ok, JSON.stringify(report));
			assert.match(gdb.version ?? '', /GNU gdb/);
		}
		// The rules file that install_probe_access would copy is in the OpenOCD install.
		const installed = await store.find('xpack-openocd');
		if (installed) {
			const rules = TOOL_MANIFEST['xpack-openocd'].files!.udevRules!;
			const content = await store.readFile('xpack-openocd', installed.version, rules.path);
			assert.strictEqual(createHash('sha256').update(content, 'utf8').digest('hex'), rules.sha256, 'pinned rules hash matches the vendor file');
			assert.ok(content.includes('0483'));
		}
	});
});
