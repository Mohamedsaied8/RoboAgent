/*---------------------------------------------------------------------------------------------
 *  Copyright (c) RoboAgent. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

export type LintSeverity = 'error' | 'warning' | 'info';

export interface LintFinding {
	readonly severity: LintSeverity;
	readonly setting: string;
	readonly message: string;
	readonly fix: string;
}

/** `#define configFOO value` (and function-like `#define configASSERT( x ) …`), comments stripped. */
export function parseConfigDefines(header: string): Map<string, string> {
	const defines = new Map<string, string>();
	const text = header.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/\/\/.*$/gm, '').replace(/\\\r?\n/g, ' ');
	for (const m of text.matchAll(/^[ \t]*#[ \t]*define[ \t]+(config\w+|INCLUDE_\w+)(\([^)]*\))?[ \t]*(.*)$/gm)) {
		defines.set(m[1], m[3].trim());
	}
	return defines;
}

function numeric(value: string | undefined): number | undefined {
	if (value === undefined) {
		return undefined;
	}
	const m = /^\(?\s*(0x[0-9a-f]+|\d+)\s*[uUlL]*\s*\)?$/i.exec(value);
	return m ? Number(m[1]) : undefined;
}

export interface FreeRtosLintContext {
	readonly arch?: 'cortex-m' | 'xtensa' | 'riscv';
	/** Build files (CMakeLists.txt, Makefile, platformio.ini) concatenated, to look for linker flags. */
	readonly buildFiles?: string;
}

/**
 * Checks a FreeRTOSConfig.h for the settings that make crashes diagnosable and that the debug
 * agent relies on (stack-overflow checking, asserts, malloc-failed hook, queue registry,
 * interrupt-priority limits on Cortex-M, `uxTopUsedPriority` for OpenOCD task awareness).
 */
export function lintFreeRtosConfig(header: string, context: FreeRtosLintContext = {}): LintFinding[] {
	const d = parseConfigDefines(header);
	const findings: LintFinding[] = [];
	const add = (severity: LintSeverity, setting: string, message: string, fix: string) => findings.push({ severity, setting, message, fix });

	if (!d.has('configASSERT')) {
		add('warning', 'configASSERT', 'configASSERT is not defined, so the kernel cannot report misuse (e.g. calling a non-FromISR API from an interrupt).', '#define configASSERT( x ) if( ( x ) == 0 ) { taskDISABLE_INTERRUPTS(); for( ;; ); }');
	}
	const stack = numeric(d.get('configCHECK_FOR_STACK_OVERFLOW'));
	if (!stack) {
		add('warning', 'configCHECK_FOR_STACK_OVERFLOW', 'Stack-overflow checking is off: an overflowing task silently corrupts memory.', '#define configCHECK_FOR_STACK_OVERFLOW 2 and implement vApplicationStackOverflowHook()');
	} else if (stack === 1) {
		add('info', 'configCHECK_FOR_STACK_OVERFLOW', 'Method 1 only checks the stack pointer at context switches; method 2 also checks the stack fill pattern.', '#define configCHECK_FOR_STACK_OVERFLOW 2');
	}
	if (numeric(d.get('configUSE_MALLOC_FAILED_HOOK')) !== 1) {
		add('warning', 'configUSE_MALLOC_FAILED_HOOK', 'Heap exhaustion is silent: pvPortMalloc just returns NULL.', '#define configUSE_MALLOC_FAILED_HOOK 1 and implement vApplicationMallocFailedHook()');
	}
	if (!numeric(d.get('configQUEUE_REGISTRY_SIZE'))) {
		add('info', 'configQUEUE_REGISTRY_SIZE', 'Queues and semaphores are not registered, so a debugger cannot list them by name.', '#define configQUEUE_REGISTRY_SIZE 8 and call vQueueAddToRegistry() for important queues');
	}
	if (numeric(d.get('configUSE_TRACE_FACILITY')) !== 1) {
		add('info', 'configUSE_TRACE_FACILITY', 'Trace facility off: task numbers and uxTaskGetSystemState() are unavailable for debugging.', '#define configUSE_TRACE_FACILITY 1');
	}
	if (context.arch === 'cortex-m') {
		if (!d.has('configMAX_SYSCALL_INTERRUPT_PRIORITY') && !d.has('configMAX_API_CALL_INTERRUPT_PRIORITY')) {
			add('error', 'configMAX_SYSCALL_INTERRUPT_PRIORITY', 'Not defined: on Cortex-M the port cannot mask interrupts that call FreeRTOS APIs, which causes hard-to-trace crashes.', 'Define configMAX_SYSCALL_INTERRUPT_PRIORITY (e.g. 5 << (8 - configPRIO_BITS)) and keep every ISR that calls a FromISR API at that priority or lower urgency.');
		}
		if (context.buildFiles !== undefined && !context.buildFiles.includes('uxTopUsedPriority')) {
			add('info', 'uxTopUsedPriority', 'OpenOCD\'s FreeRTOS task awareness reads uxTopUsedPriority, which --gc-sections may remove.', 'Add the linker flag -Wl,--undefined=uxTopUsedPriority');
		}
	}
	return findings;
}
