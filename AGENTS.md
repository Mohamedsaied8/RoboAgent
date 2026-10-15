# VS Code Agents Instructions

This file provides instructions for AI coding agents working with the VS Code codebase.

For detailed project overview, architecture, coding guidelines, and validation steps, see the [Copilot Instructions](.github/copilot-instructions.md).

---

# RoboAgent

This repository is **RoboAgent**, an AI-powered IDE for robotics and embedded systems built as a fork of
VS Code. The product, plan and code belong to Mohamed Saied.

## Where things are

| What | Where |
|---|---|
| Product blueprint and requirement specs | `requirements_docs/` (`roboagent_blueprint_part1..5.md`, `roboagent_req_*.md`) |
| Per-requirement detail (context, files, decisions, deferrals) | `implementation.md` (newest first) |
| Task board | `implementation_tasks.md` (contains one intentional NUL byte: use `grep -a`) |
| RoboAgent workbench code | `src/vs/workbench/contrib/roboagent/` (core patches are marked `// RoboAgent:`) |
| Built-in extensions | `extensions/roboagent-ros2/` (ROS2 / STM32 / ESP32 modes), `extensions/roboagent-ai/` (chat + gateway) |
| Firmware agents (REQ-7) | `packages/firmware-agents/` |
| REQ-7 implementation plan (outside this repo) | `../agents_dev/agents_plan.md` |

RoboAgent sources carry the "Copyright (c) RoboAgent" MIT header (ESLint enforces it for the folders
listed in `eslint.config.js`).

## REQ-7 — Firmware agents (Dev · Debug · Test)

Three cooperating AI agents for STM32 and ESP32 firmware (bare-metal or FreeRTOS): a **Dev** agent
(toolchain, build, diagnostics, size, flash, change requests), a **Debug** agent (OpenOCD + GDB/MI:
breakpoints, watch expressions, memory, registers, SVD-decoded SFRs, fault/panic decoding, FreeRTOS
awareness) and a **Test** agent (GoogleTest + GMock on the host, GoogleTest or Unity on the target,
debugger-driven HIL checks), coordinated through a message bus.

**Constraints.**
- `packages/firmware-agents` is host-agnostic: no `vscode` or `vs/*` imports (a test enforces it) and
  zero runtime dependencies. RoboAgent, a `fwagent` CLI and an MCP server are planned host adapters.
- SOLID with explicit patterns: tools are Commands, the agent loop is a Template Method, build systems,
  flashers, toolchains and dependencies are Strategies chosen by factories, hosts are Adapters behind
  ports (`IAgentHost`, `IFileSystem`, `IToolStore`, `ISystemProbe`, `ILlmClient`).
- LLM: OpenRouter through an OpenAI-compatible client; key from `OPENROUTER_API_KEY`, model from
  `OPENROUTER_MODEL`. Never commit or log keys.
- GDB always evaluates watch expressions; never write a custom C expression evaluator.
- Every non-read tool goes through approval, enforced inside the agent loop. Installs of pinned,
  SHA-256-verified tools into the user-space tool store are approved automatically by default
  (`ROBOAGENT_INSTALL_POLICY=ask` opts out); root-level steps, edits, builds and flashing always ask.
- No hard-coded system paths: programs, udev folders and the tool store location are found by search
  or from the environment. Programs that run as root must be root-owned along their whole link chain,
  with no ACLs.

**Progress (2026-10-15)** — branch `firmware-agents` on `github.com/Mohamedsaied8/RoboAgent`:

| Phase | Status |
|---|---|
| P0 agent kernel, OpenRouter client, Node adapters | done |
| P1 Dev agent (verified with the real arm-none-eabi-gcc + CMake on the STM32 fixture) | done |
| P2a self-install of debug dependencies, STM32 + ESP32 (verified with real vendor downloads) | done |
| P2a STM32 debug session (GDB/MI, OpenOCD, SVD, fault decode, Debug agent; verified on a Blue Pill STM32F103C8T6 + ST-Link V2) | done |
| P2b ESP32 debug, P2c FreeRTOS awareness, P2d optional Rust/probe-rs spike | to do |
| P3 Test agent + orchestration (bug-fix loop) | to do |
| P4 RoboAgent extension, `fwagent` CLI, MCP server | to do |

**What is left** (full list in `../agents_dev/agents_plan.md` §0.1, deferrals in `implementation.md`):
P2b–P4; debug-session follow-ups (side-effect reads through expressions/conditions, the localhost GDB-port race); installer follow-ups (`HTTPS_PROXY`, a manifest refresh
script, ESP-IDF tools under `~/.espressif`, Windows driver checks); P4 wiring of the install opt-out
setting/flag and `createDefaultToolStore()`; open decision on the ESP32 validation board.

**Verify.** `cd packages/firmware-agents && npm test` (215 tests). Optional:
`FWAGENT_NETWORK_TESTS=1 npm test` (real vendor downloads, ~90 MB; `=full` adds the 300 MB Arm
toolchain); live LLM tests need `OPENROUTER_API_KEY` + `OPENROUTER_MODEL`. The real-toolchain tests
skip when `arm-none-eabi-gcc`/`cmake` are missing. `FWAGENT_HW=1 npm test` runs the Debug agent on a real
Blue Pill (STM32F103C8T6) over an ST-Link V2 — it **reflashes the board**. The GDB/MI layer is also tested by
replaying a session recorded on that board (`src/test/fixtures/stm32f103-bluepill.mi.txt`).

## Working rules

- **Definition of Done** for every task: (1) developed — `tsc` and ESLint clean; (2) reviewed by an
  independent reviewer; (3) tested and verified, with a regression test for every bug found;
  (4) security-checked; (5) committed and pushed with a readable message that explains the change.
- **Authorship:** the user is the sole author. Never add `Co-Authored-By`, "Generated with …" or any
  AI attribution to commits, PRs or files.
- **Remotes:** push only to `roboagent` (`github.com/Mohamedsaied8/RoboAgent`). `origin` is
  `microsoft/vscode` — never push there, and open PRs against `Mohamedsaied8/RoboAgent:main`
  (the repo is a GitHub fork, so GitHub suggests the upstream by default).
- **Staging:** the working tree often holds the user's own uncommitted edits (e.g. in
  `extensions/roboagent-ros2`, `build/`, `eslint.config.js`). Stage only the files of the current task.
- **ESLint** needs Node 22: `~/.nvm/versions/node/v22.22.1/bin/node node_modules/eslint/bin/eslint.js <paths>`.
- **Releases** (`.deb`): built under Node 22 with `gulp vscode-linux-x64-min` → `vscode-linux-x64-prepare-deb` → `vscode-linux-x64-build-deb`; see `implementation_tasks.md`.
