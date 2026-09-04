/*---------------------------------------------------------------------------------------------
 *  Copyright (c) RoboAgent. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as assert from 'assert';
import { cpuFlags, familyIdFromPartNumber, getPart, isPlausiblePartNumber, resolveTarget, STM32_FAMILIES, STM32_PARTS } from '../modes/stm32/mcuDatabase';

suite('STM32 MCU database', () => {

	test('every catalog part belongs to a known family and has sane sizes', () => {
		for (const p of STM32_PARTS) {
			assert.ok(STM32_FAMILIES.some(f => f.id === p.family), `${p.name}: family ${p.family}`);
			assert.ok(p.flashKb > 0 && p.ramKb > 0, p.name);
			assert.strictEqual(familyIdFromPartNumber(p.name), p.family, p.name);
			assert.ok(isPlausiblePartNumber(p.name), p.name);
		}
		assert.ok(STM32_PARTS.length >= 30);
	});

	test('family prefix parsing', () => {
		assert.strictEqual(familyIdFromPartNumber('STM32F407VGT6'), 'F4');
		assert.strictEqual(familyIdFromPartNumber('stm32g474ret6'), 'G4');
		assert.strictEqual(familyIdFromPartNumber('STM32WB55RGV6'), 'WB');
		assert.strictEqual(familyIdFromPartNumber('STM32H7A3ZIT6'), 'H7');
		assert.strictEqual(familyIdFromPartNumber('ATSAMD21'), undefined);
	});

	test('core flags: M4 hard-float single precision, M7 double, M0 soft', () => {
		assert.deepStrictEqual(cpuFlags(resolveTarget('STM32F407VGT6')), ['-mcpu=cortex-m4', '-mthumb', '-mfpu=fpv4-sp-d16', '-mfloat-abi=hard']);
		assert.deepStrictEqual(cpuFlags(resolveTarget('STM32H743ZIT6')), ['-mcpu=cortex-m7', '-mthumb', '-mfpu=fpv5-d16', '-mfloat-abi=hard']);
		assert.deepStrictEqual(cpuFlags(resolveTarget('STM32F030F4P6')), ['-mcpu=cortex-m0', '-mthumb', '-mfloat-abi=soft']);
		assert.deepStrictEqual(cpuFlags(resolveTarget('STM32G071RBT6')), ['-mcpu=cortex-m0plus', '-mthumb', '-mfloat-abi=soft']);
		assert.deepStrictEqual(cpuFlags(resolveTarget('STM32U575ZIT6')), ['-mcpu=cortex-m33', '-mthumb', '-mfpu=fpv5-sp-d16', '-mfloat-abi=hard']);
	});

	test('per-part FPU override (F746 has a single-precision FPU)', () => {
		assert.strictEqual(resolveTarget('STM32F746ZGT6').flags.mfpu, 'fpv5-sp-d16');
		assert.strictEqual(resolveTarget('STM32F767ZIT6').flags.mfpu, 'fpv5-d16');
	});

	test('catalog part resolves exactly', () => {
		const t = resolveTarget('stm32l476rgt6');
		assert.strictEqual(t.exact, true);
		assert.strictEqual(t.part, 'STM32L476RGT6');
		assert.strictEqual(t.define, 'STM32L476xx');
		assert.strictEqual(t.family.openocdTarget, 'stm32l4x');
		assert.strictEqual(t.flashKb, 1024);
		assert.ok(getPart('STM32L476RGT6'));
	});

	test('free-text part of a known family: family core, default sizes, guessed define', () => {
		const t = resolveTarget('STM32F412ZGT6');
		assert.strictEqual(t.exact, false);
		assert.strictEqual(t.core, 'cortex-m4');
		assert.strictEqual(t.family.id, 'F4');
		assert.strictEqual(t.define, 'STM32F412xx');
		assert.strictEqual(t.flashKb, 256);
	});

	test('unknown family falls back to a buildable Cortex-M4 soft-float target', () => {
		const t = resolveTarget('STM32MP157CAA3');
		assert.strictEqual(t.exact, false);
		assert.strictEqual(t.family.id, '??');
		assert.deepStrictEqual(cpuFlags(t), ['-mcpu=cortex-m4', '-mthumb', '-mfloat-abi=soft']);
	});

	test('plausibility check for free text', () => {
		assert.ok(isPlausiblePartNumber('STM32F103C8T6'));
		assert.ok(isPlausiblePartNumber('stm32g0b1re'));
		assert.ok(!isPlausiblePartNumber('F103'));
		assert.ok(!isPlausiblePartNumber('STM32'));
	});
});
