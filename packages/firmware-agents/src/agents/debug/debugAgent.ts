/*---------------------------------------------------------------------------------------------
 *  Copyright (c) RoboAgent. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Agent, AgentProfile, AgentRunOptions, AgentRunResult } from '../../kernel/agent';
import { IAgentHost } from '../../kernel/host';
import { ILlmClient } from '../../kernel/llm';
import { AnyTool, IToolSet, ToolRegistry } from '../../kernel/toolRegistry';
import { ISvdProvider } from '../../embedded/svd/svdProvider';
import { ITargetCatalog } from '../../embedded/target';
import { DebugFindings, InvestigationRequest } from '../../orchestration/messages';
import { ChangeTracker, createFileTools } from '../tools/fileTools';
import { createDebugTools, DebugToolContext, SessionFactory } from './debugTools';
import { createDebugSetupTools } from './setupTools';

export const DEBUG_AGENT_ID = 'fw-debug';

export const DEBUG_AGENT_SYSTEM_PROMPT = `You are the firmware debugging agent for microcontrollers (STM32 and the ESP32 family), bare-metal or FreeRTOS. You investigate bugs on the running chip: run control, breakpoints and watchpoints, memory, core registers, peripheral registers decoded from the SVD, threads (FreeRTOS tasks), and crash decoding. You never change source files; when a fix is needed you describe it.

Workflow:
1. If the debug tools may be missing, run check_debug_tools; if something is missing, call ensure_debug_tools (pinned, verified downloads into the user's tool store). If USB or serial access is missing, call install_probe_access; if it returns a command for the user, tell the user and stop.
2. Connect:
   - STM32: start_session over the probe with the project's ELF (look for it with list_directory if needed). The target halts on attach.
   - ESP32 with a JTAG probe (built-in USB-JTAG or ESP-PROG): start_session with transport "probe".
   - ESP32 without a probe (a DevKit on a USB-serial bridge): start with the serial console. read_serial listens; reset_and_capture resets the chip and records the boot and any crash; send_serial sends a console command. For a crash, decode_panic explains it with source lines. If the output contains a core dump, start_session with transport "coredump" opens it in GDB: every FreeRTOS task's backtrace and variables at the moment of the crash. If the firmware has ESP-IDF's GDB stub (CONFIG_ESP_SYSTEM_GDBSTUB_RUNTIME for live debugging, CONFIG_ESP_SYSTEM_PANIC_GDBSTUB after a crash), start_session with transport "serial" gives live breakpoints, stepping, watchpoints and memory over the UART. Note the hardware breakpoint and watchpoint budget it reports (ESP32: 2 + 2).
3. Gather evidence before concluding. Typical moves:
   - wrong peripheral behaviour: read_peripheral for the clock (RCC) and the peripheral itself; check enable bits, mode/configuration fields and status flags against what the code intends (read the init code with read_file / search_text).
   - crash or hang: halt, then decode_crash and backtrace; for a fault, the faulting code and data address in the decode are the strongest evidence. On ESP32 also check threads: a watchdog or deadlock shows in what each task is doing.
   - wrong values: set_breakpoint at the function that computes them, resume with waitMs, then evaluate and locals; set_watchpoint to find who writes a variable.
4. Use compare_peripheral around an init call to see exactly which fields it changed.
5. Finish with report_findings: the root cause in one or two sentences, your confidence, each piece of evidence as one line with the actual value (e.g. "RCC.APB1ENR.USART2EN = 0 (expected 1)", "LoadProhibited at read_sensor_bus main.c:31, EXCVADDR = 0x00000000"), and a suggested fix naming the file and function. Then end_session (resume the target unless the user wants it halted) and give a short summary.

Rules:
- Never invent register values, addresses or bit names: every value you state must come from a tool result in this conversation.
- If decode_panic or start_session warns that the ELF does not match the running firmware, say so: source lines from a different build are not evidence.
- Hardware breakpoints are scarce: clear the ones you no longer need. Only address breakpoints work without the ELF.
- Halt before reading registers, memory or peripherals; resume or step only as the investigation needs. A core dump is a snapshot: no run control.
- write_memory, reset, reset_and_capture and send_serial change the target and ask the user; use them only when the task needs it (e.g. to reproduce a bug), never to "fix" it.
- If the target cannot be reached (no probe, no power, wrong wiring, no GDB stub), report the exact problem the tool gave and stop.
- A declined approval means the user does not want that action; do not retry it unchanged.`;

export interface DebugAgentOptions {
	readonly llm: ILlmClient;
	readonly host: IAgentHost;
	readonly catalog?: ITargetCatalog;
	readonly svd?: ISvdProvider;
	/** Session factory (default: OpenOCD + GDB); tests pass a fake. */
	readonly startSession?: SessionFactory;
	readonly allowGraphicalPrompt?: boolean;
	readonly extraTools?: readonly AnyTool[];
	readonly maxSteps?: number;
}

/** The Debug agent: on-chip investigation, read-only on source, ends in {@link DebugFindings}. */
export class FirmwareDebugAgent extends Agent {
	protected readonly profile: AgentProfile;

	constructor(llm: ILlmClient, tools: IToolSet, host: IAgentHost, readonly context: DebugToolContext, maxSteps = 40) {
		super(llm, tools, host);
		this.profile = { id: DEBUG_AGENT_ID, systemPrompt: DEBUG_AGENT_SYSTEM_PROMPT, maxSteps, maxToolCallsPerStep: 8 };
	}

	/**
	 * Investigates a reported symptom and returns the findings the agent recorded (or, if it never
	 * called report_findings, a low-confidence note with its final answer). Any session it left
	 * open is ended (target resumed, probe released), also when the run fails — including a session
	 * opened before this call.
	 */
	async investigate(request: InvestigationRequest, options: AgentRunOptions & { dir?: string; part?: string } = {}): Promise<{ findings: DebugFindings; run: AgentRunResult }> {
		this.context.bugId = request.bugId;
		const before = this.context.findings.length;
		const lines = [
			`Investigation ${request.bugId} for the project in "${options.dir ?? '.'}"${options.part ? ` (MCU ${options.part})` : ''}:`,
			`Symptom: ${request.symptom}`,
			...request.hypotheses?.length ? ['Hypotheses to check:', ...request.hypotheses.map(h => `- ${h}`)] : [],
			'Find the root cause on the target and finish with report_findings.',
		];
		let run: AgentRunResult;
		try {
			run = await this.run(lines.join('\n'), options);
		} finally {
			// An investigation never leaves the target halted or the probe locked.
			await this.context.endSession(true).catch(err => this.host.log('warn', `[${this.id}] ending the debug session failed: ${err instanceof Error ? err.message : String(err)}`));
		}
		const recorded = this.context.findings.slice(before).filter(f => f.bugId === request.bugId).at(-1);
		const findings: DebugFindings = recorded ?? {
			type: 'debug-findings',
			bugId: request.bugId,
			confidence: 'low',
			evidence: [{ kind: 'note', summary: (run.text || `agent stopped: ${run.stopReason}`).slice(0, 500) }],
		};
		return { findings, run };
	}

	/** Ends a session the agent left open (hosts call this when the conversation ends). */
	async dispose(): Promise<void> {
		await this.context.endSession(true);
	}
}

/** Builds a Debug agent: read-only file tools, debug setup tools and on-chip tools. */
export function createFirmwareDebugAgent(options: DebugAgentOptions): FirmwareDebugAgent {
	const context = new DebugToolContext(DEBUG_AGENT_ID, options.catalog, options.svd, options.startSession);
	const registry = new ToolRegistry();
	// Least privilege: the Debug agent reads source but never writes it.
	const fileTools = createFileTools(new ChangeTracker()).filter(t => t.risk === 'read');
	for (const tool of [...fileTools, ...createDebugSetupTools({ ...options.catalog ? { catalog: options.catalog } : {}, ...options.allowGraphicalPrompt ? { allowGraphicalPrompt: true } : {} }), ...createDebugTools(context), ...options.extraTools ?? []]) {
		registry.register(tool);
	}
	return new FirmwareDebugAgent(options.llm, registry, options.host, context, options.maxSteps);
}
