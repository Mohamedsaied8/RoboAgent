/*---------------------------------------------------------------------------------------------
 *  Copyright (c) RoboAgent. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Emitter, Event } from '../../../../base/common/event.js';
import { Disposable, toDisposable } from '../../../../base/common/lifecycle.js';
import { ProxyChannel } from '../../../../base/parts/ipc/common/ipc.js';
import { localize } from '../../../../nls.js';
import { IMainProcessService } from '../../../../platform/ipc/common/mainProcessService.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { IRoboAgentAuthMainService, IRoboAgentAuthSession } from '../../../../platform/roboagentAuth/common/roboagentAuthService.js';
import { IWorkbenchContribution } from '../../../common/contributions.js';
import { AuthenticationSession, AuthenticationSessionsChangeEvent, IAuthenticationProvider, IAuthenticationProviderSessionOptions, IAuthenticationService } from '../../../services/authentication/common/authentication.js';

/** Provider id extensions pass to `vscode.authentication.getSession(...)`. */
export const ROBOAGENT_AUTH_PROVIDER_ID = 'roboagent';

/**
 * Exposes the main-process RoboAgent (Supabase) session to extensions through
 * the standard `vscode.authentication` API.
 *
 * Why not a command: a workbench command such as `roboagent.getAccessToken`
 * can be executed by ANY installed extension, which would hand the user's
 * access token to whoever asks. Going through the authentication service lets
 * the workbench enforce access instead: extensions listed under
 * `trustedExtensionAuthAccess.roboagent` in product.json (the built-in chat
 * extension) get the session silently, every other extension triggers the
 * usual "allow X to access your RoboAgent account?" consent prompt, and the
 * user can revoke that access from the Accounts menu.
 *
 * Tokens are never cached here: `getSessions` asks the main process each
 * time, which refreshes the short-lived access token as needed.
 */
export class RoboAgentAuthenticationProvider extends Disposable implements IWorkbenchContribution, IAuthenticationProvider {

	static readonly ID = 'roboagent.authenticationProvider';

	readonly id = ROBOAGENT_AUTH_PROVIDER_ID;
	readonly label = 'RoboAgent';
	readonly supportsMultipleAccounts = false;

	private readonly _onDidChangeSessions = this._register(new Emitter<AuthenticationSessionsChangeEvent>());
	readonly onDidChangeSessions: Event<AuthenticationSessionsChangeEvent> = this._onDidChangeSessions.event;

	private readonly authService: IRoboAgentAuthMainService;
	/** The session handed out last, so a sign-out can report what was removed. */
	private lastSession: AuthenticationSession | undefined;

	constructor(
		@IMainProcessService mainProcessService: IMainProcessService,
		@IAuthenticationService authenticationService: IAuthenticationService,
		@ILogService private readonly logService: ILogService,
	) {
		super();
		this.authService = ProxyChannel.toService<IRoboAgentAuthMainService>(mainProcessService.getChannel('roboagentAuth'));

		if (authenticationService.isAuthenticationProviderRegistered(this.id)) {
			this.logService.warn(`RoboAgentAuthenticationProvider: a provider with id '${this.id}' is already registered, not registering the built-in one`);
			return;
		}
		if (!authenticationService.declaredProviders.some(p => p.id === this.id)) {
			authenticationService.registerDeclaredAuthenticationProvider({ id: this.id, label: this.label });
		}
		authenticationService.registerAuthenticationProvider(this.id, this);
		this._register(toDisposable(() => authenticationService.unregisterAuthenticationProvider(this.id)));

		this._register(this.authService.onDidChangeSession(session => this.onDidChangeMainSession(session)));
	}

	async getSessions(_scopes: string[] | undefined, options: IAuthenticationProviderSessionOptions): Promise<readonly AuthenticationSession[]> {
		const session = await this.authService.getSession();
		if (!session.isSignedIn) {
			return [];
		}
		if (options.account && session.userId && options.account.id !== session.userId) {
			return [];
		}
		// Refreshed by the main process when missing or near expiry; undefined
		// means the refresh failed (offline, revoked), which reads as "no
		// usable session" rather than handing out a stale token.
		const accessToken = await this.authService.getAccessToken();
		if (!accessToken) {
			return [];
		}
		this.lastSession = this.toAuthenticationSession(session, accessToken);
		return [this.lastSession];
	}

	async createSession(): Promise<AuthenticationSession> {
		// Runs the browser (PKCE) sign-in; rejects on abort or timeout.
		await this.authService.signIn();
		const sessions = await this.getSessions(undefined, {});
		if (!sessions.length) {
			throw new Error(localize('roboagent.auth.noSession', "Signing in to RoboAgent did not produce a session."));
		}
		return sessions[0];
	}

	async removeSession(_sessionId: string): Promise<void> {
		await this.authService.signOut();
	}

	private toAuthenticationSession(session: IRoboAgentAuthSession, accessToken: string): AuthenticationSession {
		const userId = session.userId ?? 'roboagent';
		return {
			id: `roboagent/${userId}`,
			accessToken,
			account: {
				id: userId,
				label: session.email ?? session.displayName ?? localize('roboagent.auth.accountLabel', "RoboAgent user"),
			},
			scopes: [],
		};
	}

	private async onDidChangeMainSession(session: IRoboAgentAuthSession): Promise<void> {
		if (!session.isSignedIn) {
			const removed = this.lastSession;
			this.lastSession = undefined;
			this._onDidChangeSessions.fire({ added: [], removed: removed ? [removed] : [], changed: [] });
			return;
		}
		const accessToken = await this.authService.getAccessToken();
		if (!accessToken || this._store.isDisposed) {
			return;
		}
		const previous = this.lastSession;
		this.lastSession = this.toAuthenticationSession(session, accessToken);
		this._onDidChangeSessions.fire(previous
			? { added: [], removed: [], changed: [this.lastSession] }
			: { added: [this.lastSession], removed: [], changed: [] });
	}
}
