/*---------------------------------------------------------------------------------------------
 *  Copyright (c) RoboAgent. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { URI } from '../../../../base/common/uri.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../base/test/common/utils.js';
import { NullLogService } from '../../../log/common/log.js';
import { IRoboAgentAuthSession } from '../../common/roboagentAuthService.js';
import { IRoboAgentAuthSessionHost, roboAgentAuthIpcSurface, RoboAgentAuthSession } from '../../electron-main/authSession.js';
import { ProxyChannel } from '../../../../base/parts/ipc/common/ipc.js';
import { DisposableStore } from '../../../../base/common/lifecycle.js';
import { ExchangeError, ITokenResponse } from '../../electron-main/exchange.js';
import { IStoredSessionData } from '../../electron-main/storage.js';

// Regression for task board A13: the old test imported RoboAgentAuthMainService, whose DI
// dependencies load 'electron', so the unit runner could not even load the file. The session
// logic now lives in an Electron-free class and is tested here with fake storage and exchange.

function tokens(refresh: string, expiresIn = 3600): ITokenResponse {
	return { access_token: `access-for-${refresh}`, refresh_token: refresh, token_type: 'bearer', expires_in: expiresIn, user: { id: 'u1', email: 'dev@example.com' } };
}

class FakeHost implements IRoboAgentAuthSessionHost {
	readonly logService = new NullLogService();
	readonly anonKey = 'test-anon-key';
	readonly urlProtocol = 'roboagent';
	stored: IStoredSessionData | undefined;
	readonly calls: string[] = [];
	readonly opened: string[] = [];
	refresh: (token: string) => Promise<ITokenResponse> = async token => tokens(`${token}-next`);
	exchangeCodeImpl: (code: string) => Promise<ITokenResponse> = async code => tokens(`from-${code}`);

	readonly storage = {
		isAvailable: async () => true,
		save: async (data: IStoredSessionData) => { this.stored = data; },
		load: async () => this.stored,
		clear: async () => { this.calls.push('clear'); this.stored = undefined; },
	};
	readonly exchange = {
		exchangeCode: (code: string, verifier: string) => { this.calls.push(`exchange:${code}`); return this.exchangeCodeImpl(code); },
		refreshAccessToken: (token: string) => { this.calls.push(`refresh:${token}`); return this.refresh(token); },
		signOutRemote: async (accessToken: string) => { this.calls.push(`signOut:${accessToken}`); },
	};
	async openExternal(url: string): Promise<boolean> {
		this.opened.push(url);
		return true;
	}
}

/** The browser's side of a sign-in: read state + redirect from the login URL and call back. */
async function completeInBrowser(session: RoboAgentAuthSession, host: FakeHost, code: string): Promise<void> {
	while (host.opened.length === 0) {
		await new Promise(resolve => setTimeout(resolve, 0));
	}
	const login = new URL(host.opened[host.opened.length - 1]);
	const redirect = login.searchParams.get('redirect_uri')!;
	const state = login.searchParams.get('state')!;
	assert.ok(await session.signInCallbackHandler.handleURL(URI.parse(`${redirect}?code=${code}&state=${state}`)));
}

suite('RoboAgent auth session', () => {

	const store = ensureNoDisposablesAreLeakedInTestSuite();

	test('no stored session: signed out, no token, nothing refreshed', async () => {
		const host = new FakeHost();
		const session = store.add(new RoboAgentAuthSession(host));
		await session.restored;
		assert.deepStrictEqual([await session.getSession(), await session.getAccessToken(), host.calls], [{ isSignedIn: false }, undefined, []]);
	});

	test('restore: refreshes the stored token and stores the rotated one', async () => {
		const host = new FakeHost();
		host.stored = { refreshToken: 'r1', userId: 'u1', email: 'dev@example.com', displayName: 'Dev' };
		const session = store.add(new RoboAgentAuthSession(host));
		await session.restored;
		assert.deepStrictEqual([(await session.getSession()).isSignedIn, await session.getAccessToken(), host.stored?.refreshToken, host.calls], [true, 'access-for-r1-next', 'r1-next', ['refresh:r1']]);
	});

	test('restore: a rejected refresh token signs out; a network failure keeps the session', async () => {
		const rejected = new FakeHost();
		rejected.stored = { refreshToken: 'revoked' };
		rejected.refresh = async () => { throw new ExchangeError(400, 'invalid_grant'); };
		const events: IRoboAgentAuthSession[] = [];
		const s1 = store.add(new RoboAgentAuthSession(rejected));
		store.add(s1.onDidChangeSession(e => events.push(e)));
		await s1.restored;

		const offline = new FakeHost();
		offline.stored = { refreshToken: 'r1', email: 'dev@example.com' };
		offline.refresh = async () => { throw new ExchangeError(0, 'ENOTFOUND'); };
		const s2 = store.add(new RoboAgentAuthSession(offline));
		await s2.restored;

		assert.deepStrictEqual(
			[await s1.getSession(), rejected.stored, events.at(-1), (await s2.getSession()).isSignedIn, offline.stored?.refreshToken],
			[{ isSignedIn: false }, undefined, { isSignedIn: false }, true, 'r1']);
	});

	test('sign in through the browser callback, then sign out', async () => {
		const host = new FakeHost();
		const session = store.add(new RoboAgentAuthSession(host));
		await session.restored;
		const signedIn = session.signIn();
		await completeInBrowser(session, host, 'code1');
		const result = await signedIn;
		const login = new URL(host.opened[0]);
		assert.deepStrictEqual(
			[result.isSignedIn, result.email, login.searchParams.get('redirect_uri'), login.searchParams.get('code_challenge_method'), host.stored?.refreshToken, await session.getAccessToken()],
			[true, 'dev@example.com', 'roboagent://auth/callback', 'S256', 'from-code1', 'access-for-from-code1']);

		await session.signOut();
		assert.deepStrictEqual([await session.getSession(), host.stored, host.calls], [{ isSignedIn: false }, undefined, ['exchange:code1', 'signOut:access-for-from-code1', 'clear']]);
	});

	test('cancel during the code exchange discards the tokens', async () => {
		const host = new FakeHost();
		const session = store.add(new RoboAgentAuthSession(host));
		await session.restored;
		let finishExchange!: () => void;
		host.exchangeCodeImpl = code => new Promise(resolve => finishExchange = () => resolve(tokens(`from-${code}`)));
		const signedIn = session.signIn();
		await completeInBrowser(session, host, 'code1');
		while (!finishExchange) {
			await new Promise(resolve => setTimeout(resolve, 0));
		}
		await session.cancelSignIn();
		finishExchange();
		await assert.rejects(signedIn, /Sign in aborted/);
		assert.deepStrictEqual([await session.getSession(), host.stored], [{ isSignedIn: false }, undefined]);
	});

	test('dispose stops the scheduled token refresh', async () => {
		const host = new FakeHost();
		host.stored = { refreshToken: 'r1' };
		// Expires inside the refresh margin, so the next refresh is scheduled immediately.
		host.refresh = async token => tokens(`${token}-next`, 1);
		const session = new RoboAgentAuthSession(host);
		await session.restored;
		session.dispose();
		const callsAtDispose = host.calls.length;
		await new Promise(resolve => setTimeout(resolve, 20));
		assert.deepStrictEqual(host.calls.slice(callsAtDispose), []);
	});

	// Security review: ProxyChannel.fromService calls any function of the object it serves, the
	// private ones of a class included. The channel serves only the interface's members.
	test('IPC channel: only the interface methods can be called', async () => {
		const host = new FakeHost();
		const session = store.add(new RoboAgentAuthSession(host));
		await session.restored;
		const disposables = store.add(new DisposableStore());
		const channel = ProxyChannel.fromService(roboAgentAuthIpcSurface(session), disposables);
		const planted = tokens('planted');
		const refused: string[] = [];
		for (const method of ['handleTokenResponse', 'clearSession', 'refreshAccessToken', 'dispose', 'restored', 'signInCallbackHandler']) {
			try {
				await channel.call(undefined, method, [planted]);
			} catch {
				refused.push(method);
			}
		}
		assert.deepStrictEqual([refused.length, await channel.call(undefined, 'getSession'), host.stored], [6, { isSignedIn: false }, undefined]);
	});
});
