# Unit Testing .NET nanoFramework Applications in VS Code

This guide covers how to discover, run, and debug unit tests for .NET nanoFramework projects using the VS Code Test Explorer.

## Table of Contents

- [Overview](#overview)
- [Prerequisites](#prerequisites)
- [Getting Started](#getting-started)
- [Running Tests on the Emulator](#running-tests-on-the-emulator)
- [Running Tests on a Physical Device](#running-tests-on-a-physical-device)
- [Test Discovery](#test-discovery)
- [DataRow Parameterised Tests](#datarow-parameterised-tests)
- [CodeLens](#codelens)
- [Watch Mode](#watch-mode)
- [Tag Filtering](#tag-filtering)
- [runsettings](#runsettings)
- [Settings Reference](#settings-reference)
- [Known Limitations](#known-limitations)
- [Troubleshooting](#troubleshooting)

## Overview

The extension integrates with the VS Code **Testing** API to provide:

- Automatic discovery of test classes and methods from C# source files
- Two run profiles: **Run on Emulator** (default) and **Run on Device**
- Support for `[TestMethod]`, `[Setup]`, `[Cleanup]`, and `[DataRow]` attributes
- Inline CodeLens links for quick test execution
- Watch mode for automatic re-runs on file save

## Prerequisites

1. A `.nfproj` project that references **nanoFramework.TestFramework**
2. **nanoCLR** (installed automatically by the extension, or specify a local path)
3. **MSBuild** — Visual Studio Build Tools on Windows, or Mono with msbuild on Linux/macOS
4. For hardware execution: a nanoFramework device connected via USB/serial or network

## Getting Started

1. Open a workspace (or folder) containing your `.nfproj` test project.
2. The extension scans for `.nfproj` files that reference `nanoFramework.TestFramework` and automatically discovers test classes.
3. Open the **Testing** side bar (click the flask icon in the Activity Bar, or press `Ctrl+Shift+T`).
4. Your test classes and methods appear in the tree.

## Running Tests on the Emulator

This is the default run profile and requires no hardware.

1. Click the **Run** button (▶) at the top of the Test Explorer, or next to an individual test.
2. The extension will:
   - Ensure nanoCLR is installed (downloading if needed)
   - Build the project using MSBuild
   - Run `nanoclr run --assemblies <pe-files>` with all `.pe` files from the build output
   - Parse the test output and report pass/fail/skip results

## Running Tests on a Physical Device

1. Connect your nanoFramework device.
2. In the Test Explorer, click the **dropdown arrow** next to the Run button and select **"Run on Device"**.
3. If `nanoFramework.test.hardwarePort` is not configured, a port picker will appear showing available serial ports. Select yours (e.g., `COM3`).
4. The extension will:
   - Build the project
   - Connect to the device via NanoBridge
   - Deploy the `.pe` assemblies
   - Start execution and capture test output
   - Parse results (with serial line-reassembly for reliable parsing)

To skip the port picker each time, set the port in your settings:

```json
"nanoFramework.test.hardwarePort": "COM3"
```

The `hardwareRetries` setting controls how many times the extension retries if the device connection is flaky (default: 3).

## Test Discovery

The extension discovers tests by scanning `.cs` source files in projects that reference `nanoFramework.TestFramework`. It looks for:

- `[TestClass]` — marks a class as a test container
- `[TestMethod]` — marks a method as a test
- `[Setup]` — method that runs before each test in the class
- `[Cleanup]` — method that runs after each test in the class
- `[DataRow(...)]` — parameterised test data

Discovery is **automatic** and re-runs when:

- The workspace is opened
- A `.cs` file in a test project is saved
- A `.nfproj` file changes

## DataRow Parameterised Tests

Methods decorated with multiple `[DataRow(...)]` attributes appear as expandable parent items in the Test Explorer, with one child per data row:

```csharp
[TestMethod]
[DataRow(1, "one")]
[DataRow(2, "two")]
[DataRow(3, "three")]
public void MyTest(int value, string name) { ... }
```

This produces:

```text
▸ MyTest
    MyTest(1, "one")
    MyTest(2, "two")
    MyTest(3, "three")
```

Each child is individually reportable — you can see which specific data row passed or failed.

## CodeLens

Inline links appear above test methods and classes in the editor:

- **Run Test** — above `[TestMethod]`, `[Setup]`, and `[Cleanup]` methods
- **Run Class** — above `[TestClass]` declarations

Click the link to run the corresponding test(s) on the emulator.

## Watch Mode

Enable watch mode to automatically re-run tests when source files are saved:

```json
"nanoFramework.test.watchMode": true
```

When enabled, saving any `.cs` file in a test project triggers a full test run on the emulator.

## Tag Filtering

Tests are tagged by type. Use the Test Explorer filter bar with `@tag:` syntax:

| Tag | Applied To |
| --- | ---------- |
| `@testMethod` | `[TestMethod]` methods |
| `@dataRow` | `[DataRow]` parameterised entries |
| `@setup` | `[Setup]` methods |
| `@cleanup` | `[Cleanup]` methods |

Example: type `@setup` in the filter bar to show only setup methods.

## runsettings

You can create a `nano.runsettings` file to configure test execution. The extension looks for it in the workspace root, or you can specify a path:

```json
"nanoFramework.test.runSettingsPath": "./nano.runsettings"
```

Use the command **nanoFramework: Configure Test Run Settings** to generate a template.

## Settings Reference

All settings are under `nanoFramework.test.*`:

| Setting | Type | Default | Description |
| ------- | ---- | ------- | ----------- |
| `sessionTimeout` | number | `120000` | Maximum time in milliseconds to wait for test output |
| `logging` | string | `None` | Logging level: `None`, `Normal`, `Verbose` |
| `nanoclrVersion` | string | `""` | Specific nanoCLR version to use (empty = latest stable) |
| `usePreviewClr` | boolean | `false` | Use preview/pre-release nanoCLR builds |
| `pathToLocalCLRInstance` | string | `""` | Path to a local nanoCLR binary (bypasses download) |
| `hardwarePort` | string | `""` | Pre-configured device serial port (e.g. `COM3`, `/dev/ttyUSB0`) |
| `hardwareRetries` | number | `3` | Number of connection retries for hardware test runs |
| `runSettingsPath` | string | `""` | Path to a `nano.runsettings` file |
| `watchMode` | boolean | `false` | Automatically re-run tests on file save |

## Known Limitations

- **All tests run every time.** The nanoCLR emulator (and real hardware) execute all tests in the deployed assembly. There is no per-method filtering at the CLR level. When you select a single test, the extension runs the full suite internally and reports only the selected test's result.
- **No code coverage.** The nanoFramework CLR does not support code coverage instrumentation.
- **Serial line splitting.** On hardware, long test result lines may arrive split across multiple serial packets. The parser reassembles these automatically, but extremely long error messages could still be truncated depending on device buffer sizes.

## Troubleshooting

**Tests not discovered:**

- Ensure your `.nfproj` file has a `<PackageReference>` or `<Reference>` to `nanoFramework.TestFramework`
- Check that test classes have `[TestClass]` and methods have `[TestMethod]`
- Open the **nanoFramework Tests** output channel for diagnostic messages

**Build fails:**

- On Windows, ensure Visual Studio Build Tools are installed with the ".NET desktop development" workload
- On Linux/macOS, ensure `mono-complete` and `msbuild` are installed
- Check that NuGet packages are restored (the extension runs `nuget restore` automatically on Windows)

**Tests show grey (no result):**

- This can happen if the FQN (fully qualified name) from the test output doesn't match the discovered name. Check the **nanoFramework Tests** output for the raw test output.

**Hardware tests fail to connect:**

- Verify the device is connected and running nanoFramework firmware
- Check that no other application (serial monitor, debugger) is using the port
- Try increasing `hardwareRetries` in settings
- Ensure the device is not in a boot loop or crash state

**Timeout during hardware test run:**

- Increase `sessionTimeout` (default 120 seconds may not be enough for large test suites)
- Check the device is not stuck — some tests may take a long time on constrained hardware
