/*---------------------------------------------------------------------------------------------
 *  Copyright (c) RoboAgent. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/*---------------------------------------------------------------------------------------------
 *  RoboAgent — CMake messages → Problems.
 *
 *  A gcc-style problem matcher cannot place CMake errors: CMake prints paths relative to the
 *  project's *source* folder (`CMake Error at CMakeLists.txt:7 (find_package):`), and a colcon
 *  workspace has one source folder per package. colcon keeps each package's stderr and the
 *  cmake command line (which names the source folder) under `log/latest_build/<pkg>/`, so after
 *  a colcon build the messages are read from there and resolved per package.
 *
 *  This module is pure (fs only, no vscode) so it can be unit-tested.
 *--------------------------------------------------------------------------------------------*/

import * as fs from 'fs';
import * as path from 'path';

export interface CMakeProblem {
	/** Absolute path of the file the message points at. */
	readonly file: string;
	/** 1-based line. */
	readonly line: number;
	readonly severity: 'error' | 'warning';
	readonly message: string;
	/** The CMake command that reported it (`find_package`, `message`, …), when printed. */
	readonly command?: string;
}

const MAX_LINE = 2000;
const ANSI = /\x1b\[[0-9;]*[A-Za-z]/g;
// File paths may start with a Windows drive letter (`C:/…`), whose colon is not the separator.
const HEADER = /^CMake (?<kind>Error|Warning|Deprecation Error|Deprecation Warning)(?: \(dev\))?(?: at (?<atFile>(?:[A-Za-z]:)?.+?):(?<atLine>\d+)(?: \((?<command>[\w.-]+)\))?| in (?<inFile>(?:[A-Za-z]:)?[^:]+))?:\s*(?<inline>.*)$/;
const FRAME = /^\s+(?<file>(?:[A-Za-z]:)?.+?):(?<line>\d+)(?: \([\w.-]+\))?\s*$/;

/** Join the indented message body into paragraphs: lines within a paragraph by spaces. */
function joinBody(lines: readonly string[]): string {
	const paragraphs: string[] = [];
	let current: string[] = [];
	for (const raw of lines) {
		const t = raw.trim();
		if (t) {
			current.push(t);
		} else if (current.length) {
			paragraphs.push(current.join(' '));
			current = [];
		}
	}
	if (current.length) { paragraphs.push(current.join(' ')); }
	return paragraphs.join('\n');
}

function isInside(file: string, dir: string): boolean {
	const rel = path.relative(dir, file);
	return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel);
}

/**
 * Parse CMake's error and warning blocks out of `text` (configure / generate output).
 * Relative paths are resolved against `sourceDir`. When the message comes from a file outside
 * `sourceDir` (an ament or ESP-IDF .cmake module) and the call stack passes through the project,
 * the problem is placed at that project frame, where the user can act on it.
 */
export function parseCMakeOutput(text: string, sourceDir: string): CMakeProblem[] {
	// Lines are capped before matching so crafted output cannot make the regexes slow.
	const lines = text.replace(ANSI, '').split(/\r?\n/).map(line => line.length > MAX_LINE ? line.slice(0, MAX_LINE) : line);
	const problems: CMakeProblem[] = [];
	const resolve = (f: string) => path.isAbsolute(f) ? path.normalize(f) : path.win32.isAbsolute(f) ? f : path.join(sourceDir, f);

	for (let i = 0; i < lines.length; i++) {
		const m = HEADER.exec(lines[i])?.groups;
		if (!m) { continue; }
		const { kind, atFile, atLine, command, inFile, inline } = m;
		const body: string[] = inline ? [inline] : [];
		let j = i + 1;
		for (; j < lines.length && (lines[j].trim() === '' || /^\s/.test(lines[j])); j++) {
			body.push(lines[j]);
		}
		// Optional call stack: "Call Stack (most recent call first):" then indented frames.
		const frames: { file: string; line: number }[] = [];
		if (j < lines.length && lines[j].startsWith('Call Stack')) {
			for (j++; j < lines.length; j++) {
				const f = FRAME.exec(lines[j])?.groups;
				if (!f) { break; }
				frames.push({ file: resolve(f.file), line: Number(f.line) });
			}
		}
		i = j - 1;

		if (!atFile && !inFile && !kind.endsWith('Error')) {
			// Location-less warnings ("Manually-specified variables were not used by the project",
			// raised by colcon's own -D flags on every build) are noise, not something to fix here.
			continue;
		}
		let file = resolve(atFile ?? inFile ?? 'CMakeLists.txt');
		let line = atLine ? Number(atLine) : 1;
		let message = joinBody(body) || `CMake ${kind.toLowerCase()}`;
		if (!isInside(file, sourceDir)) {
			const own = frames.find(f => isInside(f.file, sourceDir));
			if (own) {
				message += `\n(reported in ${file}:${line})`;
				file = own.file;
				line = own.line;
			}
		}
		problems.push({ file, line: Math.max(1, line), severity: kind.endsWith('Error') ? 'error' : 'warning', message, command: command || undefined });
	}
	return problems;
}

/** The build folder from a colcon `command.log` (`Invoking command in '<build>': …`). */
export function colconBuildDir(commandLog: string): string | undefined {
	return /^Invoking command in '(?<dir>[^']+)'/m.exec(commandLog)?.groups?.dir;
}

/** `CMAKE_HOME_DIRECTORY` (the source folder) from a build folder's CMakeCache.txt. */
export function cmakeCacheSourceDir(cache: string): string | undefined {
	return /^CMAKE_HOME_DIRECTORY:INTERNAL=(?<dir>.+)$/m.exec(cache)?.groups?.dir.trim() || undefined;
}

/** The source folder from a colcon `command.log` (`… /usr/bin/cmake <source> -D…`); configure runs only. */
export function colconSourceDir(commandLog: string): string | undefined {
	for (const line of commandLog.split(/\r?\n/)) {
		if (!line.startsWith('Invoking command')) { continue; }
		const source = /(?:^|[\s/])cmake\s+(?<source>\/\S+)/.exec(line)?.groups?.source;
		if (source) { return source; }
	}
	return undefined;
}

/** colcon logs are workspace files: read only regular files (no FIFOs, devices or symlinks), capped. */
const MAX_LOG_BYTES = 4 * 1024 * 1024;

async function readText(file: string): Promise<string | undefined> {
	try {
		const stat = await fs.promises.lstat(file);
		if (!stat.isFile()) {
			return undefined;
		}
		// O_NONBLOCK: a file swapped for a FIFO between lstat and open must not block the open;
		// the handle is checked again before reading.
		const handle = await fs.promises.open(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0) | (fs.constants.O_NONBLOCK ?? 0));
		try {
			if (!(await handle.stat()).isFile()) {
				return undefined;
			}
			const buffer = Buffer.alloc(Math.min(stat.size, MAX_LOG_BYTES));
			const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
			return buffer.subarray(0, bytesRead).toString('utf8');
		} finally {
			await handle.close();
		}
	} catch {
		return undefined;
	}
}

/**
 * CMake problems of the last colcon build in `workspaceRoot`, from
 * `log/latest_build/<pkg>/{command,stderr}.log`. Packages that did not run CMake (ament_python)
 * or whose source folder cannot be told are skipped.
 */
export async function readColconCMakeProblems(workspaceRoot: string): Promise<CMakeProblem[]> {
	const logDir = path.join(workspaceRoot, 'log', 'latest_build');
	let packages: string[];
	try {
		packages = (await fs.promises.readdir(logDir, { withFileTypes: true })).filter(d => d.isDirectory()).map(d => d.name);
	} catch {
		return [];
	}
	const problems: CMakeProblem[] = [];
	for (const pkg of packages.sort()) {
		const stderr = await readText(path.join(logDir, pkg, 'stderr.log'));
		if (!stderr || !stderr.includes('CMake ')) { continue; }
		// The build folder's CMakeCache.txt names the source folder on every build (also when colcon
		// skips the configure step and CMake re-runs inside `cmake --build`); the configure command
		// line is the fallback.
		const commandLog = (await readText(path.join(logDir, pkg, 'command.log'))) ?? '';
		const buildDir = colconBuildDir(commandLog) ?? path.join(workspaceRoot, 'build', pkg);
		let sourceDir = cmakeCacheSourceDir((await readText(path.join(buildDir, 'CMakeCache.txt'))) ?? '') ?? colconSourceDir(commandLog);
		if (!sourceDir) {
			const guess = path.join(workspaceRoot, 'src', pkg);
			if (await readText(path.join(guess, 'CMakeLists.txt')) === undefined) { continue; }
			sourceDir = guess;
		}
		problems.push(...parseCMakeOutput(stderr, sourceDir));
	}
	return problems;
}
