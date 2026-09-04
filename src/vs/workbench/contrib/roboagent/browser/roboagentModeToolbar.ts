/*---------------------------------------------------------------------------------------------
 *  Copyright (c) RoboAgent. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/*---------------------------------------------------------------------------------------------
 *  RoboAgent — the Mode | Create | Build | Debug toolbar in the title bar.
 *
 *  Lives next to the command center (MenuId.TitleBarAdjacentCenter, always present with the
 *  custom title bar). The four actions forward to the roboagent-ros2 extension commands
 *  (`roboagent.selectMode` / `create` / `build` / `debug`), which own the mode logic; the
 *  extension publishes the `roboagent.mode` and `roboagent.modeProjectPresent` context keys
 *  that drive labels, tooltips and enablement here. Rendering goes through
 *  IActionViewItemService so Create can be a real primary-styled button and Mode a
 *  dropdown-looking label, instead of bare codicons.
 *--------------------------------------------------------------------------------------------*/

import './media/roboagentModeToolbar.css';
import * as dom from '../../../../base/browser/dom.js';
import { BaseActionViewItem, IBaseActionViewItemOptions } from '../../../../base/browser/ui/actionbar/actionViewItems.js';
import { IAction } from '../../../../base/common/actions.js';
import { Codicon } from '../../../../base/common/codicons.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { ThemeIcon } from '../../../../base/common/themables.js';
import { localize, localize2 } from '../../../../nls.js';
import { IActionViewItemService } from '../../../../platform/actions/browser/actionViewItemService.js';
import { Action2, MenuId, registerAction2 } from '../../../../platform/actions/common/actions.js';
import { ICommandService } from '../../../../platform/commands/common/commands.js';
import { ContextKeyExpr, ContextKeyExpression, IContextKeyService } from '../../../../platform/contextkey/common/contextkey.js';
import { IInstantiationService, ServicesAccessor } from '../../../../platform/instantiation/common/instantiation.js';
import { IKeybindingService } from '../../../../platform/keybinding/common/keybinding.js';
import { IWorkbenchContribution } from '../../../common/contributions.js';

/** Context keys published by the roboagent-ros2 extension's ModeService. */
export const ROBOAGENT_MODE_KEY = 'roboagent.mode';
export const ROBOAGENT_PROJECT_PRESENT_KEY = 'roboagent.modeProjectPresent';

const MODE_LABELS: Readonly<Record<string, string>> = { stm32: 'STM32', esp32: 'ESP32', ros2: 'ROS2' };
const MODE_ICONS: Readonly<Record<string, ThemeIcon>> = { stm32: Codicon.circuitBoard, esp32: Codicon.radioTower, ros2: Codicon.rocket };

/** Only show the toolbar once the extension has published a mode. */
const HAS_MODE = ContextKeyExpr.has(ROBOAGENT_MODE_KEY);
const PROJECT_PRESENT = ContextKeyExpr.has(ROBOAGENT_PROJECT_PRESENT_KEY);

const CATEGORY = localize2('roboagent.category', "RoboAgent");

interface IToolbarActionDescriptor {
	readonly id: string;
	readonly title: string;
	readonly forwardTo: string;
	readonly order: number;
	readonly icon?: ThemeIcon;
	readonly kind: 'mode' | 'create' | 'icon';
	readonly precondition?: ContextKeyExpression;
}

const TOOLBAR_ACTIONS: readonly IToolbarActionDescriptor[] = [
	{ id: 'roboagent.toolbar.selectMode', title: localize('roboagent.toolbar.mode', "Mode"), forwardTo: 'roboagent.selectMode', order: 10, kind: 'mode' },
	{ id: 'roboagent.toolbar.create', title: localize('roboagent.toolbar.create', "Create"), forwardTo: 'roboagent.create', order: 11, kind: 'create', icon: Codicon.add },
	{ id: 'roboagent.toolbar.build', title: localize('roboagent.toolbar.build', "Build"), forwardTo: 'roboagent.build', order: 12, kind: 'icon', icon: Codicon.tools, precondition: PROJECT_PRESENT },
	{ id: 'roboagent.toolbar.debug', title: localize('roboagent.toolbar.debug', "Debug"), forwardTo: 'roboagent.debug', order: 13, kind: 'icon', icon: Codicon.debugAlt, precondition: PROJECT_PRESENT },
];

function registerToolbarAction(desc: IToolbarActionDescriptor): void {
	registerAction2(class extends Action2 {
		constructor() {
			super({
				id: desc.id,
				title: { value: desc.title, original: desc.title },
				category: CATEGORY,
				icon: desc.icon,
				f1: false,   // the palette entries live in the extension (roboagent.create etc.)
				precondition: desc.precondition,
				menu: [{ id: MenuId.TitleBarAdjacentCenter, order: desc.order, when: HAS_MODE }]
			});
		}
		override async run(accessor: ServicesAccessor): Promise<void> {
			await accessor.get(ICommandService).executeCommand(desc.forwardTo);
		}
	});
}

/**
 * Custom rendering for one toolbar entry. Re-renders whenever the mode / project context keys
 * change so the Mode label and the "(STM32)" tooltips follow the extension's state.
 */
class RoboAgentToolbarItem extends BaseActionViewItem {

	private content: HTMLElement | undefined;
	private iconElement: HTMLElement | undefined;
	private labelElement: HTMLElement | undefined;

	constructor(
		action: IAction,
		options: IBaseActionViewItemOptions,
		private readonly desc: IToolbarActionDescriptor,
		@IContextKeyService private readonly contextKeyService: IContextKeyService,
		@IKeybindingService private readonly keybindingService: IKeybindingService,
	) {
		super(undefined, action, options);
		this._register(this.contextKeyService.onDidChangeContext(e => {
			if (e.affectsSome(new Set([ROBOAGENT_MODE_KEY, ROBOAGENT_PROJECT_PRESENT_KEY]))) {
				this.refresh();
			}
		}));
	}

	override render(container: HTMLElement): void {
		super.render(container);
		this.content = dom.append(container, dom.$(`.roboagent-toolbar-item.${this.desc.kind}`));
		this.content.tabIndex = 0;
		this.content.setAttribute('role', 'button');

		if (this.desc.kind === 'mode') {
			this.iconElement = dom.append(this.content, dom.$('span.codicon'));
			this.labelElement = dom.append(this.content, dom.$('span.roboagent-toolbar-label'));
			dom.append(this.content, dom.$(`span${ThemeIcon.asCSSSelector(Codicon.chevronDown)}`));
		} else if (this.desc.kind === 'create') {
			dom.append(this.content, dom.$(`span${ThemeIcon.asCSSSelector(this.desc.icon ?? Codicon.add)}`));
			this.labelElement = dom.append(this.content, dom.$('span.roboagent-toolbar-label'));
		} else {
			dom.append(this.content, dom.$(`span${ThemeIcon.asCSSSelector(this.desc.icon ?? Codicon.tools)}`));
		}
		this.refresh();
	}

	private get mode(): string {
		return this.contextKeyService.getContextKeyValue<string>(ROBOAGENT_MODE_KEY) ?? '';
	}

	private get modeLabel(): string {
		return MODE_LABELS[this.mode] ?? this.mode.toUpperCase();
	}

	private refresh(): void {
		if (!this.content) {
			return;
		}
		if (this.desc.kind === 'mode') {
			const icon = MODE_ICONS[this.mode] ?? Codicon.circuitBoard;
			if (this.iconElement) {
				this.iconElement.className = `codicon ${ThemeIcon.asClassName(icon)}`;
			}
			if (this.labelElement) {
				this.labelElement.textContent = localize('roboagent.toolbar.modeLabel', "Mode: {0}", this.modeLabel);
			}
		} else if (this.desc.kind === 'create' && this.labelElement) {
			this.labelElement.textContent = this.desc.title;
		}
		this.updateTooltip();
		this.updateEnabled();
		this.content.setAttribute('aria-label', this.getTooltip() ?? this.desc.title);
	}

	protected override getTooltip(): string | undefined {
		const keybinding = this.keybindingService.lookupKeybinding(this.desc.forwardTo)?.getLabel();
		const suffix = keybinding ? ` (${keybinding})` : '';
		switch (this.desc.kind) {
			case 'mode':
				return localize('roboagent.toolbar.modeTooltip', "RoboAgent Mode: {0} — click to change", this.modeLabel);
			case 'create':
				return localize('roboagent.toolbar.createTooltip', "Create a new {0} project", this.modeLabel) + suffix;
			default: {
				const base = localize('roboagent.toolbar.actionTooltip', "{0} ({1})", this.desc.title, this.modeLabel);
				const present = !!this.contextKeyService.getContextKeyValue<boolean>(ROBOAGENT_PROJECT_PRESENT_KEY);
				return present ? base + suffix : localize('roboagent.toolbar.noProjectTooltip', "{0} — no {1} project in this workspace", base, this.modeLabel);
			}
		}
	}
}

/**
 * Registers the custom view items for the four toolbar actions. The actions themselves are
 * registered at module load (see below) so the menu is populated before any window renders.
 */
export class RoboAgentModeToolbarContribution extends Disposable implements IWorkbenchContribution {

	static readonly ID = 'roboagent.modeToolbar';

	constructor(
		@IActionViewItemService actionViewItemService: IActionViewItemService,
		@IInstantiationService instantiationService: IInstantiationService,
	) {
		super();
		for (const desc of TOOLBAR_ACTIONS) {
			this._register(actionViewItemService.register(
				MenuId.TitleBarAdjacentCenter,
				desc.id,
				(action, options) => instantiationService.createInstance(RoboAgentToolbarItem, action, options, desc)
			));
		}
	}
}

for (const desc of TOOLBAR_ACTIONS) {
	registerToolbarAction(desc);
}
