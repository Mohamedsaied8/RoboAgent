/*---------------------------------------------------------------------------------------------
 *  Copyright (c) RoboAgent. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { registerMainProcessRemoteService } from '../../ipc/electron-browser/services.js';
import { IRoboAgentAuthService } from '../common/roboagentAuthService.js';

// The channel is registered by the main process in app.ts (IRoboAgentAuthMainService).
registerMainProcessRemoteService(IRoboAgentAuthService, 'roboagentAuth');
