/*---------------------------------------------------------------------------------------------
 *  Copyright (c) RoboAgent. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// The RoboAgent account UI. It talks to the main-process auth service (IRoboAgentAuthService,
// registered by platform/roboagentAuth/electron-browser), so it exists in the desktop builds only.

import '../../../../platform/roboagentAuth/electron-browser/roboagentAuthService.js';
import { registerWorkbenchContribution2, WorkbenchPhase } from '../../../common/contributions.js';
import { registerAuthActions } from '../browser/roboagentAuthCommands.js';
import { RoboAgentAuthStatusBar } from '../browser/roboagentAuthStatusBar.js';
import { RoboAgentAuthenticationProviderContribution } from '../browser/roboagentAuthenticationProvider.js';

registerAuthActions();

registerWorkbenchContribution2(RoboAgentAuthStatusBar.ID, RoboAgentAuthStatusBar, WorkbenchPhase.AfterRestored);

// The `roboagent` authentication provider: the account's token for extensions (e.g. AI chat).
registerWorkbenchContribution2(RoboAgentAuthenticationProviderContribution.ID, RoboAgentAuthenticationProviderContribution, WorkbenchPhase.BlockRestore);
