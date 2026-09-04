# RoboAgent — Implementation Detail

Per-requirement context, scope, files, and verification. Task status lives in
`implementation_tasks.md`; specs live in `requirements_docs/`.

---

## REQ-6 — Mode selector + Create / Build / Debug toolbar (2026-09-04)

**Context.** One toolbar, three toolchains. A **Mode** (`stm32 | esp32 | ros2`) chooses what
**Create**, **Build** and **Debug** do; the ESP-IDF extension ships built-in and the STM32 debug
stack is installed on first use. User-facing description in `docs/modes.md`; the bundling and
licensing research (why ST's extension is neither vendored nor auto-installed) in `docs/extensions.md`.

**Where things live.**
- Core: `contrib/roboagent/browser/roboagentModeToolbar.ts` (+ `media/roboagentModeToolbar.css`) —
  four `Action2`s in `MenuId.TitleBarAdjacentCenter` forwarding to extension commands (the
  Package-Explorer forwarding pattern), rendered through `IActionViewItemService` so Create is a
  real `--vscode-button-background` button and Mode a `Mode: STM32 ▾` label; enablement/labels
  come from the extension's context keys. `product.json`: `builtInExtensions` += ESP-IDF 2.2.0.
- Extension `extensions/roboagent-ros2/src/modes/`: `modeService.ts` (state, keys, status bar,
  auto-detect + Undo), `modeProvider.ts` (strategy interface), `modeHost.ts` / `vscodeModeHost.ts`
  (tasks, terminals, debug, messages — the seam the tests fake), `detect.ts`, `scaffold.ts`,
  `toolchains.ts`, `wizardSteps.ts` (lifted from `newProject.ts`, now shared), `modeCommands.ts`,
  `bundledExtensions.ts`, `output.ts`; per mode `stm32/` (`mcuDatabase.ts`, `generator.ts`,
  `stm32ModeProvider.ts`, `ensureExtension.ts`), `esp32/`, `ros2/` (each `generator.ts` +
  provider). Generators are pure (spec → files) and unit-tested; providers are thin.
- Tests: `src/test/*.test.ts` — run with `npm run test-unit` (tsc emit + mocha, Node only, no
  Electron); `vscodeStub.ts` hooks `require('vscode')`, `fakeHost.ts` records side effects.

**Decisions.**
- Toolbar home: the title bar's center-adjacent slot (always present with the custom title bar,
  room for a text button) rather than `editor/title` (icon-only, per-editor).
- `Ctrl+Alt+D` for Debug — `Ctrl+Shift+D` is the Run and Debug view. `Ctrl+Shift+B` is only
  taken over while `roboagent.modeProjectPresent`.
- STM32 MCU data is a typed TS module (`mcuDatabase.ts`), not a runtime JSON file: same data,
  type-checked, importable by tests; adding a part is still a data edit.
- ESP-IDF 2.x keeps almost no `idf.*` workspace settings (setups moved to EIM), so generated
  `.vscode/settings.json` records `roboagent.*` keys and the chip is pinned via `sdkconfig.defaults`.
- ROS2 Build/Debug resolve the colcon root from the workspace folder; seeding `findColconRoot()`
  from the active file returns the package directory (it has a `package.xml`).

**Verification.** Core tsc, extension tsc, eslint (0 warnings on new files), unit + smoke tests
(the smoke test compiles the STM32 skeletons with the installed `arm-none-eabi-gcc`); see the
task board. E2E in the live app is the remaining item (6.12).

## REQ-5 — ROS2 Communication Graph View (HIGH)

**Spec:** `requirements_docs/roboagent_req_ros2_graph_view.md`

**Context.** REQ-2 gave the WKG a communication model (`communications`, `topics` registry);
REQ-5 renders it: an interactive bipartite node–topic graph (publisher → topic → subscriber,
service/action links dashed) in a full-size workbench **editor pane** — the first visual payoff
of the WKG and the surface live introspection will later annotate. Static (source-scanned)
only; no running system needed.

**Architecture.** Fork-side only (needs `IRos2WorkspaceService` + workbench editor panes —
not available to extensions). Pattern cribbed from the Running Extensions editor: singleton
readonly `EditorInput` + `EditorPane` + serializer. Rendering is dependency-free SVG (no
Cytoscape): the WKG is dozens of nodes, and SVG + theme CSS variables is theme-native and
testable.

**Files (all `src/vs/workbench/contrib/roboagent/`).**
- `common/ros2GraphLayout.ts` — NEW, pure: WKG → positioned nodes/topics/edges. Longest-path
  layering over the pub/sub digraph (cycle-safe), barycenter ordering, fixed spacing. No DOM.
- `browser/ros2GraphEditorInput.ts` — NEW: `roboagent.ros2GraphInput`, singleton, readonly,
  `roboagent-graph:` scheme resource, `IEditorSerializer` for reopen-on-restart.
- `browser/ros2GraphEditor.ts` — NEW `EditorPane` (`roboagent.ros2GraphEditor`): SVG render,
  wheel-zoom + drag-pan (viewport transform preserved across re-render), click highlight /
  dim, `IHoverService` hovers, `onDidChangeGraph` re-render, localized empty state with Index
  command link.
- `browser/media/ros2Graph.css` — NEW: workbench color variables only.
- `browser/ros2WorkspaceActions.ts` — EDIT: `ShowRos2GraphAction` (f1 + view-title icon).
- `browser/roboagent.contribution.ts` — EDIT: register pane, serializer, action import.
- `test/common/ros2GraphLayout.test.ts` — NEW: layering, determinism, cycles, service edges.

**Verification.** DONE 2026-07-18 — layout unit tests (7) pass; fork + extension tsc clean;
E2E on `../fixtures/ros2ws` verified every acceptance criterion live (singleton open from
palette/title icon, chain + dashed service edges, click-highlight/clear, wheel zoom, hover
cards, live re-render on re-index, restart restore, empty state, light+dark). Results table
in `implementation_tasks.md`; website writeup + screenshots in `finalized_features/`.
Implementation notes: SVG elements must take `class` via attrs (`$.SVG('svg.cls')` throws —
SVGElement.className is read-only); back-edges (service links, cycles) route source-left →
below the rows → target-right so they never leave the canvas; `onDidChangeIndexing` was
added to `IRos2WorkspaceService` (start+end of every pass) — the status bar consumes it too.

---

## REQ-4 — Project Type Selection & New-Project Wizard (HIGH)

**Spec:** `requirements_docs/roboagent_req_project_type_selection.md`

**Context.** New-project on-ramp. User picks Control Level (High/Low) → Framework/Target →
Environment; the wizard scaffolds a starter, records `.roboagent/project.json`, and opens+indexes
the folder. Drives downstream toolkit behavior and the status-bar project-type indicator.

**Scope (this slice).** Selection + scaffold + record + open/index. Deploy/flash/on-chip debug
are explicit follow-ups.

**Files (all in the new `extensions/roboagent-ros2/` extension).**
- `src/targets/targetDatabase.ts` — typed, extensible catalog (STM32, ESP32 seeded).
- `src/newProject.ts` — `roboagent.newProject` stepped wizard.
- `templates/{ros2-ament,opencv-python,nlp-python,stm32-platformio,esp32-platformio}/`.
- Walkthrough step (WS5) + optional fork getting-started entry.
- Status bar (WS2) reads `.roboagent/project.json`.

**Verification.** Command palette + walkthrough launch the wizard; High→ROS2→Host and Low→STM32
each scaffold, write project.json, open/index; status bar reflects type; missing toolchain warns
not blocks; adding a 3rd MCU is data-only.

---

## REQ-3 — RoboAgent ROS2 Toolkit (IDE feel: Build → Run → Debug → Introspect)

**Context.** The fork already has the intelligence layer (WKG `IRos2WorkspaceService`, activity-bar
ROS2 container, Package Explorer tree). REQ-3 adds the IDE surfaces: colcon Build Center, Run/Debug
with bundled adapters, a ROS2 status indicator, package/node context menus, and an onboarding
walkthrough. Reference: QNX Momentics (Build → Run → Debug → Introspect).

**Architecture — hybrid.** A new builtin extension `extensions/roboagent-ros2/` owns everything an
extension *can* contribute (commands, `editor/title` buttons, task provider + problem matcher,
debuggers/adapters, walkthrough, keybindings). Two fork-only surfaces stay in
`contrib/roboagent/` because an extension cannot add a workbench part, react to a workbench
singleton, or register new `MenuId`s: the **status-bar indicator** (must read
`IRos2WorkspaceService`) and the **Package-Explorer context menu** (custom tree).

**Verified codebase facts (2026-07-07).**
- WKG service: `common/ros2WorkspaceService.ts` (interface: `packages`, `nodes`, `launchFiles`,
  `communications`, `topics`; `onDidChangeGraph`, `isIndexing`, `getGraph()`), impl in
  `browser/ros2WorkspaceService.ts`. Node model has `language:'cpp'|'python'` and `sourceHint`.
- Package Explorer: `browser/ros2PackageExplorerView.ts` + `…Tree.ts` (WorkbenchAsyncDataTree,
  typed elements). Contribution wiring in `browser/roboagent.contribution.ts`; indexing action in
  `browser/ros2WorkspaceActions.ts`.
- **`extensions/roboagent-defaults/` is functional**, not dead: `dist/extension.js` (421 lines)
  provides working `roboagent-cpp`/`roboagent-cmake` task providers (g++, colcon --symlink-install,
  cmake configure/build/run/clean), command handlers, and status-bar buttons. Only its debug side
  (`cppdbg`/`debugpy` config providers with no bundled adapter) fails. **→ Keep until superseded,
  then delete** (correcting the original plan's "delete now, nothing to migrate").
- Builtin TS extensions must be listed in `build/gulpfile.extensions.ts` `compilations` to compile.
  Crib shape from `extensions/merge-conflict/`.
- No debug adapters ship except js-debug. **→ bundle debugpy (pure-Python); C++ = detect system
  lldb-dap/gdb else terminal fallback** (avoids large binary fetch; user-approved 2026-07-07).

**Work items.** WS0 scaffold+build-wire; WS1 commands; WS3 colcon tasks+matcher; WS4 debug
(debugpy + C++ fallback); WS2 fork status bar; WS7 fork context menus; WS5 walkthrough; WS6 polish.
Detail per WS is in the inline plan / task board.

**Fork files touched.**
- `browser/ros2StatusBar.ts` (new) — `IWorkbenchContribution` + `@IStatusbarService`, reacts to
  `onDidChangeGraph`/`isIndexing`, reads `$ROS_DISTRO` and `.roboagent/project.json`.
- `browser/roboagent.contribution.ts` (edit) — register `Ros2StatusBar`.
- `browser/ros2WorkspaceActions.ts` (edit) — context-menu `Action2`s + `roboagent.itemType` context key.
- `browser/ros2PackageExplorerView.ts` (edit) — `onContextMenu` wiring, inject `IMenuService`.

**Verification.** See `implementation_tasks.md` → Verification gates. E2E via launch skill on a
fixture colcon workspace.
