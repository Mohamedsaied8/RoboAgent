# Modes: STM32 / ESP32 / ROS2 — the Create · Build · Debug toolbar

RoboAgent has a **Mode** that decides what the three toolbar buttons do. The toolbar sits in
the title bar, right of the command center:

```
┌───────────────────────────────────────────────────────────────────────────────┐
│ ☰  RoboAgent      [ 🔍 Search ]   ⚡ Mode: STM32 ▾   [ + Create ]   🔧   🐞     │
└───────────────────────────────────────────────────────────────────────────────┘
```

*(screenshot placeholder: `docs/images/modes-toolbar.png`)*

| Button | Command | What it does |
|---|---|---|
| **Mode: X ▾** | `roboagent.selectMode` | QuickPick with STM32 / ESP32 / ROS2 (icon + one-line description). Also a clickable status-bar item on the left. |
| **Create** (primary, blue) | `roboagent.create` | The current mode's Create wizard. |
| **Build** `$(tools)` | `roboagent.build` · `Ctrl+Shift+B` | Builds the current project; disabled until a project of the current mode is detected. Tooltip: *Build (STM32)*. |
| **Debug** `$(debug-alt)` | `roboagent.debug` · `Ctrl+Alt+D` | Starts the mode's debug session; offers to build first when nothing is built. |

`Ctrl+Shift+D` was not used for Debug: VS Code binds it to *Show Run and Debug*. `Ctrl+Shift+B`
overrides *Run Build Task* only while a mode project is present (`roboagent.modeProjectPresent`).

Mode-specific aliases exist for the palette and keybindings: `roboagent.<mode>.create|build|debug`.

## How the mode is chosen and stored

1. `workspaceState` — set by *Select Mode* or by auto-detection; wins for that workspace.
2. `globalState` — the last selection anywhere; fallback for new workspaces.
3. Setting `roboagent.mode` (`stm32 | esp32 | ros2`, default `ros2`) — last resort. Editing the
   setting mirrors it into the current workspace.

**Auto-detect on open** (only when nothing is stored for the workspace):

| Detected | Marker |
|---|---|
| `stm32` | a `*.ioc` (≤ 2 levels deep), an `STM32CubeIDE/` folder, or `cmake/arm-none-eabi.cmake` |
| `esp32` | `sdkconfig` / `sdkconfig.defaults`, or a root/`main/` `CMakeLists.txt` mentioning `idf_component_register` or `IDF_PATH` |
| `ros2` | `package.xml` at the root or under `src/` |

STM32 and ESP32 markers win over `package.xml` (micro-ROS firmware). A non-blocking
notification *"Detected ESP32 project — Mode set to ESP32"* has an **Undo** action.

Context keys for `when` clauses: `roboagent.mode` (`stm32|esp32|ros2`) and
`roboagent.modeProjectPresent` (boolean, refreshed when marker files appear/disappear).

## STM32 mode

*(screenshot placeholder: `docs/images/stm32-create.png`)*

**Create** — 5 steps, every one cancellable (Escape) with Back: name → location → **target MCU**
(searchable list from the bundled catalog in `src/modes/stm32/mcuDatabase.ts` — F0/F1/F3/F4/F7/
G0/G4/H7/L0/L4/L5/U5/WB, 37 parts — or any free-text STM32 part number, resolved by family) →
**Executable / Library** → **CMake + arm-none-eabi-gcc** (default) or Makefile.

Generated (executable): `CMakeLists.txt` with the right `-mcpu -mfpu -mfloat-abi` for the core,
`cmake/arm-none-eabi.cmake`, `<PART>_FLASH.ld` stub sized from the catalog, `startup_<device>.s`
placeholder, `Core/Src/main.c`, `Core/Inc/main.h`, `.vscode/{c_cpp_properties,launch,tasks,settings}.json`,
`README.md`. Library: `add_library(... STATIC ...)`, `Inc/`, `Src/`, no main/linker/startup.
Files are staged in a temp directory and moved into place only at the end.

**Build** — `cmake -S . -B build && cmake --build build` (or `make -j`) as a task in the
*RoboAgent: STM32 build* terminal, errors in Problems via `$roboagent-gcc`. The compiler comes
from `PATH` or `roboagent.stm32.toolchainPath` (passed as `-DTOOLCHAIN_PATH=`, never written into
the project).

**Toolchain check** — the host tools STM32 mode needs cannot be bundled, so Create, Build and
Debug first probe for them: `arm-none-eabi-gcc` (on `PATH`, in `roboagent.stm32.toolchainPath`,
or in the well-known install folders — a setting without a compiler in it is ignored), `cmake`
or `make` (whichever the project uses), `openocd`, and a GDB (`arm-none-eabi-gdb` next to the
compiler or on `PATH`, else `gdb-multiarch`). Create needs the compiler, Build the compiler and
build tool, Debug OpenOCD and GDB. When something is missing a notification lists it and offers:

| Action | What happens |
|---|---|
| **Install with apt / dnf / pacman / Homebrew…** | Runs the package-manager command for exactly the missing tools in a *RoboAgent: STM32 toolchain install* terminal (so `sudo` can ask for a password), e.g. `sudo apt-get update && sudo apt-get install -y gcc-arm-none-eabi libnewlib-arm-none-eabi libstdc++-arm-none-eabi-newlib openocd gdb-multiarch`. Run Create/Build/Debug again when it finishes. |
| **Download Toolchain…** (no package manager found) | Opens the Arm GNU Toolchain download page. |
| **Use Existing Toolchain…** (compiler or GDB missing) | Folder picker; the folder or its `bin/` must contain `arm-none-eabi-gcc`. Stored in `roboagent.stm32.toolchainPath` and the action continues. |
| **Create Anyway** (Create only) | Scaffolds the project; Build offers the installer later. |

The same check runs on demand as *RoboAgent: STM32: Check Toolchain* (`roboagent.stm32.ensureToolchain`,
palette in STM32 mode) and its result is logged at startup.

**Debug** — launches the Cortex-Debug/OpenOCD configuration when Cortex-Debug is installed
(with `armToolchainPath` / `gdbPath` set when the compiler is off `PATH` or only `gdb-multiarch`
exists), else cpptools `cppdbg` against an OpenOCD GDB server with the GDB the check found. No
`.elf` → *Build now?* first. Interface script from `roboagent.stm32.openocdInterface` (`stlink`
default). Cortex-Debug itself is offered once when STM32 mode is selected
(`roboagent.stm32.ensureExtension`).

## ESP32 mode

*(screenshot placeholder: `docs/images/esp32-create.png`)*

**Create** — name → location → chip (`esp32`, `esp32s2`, `esp32s3`, `esp32c3`, `esp32c6`,
`esp32h2`) → template (`hello_world`, `blink`, or hand over to the bundled ESP-IDF extension's
*New Project* wizard). Generates the IDF layout (`CMakeLists.txt`, `main/`, `sdkconfig.defaults`
pinning `CONFIG_IDF_TARGET`), `.vscode/*`, and runs `idf.py set-target <chip>` in a terminal when
an ESP-IDF installation is found (see *ESP-IDF check* below).

**ESP-IDF check** — the ESP-IDF *extension* ships with RoboAgent, the ESP-IDF *toolchain* does
not. Create, Build and Debug therefore first look for an installation, in this order:
`roboagent.esp32.idfPath` → `$IDF_PATH` → the ESP-IDF extension's current setup
(`idf.currentSetup`) → installs registered by the ESP-IDF Installation Manager
(`~/.espressif/tools/eim_idf.json`, `C:\Espressif\tools\eim_idf.json`; `idf.eimIdfJsonPath`
overrides) → `~/esp/esp-idf`, `~/esp/v*/esp-idf`, `~/.espressif/v*/esp-idf`. A checkout counts
when it has `tools/idf.py`. When nothing is found, a notification says so and offers:

| Action | What happens |
|---|---|
| **Install ESP-IDF…** | Opens the ESP-IDF Installation Manager through the bundled extension (`espIdf.installManager` downloads and launches it); without the extension, opens its download page. Create/Build/Debug are not continued — run them again once the install finishes; the new install is picked up from `eim_idf.json`. |
| **Use Existing Install…** | Folder picker; the folder must contain `tools/idf.py`. Stored in `roboagent.esp32.idfPath` (user settings) and the action continues. |
| **Create Anyway** (Create only) | Scaffolds the project without running `idf.py set-target`; `sdkconfig.defaults` still pins the chip. |

Build and Debug do nothing until an installation exists. The same check runs on demand as
*RoboAgent: ESP32: Check ESP-IDF Installation* (`roboagent.esp32.ensureIdf`, palette in ESP32
mode), and the result is logged to the RoboAgent output channel at startup.

**Build** — `espIdf.buildDevice` (ESP-IDF extension) when installed; otherwise
`. $IDF_PATH/export.sh && idf.py build` as a task.

**Debug** — the extension's `gdbtarget` session; if it does not start (no board / no OpenOCD),
offers **Flash + Monitor** (`espIdf.buildFlashMonitor`, or `idf.py -p <port> flash monitor`).

## ROS2 mode

*(screenshot placeholder: `docs/images/ros2-create.png`)*

**Create** — workspace (current colcon workspace / new `<name>/src` / existing folder) →
package name → build type (`ament_cmake` C++ node, `ament_python`, `ament_cmake` library,
interface package with msg/srv) → dependencies (multi-select: `rclcpp`, `rclpy`, `std_msgs`,
`sensor_msgs`, `geometry_msgs`, `nav_msgs`, `tf2_ros`). Runs `ros2 pkg create` in a scratch
directory, adds `launch/<pkg>.launch.py` (and its install rule), moves the result into `src/`
atomically, then re-indexes the workspace (`roboagent.indexRos2Workspace`) so the Package
Explorer shows it immediately. Without ROS 2 installed, an equivalent package is generated
offline.

**Build** — `colcon build --symlink-install` (the toolkit's existing command line), scoped with
`--packages-select` to the package of the active file, with `ROS_DISTRO` from
`roboagent.ros2.distro` (or the newest `/opt/ros/*`).

**Debug** — pick a built node from `install/*/lib/*` (Python nodes → debugpy, C++ → lldb-dap/gdb
via the existing `roboagent.debugNode` path).

## Settings

| Setting | Purpose |
|---|---|
| `roboagent.mode` | Fallback mode (`ros2`). |
| `roboagent.stm32.toolchainPath` | Directory with `arm-none-eabi-*`; empty = PATH / auto-discovery (`/opt/gcc-arm-none-eabi*`, xPack). Set by **Use Existing Toolchain…**; ignored when it holds no compiler. |
| `roboagent.stm32.openocdInterface` | `stlink` / `jlink` / `cmsis-dap`. |
| `roboagent.esp32.idfPath` | ESP-IDF checkout; empty = auto-detect (`$IDF_PATH`, the extension's setup, the Installation Manager registry, `~/esp`, `~/.espressif`). Set by **Use Existing Install…**. |
| `roboagent.esp32.port` | Serial port for flash/monitor. |
| `roboagent.ros2.distro` | ROS 2 distro to source; empty = `$ROS_DISTRO` / newest `/opt/ros/*`. |

Everything logs to the **RoboAgent** output channel.

## Testing

```bash
cd extensions/roboagent-ros2 && npm run test-unit      # mocha unit + smoke tests (Node only)
```

The smoke test generates every skeleton into a temp dir; with `arm-none-eabi-gcc` + `cmake`
installed it configures and builds the STM32 projects for real, with `$IDF_PATH` it runs
`idf.py reconfigure`, and with `ROBOAGENT_SMOKE_BUILD=1` + ROS 2 it runs `colcon build`.

### Manual checks
1. Open an empty folder → *Mode: ROS2* (default) → **Create** → follow the wizard → the Package
   Explorer lists the new package.
2. **Select Mode → STM32** → the Cortex-Debug install prompt appears once → **Create** an
   executable for `STM32F407VGT6` → **Build** (needs `gcc-arm-none-eabi`) → `build/<name>.elf`.
   Without `arm-none-eabi-gcc` / `openocd` / a GDB: **Create**, **Build** and **Debug** show the
   *STM32 toolchain is not fully installed* notification naming the missing tools;
   **Install with apt…** opens a terminal running the `apt-get install` line; **Use Existing
   Toolchain…** on an unpacked Arm toolchain folder fills `roboagent.stm32.toolchainPath` and
   the build starts. *STM32: Check Toolchain* reports what was found.
3. Open a folder containing a `.ioc` → notification *Detected STM32 project* → **Undo** restores
   the previous mode.
4. ESP32 without ESP-IDF installed: **Create**, **Build** and **Debug** each show the *ESP-IDF was
   not found* notification; **Install ESP-IDF…** opens the ESP-IDF Installation Manager;
   **Use Existing Install…** on a folder without `tools/idf.py` is refused, on a real checkout it
   fills `roboagent.esp32.idfPath` and the build starts. *ESP32: Check ESP-IDF Installation*
   reports the found version once one exists.
5. ESP32: **Create** → chip `esp32c3` → **Build** with/without the ESP-IDF extension configured.
