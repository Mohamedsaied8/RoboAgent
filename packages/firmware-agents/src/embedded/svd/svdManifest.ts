/*---------------------------------------------------------------------------------------------
 *  Copyright (c) RoboAgent. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/*---------------------------------------------------------------------------------------------
 *  Pinned SVD files from github.com/cmsis-svd/cmsis-svd-data at one commit. Each entry carries
 *  the git blob id from the repository's own tree listing (independent of our download) and the
 *  SHA-256 of the content that matched it (captured 2026-10-15); the tool store checks both.
 *--------------------------------------------------------------------------------------------*/

import { ArchiveSpec } from '../../kernel/host';

export const SVD_COMMIT = 'c65f8551e57c770344d229dcaa0bf838fa29aff4';

interface PinnedSvd {
	/** STM32 part-number prefixes it covers, e.g. `STM32F103`. */
	readonly parts: readonly string[];
	readonly file: string;
	readonly gitBlobSha1: string;
	readonly sha256: string;
	readonly size: number;
}

const PINNED: readonly PinnedSvd[] = [
	{ parts: ['STM32F072'], file: 'STM32F072x.svd', gitBlobSha1: '5b2a8538bca17b096274362d23d7c7e70bf3a492', sha256: 'bb0cad0349ecec817277dadbfb45697041dd8d01cef06e546bbdc9ee0d70c148', size: 1107490 },
	{ parts: ['STM32F103'], file: 'STM32F103xx.svd', gitBlobSha1: '1348869b31213a955ed35ae5cbc2ff9da924132f', sha256: '1d92b65aaf397a18a599fb6a840812015ad379cdcc0cc3687f673f63e7445367', size: 867312 },
	{ parts: ['STM32F303'], file: 'STM32F303.svd', gitBlobSha1: '7bc602c2585415b1110d1441c44801ef840c2e23', sha256: '9497d238de0f3da1a4cd77e1ac9d7f273cf43bfa576a076be7a02620438e0f77', size: 1414185 },
	{ parts: ['STM32F401'], file: 'STM32F401.svd', gitBlobSha1: '4ed46659f64f696cd303761706a5e3e24c811234', sha256: '7cbcddfc76b0d8c022a999ad39a5b464147aa3ad69130b8350b4f315979c3d80', size: 956970 },
	{ parts: ['STM32F405', 'STM32F415'], file: 'STM32F405.svd', gitBlobSha1: 'ceb8c5224a0315a6296bc92a383ad8f8c1ab6012', sha256: '261c70ebbeb17bc982abc7d3c8e257b78e5a89457ddf2d9655bf2f2502f95134', size: 2164865 },
	{ parts: ['STM32F407', 'STM32F417'], file: 'STM32F407.svd', gitBlobSha1: 'e6d25f36c3ef668fdfc95c4fb3d4d1933d64eaad', sha256: 'e2afca4f03f654225886d8508551cb7ac8f3c95ee28f18953aad466ecb56e6d6', size: 2164866 },
	{ parts: ['STM32F411'], file: 'STM32F411.svd', gitBlobSha1: '80e32632e5ad1706266f28a9897fd50526fdf5c5', sha256: 'e89450855e4ff2c8dde8684f910e2d0857e463ec5718793dd2fe5d9e757cd317', size: 957569 },
	{ parts: ['STM32F429', 'STM32F439'], file: 'STM32F429.svd', gitBlobSha1: 'fb4f5d4aeab29afe81fab0eb99c2d06effe813f4', sha256: '7b14d8a1d20c0924078059f1c51fb85082f279589a69d30e7b9fdead1bf8343d', size: 2224325 },
	{ parts: ['STM32F446'], file: 'STM32F446.svd', gitBlobSha1: '1f2a5f944936741b2637be3d57b8e09950d00d77', sha256: '962f478d38d6f4a934b800dd565505231bf51b794d658cf6de99476c09e8b3c4', size: 2023820 },
	{ parts: ['STM32G431'], file: 'STM32G431xx.svd', gitBlobSha1: '1faa964528944311850d591ae7b733ed991ce75c', sha256: 'ed8450599ea16593da001c1142be4d0f6afdf9c871397e0e7f2d6879047542a4', size: 1779829 },
	{ parts: ['STM32G474'], file: 'STM32G474xx.svd', gitBlobSha1: '1654303696943933b81385e585d6c42cddf7058d', sha256: 'acdd6403c3dd30bbebe9067b79ef21a8d5568cd701881eee99be861a1661f078', size: 2792162 },
	{ parts: ['STM32L476', 'STM32L486', 'STM32L496', 'STM32L4A6'], file: 'STM32L4x6.svd', gitBlobSha1: '1ff6915a73a31da6889cf8962bed5e0313810b21', sha256: '0af45ef6d1f9d8a72f945b0c72dd92f89135e9aab66182226b5fc127f4fcb750', size: 2173065 },
];

/** Tool-store version of every pinned SVD (the commit, shortened). */
export const SVD_VERSION = SVD_COMMIT.slice(0, 12);

/** The pinned SVD for an STM32 part, as a single-file tool-store spec; undefined when none is pinned. */
export function svdSpecFor(part: string): ArchiveSpec | undefined {
	const upper = part.toUpperCase();
	const pinned = PINNED.find(p => p.parts.some(prefix => upper.startsWith(prefix)));
	if (!pinned) {
		return undefined;
	}
	return {
		id: `svd-${pinned.file.replace(/\.svd$/, '')}`,
		version: SVD_VERSION,
		url: `https://raw.githubusercontent.com/cmsis-svd/cmsis-svd-data/${SVD_COMMIT}/data/STMicro/${pinned.file}`,
		sha256: pinned.sha256,
		gitBlobSha1: pinned.gitBlobSha1,
		size: pinned.size,
		format: 'file',
		fileName: pinned.file,
		binDir: 'svd',
		onPath: false,
	};
}
