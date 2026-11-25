/*---------------------------------------------------------------------------------------------
 *  Copyright (c) RoboAgent. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../base/test/common/utils.js';
import { ensureLinuxUrlSchemeHandler, IUrlSchemeHost, quoteExecArgument, urlSchemeTarget, userHandlerDesktopEntry } from '../../electron-main/urlSchemeRegistration.js';

// Review finding (2026-11-25): with the loopback server gone, sign-in from a tarball or dev build
// never completed — only the packages register roboagent:// with the desktop.
suite('RoboAgent Auth - roboagent:// handler registration (Linux)', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	const PRODUCT = { urlProtocol: 'roboagent', applicationName: 'roboagent', nameLong: 'RoboAgent' };
	const OWN = 'roboagent-url-handler-user.desktop';

	function fakeHost(defaultHandler: string, files: Record<string, string> = {}, xdgMime = true) {
		const calls: string[][] = [];
		const written: Record<string, string> = {};
		const deleted: string[] = [];
		const host: IUrlSchemeHost = {
			env: { XDG_DATA_DIRS: '/usr/share' },
			homeDir: '/home/u',
			execFile: async (program, args) => {
				if (!xdgMime) { throw new Error('ENOENT'); }
				calls.push([program, ...args]);
				return args[0] === 'query' ? `${defaultHandler}\n` : '';
			},
			readFile: async file => written[file] ?? files[file],
			writeFile: async (file, content) => { written[file] = content; },
			deleteFile: async file => { deleted.push(file); },
		};
		return { host, calls, written, deleted };
	}

	const target = urlSchemeTarget(PRODUCT, { isBuilt: true, appRoot: '/opt/roboagent/resources/app' }, '/opt/my apps/roboagent');

	test('no handler, or one whose entry is gone: this RoboAgent registers itself', async () => {
		for (const current of ['', 'roboagent-url-handler.desktop']) {
			const { host, calls, written } = fakeHost(current);
			assert.strictEqual(await ensureLinuxUrlSchemeHandler(host, target), 'registered');
			assert.deepStrictEqual(Object.keys(written), [`/home/u/.local/share/applications/${OWN}`]);
			assert.deepStrictEqual(calls[1], ['xdg-mime', 'default', OWN, 'x-scheme-handler/roboagent']);
		}
	});

	test('a handler installed by a package is kept', async () => {
		const { host, calls, written } = fakeHost('roboagent-url-handler.desktop', { '/usr/share/applications/roboagent-url-handler.desktop': '[Desktop Entry]' });
		assert.strictEqual(await ensureLinuxUrlSchemeHandler(host, target), 'kept-other-handler');
		assert.deepStrictEqual([calls.length, written], [1, {}]);
	});

	// Re-review N1: a user-level default outranks a package's entry, so once the package is installed
	// the default goes back to it and RoboAgent's own entry is removed.
	test('when the package is installed again, the default goes back to its entry', async () => {
		const { host, calls, deleted } = fakeHost(OWN, { '/usr/share/applications/roboagent-url-handler.desktop': '[Desktop Entry]' });
		assert.strictEqual(await ensureLinuxUrlSchemeHandler(host, target), 'returned-to-package');
		assert.deepStrictEqual(calls[1], ['xdg-mime', 'default', 'roboagent-url-handler.desktop', 'x-scheme-handler/roboagent']);
		assert.deepStrictEqual(deleted, [`/home/u/.local/share/applications/${OWN}`]);
	});

	test('a throw-away instance (dev build with its own profile, test run) never becomes the handler', async () => {
		const dev = urlSchemeTarget(PRODUCT, { isBuilt: false, appRoot: '/src', userDataDir: '/tmp/udd' }, '/src/electron');
		const tests = urlSchemeTarget(PRODUCT, { isBuilt: true, appRoot: '/opt/app', testRun: true }, '/opt/roboagent');
		for (const t of [dev, tests]) {
			const { host, written } = fakeHost('');
			assert.strictEqual(await ensureLinuxUrlSchemeHandler(host, t), 'skipped');
			assert.deepStrictEqual(written, {});
		}
		assert.strictEqual(urlSchemeTarget(PRODUCT, { isBuilt: false, appRoot: '/src' }, '/src/electron').ephemeral, false);
	});

	test('a relative XDG_DATA_HOME is ignored', async () => {
		const { host, written } = fakeHost('');
		(host.env as Record<string, string>)['XDG_DATA_HOME'] = 'relative/share';
		await ensureLinuxUrlSchemeHandler(host, target);
		assert.deepStrictEqual(Object.keys(written), [`/home/u/.local/share/applications/${OWN}`]);
	});

	test('RoboAgent\'s own entry is refreshed to the running instance; no xdg-mime means nothing is done', async () => {
		const stale = userHandlerDesktopEntry({ ...target, command: ['/old/roboagent'] });
		const { host, calls, written } = fakeHost(OWN, { [`/home/u/.local/share/applications/${OWN}`]: stale });
		assert.strictEqual(await ensureLinuxUrlSchemeHandler(host, target), 'refreshed');
		assert.ok(written[`/home/u/.local/share/applications/${OWN}`].includes('/opt/my apps/roboagent'));
		assert.strictEqual(calls.length, 1, 'already the default');

		assert.strictEqual(await ensureLinuxUrlSchemeHandler(fakeHost('', {}, false).host, target), 'unavailable');
	});

	test('the Exec line: quoted arguments, dev builds run Electron on the source root with VSCODE_DEV', () => {
		// Re-review N2: quote-layer escapes, then every backslash doubled (string layer); % doubled.
		assert.strictEqual(quoteExecArgument('/a b/$x"`\\%u'), '"/a b/\\\\$x\\\\"\\\\`\\\\\\\\%%u"');
		assert.throws(() => quoteExecArgument('/tmp/x\nExec=evil'), /control character/);
		const dev = urlSchemeTarget(PRODUCT, { isBuilt: false, appRoot: '/src/vscode', userDataDir: '/tmp/udd' }, '/src/vscode/.build/electron/roboagent');
		assert.ok(userHandlerDesktopEntry(dev).includes('Exec="env" "VSCODE_DEV=1" "/src/vscode/.build/electron/roboagent" "/src/vscode" "--user-data-dir" "/tmp/udd" --open-url %U'));
		assert.ok(userHandlerDesktopEntry(target).includes('Exec="/opt/my apps/roboagent" --open-url %U'));
	});
});
