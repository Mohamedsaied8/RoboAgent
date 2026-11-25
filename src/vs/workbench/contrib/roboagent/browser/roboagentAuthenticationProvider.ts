/*---------------------------------------------------------------------------------------------
 *  Copyright (c) RoboAgent. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/*---------------------------------------------------------------------------------------------
 *  RoboAgent — the `roboagent` authentication provider.
 *
 *  Exposes the Robotics Corner account (signed in by the main-process RoboAgentAuthMainService)
 *  to extensions through `vscode.authentication.getSession('roboagent', [])`. The session's
 *  access token is the account's Supabase access token, which RoboAgent services (the AI chat
 *  gateway) accept as `Authorization: Bearer <token>`. Tokens are fetched from the main process
 *  on every `getSessions` call, so extensions always get a refreshed one.
 *--------------------------------------------------------------------------------------------*/

import { Emitter } from '../../../../base/common/event.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { ProxyChannel } from '../../../../base/parts/ipc/common/ipc.js';
import { localize } from '../../../../nls.js';
import { IMainProcessService } from '../../../../platform/ipc/common/mainProcessService.js';
import { IRoboAgentAuthMainService, IRoboAgentAuthSession } from '../../../../platform/roboagentAuth/common/roboagentAuthService.js';
import { IWorkbenchContribution } from '../../../common/contributions.js';
import { AuthenticationSession, AuthenticationSessionsChangeEvent, IAuthenticationProvider, IAuthenticationService } from '../../../services/authentication/common/authentication.js';

export const ROBOAGENT_AUTH_PROVIDER_ID = 'roboagent';

class RoboAgentAuthenticationProvider extends Disposable implements IAuthenticationProvider {

	readonly id = ROBOAGENT_AUTH_PROVIDER_ID;
	readonly label = localize('roboagent.auth.providerLabel', "RoboAgent");
	readonly supportsMultipleAccounts = false;

	private readonly _onDidChangeSessions = this._register(new Emitter<AuthenticationSessionsChangeEvent>());
	readonly onDidChangeSessions = this._onDidChangeSessions.event;

	private lastSession: AuthenticationSession | undefined;

	constructor(private readonly authService: IRoboAgentAuthMainService) {
		super();
		this._register(authService.onDidChangeSession(session => this.onDidChangeAccount(session)));
	}

	async getSessions(): Promise<readonly AuthenticationSession[]> {
		const session = await this.currentSession();
		return session ? [session] : [];
	}

	async createSession(): Promise<AuthenticationSession> {
		await this.authService.signIn();
		const session = await this.currentSession();
		if (!session) {
			throw new Error(localize('roboagent.auth.signInFailed', "Signing in to RoboAgent did not produce a session."));
		}
		return session;
	}

	async removeSession(): Promise<void> {
		await this.authService.signOut();
	}

	private async currentSession(): Promise<AuthenticationSession | undefined> {
		const account = await this.authService.getSession();
		if (!account.isSignedIn || !account.userId) {
			return undefined;
		}
		const accessToken = await this.authService.getAccessToken();
		if (!accessToken) {
			return undefined;
		}
		return {
			id: account.userId,
			accessToken,
			account: { id: account.userId, label: account.email || account.displayName || account.userId },
			scopes: [],
		};
	}

	private async onDidChangeAccount(account: IRoboAgentAuthSession): Promise<void> {
		const previous = this.lastSession;
		const current = account.isSignedIn ? await this.currentSession() : undefined;
		this.lastSession = current;
		if (previous && !current) {
			this._onDidChangeSessions.fire({ added: [], removed: [previous], changed: [] });
		} else if (!previous && current) {
			this._onDidChangeSessions.fire({ added: [current], removed: [], changed: [] });
		} else if (previous && current) {
			this._onDidChangeSessions.fire({ added: [], removed: [], changed: [current] });
		}
	}
}

export class RoboAgentAuthenticationProviderContribution extends Disposable implements IWorkbenchContribution {

	static readonly ID = 'roboagent.authenticationProvider';

	constructor(
		@IAuthenticationService authenticationService: IAuthenticationService,
		@IMainProcessService mainProcessService: IMainProcessService,
	) {
		super();
		const authService = ProxyChannel.toService<IRoboAgentAuthMainService>(mainProcessService.getChannel('roboagentAuth'));
		const provider = this._register(new RoboAgentAuthenticationProvider(authService));
		authenticationService.registerDeclaredAuthenticationProvider({ id: provider.id, label: provider.label });
		authenticationService.registerAuthenticationProvider(provider.id, provider);
		this._register({
			dispose: () => {
				authenticationService.unregisterAuthenticationProvider(provider.id);
				authenticationService.unregisterDeclaredAuthenticationProvider(provider.id);
			}
		});
	}
}
