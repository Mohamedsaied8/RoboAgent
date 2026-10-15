/*---------------------------------------------------------------------------------------------
 *  Copyright (c) RoboAgent. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as assert from 'assert';
import { createHash } from 'crypto';
import { promises as fs } from 'fs';
import * as os from 'os';
import * as path from 'path';
import { NodeToolStore } from '../adapters/node/nodeToolStore';
import { validateArchiveSpec } from '../install/manifest';
import { comparePeripheral, decodeRegister, fieldValue, readableRegister } from '../embedded/svd/peripheralDecoder';
import { SVD_COMMIT, svdSpecFor } from '../embedded/svd/svdManifest';
import { findPeripheral, parseSvd, parseSvdNumber, SvdError } from '../embedded/svd/svdParser';
import { DefaultSvdProvider } from '../embedded/svd/svdProvider';
import { parseXml, XmlError } from '../embedded/svd/xml';
import { DefaultTargetCatalog } from '../embedded/target';
import { FakeHost } from './fakeHost';

const SVD = `<?xml version="1.0" encoding="utf-8"?>
<!-- vendor comment -->
<device schemaVersion="1.1">
  <name>TESTCHIP</name>
  <size>32</size>
  <access>read-write</access>
  <resetValue>0x00000000</resetValue>
  <peripherals>
    <peripheral>
      <name>TIM1</name>
      <description>Advanced &amp; general timer</description>
      <baseAddress>0x40012C00</baseAddress>
      <registers>
        <register>
          <name>CR1</name>
          <addressOffset>0x00</addressOffset>
          <resetValue>0x0000</resetValue>
          <size>16</size>
          <fields>
            <field><name>CEN</name><bitOffset>0</bitOffset><bitWidth>1</bitWidth>
              <enumeratedValues>
                <enumeratedValue><name>Disabled</name><value>0</value></enumeratedValue>
                <enumeratedValue><name>Enabled</name><value>1</value></enumeratedValue>
              </enumeratedValues>
            </field>
            <field><name>CKD</name><bitRange>[9:8]</bitRange></field>
            <field><name>DIR</name><lsb>4</lsb><msb>4</msb></field>
          </fields>
        </register>
        <register>
          <dim>4</dim><dimIncrement>4</dimIncrement><dimIndex>1-4</dimIndex>
          <name>CCR%s</name>
          <addressOffset>0x34</addressOffset>
          <fields><field><name>CCR</name><bitOffset>0</bitOffset><bitWidth>16</bitWidth></field></fields>
        </register>
        <register derivedFrom="CR1">
          <name>CR1_ALIAS</name>
          <addressOffset>0x80</addressOffset>
        </register>
        <register>
          <name>DR</name><addressOffset>0x4C</addressOffset>
        </register>
        <register>
          <name>SR</name><addressOffset>0x10</addressOffset><readAction>clear</readAction>
        </register>
        <cluster>
          <dim>2</dim><dimIncrement>0x10</dimIncrement>
          <name>CH[%s]</name>
          <addressOffset>0x100</addressOffset>
          <register><name>CFG</name><addressOffset>0x4</addressOffset><access>write-only</access></register>
          <register><name>VAL</name><addressOffset>0x8</addressOffset>
            <fields><field><name>FULL</name><bitOffset>0</bitOffset><bitWidth>32</bitWidth></field></fields>
          </register>
        </cluster>
      </registers>
    </peripheral>
    <peripheral derivedFrom="TIM1">
      <name>TIM8</name>
      <baseAddress>0x40013400</baseAddress>
    </peripheral>
  </peripherals>
</device>`;

suite('SVD', () => {

	test('parses fields (bitOffset, bitRange, lsb/msb), enums, dim lists, clusters, derivedFrom, readAction and inherited properties', () => {
		const device = parseSvd(SVD);
		const tim1 = findPeripheral(device, 'tim1')!;
		assert.deepStrictEqual([device.name, tim1.description, device.peripherals.map(p => p.name)], ['TESTCHIP', 'Advanced & general timer', ['TIM1', 'TIM8']]);
		assert.deepStrictEqual(tim1.registers.map(r => `${r.name}@${r.offset.toString(16)}/${r.size}${r.access ? `/${r.access}` : ''}${r.readAction ? '/!' : ''}`), [
			'CR1@0/16/read-write', 'CCR1@34/32/read-write', 'CCR2@38/32/read-write', 'CCR3@3c/32/read-write', 'CCR4@40/32/read-write',
			'CR1_ALIAS@80/32/read-write', 'DR@4c/32/read-write', 'SR@10/32/read-write/!',
			'CH0.CFG@104/32/write-only', 'CH0.VAL@108/32/read-write', 'CH1.CFG@114/32/write-only', 'CH1.VAL@118/32/read-write',
		]);
		const cr1 = tim1.registers[0];
		assert.deepStrictEqual(cr1.fields.map(f => [f.name, f.bitOffset, f.bitWidth]), [['CEN', 0, 1], ['CKD', 8, 2], ['DIR', 4, 1]]);
		assert.deepStrictEqual(tim1.registers.find(r => r.name === 'CR1_ALIAS')!.fields.map(f => f.name), ['CEN', 'CKD', 'DIR']);
		const tim8 = findPeripheral(device, 'TIM8')!;
		assert.deepStrictEqual([tim8.baseAddress, tim8.registers.length, tim8.description], [0x40013400, tim1.registers.length, 'Advanced & general timer']);
	});

	test('decodes values with enum names and changes from reset; refuses to read side-effect and write-only registers', () => {
		const tim1 = findPeripheral(parseSvd(SVD), 'TIM1')!;
		const cr1 = decodeRegister(tim1, tim1.registers[0], 0x0201);
		assert.deepStrictEqual(cr1, {
			name: 'CR1', address: '0x40012C00', value: '0x0201',
			fields: [{ name: 'CEN', bits: '[0]', value: 1, meaning: 'Enabled' }, { name: 'CKD', bits: '[9:8]', value: 2 }, { name: 'DIR', bits: '[4]', value: 0 }],
			changedFromReset: ['CEN', 'CKD'],
		});
		const full = tim1.registers.find(r => r.name === 'CH0.VAL')!;
		assert.strictEqual(fieldValue(full.fields[0], 0xFFFFFFFF), 0xFFFFFFFF);
		assert.deepStrictEqual(tim1.registers.map(r => [r.name, readableRegister(r).ok]).filter(([, ok]) => !ok).map(([n]) => n), ['DR', 'SR', 'CH0.CFG', 'CH1.CFG']);
		const before = { name: 'TIM1', baseAddress: '0x40012C00', registers: [decodeRegister(tim1, tim1.registers[0], 0)], skipped: [] };
		const after = { ...before, registers: [cr1] };
		assert.deepStrictEqual(comparePeripheral(before, after), [{ register: 'CR1', field: 'CEN', before: 0, after: 1 }, { register: 'CR1', field: 'CKD', before: 0, after: 2 }]);
	});

	test('numbers: hex, decimal, #binary with don\'t-care bits; garbage is undefined', () => {
		assert.deepStrictEqual(['0x1F', '42', '#1x01', '0b101', 'abc', ''].map(parseSvdNumber), [31, 42, 9, 5, undefined, undefined]);
	});

	test('the XML reader refuses DTDs (no entity expansion or external entities) and absurd nesting', () => {
		assert.throws(() => parseXml('<!DOCTYPE d [<!ENTITY x SYSTEM "file:///etc/passwd">]><device>&x;</device>'), XmlError);
		assert.throws(() => parseXml(`${'<a>'.repeat(100)}${'</a>'.repeat(100)}`), /nesting too deep/);
		assert.throws(() => parseXml('<a><b></a>'), XmlError);
		assert.throws(() => parseSvd('<html></html>'), SvdError);
		assert.strictEqual(parseXml('<a x="1 &lt; 2"><![CDATA[<raw>]]> &#x41;&#66;</a>').text, '<raw> AB');
	});

	test('a malformed dim drops only that element; letter dimIndex ranges work; derived peripherals merge registers', () => {
		const huge = parseSvd(SVD.replace('<dim>4</dim>', '<dim>100000</dim>'));
		assert.deepStrictEqual([findPeripheral(huge, 'TIM1')!.registers.some(r => r.name.startsWith('CCR')), huge.skipped], [false, ['CCR%s: dim 100000 out of range']]);
		const letters = parseSvd(SVD.replace('<dimIndex>1-4</dimIndex>', '<dimIndex>A-D</dimIndex>'));
		assert.deepStrictEqual(findPeripheral(letters, 'TIM1')!.registers.filter(r => r.name.startsWith('CCR')).map(r => r.name), ['CCRA', 'CCRB', 'CCRC', 'CCRD']);
		const merged = parseSvd(SVD.replace('<baseAddress>0x40013400</baseAddress>', '<baseAddress>0x40013400</baseAddress><registers><register><name>BDTR</name><addressOffset>0x44</addressOffset></register><register><name>CR1</name><addressOffset>0x00</addressOffset><size>32</size></register></registers>'));
		const tim8 = findPeripheral(merged, 'TIM8')!;
		assert.deepStrictEqual([tim8.registers.length, tim8.registers.find(r => r.name === 'CR1')!.size, tim8.registers.at(-1)!.name], [findPeripheral(merged, 'TIM1')!.registers.length + 1, 32, 'CR1']);
	});

	test('hostile expansion is bounded: nested dims and deep clusters fail fast instead of exhausting memory', () => {
		const fields = Array.from({ length: 50 }, (_, k) => `<field><dim>1024</dim><dimIncrement>0</dimIncrement><name>F${k}_%s</name><bitOffset>0</bitOffset></field>`).join('');
		const bomb = `<device><name>X</name><peripherals><peripheral><name>P</name><baseAddress>0</baseAddress><registers><register><dim>1024</dim><dimIncrement>4</dimIncrement><name>R%s</name><addressOffset>0</addressOffset><fields>${fields}</fields></register></registers></peripheral></peripherals></device>`;
		const started = Date.now();
		assert.throws(() => parseSvd(bomb), /expands to more than/);
		const cluster = (inner: string) => `<cluster><dim>1024</dim><dimIncrement>4</dimIncrement><name>C%s</name><addressOffset>0</addressOffset>${inner}</cluster>`;
		assert.throws(() => parseSvd(`<device><name>X</name><peripherals><peripheral><name>P</name><baseAddress>0</baseAddress><registers>${cluster(cluster(cluster('')))}</registers></peripheral></peripherals></device>`), /expands to more than/);
		let deep = '<register><name>R</name><addressOffset>0</addressOffset></register>';
		for (let k = 0; k < 10; k++) {
			deep = `<cluster><name>C${k}</name><addressOffset>0</addressOffset>${deep}</cluster>`;
		}
		assert.throws(() => parseSvd(`<device><name>X</name><peripherals><peripheral><name>P</name><baseAddress>0</baseAddress><registers>${deep}</registers></peripheral></peripherals></device>`), /nested deeper than 8/);
		assert.ok(Date.now() - started < 2000, `took ${Date.now() - started} ms`);
	});

	test('raw.githubusercontent.com is allowed only for the pinned SVD repository commit', () => {
		const spec = svdSpecFor('STM32F103C8T6')!;
		assert.strictEqual(validateArchiveSpec(spec), undefined);
		for (const url of ['https://raw.githubusercontent.com/attacker/repo/main/x.svd', `https://raw.githubusercontent.com/cmsis-svd/cmsis-svd-data/main/data/STMicro/x.svd`]) {
			assert.match(validateArchiveSpec({ ...spec, url })!, /not in the pinned SVD repository commit/, url);
		}
	});

	test('cycles are refused', () => {
		const cyclic = '<device><name>X</name><peripherals><peripheral derivedFrom="B"><name>A</name><baseAddress>0</baseAddress></peripheral><peripheral derivedFrom="A"><name>B</name><baseAddress>4</baseAddress></peripheral></peripherals></device>';
		assert.throws(() => parseSvd(cyclic), /cycle/);
	});

	test('pinned SVDs: every spec is valid; parts map to their files; unknown parts have none', () => {
		const catalog = new DefaultTargetCatalog();
		const parts = ['STM32F103C8T6', 'STM32F103RBT6', 'STM32F401RET6', 'STM32F407VGT6', 'STM32F411CEU6', 'STM32F446RET6', 'STM32G431KBT6', 'STM32L476RGT6', 'STM32F429ZIT6'];
		const specs = parts.map(p => svdSpecFor(catalog.resolve(p)!.part)!);
		assert.deepStrictEqual(specs.map(s => s.fileName), ['STM32F103xx.svd', 'STM32F103xx.svd', 'STM32F401.svd', 'STM32F407.svd', 'STM32F411.svd', 'STM32F446.svd', 'STM32G431xx.svd', 'STM32L4x6.svd', 'STM32F429.svd']);
		assert.deepStrictEqual(specs.map(s => validateArchiveSpec(s)).filter(Boolean), []);
		assert.strictEqual(svdSpecFor('STM32H743ZIT6'), undefined);
	});

	test('the provider reads a workspace SVD, or explains how to get the pinned one', async () => {
		const host = new FakeHost();
		host.fs.files.set('fw/chip.svd', SVD);
		const provider = new DefaultSvdProvider();
		const target = new DefaultTargetCatalog().resolve('STM32F103C8T6')!;
		assert.strictEqual((await provider.load(host, target, 'fw/chip.svd')).name, 'TESTCHIP');
		await assert.rejects(provider.load(host, target), /not downloaded yet: run ensure_debug_tools/);
		await assert.rejects(provider.load(host, new DefaultTargetCatalog().resolve('STM32H743ZIT6')!), /No pinned SVD/);
	});
});

suite('NodeToolStore single-file installs (SVD)', function () {

	this.timeout(30_000);
	let tmp: string;

	setup(async () => {
		tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'fwagents-svd-'));
	});

	teardown(async () => {
		await fs.rm(tmp, { recursive: true, force: true });
	});

	function storeServing(body: Buffer): NodeToolStore {
		const fetchImpl = (async (url: string) => {
			const response = new Response(new Uint8Array(body), { status: 200 });
			Object.defineProperty(response, 'url', { value: url });
			return response;
		}) as typeof fetch;
		return new NodeToolStore({ root: path.join(tmp, 'store'), fetchImpl, platform: 'linux-x64' });
	}

	function specFor(content: Buffer, overrides: { sha256?: string; gitBlobSha1?: string } = {}) {
		return {
			id: 'svd-TESTCHIP', version: 'c65f8551e57c', url: `https://raw.githubusercontent.com/cmsis-svd/cmsis-svd-data/${SVD_COMMIT}/data/X/TESTCHIP.svd`,
			sha256: overrides.sha256 ?? createHash('sha256').update(content).digest('hex'),
			gitBlobSha1: overrides.gitBlobSha1 ?? createHash('sha1').update(`blob ${content.length}\0`).update(content).digest('hex'),
			size: content.length, format: 'file' as const, fileName: 'TESTCHIP.svd', binDir: 'svd', onPath: false,
		};
	}

	test('installs a verified file and reads it back; it never goes on PATH', async () => {
		const content = Buffer.from(SVD);
		const store = storeServing(content);
		const spec = specFor(content);
		const installed = await store.install(spec);
		assert.strictEqual(await store.readFile(spec.id, spec.version, 'svd/TESTCHIP.svd'), SVD);
		assert.deepStrictEqual([installed.onPath, await store.binPaths()], [false, []]);
	});

	test('refuses content whose git blob id or SHA-256 does not match, and installs nothing', async () => {
		const content = Buffer.from(SVD);
		const store = storeServing(content);
		await assert.rejects(store.install(specFor(content, { gitBlobSha1: '0'.repeat(40) })), /Git blob id .* does not match/);
		await assert.rejects(store.install(specFor(content, { sha256: 'f'.repeat(64) })), /SHA-256 .* does not match/);
		assert.deepStrictEqual(await store.installed(), []);
	});

	test('a file name that could leave the install folder is refused before any download', async () => {
		const content = Buffer.from(SVD);
		const store = storeServing(content);
		await assert.rejects(store.install({ ...specFor(content), fileName: '../evil.svd' }), /invalid file name/);
	});
});
