# Bundled toolchain extensions

RoboAgent ships the toolchain extensions it depends on as **built-in extensions** (they appear
under *Extensions → Built-in* and need no marketplace step). This page records what is bundled,
how it gets into the `.deb`, and the one case where bundling is not possible.

| Extension | Id | Version | License | How it ships |
|---|---|---|---|---|
| ESP-IDF | `espressif.esp-idf-extension` | **2.2.0** (pinned) | Apache-2.0 | Built-in (`product.json` → `builtInExtensions`) |
| C/C++ (IntelliSense + `cppdbg`) | `ms-vscode.cpptools` | 1.32.2 | MIT | Built-in (already bundled) |
| CMake Tools | `ms-vscode.cmake-tools` | 1.23.52 | MIT | Built-in (already bundled) |
| Cortex-Debug (STM32 on-chip debugging) | `marus25.cortex-debug` | 1.12.1 | MIT | **Installed on first use** of STM32 mode from Open VSX (`roboagent.stm32.ensureExtension`) |
| STM32CubeIDE for VS Code | `stmicroelectronics.stm32-vscode-extension` | 3.10.0 | ST SLA0048 (proprietary) | **Not bundled, not auto-installed** — see below |

## How bundling works in this fork

`product.json` lists marketplace extensions under `builtInExtensions`. The build
(`build/lib/builtInExtensions.ts` for dev, `bundle-marketplace-extensions-build` for packaging)
downloads each entry from the configured gallery — this fork's gallery is **Open VSX**
(`extensionsGallery.serviceUrl`) — verifies the `sha256`, and unpacks it into
`.build/builtInExtensions/<id>` (dev) or `.build/extensions/<id>` (release). The `.deb` task
(`vscode-linux-x64-build-deb`) packages `.build/extensions/**`, so anything listed there lands in
`/usr/share/roboagent/resources/app/extensions/` and shows as *Built-in*.

To bump ESP-IDF: change `version`, download
`https://open-vsx.org/vscode/gallery/publishers/espressif/vsextensions/esp-idf-extension/<version>/vspackage`,
put its `sha256sum` in the entry, and run `npm run download-builtin-extensions` (dev) or a
release build. The entry's `metadata` ids come from Open VSX's gallery `extensionquery`.

Note: an ESP-IDF *toolchain* (the `esp-idf` checkout, Python env, compilers) is **not** part of
the extension; the extension's *ESP-IDF: Configure extension* / install manager sets it up, or
point `roboagent.esp32.idfPath` at an existing checkout.

## Startup check

On activation the ROS2 Toolkit extension logs (to the **RoboAgent** output channel — never a
notification) whether each bundled extension is present:

```
Bundled extension espressif.esp-idf-extension@2.2.0 present — ESP32 mode (…)
Optional extension marus25.cortex-debug not installed — STM32 mode offers to install it on first use
```

A missing bundled extension means the packaging step dropped it; see `checkBundledExtensions()`
in `extensions/roboagent-ros2/src/modes/bundledExtensions.ts`.

## STM32: why ST's extension is not vendored (decision)

Research (2026-09-04) on *STM32CubeIDE for Visual Studio Code*
(`stmicroelectronics.stm32-vscode-extension`, MS Marketplace, v3.10.0):

1. **License.** The extension is distributed under **ST SLA0048 Rev5**. Clause 4 restricts use to
   ST processing-unit devices and clause 5 forbids any redistribution "in any manner that would
   subject the SOFTWARE PACKAGE to any Open Source Terms". RoboAgent is an MIT-licensed product;
   shipping the package inside it is exactly that. Clause 11 voids the license on any other
   redistribution.
2. **Availability.** The extension is published **only on the Microsoft Marketplace**, whose terms
   of use limit access to Microsoft's own products, and it is **not on Open VSX** — RoboAgent's
   configured gallery. So a "first-run installer" cannot legally or technically fetch it either:
   `workbench.extensions.installExtension` resolves against Open VSX and would fail.

Therefore STM32 mode is built on the **open-source stack**, all of it available on Open VSX:

- **Create/Build** need no extension at all: RoboAgent generates a CMake project for
  `arm-none-eabi-gcc` (see `docs/modes.md`).
- **Debug** uses **Cortex-Debug** (`marus25.cortex-debug`, MIT) over OpenOCD / ST-Link. It is not
  bundled because it declares four `extensionDependencies` (`mcu-debug.*`) that would all have
  to ship too; instead `roboagent.stm32.ensureExtension` installs it (with its dependencies)
  from Open VSX the first time STM32 mode is selected, after a notification. Until then Debug
  falls back to the bundled cpptools `cppdbg` driver talking to an OpenOCD GDB server.
- Users who want ST's official extension (CubeMX integration, ST-Link server) can install it
  themselves under ST's terms; the *ensure* command links to the instructions. RoboAgent detects
  it and logs its presence, and the generated STM32 projects remain plain CMake projects that
  ST's extension can open.
