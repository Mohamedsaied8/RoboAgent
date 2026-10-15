/*---------------------------------------------------------------------------------------------
 *  Copyright (c) RoboAgent. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as assert from 'assert';
import { promises as fs } from 'fs';
import * as os from 'os';
import * as path from 'path';
import { NodeSystemProbe, rulesDirList } from '../adapters/node/nodeSystemProbe';
import { defaultToolStoreRoot } from '../adapters/node/nodeToolStore';

suite('NodeSystemProbe (search, no hard-coded paths)', function () {

	let tmp: string;

	setup(async function () {
		if (process.platform === 'win32') {
			this.skip();
		}
		tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'fwagents-probe-'));
	});

	teardown(async () => {
		if (tmp) {
			await fs.rm(tmp, { recursive: true, force: true });
		}
	});

	async function program(dir: string, name: string): Promise<string> {
		await fs.mkdir(dir, { recursive: true });
		const file = path.join(dir, name);
		await fs.writeFile(file, '#!/bin/sh\n', { mode: 0o755 });
		return file;
	}

	test('finds programs on PATH and in the sbin sibling of a bin folder; skips relative and workspace folders', async () => {
		const usrBin = path.join(tmp, 'usr', 'bin');
		const viaPath = await program(usrBin, 'tool-a');
		const viaSbin = await program(path.join(tmp, 'usr', 'sbin'), 'tool-b');
		const ws = path.join(tmp, 'ws');
		await program(path.join(ws, 'bin'), 'planted');
		const probe = new NodeSystemProbe({ env: { PATH: `bin:.:${path.join(ws, 'bin')}:${usrBin}` }, workspaceRoot: ws, platform: 'linux' });
		assert.deepStrictEqual([await probe.findProgram('tool-a'), await probe.findProgram('tool-b'), await probe.findProgram('planted')], [viaPath, viaSbin, undefined]);
		assert.strictEqual(await probe.findProgram('../usr/bin/tool-a'), undefined, 'names only, no paths');
	});

	test('the tool store is searched first unless systemOnly; never for root', async () => {
		const store = path.join(tmp, 'store', 'bin');
		const fromStore = await program(store, 'openocd');
		const fromSystem = await program(path.join(tmp, 'usr', 'bin'), 'openocd');
		const probe = new NodeSystemProbe({ env: { PATH: path.join(tmp, 'usr', 'bin') }, toolStoreBins: async () => [store], platform: 'linux' });
		assert.deepStrictEqual([await probe.findProgram('openocd'), await probe.findProgram('openocd', { systemOnly: true })], [fromStore, fromSystem]);
	});

	test('a program a normal user owns is never trusted to run as root', async () => {
		await program(path.join(tmp, 'usr', 'bin'), 'sudo');
		const probe = new NodeSystemProbe({ env: { PATH: path.join(tmp, 'usr', 'bin') }, platform: 'linux' });
		assert.ok(await probe.findProgram('sudo'));
		assert.strictEqual(await probe.findProgram('sudo', { trustedForRoot: true }), undefined);
	});

	test('on this machine: root programs are found by search and udev\'s rule folders are read from udevadm', async function () {
		if (process.platform !== 'linux') {
			this.skip();
		}
		const probe = new NodeSystemProbe({ platform: 'linux' });
		const udevadm = await probe.findProgram('udevadm', { systemOnly: true });
		if (!udevadm) {
			this.skip();
		}
		const sudo = await probe.findProgram('sudo', { trustedForRoot: true });
		if (sudo) {
			const stat = await fs.stat(sudo);
			assert.deepStrictEqual([path.isAbsolute(sudo), stat.uid], [true, 0]);
		}
		const dirs = await probe.udevRuleDirs();
		assert.ok(dirs.length >= 1, 'udev rule folders discovered');
		for (const d of dirs) {
			assert.ok(d.endsWith(path.join('udev', 'rules.d')) && (await fs.stat(d)).isDirectory(), d);
		}
		assert.ok((await probe.readUdevRules()).every(f => f.file.endsWith('.rules')));
	});

	test('a link in a user folder to a root program is skipped; the trusted path further on PATH is used', async function () {
		const real = await new NodeSystemProbe({ platform: 'linux' }).findProgram('tee', { trustedForRoot: true });
		if (!real) {
			return this.skip();
		}
		const ubin = path.join(tmp, 'ubin');
		await fs.mkdir(ubin);
		await fs.symlink(real, path.join(ubin, 'tee'));
		const probe = new NodeSystemProbe({ env: { PATH: `${ubin}:${path.dirname(real)}` }, platform: 'linux' });
		// The original trusted path is returned (not its link target), so multi-call binaries keep their name.
		assert.strictEqual(await probe.findProgram('tee', { trustedForRoot: true }), real);
		const onlyLink = new NodeSystemProbe({ env: { PATH: ubin }, platform: 'linux' });
		assert.strictEqual(await onlyLink.findProgram('tee', { trustedForRoot: true }), undefined);
	});

	test('a fake udevadm (not root-owned) cannot choose the rule folders', async () => {
		const fakeBin = path.join(tmp, 'fakebin');
		await program(fakeBin, 'udevadm');
		await fs.appendFile(path.join(fakeBin, 'udevadm'), `# ${path.join(tmp, 'evil/udev/rules.d')}\0\n`);
		await fs.mkdir(path.join(tmp, 'evil', 'udev', 'rules.d'), { recursive: true });
		const probe = new NodeSystemProbe({ env: { PATH: fakeBin }, platform: 'linux' });
		assert.deepStrictEqual([await probe.udevRuleDirs(), await probe.udevAdminDir()], [[], undefined]);
	});

	test('the folder list is the longest contiguous NUL-separated run in udevadm, in order', () => {
		const binary = 'junk /home/x/udev/rules.d stuff\0\0/etc/udev/rules.d\0/run/udev/rules.d\0/usr/lib/udev/rules.d\0more';
		assert.deepStrictEqual(rulesDirList(binary), ['/etc/udev/rules.d', '/run/udev/rules.d', '/usr/lib/udev/rules.d']);
	});

	test('rules: a same-named file in a higher-priority folder overrides, and an empty file or /dev/null link masks', async () => {
		const admin = path.join(tmp, 'admin');
		const vendor = path.join(tmp, 'vendor');
		await fs.mkdir(admin);
		await fs.mkdir(vendor);
		await fs.writeFile(path.join(vendor, '50-a.rules'), 'vendor-a');
		await fs.writeFile(path.join(admin, '50-a.rules'), 'admin-a');
		await fs.writeFile(path.join(vendor, '60-b.rules'), 'vendor-b');
		await fs.symlink('/dev/null', path.join(admin, '60-b.rules'));
		await fs.writeFile(path.join(vendor, '70-c.rules'), 'vendor-c');
		await fs.writeFile(path.join(admin, '70-c.rules'), '');
		await fs.writeFile(path.join(vendor, '80-d.rules'), 'vendor-d');
		class Dirs extends NodeSystemProbe {
			override async udevRuleDirs() { return [admin, vendor]; }
		}
		const rules = await new Dirs({ platform: 'linux' }).readUdevRules();
		assert.deepStrictEqual(rules.map(r => r.content), ['admin-a', 'vendor-d']);
	});

	test('a relative XDG_DATA_HOME is ignored (XDG spec); ROBOAGENT_TOOLS_DIR wins', () => {
		assert.strictEqual(defaultToolStoreRoot({ XDG_DATA_HOME: 'ws' }, 'linux', '/home/u'), path.join('/home/u', '.local', 'share', 'roboagent', 'tools'));
		assert.strictEqual(defaultToolStoreRoot({ XDG_DATA_HOME: '/data' }, 'linux', '/home/u'), path.join('/data', 'roboagent', 'tools'));
		assert.strictEqual(defaultToolStoreRoot({ ROBOAGENT_TOOLS_DIR: '/opt/rt', XDG_DATA_HOME: '/data' }, 'linux', '/home/u'), '/opt/rt');
	});
});
