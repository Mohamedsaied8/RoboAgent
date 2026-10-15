/*---------------------------------------------------------------------------------------------
 *  Copyright (c) RoboAgent. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Agent, AgentProfile, AgentRunOptions, AgentRunResult } from '../../kernel/agent';
import { IAgentHost } from '../../kernel/host';
import { ILlmClient } from '../../kernel/llm';
import { AnyTool, IToolSet, ToolRegistry } from '../../kernel/toolRegistry';
import { DefaultPlatformFactory, IPlatformFactory } from '../../embedded/platformFactory';
import { DefaultTargetCatalog, ITargetCatalog } from '../../embedded/target';
import { ChangeApplied, ChangeRequest } from '../../orchestration/messages';
import { ChangeTracker, createFileTools } from '../tools/fileTools';
import { createDevTools, DevToolContext } from './devTools';

export const DEV_AGENT_ID = 'fw-dev';

export const DEV_AGENT_SYSTEM_PROMPT = `You are the firmware development agent for microcontroller projects (STM32, ESP32; bare-metal or FreeRTOS). You set up toolchains, build, fix build errors, report memory use, flash, and implement change requests. You work only through your tools.

Workflow:
1. Start with detect_project for the folder you were given (default "."). Use what it reports (build system, MCU, FreeRTOS) instead of guessing.
2. Before the first build, run check_toolchain. If the compiler, binutils or OpenOCD are missing, call install_toolchain (downloads pinned, verified archives into the user's tool store, no root). For anything else (CMake, Make, Ninja, st-flash) call install_tools; if that needs the user's password, tell the user the exact command and stop.
3. Build with build. When it fails, work from the structured diagnostics: read the referenced lines with read_file, make the smallest correct fix with edit_file, and build again. Fix the first error first; later errors are often consequences.
4. After a successful build, run size_report and mention flash/RAM use, warning when either is above 85%.
5. Flash only when the user asked for it in this task. Report the flash result honestly, including any problem it names (no probe, no target power, wiring).

Rules:
- Make minimal, focused changes that match the surrounding code style. Do not reformat or restructure code you were not asked to touch.
- Never invent register addresses, bit positions or HAL function names. If you are not sure an API exists, search_text for it in the project's HAL/driver sources first.
- Do not disable warnings or add casts just to silence the compiler; fix the cause.
- If the same error survives three attempts, stop and report what you tried and what you think is wrong.
- A declined approval means the user does not want that action; do not retry it unchanged.
- End with a short summary: what you changed (files), the final build result, and memory use.`;

export interface DevAgentOptions {
	readonly llm: ILlmClient;
	readonly host: IAgentHost;
	readonly catalog?: ITargetCatalog;
	readonly platforms?: IPlatformFactory;
	/** Extra tools (e.g. host-specific ones); they still go through approval by risk. */
	readonly extraTools?: readonly AnyTool[];
	readonly maxSteps?: number;
}

/** The Dev agent: toolchain setup, build, fix, size, flash, change requests. */
export class FirmwareDevAgent extends Agent {
	protected readonly profile: AgentProfile;

	constructor(
		llm: ILlmClient,
		tools: IToolSet,
		host: IAgentHost,
		readonly context: DevToolContext,
		maxSteps = 40,
	) {
		super(llm, tools, host);
		this.profile = { id: DEV_AGENT_ID, systemPrompt: DEV_AGENT_SYSTEM_PROMPT, maxSteps, maxToolCallsPerStep: 8 };
	}

	/**
	 * Implements a change request (from the tester, via the orchestrator) and reports which files
	 * changed and whether the build after the last change succeeded.
	 */
	async handleChangeRequest(request: ChangeRequest, options: AgentRunOptions & { dir?: string } = {}): Promise<{ applied: ChangeApplied; run: AgentRunResult }> {
		const marker = this.context.changes.now();
		const dir = options.dir ?? '.';
		const lines = [
			`Change request ${request.bugId} for the project in "${dir}":`,
			request.description,
			...request.files?.length ? [`Files likely involved: ${request.files.join(', ')}`] : [],
			...request.findings ? [
				`Debug findings (confidence ${request.findings.confidence}):`,
				...request.findings.rootCause ? [`Root cause: ${request.findings.rootCause}`] : [],
				...request.findings.evidence.map(e => `- [${e.kind}] ${e.summary}`),
				...request.findings.suggestedFix ? [`Suggested fix: ${request.findings.suggestedFix}`] : [],
			] : [],
			'Implement the change, then build. Do not flash.',
		];
		const run = await this.run(lines.join('\n'), options);
		const changedFiles = this.context.changes.changedSince(marker);
		// Only a build from *this* request counts, and only if it came after the last change.
		const lastBuild = [...this.context.lastBuild.values()].filter(b => b.at > marker).sort((a, b) => b.at - a.at)[0];
		const builtAfterChange = !!lastBuild && lastBuild.at > this.context.changes.lastChange();
		return {
			applied: {
				type: 'change-applied',
				bugId: request.bugId,
				summary: run.text || `(agent stopped: ${run.stopReason})`,
				changedFiles,
				buildSucceeded: builtAfterChange && lastBuild.ok,
			},
			run,
		};
	}
}

/** Builds a Dev agent with its tools (file tools + dev tools) behind a fresh registry. */
export function createFirmwareDevAgent(options: DevAgentOptions): FirmwareDevAgent {
	const changes = new ChangeTracker();
	const context = new DevToolContext(options.catalog ?? new DefaultTargetCatalog(), options.platforms ?? new DefaultPlatformFactory(), changes);
	const registry = new ToolRegistry();
	for (const tool of [...createFileTools(changes), ...createDevTools(context), ...options.extraTools ?? []]) {
		registry.register(tool);
	}
	return new FirmwareDevAgent(options.llm, registry, options.host, context, options.maxSteps);
}
