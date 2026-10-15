/*---------------------------------------------------------------------------------------------
 *  Copyright (c) RoboAgent. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as assert from 'assert';
import { execFileSync } from 'child_process';
import { createHash } from 'crypto';
import { promises as fs } from 'fs';
import * as os from 'os';
import * as path from 'path';
import { NodeAgentHost } from '../adapters/node/nodeAgentHost';
import { NodeToolStore } from '../adapters/node/nodeToolStore';
import { ArchiveSpec } from '../kernel/host';

suite('NodeToolStore (real tar, local archives)', function () {

	this.timeout(60_000);
	let tmp: string;
	let store: NodeToolStore;
	let fetches: string[];
	let served: Map<string, Buffer>;
	let redirectTo: string | undefined;

	const URL_BASE = 'https://github.com/vendor/tool/releases/download/v1';

	setup(async function () {
		if (process.platform === 'win32') {
			this.skip();
		}
		tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'fwagents-store-'));
		fetches = [];
		served = new Map();
		redirectTo = undefined;
		const fetchImpl = (async (url: string) => {
			fetches.push(url);
			const body = served.get(url);
			const response = body ? new Response(new Uint8Array(body), { status: 200 }) : new Response('not found', { status: 404 });
			Object.defineProperty(response, 'url', { value: redirectTo ?? url });
			return response;
		}) as typeof fetch;
		store = new NodeToolStore({ root: path.join(tmp, 'store'), fetchImpl, platform: 'linux-x64' });
	});

	teardown(async () => {
		if (tmp) {
			await fs.rm(tmp, { recursive: true, force: true });
		}
	});

	/** Builds `tool-1.0/bin/fake-tool` (+ an internal relative symlink) as a tar.gz and serves it. */
	async function serveGoodArchive(name = 'good.tar.gz'): Promise<ArchiveSpec> {
		const src = path.join(tmp, 'src', name);
		const bin = path.join(src, 'tool-1.0', 'bin');
		await fs.mkdir(bin, { recursive: true });
		await fs.writeFile(path.join(bin, 'fake-tool'), '#!/bin/sh\necho "fake-tool 1.0"\n', { mode: 0o755 });
		await fs.mkdir(path.join(src, 'tool-1.0', 'lib'));
		await fs.writeFile(path.join(src, 'tool-1.0', 'lib', 'libx.so.1.2'), 'x');
		await fs.symlink('libx.so.1.2', path.join(src, 'tool-1.0', 'lib', 'libx.so.1'));
		const archive = path.join(tmp, name);
		execFileSync('tar', ['-czf', archive, '-C', src, 'tool-1.0']);
		return serve(archive, name);
	}

	async function serve(archive: string, name: string): Promise<ArchiveSpec> {
		const bytes = await fs.readFile(archive);
		const url = `${URL_BASE}/${name}`;
		served.set(url, bytes);
		return { id: 'fake-tool', version: '1.0', url, sha256: createHash('sha256').update(bytes).digest('hex'), size: bytes.length, format: 'tar.gz', binDir: 'tool-1.0/bin', onPath: true };
	}

	/** An archive built with Python's tarfile, which (unlike tar) lets us write hostile entries. */
	async function serveHostile(kind: 'dotdot' | 'symlink'): Promise<ArchiveSpec> {
		const archive = path.join(tmp, `${kind}.tar.gz`);
		const script = kind === 'dotdot'
			? `import tarfile,io\nt=tarfile.open('${archive}','w:gz')\nfor n in ['tool-1.0/bin/fake-tool','tool-1.0/../../evil.sh']:\n  i=tarfile.TarInfo(n);d=b'x';i.size=len(d);t.addfile(i,io.BytesIO(d))\nt.close()`
			: `import tarfile,io\nt=tarfile.open('${archive}','w:gz')\ni=tarfile.TarInfo('tool-1.0/bin/fake-tool');i.size=1;t.addfile(i,io.BytesIO(b'x'))\nl=tarfile.TarInfo('tool-1.0/bin/escape');l.type=tarfile.SYMTYPE;l.linkname='../../../../../etc/passwd';t.addfile(l)\nt.close()`;
		execFileSync('python3', ['-c', script]);
		return serve(archive, `${kind}.tar.gz`);
	}

	test('installs a verified archive atomically, records it, and a second install is a no-op', async () => {
		const spec = await serveGoodArchive();
		const tool = await store.install(spec);
		assert.strictEqual(tool.binDir, path.join(tmp, 'store', 'fake-tool', '1.0', 'tool-1.0', 'bin'));
		assert.strictEqual(execFileSync(path.join(tool.binDir, 'fake-tool')).toString().trim(), 'fake-tool 1.0');
		assert.strictEqual(await fs.readlink(path.join(tool.dir, 'tool-1.0', 'lib', 'libx.so.1')), 'libx.so.1.2');
		assert.deepStrictEqual((await store.installed()).map(t => `${t.id}@${t.version}`), ['fake-tool@1.0']);
		assert.deepStrictEqual(await store.binPaths(), [tool.binDir]);
		await store.install(spec);
		assert.strictEqual(fetches.length, 1, 'second install must not download again');
		assert.deepStrictEqual(await fs.readdir(path.join(tmp, 'store', '.tmp')), [], 'temp folders are cleaned up');
	});

	test('refuses a tampered download (hash) and a wrong size, installing nothing', async () => {
		const spec = await serveGoodArchive();
		await assert.rejects(store.install({ ...spec, sha256: '0'.repeat(64) }), /does not match the vendor's published value/);
		await assert.rejects(store.install({ ...spec, size: spec.size - 1 }), /larger than the pinned/);
		await assert.rejects(store.install({ ...spec, size: spec.size + 1 }), /expected .*refusing/);
		assert.deepStrictEqual(await store.installed(), []);
	});

	test('refuses archives with "../" entries or links leading outside, before anything lands in the store', async () => {
		await assert.rejects(store.install(await serveHostile('dotdot')), /unsafe path "tool-1.0\/..\/..\/evil.sh"/);
		await assert.rejects(store.install({ ...await serveHostile('symlink'), id: 'fake-tool-2' }), /leads outside the tool folder/);
		assert.deepStrictEqual(await store.installed(), []);
		assert.strictEqual(await fs.access(path.join(tmp, 'evil.sh')).then(() => true, () => false), false);
	});

	test('refuses redirects to hosts outside the allowlist, http URLs and unknown hosts', async () => {
		const spec = await serveGoodArchive();
		redirectTo = 'https://evil.example/payload.tgz';
		await assert.rejects(store.install(spec), /redirected to evil.example/);
		redirectTo = undefined;
		await assert.rejects(store.install({ ...spec, url: spec.url.replace('https:', 'http:') }), /not https/);
		await assert.rejects(store.install({ ...spec, url: 'https://evil.example/x.tgz' }), /not an allowed download host/);
	});

	test('remove deletes the install and its index entry', async () => {
		await store.install(await serveGoodArchive());
		await store.remove('fake-tool');
		assert.deepStrictEqual([await store.installed(), await fs.readdir(path.join(tmp, 'store'))], [[], ['.tmp', 'index.json']]);
	});

	test('NodeAgentHost puts installed tools first on PATH for every command it runs', async () => {
		await store.install(await serveGoodArchive());
		const ws = path.join(tmp, 'ws');
		await fs.mkdir(ws);
		const host = new NodeAgentHost({ root: ws, toolStore: store, write: () => { } });
		const result = await host.exec('fake-tool', []);
		assert.deepStrictEqual([result.exitCode, result.stdout.trim()], [0, 'fake-tool 1.0']);
	});

	test('a tampered index cannot point the store elsewhere: entries are re-derived, and remove stays inside', async () => {
		const victim = path.join(tmp, 'victim');
		await fs.mkdir(path.join(victim, 'bin'), { recursive: true });
		await fs.mkdir(path.join(tmp, 'store'), { recursive: true });
		await fs.writeFile(path.join(tmp, 'store', 'index.json'), JSON.stringify([
			{ id: 'evil', version: '1', dir: victim, binDir: path.join(victim, 'bin'), sha256: 'x', onPath: true },
			{ id: '..', version: '..', binDir: 'bin', sha256: 'x', onPath: true },
			{ id: 'ok', version: '1', binDir: '../../victim/bin', sha256: 'x', onPath: true },
		]));
		assert.deepStrictEqual(await store.installed(), []);
		await store.remove('evil');
		await store.remove('..');
		assert.ok(await fs.stat(victim).then(() => true, () => false), 'nothing outside the store was deleted');
	});

	test('concurrent installs of different tools all end up in the index', async () => {
		const specs = await Promise.all(['a', 'b', 'c'].map(async n => ({ ...await serveGoodArchive(`${n}.tar.gz`), id: `tool-${n}` })));
		await Promise.all(specs.map(sp => store.install(sp)));
		assert.deepStrictEqual((await store.installed()).map(t => t.id).sort(), ['tool-a', 'tool-b', 'tool-c']);
	});

	test('a stream that fails mid-download is a rejection (no crash) and leaves nothing behind', async () => {
		const spec = await serveGoodArchive();
		const failing = new NodeToolStore({
			root: path.join(tmp, 'store'), platform: 'linux-x64',
			fetchImpl: (async () => new Response(new ReadableStream({
				start(c) {
					c.enqueue(new Uint8Array(10));
					c.error(new Error('connection reset'));
				},
			}), { status: 200 })) as typeof fetch,
		});
		await assert.rejects(failing.install(spec), /connection reset/);
		assert.deepStrictEqual(await fs.readdir(path.join(tmp, 'store', '.tmp')), []);
	});

	test('readFile serves files inside an install and refuses paths that leave it', async () => {
		await store.install(await serveGoodArchive());
		assert.strictEqual(await store.readFile('fake-tool', '1.0', 'tool-1.0/lib/libx.so.1.2'), 'x');
		await assert.rejects(store.readFile('fake-tool', '1.0', '../../index.json'), /outside the fake-tool install/);
	});

	test('NodeAgentHost refuses a tool store inside the workspace, or one that contains it', async () => {
		const ws = path.join(tmp, 'ws');
		await fs.mkdir(ws);
		assert.throws(() => new NodeAgentHost({ root: ws, toolStore: new NodeToolStore({ root: path.join(ws, '.tools') }), write: () => { } }), /must not be inside the workspace/);
		assert.throws(() => new NodeAgentHost({ root: ws, toolStore: new NodeToolStore({ root: tmp }), write: () => { } }), /must not be inside the workspace/);
		// A store that does not exist yet, reached through a symlink into the workspace.
		await fs.symlink(ws, path.join(tmp, 'link'));
		assert.throws(() => new NodeAgentHost({ root: ws, toolStore: new NodeToolStore({ root: path.join(tmp, 'link', 'not-yet', 'tools') }), write: () => { } }), /must not be inside the workspace/);
	});
});
