/*---------------------------------------------------------------------------------------------
 *  Copyright (c) RoboAgent. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { URI } from '../../../../base/common/uri.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../base/test/common/utils.js';
import { authRedirectUri, BrowserSignIn, buildLoginUrl, describeAuthError, parseAuthCallback } from '../../electron-main/authCallback.js';

// The sign-in returns through the app's URL scheme, not a server on the user's machine
// (user requirement, 2026-11-25: the callback "should not be from my local host").
suite('RoboAgent Auth - browser callback', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	test('the redirect URI is the roboagent:// deep link, never a localhost address', () => {
		const redirect = authRedirectUri('roboagent');
		const login = new URL(buildLoginUrl('https://roboticscorner.tech/roboagent', 'CHALLENGE', 'STATE', redirect));
		assert.deepStrictEqual({
			redirect,
			page: login.origin + login.pathname,
			params: Object.fromEntries(login.searchParams),
		}, {
			redirect: 'roboagent://auth/callback',
			page: 'https://roboticscorner.tech/roboagent/login',
			params: { code_challenge: 'CHALLENGE', code_challenge_method: 'S256', state: 'STATE', redirect_uri: 'roboagent://auth/callback' },
		});
		assert.ok(!/127\.0\.0\.1|localhost/.test(login.toString()));
	});

	test('the deep link callback yields the code and state, or the error', () => {
		assert.deepStrictEqual(parseAuthCallback(URI.parse('roboagent://auth/callback?code=abc&state=xyz'), 'roboagent'),
			{ code: 'abc', state: 'xyz', error: undefined, error_description: undefined });
		assert.deepStrictEqual(parseAuthCallback(URI.parse('roboagent://auth/callback?error=access_denied&error_description=User%20cancelled&state=xyz'), 'roboagent'),
			{ code: undefined, state: 'xyz', error: 'access_denied', error_description: 'User cancelled' });
	});

	test('other URLs are not taken for the callback', () => {
		const others = [
			'roboagent://auth/other?code=abc',
			'roboagent://extension/callback?code=abc',
			'vscode://auth/callback?code=abc',
			'http://127.0.0.1:42433/callback?code=abc&state=xyz',
		];
		assert.deepStrictEqual(others.map(u => parseAuthCallback(URI.parse(u), 'roboagent')), [undefined, undefined, undefined, undefined]);
	});

	suite('the sign-in flow (security review 2026-11-25)', () => {

		const STATE = 'S'.repeat(43);
		const link = (query: string) => URI.parse(`roboagent://auth/callback?${query}`);

		function flow(timeoutMs = 60_000) {
			const warnings: string[] = [];
			const opened: string[] = [];
			const signIn = new BrowserSignIn('roboagent', timeoutMs, m => warnings.push(m));
			const open = async (redirect: string) => { opened.push(redirect); };
			return { signIn, warnings, opened, open };
		}

		test('the callback with this sign-in\'s state yields the code', async () => {
			const { signIn, opened, open } = flow();
			const code = signIn.run(STATE, open);
			await Promise.resolve();
			assert.strictEqual(await signIn.handler.handleURL(link(`code=abc&state=${STATE}`)), true);
			assert.deepStrictEqual([await code, opened], ['abc', ['roboagent://auth/callback']]);
		});

		test('a forged callback (wrong state, error with a command link) is ignored; the real one still completes', async () => {
			const { signIn, warnings, open } = flow();
			const code = signIn.run(STATE, open);
			await Promise.resolve();
			const forged = 'error=x&error_description=' + encodeURIComponent('[Retry](command:workbench.action.terminal.sendSequence)') + '&state=WRONG';
			assert.strictEqual(await signIn.handler.handleURL(link(forged)), true);
			assert.strictEqual(await signIn.handler.handleURL(link('error=x')), true, 'no state at all');
			assert.strictEqual(await signIn.handler.handleURL(link(`code=abc&state=${STATE}`)), true);
			assert.strictEqual(await code, 'abc');
			assert.strictEqual(warnings.length, 2);
		});

		test('an error from the sign-in page is reported by code only, never its description', async () => {
			const { signIn, open } = flow();
			const refused = signIn.run(STATE, open);
			await Promise.resolve();
			await signIn.handler.handleURL(link(`error=access_denied&error_description=${encodeURIComponent('[x](command:y)')}&state=${STATE}`));
			await assert.rejects(refused, { message: 'The sign-in was refused (access_denied).' });
			assert.deepStrictEqual([describeAuthError('access_denied'), describeAuthError('[x](command:y)')], ['access_denied', 'unknown_error']);
		});

		test('cancel, timeout, and callbacks with no sign-in in progress', async () => {
			const { signIn, open } = flow();
			const cancelled = signIn.run(STATE, open);
			await Promise.resolve();
			signIn.cancel();
			await assert.rejects(cancelled, { message: 'Sign in aborted' });
			assert.strictEqual(await signIn.handler.handleURL(link(`code=late&state=${STATE}`)), true, 'swallowed, not routed elsewhere');
			assert.strictEqual(await signIn.handler.handleURL(URI.parse('roboagent://other/path')), false);

			const short = flow(5);
			await assert.rejects(short.signIn.run(STATE, short.open), { message: 'Sign in aborted' });
		});

		// Re-review N5: a browser that cannot be opened, or never returns, does not leave the sign-in waiting.
		test('a browser launch that fails or hangs ends the sign-in', async () => {
			const failed = flow();
			await assert.rejects(failed.signIn.run(STATE, async () => false), { message: 'Could not open the browser for the sign-in.' });
			const hung = flow(5);
			await assert.rejects(hung.signIn.run(STATE, () => new Promise<void>(() => { })), { message: 'Sign in aborted' });
		});

		test('a sign-in replaced while its browser is still opening does not break the new one', async () => {
			const { signIn } = flow();
			let releaseFirstBrowser!: () => void;
			const first = signIn.run('A'.repeat(43), () => new Promise<void>(resolve => releaseFirstBrowser = resolve));
			const second = signIn.run(STATE, async () => { });
			releaseFirstBrowser();
			await assert.rejects(first, { message: 'Sign in aborted' });
			assert.strictEqual(await signIn.handler.handleURL(link(`code=second&state=${STATE}`)), true);
			assert.strictEqual(await second, 'second');
		});
	});
});
