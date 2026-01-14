# Developing .NET **nanoFramework** VS Code extension

This document provides details on how to setup your local environment to develop and code for the extension. Along with some general guidelines about it.

## Prerequisites

The following packages/tools/frameworks are required on all platforms:

- [Node.js](https://nodejs.org/en/) (v18 or later - LTS recommended)
- [npm](https://www.npmjs.com/)
- [.NET 8.0](https://dotnet.microsoft.com/en-us/download/dotnet/8.0)
- [nbgv](https://github.com/dotnet/nerdbank.gitversioning)

### Platform-Specific Requirements

#### Windows

- .NET Framework 4.8 (included in Windows 10/11, or install via Visual Studio Build Tools)
- PowerShell 5.1+ (included) or [PowerShell 7+](https://aka.ms/install-powershell) (recommended)

#### macOS

- **PowerShell 7+** (required) - macOS 13 (Ventura) or later required
  
  Install via Homebrew (recommended):

  ```bash
  brew install --cask powershell
  ```

  Or via .NET Global Tool (if .NET SDK is installed):

  ```bash
  dotnet tool install --global PowerShell
  ```
  
  Or download directly from [PowerShell Releases](https://aka.ms/powershell-release?tag=stable)

- Xcode Command Line Tools (recommended):

  ```bash
  xcode-select --install
  ```

#### Linux

- **PowerShell 7+** (required)

  **Ubuntu/Debian:**

  ```bash
  # Install prerequisites
  sudo apt-get update
  sudo apt-get install -y wget apt-transport-https software-properties-common
  
  # Download and register Microsoft repository
  wget -q "https://packages.microsoft.com/config/ubuntu/$(lsb_release -rs)/packages-microsoft-prod.deb"
  sudo dpkg -i packages-microsoft-prod.deb
  rm packages-microsoft-prod.deb
  
  # Install PowerShell
  sudo apt-get update
  sudo apt-get install -y powershell
  ```

  **RHEL/Fedora:**

  ```bash
  # Register Microsoft repository
  curl https://packages.microsoft.com/config/rhel/8/prod.repo | sudo tee /etc/yum.repos.d/microsoft.repo
  
  # Install PowerShell
  sudo dnf install -y powershell
  ```

  **Snap (Universal):**

  ```bash
  sudo snap install powershell --classic
  ```

- [mono-complete](https://www.mono-project.com/docs/getting-started/install/) with msbuild

> **Note:** Do not use the `mono-complete` package provided by your Linux distribution  
> as it may not include `msbuild` which is required for this extension to work.  
>
> Instead install the `mono-complete` package provided by the Mono Project.  
> The [preview](https://www.mono-project.com/download/preview/) version is recommended
> as the [stable](https://www.mono-project.com/download/stable/) version is outdated.

> **Note:** If you're running into a `langversion:9` error, try installing the latest mono-nightly.

### Verify PowerShell Installation

Before proceeding, verify PowerShell is installed correctly:

```bash
pwsh --version
# Should output: PowerShell 7.x.x
```

## Install steps

1. Clone repository and `cd` into it
2. Run `npm install`
3. Run the build script:
   - **Windows (PowerShell 5.1+):** `.\scripts\build.ps1`
   - **Windows (PowerShell 7+):** `pwsh .\scripts\build.ps1`
   - **macOS/Linux:** `pwsh scripts/build.ps1` or `./scripts/build.sh`
4. Open in Visual Studio Code (`code .`)

## Debugging extension

- Press <kbd>F5</kbd> to debug
- Set breakpoints at will
- Move to the new VS Code instance window
- Load a directory with a project or go to Command Palette and choose one of the nanoFramework commands

## Dependencies

The extension uses the following key npm packages:

- **serialport** - Cross-platform serial port enumeration (native bindings auto-installed)
- **axios** - HTTP client for firmware downloads
- **globby** - File pattern matching

Native bindings for `serialport` are automatically downloaded during `npm install` for your platform.

## Updating the dependencies

The extension depends on .NET **nanoFramework** msbuild components provided by the [VS extension](https://github.com/nanoframework/vs-extension).
To update to a new version go to the [build.ps1](scripts/build.ps1) and set the `$vsExtensionVersion` variable to the desired Git tag.
Make sure to commit these update changes in an individual commit to the upstream repository.
