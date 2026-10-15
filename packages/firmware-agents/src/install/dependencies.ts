/*---------------------------------------------------------------------------------------------
 *  Copyright (c) RoboAgent. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { createHash } from 'crypto';
import { IAgentHost, InstalledTool, PlatformId } from '../kernel/host';
import { archiveFor, TOOL_MANIFEST, ToolId, validateArchiveSpec } from './manifest';
import { grantsInGrepDump, PROBES, probeCovered, ProbeId } from './probes';

export type HostOs = 'linux' | 'darwin' | 'win32' | 'other';

export interface DependencyContext {
	readonly host: IAgentHost;
	readonly platform: PlatformId | undefined;
	readonly os: HostOs;
	readonly signal?: AbortSignal;
}

/** How a missing dependency can be provided: by the agent in user space, by a root step, or only by the user. */
export type Remedy = 'user-space' | 'system' | 'manual' | 'none';

export interface DependencyStatus {
	readonly id: string;
	readonly label: string;
	readonly ok: boolean;
	/** What was found, or what is missing and why. */
	readonly detail: string;
	/** Program to run (absolute for tool-store installs). */
	readonly command?: string;
	readonly version?: string;
	readonly source?: 'path' | 'tool-store';
	readonly remedy: Remedy;
	/** For `manual`: the exact step for the user. */
	readonly manualStep?: string;
	/** Done, but only effective after something else (e.g. logging in again). */
	readonly pending?: string;
}

export interface InstallOutcome {
	readonly id: string;
	readonly ok: boolean;
	readonly action: 'none' | 'downloaded' | 'system-change' | 'needs-user';
	readonly detail: string;
	/** Exact command for the user when the agent could not do it (no passwordless root). */
	readonly userCommand?: string;
}

export interface SystemInstallOptions {
	/** Allow `pkexec` (the desktop's own password dialog) when `sudo -n` is not possible. */
	readonly allowGraphicalPrompt?: boolean;
}

/** One thing the debug stack needs (Strategy). */
export interface IDependency {
	readonly id: string;
	readonly label: string;
	check(ctx: DependencyContext): Promise<DependencyStatus>;
	/** User-space install (tool store); `undefined` when this dependency has none. */
	installUserSpace?(ctx: DependencyContext): Promise<InstallOutcome>;
	/** Root-level install (system files, groups). */
	installSystem?(ctx: DependencyContext, options: SystemInstallOptions): Promise<InstallOutcome>;
	/** What {@link installSystem} would do, for approval prompts. */
	describeSystemChange?(ctx: DependencyContext): Promise<string | undefined>;
}

/** First output line of a successful run (exit 0); undefined when the program is missing or fails. */
async function firstLine(host: IAgentHost, command: string, args: string[], options: { signal?: AbortSignal; noToolStorePath?: boolean } = {}): Promise<string | undefined> {
	const r = await host.exec(command, args, { timeoutMs: 20_000, maxOutputBytes: 32_768, ...options });
	if (r.spawnError || r.exitCode !== 0) {
		return undefined;
	}
	return (r.stdout || r.stderr).split('\n').map(l => l.trim()).find(l => l) ?? '';
}

/** Absolute path of `command` as PATH resolves it (`which` / `where`), or undefined. */
async function resolveOnPath(ctx: DependencyContext, command: string, systemPathOnly: boolean): Promise<string | undefined> {
	const r = ctx.os === 'win32'
		? await ctx.host.exec('where', [command], { timeoutMs: 10_000, noToolStorePath: systemPathOnly })
		: await ctx.host.exec('/usr/bin/which', [command], { timeoutMs: 10_000, noToolStorePath: systemPathOnly });
	const first = r.exitCode === 0 ? r.stdout.split(/\r?\n/).map(l => l.trim()).find(Boolean) : undefined;
	return first && (first.startsWith('/') || /^[A-Za-z]:\\/.test(first)) ? first : undefined;
}

function joinBin(dir: string, name: string, os: HostOs): string {
	const sep = os === 'win32' ? '\\' : '/';
	return `${dir.replace(/[\\/]+$/, '')}${sep}${name}${os === 'win32' && !name.endsWith('.exe') ? '.exe' : ''}`;
}

/** POSIX shell quoting, for commands shown to the user. */
export function shellQuote(value: string): string {
	return /^[\w@%+=:,./-]+$/.test(value) ? value : `'${value.replace(/'/g, `'\\''`)}'`;
}

export interface ExecutableDependencyOptions {
	readonly id: string;
	readonly label: string;
	/** Executable names, in order of preference (on PATH, or inside the archive's bin folder). */
	readonly commands: readonly string[];
	/** The `--version` output must match (e.g. Espressif's OpenOCD says "esp32"). */
	readonly versionMatch?: RegExp;
	/** Pinned archive that provides it in user space. */
	readonly archive?: ToolId;
	/** Look on the system PATH only (the tool store's own folders could shadow the wanted build). */
	readonly systemPathOnly?: boolean;
	/** Shown when nothing can be installed automatically. */
	readonly manualHint: string;
}

/** A program found on PATH or in the tool store, installable from a pinned archive. */
export class ExecutableDependency implements IDependency {
	readonly id: string;
	readonly label: string;

	constructor(private readonly o: ExecutableDependencyOptions) {
		this.id = o.id;
		this.label = o.label;
	}

	/** The pinned archive that provides this program, if any. */
	get archive(): ToolId | undefined {
		return this.o.archive;
	}

	async check(ctx: DependencyContext): Promise<DependencyStatus> {
		const { host } = ctx;
		// Tool store first: what the agent installed is pinned and known to work.
		if (this.o.archive && host.toolStore) {
			const installed = await host.toolStore.find(this.o.archive);
			const hit = installed && await this.probeIn(ctx, installed);
			if (hit) {
				return hit;
			}
		}
		for (const command of this.o.commands) {
			const version = await firstLine(host, command, ['--version'], { ...ctx.signal ? { signal: ctx.signal } : {}, ...this.o.systemPathOnly ? { noToolStorePath: true } : {} });
			if (version !== undefined && (!this.o.versionMatch || this.o.versionMatch.test(version))) {
				// Report the absolute path: run by bare name later, PATH (which starts with the tool
				// store) could pick a different build than the one checked here.
				const resolved = await resolveOnPath(ctx, command, !!this.o.systemPathOnly);
				return { id: this.id, label: this.label, ok: true, detail: `${resolved ?? command} on PATH`, command: resolved ?? command, version, source: 'path', remedy: 'none' };
			}
		}
		const userSpace = this.o.archive && host.toolStore && archiveFor(this.o.archive, ctx.platform);
		return {
			id: this.id,
			label: this.label,
			ok: false,
			detail: `not found (looked for ${this.o.commands.join(', ')}${this.o.versionMatch ? ` matching ${this.o.versionMatch}` : ''})`,
			remedy: userSpace ? 'user-space' : 'manual',
			...userSpace ? {} : { manualStep: this.o.manualHint },
		};
	}

	async installUserSpace(ctx: DependencyContext): Promise<InstallOutcome> {
		const store = ctx.host.toolStore;
		const spec = this.o.archive && archiveFor(this.o.archive, ctx.platform);
		if (!store || !spec) {
			return { id: this.id, ok: false, action: 'needs-user', detail: `No pinned download for ${ctx.platform ?? 'this platform'}. ${this.o.manualHint}` };
		}
		const invalid = validateArchiveSpec(spec);
		if (invalid) {
			return { id: this.id, ok: false, action: 'needs-user', detail: `Refusing the pinned download: ${invalid}` };
		}
		ctx.host.progress(`Downloading ${TOOL_MANIFEST[this.o.archive!].vendor} ${spec.version} (${Math.round(spec.size / 1e6)} MB) into ${store.location}`);
		const installed = await store.install(spec, ctx.signal ? { signal: ctx.signal } : {});
		const status = await this.probeIn(ctx, installed);
		return status
			? { id: this.id, ok: true, action: 'downloaded', detail: `${status.command} — ${status.version}` }
			: { id: this.id, ok: false, action: 'needs-user', detail: `Installed ${spec.id} ${spec.version}, but none of ${this.o.commands.join(', ')} runs from ${installed.binDir} (missing system libraries?).` };
	}

	private async probeIn(ctx: DependencyContext, installed: InstalledTool): Promise<DependencyStatus | undefined> {
		for (const name of this.o.commands) {
			const command = joinBin(installed.binDir, name, ctx.os);
			const version = await firstLine(ctx.host, command, ['--version'], ctx.signal ? { signal: ctx.signal } : {});
			if (version !== undefined && (!this.o.versionMatch || this.o.versionMatch.test(version))) {
				return { id: this.id, label: this.label, ok: true, detail: `${installed.id} ${installed.version} in the tool store`, command, version, source: 'tool-store', remedy: 'none' };
			}
		}
		return undefined;
	}
}

/**
 * Root steps run fixed programs by absolute path only: never through PATH (which starts with the
 * tool store), and with arguments the agent chose, never the model.
 */
const ROOT_PROGRAMS: Readonly<Record<'sudo' | 'pkexec' | 'tee' | 'chmod' | 'udevadm' | 'usermod', readonly string[]>> = {
	sudo: ['/usr/bin/sudo', '/bin/sudo'],
	pkexec: ['/usr/bin/pkexec', '/bin/pkexec'],
	tee: ['/usr/bin/tee', '/bin/tee'],
	chmod: ['/usr/bin/chmod', '/bin/chmod'],
	udevadm: ['/usr/bin/udevadm', '/bin/udevadm', '/sbin/udevadm', '/usr/sbin/udevadm'],
	usermod: ['/usr/sbin/usermod', '/sbin/usermod', '/usr/bin/usermod'],
};

async function locate(ctx: DependencyContext, program: keyof typeof ROOT_PROGRAMS): Promise<string | undefined> {
	for (const candidate of ROOT_PROGRAMS[program]) {
		const r = await ctx.host.exec(candidate, [program === 'usermod' ? '--help' : '--version'], { timeoutMs: 10_000, noToolStorePath: true });
		if (!r.spawnError) {
			return candidate;
		}
	}
	return undefined;
}

/** Runs one fixed root command: `sudo -n` (passwordless sudo), then `pkexec` if allowed. Never prompts in a terminal. */
async function runAsRoot(ctx: DependencyContext, program: keyof typeof ROOT_PROGRAMS, args: string[], options: SystemInstallOptions & { input?: string }): Promise<{ ok: boolean; how?: 'sudo' | 'pkexec'; error?: string }> {
	const exe = await locate(ctx, program);
	if (!exe) {
		return { ok: false, error: `${program} not found` };
	}
	const run = { timeoutMs: 300_000, noToolStorePath: true, ...options.input !== undefined ? { input: options.input } : {} };
	const sudo = await locate(ctx, 'sudo');
	let error = 'sudo not found';
	if (sudo) {
		const r = await ctx.host.exec(sudo, ['-n', '--', exe, ...args], run);
		if (r.exitCode === 0) {
			return { ok: true, how: 'sudo' };
		}
		error = (r.stderr || r.spawnError || `sudo exit ${r.exitCode}`).trim().slice(0, 300);
	}
	if (options.allowGraphicalPrompt) {
		const pkexec = await locate(ctx, 'pkexec');
		if (pkexec) {
			const r = await ctx.host.exec(pkexec, [exe, ...args], run);
			if (r.exitCode === 0) {
				return { ok: true, how: 'pkexec' };
			}
			error = (r.stderr || r.spawnError || `pkexec exit ${r.exitCode}`).trim().slice(0, 300);
		}
	}
	return { ok: false, error };
}

const RULE_DIRS = ['/etc/udev/rules.d', '/lib/udev/rules.d', '/usr/lib/udev/rules.d'];
/** Our own file name: never overwrites a rules file the user or a package installed. */
export const RULES_TARGET = '/etc/udev/rules.d/60-roboagent-openocd.rules';
/** A trusted udev rules file inside a tool-store install, with its pinned content hash. */
export interface RulesSource {
	readonly tool: string;
	readonly version: string;
	readonly path: string;
	readonly sha256: string;
}

/** xPack's rules first: they grant with `MODE="666"`, which also works over SSH and outside `plugdev`. */
const DEFAULT_RULES_SOURCES: readonly RulesSource[] = (['xpack-openocd', 'openocd-esp32'] as const).flatMap(id => {
	const t = TOOL_MANIFEST[id];
	return t.files?.udevRules ? [{ tool: id, version: t.version, path: t.files.udevRules.path, sha256: t.files.udevRules.sha256 }] : [];
});

/** udev keys that run programs or import data; never acceptable in rules we install as root. */
const DANGEROUS_UDEV_KEY = /(^|[,\s])(RUN|PROGRAM|IMPORT)(\{[^}]*\})?\s*\+?=/m;

/**
 * USB access for debug probes. Linux needs udev rules that grant the user the probe's USB device;
 * macOS needs nothing; Windows needs a WinUSB-compatible driver (vendor driver or Zadig).
 */
export class ProbeAccessDependency implements IDependency {
	readonly id = 'probe-usb-access';
	readonly label: string;

	/** `rulesSources`: where trusted rules come from, in order (default: the pinned OpenOCD rules). */
	constructor(private readonly probes: readonly ProbeId[], private readonly rulesSources: readonly RulesSource[] = DEFAULT_RULES_SOURCES) {
		this.label = `USB access for ${probes.map(p => PROBES[p].label).join(', ')}`;
	}

	private async missingProbes(ctx: DependencyContext): Promise<ProbeId[]> {
		// Every line of every rules file, prefixed with its file name, so continuations join per file.
		const r = await ctx.host.exec('grep', ['-rsH', '--include=*.rules', '', ...RULE_DIRS], { timeoutMs: 20_000, maxOutputBytes: 16 * 1024 * 1024, noToolStorePath: true });
		const grants = grantsInGrepDump(r.stdout);
		return this.probes.filter(p => !probeCovered(PROBES[p], grants));
	}

	async check(ctx: DependencyContext): Promise<DependencyStatus> {
		if (ctx.os === 'darwin') {
			return { id: this.id, label: this.label, ok: true, detail: 'macOS needs no USB rules', remedy: 'none' };
		}
		if (ctx.os === 'win32') {
			return { id: this.id, label: this.label, ok: true, detail: 'Windows: probes need a WinUSB-compatible driver (vendor installer or Zadig); not checked automatically', remedy: 'none' };
		}
		if (ctx.os !== 'linux') {
			return { id: this.id, label: this.label, ok: true, detail: 'not checked on this OS', remedy: 'none' };
		}
		const missing = await this.missingProbes(ctx);
		if (!missing.length) {
			return { id: this.id, label: this.label, ok: true, detail: `udev rules grant access to ${this.probes.join(', ')}`, remedy: 'none' };
		}
		return { id: this.id, label: this.label, ok: false, detail: `no udev rule grants access to ${missing.map(p => PROBES[p].label).join(', ')}`, remedy: 'system' };
	}

	async describeSystemChange(ctx: DependencyContext): Promise<string | undefined> {
		const source = await this.rulesSource(ctx);
		return source
			? `write OpenOCD's udev rules (${source.tool} ${source.version}, after checking their pinned SHA-256) to ${RULES_TARGET} and reload udev`
			: `install udev rules to ${RULES_TARGET} (needs OpenOCD in the tool store first)`;
	}

	async installSystem(ctx: DependencyContext, options: SystemInstallOptions): Promise<InstallOutcome> {
		if (ctx.os !== 'linux') {
			return { id: this.id, ok: true, action: 'none', detail: 'nothing to install on this OS' };
		}
		const source = await this.rulesSource(ctx);
		if (!source) {
			return { id: this.id, ok: false, action: 'needs-user', detail: 'No OpenOCD udev rules file available: run ensure_debug_tools first (it downloads OpenOCD, which ships the rules).' };
		}
		// The content is checked here, in memory, and handed to root over stdin: no file path
		// that something else could swap between the check and the copy.
		let content: string;
		try {
			content = await ctx.host.toolStore!.readFile(source.tool, source.version, source.path, 256 * 1024);
		} catch (err) {
			return { id: this.id, ok: false, action: 'needs-user', detail: `Cannot read the udev rules from the tool store: ${err instanceof Error ? err.message : String(err)}` };
		}
		const actual = createHash('sha256').update(content, 'utf8').digest('hex');
		if (actual !== source.sha256 || DANGEROUS_UDEV_KEY.test(content.replace(/^\s*#.*$/gm, ''))) {
			return { id: this.id, ok: false, action: 'needs-user', detail: `The udev rules in the tool store do not match the pinned file (SHA-256 ${actual}); refusing to install them. Reinstall OpenOCD with ensure_debug_tools.` };
		}
		// The user's own command checks the file's hash again at the moment they run it.
		const userCommand = `echo ${shellQuote(`${source.sha256}  ${source.absolutePath}`)} | sha256sum -c - && sudo install -m 0644 -- ${shellQuote(source.absolutePath)} ${RULES_TARGET} && sudo udevadm control --reload-rules && sudo udevadm trigger`;
		const written = await runAsRoot(ctx, 'tee', [RULES_TARGET], { ...options, input: content });
		if (!written.ok) {
			return { id: this.id, ok: false, action: 'needs-user', detail: `Installing udev rules needs root (${written.error}).`, userCommand };
		}
		// tee creates the file 0644 under root's umask; with passwordless sudo make it explicit, and
		// reload udev (udevd also notices new rule files by itself). With pkexec, avoid more dialogs.
		if (written.how === 'sudo') {
			await runAsRoot(ctx, 'chmod', ['0644', RULES_TARGET], {});
			await runAsRoot(ctx, 'udevadm', ['control', '--reload-rules'], {});
			await runAsRoot(ctx, 'udevadm', ['trigger', '--subsystem-match=usb'], {});
		}
		const after = await this.missingProbes(ctx);
		return after.length
			? { id: this.id, ok: false, action: 'system-change', detail: `Rules written to ${RULES_TARGET}, but still no rule for ${after.join(', ')}.`, userCommand }
			: { id: this.id, ok: true, action: 'system-change', detail: `Installed ${RULES_TARGET} (via ${written.how}). Unplug and re-plug the probe.` };
	}

	/**
	 * The pinned rules file of an OpenOCD in the tool store. xPack's first: it grants with
	 * `MODE="666"`, which also works over SSH and for users outside `plugdev`.
	 */
	private async rulesSource(ctx: DependencyContext): Promise<(RulesSource & { absolutePath: string }) | undefined> {
		const store = ctx.host.toolStore;
		if (!store) {
			return undefined;
		}
		for (const source of this.rulesSources) {
			const installed = await store.find(source.tool, source.version);
			if (installed) {
				return { ...source, absolutePath: `${installed.dir.replace(/[\\/]+$/, '')}/${source.path}` };
			}
		}
		return undefined;
	}
}

/** Serial-port access (ESP32 flashing and logs over UART): membership of `dialout` (Debian/Fedora) or `uucp` (Arch). */
export class SerialAccessDependency implements IDependency {
	readonly id = 'serial-port-access';
	readonly label = 'Serial port access (dialout / uucp group)';

	private async state(ctx: DependencyContext): Promise<{ user?: string; inDatabase: boolean; inSession: boolean; group?: string }> {
		const user = (await firstLine(ctx.host, 'id', ['-un'], { noToolStorePath: true }))?.trim();
		let group: string | undefined;
		for (const g of ['dialout', 'uucp']) {
			if ((await ctx.host.exec('getent', ['group', g], { timeoutMs: 10_000, noToolStorePath: true })).exitCode === 0) {
				group = g;
				break;
			}
		}
		const valid = user && /^[a-z_][a-z0-9_.-]*\$?$/i.test(user);
		// `id -nG <user>` reads the group database (includes a fresh usermod); `id -nG` is this session.
		const database = valid ? (await firstLine(ctx.host, 'id', ['-nG', '--', user], { noToolStorePath: true }))?.split(/\s+/) ?? [] : [];
		const session = (await firstLine(ctx.host, 'id', ['-nG'], { noToolStorePath: true }))?.split(/\s+/) ?? [];
		return { ...valid ? { user } : {}, ...group ? { group } : {}, inDatabase: !!group && database.includes(group), inSession: !!group && session.includes(group) };
	}

	async check(ctx: DependencyContext): Promise<DependencyStatus> {
		if (ctx.os !== 'linux') {
			return { id: this.id, label: this.label, ok: true, detail: 'no group needed on this OS', remedy: 'none' };
		}
		const { group, inDatabase, inSession } = await this.state(ctx);
		if (!group || inSession) {
			return { id: this.id, label: this.label, ok: true, detail: group ? `member of ${group}` : 'no serial group on this system', remedy: 'none' };
		}
		if (inDatabase) {
			return { id: this.id, label: this.label, ok: true, detail: `added to ${group}`, remedy: 'none', pending: 'Log out and back in (or reboot) for the group to take effect.' };
		}
		return { id: this.id, label: this.label, ok: false, detail: `not a member of ${group}`, remedy: 'system' };
	}

	async describeSystemChange(ctx: DependencyContext): Promise<string | undefined> {
		const { user, group } = await this.state(ctx);
		return group && user ? `add ${user} to the ${group} group (usermod -aG)` : undefined;
	}

	async installSystem(ctx: DependencyContext, options: SystemInstallOptions): Promise<InstallOutcome> {
		const { user, group, inDatabase } = await this.state(ctx);
		if (ctx.os !== 'linux' || !group || inDatabase) {
			return { id: this.id, ok: true, action: 'none', detail: 'already has access' };
		}
		if (!user) {
			return { id: this.id, ok: false, action: 'needs-user', detail: 'Could not determine the user name.' };
		}
		const userCommand = `sudo usermod -aG ${group} ${shellQuote(user)}`;
		const r = await runAsRoot(ctx, 'usermod', ['-aG', group, '--', user], options);
		return r.ok
			? { id: this.id, ok: true, action: 'system-change', detail: `Added ${user} to ${group} (via ${r.how}). Log out and back in for it to take effect.` }
			: { id: this.id, ok: false, action: 'needs-user', detail: `Adding the user to ${group} needs root (${r.error}).`, userCommand };
	}
}
