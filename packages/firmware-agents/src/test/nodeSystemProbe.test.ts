/*---------------------------------------------------------------------------------------------
 *  Copyright (c) RoboAgent. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as assert from 'assert';
import { spawnSync } from 'child_process';
import { promises as fs } from 'fs';
import * as os from 'os';
import * as path from 'path';
import { aclFlags, aclFromDarwinLs, NodeSystemProbe, rulesDirList } from '../adapters/node/nodeSystemProbe';
import { defaultToolStoreRoot, NodeToolStore } from '../adapters/node/nodeToolStore';

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

	test('ACLs: the ls marker is read, any ACL on the chain makes a root program untrusted, and no ls means untrusted', async function () {
		assert.deepStrictEqual(aclFlags('-rw-rw-r--+ 1 u u 0 Oct 15 05:35 /x/f\ndrwxr-xr-x 2 root root 4096 Oct 11 /etc\n-rwxr-xr-x. 1 root root 1 Jan 1 /y'), [true, false, false]);
		const tee = await new NodeSystemProbe({ platform: 'linux' }).findProgram('tee', { trustedForRoot: true });
		if (!tee) {
			return this.skip();
		}
		class WithAcl extends NodeSystemProbe {
			protected override async anyHasAcl() { return true; }
		}
		assert.strictEqual(await new WithAcl({ platform: 'linux' }).findProgram('tee', { trustedForRoot: true }), undefined);
		// No trusted `ls` on PATH: Linux falls back to the mode bits (already checked); elsewhere unknown = "has ACL".
		class Exposed extends NodeSystemProbe {
			hasAcl(paths: string[]) { return this.anyHasAcl(paths); }
		}
		assert.strictEqual(await new Exposed({ env: { PATH: '' }, platform: 'linux' }).hasAcl([path.dirname(tee)]), false);
		assert.strictEqual(await new Exposed({ env: { PATH: '' }, platform: 'darwin' }).hasAcl([path.dirname(tee)]), true);
		assert.strictEqual(await new Exposed({ platform: 'linux' }).hasAcl([path.dirname(tee)]), false, 'a normal system folder has no ACL');
	});

	test('a legacy store (absolute paths in its index) is taken over: moved, index converted, no re-download', async () => {
		const legacy = path.join(tmp, 'home', '.roboagent', 'tools');
		const bin = path.join(legacy, 'xpack-openocd', '0.12.0-7', 'xpack-openocd-0.12.0-7', 'bin');
		await program(bin, 'openocd');
		await fs.writeFile(path.join(legacy, 'index.json'), JSON.stringify([
			{ id: 'xpack-openocd', version: '0.12.0-7', dir: path.join(legacy, 'xpack-openocd', '0.12.0-7'), binDir: bin, sha256: 'abc', onPath: true, installedAt: 'x', url: 'https://github.com/x' },
			{ id: 'evil', version: '1', dir: '/etc', binDir: '/etc', sha256: 'x', onPath: true },
		]));
		const target = path.join(tmp, 'data', 'roboagent', 'tools');
		const store = new NodeToolStore({ root: target, migrateFrom: legacy, platform: 'linux-x64' });
		const tools = await store.installed();
		assert.deepStrictEqual(tools.map(t => [t.id, t.binDir]), [['xpack-openocd', path.join(target, 'xpack-openocd', '0.12.0-7', 'xpack-openocd-0.12.0-7', 'bin')]]);
		assert.strictEqual(await fs.stat(legacy).then(() => true, () => false), false, 'moved, not copied');
		// An existing new store is never overwritten by a legacy one.
		await fs.mkdir(legacy, { recursive: true });
		await fs.writeFile(path.join(legacy, 'index.json'), '[]');
		assert.strictEqual((await new NodeToolStore({ root: target, migrateFrom: legacy }).installed()).length, 1);
	});

	test('a fake ls cannot blind the ACL check: a link in a user folder is refused, and non-ls output means "has ACL"', async function () {
		const echo = await new NodeSystemProbe({ platform: 'linux' }).findProgram('echo', { systemOnly: true });
		if (!echo) {
			return this.skip();
		}
		const ubin = path.join(tmp, 'ubin2');
		await fs.mkdir(ubin);
		await fs.symlink(await fs.realpath(echo), path.join(ubin, 'ls'));
		class Exposed extends NodeSystemProbe {
			hasAcl(paths: string[]) { return this.anyHasAcl(paths); }
		}
		// The fake ls in a user folder is refused; with a real ls further on PATH, an ACL'd file is still seen.
		const aclFile = path.join(tmp, 'acl-file');
		await fs.writeFile(aclFile, '');
		const setfacl = await new NodeSystemProbe({ platform: 'linux' }).findProgram('setfacl', { systemOnly: true });
		if (setfacl && spawnSync(setfacl, ['-m', 'u:nobody:r', aclFile]).status === 0) {
			assert.strictEqual(await new Exposed({ env: { PATH: `${ubin}:${process.env.PATH}` }, platform: 'linux' }).hasAcl([aclFile]), true);
		}
		// The parser itself refuses anything that is not ls output (e.g. what echo prints).
		assert.deepStrictEqual(aclFlags('-ld -- /etc\n'), [true]);
	});

	test('macOS: ACL entries from ls -lde are found even when @ hides +', () => {
		assert.strictEqual(aclFromDarwinLs('-rwxr-xr-x@ 1 root wheel 1 Jan 1 /usr/bin/x\n 0: group:staff allow write\n'), true);
		assert.strictEqual(aclFromDarwinLs('-rwxr-xr-x@ 1 root wheel 1 Jan 1 /usr/bin/x\n'), false);
		assert.strictEqual(aclFromDarwinLs('drwxr-xr-x+ 3 root wheel 96 Jan 1 /x\n'), true);
		assert.strictEqual(aclFromDarwinLs('not ls output'), true);
	});

	test('a symlinked legacy store is never taken over (it could pull the store into a workspace)', async () => {
		const ws = path.join(tmp, 'ws-legacy');
		await program(path.join(ws, 'tools', 'evil', '1', 'bin'), 'openocd');
		await fs.writeFile(path.join(ws, 'tools', 'index.json'), JSON.stringify([{ id: 'evil', version: '1', binDir: 'bin', sha256: 'x', onPath: true }]));
		const legacyParent = path.join(tmp, 'home2', '.roboagent');
		await fs.mkdir(legacyParent, { recursive: true });
		await fs.symlink(path.join(ws, 'tools'), path.join(legacyParent, 'tools'));
		const target = path.join(tmp, 'data2', 'roboagent', 'tools');
		const store = new NodeToolStore({ root: target, migrateFrom: path.join(legacyParent, 'tools') });
		assert.deepStrictEqual(await store.installed(), []);
		assert.ok(await fs.stat(path.join(ws, 'tools', 'index.json')).then(() => true), 'left alone');
		assert.strictEqual(await fs.lstat(target).then(() => true, () => false), false, 'nothing moved into place');
	});

	test('a bin folder that links out of its install is not trusted', async () => {
		const store = path.join(tmp, 'store4');
		const outside = path.join(tmp, 'outside4');
		await program(outside, 'openocd');
		await fs.mkdir(path.join(store, 'y', '1'), { recursive: true });
		await fs.symlink(outside, path.join(store, 'y', '1', 'bin'));
		await fs.writeFile(path.join(store, 'index.json'), JSON.stringify([{ id: 'y', version: '1', binDir: 'bin', sha256: 'x', onPath: true }]));
		assert.deepStrictEqual(await new NodeToolStore({ root: store }).installed(), []);
	});

	test('tools whose install folder is a link leading out of the store are not trusted', async () => {
		const store = path.join(tmp, 'store3');
		const outside = path.join(tmp, 'outside3');
		await program(path.join(outside, 'bin'), 'openocd');
		await fs.mkdir(path.join(store, 'x'), { recursive: true });
		await fs.symlink(outside, path.join(store, 'x', '1'));
		await fs.writeFile(path.join(store, 'index.json'), JSON.stringify([{ id: 'x', version: '1', binDir: 'bin', sha256: 'x', onPath: true }]));
		assert.deepStrictEqual(await new NodeToolStore({ root: store }).installed(), []);
	});
});
