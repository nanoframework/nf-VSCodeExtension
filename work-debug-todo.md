# VS Code Debugging Support for .NET nanoFramework

## Overview

This document outlines the work required to implement debugging support in VS Code for .NET nanoFramework. The current Visual Studio extension uses the old COM-based debug engine (ICorDebug interfaces), which is not compatible with VS Code. VS Code uses the **Debug Adapter Protocol (DAP)**, a JSON-based protocol that defines how development tools communicate with debug adapters.

> **✅ IMPORTANT: No Wire Protocol Changes Required**
> 
> This implementation can be done **entirely on the host side** without any modifications to the Wire Protocol or the nanoFramework interpreter (nf-interpreter). The existing Wire Protocol already provides all necessary debugging commands. The Debug Adapter is purely a **translation layer** between VS Code's DAP and the existing Wire Protocol.

## Implementation Progress

| Phase | Status | Description |
|-------|--------|-------------|
| Phase 1 | ✅ Complete | Foundation & Infrastructure |
| Phase 2 | ✅ Complete | Core Debug Adapter Implementation |
| Phase 3 | ✅ Complete | Wire Protocol Bridge (nf-debugger integrated) |
| Phase 4 | ✅ Complete | Source Mapping & Symbols |
| Phase 5 | ✅ Complete | User Experience |
| Phase 6 | 🔄 Partial | Testing & Quality (documentation complete, tests pending) |
| Phase 7 | ⬜ Not Started | Advanced Features (Future) |

### Current Session Summary

**Core debugging functionality is complete!** The following major components have been implemented:

1. **TypeScript Debug Adapter** (`src/debugger/`)
   - `nanoDebugSession.ts` - DAP protocol handler
   - `nanoRuntime.ts` - Debug runtime coordination
   - `bridge/nanoBridge.ts` - JSON-RPC communication with .NET bridge

2. **.NET Debug Bridge** (`src/debugger/bridge/dotnet/nanoFramework.Tools.DebugBridge/`)
   - `Program.cs` - Main entry point, JSON-RPC command handling
   - `DebugBridgeSession.cs` - Core session management, wraps nf-debugger
   - `Protocol/` - Command/response types aligned with TypeScript

3. **Symbol Resolution** (`Symbols/`)
   - `PdbxModels.cs` - XML models for .pdbx files (IL offset mapping)
   - `PortablePdbReader.cs` - Portable PDB parsing for source locations
   - `SymbolResolver.cs` - Source ↔ IL offset resolution
   - `AssemblyManager.cs` - Device/local assembly tracking

4. **User Experience**
   - Device auto-detection and selection
   - Workspace state persistence for device preference
   - Debug output forwarding (Debug.WriteLine support)

## Why No Device-Side Changes Are Needed

The existing Wire Protocol (implemented in nf-interpreter and exposed via nf-debugger library) already supports:

| Debugging Capability | Wire Protocol Command(s) | Status |
|---------------------|-------------------------|--------|
| Set/Clear Breakpoints | `Debugging_Execution_Breakpoints` | ✅ Exists |
| Step In/Over/Out | `Debugging_Execution_Breakpoints` with flags | ✅ Exists |
| Pause/Resume | `Debugging_Execution_ChangeConditions` | ✅ Exists |
| List Threads | `Debugging_Thread_List` | ✅ Exists |
| Get Call Stack | `Debugging_Thread_Stack` | ✅ Exists |
| Inspect Variables | `Debugging_Value_GetStack`, `GetField`, `GetArray`, `GetBlock` | ✅ Exists |
| Modify Variables | `Debugging_Value_SetBlock`, `SetArray`, `Assign` | ✅ Exists |
| Evaluate Expressions | `Debugging_Value_*` commands | ✅ Exists |
| Resolve Types/Methods | `Debugging_Resolve_Type`, `_Method`, `_Field`, `_Assembly` | ✅ Exists |
| Exception Handling | Breakpoint flags: `EXCEPTION_THROWN`, `CAUGHT`, `UNCAUGHT` | ✅ Exists |
| Thread Suspend/Resume | `Debugging_Thread_Suspend`, `_Resume` | ✅ Exists |
| Deploy Assemblies | `WriteMemory`, `DeploymentExecute` | ✅ Exists |
| Device Info | `Monitor_Ping`, `Monitor_TargetInfo` | ✅ Exists |

The Debug Adapter simply translates DAP ↔ Wire Protocol messages. The nf-debugger .NET library already handles all the low-level communication.

## Background Research

### Current Visual Studio Extension Architecture

The existing Visual Studio extension (`nf-Visual-Studio-extension`) implements debugging using:

1. **CorDebug Engine** (`CorDebug.cs`, `CorDebugProcess.cs`, `CorDebugThread.cs`)
   - Implements `ICorDebug`, `ICorDebugProcess`, `ICorDebugThread` COM interfaces
   - Uses Visual Studio's proprietary debug engine infrastructure

2. **Wire Protocol Communication** (via `nf-debugger` library)
   - `Engine` class manages communication with the device
   - Commands like `Debugging_Execution_Breakpoints`, `Debugging_Thread_Stack`, etc.
   - Serial/USB/Network transport layers

3. **Debug Launch Provider** (`NanoDebuggerLaunchProvider.cs`)
   - Handles launch configuration and debug session initialization

### nanoFramework Interpreter Debugging Capabilities

The native interpreter (`nf-interpreter`) supports:

- **Breakpoint Types**: Step In, Step Over, Step Out, Hard, Exception (thrown/caught/uncaught), Thread events
- **Thread Management**: Create, List, Stack, Kill, Suspend, Resume
- **Value Inspection**: GetStack, GetField, GetArray, GetBlock, SetBlock, AllocateObject, AllocateString
- **Type System**: Assemblies, AppDomains, Resolve Type/Field/Method/Assembly
- **Execution Control**: ChangeConditions, Pause, Resume, Reboot
- **Memory Operations**: Read, Write, Check, Erase

### VS Code Debug Adapter Protocol (DAP)

VS Code requires a **Debug Adapter** that implements DAP. Key concepts:

- Debug Adapter runs as a separate process or inline
- Communicates via JSON messages over stdin/stdout or TCP
- Standard request/response/event model
- Language-agnostic debugging UI

---

## Work Items

### Phase 1: Foundation & Infrastructure ✅ COMPLETE

#### 1.1 Create Debug Adapter Project Structure ✅
- [x] Create new TypeScript/Node.js project for the Debug Adapter
- [x] Set up build configuration and dependencies
- [x] Add `@vscode/debugadapter` and `@vscode/debugprotocol` npm packages
- [x] Configure TypeScript compilation settings

**Files created:**
```
src/debugger/
├── nanoDebugAdapter.ts        ✅ Main debug adapter entry point
├── nanoDebugSession.ts        ✅ Debug session management (all DAP handlers)
├── nanoRuntime.ts             ✅ Communication with nf-debugger bridge
├── bridge/
│   ├── nanoBridge.ts          ✅ .NET bridge communication layer
│   └── dotnet/                ✅ .NET bridge project (DebugBridge)
├── types/
│   └── debugTypes.ts          ✅ Type definitions
└── utils/
    ├── subject.ts             ✅ Async notification utility
    └── logger.ts              ✅ Debug logging utilities
```

#### 1.2 Integrate nf-debugger Library ✅
- [x] Research options for using the C# nf-debugger library:
  - **Option A**: Port critical parts to TypeScript/Node.js
  - **✅ Option B (CHOSEN)**: Create a .NET bridge process that the TypeScript adapter communicates with
  - **Option C**: Use Edge.js or similar to call .NET code from Node.js
- [x] Create .NET bridge project structure
- [x] Implement JSON-RPC protocol for TypeScript ↔ .NET communication

#### 1.3 Update package.json for Debugging Contributions ✅
- [x] Add `debuggers` contribution point
- [x] Define debug configuration schema (`configurationAttributes`)
- [x] Add `breakpoints` contribution for supported languages
- [x] Define initial configurations and snippets
- [x] Add activation events for debugging
  - **Option B**: Create a .NET bridge process that the TypeScript adapter communicates with
  - **Option C**: Use Edge.js or similar to call .NET code from Node.js
- [ ] Implement Wire Protocol message encoding/decoding in TypeScript
- [ ] Implement serial port communication using `serialport` npm package
- [ ] Implement USB communication (if needed, using `usb` npm package)

#### 1.3 Update package.json for Debugging Contributions
- [ ] Add `debuggers` contribution point
- [ ] Define debug configuration schema (`configurationAttributes`)
- [ ] Add `breakpoints` contribution for supported languages
- [ ] Define initial configurations and snippets
- [ ] Add activation events for debugging

**Example contribution:**
```json
{
  "contributes": {
    "breakpoints": [
      { "language": "csharp" }
    ],
    "debuggers": [
      {
        "type": "nanoframework",
        "label": ".NET nanoFramework Debug",
        "program": "./out/debugger/nanoDebugAdapter.js",
        "runtime": "node",
        "configurationAttributes": {
          "launch": {
            "required": ["program"],
            "properties": {
              "program": {
                "type": "string",
                "description": "Path to the .nfproj or .sln file"
              },
              "device": {
                "type": "string",
                "description": "Target device (COM port or IP address)"
              },
              "stopOnEntry": {
                "type": "boolean",
                "default": false
              }
            }
          },
          "attach": {
            "properties": {
              "device": {
                "type": "string",
                "description": "Target device to attach to"
              }
            }
          }
        }
      }
    ]
  }
}
```

---

### Phase 2: Core Debug Adapter Implementation ✅ COMPLETE

#### 2.1 Implement DAP Request Handlers ✅

##### Initialize & Configuration ✅
- [x] `initializeRequest` - Return debug adapter capabilities
- [x] `configurationDoneRequest` - Signal configuration complete
- [x] `disconnectRequest` - Clean up and disconnect

##### Launch & Attach ✅
- [x] `launchRequest` - Deploy and start debugging
- [x] `attachRequest` - Attach to running device

##### Breakpoints ✅
- [x] `setBreakPointsRequest` - Set source breakpoints
- [x] `setFunctionBreakpointsRequest` - Set function breakpoints
- [x] `setExceptionBreakpointsRequest` - Configure exception handling

##### Execution Control ✅
- [x] `continueRequest` - Resume execution
- [x] `nextRequest` - Step over
- [x] `stepInRequest` - Step into
- [x] `stepOutRequest` - Step out
- [x] `pauseRequest` - Break execution
- [x] `terminateRequest` - Stop debugging

##### Stack & Threads ✅
- [x] `threadsRequest` - List active threads
- [x] `stackTraceRequest` - Get call stack
- [x] `scopesRequest` - Get variable scopes
- [x] `variablesRequest` - Get variables in scope

##### Variables & Evaluation ✅
- [x] `evaluateRequest` - Evaluate expression
- [x] `setVariableRequest` - Modify variable value

##### Modules ✅
- [x] `modulesRequest` - List loaded assemblies
- [x] `exceptionInfoRequest` - Get exception details

#### 2.2 Implement DAP Events ✅

- [x] `initialized` - Adapter ready
- [x] `stopped` - Execution stopped (breakpoint, step, exception)
- [x] `continued` - Execution resumed (implicit)
- [x] `terminated` - Debug session ended
- [x] `breakpoint` - Breakpoint status changed
- [x] `output` - Debug console output
- [ ] `thread` - Thread created/exited (TODO: add thread events)
- [ ] `module` - Assembly loaded/unloaded (TODO: add module events)

---

### Phase 3: Wire Protocol Bridge ✅ COMPLETE

> **Note:** The .NET bridge now integrates with the actual nf-debugger NuGet package (nanoFramework.Tools.Debugger.Net). All core debug operations are implemented using the real Engine and PortBase classes.

#### 3.1 Command Mapping (DAP ↔ Wire Protocol)

| DAP Request | Wire Protocol Command(s) | Status |
|-------------|-------------------------|--------|
| `launch` | Deploy assemblies, `Debugging_Execution_ChangeConditions` | ✅ Implemented |
| `attach` | `Monitor_Ping`, `Debugging_Execution_ChangeConditions` | ✅ Implemented |
| `setBreakpoints` | `Debugging_Execution_Breakpoints` | ✅ Implemented |
| `continue` | `_engine.ResumeExecution()` | ✅ Implemented |
| `next` | `Debugging_Execution_BreakpointDef` (STEP_OVER) | ✅ Implemented |
| `stepIn` | `Debugging_Execution_BreakpointDef` (STEP_IN) | ✅ Implemented |
| `stepOut` | `Debugging_Execution_BreakpointDef` (STEP_OUT) | ✅ Implemented |
| `pause` | `_engine.PauseExecution()` | ✅ Implemented |
| `threads` | `_engine.GetThreadList()`, `_engine.GetThreadStack()` | ✅ Implemented |
| `stackTrace` | `_engine.GetThreadStack()`, `_engine.GetMethodName()` | ✅ Implemented |
| `scopes` | `_engine.GetStackFrameInfo()` | ✅ Implemented |
| `variables` | `_engine.GetStackFrameValue()`, `Engine.StackValueKind` | ✅ Implemented |
| `evaluate` | `_engine.GetStackFrameValue()` | ✅ Implemented |

#### 3.2 Type Resolution

- [x] Implement `_engine.ResolveType()` for variable type names
- [x] Implement variable value extraction for all RuntimeValue types:
  - RuntimeValue_Primitive (numbers, bool, etc.)
  - RuntimeValue_String
  - RuntimeValue_Array (element enumeration)
  - RuntimeValue_Class (field enumeration)
  - RuntimeValue_ValueType
  - RuntimeValue_Object
- [x] Cache resolved types for performance (via _variableReferences map)

#### 3.3 Breakpoint Management

- [x] Basic breakpoint management in TypeScript
- [x] Breakpoint structure mapped to WireProtocol.Commands.Debugging_Execution_BreakpointDef
- [x] Support for step breakpoints (STEP_IN, STEP_OVER, STEP_OUT, STEP_RETURN flags)
- [ ] Map source file locations to IL offsets (needs PE/PDB parsing - Phase 4)
- [ ] Handle breakpoint validation (verified/unverified states - Phase 4)
- [ ] Support conditional breakpoints (if device supports)
- [ ] Support hit count breakpoints

#### 3.4 .NET Bridge Implementation Status

The .NET bridge project (`nanoFramework.Tools.DebugBridge`) now includes:
- [x] JSON-RPC protocol handling over stdin/stdout
- [x] Command routing infrastructure
- [x] **nanoFramework.Tools.Debugger.Net** NuGet package integrated
- [x] **Initialize** command with capability reporting
- [x] **Connect/Disconnect** using PortBase.CreateInstanceForSerial/Network
- [x] **SetBreakpoint/RemoveBreakpoint** with BreakpointDef structures
- [x] **Continue/Pause** using Engine.ResumeExecution/PauseExecution
- [x] **Step commands** using BreakpointDef with step flags
- [x] **GetThreads** using Engine.GetThreadList/GetThreadStack
- [x] **GetStackTrace** using Engine.GetThreadStack and method name resolution
- [x] **GetScopes/GetVariables** using Engine.GetStackFrameInfo/GetStackFrameValue
- [x] **RuntimeValue handling** for all value types (primitives, strings, arrays, objects)
- [x] Helper classes: ScopeReference, RuntimeValueReference, ScopeType enum
- [x] **Build successful** (all compilation errors fixed)
- [x] **TypeScript-C# protocol aligned** (command, id, args/data)

#### 3.5 Build & Integration Status

- [x] .NET bridge compiles successfully
- [x] TypeScript adapter compiles successfully
- [x] Bridge executable responds to JSON-RPC commands
- [x] Gulp task added for building bridge (`gulp build-debug-bridge`)
- [x] Bridge deployed to `bin/nanoDebugBridge/`

---

### Phase 4: Source Mapping & Symbols ✅ COMPLETE

> **Note**: This phase provides the critical symbol infrastructure for source-level debugging.

#### 4.1 Pdbx Symbol File Support ✅

The nanoFramework build process generates `.pdbx` files (XML-based symbol files) that contain IL mappings between CLR and nanoFramework offsets.

- [x] Research pdbx format from nf-Visual-Studio-extension
- [x] Create `PdbxModels.cs` - XML serialization models for .pdbx files
  - `PdbxFile`, `PdbxAssembly`, `PdbxClass`, `PdbxMethod`, `PdbxField`
  - `PdbxToken` - CLR/nanoCLR token mapping
  - `PdbxIL` - CLR/nanoCLR IL offset mapping
- [x] Implement `PdbxMethod.GetNanoILFromCLRIL()` and `GetCLRILFromNanoIL()` - binary search with interpolation
- [x] Create `SymbolResolver.cs` - symbol resolution class
  - `LoadSymbols()` - parse .pdbx files
  - `LoadSymbolsFromDirectory()` - batch load
  - `GetBreakpointLocation()` - source → IL for breakpoints
  - `GetSourceLocation()` - IL → source for stack traces
  - `GetMethodInfo()` - method metadata lookup

**Files created:**
```
src/debugger/bridge/dotnet/nanoFramework.Tools.DebugBridge/Symbols/
├── PdbxModels.cs              ✅ Pdbx XML model classes (~340 lines)
└── SymbolResolver.cs          ✅ Symbol resolution (~334 lines)
```

#### 4.2 Integration with DebugBridgeSession ✅

- [x] Add `SymbolResolver` field to `DebugBridgeSession`
- [x] Update `SetBreakpoint()` to use symbol resolution for verified breakpoints
- [x] Update `GetStackTrace()` to return source locations
- [x] Add `LoadSymbols()` and `LoadSymbolsFromDirectory()` methods
- [x] Add `RebindPendingBreakpoints()` to verify pending breakpoints when symbols load
- [x] Add `loadSymbols` command handler to `Program.cs`

#### 4.3 Portable PDB Integration ✅

To get actual source line numbers (not just IL offsets), need to parse portable PDB files.

- [x] Add System.Reflection.Metadata NuGet for PDB parsing
- [x] Create `PortablePdbReader.cs` - parses portable PDB files
  - `Load()` - load PDB from file path
  - `LoadFromEmbeddedPdb()` - load PDB embedded in PE file
  - `GetSequencePoints()` - get sequence points by method token
  - `FindSequencePoint()` - find sequence point for IL offset
  - `FindSequencePointBySourceLocation()` - find by source file/line
- [x] Extract sequence points from portable PDBs
- [x] Correlate with .pdbx IL mappings (CLR IL offset → source location)
- [x] Integrate with `SymbolResolver` to populate source info in cache

**Files created/updated:**
```
src/debugger/bridge/dotnet/nanoFramework.Tools.DebugBridge/Symbols/
├── PortablePdbReader.cs       ✅ PDB parsing (~330 lines)
└── SymbolResolver.cs          ✅ Updated to use PortablePdbReader
```

**How it works:**
1. When loading a `.pdbx` file, SymbolResolver also looks for corresponding `.pdb` file
2. The `.pdbx` provides CLR ↔ nanoFramework IL offset mapping
3. The portable PDB provides CLR IL offset → source file/line mapping
4. Combined: nanoFramework IL offset → source location for stack traces
5. And: source location → nanoFramework IL offset for breakpoints

#### 4.4 Assembly Management ✅

- [x] Create `AssemblyManager.cs` - tracks device and local assemblies
  - `RegisterDeviceAssembly()` - register assemblies from device
  - `AddSearchPath()` / `ScanLocalAssemblies()` - scan for local assemblies
  - `GetPdbxPath()` - find symbol files for assemblies
  - CRC32 checksum matching for assembly verification
- [x] Track deployed assemblies with version and checksum
- [x] Match device assemblies to local source by name and checksum
- [x] Detect and report assembly mismatches via `AssemblyMismatchDetected` event
- [x] Integrate with DebugBridgeSession:
  - Assembly scanning during `LoadSymbolsFromDirectory()`
  - `GetAssemblyManager()` accessor for assembly state

**Files created:**
```
src/debugger/bridge/dotnet/nanoFramework.Tools.DebugBridge/Symbols/
├── AssemblyManager.cs         ✅ Assembly tracking (~340 lines)
```

**Key types:**
- `AssemblyInfo` - device assembly (name, version, checksum, device index)
- `LocalAssemblyInfo` - local assembly (paths to PE, PDB, PDBX)
- `AssemblyMismatchEventArgs` - mismatch notification with reason

---

### Phase 5: User Experience ✅ COMPLETE

#### 5.1 Debug Configuration Provider ✅

- [x] Implement `DebugConfigurationProvider` for dynamic configuration
- [x] Provide smart defaults based on workspace
- [x] Auto-detect available devices via SerialPortCtrl

#### 5.2 Device Selection ✅

- [x] Basic device selection command added
- [x] Integrate with existing device discovery (`serialportctrl.ts`)
- [x] Show device picker when multiple devices available
- [x] Remember last used device via workspaceState

**Implementation details:**
- `NanoDebugConfigurationProvider.resolveDevice()` - intelligent device selection
- Stored device preference: `nanoframework.debugDevice` in workspace state
- Auto-selects if only one device connected
- Shows picker for multiple devices
- Falls back gracefully for launch (vs attach which requires device)

#### 5.3 Debug Console ✅

- [x] Forward device output to debug console (infrastructure ready)
- [x] Support expression evaluation in console (evaluate request implemented)
- [x] Handle Debug.WriteLine output (bridge integration complete)
  - `OnEngineMessage` event handler captures device debug output
  - Forwards to VS Code debug console as "stdout" output events

#### 5.4 Exception Handling ✅

- [x] Show exception details in UI (exceptionInfoRequest)
- [x] Support "Break on Exception" options (exception filters)
- [x] Display exception call stack (stackTraceRequest)

---

### Phase 6: Testing & Quality 🔄 IN PROGRESS

> **Status**: Documentation complete. Unit and integration tests pending device testing.

#### 6.1 Unit Tests

- [ ] Test Wire Protocol encoding/decoding
- [ ] Test DAP message handling
- [ ] Test breakpoint management
- [ ] Test variable resolution

#### 6.2 Integration Tests

- [ ] Test with real nanoFramework device
- [ ] Test with nanoFramework virtual device
- [ ] Test all debug scenarios (launch, attach, breakpoints, stepping)

#### 6.3 Documentation ✅

- [x] Update README with debugging instructions
  - Added comprehensive Debugging section with features table
  - Updated "Known Issues" to reflect debugging support
  - Added launch.json configuration documentation
  - Added troubleshooting section
- [x] Document launch.json configuration options (in README)
- [x] Add troubleshooting guide (in README and docs/debugging.md)
- [x] Create debugging tutorial ([docs/debugging.md](docs/debugging.md))
  - Complete debugging guide with all features
  - Symbol file explanation
  - Architecture overview
  - Detailed troubleshooting section

---

### Phase 7: Advanced Features (Future)

#### 7.1 Hot Reload (if supported)
- [ ] Investigate Edit and Continue possibilities
- [ ] Implement assembly hot-swap if feasible

#### 7.2 Multi-Device Debugging
- [ ] Support debugging multiple devices simultaneously
- [ ] Implement compound launch configurations

#### 7.3 Remote Debugging
- [ ] Support network-connected devices
- [ ] Implement secure connection options

#### 7.4 Profiling Integration
- [ ] Expose profiling data from device
- [ ] Integrate with VS Code performance tools

---

## Architecture Diagram

```
┌─────────────────────────────────────────────────────────────────┐
│                         VS Code                                  │
│  ┌─────────────┐  ┌──────────────┐  ┌─────────────────────────┐ │
│  │ Debug UI    │  │ Breakpoints  │  │ Variables/Watch/Stack   │ │
│  └──────┬──────┘  └──────┬───────┘  └────────────┬────────────┘ │
│         │                │                        │              │
│         └────────────────┴────────────────────────┘              │
│                          │                                       │
│                   Debug Adapter Protocol (DAP)                   │
│                          │  (JSON over stdin/stdout)             │
└──────────────────────────┼───────────────────────────────────────┘
                           │
                           │ ← NEW CODE LIVES HERE
                           │   (Translation Layer)
                           ▼
┌──────────────────────────────────────────────────────────────────┐
│               nanoFramework Debug Adapter                        │
│  ┌───────────────────────────────────────────────────────────┐  │
│  │                  nanoDebugSession.ts                       │  │
│  │  • Receive DAP requests → Translate → Send WP commands    │  │
│  │  • Receive WP responses → Translate → Send DAP events     │  │
│  │  • Source/Symbol mapping (PE/PDB files)                   │  │
│  └───────────────────────┬───────────────────────────────────┘  │
│                          │                                       │
│  ┌───────────────────────┴───────────────────────────────────┐  │
│  │              nf-debugger Library (EXISTING)                │  │
│  │  • Wire Protocol implementation ← NO CHANGES NEEDED       │  │
│  │  • Engine class for communication                         │  │
│  │  • Serial/USB/Network transport                           │  │
│  └───────────────────────┬───────────────────────────────────┘  │
│                          │                                       │
└──────────────────────────┼───────────────────────────────────────┘
                           │
              ┌────────────┴────────────┐
              │   Serial/USB/Network    │
              │   (Existing Transport)  │
              └────────────┬────────────┘
                           │
                           │ ← NO CHANGES BELOW THIS LINE
                           ▼
┌──────────────────────────────────────────────────────────────────┐
│                  nanoFramework Device                            │
│  ┌───────────────────────────────────────────────────────────┐  │
│  │                     nanoCLR                                │  │
│  │  • Wire Protocol handler      ← NO CHANGES NEEDED         │  │
│  │  • Debugger_* commands        ← ALREADY IMPLEMENTED       │  │
│  │  • Breakpoint engine          ← ALREADY IMPLEMENTED       │  │
│  │  • Execution control          ← ALREADY IMPLEMENTED       │  │
│  └───────────────────────────────────────────────────────────┘  │
└──────────────────────────────────────────────────────────────────┘
```

**Key Point:** All new code is in the Debug Adapter layer. The nf-debugger library and nf-interpreter remain unchanged.

---

## Key Technical Decisions Needed

### 1. nf-debugger Library Integration Strategy

The critical decision is how to use the existing **nf-debugger** .NET library from the Node.js/TypeScript Debug Adapter:

**Options:**

| Option | Pros | Cons |
|--------|------|------|
| **A: .NET Bridge Process** | Reuse 100% of existing nf-debugger code, proven implementation, no Wire Protocol reimplementation | Extra process, IPC overhead, .NET runtime dependency |
| **B: Port to TypeScript** | Native Node.js, single runtime, easier VS Code deployment | Significant effort (~4000+ lines of Wire Protocol code), need to maintain two codebases |
| **C: Edge.js/.NET interop** | Reuse code, single process | Complex setup, platform-specific issues, maintenance burden |

**Recommendation:** **Option A (.NET Bridge Process)** is strongly recommended because:
1. ✅ Zero Wire Protocol changes needed
2. ✅ Proven, battle-tested communication code  
3. ✅ Faster time to working debugger
4. ✅ Easier to keep in sync with nf-debugger updates
5. ✅ The VS extension already uses nf-debugger successfully

The bridge process can communicate with the Debug Adapter via:
- JSON-RPC over stdin/stdout (simple)
- Named pipes (faster)
- Local TCP socket (cross-platform)

### 2. Transport Layer

- Serial port: Use `serialport` npm package
- USB: Use `usb` npm package or delegate to .NET bridge
- Network: Standard Node.js `net` module

### 3. Symbol/Source Mapping

- Option to use existing `nanoFramework.Tools.MetadataProcessor` for PE parsing
- Or implement lightweight TypeScript parser for essential metadata

---

## Dependencies

### NPM Packages Required

```json
{
  "dependencies": {
    "@vscode/debugadapter": "^1.65.0",
    "@vscode/debugprotocol": "^1.65.0",
    "serialport": "^12.0.0",
    "await-notify": "^1.0.1"
  },
  "devDependencies": {
    "@vscode/debugadapter-testsupport": "^1.65.0"
  }
}
```

### .NET Components (using bridge approach) ✅

- `nanoFramework.Tools.Debugger.Net` NuGet package (to be integrated)
- .NET 8.0 runtime

---

## References

- [VS Code Debug Adapter Protocol](https://microsoft.github.io/debug-adapter-protocol/)
- [VS Code Debugger Extension Guide](https://code.visualstudio.com/api/extension-guides/debugger-extension)
- [Mock Debug Example](https://github.com/microsoft/vscode-mock-debug)
- [nf-Visual-Studio-extension](https://github.com/nanoframework/nf-Visual-Studio-extension)
- [nf-debugger](https://github.com/nanoframework/nf-debugger)
- [nf-interpreter](https://github.com/nanoframework/nf-interpreter)

---

## Timeline Estimate

| Phase | Estimated Duration | Actual |
|-------|-------------------|--------|
| Phase 1: Foundation | 2-3 weeks | ✅ Complete |
| Phase 2: Core DAP Implementation | 3-4 weeks | ✅ Complete |
| Phase 3: Wire Protocol Bridge | 2-3 weeks | 🔄 In Progress (need nf-debugger integration) |
| Phase 4: Source Mapping | 2 weeks | ⬜ Not Started |
| Phase 5: User Experience | 2 weeks | ✅ Partially Complete |
| Phase 6: Testing & Documentation | 2 weeks | ⬜ Not Started |
| **Total** | **13-16 weeks** | **~40% Complete** |

---

## Next Steps

1. **Integrate nf-debugger NuGet package** into the .NET bridge project
2. **Implement actual Wire Protocol calls** in `DebugBridgeSession.cs`
3. **Test with real nanoFramework device**
4. **Implement PE/PDB parsing** for source mapping
5. **Add comprehensive error handling**

---

## Getting Started

1. Review the existing VS extension source code in `nf-Visual-Studio-extension`
2. Study the `nf-debugger` library's `Engine` class and Wire Protocol commands
3. Set up the vscode-mock-debug example and understand DAP flow
4. Begin with Phase 1.1 - creating the project structure
5. Implement a minimal launch/attach flow first, then iterate

---

*Document created: January 2026*
*Last updated: January 2026*
