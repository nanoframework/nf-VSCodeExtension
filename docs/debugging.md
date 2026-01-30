# Debugging .NET nanoFramework Applications in VS Code

This guide provides detailed information about debugging .NET nanoFramework applications using the VS Code extension.

## Table of Contents

- [Overview](#overview)
- [Getting Started](#getting-started)
- [Debug Configurations](#debug-configurations)
- [Breakpoints](#breakpoints)
- [Stepping Through Code](#stepping-through-code)
- [Inspecting Variables](#inspecting-variables)
- [Debug Console](#debug-console)
- [Exception Handling](#exception-handling)
- [Symbol Files](#symbol-files)
- [Troubleshooting](#troubleshooting)
- [Architecture](#architecture)

## Overview

The VS Code extension provides full source-level debugging support for .NET nanoFramework applications. This includes:

- Setting and hitting breakpoints
- Stepping through code (step into, step over, step out)
- Inspecting local variables and object properties
- Evaluating expressions
- Viewing call stacks with source locations
- Breaking on exceptions
- Debug console output (Debug.WriteLine)

## Getting Started

### Prerequisites

1. **.NET 8.0 Runtime** - Required for the debug bridge
2. **nanoFramework device** - Connected via USB/Serial with nanoFramework firmware
3. **Built project** - Your project must be built with debug symbols

### Quick Start

1. Open your nanoFramework project in VS Code
2. Build the project using `nanoFramework: Build Project`
3. Press `F5` or click "Run and Debug" in the Activity Bar
4. Select your device when prompted (if multiple are connected)
5. The debugger will deploy your code and stop at the entry point

## Debug Configurations

### Creating launch.json

VS Code uses `launch.json` to configure debug sessions. Create this file in `.vscode/launch.json`:

```json
{
    "version": "0.2.0",
    "configurations": [
        {
            "name": "nanoFramework: Launch",
            "type": "nanoframework",
            "request": "launch",
            "program": "${workspaceFolder}/bin/Debug/${workspaceFolderBasename}.pe",
            "stopOnEntry": true,
            "deployAssemblies": true
        }
    ]
}
```

### Configuration Reference

#### Common Options

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `name` | string | required | Display name for the configuration |
| `type` | string | required | Must be `"nanoframework"` |
| `request` | string | required | `"launch"` or `"attach"` |
| `program` | string | required | Path to .pe file or assembly directory |
| `device` | string | `""` | Device connection (COM port or IP). Empty for auto-detect |
| `verbosity` | string | `"information"` | Logging verbosity level. See [Verbosity Levels](#verbosity-levels) |
| `verbose` | boolean | `false` | (Deprecated) Enable verbose debug output. Use `verbosity` instead |

#### Verbosity Levels

The `verbosity` option controls how much debug output is shown in the Debug Console:

| Level | Description |
|-------|-------------|
| `"none"` | No debug bridge logging output. Only application output (Debug.WriteLine) is shown |
| `"information"` | Shows important events: connection status, errors, deployment progress, and key debugging milestones |
| `"debug"` | Full diagnostic output including internal operations, symbol resolution details, breakpoint status, and wire protocol details. Useful for troubleshooting debugger issues |

**Example with verbosity:**
```json
{
    "name": "Debug (Verbose)",
    "type": "nanoframework",
    "request": "launch",
    "program": "${workspaceFolder}/bin/Debug",
    "verbosity": "debug"
}
```

#### Launch-Specific Options

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `stopOnEntry` | boolean | `true` | Pause execution at program entry |
| `deployAssemblies` | boolean | `true` | Deploy assemblies before starting |

#### Attach-Specific Options

When using `"request": "attach"`, the debugger connects to an already-running application without deploying new code.

### Example Configurations

**Launch with specific device:**
```json
{
    "name": "Debug on COM3",
    "type": "nanoframework",
    "request": "launch",
    "program": "${workspaceFolder}/bin/Debug/MyApp.pe",
    "device": "COM3",
    "stopOnEntry": false
}
```

**Attach to running device:**
```json
{
    "name": "Attach to Device",
    "type": "nanoframework",
    "request": "attach",
    "device": "COM3",
    "program": "${workspaceFolder}/bin/Debug"
}
```

## Breakpoints

### Setting Breakpoints

- **Click** in the editor gutter (left margin) next to a line number
- **Press `F9`** to toggle a breakpoint on the current line
- **Right-click** in the gutter for breakpoint options

### Breakpoint Types

| Type | Description |
|------|-------------|
| **Line Breakpoint** | Standard breakpoint that pauses at a specific line |
| **Conditional** | Breaks only when a condition is true (limited support) |
| **Logpoint** | Logs a message without pausing (use Debug.WriteLine instead) |

### Breakpoint States

- **Red circle**: Verified breakpoint (will be hit)
- **Gray circle**: Unverified breakpoint (symbols not loaded or line not executable)
- **Red circle with dot**: Breakpoint is hit (execution paused here)

### Tips

- Set breakpoints before starting the debug session for best results
- Breakpoints on empty lines or comments won't be hit
- If a breakpoint shows as unverified, rebuild your project

## Stepping Through Code

Once paused at a breakpoint, use these commands:

| Action | Shortcut | Description |
|--------|----------|-------------|
| **Continue** | `F5` | Resume execution until next breakpoint |
| **Step Over** | `F10` | Execute current line, don't enter functions |
| **Step Into** | `F11` | Execute current line, enter function calls |
| **Step Out** | `Shift+F11` | Run until current function returns |
| **Restart** | `Ctrl+Shift+F5` | Restart the debug session |
| **Stop** | `Shift+F5` | End the debug session |

## Inspecting Variables

### Variables Panel

The Variables panel in the Debug sidebar shows:

- **Locals**: Variables in the current scope
- **Arguments**: Parameters passed to the current function

### Expanding Objects

Click the arrow next to complex objects to expand and view their properties:

```
▼ myObject
    Name: "Test"
    Value: 42
    ▼ Items
        [0]: "First"
        [1]: "Second"
```

### Watch Expressions

Add expressions to the Watch panel to monitor their values:

1. Click the **+** in the Watch panel
2. Type an expression (e.g., `myVariable`, `array.Length`, `obj.Property`)
3. The value updates each time execution pauses

### Hover Inspection

Hover over a variable in the editor to see its current value in a tooltip.

## Debug Console

The Debug Console serves two purposes:

### Viewing Output

All `Debug.WriteLine()` calls from your nanoFramework application appear here:

```csharp
Debug.WriteLine("Temperature: " + temperature);
Debug.WriteLine($"Status: {status}");
```

### Evaluating Expressions

Type expressions in the Debug Console input to evaluate them:

```
> myVariable
42
> array.Length
5
> DateTime.UtcNow
{01/15/2026 10:30:45}
```

## Exception Handling

### Breaking on Exceptions

The debugger can pause when exceptions occur. Configure this in the Breakpoints panel:

- **All Exceptions**: Break on any thrown exception
- **Uncaught Exceptions**: Break only on unhandled exceptions

### Exception Information

When an exception occurs, the debugger shows:

- Exception type and message
- Stack trace with source locations
- Exception properties (InnerException, etc.)

## Symbol Files

Symbol files enable source-level debugging by mapping IL offsets to source locations.

### Required Files

| File | Purpose |
|------|---------|
| `*.pdbx` | nanoFramework IL offset mapping (CLR ↔ nanoCLR) |
| `*.pdb` | Portable PDB with source line information |
| `*.pe` | nanoFramework portable executable |

### Symbol Loading

Symbols are automatically loaded from:

1. The directory specified in `program`
2. The workspace folder's bin/Debug directory

### Verifying Symbols

If breakpoints aren't working:

1. Check that `.pdbx` and `.pdb` files exist alongside your `.pe` file
2. Ensure the files match (same build)
3. Rebuild the project to regenerate symbol files

## Troubleshooting

### Device Not Found

**Symptom:** "Device not found" error when starting debug session

**Solutions:**
1. Verify device is connected and powered on
2. Check Device Manager (Windows) or `ls /dev/tty*` (Linux/Mac) for COM port
3. Ensure nanoFramework firmware is running (not bootloader mode)
4. Try the `nanoFramework: Select Debug Device` command
5. Disconnect and reconnect the USB cable

### Breakpoints Not Hit

**Symptom:** Breakpoints show as unverified or code runs past them

**Solutions:**
1. Rebuild the project (`nanoFramework: Build Project`)
2. Ensure `deployAssemblies: true` in launch.json
3. Check that source files match the deployed code
4. Verify `.pdbx` and `.pdb` files exist in output directory

### Debug Session Won't Start

**Symptom:** Error message when pressing F5

**Solutions:**
1. Check Debug Console for specific error messages
2. Verify .NET 8.0 is installed: `dotnet --version`
3. Ensure no other application is using the COM port
4. Try restarting VS Code

### Variables Show "Unable to read"

**Symptom:** Variables panel shows errors instead of values

**Solutions:**
1. Ensure you're paused at a breakpoint (not running)
2. Some optimized variables may not be readable
3. Try adding the variable to a Watch expression

### Stepping Behaves Unexpectedly

**Symptom:** Step Over enters functions, or stepping skips lines

**Causes:**
- Code optimization may combine or eliminate lines
- Async/await code has different stepping behavior
- Inlined methods are stepped through

## Architecture

The debugging system consists of three main components:

```
┌─────────────────────────────────────────────────────────────┐
│                         VS Code                              │
│  ┌─────────────┐  ┌────────────┐  ┌───────────────────────┐ │
│  │ Debug UI    │  │ Breakpoints│  │ Variables/Watch/Stack │ │
│  └──────┬──────┘  └──────┬─────┘  └───────────┬───────────┘ │
│         └────────────────┴────────────────────┘              │
│                          │                                   │
│              Debug Adapter Protocol (DAP)                    │
└──────────────────────────┼───────────────────────────────────┘
                           │
                           ▼
┌──────────────────────────────────────────────────────────────┐
│              nanoFramework Debug Adapter                     │
│  ┌──────────────────────────────────────────────────────┐   │
│  │ TypeScript Layer (nanoDebugSession, nanoRuntime)     │   │
│  └──────────────────────┬───────────────────────────────┘   │
│                         │ JSON-RPC                           │
│  ┌──────────────────────┴───────────────────────────────┐   │
│  │ .NET Bridge (DebugBridgeSession, SymbolResolver)     │   │
│  └──────────────────────┬───────────────────────────────┘   │
│                         │ Wire Protocol                      │
└─────────────────────────┼────────────────────────────────────┘
                          │
                          ▼
┌──────────────────────────────────────────────────────────────┐
│                  nanoFramework Device                        │
│  ┌──────────────────────────────────────────────────────┐   │
│  │ nanoCLR Runtime + Your Application                   │   │
│  └──────────────────────────────────────────────────────┘   │
└──────────────────────────────────────────────────────────────┘
```

### Components

1. **TypeScript Debug Adapter**: Handles DAP communication with VS Code
2. **.NET Debug Bridge**: Uses nf-debugger library to communicate with device
3. **Symbol Resolver**: Maps source locations to IL offsets using .pdbx and .pdb files
4. **Wire Protocol**: Low-level communication with the nanoFramework device

For more technical details, see the [work-debug-todo.md](../work-debug-todo.md) implementation plan.
