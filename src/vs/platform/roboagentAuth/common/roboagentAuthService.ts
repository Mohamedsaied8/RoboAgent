/*---------------------------------------------------------------------------------------------
 *  Copyright (c) RoboAgent. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Event } from '../../../base/common/event.js';
import { createDecorator } from '../../instantiation/common/instantiation.js';

export interface IRoboAgentAuthSession {
	readonly isSignedIn: boolean;
	readonly userId?: string;
	readonly email?: string;
	readonly displayName?: string;
}

export const IRoboAgentAuthMainService = createDecorator<IRoboAgentAuthMainService>('roboagentAuthMainService');

export interface IRoboAgentAuthMainService {
	readonly _serviceBrand: undefined;

	/**
	 * Fired when the session state changes (e.g. sign in, sign out, token expiration).
	 */
	readonly onDidChangeSession: Event<IRoboAgentAuthSession>;

	/**
	 * Initiate the OAuth 2.0 PKCE sign-in flow.
	 */
	signIn(): Promise<IRoboAgentAuthSession>;

	/**
	 * Cancel the sign-in in progress, if any: its `signIn()` rejects with "Sign in aborted".
	 */
	cancelSignIn(): Promise<void>;

	/**
	 * Sign out, clearing both local credentials and remote Supabase session.
	 */
	signOut(): Promise<void>;

	/**
	 * Get the current derived session state. Does not include access/refresh tokens.
	 */
	getSession(): Promise<IRoboAgentAuthSession>;

	/**
	 * A valid access token for the signed-in account (refreshed first when it is about to expire),
	 * for calling RoboAgent services such as the AI chat gateway. Undefined when signed out or when
	 * no token can be obtained.
	 */
	getAccessToken(): Promise<string | undefined>;
}
