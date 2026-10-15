/*---------------------------------------------------------------------------------------------
 *  Copyright (c) RoboAgent. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as assert from 'assert';
import { createHash } from 'crypto';
import { installPolicyFromEnv, NodeAgentHost } from '../adapters/node/nodeAgentHost';
import { createDebugSetupTools } from '../agents/debug/setupTools';
import { DefaultTargetCatalog } from '../embedded/target';
import { ExecutableDependency, ProbeAccessDependency, SerialAccessDependency } from '../install/dependencies';
import { ALLOWED_DOWNLOAD_HOSTS, archiveFor, TOOL_MANIFEST, ToolId, validateArchiveSpec } from '../install/manifest';
import { grantsInGrepDump, PROBES, probeCovered, usbIdsInUdevRules } from '../install/probes';
import { debugRequirements, DependencyResolver } from '../install/resolver';
import { ArchiveSpec, InstalledTool, IToolStore, PlatformId } from '../kernel/host';
import { ToolRegistry } from '../kernel/toolRegistry';
import { Agent, AgentProfile } from '../kernel/agent';
import { ILlmClient } from '../kernel/llm';
import { callTool, say, ScriptedFakeLlm } from '../llm/scriptedFakeLlm';
import { FakeHost, FakeSystemProbe } from './fakeHost';

/** In-memory tool store: "installs" by recording the spec under /store/<id>/<version>. */
class FakeToolStore implements IToolStore {
	readonly location = '/store';
	readonly tools: InstalledTool[] = [];
	readonly installs: ArchiveSpec[] = [];
	constructor(private readonly plat: PlatformId | undefined = 'linux-x64') { }
	platform() { return this.plat; }
	async installed() { return this.tools; }
	async find(id: string) { return this.tools.find(t => t.id === id); }
	async install(spec: ArchiveSpec) {
		this.installs.push(spec);
		const dir = `/store/${spec.id}/${spec.version}`;
		const tool = { id: spec.id, version: spec.version, dir, binDir: `${dir}/${spec.binDir}`, sha256: spec.sha256, onPath: spec.onPath };
		this.tools.push(tool);
		return tool;
	}
	async remove() { }
	async binPaths() { return this.tools.filter(t => t.onPath).map(t => t.binDir); }
	readonly fileContents = new Map<string, string>();
	async readFile(id: string, version: string, rel: string) {
		const c = this.fileContents.get(`${id}@${version}/${rel}`);
		if (c === undefined) {
			throw new Error(`no ${rel}`);
		}
		return c;
	}
}

class StoreHost extends FakeHost {
	constructor(readonly toolStore: FakeToolStore = new FakeToolStore(), approve = true) {
		super(approve);
	}
}

/** Where the fake machine's programs and udev folders are — deliberately not real paths. */
const SBIN = '/discovered/sbin';
const ADMIN_RULES = '/udev-admin/rules.d';

/** Scripts a Linux machine: `present` programs answer `--version`, rule files and groups as given. */
function machine(host: FakeHost, o: { present?: Record<string, string>; rules?: string; groups?: string; dbGroups?: string; sudo?: boolean; pkexec?: boolean }) {
	const system = new FakeSystemProbe();
	for (const name of ['sudo', 'pkexec', 'tee', 'chmod', 'udevadm', 'usermod']) {
		system.programs.set(name, { path: `${SBIN}/${name}`, root: true });
	}
	for (const name of Object.keys(o.present ?? {})) {
		system.programs.set(name, { path: `/discovered/bin/${name}` });
	}
	system.ruleDirs = [ADMIN_RULES, '/udev-vendor/rules.d'];
	system.ruleFiles = o.rules ? [{ file: '/udev-vendor/rules.d/49-test.rules', content: o.rules }] : [];
	host.system = system;
	host.onExec = (command, args) => {
		const base = command.split('/').pop()!;
		if (args[0] === '--version' && !command.startsWith('/')) {
			const v = o.present?.[command];
			return v ? { stdout: `${v}\n` } : { exitCode: null, spawnError: `spawn ${command} ENOENT` };
		}
		if (command === 'id') {
			if (args[0] === '-un') {
				return { stdout: 'mohamed\n' };
			}
			return { stdout: `${args.length > 1 ? o.dbGroups ?? o.groups ?? 'mohamed plugdev' : o.groups ?? 'mohamed plugdev'}\n` };
		}
		if (command === 'getent') {
			return args[1] === 'dialout' ? { stdout: 'dialout:x:20:\n' } : { exitCode: 2 };
		}
		if (command === `${SBIN}/sudo`) {
			return o.sudo ? {} : { exitCode: 1, stderr: 'sudo: a password is required\n' };
		}
		if (command === `${SBIN}/pkexec`) {
			return o.pkexec ? {} : { exitCode: 126, stderr: 'Error executing command as another user: Not authorized\n' };
		}
		if (command.startsWith('/') && args[0] === '--version') {
			return base === 'openocd' || base.includes('gdb') ? undefined : { exitCode: 127, spawnError: 'ENOENT' };
		}
		return { exitCode: 127, spawnError: `spawn ${command} ENOENT` };
	};
}

const STLINK_RULES = [
	'# stm32 discovery boards, with onboard st/linkv2',
	'SUBSYSTEMS=="usb", ATTRS{idVendor}=="0483", ATTRS{idProduct}=="3748", \\',
	'    MODE="660", TAG+="uaccess", ENV{ID_MM_DEVICE_IGNORE}="1", \\',
	'    SYMLINK+="stlinkv2_%n"',
	'# ATTRS{idVendor}=="303a", ATTRS{idProduct}=="1001"',
].join('\n');

suite('tool manifest', () => {

	test('every pinned archive is https from an allowed host, has a vendor SHA-256, and a bin folder inside its archive root', () => {
		const platforms: PlatformId[] = ['linux-x64', 'linux-arm64', 'darwin-x64', 'darwin-arm64', 'win32-x64'];
		for (const id of Object.keys(TOOL_MANIFEST) as ToolId[]) {
			for (const p of platforms) {
				const spec = archiveFor(id, p);
				assert.ok(spec, `${id} ${p}`);
				assert.strictEqual(validateArchiveSpec(spec), undefined, `${id} ${p}`);
				assert.ok(spec.size > 1_000_000, `${id} ${p} size`);
				assert.strictEqual(spec.format, p === 'win32-x64' ? 'zip' : 'tar.gz');
			}
		}
		assert.strictEqual(archiveFor('xpack-openocd', 'linux-x64')?.sha256, '94b3790983beaf8ed57e646c0620dd66d705fddae03d290823a6ed3b439468d6');
		assert.strictEqual(archiveFor('openocd-esp32', 'linux-x64')?.onPath, false, 'Espressif openocd would shadow upstream openocd');
	});

	test('validateArchiveSpec refuses http, unknown hosts, bad hashes and escaping bin folders', () => {
		const good = archiveFor('xpack-openocd', 'linux-x64')!;
		assert.match(validateArchiveSpec({ ...good, url: good.url.replace('https', 'http') }) ?? '', /not https/);
		assert.match(validateArchiveSpec({ ...good, url: 'https://evil.example/openocd.tgz' }) ?? '', /not an allowed download host/);
		assert.match(validateArchiveSpec({ ...good, sha256: 'abc' }) ?? '', /SHA-256/);
		assert.match(validateArchiveSpec({ ...good, binDir: '../../bin' }) ?? '', /binDir/);
		assert.ok(ALLOWED_DOWNLOAD_HOSTS.includes('release-assets.githubusercontent.com'));
	});
});

suite('udev rules parsing', () => {

	test('reads vendor:product pairs from continued lines and ignores comments', () => {
		assert.deepStrictEqual([...usbIdsInUdevRules(STLINK_RULES)], ['0483:3748']);
		assert.deepStrictEqual([...usbIdsInUdevRules('ATTR{idVendor}=="303A", ATTR{idProduct}=="1001", MODE="666"')], ['303a:1001']);
	});

	test('every probe has USB ids and an OpenOCD interface script', () => {
		for (const p of Object.values(PROBES)) {
			assert.ok(p.usbIds.length && p.usbIds.every(id => /^[0-9a-f]{4}:[0-9a-f]{4}$/.test(id)), p.id);
			assert.match(p.openocdInterface, /^interface\/.+\.cfg$/);
		}
	});
});

suite('udev grants (per file, access-granting rules only)', () => {

	test('grep dumps join continuations within each file, never across files', () => {
		const dump = [
			'/lib/udev/rules.d/49-a.rules:SUBSYSTEMS=="usb", ATTRS{idVendor}=="0483", ATTRS{idProduct}=="374b", \\',
			'/lib/udev/rules.d/49-a.rules:    MODE="660", TAG+="uaccess"',
			'/lib/udev/rules.d/49-a.rules:SUBSYSTEMS=="usb", ATTRS{idVendor}=="0483", ATTRS{idProduct}=="3752", \\',
			'/lib/udev/rules.d/49-a.rules:    MODE="660"',
			'/lib/udev/rules.d/50-b.rules:ATTRS{idVendor}=="1366", ATTRS{idProduct}=="0101", ENV{ID_MM_DEVICE_IGNORE}="1"',
			'/lib/udev/rules.d/60-c.rules:ATTRS{idVendor}=="0d28", ATTRS{idProduct}=="0204|0205", MODE="666"',
			'/lib/udev/rules.d/60-c.rules:ATTRS{product}=="*CMSIS-DAP*", MODE="660", GROUP="plugdev", TAG+="uaccess"',
		].join('\n');
		const g = grantsInGrepDump(dump);
		assert.deepStrictEqual([...g.ids].sort(), ['0483:374b', '0483:3752', '0d28:0204', '0d28:0205']);
		assert.strictEqual(probeCovered(PROBES['jlink'], g), false, 'a rule without MODE/GROUP/uaccess grants nothing');
		assert.strictEqual(probeCovered(PROBES['cmsis-dap'], { ids: new Set(), products: ['*CMSIS-DAP*'] }), true);
		// A rule limited to the probe's hidraw side does not grant the USB device.
		assert.strictEqual(grantsInGrepDump('/lib/udev/rules.d/99-jlink.rules:KERNEL=="hidraw*", ATTRS{idVendor}=="0d28", ATTRS{idProduct}=="0204", MODE="666"').ids.size, 0);
	});

	test('a program that fails --version (e.g. missing shared libraries) does not count as found', async () => {
		const host = new StoreHost();
		host.onExec = () => ({ exitCode: 127, stderr: 'arm-none-eabi-gdb: error while loading shared libraries: libncursesw.so.5' });
		const status = await debugRequirements()[1].check({ host, platform: 'linux-x64', os: 'linux' });
		assert.strictEqual(status.ok, false);
	});
});

suite('debug dependencies', () => {

	const ctx = (host: FakeHost, platform: PlatformId | undefined = 'linux-x64') => ({ host, platform, os: 'linux' as const });

	test('a program on PATH is found with its version; Espressif OpenOCD must say "esp32"', async () => {
		const host = new StoreHost();
		machine(host, { present: { 'openocd': 'Open On-Chip Debugger 0.11.0', 'gdb-multiarch': 'GNU gdb (Ubuntu 12.1) 12.1' } });
		const [ocd, gdb] = debugRequirements();
		assert.deepStrictEqual(await ocd.check(ctx(host)), { id: 'openocd', label: 'OpenOCD', ok: true, detail: '/discovered/bin/openocd on PATH', command: '/discovered/bin/openocd', version: 'Open On-Chip Debugger 0.11.0', source: 'path', remedy: 'none' });
		assert.strictEqual((await gdb.check(ctx(host))).command, '/discovered/bin/gdb-multiarch');

		const [espOcd] = debugRequirements({ target: new DefaultTargetCatalog().resolve('esp32s3')! });
		const status = await espOcd.check(ctx(host));
		assert.deepStrictEqual([status.ok, status.remedy], [false, 'user-space'], 'upstream openocd must not count as the ESP32 one');
		// …and the ESP32 lookup leaves the tool store off PATH, so xPack's openocd cannot hide an ESP-IDF one.
		assert.deepStrictEqual(host.commands.filter(c => c.command === 'openocd').map(c => !!c.noToolStorePath), [false, true]);
		// An Espressif OpenOCD on the system PATH is reported by absolute path, resolved without the store.
		host.onExec = (command, args) => command === 'openocd' && args[0] === '--version' ? { stdout: 'Open On-Chip Debugger v0.12.0-esp32-20260703\n' } : { exitCode: 127, spawnError: 'ENOENT' };
		const searches: { name: string; systemOnly?: boolean }[] = [];
		host.system!.findProgram = async (name, options) => {
			searches.push({ name, ...options?.systemOnly ? { systemOnly: true } : {} });
			return '/found/esp-idf/openocd-esp32/bin/openocd';
		};
		const esp = await espOcd.check(ctx(host));
		assert.deepStrictEqual([esp.ok, esp.command], [true, '/found/esp-idf/openocd-esp32/bin/openocd']);
		assert.deepStrictEqual(searches, [{ name: 'openocd', systemOnly: true }]);
	});

	test('missing tools are installable in user space when the store has a pinned archive, else manual', async () => {
		const host = new StoreHost();
		machine(host, {});
		const [ocd] = debugRequirements();
		assert.strictEqual((await ocd.check(ctx(host))).remedy, 'user-space');
		const noStore = new FakeHost();
		machine(noStore, {});
		const manual = await ocd.check(ctx(noStore, undefined));
		assert.deepStrictEqual([manual.remedy, /xpack-dev-tools/.test(manual.manualStep ?? '')], ['manual', true]);
	});

	test('ensureUserSpace downloads only what is missing and then finds it in the tool store', async () => {
		const host = new StoreHost();
		const store = host.toolStore;
		machine(host, { present: { 'gdb-multiarch': 'GNU gdb 12.1' }, rules: STLINK_RULES });
		host.onExec = ((inner) => (command, args, options) => command.startsWith('/store/') && args[0] === '--version' ? { stdout: 'Open On-Chip Debugger 0.12.0+dev (xPack)\n' } : inner(command, args, options))(host.onExec);
		const report = await new DependencyResolver(host).ensureUserSpace(debugRequirements());
		assert.deepStrictEqual(store.installs.map(s => `${s.id}@${s.version}`), ['xpack-openocd@0.12.0-7']);
		assert.strictEqual(report.ok, true);
		assert.deepStrictEqual(report.statuses.map(s => [s.id, s.source]), [['openocd', 'tool-store'], ['gdb', 'path'], ['probe-usb-access', undefined]]);
		assert.strictEqual(report.statuses[0].command, '/store/xpack-openocd/0.12.0-7/xpack-openocd-0.12.0-7/bin/openocd');
		assert.deepStrictEqual(report.installed.map(i => [i.id, i.action]), [['openocd', 'downloaded']]);
	});

	test('USB access: ST-Link rules present → ok; ESP probes missing → needs a system step', async () => {
		const host = new StoreHost();
		machine(host, { rules: STLINK_RULES });
		assert.strictEqual((await new ProbeAccessDependency(['stlink']).check(ctx(host))).ok, true);
		const esp = await new ProbeAccessDependency(['esp-usb-jtag', 'esp-prog']).check(ctx(host));
		assert.deepStrictEqual([esp.ok, esp.remedy], [false, 'system']);
		assert.match(esp.detail, /USB-Serial-JTAG.*ESP-PROG/);
	});

	const RULES = 'SUBSYSTEMS=="usb", ATTRS{idVendor}=="303a", ATTRS{idProduct}=="1001", MODE="666"\n';
	const rulesSource = { tool: 'xpack-openocd', version: '0.12.0-7', path: 'contrib/60-openocd.rules', sha256: createHash('sha256').update(RULES).digest('hex') };

	async function storeWithRules(host: StoreHost, content = RULES) {
		await host.toolStore.install(archiveFor('xpack-openocd', 'linux-x64')!);
		host.toolStore.fileContents.set('xpack-openocd@0.12.0-7/contrib/60-openocd.rules', content);
	}

	test('without passwordless sudo nothing runs as root and the user gets the exact, quoted command', async () => {
		const host = new StoreHost();
		await storeWithRules(host);
		machine(host, { rules: STLINK_RULES });
		const refused = await new ProbeAccessDependency(['esp-usb-jtag'], [rulesSource]).installSystem(ctx(host), {});
		assert.deepStrictEqual([refused.ok, refused.action], [false, 'needs-user']);
		assert.strictEqual(refused.userCommand, `echo '${rulesSource.sha256}  /store/xpack-openocd/0.12.0-7/contrib/60-openocd.rules' | sha256sum -c - && sudo install -m 0644 -- /store/xpack-openocd/0.12.0-7/contrib/60-openocd.rules /udev-admin/rules.d/60-roboagent-openocd.rules && sudo udevadm control --reload-rules && sudo udevadm trigger`);
		assert.ok(!host.commands.some(c => c.command.endsWith('pkexec')), 'pkexec only when allowed');
	});

	test('with passwordless sudo the verified rules go to root over stdin, by absolute paths, into our own file', async () => {
		const host = new StoreHost();
		await storeWithRules(host);
		let written = '';
		machine(host, { rules: STLINK_RULES, sudo: true });
		const inner = host.onExec;
		host.onExec = (command, args, options) => {
			if (command === `${SBIN}/sudo` && args[2] === `${SBIN}/tee`) {
				written = options.input ?? '';
				host.system!.ruleFiles = [...host.system!.ruleFiles, { file: `${ADMIN_RULES}/60-roboagent-openocd.rules`, content: written }];
			}
			return inner(command, args, options);
		};
		const done = await new ProbeAccessDependency(['esp-usb-jtag'], [rulesSource]).installSystem(ctx(host), {});
		assert.deepStrictEqual([done.ok, done.action, written], [true, 'system-change', RULES]);
		assert.deepStrictEqual(host.commands.filter(c => c.command === `${SBIN}/sudo`).map(c => c.args.join(' ')), [
			`-n -- ${SBIN}/tee ${ADMIN_RULES}/60-roboagent-openocd.rules`,
			`-n -- ${SBIN}/chmod 0644 ${ADMIN_RULES}/60-roboagent-openocd.rules`,
			`-n -- ${SBIN}/udevadm control --reload-rules`,
			`-n -- ${SBIN}/udevadm trigger --subsystem-match=usb`,
		]);
	});

	test('tampered rules (hash mismatch) or rules with RUN/PROGRAM keys are never installed', async () => {
		for (const content of ['SUBSYSTEMS=="usb", RUN+="/bin/sh -c id"\n', RULES + 'ACTION=="add", PROGRAM="/tmp/x"\n']) {
			const host = new StoreHost();
			await storeWithRules(host, content);
			machine(host, { sudo: true });
			const pinned = content.includes('PROGRAM') ? { ...rulesSource, sha256: createHash('sha256').update(content).digest('hex') } : rulesSource;
			const r = await new ProbeAccessDependency(['esp-usb-jtag'], [pinned]).installSystem(ctx(host), {});
			assert.deepStrictEqual([r.ok, /do not match the pinned file/.test(r.detail)], [false, true], content);
			assert.ok(!host.commands.some(c => c.args.includes(`${SBIN}/tee`)), 'nothing written as root');
		}
	});

	test('pkexec is used only when the host allows the desktop password dialog', async () => {
		const host = new StoreHost();
		await storeWithRules(host);
		machine(host, { pkexec: true });
		await new ProbeAccessDependency(['esp-usb-jtag'], [rulesSource]).installSystem(ctx(host), { allowGraphicalPrompt: true });
		assert.ok(host.commands.some(c => c.command === `${SBIN}/pkexec` && c.args[0] === `${SBIN}/tee`));
	});

	test('the default rules sources are the pinned OpenOCD files from the manifest', async () => {
		const host = new StoreHost();
		await host.toolStore.install(archiveFor('xpack-openocd', 'linux-x64')!);
		host.toolStore.fileContents.set('xpack-openocd@0.12.0-7/xpack-openocd-0.12.0-7/openocd/contrib/60-openocd.rules', 'not the vendor file');
		machine(host, { sudo: true });
		const r = await new ProbeAccessDependency(['esp-usb-jtag']).installSystem(ctx(host), {});
		assert.match(r.detail, /do not match the pinned file/);
	});

	test('serial access: dialout membership, and the usermod command when root is not available', async () => {
		const host = new StoreHost();
		machine(host, { groups: 'mohamed dialout plugdev' });
		assert.strictEqual((await new SerialAccessDependency().check(ctx(host))).ok, true);
		machine(host, { groups: 'mohamed' });
		const dep = new SerialAccessDependency();
		assert.deepStrictEqual([(await dep.check(ctx(host))).remedy], ['system']);
		assert.strictEqual((await dep.installSystem(ctx(host), {})).userCommand, 'sudo usermod -aG dialout mohamed');
		// After usermod: the group database has it, the running session not yet → ok, with a re-login note.
		machine(host, { groups: 'mohamed', dbGroups: 'mohamed dialout' });
		const after = await dep.check(ctx(host));
		assert.deepStrictEqual([after.ok, after.remedy, /Log out/.test(after.pending ?? '')], [true, 'none', true]);
	});

	test('ESP32 requirements pick the chip\'s GDB and both ESP probes', () => {
		const c = new DefaultTargetCatalog();
		const s3 = debugRequirements({ target: c.resolve('esp32s3')! });
		const c3 = debugRequirements({ target: c.resolve('esp32c3')! });
		assert.deepStrictEqual(s3.map(d => d.id), ['openocd-esp32', 'gdb', 'probe-usb-access', 'serial-port-access']);
		assert.strictEqual((s3[1] as ExecutableDependency).archive, 'xtensa-esp-elf-gdb');
		assert.strictEqual((c3[1] as ExecutableDependency).archive, 'riscv32-esp-elf-gdb');
		assert.match(s3[2].label, /USB-Serial-JTAG.*ESP-PROG/);
	});
});

suite('debug setup tools', () => {

	class SetupAgent extends Agent {
		protected readonly profile: AgentProfile = { id: 'fw-debug', systemPrompt: '' };
		constructor(llm: ILlmClient, host: FakeHost) {
			const registry = new ToolRegistry();
			createDebugSetupTools().forEach(t => registry.register(t));
			super(llm, registry, host);
		}
	}

	test('check is read-only; ensure is an "install" approval; probe access is a "system" approval', async () => {
		const host = new StoreHost();
		machine(host, { rules: STLINK_RULES, groups: 'mohamed' });
		const llm = new ScriptedFakeLlm([
			callTool('c', 'check_debug_tools', { part: 'STM32F103C8T6' }),
			callTool('e', 'ensure_debug_tools', { part: 'STM32F103C8T6' }),
			callTool('p', 'install_probe_access', { part: 'esp32s3' }),
			say('done'),
		]);
		await new SetupAgent(llm, host).run('set up debugging');
		assert.deepStrictEqual(host.approvals.map(a => [a.toolName, a.category]), [['ensure_debug_tools', 'install'], ['install_probe_access', 'system']]);
		assert.match(host.approvals[0].summary, /^For STM32F103C8T6: download xPack OpenOCD .* 0\.12\.0-7 \(3 MB\); xPack GNU Arm Embedded GCC .* 15\.2\.1-1\.1 \(307 MB\) into \/store/);
		assert.match(host.approvals[1].summary, /^For esp32s3, as root: write OpenOCD's udev rules \(xpack-openocd 0\.12\.0-7, after checking their pinned SHA-256\) to \/udev-admin\/rules.d\/60-roboagent-openocd.rules and reload udev; add mohamed to the dialout group/);
		const checked = JSON.parse((llm.requests[1].messages.find(m => m.role === 'tool') as { content: string }).content);
		assert.deepStrictEqual([checked.target, checked.ok, checked.statuses.map((s: { id: string }) => s.id)], ['STM32F103C8T6', false, ['openocd', 'gdb', 'probe-usb-access']]);
		assert.match(checked.next, /ensure_debug_tools can download OpenOCD, GDB for Arm Cortex-M/);
	});

	test('approval summaries follow the target detected from dir (ESP32 project → ESP tools, usermod)', async () => {
		const host = new StoreHost();
		host.fs.files.set('fw/CMakeLists.txt', 'include($ENV{IDF_PATH}/tools/cmake/project.cmake)\n');
		host.fs.files.set('fw/sdkconfig', 'CONFIG_IDF_TARGET="esp32s3"\n');
		machine(host, { groups: 'mohamed' });
		const llm = new ScriptedFakeLlm([callTool('e', 'ensure_debug_tools', { dir: 'fw' }), callTool('p', 'install_probe_access', { dir: 'fw' }), say('ok')]);
		await new SetupAgent(llm, host).run('x');
		assert.match(host.approvals[0].summary, /^For esp32s3: download Espressif OpenOCD for ESP32 .*; Espressif GDB for Xtensa/);
		assert.ok(!/Arm/.test(host.approvals[0].summary));
		assert.match(host.approvals[1].summary, /add mohamed to the dialout group/);
	});

	test('installs are approved automatically by default; "ask" sends them to the user; root steps always ask', async () => {
		const base = { agentId: 'a', toolName: 'ensure_debug_tools', risk: 'write' as const, summary: 's', input: {} };
		const asked: string[] = [];
		const byDefault = new NodeAgentHost({ root: '.', write: () => { }, approve: async r => { asked.push(r.category); return false; } });
		assert.deepStrictEqual([await byDefault.approve({ ...base, category: 'install' }), await byDefault.approve({ ...base, category: 'system' })], [true, false]);
		const askHost = new NodeAgentHost({ root: '.', installPolicy: 'ask', write: () => { }, approve: async r => { asked.push(r.category); return false; } });
		assert.strictEqual(await askHost.approve({ ...base, category: 'install' }), false);
		assert.deepStrictEqual(asked, ['system', 'install']);
		// Without any approve callback (unattended), installs still run and everything else is denied.
		const unattended = new NodeAgentHost({ root: '.', write: () => { } });
		assert.deepStrictEqual([await unattended.approve({ ...base, category: 'install' }), await unattended.approve({ ...base, category: 'hardware', risk: 'hardware' })], [true, false]);
		// Only the two pinned-download tools are covered; any other tool claiming "install" still asks.
		assert.strictEqual(await unattended.approve({ ...base, toolName: 'some_new_tool', category: 'install' }), false);
	});

	test('$ROBOAGENT_INSTALL_POLICY opts out: "ask" asks, a typo also asks, unset means auto', async () => {
		const base = { agentId: 'a', toolName: 'ensure_debug_tools', risk: 'write' as const, category: 'install' as const, summary: 's', input: {} };
		const host = (value?: string) => new NodeAgentHost({ root: '.', env: value === undefined ? {} : { ROBOAGENT_INSTALL_POLICY: value }, write: () => { } });
		assert.deepStrictEqual([
			await host().approve(base), await host('auto').approve(base), await host('ask').approve(base), await host('ASK').approve(base), await host('aut0').approve(base),
		], [true, true, false, false, false]);
		assert.deepStrictEqual([installPolicyFromEnv(undefined), installPolicyFromEnv(''), installPolicyFromEnv(' Auto '), installPolicyFromEnv('no')], ['auto', 'auto', 'auto', 'ask']);
	});

	test('the "auto" install policy approves installs without asking, but never root steps', async () => {
		const asked: string[] = [];
		const host = new NodeAgentHost({ root: '.', installPolicy: 'auto', write: () => { }, approve: async r => { asked.push(r.category); return false; } });
		const base = { agentId: 'a', toolName: 'ensure_debug_tools', risk: 'write' as const, summary: 's', input: {} };
		assert.deepStrictEqual([
			await host.approve({ ...base, category: 'install' }),
			await host.approve({ ...base, category: 'system' }),
			await host.approve({ ...base, category: 'edit' }),
		], [true, false, false]);
		assert.deepStrictEqual(asked, ['system', 'edit']);
	});
});
