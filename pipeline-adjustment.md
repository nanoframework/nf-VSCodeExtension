# Build Plan for Multi-Platform Debug Bridge Support

## Overview

This document outlines the changes required to build the nanoFramework Debug Bridge for all target platforms:
- Windows amd64 (win-x64)
- Linux amd64 (linux-x64)
- macOS amd64 (osx-x64)
- macOS arm64 (osx-arm64)

---

## Current State

1. **Debug Bridge Project**: Located at `src/debugger/bridge/dotnet/nanoFramework.Tools.DebugBridge`
2. **Current Build**: The `gulpfile.js` has a `build-debug-bridge` task that publishes to `bin/nanoDebugBridge` but only builds **framework-dependent** (requires .NET runtime on target)
3. **Runtime Resolution**: `nanoBridge.ts` expects:
   - Windows: `nanoFramework.Tools.DebugBridge.exe`
   - Other platforms: `nanoFramework.Tools.DebugBridge.dll` (run via `dotnet`)

---

## Required Changes

### 1. Update the .NET Project for Self-Contained Publishing

**File**: `src/debugger/bridge/dotnet/nanoFramework.Tools.DebugBridge/nanoFramework.Tools.DebugBridge.csproj`

Change the following properties:

```xml
<PropertyGroup>
  <OutputType>Exe</OutputType>
  <TargetFramework>net10.0</TargetFramework>
  <ImplicitUsings>enable</ImplicitUsings>
  <Nullable>enable</Nullable>
  <AllowUnsafeBlocks>true</AllowUnsafeBlocks>
  <RootNamespace>nanoFramework.Tools.DebugBridge</RootNamespace>
  <AssemblyName>nanoFramework.Tools.DebugBridge</AssemblyName>
  <Description>Debug bridge process for VS Code nanoFramework debugging</Description>
  <Authors>.NET Foundation and Contributors</Authors>
  <Company>nanoframework</Company>
  <Copyright>Copyright (c) .NET Foundation and Contributors</Copyright>
  
  <!-- Publishing configuration for self-contained deployment -->
  <PublishSingleFile>true</PublishSingleFile>
  <SelfContained>true</SelfContained>
  <EnableCompressionInSingleFile>true</EnableCompressionInSingleFile>
  <IncludeNativeLibrariesForSelfExtract>true</IncludeNativeLibrariesForSelfExtract>
</PropertyGroup>
```

**Runtime Identifiers to publish:**

| Platform | RID | Output Folder |
|----------|-----|---------------|
| Windows x64 | `win-x64` | `win32-x64` |
| Linux x64 | `linux-x64` | `linux-x64` |
| macOS x64 | `osx-x64` | `darwin-x64` |
| macOS ARM64 | `osx-arm64` | `darwin-arm64` |

---

### 2. Update gulpfile.js - Build for All Platforms

**File**: `gulpfile.js`

Replace the `build-debug-bridge` task with multi-platform builds:

```javascript
gulp.task("build-debug-bridge", async (done) => {
    const bridgeProjectDir = path.resolve("src", "debugger", "bridge", "dotnet", "nanoFramework.Tools.DebugBridge");
    const baseOutputDir = path.resolve("bin", "nanoDebugBridge");
    const promiseExec = require("util").promisify(exec);
    
    const platforms = [
        { rid: "win-x64", folder: "win32-x64" },
        { rid: "linux-x64", folder: "linux-x64" },
        { rid: "osx-x64", folder: "darwin-x64" },
        { rid: "osx-arm64", folder: "darwin-arm64" }
    ];
    
    for (const platform of platforms) {
        const outputDir = path.join(baseOutputDir, platform.folder);
        console.log(`Building debug bridge for ${platform.rid}...`);
        
        try {
            const { stdout, stderr } = await promiseExec(
                `dotnet publish -c Release -r ${platform.rid} --self-contained true -o "${outputDir}"`,
                { cwd: bridgeProjectDir }
            );
            if (stdout) console.log(stdout);
            console.log(`Debug bridge built successfully for ${platform.rid}`);
        } catch (err) {
            console.error(`Error building debug bridge for ${platform.rid}:`, err.message);
            throw err;
        }
    }
    
    // Set executable permissions on Unix binaries (when running on Unix)
    if (process.platform !== 'win32') {
        const { chmod } = require('fs').promises;
        const unixPlatforms = ['linux-x64', 'darwin-x64', 'darwin-arm64'];
        for (const folder of unixPlatforms) {
            const execPath = path.join(baseOutputDir, folder, 'nanoFramework.Tools.DebugBridge');
            try {
                await chmod(execPath, 0o755);
            } catch (e) {
                // Ignore if file doesn't exist (cross-compiling from Windows)
            }
        }
    }
    
    done();
});
```

---

### 3. Update nanoBridge.ts - Platform-Aware Path Resolution

**File**: `src/debugger/bridge/nanoBridge.ts`

#### 3.1 Update `getBridgePath()` method:

```typescript
private getBridgePath(): string {
    const platform = process.platform;
    const arch = process.arch;
    
    let platformFolder: string;
    let fileName: string;
    
    if (platform === 'win32') {
        platformFolder = 'win32-x64';
        fileName = 'nanoFramework.Tools.DebugBridge.exe';
    } else if (platform === 'darwin') {
        platformFolder = arch === 'arm64' ? 'darwin-arm64' : 'darwin-x64';
        fileName = 'nanoFramework.Tools.DebugBridge';
    } else {
        platformFolder = 'linux-x64';
        fileName = 'nanoFramework.Tools.DebugBridge';
    }
    
    return path.join(__dirname, '..', '..', '..', 'bin', 'nanoDebugBridge', platformFolder, fileName);
}
```

#### 3.2 Update the spawn logic in `initialize()`:

Since we're using self-contained executables, we no longer need to invoke `dotnet` on non-Windows platforms:

```typescript
// Self-contained executable - run directly on all platforms
this._process = spawn(bridgePath, [], {
    stdio: ['pipe', 'pipe', 'pipe']
});
```

Remove the platform-specific spawn logic that uses `dotnet` for non-Windows platforms.

---

### 4. Update .vscodeignore - Include Binaries

**File**: `.vscodeignore`

Ensure the debug bridge binaries are included in the extension package by adding:

```ignore
# Ensure debug bridge is included
!bin/nanoDebugBridge/**
```

---

### 5. Update azure-pipelines.yml - Cross-Platform Build

**File**: `azure-pipelines.yml`

The .NET SDK supports cross-compilation, so all platforms can be built from the Windows agent. No changes are strictly required to the pipeline structure, but ensure the gulp task runs during the build.

The current pipeline already runs:
1. `scripts/build.ps1` - Downloads dependencies
2. `npm ci` - Installs npm dependencies and runs `postinstall` which calls `gulp build`
3. `npm run build:prod` - Compiles TypeScript

The `gulp build` task includes `build-debug-bridge`, so the multi-platform binaries will be built automatically.

#### Optional: Add explicit build step for clarity

If you want more visibility in the pipeline, add an explicit step:

```yaml
- script: npx gulp build-debug-bridge
  displayName: Build debug bridge for all platforms
  condition: succeeded()
```

---

## Implementation Priority

| # | Task | File(s) | Priority |
|---|------|---------|----------|
| 1 | Modify .csproj for self-contained | `nanoFramework.Tools.DebugBridge.csproj` | High |
| 2 | Update gulpfile.js multi-platform build | `gulpfile.js` | High |
| 3 | Update nanoBridge.ts path resolution | `nanoBridge.ts` | High |
| 4 | Update nanoBridge.ts spawn logic | `nanoBridge.ts` | High |
| 5 | Update .vscodeignore | `.vscodeignore` | High |
| 6 | Update azure-pipelines.yml (optional) | `azure-pipelines.yml` | Medium |

---

## Size Considerations

Self-contained .NET 10 single-file executables will be approximately:
- **~50-80 MB per platform** (includes .NET runtime)
- **Total: ~200-320 MB** for all 4 platforms

### If size is a concern, consider these alternatives:

1. **Keep framework-dependent**: Require users to have .NET installed
2. **Use trimming**: Add `<PublishTrimmed>true</PublishTrimmed>` (can reduce to ~20-30MB each)
3. **Platform-specific extension packages**: Users download only their platform

### Platform-Specific Extensions (Optional)

VS Code supports platform-specific extensions. Add to `package.json`:

```json
{
  "capabilities": {
    "untrustedWorkspaces": { "supported": true }
  }
}
```

Then publish separate `.vsix` files per platform using:
```bash
vsce package --target win32-x64
vsce package --target linux-x64
vsce package --target darwin-x64
vsce package --target darwin-arm64
```

This results in smaller downloads for users (they only get their platform's binaries).

---

## Testing Checklist

After implementing the changes:

- [ ] Build succeeds on Windows for all 4 RIDs
- [ ] Extension package (`.vsix`) includes all platform binaries
- [ ] Debug bridge starts correctly on Windows x64
- [ ] Debug bridge starts correctly on Linux x64
- [ ] Debug bridge starts correctly on macOS x64 (Intel)
- [ ] Debug bridge starts correctly on macOS arm64 (Apple Silicon)
- [ ] Debugger can connect to device on all platforms
- [ ] Breakpoints work on all platforms
- [ ] Variable inspection works on all platforms

---

## References

- [.NET RID Catalog](https://docs.microsoft.com/en-us/dotnet/core/rid-catalog)
- [Single-file deployment](https://docs.microsoft.com/en-us/dotnet/core/deploying/single-file)
- [VS Code Platform-specific extensions](https://code.visualstudio.com/api/working-with-extensions/publishing-extension#platformspecific-extensions)
