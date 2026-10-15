/*---------------------------------------------------------------------------------------------
 *  Copyright (c) RoboAgent. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as assert from 'assert';
import { createFirmwareDevAgent, DEV_AGENT_ID } from '../agents/dev/devAgent';
import { ChangeTracker, createFileTools, isSecretPath } from '../agents/tools/fileTools';
import { ToolContext } from '../kernel/tool';
import { LlmEvent, LlmRequest } from '../kernel/llm';
import { callTool, say, ScriptedFakeLlm } from '../llm/scriptedFakeLlm';
import { FakeHost } from './fakeHost';

/** The JSON content of the tool result for `callId` in the last request the model saw. */
function toolResult(llm: ScriptedFakeLlm, callId: string): { error?: string;[key: string]: unknown } {
	for (const request of [...llm.requests].reverse()) {
		const m = request.messages.find(x => x.role === 'tool' && x.toolCallId === callId);
		if (m && m.role === 'tool') {
			return JSON.parse(m.content);
		}
	}
	throw new Error(`no result for ${callId}`);
}

suite('file tools', () => {

	const ctx = (host: FakeHost): ToolContext => ({ host, signal: new AbortController().signal, agentId: 't', callId: 'c' });
	const tools = (changes = new ChangeTracker()) => Object.fromEntries(createFileTools(changes).map(t => [t.name, t]));

	test('secret and VCS files are refused for reading and writing, and hidden from listings', async () => {
		for (const p of ['.env', 'app/.env.local', '.git/config', '.git/hooks/pre-commit', 'keys/device.pem', 'home/.ssh/id_ed25519', 'aws_credentials.json', 'cfg/secrets.h', '.npmrc']) {
			assert.ok(isSecretPath(p), p);
		}
		for (const p of ['Src/main.c', 'Inc/stm32f1xx_hal_conf.h', 'CMakeLists.txt', 'environment.c', 'docs/keyboard.md']) {
			assert.ok(!isSecretPath(p), p);
		}
		const host = new FakeHost();
		host.fs.files.set('.env', 'OPENROUTER_API_KEY=x');
		host.fs.files.set('main.c', '');
		const t = tools();
		await assert.rejects(t.read_file.invoke({ path: '.env' }, ctx(host)), /credential, key or VCS-internal/);
		await assert.rejects(t.write_file.invoke({ path: '.git/hooks/post-checkout', content: 'rm -rf ~' }, ctx(host)), /VCS-internal/);
		assert.deepStrictEqual(await t.list_directory.invoke({}, ctx(host)), ['main.c']);
	});

	test('read_file pages long files with line numbers', async () => {
		const host = new FakeHost();
		host.fs.files.set('a.c', Array.from({ length: 10 }, (_, i) => `line${i + 1}`).join('\n'));
		const r = await tools().read_file.invoke({ path: 'a.c', startLine: 3, maxLines: 2 }, ctx(host)) as Record<string, unknown>;
		assert.deepStrictEqual(r, { path: 'a.c', totalLines: 10, startLine: 3, endLine: 4, content: '3\tline3\n4\tline4', more: '6 more lines; call again with startLine=5' });
	});

	test('edit_file needs exactly one match and records the change', async () => {
		const host = new FakeHost();
		host.fs.files.set('m.c', 'a = 1;\nb = 1;\n');
		const changes = new ChangeTracker();
		const t = tools(changes);
		await assert.rejects(t.edit_file.invoke({ path: 'm.c', oldText: ' = 1;', newText: ' = 2;' }, ctx(host)), /more than once/);
		await assert.rejects(t.edit_file.invoke({ path: 'm.c', oldText: 'c = 1;', newText: '' }, ctx(host)), /not found/);
		await t.edit_file.invoke({ path: 'm.c', oldText: 'b = 1;', newText: 'b = 2;' }, ctx(host));
		assert.strictEqual(host.fs.files.get('m.c'), 'a = 1;\nb = 2;\n');
		assert.deepStrictEqual(changes.changedSince(0), ['m.c']);
	});

	test('search_text finds literal text in sources and skips secrets and build output', async () => {
		const host = new FakeHost();
		host.fs.files.set('Src/uart.c', 'HAL_UART_Init(&huart2);\n');
		host.fs.files.set('build/gen.c', 'HAL_UART_Init(&x);\n');
		host.fs.files.set('cfg/secrets.h', 'HAL_UART_Init key\n');
		const r = await tools().search_text.invoke({ text: 'HAL_UART_Init' }, ctx(host)) as { matches: string[] };
		assert.deepStrictEqual(r.matches, ['Src/uart.c:1: HAL_UART_Init(&huart2);']);
	});
});

const PROJECT = {
	'fw/CMakeLists.txt': 'project(app C)\n',
	'fw/README.md': 'Target: STM32F103C8T6\n',
	'fw/Src/main.c': '#include <stdint.h>\nint main(void)\n{\n\tuint8 x = 0;\n\treturn x;\n}\n',
};

/** Scripts the toolchain: everything is installed; the build fails until `uint8` is fixed. */
function firmwareHost(approve = true): FakeHost {
	const host = new FakeHost(approve);
	for (const [p, c] of Object.entries(PROJECT)) {
		host.fs.files.set(p, c);
	}
	host.onExec = (command, args) => {
		if (args[0] === '--version') {
			return { stdout: `${command} 1.0` };
		}
		if (command === 'cmake' && args[0] === '-S') {
			host.fs.files.set('fw/build/CMakeCache.txt', '');
			return { stdout: '-- Configuring done\n' };
		}
		if (command === 'cmake' && args[0] === '--build') {
			if (host.fs.files.get('fw/Src/main.c')!.includes('uint8 ')) {
				return { exitCode: 2, stderr: `/work/fw/Src/main.c:4:2: error: unknown type name 'uint8'; did you mean 'uint8_t'?\n` };
			}
			host.fs.files.set('fw/build/app.elf', '');
			return { stdout: '[100%] Built target app.elf\n' };
		}
		if (command === 'arm-none-eabi-size') {
			return { stdout: '   text\t   data\t    bss\t    dec\t    hex\tfilename\n  58982\t    100\t  13000\t  72082\t  11992\tfw/build/app.elf\n' };
		}
		return { exitCode: 1, stderr: `unexpected ${command}` };
	};
	return host;
}

suite('FirmwareDevAgent', () => {

	test('detect → toolchain → failing build → read → fix → green build → size, with approvals for every build and edit', async () => {
		const host = firmwareHost();
		const llm = new ScriptedFakeLlm([
			callTool('d', 'detect_project', { dir: 'fw' }),
			callTool('t', 'check_toolchain', { dir: 'fw' }),
			callTool('b1', 'build', { dir: 'fw' }),
			callTool('r', 'read_file', { path: 'fw/Src/main.c', startLine: 4, maxLines: 1 }),
			callTool('e', 'edit_file', { path: 'fw/Src/main.c', oldText: '\tuint8 x = 0;', newText: '\tuint8_t x = 0;' }),
			callTool('b2', 'build', { dir: 'fw' }),
			callTool('s', 'size_report', { dir: 'fw' }),
			say('Fixed the uint8 typo in fw/Src/main.c; build OK; flash 90.1%, RAM 64%.'),
		]);
		const agent = createFirmwareDevAgent({ llm, host });
		const result = await agent.run('Build the firmware in fw and fix any errors.');

		assert.strictEqual(result.stopReason, 'done');
		const detected = toolResult(llm, 'd');
		assert.deepStrictEqual([detected.buildSystem, (detected.target as { part: string }).part, detected.toolchain, detected.flashers], ['cmake', 'STM32F103C8T6', 'arm-none-eabi-gcc', ['openocd', 'st-flash']]);
		assert.deepStrictEqual(toolResult(llm, 't').missing, []);

		const failed = toolResult(llm, 'b1') as { ok: boolean; steps: { step: string; diagnostics: { file: string; line: number; message: string }[] }[] };
		assert.strictEqual(failed.ok, false);
		assert.deepStrictEqual(failed.steps.map(s => s.step), ['configure', 'build']);
		assert.deepStrictEqual(failed.steps[1].diagnostics[0], { severity: 'error', source: 'compiler', message: `unknown type name 'uint8'; did you mean 'uint8_t'?`, file: '/work/fw/Src/main.c', line: 4, column: 2 });

		const green = toolResult(llm, 'b2') as { ok: boolean; artifacts: { elf: string[] } };
		assert.deepStrictEqual([green.ok, green.artifacts.elf], [true, ['fw/build/app.elf']]);
		const size = toolResult(llm, 's');
		assert.deepStrictEqual([size.flashBytes, size.flashPercent, size.ramBytes, size.ramPercent], [59082, 90.2, 13100, 64]);

		assert.deepStrictEqual(host.approvals.map(a => [a.agentId, a.toolName, a.risk]), [
			[DEV_AGENT_ID, 'build', 'write'], [DEV_AGENT_ID, 'edit_file', 'write'], [DEV_AGENT_ID, 'build', 'write'],
		]);
	});

	test('flashing needs hardware approval; when declined nothing runs', async () => {
		const host = firmwareHost(false);
		host.fs.files.set('fw/build/app.elf', '');
		const llm = new ScriptedFakeLlm([callTool('f', 'flash', { dir: 'fw' }), say('The user declined flashing.')]);
		await createFirmwareDevAgent({ llm, host }).run('Flash it');
		assert.deepStrictEqual(host.approvals.map(a => [a.toolName, a.risk, a.summary]), [['flash', 'hardware', 'Flash the build in fw to the target']]);
		assert.ok(!host.commands.some(c => c.command === 'openocd'));
		assert.match(toolResult(llm, 'f').error ?? '', /declined/);
	});

	test('flash warns when sources changed after the last build', async () => {
		const host = firmwareHost();
		host.fs.files.set('fw/Src/main.c', PROJECT['fw/Src/main.c'].replace('uint8 ', 'uint8_t '));
		host.onExec = ((inner) => (command, args, options) => command === 'openocd' ? { stderr: '** Verified OK **' } : inner(command, args, options))(host.onExec);
		const llm = new ScriptedFakeLlm([
			callTool('b', 'build', { dir: 'fw' }),
			callTool('e', 'edit_file', { path: 'fw/Src/main.c', oldText: 'return x;', newText: 'return (int)x;' }),
			callTool('f', 'flash', { dir: 'fw' }),
			say('done'),
		]);
		await createFirmwareDevAgent({ llm, host }).run('Build, tweak, flash');
		const flashed = toolResult(llm, 'f');
		assert.deepStrictEqual([flashed.ok, flashed.verified, flashed.flasher], [true, true, 'openocd']);
		assert.match(String(flashed.warning), /changed after the last build/);
	});

	test('missing project, missing tools and unknown targets are explained to the model', async () => {
		const host = new FakeHost();
		host.fs.files.set('docs/readme.md', '');
		host.onExec = command => ({ exitCode: null, spawnError: `spawn ${command} ENOENT` });
		host.fs.files.set('lib/Makefile', 'all:\n');
		const llm = new ScriptedFakeLlm([
			callTool('a', 'detect_project', { dir: 'docs' }),
			callTool('b', 'build', { dir: 'lib' }),
			callTool('c', 'flash', { dir: 'lib' }),
			callTool('d', 'read_file', { path: '../etc/passwd' }),
			say('done'),
		]);
		await createFirmwareDevAgent({ llm, host }).run('x');
		assert.match(toolResult(llm, 'a').error ?? '', /No build system found/);
		const build = toolResult(llm, 'b') as { ok: boolean; steps: { spawnError?: string; hint?: string }[] };
		assert.deepStrictEqual([build.ok, !!build.steps[0].spawnError, build.steps[0].hint], [false, true, 'The build tool is missing: run check_toolchain.']);
		assert.match(toolResult(llm, 'c').error ?? '', /target MCU is unknown/);
	});

	test('a change request reports changed files and whether the build after the change passed', async () => {
		const host = firmwareHost();
		const turns: ((r: LlmRequest) => LlmEvent[])[] = [
			r => {
				const task = r.messages[0].role === 'user' ? r.messages[0].content : '';
				assert.match(task, /Change request bug-7/);
				assert.match(task, /\[peripheral\] RCC\.APB1ENR\.USART2EN = 0/);
				assert.match(task, /Do not flash/);
				return callTool('e', 'edit_file', { path: 'fw/Src/main.c', oldText: '\tuint8 x = 0;', newText: '\tuint8_t x = 0;' });
			},
			() => callTool('b', 'build', { dir: 'fw' }),
			() => say('Changed main.c; build OK.'),
		];
		const agent = createFirmwareDevAgent({ llm: new ScriptedFakeLlm(turns), host });
		const { applied } = await agent.handleChangeRequest({
			type: 'change-request', bugId: 'bug-7', description: 'Enable the USART2 clock before HAL_UART_Init.',
			findings: { type: 'debug-findings', bugId: 'bug-7', confidence: 'high', evidence: [{ kind: 'peripheral', summary: 'RCC.APB1ENR.USART2EN = 0' }] },
		}, { dir: 'fw' });
		assert.deepStrictEqual(applied, { type: 'change-applied', bugId: 'bug-7', summary: 'Changed main.c; build OK.', changedFiles: ['fw/Src/main.c'], buildSucceeded: true });
	});

	test('a change that was not rebuilt is reported as not built', async () => {
		const host = firmwareHost();
		const llm = new ScriptedFakeLlm([
			callTool('b', 'build', { dir: 'fw' }),
			callTool('e', 'edit_file', { path: 'fw/Src/main.c', oldText: '\tuint8 x = 0;', newText: '\tuint8_t x = 0;' }),
			say('Edited.'),
		]);
		const { applied } = await createFirmwareDevAgent({ llm, host }).handleChangeRequest({ type: 'change-request', bugId: 'b', description: 'fix' });
		assert.deepStrictEqual([applied.changedFiles, applied.buildSucceeded], [['fw/Src/main.c'], false]);
	});
});
