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

**Debug** — launches the Cortex-Debug/OpenOCD configuration when Cortex-Debug is installed,
else cpptools `cppdbg` against an OpenOCD GDB server (`arm-none-eabi-gdb`), else offers the
installer (`roboagent.stm32.ensureExtension`). No `.elf` → *Build now?* first. Interface script
from `roboagent.stm32.openocdInterface` (`stlink` default).

## ESP32 mode

*(screenshot placeholder: `docs/images/esp32-create.png`)*

**Create** — name → location → chip (`esp32`, `esp32s2`, `esp32s3`, `esp32c3`, `esp32c6`,
`esp32h2`) → template (`hello_world`, `blink`, or hand over to the bundled ESP-IDF extension's
*New Project* wizard). Generates the IDF layout (`CMakeLists.txt`, `main/`, `sdkconfig.defaults`
pinning `CONFIG_IDF_TARGET`), `.vscode/*`, and runs `idf.py set-target <chip>` in a terminal when
an ESP-IDF checkout is found (`roboagent.esp32.idfPath` → `$IDF_PATH` → `~/esp/esp-idf`).

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
| `roboagent.stm32.toolchainPath` | Directory with `arm-none-eabi-*`; empty = PATH / auto-discovery (`/opt/gcc-arm-none-eabi*`, xPack). |
| `roboagent.stm32.openocdInterface` | `stlink` / `jlink` / `cmsis-dap`. |
| `roboagent.esp32.idfPath` | ESP-IDF checkout; empty = `$IDF_PATH` / `~/esp/esp-idf`. |
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
3. Open a folder containing a `.ioc` → notification *Detected STM32 project* → **Undo** restores
   the previous mode.
4. ESP32: **Create** → chip `esp32c3` → **Build** with/without the ESP-IDF extension configured.
