/*---------------------------------------------------------------------------------------------
 *  Copyright (c) RoboAgent. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as assert from 'assert';
import { execFileSync } from 'child_process';
import { promises as fs } from 'fs';
import * as os from 'os';
import * as path from 'path';
import { NodeAgentHost } from '../adapters/node/nodeAgentHost';
import { NodeSystemProbe } from '../adapters/node/nodeSystemProbe';
import { NodeToolStore } from '../adapters/node/nodeToolStore';

/** Waits until `check` holds (polling), or fails after `ms`. */
async function until(check: () => boolean | Promise<boolean>, ms = 10_000): Promise<void> {
	const deadline = Date.now() + ms;
	while (!await check()) {
		if (Date.now() > deadline) {
			throw new Error('condition not met in time');
		}
		await new Promise(r => setTimeout(r, 25));
	}
}

function which(name: string): string | undefined {
	try {
		return execFileSync('sh', ['-c', `command -v ${name}`], { encoding: 'utf8' }).trim() || undefined;
	} catch {
		return undefined;
	}
}

suite('NodeAgentHost.spawn and trusted data folders', function () {

	this.timeout(20_000);
	let tmp: string;
	let ws: string;
	let storeRoot: string;

	setup(async function () {
		if (process.platform === 'win32') {
			this.skip();
		}
		tmp = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'fwagents-spawn-')));
		ws = path.join(tmp, 'ws');
		storeRoot = path.join(tmp, 'store');
		await fs.mkdir(ws);
		await fs.mkdir(path.join(storeRoot, 'tool', '1.0', 'scripts'), { recursive: true });
	});

	teardown(async () => {
		if (tmp) {
			await fs.rm(tmp, { recursive: true, force: true });
		}
	});

	function host(env: Record<string, string> = {}): NodeAgentHost {
		return new NodeAgentHost({ root: ws, toolStore: new NodeToolStore({ root: storeRoot, platform: 'linux-x64' }), env: { ...process.env as Record<string, string>, ...env }, write: () => { } });
	}

	test('talks to a long-lived program over stdin/stdout, with secrets and unset variables removed', async function () {
		const cat = which('cat');
		const sh = which('sh');
		if (!cat || !sh) {
			this.skip();
		}
		const out: string[] = [];
		const h = host({ OPENOCD_SCRIPTS: '/evil', MY_API_KEY: 'sk-secret' });
		const p = h.spawn(cat!, [], { onOutput: (_s, chunk) => out.push(chunk) });
		p.write('hello\n');
		await until(() => out.join('') === 'hello\n');
		const exit = await p.kill();
		assert.notStrictEqual(exit.spawnError, 'killed before it started');

		const env: string[] = [];
		const q = h.spawn(sh!, ['-c', 'echo "[$OPENOCD_SCRIPTS][$MY_API_KEY]"'], { unsetEnv: ['OPENOCD_SCRIPTS'], onOutput: (_s, c) => env.push(c) });
		await q.exited;
		assert.strictEqual(env.join('').trim(), '[][]');
	});

	test('refuses relative programs, and working folders that are not trusted or are in the workspace', async function () {
		const sh = which('sh');
		if (!sh) {
			this.skip();
		}
		const h = host();
		assert.match((await h.spawn('openocd', []).exited).spawnError ?? '', /absolute program path/);
		for (const bad of [ws, path.join(ws, 'sub'), tmp, 'relative/dir']) {
			assert.match((await h.spawn(sh!, ['-c', 'true'], { trustedCwd: bad }).exited).spawnError ?? '', /not a trusted working folder/, bad);
		}
		const scripts = path.join(storeRoot, 'tool', '1.0', 'scripts');
		const out: string[] = [];
		const ok = h.spawn(sh!, ['-c', 'pwd'], { trustedCwd: scripts, onOutput: (_s, c) => out.push(c) });
		assert.strictEqual((await ok.exited).exitCode, 0);
		assert.strictEqual(out.join('').trim(), scripts);
	});

	test('kill stops the whole process group, including children it started', async function () {
		const sh = which('sh');
		if (!sh) {
			this.skip();
		}
		const marker = path.join(tmp, 'still-running');
		const started = path.join(tmp, 'started');
		const p = host().spawn(sh!, ['-c', `touch ${started}; (sleep 1; touch ${marker}) & sleep 30`]);
		await until(() => fs.access(started).then(() => true, () => false));
		await p.kill();
		// Long enough for the background child to have touched the marker had it survived.
		await new Promise(r => setTimeout(r, 1500));
		assert.strictEqual(await fs.access(marker).then(() => true, () => false), false);
	});

	test('a handle killed before its program started never starts it; setup failures resolve, never reject', async function () {
		const sh = which('sh');
		if (!sh) {
			this.skip();
		}
		const marker = path.join(tmp, 'ran');
		const h = host();
		const p = h.spawn(sh!, ['-c', `touch ${marker}`]);
		assert.match((await p.kill()).spawnError ?? '', /killed before it started/);
		await new Promise(r => setTimeout(r, 300));
		assert.strictEqual(await fs.access(marker).then(() => true, () => false), false);

		const broken = new NodeAgentHost({ root: ws, toolStore: Object.assign(new NodeToolStore({ root: storeRoot, platform: 'linux-x64' }), { binPaths: () => Promise.reject(new Error('index unreadable')) }), write: () => { } });
		assert.match((await broken.spawn(sh!, ['-c', 'true']).exited).spawnError ?? '', /could not prepare .* index unreadable/);
	});

	test('trustedDataDir: tool-store folders and root-owned folders; never the workspace or user folders', async () => {
		const probe = new NodeSystemProbe({ workspaceRoot: ws, toolStoreRoot: storeRoot });
		const scripts = path.join(storeRoot, 'tool', '1.0', 'scripts');
		await fs.mkdir(path.join(ws, 'scripts'));
		assert.strictEqual(await probe.trustedDataDir([path.join(ws, 'scripts'), tmp, 'relative', scripts]), scripts);
		assert.strictEqual(await probe.trustedDataDir([storeRoot]), undefined, 'the store root itself is not a data folder');
		// A link from the store into the workspace resolves to the workspace and is refused.
		await fs.symlink(path.join(ws, 'scripts'), path.join(storeRoot, 'tool', '1.0', 'link'));
		assert.strictEqual(await probe.trustedDataDir([path.join(storeRoot, 'tool', '1.0', 'link')]), undefined);
		if (process.getuid?.() !== 0) {
			// /usr (root-owned, not writable by others) on any normal Linux/macOS.
			assert.strictEqual(await probe.trustedDataDir(['/usr']), '/usr');
		}
	});
});
