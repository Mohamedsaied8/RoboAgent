/*---------------------------------------------------------------------------------------------
 *  Copyright (c) RoboAgent. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/*---------------------------------------------------------------------------------------------
 *  RoboAgent — C++ IntelliSense (clangd) for colcon workspaces.
 *
 *  colcon builds every package in its own CMake build folder, so each has its own
 *  build/<pkg>/compile_commands.json (RoboAgent's colcon builds pass
 *  -DCMAKE_EXPORT_COMPILE_COMMANDS=ON). clangd looks for compile_commands.json in each parent
 *  folder of a source file and in their build/ subfolder, so after every colcon build the
 *  per-package files are merged into <workspace>/build/compile_commands.json, which clangd finds
 *  for every file under src/.
 *--------------------------------------------------------------------------------------------*/

import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { readText } from './cmakeDiagnostics';

/** One entry of a JSON compilation database. */
export interface CompileCommand {
	readonly directory: string;
	readonly file: string;
	readonly command?: string;
	readonly arguments?: readonly string[];
	readonly output?: string;
}

/** The cmake argument that makes CMake write compile_commands.json. */
export const EXPORT_COMPILE_COMMANDS = '-DCMAKE_EXPORT_COMPILE_COMMANDS=ON';

/** A package's database can be large (one entry per source file), but not this large. */
const MAX_DATABASE_BYTES = 64 * 1024 * 1024;
/** And all of them together: packages past this budget are left out of the merged file. */
const MAX_TOTAL_BYTES = 192 * 1024 * 1024;

function isStringArray(value: unknown): value is string[] {
	return Array.isArray(value) && value.every(item => typeof item === 'string');
}

/** The well-formed entries of a parsed compile_commands.json, with only the standard fields. */
export function compileCommandEntries(database: unknown): CompileCommand[] {
	if (!Array.isArray(database)) {
		return [];
	}
	const entries: CompileCommand[] = [];
	for (const item of database) {
		if (typeof item !== 'object' || item === null) { continue; }
		const { directory, file, command, arguments: args, output } = item as Record<string, unknown>;
		if (typeof directory !== 'string' || typeof file !== 'string') { continue; }
		if (typeof command === 'string') {
			entries.push({ directory, file, command, ...(typeof output === 'string' ? { output } : {}) });
		} else if (isStringArray(args)) {
			entries.push({ directory, file, arguments: args, ...(typeof output === 'string' ? { output } : {}) });
		}
	}
	return entries;
}

/**
 * Merge per-package compile_commands.json files from `<workspaceRoot>/build/*` into
 * `<workspaceRoot>/build/compile_commands.json`. Returns the number of entries written, 0 when the
 * file was already up to date, or undefined when there was nothing to merge or the target is not
 * RoboAgent's to write (build/ or the target is a symlink or not a regular file).
 */
export async function mergeColconCompileCommands(workspaceRoot: string, log: (message: string) => void = () => { }): Promise<number | undefined> {
	const buildDir = path.join(workspaceRoot, 'build');
	let packages: fs.Dirent[];
	try {
		if (!(await fs.promises.lstat(buildDir)).isDirectory()) {
			return undefined;
		}
		packages = await fs.promises.readdir(buildDir, { withFileTypes: true });
	} catch {
		return undefined;
	}
	const entries: CompileCommand[] = [];
	let budget = MAX_TOTAL_BYTES;
	const names = packages.filter(d => d.isDirectory()).map(d => d.name).sort();
	for (const [index, pkg] of names.entries()) {
		const text = await readText(path.join(buildDir, pkg, 'compile_commands.json'), Math.min(MAX_DATABASE_BYTES, budget));
		if (!text) { continue; }
		budget -= Buffer.byteLength(text);
		if (budget <= 0) {
			log(`compile_commands.json: over ${MAX_TOTAL_BYTES / (1024 * 1024)} MB in total; left out ${names.slice(index).join(', ')}`);
			break;
		}
		try {
			entries.push(...compileCommandEntries(JSON.parse(text)));
		} catch {
			// A package whose database is being rewritten or is broken: skip it.
		}
	}
	if (entries.length === 0) {
		return undefined;
	}

	const target = path.join(buildDir, 'compile_commands.json');
	const merged = JSON.stringify(entries, undefined, 1) + '\n';
	try {
		const existing = await fs.promises.lstat(target);
		if (!existing.isFile()) {
			return undefined; // A link or folder the user made: leave it alone.
		}
		if (await readText(target, MAX_TOTAL_BYTES * 2) === merged) {
			return 0;
		}
	} catch {
		// No merged database yet.
	}
	// Write next to the target and rename over it, so clangd never reads a half-written file.
	// 'wx' refuses to follow a link planted at the temporary name.
	const temporary = path.join(buildDir, `.compile_commands.${crypto.randomBytes(6).toString('hex')}.tmp`);
	try {
		await fs.promises.writeFile(temporary, merged, { flag: 'wx', mode: 0o644 });
		await fs.promises.rename(temporary, target);
	} catch (e) {
		await fs.promises.rm(temporary, { force: true });
		throw e;
	}
	return entries.length;
}
