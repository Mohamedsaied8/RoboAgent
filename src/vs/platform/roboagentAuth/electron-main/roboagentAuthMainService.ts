/*---------------------------------------------------------------------------------------------
 *  Copyright (c) RoboAgent. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { ILogService } from '../../log/common/log.js';
import { IProductService } from '../../product/common/productService.js';
import { IRoboAgentAuthMainService } from '../common/roboagentAuthService.js';
import { IFileService } from '../../files/common/files.js';
import { IEncryptionMainService } from '../../encryption/common/encryptionService.js';
import { IEnvironmentMainService } from '../../environment/electron-main/environmentMainService.js';
import { INativeHostMainService } from '../../native/electron-main/nativeHostMainService.js';
import { AuthStorageService } from './storage.js';
import { AuthExchangeService } from './exchange.js';
import { RoboAgentAuthSession } from './authSession.js';

/** The account session (`authSession.ts`) wired to the main process services. */
export class RoboAgentAuthMainService extends RoboAgentAuthSession implements IRoboAgentAuthMainService {
	public readonly _serviceBrand: undefined;

	constructor(
		@ILogService logService: ILogService,
		@IProductService productService: IProductService,
		@IFileService fileService: IFileService,
		@IEncryptionMainService encryptionService: IEncryptionMainService,
		@IEnvironmentMainService environmentService: IEnvironmentMainService,
		@INativeHostMainService nativeHostService: INativeHostMainService
	) {
		const anonKey = productService.supabaseAnonKey || '';
		super({
			logService,
			anonKey,
			urlProtocol: productService.urlProtocol,
			storage: new AuthStorageService(environmentService.userDataPath, fileService, encryptionService, logService),
			exchange: new AuthExchangeService(anonKey, logService),
			openExternal: url => nativeHostService.openExternal(undefined, url),
		});
	}
}
