/*---------------------------------------------------------------------------------------------
 *  Copyright (c) RoboAgent. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { realpathSync } from 'fs';
import * as path from 'path';
import { ApprovalRequest, ExecOptions, ExecResult, IAgentHost, IFileSystem, ISystemProbe, IToolStore, LogLevel } from '../../kernel/host';
import { redactSecrets } from '../../kernel/redact';
import { isInside, NodeFileSystem } from './nodeFileSystem';
import { runProcess } from './nodeProcessRunner';
import { NodeSystemProbe } from './nodeSystemProbe';

/** Environment variables never passed to child processes (in addition to {@link SECRET_ENV_PATTERN}). */
export const DEFAULT_SECRET_ENV_NAMES: readonly string[] = ['OPENROUTER_API_KEY', 'ANTHROPIC_API_KEY', 'OPENAI_API_KEY'];

/** Names that look like credentials (GITHUB_TOKEN, AWS_SECRET_ACCESS_KEY, NPM_TOKEN, DB_PASSWORD, …). */
export const SECRET_ENV_PATTERN = /TOKEN|SECRET|PASSWORD|PASSWD|API_?KEY|ACCESS_?KEY|PRIVATE_?KEY|CREDENTIAL|SESSION_?KEY/i;

export interface NodeAgentHostOptions {
	/** Workspace root; files and process working directories are confined to it. */
	readonly root: string;
	/** Asks the user. Omitted means every risky action is denied (safe for unattended runs). */
	readonly approve?: (request: ApprovalRequest) => Promise<boolean>;
	readonly write?: (line: string) => void;
	/** Values never to print or hand to the model (API keys); known key formats are redacted regardless. */
	readonly secrets?: readonly string[];
	/** Variables stripped from child environments (default {@link DEFAULT_SECRET_ENV_NAMES}). */
	readonly secretEnvNames?: readonly string[];
	readonly minLogLevel?: LogLevel;
	/** Environment children start from (default: this process's). */
	readonly env?: Readonly<Record<string, string | undefined>>;
	/** Where agents install tools; its `onPath` tools come first on children's PATH. */
	readonly toolStore?: IToolStore;
	/**
	 * `auto` (default): tool installs into the tool store (category `install`: pinned,
	 * hash-verified, user space only) are approved without asking. `ask`: they go to `approve`
	 * like everything else. Root steps (`system`), edits, builds and hardware always ask.
	 * When not given, `$ROBOAGENT_INSTALL_POLICY` decides (`ask` or `auto`; anything else → `ask`).
	 */
	readonly installPolicy?: 'ask' | 'auto';
	/** Tools whose `install` approvals the `auto` policy covers (default: the two pinned-download tools). */
	readonly autoInstallTools?: readonly string[];
	/** System layout discovery (default: {@link NodeSystemProbe} on this machine). */
	readonly system?: ISystemProbe;
}

/** `$ROBOAGENT_INSTALL_POLICY`: unset or empty → `auto`; `ask`/`auto` as given; any other value → `ask` (the safe reading of a typo). */
export function installPolicyFromEnv(value: string | undefined): 'ask' | 'auto' {
	const v = value?.trim().toLowerCase();
	return !v || v === 'auto' ? 'auto' : 'ask';
}

/** The only tools that download pinned, hash-verified archives into the tool store. */
export const DEFAULT_AUTO_INSTALL_TOOLS: readonly string[] = ['ensure_debug_tools', 'install_toolchain'];

const LEVELS: readonly LogLevel[] = ['debug', 'info', 'warn', 'error'];

/** Real path of `p`; for a path that does not exist yet, of its deepest existing ancestor plus the rest. */
function realOrResolved(p: string): string {
	let existing = path.resolve(p);
	const rest: string[] = [];
	for (; ;) {
		try {
			return path.join(realpathSync(existing), ...rest);
		} catch {
			const parent = path.dirname(existing);
			if (parent === existing) {
				return path.resolve(p);
			}
			rest.unshift(path.basename(existing));
			existing = parent;
		}
	}
}

/**
 * The tool store holds programs the agents run, some by absolute path from read-only checks:
 * it must be somewhere the agents' file tools cannot write, so never inside the workspace (nor
 * the workspace inside it).
 */
export function assertStoreOutsideWorkspace(store: string, workspace: string): void {
	const s = realOrResolved(store);
	const w = realOrResolved(workspace);
	if (isInside(w, s) || isInside(s, w)) {
		throw new Error(`The tool store (${store}) must not be inside the workspace (${workspace}) or contain it; set ROBOAGENT_TOOLS_DIR to a folder outside it.`);
	}
}

/** {@link IAgentHost} for plain Node: the CLI, the MCP server, CI and tests. */
export class NodeAgentHost implements IAgentHost {
	readonly fs: IFileSystem;
	readonly toolStore?: IToolStore;
	readonly system: ISystemProbe;
	readonly installPolicy: 'ask' | 'auto';
	private readonly childEnv: Record<string, string | undefined>;

	constructor(private readonly options: NodeAgentHostOptions) {
		this.fs = new NodeFileSystem(options.root);
		this.installPolicy = options.installPolicy ?? installPolicyFromEnv((options.env ?? process.env).ROBOAGENT_INSTALL_POLICY);
		if (options.toolStore) {
			assertStoreOutsideWorkspace(options.toolStore.location, options.root);
			this.toolStore = options.toolStore;
		}
		const secretValues = new Set(options.secrets ?? []);
		const secretNames = new Set(options.secretEnvNames ?? DEFAULT_SECRET_ENV_NAMES);
		this.system = options.system ?? new NodeSystemProbe({
			env: options.env ?? process.env,
			workspaceRoot: options.root,
			toolStoreBins: () => this.toolStore ? this.toolStore.binPaths() : Promise.resolve([]),
		});
		this.childEnv = Object.fromEntries(Object.entries(options.env ?? process.env)
			.filter(([name, value]) => !secretNames.has(name) && !SECRET_ENV_PATTERN.test(name) && !(value !== undefined && secretValues.has(value))));
	}

	async exec(command: string, args: readonly string[], options?: ExecOptions): Promise<ExecResult> {
		let baseEnv = this.childEnv;
		const bins = this.toolStore && !options?.noToolStorePath ? await this.toolStore.binPaths() : [];
		if (bins.length) {
			const key = Object.keys(baseEnv).find(k => k.toUpperCase() === 'PATH') ?? 'PATH';
			baseEnv = { ...baseEnv, [key]: [...bins, baseEnv[key]].filter(Boolean).join(path.delimiter) };
		}
		// Tool output goes to the model and the UI; keep secrets out of both even if a child prints one.
		return runProcess(this.options.root, command, args, { ...options, baseEnv, redact: text => this.redact(text) });
	}

	approve(request: ApprovalRequest): Promise<boolean> {
		if (this.installPolicy === 'auto' && request.category === 'install' && (this.options.autoInstallTools ?? DEFAULT_AUTO_INSTALL_TOOLS).includes(request.toolName)) {
			this.log('info', `Auto-approved (install policy "auto"): ${request.summary}`);
			return Promise.resolve(true);
		}
		return this.options.approve ? this.options.approve(request) : Promise.resolve(false);
	}

	log(level: LogLevel, message: string): void {
		if (LEVELS.indexOf(level) >= LEVELS.indexOf(this.options.minLogLevel ?? 'info')) {
			this.emit(`[${level}] ${message}`);
		}
	}

	progress(message: string): void {
		this.emit(`… ${message}`);
	}

	private redact(text: string): string {
		return redactSecrets(text, this.options.secrets);
	}

	private emit(line: string): void {
		const write = this.options.write ?? ((l: string) => process.stderr.write(`${l}\n`));
		write(this.redact(line));
	}
}
