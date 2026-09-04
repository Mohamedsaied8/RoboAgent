/*---------------------------------------------------------------------------------------------
 *  Copyright (c) RoboAgent. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/*---------------------------------------------------------------------------------------------
 *  RoboAgent — atomic project scaffolding (pure Node, no vscode).
 *
 *  A generator produces a {@link FileSet} (relative path → text). `materialize` writes the set
 *  into a temp directory next to the destination and only then renames it into place, so a
 *  cancelled or failed wizard never leaves a half-written project behind.
 *--------------------------------------------------------------------------------------------*/

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

/** Relative POSIX path → file contents. */
export type FileSet = ReadonlyMap<string, string>;

export interface MaterializeOptions {
	/** Executable bit for these relative paths (scripts). */
	readonly executable?: readonly string[];
	/** Called between writing to the staging dir and the final move (e.g. to run a generator CLI). */
	readonly beforeCommit?: (stagingDir: string) => Promise<void>;
	/** Cooperative cancellation: checked before the final move. */
	readonly isCancelled?: () => boolean;
}

export class ScaffoldError extends Error {
	constructor(message: string, readonly code: 'exists' | 'cancelled' | 'io') {
		super(message);
		this.name = 'ScaffoldError';
	}
}

async function pathExists(p: string): Promise<boolean> {
	try {
		await fs.promises.access(p);
		return true;
	} catch {
		return false;
	}
}

async function isEmptyDir(p: string): Promise<boolean> {
	try {
		return (await fs.promises.readdir(p)).length === 0;
	} catch {
		return false;
	}
}

/** Write every file of `files` under `root` (creating directories). */
export async function writeFileSet(root: string, files: FileSet, executable: readonly string[] = []): Promise<void> {
	for (const [rel, content] of files) {
		const target = path.join(root, ...rel.split('/'));
		await fs.promises.mkdir(path.dirname(target), { recursive: true });
		await fs.promises.writeFile(target, content, 'utf8');
		if (executable.includes(rel)) {
			await fs.promises.chmod(target, 0o755);
		}
	}
}

/**
 * Create `destination` with `files`, atomically. The destination must not exist (an empty
 * directory is acceptable). Everything is staged in a sibling temp directory first.
 */
export async function materialize(destination: string, files: FileSet, options: MaterializeOptions = {}): Promise<void> {
	const dest = path.resolve(destination);
	if (await pathExists(dest) && !(await isEmptyDir(dest))) {
		throw new ScaffoldError(`"${dest}" already exists and is not empty.`, 'exists');
	}
	const parent = path.dirname(dest);
	await fs.promises.mkdir(parent, { recursive: true });

	// Stage next to the destination so the final rename is a same-filesystem move.
	let staging: string;
	try {
		staging = await fs.promises.mkdtemp(path.join(parent, `.${path.basename(dest)}.roboagent-`));
	} catch {
		staging = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'roboagent-scaffold-'));
	}

	try {
		await writeFileSet(staging, files, options.executable);
		if (options.beforeCommit) {
			await options.beforeCommit(staging);
		}
		if (options.isCancelled?.()) {
			throw new ScaffoldError('Cancelled.', 'cancelled');
		}
		if (await pathExists(dest)) {
			await fs.promises.rmdir(dest);   // the empty directory case
		}
		try {
			await fs.promises.rename(staging, dest);
		} catch {
			// Cross-device (staging fell back to os.tmpdir): copy then remove.
			await fs.promises.cp(staging, dest, { recursive: true });
			await fs.promises.rm(staging, { recursive: true, force: true });
		}
	} catch (e) {
		await fs.promises.rm(staging, { recursive: true, force: true });
		if (e instanceof ScaffoldError) {
			throw e;
		}
		throw new ScaffoldError(e instanceof Error ? e.message : String(e), 'io');
	}
}

/** Small helpers shared by the generators. */
export function jsonFile(value: unknown): string {
	return JSON.stringify(value, null, '\t') + '\n';
}

/** `my-project` → `my_project`; keeps identifiers C/CMake/ROS-safe. */
export function toIdentifier(name: string): string {
	const s = name.toLowerCase().replace(/[^a-z0-9_]+/g, '_').replace(/^_+|_+$/g, '');
	return /^[a-z]/.test(s) ? s : `p_${s}`;
}
