/*---------------------------------------------------------------------------------------------
 *  Copyright (c) RoboAgent. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { IAgentHost } from '../../kernel/host';
import { TargetDescriptor } from '../target';
import { svdSpecFor } from './svdManifest';
import { parseSvd, SvdDevice, SvdError } from './svdParser';

/** Larger than any vendor SVD we know of (the biggest STM32 ones are ~3 MB). */
const MAX_SVD_BYTES = 16 * 1024 * 1024;

/** Port: register descriptions for a target. */
export interface ISvdProvider {
	/**
	 * The device description: from `workspacePath` when given (a project's own SVD), otherwise the
	 * pinned SVD for the part from the tool store. Throws {@link SvdError} when there is none.
	 */
	load(host: IAgentHost, target: TargetDescriptor, workspacePath?: string): Promise<SvdDevice>;
}

/** Loads and parses SVD files once per source (parsing a 2 MB SVD takes ~0.1 s). */
export class DefaultSvdProvider implements ISvdProvider {
	private readonly cache = new Map<string, Promise<SvdDevice>>();

	load(host: IAgentHost, target: TargetDescriptor, workspacePath?: string): Promise<SvdDevice> {
		if (workspacePath) {
			// Workspace files can change; never cache them.
			return host.fs.readFile(workspacePath).then(text => this.parse(text, workspacePath));
		}
		const spec = target.vendor === 'stm32' ? svdSpecFor(target.part) : undefined;
		if (!spec) {
			return Promise.reject(new SvdError(`No pinned SVD for ${target.part}; pass the path of the part's .svd file in the workspace.`));
		}
		const key = `${spec.id}@${spec.version}`;
		let loading = this.cache.get(key);
		if (!loading) {
			loading = (async () => {
				const store = host.toolStore;
				if (!store || !await store.find(spec.id, spec.version)) {
					throw new SvdError(`The SVD for ${target.part} (${spec.fileName}) is not downloaded yet: run ensure_debug_tools, or pass the path of an .svd file in the workspace.`);
				}
				return this.parse(await store.readFile(spec.id, spec.version, `${spec.binDir}/${spec.fileName}`, MAX_SVD_BYTES), spec.fileName!);
			})();
			this.cache.set(key, loading);
			loading.catch(() => this.cache.delete(key));
		}
		return loading;
	}

	private parse(text: string, source: string): SvdDevice {
		try {
			return parseSvd(text);
		} catch (err) {
			throw new SvdError(`${source}: ${err instanceof Error ? err.message : String(err)}`);
		}
	}
}
