/*---------------------------------------------------------------------------------------------
 *  Copyright (c) RoboAgent. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { URI } from '../../../base/common/uri.js';
import { IURLHandler } from '../../url/common/url.js';
import { constantTimeEqual } from './pkce.js';

/**
 * The browser sign-in returns to RoboAgent through the app's own URL scheme
 * (`roboagent://auth/callback`, registered by the installed .desktop / OS handler), never
 * through a server on the user's machine: no port is opened on 127.0.0.1 for the callback.
 */
const CALLBACK_AUTHORITY = 'auth';
const CALLBACK_PATH = '/callback';

/** What the sign-in page hands back: an authorization code (or an error) plus the state. */
export interface ISignInCallback {
	readonly code?: string;
	readonly state?: string;
	readonly error?: string;
	readonly error_description?: string;
}

/** The redirect URI sent to the sign-in page: `<urlProtocol>://auth/callback`. */
export function authRedirectUri(urlProtocol: string): string {
	return `${urlProtocol}://${CALLBACK_AUTHORITY}${CALLBACK_PATH}`;
}

/** The sign-in page URL with the PKCE challenge, the state and the redirect URI. */
export function buildLoginUrl(webBase: string, challenge: string, state: string, redirectUri: string): string {
	const query = new URLSearchParams({ code_challenge: challenge, code_challenge_method: 'S256', state, redirect_uri: redirectUri });
	return `${webBase}/login?${query.toString()}`;
}

/** The callback carried by `uri`, or undefined when `uri` is not the sign-in callback. */
export function parseAuthCallback(uri: URI, urlProtocol: string): ISignInCallback | undefined {
	if (uri.scheme !== urlProtocol || uri.authority !== CALLBACK_AUTHORITY || uri.path !== CALLBACK_PATH) {
		return undefined;
	}
	const query = new URLSearchParams(uri.query);
	const value = (key: string) => query.get(key) || undefined;
	return { code: value('code'), state: value('state'), error: value('error'), error_description: value('error_description') };
}

/** OAuth error codes are short identifiers; anything else in a callback is not shown as-is. */
export function describeAuthError(error: string): string {
	return /^[a-z0-9_.-]{1,64}$/i.test(error) ? error : 'unknown_error';
}

interface IActiveSignIn {
	readonly state: string;
	readonly settle: (result: ISignInCallback | Error) => void;
}

/**
 * The browser half of a sign-in: open the login page, wait for this sign-in's callback, return
 * the authorization code. One sign-in at a time; a new one replaces the one in progress.
 *
 * Callbacks are matched on `state` before anything else, so a stray or forged
 * `roboagent://auth/callback` link (any local app or web page can fire one) is ignored instead of
 * ending — or erroring — the real sign-in. Each sign-in cleans up only its own record.
 */
export class BrowserSignIn {

	private active: IActiveSignIn | undefined;

	constructor(
		private readonly urlProtocol: string,
		private readonly timeoutMs: number,
		private readonly warn: (message: string) => void,
	) { }

	/** The URL handler for `<urlProtocol>://auth/callback`; true for every callback link. */
	readonly handler: IURLHandler = {
		handleURL: async (uri: URI) => {
			const callback = parseAuthCallback(uri, this.urlProtocol);
			if (!callback) {
				return false;
			}
			const active = this.active;
			if (!active || !callback.state || !constantTimeEqual(active.state, callback.state)) {
				this.warn('ignored a sign-in callback that does not belong to the sign-in in progress');
				return true;
			}
			active.settle(callback);
			return true;
		}
	};

	/**
	 * Run one sign-in with `state`: `openBrowser` gets the redirect URI to put in the login URL.
	 * Resolves with the authorization code; rejects with "Sign in aborted" when cancelled, timed
	 * out or replaced, or with the (sanitised) error the sign-in page returned.
	 */
	async run(state: string, openBrowser: (redirectUri: string) => Promise<boolean | void>): Promise<string> {
		this.cancel();
		let settle!: (result: ISignInCallback | Error) => void;
		const settled = new Promise<ISignInCallback | Error>(resolve => settle = resolve);
		const active: IActiveSignIn = { state, settle };
		this.active = active;
		let timer: ReturnType<typeof setTimeout> | undefined;
		try {
			// The timeout also covers a browser launch that never returns.
			timer = setTimeout(() => {
				this.warn('timed out waiting for the browser sign-in');
				settle(new Error('Sign in aborted'));
			}, this.timeoutMs);
			// Raced against the outcome, so a launch that never returns still ends with the timeout
			// (or with a cancel, or the callback itself).
			const launched = openBrowser(authRedirectUri(this.urlProtocol)).then(opened =>
				opened === false ? new Error('Could not open the browser for the sign-in.') : undefined);
			const first = await Promise.race([launched, settled]);
			const result = first === undefined ? await settled : first;
			if (result instanceof Error) {
				throw result;
			}
			if (result.error) {
				throw new Error(`The sign-in was refused (${describeAuthError(result.error)}).`);
			}
			if (!result.code) {
				throw new Error('No code returned from auth provider.');
			}
			return result.code;
		} finally {
			if (timer) {
				clearTimeout(timer);
			}
			if (this.active === active) {
				this.active = undefined;
			}
		}
	}

	/** Abort the sign-in in progress, if any. */
	cancel(): void {
		this.active?.settle(new Error('Sign in aborted'));
	}
}
