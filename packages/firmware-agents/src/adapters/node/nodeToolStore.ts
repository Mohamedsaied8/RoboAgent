/*---------------------------------------------------------------------------------------------
 *  Copyright (c) RoboAgent. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { createHash, randomUUID } from 'crypto';
import { createWriteStream, promises as fs } from 'fs';
import * as os from 'os';
import * as path from 'path';
import { Readable } from 'stream';
import { pipeline } from 'stream/promises';
import { ArchiveSpec, InstalledTool, IToolStore, PlatformId } from '../../kernel/host';
import { ALLOWED_DOWNLOAD_HOSTS, isSafeToolName, validateArchiveSpec } from '../../install/manifest';
import { isInside } from './nodeFileSystem';
import { runProcess } from './nodeProcessRunner';

export interface NodeToolStoreOptions {
	/** Store folder; must be outside any workspace the agents work in. */
	readonly root: string;
	readonly fetchImpl?: typeof fetch;
	readonly allowedHosts?: readonly string[];
	/** Platform override (tests); default: this machine. */
	readonly platform?: PlatformId | null;
}

/**
 * `$ROBOAGENT_TOOLS_DIR` when set; otherwise `roboagent/tools` in the platform's per-user data
 * folder, taken from the environment: `$XDG_DATA_HOME` (Linux; its default `~/.local/share`),
 * `%LOCALAPPDATA%` (Windows), `~/Library/Application Support` (macOS).
 */
export function defaultToolStoreRoot(env: Readonly<Record<string, string | undefined>> = process.env, platform: NodeJS.Platform = process.platform, home: string = os.homedir()): string {
	if (env.ROBOAGENT_TOOLS_DIR) {
		return env.ROBOAGENT_TOOLS_DIR;
	}
	const dataDir = platform === 'win32'
		? env.LOCALAPPDATA || path.join(home, 'AppData', 'Local')
		: platform === 'darwin'
			? path.join(home, 'Library', 'Application Support')
			// The XDG spec: a relative $XDG_DATA_HOME is invalid and must be ignored.
			: env.XDG_DATA_HOME && path.isAbsolute(env.XDG_DATA_HOME) ? env.XDG_DATA_HOME : path.join(home, '.local', 'share');
	return path.join(dataDir, 'roboagent', 'tools');
}

export function currentPlatform(platform: NodeJS.Platform = process.platform, arch: string = process.arch): PlatformId | undefined {
	const supported: readonly PlatformId[] = ['linux-x64', 'linux-arm64', 'darwin-x64', 'darwin-arm64', 'win32-x64'];
	return supported.find(p => p === `${platform}-${arch}`);
}

/**
 * What the index records. Paths are **never** stored (entries written by an earlier development
 * build, which stored absolute paths, are ignored and those tools are simply downloaded again): they are always derived from
 * `<root>/<id>/<version>`, so a tampered index cannot point the store (or `remove`) elsewhere.
 */
interface IndexEntry {
	readonly id: string;
	readonly version: string;
	/** Relative to the install folder. */
	readonly binDir: string;
	readonly sha256: string;
	readonly onPath: boolean;
	readonly installedAt: string;
	readonly url: string;
}

/** Why an archive was refused (tampered, unsafe, wrong size…). */
export class ToolInstallError extends Error {
	constructor(message: string) {
		super(message);
		this.name = 'ToolInstallError';
	}
}

const LIST_FLAGS: Readonly<Record<ArchiveSpec['format'], string>> = { 'tar.gz': '-tzf', 'tar.xz': '-tJf', 'zip': '-tf' };
const EXTRACT_FLAGS: Readonly<Record<ArchiveSpec['format'], string>> = { 'tar.gz': '-xzf', 'tar.xz': '-xJf', 'zip': '-xf' };
const LOCK_STALE_MS = 10 * 60_000;
const TMP_STALE_MS = 6 * 60 * 60_000;

/**
 * {@link IToolStore} on disk. Install = download (https, allowlisted hosts, exact size) →
 * SHA-256 check → list and reject unsafe names → extract into a fresh temp folder with the
 * system `tar` → reject links leading outside → atomic rename into `<root>/<id>/<version>`.
 * Nothing from an archive is ever executed during install.
 */
export class NodeToolStore implements IToolStore {
	readonly location: string;
	private readonly fetchImpl: typeof fetch;
	private readonly allowedHosts: readonly string[];
	private readonly inFlight = new Map<string, Promise<InstalledTool>>();
	/** Serialises index updates inside this process; the lock folder covers other processes. */
	private indexQueue: Promise<unknown> = Promise.resolve();

	constructor(private readonly options: NodeToolStoreOptions) {
		this.location = path.resolve(options.root);
		this.fetchImpl = options.fetchImpl ?? fetch;
		this.allowedHosts = options.allowedHosts ?? ALLOWED_DOWNLOAD_HOSTS;
	}

	platform(): PlatformId | undefined {
		return this.options.platform === null ? undefined : this.options.platform ?? currentPlatform();
	}

	async installed(): Promise<InstalledTool[]> {
		const present: InstalledTool[] = [];
		for (const e of await this.readIndex()) {
			const tool = this.toInstalled(e);
			if (tool && await fs.stat(tool.binDir).then(s => s.isDirectory(), () => false)) {
				present.push(tool);
			}
		}
		return present;
	}

	async find(id: string, version?: string): Promise<InstalledTool | undefined> {
		return (await this.installed()).filter(t => t.id === id && (!version || t.version === version)).at(-1);
	}

	async binPaths(): Promise<string[]> {
		return (await this.installed()).filter(t => t.onPath).map(t => t.binDir).reverse();
	}

	async readFile(id: string, version: string, relativePath: string, maxBytes = 1024 * 1024): Promise<string> {
		const tool = await this.find(id, version);
		if (!tool) {
			throw new ToolInstallError(`${id} ${version} is not installed.`);
		}
		const real = await fs.realpath(path.resolve(tool.dir, relativePath));
		if (!isInside(await fs.realpath(tool.dir), real)) {
			throw new ToolInstallError(`${relativePath} is outside the ${id} install.`);
		}
		const stat = await fs.stat(real);
		if (!stat.isFile() || stat.size > maxBytes) {
			throw new ToolInstallError(`${relativePath} is not a regular file of at most ${maxBytes} bytes.`);
		}
		return fs.readFile(real, 'utf8');
	}

	install(spec: ArchiveSpec, options: { signal?: AbortSignal; onProgress?: (bytes: number, total: number) => void } = {}): Promise<InstalledTool> {
		const key = `${spec.id}@${spec.version}`;
		let running = this.inFlight.get(key);
		if (!running) {
			running = this.doInstall(spec, options).finally(() => this.inFlight.delete(key));
			this.inFlight.set(key, running);
		}
		return running;
	}

	async remove(id: string, version?: string): Promise<void> {
		await this.updateIndex(async entries => {
			const gone = entries.filter(e => e.id === id && (!version || e.version === version));
			for (const e of gone) {
				const dir = this.installDir(e.id, e.version);
				if (dir) {
					await fs.rm(dir, { recursive: true, force: true });
					await fs.rmdir(path.dirname(dir)).catch(() => { }); // the tool's folder, once its last version is gone
				}
			}
			return entries.filter(e => !gone.includes(e));
		});
	}

	/** `<root>/<id>/<version>`, or undefined for names that could leave the store. */
	private installDir(id: string, version: string): string | undefined {
		if (!isSafeToolName(id) || !isSafeToolName(version)) {
			return undefined;
		}
		const dir = path.join(this.location, id, version);
		return isInside(this.location, dir) && dir !== this.location ? dir : undefined;
	}

	private toInstalled(e: IndexEntry): InstalledTool | undefined {
		const dir = e && typeof e.id === 'string' && typeof e.version === 'string' ? this.installDir(e.id, e.version) : undefined;
		if (!dir || typeof e.binDir !== 'string' || path.isAbsolute(e.binDir) || e.binDir.split(/[\\/]/).includes('..')) {
			return undefined;
		}
		return { id: e.id, version: e.version, dir, binDir: path.join(dir, e.binDir), sha256: String(e.sha256), onPath: e.onPath === true };
	}

	private async doInstall(spec: ArchiveSpec, options: { signal?: AbortSignal; onProgress?: (bytes: number, total: number) => void }): Promise<InstalledTool> {
		const invalid = validateArchiveSpec(spec, this.allowedHosts);
		const finalDir = this.installDir(spec.id, spec.version);
		if (invalid || !finalDir) {
			throw new ToolInstallError(invalid ?? `unsafe tool name ${spec.id}@${spec.version}`);
		}
		const existing = await this.find(spec.id, spec.version);
		if (existing && existing.sha256 === spec.sha256) {
			return existing;
		}
		const tmpRoot = path.join(this.location, '.tmp');
		await fs.mkdir(tmpRoot, { recursive: true });
		await this.cleanStaleTemp(tmpRoot);
		const tmp = await fs.mkdtemp(path.join(tmpRoot, `${spec.id}-`));
		try {
			const archive = path.join(tmp, `download.${spec.format}`);
			await this.download(spec, archive, options);
			await this.checkListing(spec, archive, tmp, options.signal);
			const extracted = path.join(tmp, 'x');
			await fs.mkdir(extracted);
			const x = await runProcess(tmp, 'tar', [EXTRACT_FLAGS[spec.format], archive, '-C', extracted, '--no-same-owner'], { timeoutMs: 15 * 60_000, ...options.signal ? { signal: options.signal } : {} });
			if (x.exitCode !== 0) {
				throw new ToolInstallError(`Extracting ${spec.id} failed: ${(x.stderr || x.spawnError || '').trim().slice(0, 300)}`);
			}
			await this.checkTree(extracted, extracted);
			if (!await fs.stat(path.join(extracted, spec.binDir)).then(s => s.isDirectory(), () => false)) {
				throw new ToolInstallError(`${spec.id} ${spec.version}: expected folder ${spec.binDir} is not in the archive.`);
			}
			const entry: IndexEntry = { id: spec.id, version: spec.version, binDir: spec.binDir, sha256: spec.sha256, onPath: spec.onPath, installedAt: new Date().toISOString(), url: spec.url };
			await this.updateIndex(async entries => {
				await fs.rm(finalDir, { recursive: true, force: true });
				await fs.mkdir(path.dirname(finalDir), { recursive: true });
				await fs.rename(extracted, finalDir);
				return [...entries.filter(e => !(e.id === spec.id && e.version === spec.version)), entry];
			});
			return this.toInstalled(entry)!;
		} finally {
			await fs.rm(tmp, { recursive: true, force: true });
		}
	}

	private async download(spec: ArchiveSpec, dest: string, options: { signal?: AbortSignal; onProgress?: (bytes: number, total: number) => void }): Promise<void> {
		const response = await this.fetchImpl(spec.url, { redirect: 'follow', ...options.signal ? { signal: options.signal } : {} });
		if (response.url) {
			const final = new URL(response.url);
			if (final.protocol !== 'https:' || !this.allowedHosts.includes(final.hostname)) {
				throw new ToolInstallError(`Download of ${spec.id} was redirected to ${final.hostname}, which is not an allowed host.`);
			}
		}
		if (!response.ok || !response.body) {
			throw new ToolInstallError(`Download of ${spec.id} failed: HTTP ${response.status}`);
		}
		const hash = createHash('sha256');
		let bytes = 0;
		const body = response.body as unknown as AsyncIterable<Uint8Array>;
		async function* checked() {
			for await (const chunk of body) {
				bytes += chunk.byteLength;
				if (bytes > spec.size) {
					throw new ToolInstallError(`Download of ${spec.id} is larger than the pinned ${spec.size} bytes; refusing it.`);
				}
				hash.update(chunk);
				options.onProgress?.(bytes, spec.size);
				yield chunk;
			}
		}
		// pipeline propagates write errors (e.g. a full disk) and closes both ends on failure.
		const out = createWriteStream(dest, { flags: 'wx', mode: 0o600 });
		if (options.signal) {
			await pipeline(Readable.from(checked()), out, { signal: options.signal });
		} else {
			await pipeline(Readable.from(checked()), out);
		}
		if (bytes !== spec.size) {
			throw new ToolInstallError(`Download of ${spec.id} is ${bytes} bytes, expected ${spec.size}; refusing it.`);
		}
		const actual = hash.digest('hex');
		if (actual !== spec.sha256) {
			throw new ToolInstallError(`SHA-256 of ${spec.id} ${spec.version} does not match the vendor's published value (got ${actual}); refusing it.`);
		}
	}

	/** Refuses archives with absolute names, drive letters or `..` segments before extracting anything. */
	private async checkListing(spec: ArchiveSpec, archive: string, cwd: string, signal?: AbortSignal): Promise<void> {
		const list = await runProcess(cwd, 'tar', [LIST_FLAGS[spec.format], archive], { timeoutMs: 10 * 60_000, maxOutputBytes: 64 * 1024 * 1024, ...signal ? { signal } : {} });
		if (list.exitCode !== 0) {
			throw new ToolInstallError(`${spec.id}: the archive cannot be read (${(list.stderr || list.spawnError || '').trim().slice(0, 200)}).`);
		}
		if (list.truncated) {
			throw new ToolInstallError(`${spec.id}: the archive listing is too long to check; refusing it.`);
		}
		for (const name of list.stdout.split(/\r?\n/).filter(Boolean)) {
			const n = name.replace(/\\/g, '/');
			if (n.startsWith('/') || /^[A-Za-z]:/.test(n) || n.split('/').includes('..')) {
				throw new ToolInstallError(`${spec.id}: unsafe path "${name}" in the archive; refusing it.`);
			}
		}
	}

	/** After extraction: only files, folders and links that stay inside the install folder. */
	private async checkTree(dir: string, root: string): Promise<void> {
		for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
			const p = path.join(dir, entry.name);
			if (entry.isSymbolicLink()) {
				const target = await fs.readlink(p);
				if (path.isAbsolute(target) || !isInside(root, path.resolve(path.dirname(p), target))) {
					throw new ToolInstallError(`Link ${path.relative(root, p)} → ${target} leads outside the tool folder; refusing the archive.`);
				}
			} else if (entry.isDirectory()) {
				await this.checkTree(p, root);
			} else if (!entry.isFile()) {
				throw new ToolInstallError(`${path.relative(root, p)} is a device, FIFO or socket; refusing the archive.`);
			}
		}
	}

	/** Temp folders left behind by a crashed or killed install. */
	private async cleanStaleTemp(tmpRoot: string): Promise<void> {
		for (const name of await fs.readdir(tmpRoot).catch(() => [] as string[])) {
			const p = path.join(tmpRoot, name);
			const stat = await fs.stat(p).catch(() => undefined);
			if (stat && Date.now() - stat.mtimeMs > TMP_STALE_MS) {
				await fs.rm(p, { recursive: true, force: true });
			}
		}
	}

	private async readIndex(): Promise<IndexEntry[]> {
		try {
			const parsed = JSON.parse(await fs.readFile(path.join(this.location, 'index.json'), 'utf8'));
			return Array.isArray(parsed) ? parsed.filter(e => e && typeof e === 'object') : [];
		} catch {
			return [];
		}
	}

	/** Read-modify-write of the index under an in-process queue and a cross-process lock folder. */
	private updateIndex(update: (entries: IndexEntry[]) => Promise<IndexEntry[]>): Promise<void> {
		const run = this.indexQueue.then(async () => {
			await fs.mkdir(this.location, { recursive: true });
			const lock = path.join(this.location, '.index.lock');
			await acquireLock(lock);
			try {
				const next = await update(await this.readIndex());
				const tmp = path.join(this.location, `.index.${randomUUID()}.json`);
				await fs.writeFile(tmp, JSON.stringify(next, null, '\t'));
				await fs.rename(tmp, path.join(this.location, 'index.json'));
			} finally {
				await fs.rmdir(lock).catch(() => { });
			}
		});
		this.indexQueue = run.catch(() => { });
		return run;
	}
}

/** `mkdir` is atomic: whoever creates the folder holds the lock. A stale lock (crash) is broken. */
async function acquireLock(lock: string): Promise<void> {
	const deadline = Date.now() + 60_000;
	for (; ;) {
		try {
			await fs.mkdir(lock);
			return;
		} catch (err) {
			if ((err as NodeJS.ErrnoException).code !== 'EEXIST') {
				throw err;
			}
			const stat = await fs.stat(lock).catch(() => undefined);
			if (stat && Date.now() - stat.mtimeMs > LOCK_STALE_MS) {
				// Rename first: only one waiter can move the stale lock away, so a second one cannot
				// remove a lock that the first has just taken.
				const doomed = `${lock}.stale-${randomUUID()}`;
				if (await fs.rename(lock, doomed).then(() => true, () => false)) {
					await fs.rmdir(doomed).catch(() => { });
				}
				continue;
			}
			if (Date.now() > deadline) {
				throw new ToolInstallError(`The tool store is locked by another process (${lock}).`);
			}
			await new Promise(r => setTimeout(r, 100));
		}
	}
}
