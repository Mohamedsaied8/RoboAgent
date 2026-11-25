/*---------------------------------------------------------------------------------------------
 *  Copyright (c) RoboAgent. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Emitter, Event } from '../../../base/common/event.js';
import { Disposable } from '../../../base/common/lifecycle.js';
import { ILogService } from '../../log/common/log.js';
import { IProductService } from '../../product/common/productService.js';
import { IRoboAgentAuthMainService, IRoboAgentAuthSession } from '../common/roboagentAuthService.js';
import { IFileService } from '../../files/common/files.js';
import { IEncryptionMainService } from '../../encryption/common/encryptionService.js';
import { IEnvironmentMainService } from '../../environment/electron-main/environmentMainService.js';
import { IURLHandler } from '../../url/common/url.js';
import { INativeHostMainService } from '../../native/electron-main/nativeHostMainService.js';
import { AuthStorageService, IStoredSessionData } from './storage.js';
import { AuthExchangeService, ExchangeError, ITokenResponse } from './exchange.js';
import { BrowserSignIn, buildLoginUrl } from './authCallback.js';
import { generateCodeChallenge, generateCodeVerifier, generateState } from './pkce.js';
import { AUTH_TIMEOUT_MS, TOKEN_REFRESH_MARGIN_MS, WEB_BASE } from '../common/authConstants.js';

/** The auth server refused the refresh token (as opposed to a network failure). */
function isRejectedRefreshToken(e: unknown): boolean {
	return e instanceof ExchangeError && (e.statusCode === 400 || e.statusCode === 401);
}

export class RoboAgentAuthMainService extends Disposable implements IRoboAgentAuthMainService {
	public readonly _serviceBrand: undefined;

	private readonly _onDidChangeSession = this._register(new Emitter<IRoboAgentAuthSession>());
	public readonly onDidChangeSession: Event<IRoboAgentAuthSession> = this._onDidChangeSession.event;

	private _session: IRoboAgentAuthSession = { isSignedIn: false };
	private _accessToken: string | undefined;
	private _accessTokenExpiresAt = 0;
	private _refreshTimer: ReturnType<typeof setTimeout> | undefined;
	private _refreshPromise: Promise<void> | undefined;

	private readonly storageService: AuthStorageService;
	private readonly exchangeService: AuthExchangeService;

	constructor(
		@ILogService private readonly logService: ILogService,
		@IProductService private readonly productService: IProductService,
		@IFileService fileService: IFileService,
		@IEncryptionMainService encryptionService: IEncryptionMainService,
		@IEnvironmentMainService environmentService: IEnvironmentMainService,
		@INativeHostMainService private readonly nativeHostService: INativeHostMainService
	) {
		super();

		// For security and architecture correctness, throw if anon key is completely missing
		const anonKey = this.productService.supabaseAnonKey;
		if (!anonKey) {
			this.logService.error('RoboAgentAuthMainService: Missing supabaseAnonKey in product.json. Auth will fail.');
		}

		this.storageService = new AuthStorageService(environmentService.userDataPath, fileService, encryptionService, logService);
		this.exchangeService = new AuthExchangeService(anonKey || '', logService);
		this.browserSignIn = new BrowserSignIn(this.productService.urlProtocol, AUTH_TIMEOUT_MS, message => this.logService.warn(`RoboAgentAuthMainService: ${message}`));

		// Kick off restoration asynchronously
		this.tryRestoreSession();
	}

	public async getSession(): Promise<IRoboAgentAuthSession> {
		return this._session;
	}

	public async getAccessToken(): Promise<string | undefined> {
		if (!this._session.isSignedIn) {
			return undefined;
		}
		if (!this._accessToken || Date.now() >= this._accessTokenExpiresAt - TOKEN_REFRESH_MARGIN_MS) {
			try {
				await this.refreshAccessToken();
			} catch (e) {
				this.logService.warn('RoboAgentAuthMainService#getAccessToken: Could not refresh the access token', e);
				return undefined;
			}
		}
		return this._accessToken;
	}

	private readonly browserSignIn: BrowserSignIn;
	/** Bumped by every sign-in and cancel: a sign-in cancelled during its code exchange discards the tokens. */
	private signInGeneration = 0;

	/**
	 * Receives `<urlProtocol>://auth/callback` links. app.ts registers it ahead of every other URL
	 * handler, so the authorization code never reaches a window or the protocol-URL log. A property,
	 * not a method, so it is not callable over the IPC channel.
	 */
	public get signInCallbackHandler(): IURLHandler {
		return this.browserSignIn.handler;
	}

	public async signIn(): Promise<IRoboAgentAuthSession> {
		this.logService.trace('RoboAgentAuthMainService#signIn: Starting sign-in flow');
		const generation = ++this.signInGeneration;

		const isEncryptionAvailable = await this.storageService.isAvailable();
		if (!isEncryptionAvailable) {
			this.logService.warn('RoboAgentAuthMainService#signIn: Encryption is unavailable. Session will not persist across launches.');
		}

		const verifier = generateCodeVerifier();
		const challenge = generateCodeChallenge(verifier);
		const state = generateState();

		// Cancelled (or replaced by a newer sign-in) while the storage check was running.
		if (generation !== this.signInGeneration) {
			throw new Error('Sign in aborted');
		}

		// The browser returns through RoboAgent's URL scheme (`signInCallbackHandler`); no callback
		// server is opened on localhost. A new sign-in replaces the one in progress.
		const code = await this.browserSignIn.run(state, redirectUri =>
			this.nativeHostService.openExternal(undefined, buildLoginUrl(WEB_BASE, challenge, state, redirectUri)));

		const tokenResponse = await this.exchangeService.exchangeCode(code, verifier);
		if (generation !== this.signInGeneration) {
			throw new Error('Sign in aborted');
		}
		await this.handleTokenResponse(tokenResponse);
		return this._session;
	}

	public async cancelSignIn(): Promise<void> {
		this.signInGeneration++;
		this.browserSignIn.cancel();
	}

	public async signOut(): Promise<void> {
		this.logService.trace('RoboAgentAuthMainService#signOut: Signing out');

		if (this._accessToken) {
			await this.exchangeService.signOutRemote(this._accessToken);
		}

		await this.clearSession();
	}

	private async clearSession(): Promise<void> {
		this._accessToken = undefined;
		this._accessTokenExpiresAt = 0;
		this._session = { isSignedIn: false };
		if (this._refreshTimer) {
			clearTimeout(this._refreshTimer);
			this._refreshTimer = undefined;
		}

		await this.storageService.clear();
		this._onDidChangeSession.fire(this._session);
	}

	private async handleTokenResponse(response: ITokenResponse): Promise<void> {
		this._accessToken = response.access_token;
		this._accessTokenExpiresAt = Date.now() + response.expires_in * 1000;

		const displayName = response.user.user_metadata?.full_name || response.user.email;

		this._session = {
			isSignedIn: true,
			userId: response.user.id,
			email: response.user.email,
			displayName
		};

		const dataToStore: IStoredSessionData = {
			refreshToken: response.refresh_token,
			userId: response.user.id,
			email: response.user.email,
			displayName
		};
		await this.storageService.save(dataToStore);

		// Schedule next refresh
		if (this._refreshTimer) {
			clearTimeout(this._refreshTimer);
		}

		const expiresInMs = response.expires_in * 1000;
		const refreshInMs = Math.max(0, expiresInMs - TOKEN_REFRESH_MARGIN_MS);

		this._refreshTimer = setTimeout(() => {
			this.refreshAccessToken();
		}, refreshInMs);

		this._onDidChangeSession.fire(this._session);
	}

	private async tryRestoreSession(): Promise<void> {
		this.logService.trace('RoboAgentAuthMainService#tryRestoreSession: Attempting to restore session');

		if (!(await this.storageService.isAvailable())) {
			this.logService.trace('RoboAgentAuthMainService#tryRestoreSession: Encryption unavailable, cannot restore');
			return;
		}

		const storedData = await this.storageService.load();
		if (!storedData || !storedData.refreshToken) {
			return;
		}

		// Optimistic signed-in state (no access token yet, but identity known)
		this._session = {
			isSignedIn: true,
			userId: storedData.userId,
			email: storedData.email,
			displayName: storedData.displayName
		};
		this._onDidChangeSession.fire(this._session);

		try {
			await this.refreshAccessToken(storedData.refreshToken);
		} catch (e) {
			if (isRejectedRefreshToken(e)) {
				this.logService.warn('RoboAgentAuthMainService#tryRestoreSession: Refresh token rejected, clearing session');
				await this.clearSession();
			} else {
				this.logService.warn('RoboAgentAuthMainService#tryRestoreSession: Network error during restore, keeping optimistic session', e);
				// We keep the optimistic session. A future API call will fail or we can implement a retry.
			}
		}
	}

	private async refreshAccessToken(forceRefreshToken?: string): Promise<void> {
		if (this._refreshPromise) {
			return this._refreshPromise;
		}

		this._refreshPromise = this.doRefreshAccessToken(forceRefreshToken).finally(() => {
			this._refreshPromise = undefined;
		});

		return this._refreshPromise;
	}

	private async doRefreshAccessToken(forceRefreshToken?: string): Promise<void> {
		let refreshTokenToUse = forceRefreshToken;

		if (!refreshTokenToUse) {
			const storedData = await this.storageService.load();
			refreshTokenToUse = storedData?.refreshToken;
		}

		if (!refreshTokenToUse) {
			throw new Error('No refresh token available');
		}

		try {
			const tokenResponse = await this.exchangeService.refreshAccessToken(refreshTokenToUse);
			await this.handleTokenResponse(tokenResponse);
		} catch (e) {
			if (isRejectedRefreshToken(e)) {
				this.logService.warn('RoboAgentAuthMainService#doRefreshAccessToken: Refresh rejected, clearing session');
				await this.clearSession();
			}
			throw e;
		}
	}
}
