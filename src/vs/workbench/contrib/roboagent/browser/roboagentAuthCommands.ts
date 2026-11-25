/*---------------------------------------------------------------------------------------------
 *  Copyright (c) RoboAgent. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Action2, MenuId, registerAction2 } from '../../../../platform/actions/common/actions.js';
import { ContextKeyExpr } from '../../../../platform/contextkey/common/contextkey.js';
import { ServicesAccessor } from '../../../../platform/instantiation/common/instantiation.js';
import { localize, localize2 } from '../../../../nls.js';
import { IRoboAgentAuthService } from '../../../../platform/roboagentAuth/common/roboagentAuthService.js';
import { INotificationService, Severity } from '../../../../platform/notification/common/notification.js';

import { IOpenerService } from '../../../../platform/opener/common/opener.js';
import { URI } from '../../../../base/common/uri.js';

/**
 * Error text from the auth flow, made safe for a notification: notifications render Markdown
 * links (including `command:` links), so brackets are dropped and the text cannot become one.
 */
export function plainNotificationText(message: string): string {
	return message.replace(/[[\]]/g, '').slice(0, 300);
}

/**
 * Run the browser sign-in with a progress notification whose Cancel really cancels it; the
 * notification is closed however the sign-in ends. `failureMessage` formats the error.
 */
async function runBrowserSignIn(authService: IRoboAgentAuthService, notificationService: INotificationService, openingMessage: string, failureMessage: (error: string) => string): Promise<void> {
	const progress = notificationService.prompt(Severity.Info, openingMessage, [{
		label: localize('roboagent.signIn.cancel', "Cancel"),
		run: () => { void authService.cancelSignIn(); }
	}]);
	try {
		await authService.signIn();
		notificationService.info(localize('roboagent.signIn.done', "Successfully signed in to RoboAgent!"));
	} catch (e) {
		const message = e instanceof Error ? e.message : String(e);
		if (message !== 'Sign in aborted') {
			notificationService.error(failureMessage(plainNotificationText(message)));
		}
	} finally {
		progress.close();
	}
}

export class SignInAction extends Action2 {
	public static readonly ID = 'roboagent.signIn';

	constructor() {
		super({
			id: SignInAction.ID,
			title: localize2('roboagent.signInTitle', "Log In to RoboAgent"),
			category: localize2('roboagent.category', "RoboAgent"),
			f1: true,
			menu: { id: MenuId.AccountsContext, group: '1_roboagent', order: 1, when: ContextKeyExpr.equals('roboagentIsSignedIn', false) }
		});
	}

	async run(accessor: ServicesAccessor): Promise<void> {
		const notificationService = accessor.get(INotificationService);

		const authService = accessor.get(IRoboAgentAuthService);

		const session = await authService.getSession();
		if (session.isSignedIn) {
			notificationService.info('You are already signed in.');
			return;
		}

		await runBrowserSignIn(authService, notificationService,
			localize('roboagent.signIn.opening', "Opening Robotics Corner in your browser — sign in there to continue..."),
			error => localize('roboagent.signIn.failed', "Sign in failed: {0}", error));
	}
}

export class SignUpAction extends Action2 {
	public static readonly ID = 'roboagent.signUp';

	constructor() {
		super({
			id: SignUpAction.ID,
			title: localize2('roboagent.signUpTitle', "Sign Up for RoboAgent"),
			category: localize2('roboagent.category', "RoboAgent"),
			f1: true
		});
	}

	async run(accessor: ServicesAccessor): Promise<void> {
		const notificationService = accessor.get(INotificationService);

		const authService = accessor.get(IRoboAgentAuthService);

		const session = await authService.getSession();
		if (session.isSignedIn) {
			notificationService.info('You are already signed in.');
			return;
		}

		await runBrowserSignIn(authService, notificationService,
			localize('roboagent.signUp.opening', "Opening Robotics Corner in your browser — create your account there to continue..."),
			error => localize('roboagent.signUp.failed', "Sign up failed: {0}", error));
	}
}

export class SignOutAction extends Action2 {
	public static readonly ID = 'roboagent.signOut';

	constructor() {
		super({
			id: SignOutAction.ID,
			title: localize2('roboagent.signOutTitle', "Sign Out of RoboAgent"),
			category: localize2('roboagent.category', "RoboAgent"),
			f1: true,
			menu: { id: MenuId.AccountsContext, group: '1_roboagent', order: 3, when: ContextKeyExpr.equals('roboagentIsSignedIn', true) }
		});
	}

	async run(accessor: ServicesAccessor): Promise<void> {
		const notificationService = accessor.get(INotificationService);

		const authService = accessor.get(IRoboAgentAuthService);

		const session = await authService.getSession();
		if (!session.isSignedIn) {
			notificationService.info('You are not signed in.');
			return;
		}

		try {
			await authService.signOut();
			notificationService.info('Successfully signed out of RoboAgent (your browser session is unaffected).');
		} catch (e) {
			notificationService.error(`Sign out failed: ${plainNotificationText(e instanceof Error ? e.message : String(e))}`);
		}
	}
}

export class OpenDashboardAction extends Action2 {
	public static readonly ID = 'roboagent.openDashboard';

	constructor() {
		super({
			id: OpenDashboardAction.ID,
			title: localize2('roboagent.openDashboardTitle', "Go to RoboAgent Dashboard"),
			category: localize2('roboagent.category', "RoboAgent"),
			f1: true,
			menu: { id: MenuId.AccountsContext, group: '1_roboagent', order: 2, when: ContextKeyExpr.equals('roboagentIsSignedIn', true) }
		});
	}

	async run(accessor: ServicesAccessor): Promise<void> {
		const openerService = accessor.get(IOpenerService);
		await openerService.open(URI.parse('https://www.roboticscorner.tech/roboagent/dashboard'));
	}
}

export function registerAuthActions() {
	registerAction2(SignInAction);
	registerAction2(SignUpAction);
	registerAction2(SignOutAction);
	registerAction2(OpenDashboardAction);
}
