/*---------------------------------------------------------------------------------------------
 *  Copyright (c) RoboAgent. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/*---------------------------------------------------------------------------------------------
 *  Pinned tool archives. Every SHA-256 here is the vendor's published value, never one computed
 *  from our own download (captured 2026-10-15):
 *  - xPack OpenOCD / Arm GCC: the `.sha` file next to each GitHub release asset;
 *  - Espressif openocd-esp32 / GDBs: ESP-IDF v6.1 `tools/tools.json` ("recommended" versions).
 *  To update: bump the version, copy URL, size and hash from those sources, run the tests.
 *--------------------------------------------------------------------------------------------*/

import { ArchiveSpec, PlatformId } from '../kernel/host';

export type ToolId = 'xpack-openocd' | 'xpack-arm-none-eabi-gcc' | 'openocd-esp32' | 'xtensa-esp-elf-gdb' | 'riscv32-esp-elf-gdb';

/** A file inside a pinned archive, with the SHA-256 of its content (computed from the vendor-verified archive). */
export interface PinnedFile {
	readonly path: string;
	readonly sha256: string;
}

export interface PinnedTool {
	readonly id: ToolId;
	readonly version: string;
	readonly vendor: string;
	readonly onPath: boolean;
	/** Files of interest inside the install, relative to the archive root. */
	readonly files?: { readonly udevRules?: PinnedFile; readonly scripts?: string };
	readonly platforms: Partial<Readonly<Record<PlatformId, Omit<ArchiveSpec, 'id' | 'version' | 'onPath'>>>>;
}

/** Hosts downloads may come from (GitHub release assets redirect to release-assets.*). */
export const ALLOWED_DOWNLOAD_HOSTS: readonly string[] = [
	'github.com',
	'objects.githubusercontent.com',
	'release-assets.githubusercontent.com',
	'dl.espressif.com',
	'developer.arm.com',
];

const XPACK_OCD = 'https://github.com/xpack-dev-tools/openocd-xpack/releases/download/v0.12.0-7/xpack-openocd-0.12.0-7';
const XPACK_GCC = 'https://github.com/xpack-dev-tools/arm-none-eabi-gcc-xpack/releases/download/v15.2.1-1.1/xpack-arm-none-eabi-gcc-15.2.1-1.1';
const ESP_OCD = 'https://github.com/espressif/openocd-esp32/releases/download/v0.12.0-esp32-20260703/openocd-esp32';
const ESP_GDB = 'https://github.com/espressif/binutils-gdb/releases/download/esp-gdb-v17.1_20260402';

export const TOOL_MANIFEST: Readonly<Record<ToolId, PinnedTool>> = {
	'xpack-openocd': {
		id: 'xpack-openocd',
		version: '0.12.0-7',
		vendor: 'xPack OpenOCD (upstream OpenOCD with bundled libusb)',
		onPath: true,
		files: {
			udevRules: { path: 'xpack-openocd-0.12.0-7/openocd/contrib/60-openocd.rules', sha256: 'd5f11ef4aab987a4505e8321772df66e2b2bdd3d200f3b2535f86d2e2dbf847c' },
			scripts: 'xpack-openocd-0.12.0-7/openocd/scripts',
		},
		platforms: {
			'linux-x64': { url: `${XPACK_OCD}-linux-x64.tar.gz`, sha256: '94b3790983beaf8ed57e646c0620dd66d705fddae03d290823a6ed3b439468d6', size: 2802056, format: 'tar.gz', binDir: 'xpack-openocd-0.12.0-7/bin' },
			'linux-arm64': { url: `${XPACK_OCD}-linux-arm64.tar.gz`, sha256: 'db73a3ab91c556ecec2405a7e02d404b11139df6aba1031cad94a7e6766d06cc', size: 2736149, format: 'tar.gz', binDir: 'xpack-openocd-0.12.0-7/bin' },
			'darwin-x64': { url: `${XPACK_OCD}-darwin-x64.tar.gz`, sha256: '668ad25350103a4357e11629ec833eae5982e973889ce25bad0c2963e37fa8bf', size: 2481762, format: 'tar.gz', binDir: 'xpack-openocd-0.12.0-7/bin' },
			'darwin-arm64': { url: `${XPACK_OCD}-darwin-arm64.tar.gz`, sha256: '667342c086984f3e5a55b4e0d5f711add13fb04de040fca493303000e6c19327', size: 2385815, format: 'tar.gz', binDir: 'xpack-openocd-0.12.0-7/bin' },
			'win32-x64': { url: `${XPACK_OCD}-win32-x64.zip`, sha256: '6bfd3c97135aafef8affc9af1acf34fd0e2b9ca26044506f6abd7f95b7630052', size: 3225998, format: 'zip', binDir: 'xpack-openocd-0.12.0-7/bin' },
		},
	},
	'xpack-arm-none-eabi-gcc': {
		id: 'xpack-arm-none-eabi-gcc',
		version: '15.2.1-1.1',
		vendor: 'xPack GNU Arm Embedded GCC (includes arm-none-eabi-gdb)',
		onPath: true,
		platforms: {
			'linux-x64': { url: `${XPACK_GCC}-linux-x64.tar.gz`, sha256: 'da6a49ad4003944b823c6c93702a8787c922ab34bd7e918ec0eaf6933a9b1ff6', size: 307090703, format: 'tar.gz', binDir: 'xpack-arm-none-eabi-gcc-15.2.1-1.1/bin' },
			'linux-arm64': { url: `${XPACK_GCC}-linux-arm64.tar.gz`, sha256: '67980c7990eba7bb7ffdf39699102effd70889f5ac427be19a8c8a6c5fab2972', size: 302624714, format: 'tar.gz', binDir: 'xpack-arm-none-eabi-gcc-15.2.1-1.1/bin' },
			'darwin-x64': { url: `${XPACK_GCC}-darwin-x64.tar.gz`, sha256: '5be906a5194c3173e145a58048e5607ffff947773237802b93e55e23c415f1b6', size: 298312329, format: 'tar.gz', binDir: 'xpack-arm-none-eabi-gcc-15.2.1-1.1/bin' },
			'darwin-arm64': { url: `${XPACK_GCC}-darwin-arm64.tar.gz`, sha256: '574082d35e49a2bcbdc355836b2a3ae5e5bb3b9456c9f5e37177db2ab4aad870', size: 293820200, format: 'tar.gz', binDir: 'xpack-arm-none-eabi-gcc-15.2.1-1.1/bin' },
			'win32-x64': { url: `${XPACK_GCC}-win32-x64.zip`, sha256: 'bae6a3d1667697ce750c3b13d6d26d80973ecedc2cc87bf04869e83447fd93ea', size: 335571206, format: 'zip', binDir: 'xpack-arm-none-eabi-gcc-15.2.1-1.1/bin' },
		},
	},
	'openocd-esp32': {
		id: 'openocd-esp32',
		version: 'v0.12.0-esp32-20260703',
		vendor: 'Espressif OpenOCD for ESP32',
		// Its binary is also called `openocd`: used by absolute path, never put on PATH.
		onPath: false,
		files: {
			udevRules: { path: 'openocd-esp32/share/openocd/contrib/60-openocd.rules', sha256: 'f6aebec5d7b7ed15bdd5465d0039c4e45ebe7a3f7960965783af942223202b8e' },
			scripts: 'openocd-esp32/share/openocd/scripts',
		},
		platforms: {
			'linux-x64': { url: `${ESP_OCD}-linux-amd64-0.12.0-esp32-20260703.tar.gz`, sha256: '4b71d1b4d8e4025029466e780161262a04137348b68e965c15250dbeebef03ce', size: 2700256, format: 'tar.gz', binDir: 'openocd-esp32/bin' },
			'linux-arm64': { url: `${ESP_OCD}-linux-arm64-0.12.0-esp32-20260703.tar.gz`, sha256: '3ce059a26a543e96b19bef15a29b850aadaff1d4e2dc291e8c1ab45e331a5f1c', size: 2641141, format: 'tar.gz', binDir: 'openocd-esp32/bin' },
			'darwin-x64': { url: `${ESP_OCD}-macos-0.12.0-esp32-20260703.tar.gz`, sha256: '489daa179ecde646ebf1d2288c96d398f1b8b620ac7487b7c57c3bc45cef0202', size: 2893284, format: 'tar.gz', binDir: 'openocd-esp32/bin' },
			'darwin-arm64': { url: `${ESP_OCD}-macos-arm64-0.12.0-esp32-20260703.tar.gz`, sha256: 'fe366c8b72fc287fbdf5d62a1178dd882c37dc4a5c29205f126a6c3125aa9f41', size: 2694457, format: 'tar.gz', binDir: 'openocd-esp32/bin' },
			'win32-x64': { url: `${ESP_OCD}-win64-0.12.0-esp32-20260703.zip`, sha256: 'a49147705e49be9cab4af473e58b5730d99a0220d10f0976a04bf725cd0aa960', size: 3290643, format: 'zip', binDir: 'openocd-esp32/bin' },
		},
	},
	'xtensa-esp-elf-gdb': {
		id: 'xtensa-esp-elf-gdb',
		version: '17.1_20260402',
		vendor: 'Espressif GDB for Xtensa (ESP32, ESP32-S2, ESP32-S3)',
		onPath: true,
		platforms: {
			'linux-x64': { url: `${ESP_GDB}/xtensa-esp-elf-gdb-17.1_20260402-x86_64-linux-gnu.tar.gz`, sha256: '73bc6c4e50b06dceb60e94b53aded61b7769be3cf563572269d9c8d643db8e95', size: 42655871, format: 'tar.gz', binDir: 'xtensa-esp-elf-gdb/bin' },
			'linux-arm64': { url: `${ESP_GDB}/xtensa-esp-elf-gdb-17.1_20260402-aarch64-linux-gnu.tar.gz`, sha256: '00290ffe21b2916ffd343fd28ac34fc8b93e99b992a3656fa09b4f2bdc564bea', size: 41589296, format: 'tar.gz', binDir: 'xtensa-esp-elf-gdb/bin' },
			'darwin-x64': { url: `${ESP_GDB}/xtensa-esp-elf-gdb-17.1_20260402-x86_64-apple-darwin24.5.tar.gz`, sha256: '706d58849fd4a83244023051605b3631e835565395fa2783ed5afce1f17413ee', size: 53815837, format: 'tar.gz', binDir: 'xtensa-esp-elf-gdb/bin' },
			'darwin-arm64': { url: `${ESP_GDB}/xtensa-esp-elf-gdb-17.1_20260402-aarch64-apple-darwin24.5.tar.gz`, sha256: 'da97440e74a9ff36370bdb598cf421a8183c11ae6fb44431be594ad16dbe77ef', size: 46924973, format: 'tar.gz', binDir: 'xtensa-esp-elf-gdb/bin' },
			'win32-x64': { url: `${ESP_GDB}/xtensa-esp-elf-gdb-17.1_20260402-x86_64-w64-mingw32.zip`, sha256: '7525ae46b39fc87568717d8f0cc3dfbcdb77b96435dd80acfce6918b0abc2b8a', size: 44820924, format: 'zip', binDir: 'xtensa-esp-elf-gdb/bin' },
		},
	},
	'riscv32-esp-elf-gdb': {
		id: 'riscv32-esp-elf-gdb',
		version: '17.1_20260402',
		vendor: 'Espressif GDB for RISC-V (ESP32-C3, -C6, -H2)',
		onPath: true,
		platforms: {
			'linux-x64': { url: `${ESP_GDB}/riscv32-esp-elf-gdb-17.1_20260402-x86_64-linux-gnu.tar.gz`, sha256: '35f3db841338cb4f9bc60d757bc3e87dfa50ff50607bcbc3867c5b1ac28dd342', size: 43045928, format: 'tar.gz', binDir: 'riscv32-esp-elf-gdb/bin' },
			'linux-arm64': { url: `${ESP_GDB}/riscv32-esp-elf-gdb-17.1_20260402-aarch64-linux-gnu.tar.gz`, sha256: 'f185d924497750f254290a32c48163c08e3b2a29eb248d739d90990ebee17f44', size: 42035040, format: 'tar.gz', binDir: 'riscv32-esp-elf-gdb/bin' },
			'darwin-x64': { url: `${ESP_GDB}/riscv32-esp-elf-gdb-17.1_20260402-x86_64-apple-darwin24.5.tar.gz`, sha256: '4845ec4968207e40c9f840f29007d8e0cd7d11eb613bb9e9078a41bb0ceb6d4d', size: 54514283, format: 'tar.gz', binDir: 'riscv32-esp-elf-gdb/bin' },
			'darwin-arm64': { url: `${ESP_GDB}/riscv32-esp-elf-gdb-17.1_20260402-aarch64-apple-darwin24.5.tar.gz`, sha256: 'f944bb6a07b03e5d74dd1f878ba05320ee7957d3a06bcc80cd0a9cf355e8ceea', size: 47663426, format: 'tar.gz', binDir: 'riscv32-esp-elf-gdb/bin' },
			'win32-x64': { url: `${ESP_GDB}/riscv32-esp-elf-gdb-17.1_20260402-x86_64-w64-mingw32.zip`, sha256: 'f9e56a0d17414a30f7c457f7804173ecfb078b90d94a7b9f6318dc9652575d3f', size: 45474783, format: 'zip', binDir: 'riscv32-esp-elf-gdb/bin' },
		},
	},
};

/** The archive for `id` on `platform`, ready for {@link IToolStore.install}; undefined when not pinned. */
export function archiveFor(id: ToolId, platform: PlatformId | undefined): ArchiveSpec | undefined {
	const tool = TOOL_MANIFEST[id];
	const p = platform && tool.platforms[platform];
	return p ? { ...p, id: tool.id, version: tool.version, onPath: tool.onPath } : undefined;
}

/** A tool id or version usable as one folder name: starts with a letter/digit, no `..`, no separators. */
export function isSafeToolName(name: string): boolean {
	return /^[A-Za-z0-9][\w.+-]{0,99}$/.test(name) && !name.includes('..');
}

/** Checks a spec before any network access: https, allowlisted host, sane hash and paths. */
export function validateArchiveSpec(spec: ArchiveSpec, allowedHosts: readonly string[] = ALLOWED_DOWNLOAD_HOSTS): string | undefined {
	let url: URL;
	try {
		url = new URL(spec.url);
	} catch {
		return `invalid URL ${spec.url}`;
	}
	if (url.protocol !== 'https:') {
		return `${spec.url} is not https`;
	}
	if (!allowedHosts.includes(url.hostname)) {
		return `${url.hostname} is not an allowed download host`;
	}
	if (!/^[0-9a-f]{64}$/.test(spec.sha256)) {
		return `invalid SHA-256 for ${spec.id}`;
	}
	if (!isSafeToolName(spec.id) || !isSafeToolName(spec.version)) {
		return `invalid tool id or version "${spec.id}@${spec.version}"`;
	}
	if (spec.binDir.startsWith('/') || spec.binDir.split('/').includes('..')) {
		return `invalid binDir ${spec.binDir}`;
	}
	return undefined;
}
