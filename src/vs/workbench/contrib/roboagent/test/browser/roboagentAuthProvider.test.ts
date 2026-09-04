/*---------------------------------------------------------------------------------------------
 *  Copyright (c) RoboAgent. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { Emitter, Event } from '../../../../../base/common/event.js';
import { IChannel } from '../../../../../base/parts/ipc/common/ipc.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { IMainProcessService } from '../../../../../platform/ipc/common/mainProcessService.js';
import { NullLogService } from '../../../../../platform/log/common/log.js';
import { IRoboAgentAuthSession } from '../../../../../platform/roboagentAuth/common/roboagentAuthService.js';
import { AuthenticationProviderInformation, AuthenticationSessionsChangeEvent, IAuthenticationProvider, IAuthenticationService } from '../../../../services/authentication/common/authentication.js';
import { ROBOAGENT_AUTH_PROVIDER_ID, RoboAgentAuthenticationProvider } from '../../browser/roboagentAuthProvider.js';

/**
 * Stand-in for the main-process auth service, exposed through a fake IPC
 * channel exactly the way ProxyChannel.toService drives the real one.
 */
class FakeMainAuth {
	session: IRoboAgentAuthSession = { isSignedIn: false };
	accessToken: string | undefined;
	signOutCalls = 0;
	signInCalls = 0;
	readonly onDidChangeSession = new Emitter<IRoboAgentAuthSession>();

	channel(): IChannel {
		return {
			call: async <T>(command: string): Promise<T> => {
				switch (command) {
					case 'getSession': return this.session as unknown as T;
					case 'getAccessToken': return this.accessToken as unknown as T;
					case 'signOut': this.signOutCalls++; return undefined as unknown as T;
					case 'signIn': this.signInCalls++; return this.session as unknown as T;
					default: throw new Error(`unexpected call ${command}`);
				}
			},
			listen: <T>(event: string): Event<T> => {
				assert.strictEqual(event, 'onDidChangeSession');
				return this.onDidChangeSession.event as unknown as Event<T>;
			}
		};
	}
}

class FakeAuthenticationService {
	readonly declaredProviders: AuthenticationProviderInformation[] = [];
	readonly providers = new Map<string, IAuthenticationProvider>();
	isAuthenticationProviderRegistered(id: string) { return this.providers.has(id); }
	registerDeclaredAuthenticationProvider(p: AuthenticationProviderInformation) { this.declaredProviders.push(p); }
	registerAuthenticationProvider(id: string, p: IAuthenticationProvider) { this.providers.set(id, p); }
	unregisterAuthenticationProvider(id: string) { this.providers.delete(id); }
}

suite('RoboAgent Authentication Provider', () => {

	const store = ensureNoDisposablesAreLeakedInTestSuite();

	let main: FakeMainAuth;
	let authenticationService: FakeAuthenticationService;
	let provider: RoboAgentAuthenticationProvider;

	setup(() => {
		main = new FakeMainAuth();
		store.add(main.onDidChangeSession);
		authenticationService = new FakeAuthenticationService();
		const mainProcessService = { getChannel: () => main.channel() } as unknown as IMainProcessService;
		provider = store.add(new RoboAgentAuthenticationProvider(mainProcessService, authenticationService as unknown as IAuthenticationService, new NullLogService()));
	});

	test('registers itself as the declared + live "roboagent" provider', () => {
		assert.deepStrictEqual(authenticationService.declaredProviders.map(p => p.id), [ROBOAGENT_AUTH_PROVIDER_ID]);
		assert.strictEqual(authenticationService.providers.get(ROBOAGENT_AUTH_PROVIDER_ID), provider);
		assert.strictEqual(provider.supportsMultipleAccounts, false);
	});

	test('does not double-register when a provider with the same id exists', () => {
		const existing = {} as IAuthenticationProvider;
		const service = new FakeAuthenticationService();
		service.registerAuthenticationProvider(ROBOAGENT_AUTH_PROVIDER_ID, existing);
		const mainProcessService = { getChannel: () => main.channel() } as unknown as IMainProcessService;
		store.add(new RoboAgentAuthenticationProvider(mainProcessService, service as unknown as IAuthenticationService, new NullLogService()));
		assert.strictEqual(service.providers.get(ROBOAGENT_AUTH_PROVIDER_ID), existing);
		assert.strictEqual(service.declaredProviders.length, 0);
	});

	test('getSessions is empty while signed out', async () => {
		assert.deepStrictEqual(await provider.getSessions(undefined, {}), []);
	});

	test('getSessions is empty when signed in but no access token can be obtained', async () => {
		main.session = { isSignedIn: true, userId: 'u1', email: 'a@b.c' };
		main.accessToken = undefined;
		assert.deepStrictEqual(await provider.getSessions(undefined, {}), []);
	});

	test('getSessions returns the current token and account when signed in', async () => {
		main.session = { isSignedIn: true, userId: 'u1', email: 'a@b.c', displayName: 'Ada' };
		main.accessToken = 'tok-1';
		const sessions = await provider.getSessions(undefined, {});
		assert.strictEqual(sessions.length, 1);
		assert.strictEqual(sessions[0].accessToken, 'tok-1');
		assert.strictEqual(sessions[0].account.id, 'u1');
		assert.strictEqual(sessions[0].account.label, 'a@b.c');
		assert.deepStrictEqual(sessions[0].scopes, []);

		// A refreshed token is picked up on the next call (nothing is cached here).
		main.accessToken = 'tok-2';
		assert.strictEqual((await provider.getSessions(undefined, {}))[0].accessToken, 'tok-2');
	});

	test('getSessions filters by requested account', async () => {
		main.session = { isSignedIn: true, userId: 'u1', email: 'a@b.c' };
		main.accessToken = 'tok';
		assert.strictEqual((await provider.getSessions(undefined, { account: { id: 'someone-else', label: 'x' } })).length, 0);
		assert.strictEqual((await provider.getSessions(undefined, { account: { id: 'u1', label: 'x' } })).length, 1);
	});

	test('removeSession signs out of RoboAgent', async () => {
		await provider.removeSession('roboagent/u1');
		assert.strictEqual(main.signOutCalls, 1);
	});

	test('createSession runs the sign-in flow and returns the new session', async () => {
		main.accessToken = 'tok';
		main.session = { isSignedIn: true, userId: 'u1', email: 'a@b.c' };
		const session = await provider.createSession();
		assert.strictEqual(main.signInCalls, 1);
		assert.strictEqual(session.accessToken, 'tok');
	});

	test('mirrors main-process session changes as added / changed / removed events', async () => {
		const events: AuthenticationSessionsChangeEvent[] = [];
		store.add(provider.onDidChangeSessions(e => events.push(e)));

		main.session = { isSignedIn: true, userId: 'u1', email: 'a@b.c' };
		main.accessToken = 'tok';
		main.onDidChangeSession.fire(main.session);
		// The handler awaits the token over the (fake) channel; give it a tick.
		await new Promise(r => setTimeout(r, 0));
		assert.strictEqual(events.length, 1);
		assert.strictEqual(events[0].added?.length, 1);
		assert.strictEqual(events[0].added?.[0].accessToken, 'tok');

		main.accessToken = 'tok-refreshed';
		main.onDidChangeSession.fire(main.session);
		await new Promise(r => setTimeout(r, 0));
		assert.strictEqual(events.length, 2);
		assert.strictEqual(events[1].changed?.[0].accessToken, 'tok-refreshed');

		main.session = { isSignedIn: false };
		main.onDidChangeSession.fire(main.session);
		await new Promise(r => setTimeout(r, 0));
		assert.strictEqual(events.length, 3);
		assert.strictEqual(events[2].removed?.length, 1);
		assert.strictEqual(events[2].removed?.[0].account.id, 'u1');
	});
});
