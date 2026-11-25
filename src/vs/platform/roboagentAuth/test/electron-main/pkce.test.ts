/*---------------------------------------------------------------------------------------------
 *  Copyright (c) RoboAgent. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../base/test/common/utils.js';
import { constantTimeEqual, generateCodeChallenge, generateCodeVerifier, generateState } from '../../electron-main/pkce.js';

suite('RoboAgent Auth PKCE', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('generateCodeVerifier creates a 43-character base64url string', () => {
		const verifier = generateCodeVerifier();
		assert.strictEqual(verifier.length, 43);
		assert.match(verifier, /^[a-zA-Z0-9_-]+$/);
	});

	test('generateCodeChallenge matches known SHA-256 hash', () => {
		const verifier = 'test-verifier-that-is-long-enough-for-pkce';
		const challenge = generateCodeChallenge(verifier);
		// Expected hash of the above string
		// echo -n "test-verifier-that-is-long-enough-for-pkce" | openssl dgst -sha256 -binary | base64 | tr '/+' '_-' | tr -d '='
		assert.strictEqual(challenge, '_CwdUbPcDSmV2Wm80tcKQ73cQMie-QO_piOmb5qtaJg');
	});

	test('generateState creates a 43-character base64url string', () => {
		const state = generateState();
		assert.strictEqual(state.length, 43);
		assert.match(state, /^[a-zA-Z0-9_-]+$/);
	});

	test('constantTimeEqual works correctly', () => {
		assert.strictEqual(constantTimeEqual('hello', 'hello'), true);
		assert.strictEqual(constantTimeEqual('hello', 'world'), false);
		assert.strictEqual(constantTimeEqual('hello', 'helloo'), false);
	});
});
