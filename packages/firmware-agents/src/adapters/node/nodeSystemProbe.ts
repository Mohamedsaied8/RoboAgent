/*---------------------------------------------------------------------------------------------
 *  Copyright (c) RoboAgent. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { constants, promises as fs } from 'fs';
import * as os from 'os';
import * as path from 'path';
import { ISystemProbe, ProgramSearchOptions, UdevRuleFile } from '../../kernel/host';
import { isInside } from './nodeFileSystem';
import { runProcess } from './nodeProcessRunner';

export interface NodeSystemProbeOptions {
	/** Environment to search (default: this process's). */
	readonly env?: Readonly<Record<string, string | undefined>>;
	/** Workspace root: its folders are never searched (the model can write there). */
	readonly workspaceRoot?: string;
	/** The tool store's bin folders, searched first unless `systemOnly` is asked for. */
	readonly toolStoreBins?: () => Promise<string[]>;
	/** The tool store's folder: data folders inside it count as trusted (see `trustedDataDir`). */
	readonly toolStoreRoot?: string;
	readonly platform?: NodeJS.Platform;
}

const LS_MODE_LINE = /^[-dlbcpsD?][-rwxsStTlL]{9}([.+@]?)\s/;

/**
 * One flag per `ls -ld` line: true when the line carries an ACL marker (`+`), and also when the
 * line does not look like `ls` output at all (a fake `ls` must not read as "no ACL").
 */
export function aclFlags(lsOutput: string): boolean[] {
	return lsOutput.split('\n').filter(l => l.trim()).map(l => {
		const m = LS_MODE_LINE.exec(l);
		return !m || m[1] === '+';
	});
}

/**
 * macOS `ls -lde`: `@` (extended attributes) replaces `+` when a file has both, so ACLs are read
 * from the numbered entries `ls -e` prints under the file (` 0: group:staff allow write`).
 */
export function aclFromDarwinLs(lsOutput: string): boolean {
	const lines = lsOutput.split('\n').filter(l => l.trim());
	const first = lines[0] && LS_MODE_LINE.exec(lines[0]);
	return !first || first[1] === '+' || lines.slice(1).some(l => /^\s*\d+:\s/.test(l));
}

/**
 * udev's rule folders as compiled into udevadm: a contiguous run of NUL-separated strings such as
 * `/etc/udev/rules.d\0/run/udev/rules.d\0…/usr/lib/udev/rules.d`, in priority order. Taking the
 * whole run (and only the longest one) keeps unrelated strings out and the order intact.
 */
export function rulesDirList(binary: string): string[] {
	let best: string[] = [];
	for (const m of binary.matchAll(/(?:\/[\w./+-]*\/udev\/rules\.d\0+)+/g)) {
		const run = m[0].split('\0').filter(Boolean);
		if (run.length > best.length) {
			best = run;
		}
	}
	return best;
}
const MAX_BINARY_BYTES = 64 * 1024 * 1024;
/** How long an ACL answer is reused (long-running hosts re-check now and then). */
const ACL_CACHE_MS = 5 * 60_000;

/**
 * {@link ISystemProbe} for Node: nothing about the system layout is hard-coded. Programs are
 * found by searching PATH; udev's rule folders are read from the `udevadm` binary itself (the
 * list udev actually uses, in its priority order), falling back to `pkg-config`.
 */
export class NodeSystemProbe implements ISystemProbe {
	private readonly env: Readonly<Record<string, string | undefined>>;
	private readonly platform: NodeJS.Platform;
	private ruleDirs?: Promise<string[]>;
	/** True when udev's administrator folder (the first in its list) is missing or untrusted. */
	private adminDirMissing = false;

	constructor(private readonly options: NodeSystemProbeOptions = {}) {
		this.env = options.env ?? process.env;
		this.platform = options.platform ?? process.platform;
	}

	/**
	 * Search order: the tool store's bins (unless `systemOnly`), then PATH, then — because PATH
	 * of a normal user often lacks them — the `sbin` sibling of every `…/bin` folder on PATH.
	 * Relative entries and folders inside the workspace are skipped.
	 */
	private async searchDirs(options: ProgramSearchOptions): Promise<string[]> {
		const delimiter = this.platform === 'win32' ? ';' : ':';
		const pathKey = Object.keys(this.env).find(k => k.toUpperCase() === 'PATH') ?? 'PATH';
		const fromPath = (this.env[pathKey] ?? '').split(delimiter).filter(d => d && path.isAbsolute(d));
		const sbin = this.platform === 'win32' ? [] : fromPath.filter(d => /[\\/]bin$/.test(d)).map(d => d.replace(/bin$/, 'sbin'));
		const store = options.systemOnly || options.trustedForRoot || !this.options.toolStoreBins ? [] : await this.options.toolStoreBins();
		const workspace = this.options.workspaceRoot && path.resolve(this.options.workspaceRoot);
		return [...new Set([...store, ...fromPath, ...sbin].map(d => path.resolve(d)))].filter(d => !workspace || !isInside(workspace, d));
	}

	async findProgram(name: string, options: ProgramSearchOptions = {}): Promise<string | undefined> {
		if (!/^[\w.+-]+$/.test(name)) {
			return undefined;
		}
		const exts = this.platform === 'win32' ? (this.env.PATHEXT ?? '.EXE;.CMD;.BAT;.COM').split(';').filter(Boolean) : [''];
		for (const dir of await this.searchDirs(options)) {
			for (const ext of exts) {
				const candidate = path.join(dir, `${name}${name.toLowerCase().endsWith(ext.toLowerCase()) ? '' : ext.toLowerCase()}`);
				if (!await this.isExecutable(candidate)) {
					continue;
				}
				if (!options.trustedForRoot) {
					return candidate;
				}
				// The path is kept (multi-call binaries such as BusyBox pick the tool from the name they
				// run under), so every link on the way must sit in a root-trusted folder: a link in a
				// user-writable folder could be re-pointed between this check and the root step.
				if (await this.isLinkChainTrusted(candidate)) {
					return candidate;
				}
			}
		}
		return undefined;
	}

	async trustedDataDir(candidates: readonly string[]): Promise<string | undefined> {
		const workspace = this.options.workspaceRoot && await fs.realpath(this.options.workspaceRoot).catch(() => path.resolve(this.options.workspaceRoot!));
		const store = this.options.toolStoreRoot && await fs.realpath(this.options.toolStoreRoot).catch(() => undefined);
		for (const candidate of candidates) {
			if (!path.isAbsolute(candidate)) {
				continue;
			}
			const real = await fs.realpath(candidate).catch(() => undefined);
			if (!real || !await fs.stat(real).then(s => s.isDirectory(), () => false)) {
				continue;
			}
			if (workspace && (isInside(workspace, real) || isInside(real, workspace))) {
				continue;
			}
			if ((store && isInside(store, real) && real !== store) || await this.isRootTrusted(real)) {
				return real;
			}
		}
		return undefined;
	}

	async udevRuleDirs(): Promise<string[]> {
		this.ruleDirs ??= this.discoverRuleDirs();
		return this.ruleDirs;
	}

	async udevAdminDir(): Promise<string | undefined> {
		const dirs = await this.udevRuleDirs();
		return this.adminDirMissing ? undefined : dirs[0];
	}

	/**
	 * The rules udev actually applies: a file in a higher-priority folder overrides a same-named
	 * one further down, and a link to /dev/null (or an empty file) masks it.
	 */
	async readUdevRules(): Promise<UdevRuleFile[]> {
		const seen = new Set<string>();
		const files: UdevRuleFile[] = [];
		for (const dir of await this.udevRuleDirs()) {
			const names = await fs.readdir(dir).catch(() => [] as string[]);
			for (const name of names.filter(n => n.endsWith('.rules')).sort()) {
				if (seen.has(name)) {
					continue;
				}
				seen.add(name);
				const file = path.join(dir, name);
				const real = await fs.realpath(file).catch(() => undefined);
				const stat = real && await fs.stat(real).catch(() => undefined);
				if (stat && stat.isFile() && stat.size > 0 && stat.size <= 4 * 1024 * 1024) {
					files.push({ file, content: await fs.readFile(real!, 'utf8').catch(() => '') });
				}
			}
		}
		return files;
	}

	/** udev's own list, from the strings compiled into `udevadm`; `pkg-config` as a fallback. */
	private async discoverRuleDirs(): Promise<string[]> {
		if (this.platform !== 'linux') {
			return [];
		}
		let found: string[] = [];
		// Only a root-trusted udevadm: a fake one early on PATH must not choose where root writes.
		const udevadm = await this.findProgram('udevadm', { trustedForRoot: true });
		if (udevadm) {
			const stat = await fs.stat(udevadm).catch(() => undefined);
			if (stat && stat.size <= MAX_BINARY_BYTES) {
				found = rulesDirList((await fs.readFile(udevadm)).toString('latin1'));
			}
		}
		const pkgConfig = !found.length && await this.findProgram('pkg-config', { trustedForRoot: true });
		if (pkgConfig) {
			// Distribution metadata: the sysconf dir (admin rules) first, then `udevdir` (vendor
			// rules). Run without PKG_CONFIG_* so the user's environment cannot redirect it.
			const env = Object.fromEntries(Object.entries(this.env).filter(([k]) => !k.startsWith('PKG_CONFIG')));
			const pc = (args: string[]) => runProcess(os.tmpdir(), pkgConfig, args, { timeoutMs: 10_000, baseEnv: env });
			const udevdir = (await pc(['--variable=udevdir', 'udev'])).stdout.trim();
			const sysconf = (await pc(['--variable=sysconfdir', 'systemd'])).stdout.trim();
			if (sysconf) {
				found.push(path.join(sysconf, 'udev', 'rules.d'));
			}
			if (udevdir) {
				found.push(path.join(udevdir, 'rules.d'));
			}
		}
		// Keep udev's order. Folders must be root-trusted (root writes into the first one). The
		// first one is udev's administrator folder: when it is missing, report none rather than
		// writing somewhere else (e.g. a volatile /run folder or the vendor folder).
		const existing: string[] = [];
		for (const [i, dir] of [...new Set(found)].entries()) {
			const real = await fs.realpath(dir).catch(() => undefined);
			const ok = real && await fs.stat(real).then(s => s.isDirectory(), () => false) && await this.isRootTrusted(real);
			if (i === 0 && !ok) {
				this.adminDirMissing = true;
			}
			if (ok && !existing.includes(real!)) {
				existing.push(real!);
			}
		}
		return existing;
	}

	private async isExecutable(file: string): Promise<boolean> {
		const stat = await fs.stat(file).catch(() => undefined);
		if (!stat?.isFile()) {
			return false;
		}
		return this.platform === 'win32' || await fs.access(file, constants.X_OK).then(() => true, () => false);
	}

	/**
	 * Follows `file` link by link: the folder holding each link (resolved) and the final file
	 * must all be root-trusted.
	 */
	private async isLinkChainTrusted(file: string, trusted: (p: string) => Promise<boolean> = p => this.isRootTrusted(p)): Promise<boolean> {
		let current = file;
		for (let hops = 0; hops < 40; hops++) {
			const dir = await fs.realpath(path.dirname(current)).catch(() => undefined);
			if (!dir || !await trusted(dir)) {
				return false;
			}
			const stat = await fs.lstat(current).catch(() => undefined);
			if (!stat) {
				return false;
			}
			if (!stat.isSymbolicLink()) {
				return trusted(path.join(dir, path.basename(current)));
			}
			current = path.resolve(dir, await fs.readlink(current));
		}
		return false;
	}

	/**
	 * For programs run as root: the file and every folder up to `/` must be owned by root and
	 * not writable by group or others, or a normal user could have replaced it.
	 */
	private async isRootTrusted(file: string): Promise<boolean> {
		if (this.platform === 'win32') {
			return false;
		}
		const chain: string[] = [];
		let p = await fs.realpath(file).catch(() => undefined);
		while (p) {
			const stat = await fs.stat(p).catch(() => undefined);
			if (!stat || stat.uid !== 0 || (stat.mode & 0o022) !== 0) {
				return false;
			}
			chain.push(p);
			const parent = path.dirname(p);
			if (parent === p) {
				return !await this.anyHasAcl(chain);
			}
			p = parent;
		}
		return false;
	}

	/**
	 * Access control lists can grant write access the mode bits do not show (macOS and NFSv4 ACLs;
	 * on Linux a POSIX ACL with a writable entry also shows in the group bits). Any ACL on the
	 * chain makes it untrusted. `ls` marks such paths with `+` after the mode. Without a trusted
	 * `ls`: on Linux the mode bits decide (see below); elsewhere the answer is "has ACL".
	 */
	protected async anyHasAcl(paths: readonly string[]): Promise<boolean> {
		const ls = await this.trustedLs();
		const darwin = this.platform === 'darwin';
		if (!ls && this.platform === 'linux') {
			// On Linux a POSIX ACL that grants write also shows in the group bits, which the caller
			// has already checked; without an `ls` to read markers, the mode bits are the answer.
			return false;
		}
		for (const p of paths) {
			const cached = this.aclCache.get(p);
			if (!cached || Date.now() - cached.at > ACL_CACHE_MS) {
				// One path per call: `ls` sorts its arguments, so lines would not match the order.
				const r = ls ? await runProcess(os.tmpdir(), ls, [darwin ? '-lde' : '-ld', '--', p], { timeoutMs: 10_000, baseEnv: { ...this.env, LC_ALL: 'C' } }) : undefined;
				const acl = r?.exitCode !== 0 || !r ? true : darwin ? aclFromDarwinLs(r.stdout) : aclFlags(r.stdout)[0] ?? true;
				this.aclCache.set(p, { acl, at: Date.now() });
			}
			if (this.aclCache.get(p)!.acl) {
				return true;
			}
		}
		return false;
	}

	private readonly aclCache = new Map<string, { acl: boolean; at: number }>();
	private lsPath?: Promise<string | undefined>;

	/**
	 * `ls` for the ACL check itself, held to the same standard as root programs except the ACL
	 * check (which it implements): every link on the way and the final file root-owned and not
	 * writable by others, and the real file must actually be `ls`.
	 */
	private trustedLs(): Promise<string | undefined> {
		this.lsPath ??= (async () => {
			for (const dir of await this.searchDirs({ systemOnly: true })) {
				const candidate = path.join(dir, 'ls');
				if (!await this.isExecutable(candidate)) {
					continue;
				}
				// Multi-call binaries (BusyBox) are fine: the path is run under the name `ls`, and
				// output that is not `ls` output counts as "has an ACL" anyway.
				if (await this.isLinkChainTrusted(candidate, p => this.modeTrusted(p))) {
					return candidate;
				}
			}
			return undefined;
		})();
		return this.lsPath;
	}

	private async modeTrusted(file: string): Promise<boolean> {
		for (let p = file; ; p = path.dirname(p)) {
			const stat = await fs.stat(p).catch(() => undefined);
			if (!stat || stat.uid !== 0 || (stat.mode & 0o022) !== 0) {
				return false;
			}
			if (path.dirname(p) === p) {
				return true;
			}
		}
	}
}
