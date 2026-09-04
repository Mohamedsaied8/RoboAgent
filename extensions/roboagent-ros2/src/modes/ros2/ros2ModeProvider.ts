/*---------------------------------------------------------------------------------------------
 *  Copyright (c) RoboAgent. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/*---------------------------------------------------------------------------------------------
 *  RoboAgent — ROS2 mode: Create (workspace + `ros2 pkg create` wizard, offline generator when
 *  ROS 2 is absent, then re-index), Build (the toolkit's colcon build, package-scoped when a
 *  package is focused, honouring roboagent.ros2.distro), Debug (pick a built node → the
 *  existing roboagent.debugNode path: debugpy for Python, lldb-dap/gdb for C++).
 *--------------------------------------------------------------------------------------------*/

import * as cp from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { colconCommandLine } from '../../colconTasks';
import { findColconRoot, isSafeRos2Name, ros2SourcePrefix } from '../../util';
import { detectRos2 } from '../detect';
import { ModeHost } from '../modeHost';
import { ModeProvider } from '../modeProvider';
import { materialize, ScaffoldError } from '../scaffold';
import { discoverRos2Distro } from '../toolchains';
import { BACK, inputStep, multiPickStep, pickFolder, pickStep, StepResult } from '../wizardSteps';
import { COMMON_ROS2_DEPENDENCIES, generateRos2Package, isValidRos2PackageName, ROS2_BUILD_TYPES, Ros2BuildType, ros2Extras, Ros2PackageSpec, ros2PkgCreateArgs } from './generator';

interface Ros2WizardResult {
	/** colcon workspace root (contains `src/`). */
	readonly workspaceRoot: string;
	readonly createWorkspace: boolean;
	readonly spec: Ros2PackageSpec;
}

const TOTAL_STEPS = 4;

export class Ros2ModeProvider implements ModeProvider {

	readonly mode = 'ros2' as const;

	constructor(private readonly host: ModeHost) { }

	detect(folderFsPath: string): Promise<boolean> {
		return detectRos2(folderFsPath);
	}

	private distro(): Promise<string | undefined> {
		return discoverRos2Distro(this.host.getSetting<string>('roboagent.ros2.distro'));
	}

	// --- Create ---------------------------------------------------------------

	async create(): Promise<void> {
		const result = await this.runWizard();
		if (!result) {
			return;
		}
		const pkgDir = path.join(result.workspaceRoot, 'src', result.spec.name);
		const distro = await this.distro();
		const ros2Cli = await this.host.toolOnPath('ros2') || !!distro;

		try {
			await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: vscode.l10n.t('Creating ROS 2 package "{0}"…', result.spec.name) }, async () => {
				if (result.createWorkspace) {
					await fs.promises.mkdir(path.join(result.workspaceRoot, 'src'), { recursive: true });
				}
				if (ros2Cli) {
					// `ros2 pkg create` runs in a scratch dir; its output is merged into the staging dir
					// with RoboAgent's extras, and only then moved into src/ (atomic, cancel-safe).
					await materialize(pkgDir, ros2Extras(result.spec), {
						beforeCommit: staging => this.runRos2PkgCreate(result.spec, staging, distro),
					});
				} else {
					this.host.log('ROS2: no ros2 CLI / distro found; using the bundled offline package generator');
					await materialize(pkgDir, generateRos2Package(result.spec));
				}
			});
		} catch (e) {
			if (e instanceof ScaffoldError && e.code === 'cancelled') { return; }
			await this.host.showError(vscode.l10n.t('Could not create the ROS 2 package: {0}', e instanceof Error ? e.message : String(e)));
			return;
		}
		this.host.log(`ROS2: created ${pkgDir} (${result.spec.buildType}; deps: ${result.spec.dependencies.join(', ') || 'none'})`);
		if (!ros2Cli) {
			await this.host.showWarning(vscode.l10n.t('No ROS 2 installation was found (ros2 not on PATH, nothing under /opt/ros). The package was generated offline; install ROS 2 to build it.'));
		}

		const openFolder = vscode.workspace.workspaceFolders?.find(f => f.uri.scheme === 'file' && isInside(result.workspaceRoot, f.uri.fsPath));
		if (openFolder) {
			// Same workspace: refresh the Package Explorer / knowledge graph right away.
			await this.host.executeCommand('roboagent.indexRos2Workspace');
			const doc = await this.entryFile(pkgDir, result.spec);
			if (doc) {
				await vscode.window.showTextDocument(vscode.Uri.file(doc), { preview: false });
			}
		} else {
			await vscode.commands.executeCommand('vscode.openFolder', vscode.Uri.file(result.workspaceRoot), { forceNewWindow: false });
		}
	}

	private async entryFile(pkgDir: string, spec: Ros2PackageSpec): Promise<string | undefined> {
		const node = spec.nodeName ?? `${spec.name}_node`;
		const candidates = spec.buildType === 'ament_python'
			? [path.join(pkgDir, spec.name, `${node}.py`)]
			: spec.buildType === 'ament_cmake'
				? [path.join(pkgDir, 'src', `${node}.cpp`)]
				: [path.join(pkgDir, 'CMakeLists.txt')];
		for (const c of candidates) {
			if (await this.host.fileExists(c)) { return c; }
		}
		return undefined;
	}

	/** Run `ros2 pkg create` in a scratch dir and merge the result into `staging`. */
	private async runRos2PkgCreate(spec: Ros2PackageSpec, staging: string, distro: string | undefined): Promise<void> {
		const scratch = await fs.promises.mkdtemp(path.join(path.dirname(staging), '.ros2pkg-'));
		try {
			const args = ros2PkgCreateArgs(spec).map(shellQuote).join(' ');
			const env = distro ? { ...process.env, ROS_DISTRO: distro } : process.env;
			const command = `${ros2SourcePrefix()}ros2 ${args}`;
			this.host.log(`ROS2: ${command}`);
			await new Promise<void>((resolve, reject) => {
				cp.exec(command, { cwd: scratch, env, shell: '/bin/bash', timeout: 120_000 }, (error, stdout, stderr) => {
					if (stdout) { this.host.log(stdout.trim()); }
					if (stderr) { this.host.log(stderr.trim()); }
					error ? reject(new Error(`ros2 pkg create failed: ${stderr.trim() || error.message}`)) : resolve();
				});
			});
			const created = path.join(scratch, spec.name);
			await fs.promises.cp(created, staging, { recursive: true, force: false, errorOnExist: false });
			await this.installLaunchDir(staging, spec);
		} finally {
			await fs.promises.rm(scratch, { recursive: true, force: true });
		}
	}

	/** Teach the generated build files about the launch/ directory RoboAgent adds. */
	private async installLaunchDir(pkgDir: string, spec: Ros2PackageSpec): Promise<void> {
		if (spec.buildType === 'ament_cmake') {
			const cmakePath = path.join(pkgDir, 'CMakeLists.txt');
			let text = await fs.promises.readFile(cmakePath, 'utf8');
			if (!text.includes('DIRECTORY launch')) {
				text = text.replace(/\nament_package\(\)/, '\ninstall(DIRECTORY launch DESTINATION share/${PROJECT_NAME})\n\nament_package()');
				await fs.promises.writeFile(cmakePath, text, 'utf8');
			}
		} else if (spec.buildType === 'ament_python') {
			const setupPath = path.join(pkgDir, 'setup.py');
			let text = await fs.promises.readFile(setupPath, 'utf8');
			if (!text.includes('/launch')) {
				text = text.replace(/\(\s*'share\/' \+ package_name,\s*\['package\.xml'\]\s*\),/, m => `${m}\n        ('share/' + package_name + '/launch', ['launch/${spec.name}.launch.py']),`);
				await fs.promises.writeFile(setupPath, text, 'utf8');
			}
		}
	}

	private async runWizard(): Promise<Ros2WizardResult | undefined> {
		type Step = 'workspace' | 'name' | 'buildType' | 'deps';
		let step: Step = 'workspace';
		let workspaceRoot: string | undefined;
		let createWorkspace = false;
		let name = '';
		let buildType: Ros2BuildType = 'ament_cmake';
		let deps: string[] = [];
		const currentRoot = (await findColconRoot())?.fsPath;

		while (true) {
			switch (step) {
				case 'workspace': {
					const items: { label: string; description: string; value: 'current' | 'new' | 'existing' }[] = [];
					if (currentRoot) {
						items.push({ label: `$(folder-active) ${vscode.l10n.t('Current workspace')}`, description: currentRoot, value: 'current' });
					}
					items.push({ label: `$(new-folder) ${vscode.l10n.t('New colcon workspace')}`, description: vscode.l10n.t('Create <name>/src and put the package inside'), value: 'new' });
					items.push({ label: `$(folder-opened) ${vscode.l10n.t('Existing workspace folder…')}`, description: vscode.l10n.t('Pick a folder that has (or will get) a src/ directory'), value: 'existing' });
					const r = await pickStep({ title: vscode.l10n.t('New ROS 2 Package — Workspace'), step: 1, totalSteps: TOTAL_STEPS }, items);
					if (r === undefined || r === BACK) { return undefined; }
					if (r === 'current') {
						workspaceRoot = currentRoot; createWorkspace = false; step = 'name'; break;
					}
					if (r === 'new') {
						const wsName = await inputStep({ title: vscode.l10n.t('New colcon workspace — Name'), prompt: vscode.l10n.t('Workspace folder name (e.g. robot_ws)'), value: 'robot_ws', canGoBack: true, validate: v => /^[A-Za-z][\w-]*$/.test(v.trim()) ? undefined : vscode.l10n.t('Use a letter followed by letters, digits, _ or -') });
						if (wsName === undefined) { return undefined; }
						if (wsName === BACK) { break; }
						const parent = await pickFolder(vscode.l10n.t('New colcon workspace — Location (parent folder)'), vscode.l10n.t('Create here'));
						if (!parent) { break; }
						workspaceRoot = path.join(parent, wsName.trim()); createWorkspace = true; step = 'name'; break;
					}
					const picked = await pickFolder(vscode.l10n.t('Existing colcon workspace'), vscode.l10n.t('Use this workspace'));
					if (!picked) { break; }
					workspaceRoot = picked; createWorkspace = !(await this.host.fileExists(path.join(picked, 'src'))); step = 'name';
					break;
				}
				case 'name': {
					const r = await inputStep({ title: vscode.l10n.t('New ROS 2 Package — Name'), step: 2, totalSteps: TOTAL_STEPS, prompt: vscode.l10n.t('Package name (lowercase, underscores)'), value: name, canGoBack: true, validate: v => isValidRos2PackageName(v.trim()) ? undefined : vscode.l10n.t('ROS 2 package names are lowercase letters, digits and single underscores, starting with a letter') });
					if (r === undefined) { return undefined; }
					if (r === BACK) { step = 'workspace'; break; }
					name = r.trim();
					if (workspaceRoot && await this.host.fileExists(path.join(workspaceRoot, 'src', name))) {
						await this.host.showWarning(vscode.l10n.t('src/{0} already exists in {1}.', name, workspaceRoot));
						break;
					}
					step = 'buildType';
					break;
				}
				case 'buildType': {
					const r: StepResult<Ros2BuildType> = await pickStep<Ros2BuildType>({ title: vscode.l10n.t('New ROS 2 Package — Build Type'), step: 3, totalSteps: TOTAL_STEPS, canGoBack: true },
						ROS2_BUILD_TYPES.map(b => ({ label: `$(${b.icon}) ${b.label}`, description: b.description, value: b.id })), buildType);
					if (r === undefined) { return undefined; }
					if (r === BACK) { step = 'name'; break; }
					buildType = r;
					step = 'deps';
					break;
				}
				case 'deps': {
					const preset = buildType === 'ament_python' ? ['rclpy'] : buildType === 'interface' ? ['std_msgs'] : ['rclcpp'];
					const r: StepResult<string[]> = await multiPickStep<string>({ title: vscode.l10n.t('New ROS 2 Package — Dependencies'), step: 4, totalSteps: TOTAL_STEPS, placeholder: vscode.l10n.t('Select dependencies (Space to toggle, Enter to confirm)'), canGoBack: true },
						COMMON_ROS2_DEPENDENCIES.map(d => ({ label: d.id, description: d.description, value: d.id })), deps.length ? deps : preset);
					if (r === undefined) { return undefined; }
					if (r === BACK) { step = 'buildType'; break; }
					deps = r;
					return { workspaceRoot: workspaceRoot!, createWorkspace, spec: { name, buildType, dependencies: deps } };
				}
			}
		}
	}

	// --- Build ----------------------------------------------------------------

	/**
	 * The colcon workspace root for Build/Debug: resolved from the workspace folder (not the
	 * active file, whose nearest `package.xml` would make the package itself the root).
	 */
	private async workspaceRoot(): Promise<string | undefined> {
		const active = vscode.window.activeTextEditor?.document.uri;
		const folder = (active && vscode.workspace.getWorkspaceFolder(active)) ?? vscode.workspace.workspaceFolders?.[0];
		if (!folder || folder.uri.scheme !== 'file') {
			return undefined;
		}
		return (await findColconRoot(folder.uri))?.fsPath;
	}

	/** The package that contains the active editor's file, when it lives under `src/`. */
	private async focusedPackage(root: string): Promise<string | undefined> {
		const active = vscode.window.activeTextEditor?.document.uri;
		if (!active || active.scheme !== 'file' || !isInside(path.join(root, 'src'), active.fsPath)) {
			return undefined;
		}
		let dir = path.dirname(active.fsPath);
		while (isInside(path.join(root, 'src'), dir) && dir !== path.join(root, 'src')) {
			if (await this.host.fileExists(path.join(dir, 'package.xml'))) {
				const name = path.basename(dir);
				return isSafeRos2Name(name) ? name : undefined;
			}
			dir = path.dirname(dir);
		}
		return undefined;
	}

	async build(): Promise<number | undefined> {
		const root = await this.workspaceRoot();
		if (!root) {
			await this.host.showWarning(vscode.l10n.t('No colcon workspace detected (no folder with src/ or a package.xml). Use Create to start one.'));
			return undefined;
		}
		if (!(await this.host.toolOnPath('colcon')) && !(await this.distro())) {
			await this.host.showError(vscode.l10n.t('colcon was not found. Install ROS 2 + colcon (e.g. `apt install python3-colcon-common-extensions`).'));
			return undefined;
		}
		const pkg = await this.focusedPackage(root);
		const distro = await this.distro();
		const result = await this.host.runShellTask({
			name: pkg ? `RoboAgent: colcon build ${pkg}` : 'RoboAgent: colcon build',
			command: colconCommandLine('build', pkg ? [pkg] : undefined),
			cwd: root,
			problemMatchers: ['$colcon'],
			group: 'build',
			env: distro ? { ROS_DISTRO: distro } : undefined,
		});
		return result.exitCode;
	}

	// --- Debug ----------------------------------------------------------------

	async debug(): Promise<void> {
		const root = await this.workspaceRoot();
		if (!root) {
			await this.host.showWarning(vscode.l10n.t('No colcon workspace detected.'));
			return;
		}
		const nodes = await this.builtNodes(root);
		if (nodes.length === 0) {
			let chosen = false;
			await this.host.showWarning(vscode.l10n.t('No built nodes found under install/. Build the workspace first?'), { title: vscode.l10n.t('Build now'), run: () => { chosen = true; } });
			if (chosen) {
				await this.build();
			}
			return;
		}
		const focused = await this.focusedPackage(root);
		const items = nodes.map(n => ({ label: `$(${n.language === 'python' ? 'symbol-namespace' : 'symbol-method'}) ${n.node}`, description: n.package, detail: n.language === 'python' ? 'Python (debugpy)' : 'C++ (lldb-dap / gdb)', node: n }));
		const pick = await vscode.window.showQuickPick(items.sort((a, b) => (a.node.package === focused ? -1 : 0) - (b.node.package === focused ? -1 : 0)), { title: vscode.l10n.t('Debug ROS 2 node'), placeHolder: vscode.l10n.t('Select a built node') });
		if (!pick) { return; }
		await this.host.executeCommand('roboagent.debugNode', pick.node);
	}

	private async builtNodes(root: string): Promise<{ package: string; node: string; language: 'python' | 'cpp' }[]> {
		const result: { package: string; node: string; language: 'python' | 'cpp' }[] = [];
		const install = path.join(root, 'install');
		let packages: string[];
		try {
			packages = (await fs.promises.readdir(install, { withFileTypes: true })).filter(e => e.isDirectory()).map(e => e.name);
		} catch {
			return result;
		}
		for (const pkg of packages) {
			const libDir = path.join(install, pkg, 'lib', pkg);
			let entries: fs.Dirent[];
			try {
				entries = await fs.promises.readdir(libDir, { withFileTypes: true });
			} catch {
				continue;
			}
			for (const entry of entries) {
				if (!entry.isFile() || !isSafeRos2Name(entry.name) || !isSafeRos2Name(pkg)) { continue; }
				const file = path.join(libDir, entry.name);
				try {
					await fs.promises.access(file, fs.constants.X_OK);
				} catch {
					continue;
				}
				const head = Buffer.alloc(64);
				const fd = await fs.promises.open(file, 'r');
				try { await fd.read(head, 0, 64, 0); } finally { await fd.close(); }
				const language = head.subarray(0, 2).toString() === '#!' && /python/.test(head.toString()) ? 'python' : 'cpp';
				result.push({ package: pkg, node: entry.name, language });
			}
		}
		return result;
	}
}

function isInside(parent: string, child: string): boolean {
	const rel = path.relative(parent, child);
	return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

function shellQuote(value: string): string {
	return /^[A-Za-z0-9_@%+=:,./-]+$/.test(value) ? value : `'${value.replace(/'/g, `'\\''`)}'`;
}
