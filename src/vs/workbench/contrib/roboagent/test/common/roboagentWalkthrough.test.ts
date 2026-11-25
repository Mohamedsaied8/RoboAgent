/*---------------------------------------------------------------------------------------------
 *  Copyright (c) RoboAgent. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { walkthroughs } from '../../../welcomeGettingStarted/common/gettingStartedContent.js';

// Regression for the 2026-11-25 manual test: the featured first-run walkthrough was upstream's
// "Get started with VS Code", whose first step offered Copilot under GitHub's terms.
suite('RoboAgent - Setup walkthrough', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	test('is branded RoboAgent and signs in to the RoboAgent account instead of Copilot', () => {
		const setup = walkthroughs.find(w => w.id === 'Setup');
		assert.ok(setup && setup.content.type === 'steps');
		const steps = setup.content.steps;
		assert.deepStrictEqual({
			title: setup.title,
			pageTitle: setup.walkthroughPageTitle,
			steps: steps.map(s => s.id),
			signIn: steps[0].description.includes('(command:roboagent.signIn)'),
			when: steps[0].when,
		}, {
			title: 'Get started with RoboAgent',
			pageTitle: 'Set Up RoboAgent',
			steps: ['roboagentSignIn', 'pickColorTheme'],
			signIn: true,
			when: 'roboagentIsSignedIn == false',
		});
		assert.ok(!steps.some(s => /copilot/i.test(s.title + s.description)), 'no Copilot step');
	});
});
