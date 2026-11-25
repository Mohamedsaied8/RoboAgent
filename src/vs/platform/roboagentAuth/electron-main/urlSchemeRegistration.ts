/*---------------------------------------------------------------------------------------------
 *  Copyright (c) RoboAgent. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { execFile } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from '../../../base/common/path.js';

/**
 * The browser sign-in returns through `<urlProtocol>://auth/callback`, which only works when the
 * desktop knows which program opens that scheme. The .deb/.rpm/snap packages install a URL-handler
 * .desktop entry; the tarball and dev builds do not. On Linux, at startup:
 *  - a package's entry (`<app>-url-handler.desktop`) is installed: it is the handler. If RoboAgent
 *    had registered its own user-level entry before, the default goes back to the package's and
 *    the user entry is deleted (a user-level default outranks a package's);
 *  - another program's handler is registered: it is kept;
 *  - otherwise (no handler, or a dangling one) this RoboAgent registers — or refreshes — its own
 *    user-level entry, unless it is a throw-away instance (a dev build with its own user-data-dir,
 *    or an extension test run), which would leave the scheme pointing at a temporary profile.
 */

/** What the registration needs from the system; injected so it can be tested. */
export interface IUrlSchemeHost {
	readonly env: NodeJS.ProcessEnv;
	readonly homeDir: string;
	/** Run a program (no shell); resolves to stdout, rejects when it cannot run or fails. */
	execFile(program: string, args: readonly string[]): Promise<string>;
	readFile(file: string): Promise<string | undefined>;
	writeFile(file: string, content: string): Promise<void>;
	deleteFile(file: string): Promise<void>;
}

export interface IUrlSchemeTarget {
	readonly urlProtocol: string;
	readonly applicationName: string;
	readonly nameLong: string;
	/** The command line that starts this RoboAgent (program first); `--open-url %U` is appended. */
	readonly command: readonly string[];
	/** Environment the command needs (dev builds: VSCODE_DEV=1). */
	readonly env?: Readonly<Record<string, string>>;
	/** A throw-away instance (temporary profile, test run): never becomes the handler. */
	readonly ephemeral?: boolean;
}

export type UrlSchemeRegistrationResult = 'registered' | 'refreshed' | 'returned-to-package' | 'kept-other-handler' | 'skipped' | 'unavailable';

/**
 * One `Exec` argument per the Desktop Entry spec: `%` doubled (field codes), the argument in double
 * quotes with `"`, `` ` ``, `$`, `\` backslash-escaped — and, because the value is also a string
 * value, every backslash then doubled. Control characters cannot be represented: rejected.
 */
export function quoteExecArgument(arg: string): string {
	if (/[\x00-\x1f\x7f]/.test(arg)) {
		throw new Error('A command-line argument contains a control character; not writing a .desktop entry.');
	}
	const quoted = `"${arg.replace(/%/g, '%%').replace(/(["`$\\])/g, '\\$1')}"`;
	return quoted.replace(/\\/g, '\\\\');
}

/** The user-level .desktop file RoboAgent writes (distinct from the packages' `<app>-url-handler.desktop`). */
export function userHandlerFileName(applicationName: string): string {
	return `${applicationName}-url-handler-user.desktop`;
}

export function userHandlerDesktopEntry(target: IUrlSchemeTarget): string {
	const envPrefix = Object.entries(target.env ?? {}).map(([k, v]) => `${k}=${v}`);
	const exec = [...(envPrefix.length ? ['env', ...envPrefix] : []), ...target.command].map(quoteExecArgument).join(' ');
	return [
		'[Desktop Entry]',
		`Name=${target.nameLong} - URL Handler`,
		'Type=Application',
		'NoDisplay=true',
		`Exec=${exec} --open-url %U`,
		`MimeType=x-scheme-handler/${target.urlProtocol};`,
		'X-RoboAgent-Generated=true',
		'',
	].join('\n');
}

/** XDG application folders; relative XDG paths are ignored, as the spec requires. */
function applicationDirs(host: IUrlSchemeHost): string[] {
	const configuredHome = host.env['XDG_DATA_HOME'];
	const dataHome = configuredHome && path.isAbsolute(configuredHome) ? configuredHome : path.join(host.homeDir, '.local', 'share');
	const dataDirs = (host.env['XDG_DATA_DIRS'] || '/usr/local/share:/usr/share').split(':').filter(d => d && path.isAbsolute(d));
	return [dataHome, ...dataDirs].map(d => path.join(d, 'applications'));
}

async function findDesktopFile(host: IUrlSchemeHost, name: string): Promise<{ file: string; content: string } | undefined> {
	for (const dir of applicationDirs(host)) {
		const file = path.join(dir, name);
		const content = await host.readFile(file);
		if (content !== undefined) {
			return { file, content };
		}
	}
	return undefined;
}

export async function ensureLinuxUrlSchemeHandler(host: IUrlSchemeHost, target: IUrlSchemeTarget): Promise<UrlSchemeRegistrationResult> {
	const mime = `x-scheme-handler/${target.urlProtocol}`;
	let current: string;
	try {
		current = (await host.execFile('xdg-mime', ['query', 'default', mime])).trim();
	} catch {
		return 'unavailable';
	}
	const ownName = userHandlerFileName(target.applicationName);
	const ownFile = path.join(applicationDirs(host)[0], ownName);
	const packageName = `${target.applicationName}-url-handler.desktop`;

	if (await findDesktopFile(host, packageName)) {
		if (current !== ownName) {
			return 'kept-other-handler';
		}
		await host.execFile('xdg-mime', ['default', packageName, mime]);
		await host.deleteFile(ownFile);
		return 'returned-to-package';
	}
	if (current && current !== ownName && await findDesktopFile(host, current)) {
		return 'kept-other-handler';
	}
	if (target.ephemeral) {
		return 'skipped';
	}
	const entry = userHandlerDesktopEntry(target);
	if (await host.readFile(ownFile) !== entry) {
		await host.writeFile(ownFile, entry);
	}
	if (current !== ownName) {
		await host.execFile('xdg-mime', ['default', ownName, mime]);
		return 'registered';
	}
	return 'refreshed';
}

/** The real {@link IUrlSchemeHost}: Node's fs and child_process, no shell. */
export function nodeUrlSchemeHost(): IUrlSchemeHost {
	return {
		env: process.env,
		homeDir: os.homedir(),
		execFile: (program, args) => new Promise((resolve, reject) => {
			execFile(program, [...args], { timeout: 10_000 }, (error, stdout) => error ? reject(error) : resolve(stdout));
		}),
		readFile: async file => {
			try {
				return await fs.promises.readFile(file, 'utf8');
			} catch {
				return undefined;
			}
		},
		writeFile: async (file, content) => {
			await fs.promises.mkdir(path.dirname(file), { recursive: true });
			await fs.promises.writeFile(file, content, { mode: 0o644 });
		},
		deleteFile: file => fs.promises.rm(file, { force: true }),
	};
}

/**
 * The command line that starts this RoboAgent: the product binary for a built app; for a dev
 * build, Electron with the source root and VSCODE_DEV=1. A non-default user-data-dir is passed
 * along so the link reaches this instance.
 */
export function urlSchemeTarget(product: { urlProtocol: string; applicationName: string; nameLong: string }, environment: { isBuilt: boolean; appRoot: string; userDataDir?: string; testRun?: boolean }, execPath: string): IUrlSchemeTarget {
	const command = environment.isBuilt ? [execPath] : [execPath, environment.appRoot];
	if (environment.userDataDir) {
		command.push('--user-data-dir', environment.userDataDir);
	}
	return {
		...product,
		command,
		env: environment.isBuilt ? undefined : { VSCODE_DEV: '1' },
		ephemeral: environment.testRun || (!environment.isBuilt && !!environment.userDataDir),
	};
}
