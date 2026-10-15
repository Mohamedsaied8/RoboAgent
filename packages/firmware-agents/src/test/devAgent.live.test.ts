/*---------------------------------------------------------------------------------------------
 *  Copyright (c) RoboAgent. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as assert from 'assert';
import { execFileSync } from 'child_process';
import { promises as fs } from 'fs';
import * as os from 'os';
import * as path from 'path';
import { NodeAgentHost } from '../adapters/node/nodeAgentHost';
import { createFirmwareDevAgent } from '../agents/dev/devAgent';
import { ApprovalRequest } from '../kernel/host';
import { createOpenRouterClient, openRouterOptionsFromEnv } from '../llm/openRouter';
import { writeStm32LibraryFixture } from './firmwareFixtures';

/**
 * @llm @toolchain — a real model drives the Dev agent against the real toolchain: it must find
 * and fix a seeded compile error in the STM32 fixture and end with a green build. Runs only with
 * OPENROUTER_API_KEY + OPENROUTER_MODEL set and arm-none-eabi-gcc + cmake installed.
 */
suite('@llm @toolchain FirmwareDevAgent live', function () {

	test('fixes a seeded compile error and builds', async function () {
		const env = openRouterOptionsFromEnv(process.env);
		let toolchain = true;
		try {
			execFileSync('arm-none-eabi-gcc', ['--version'], { stdio: 'ignore' });
			execFileSync('cmake', ['--version'], { stdio: 'ignore' });
		} catch {
			toolchain = false;
		}
		if (!env || !toolchain) {
			this.skip();
		}
		this.timeout(600_000);

		const root = await fs.mkdtemp(path.join(os.tmpdir(), 'fwagents-live-'));
		try {
			await writeStm32LibraryFixture(path.join(root, 'stm32_test'));
			const file = path.join(root, 'stm32_test/Src/stm32_test.c');
			await fs.writeFile(file, (await fs.readFile(file, 'utf8')).replace('return ++s_ticks;', 'return ++s_tick;'));

			const approvals: ApprovalRequest[] = [];
			const host = new NodeAgentHost({
				root,
				secrets: [env!.apiKey],
				write: () => { },
				// Allow builds and edits; never installs or hardware in an automated test.
				approve: async request => {
					approvals.push(request);
					return request.risk === 'write' && request.toolName !== 'install_tools';
				},
			});
			const llm = createOpenRouterClient({ ...env!, appName: 'RoboAgent firmware-agents tests', temperature: 0 });
			const agent = createFirmwareDevAgent({ llm, host, maxSteps: 25 });
			const result = await agent.run('Build the firmware project in "stm32_test" and fix any compile errors.');

			assert.strictEqual(result.stopReason, 'done', result.text);
			assert.match(await fs.readFile(file, 'utf8'), /return \+\+s_ticks;/);
			const last = [...agent.context.lastBuild.values()].at(-1);
			assert.ok(last?.ok, 'the last build should be green');
			assert.ok(!approvals.some(a => a.risk === 'hardware'), 'the agent must not try to flash unasked');
		} finally {
			await fs.rm(root, { recursive: true, force: true });
		}
	});
});
