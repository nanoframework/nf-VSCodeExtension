# Developing .NET **nanoFramework** VS Code extension

This document provides details on how to setup your local environment to develop and code for the extension. Along with some general guidelines about it.

## Prerequisites

The following packages/tools/frameworks are required:

- [node](https://nodejs.org/en/) (> v12)
- [npm](https://www.npmjs.com/)
- [.NET 6.0](https://dotnet.microsoft.com/en-us/download/dotnet/6.0)
- [nbgv](https://github.com/dotnet/nerdbank.gitversioning)
- .NET 4.7.2 on Windows, [mono-complete](https://www.mono-project.com/docs/getting-started/install/) on Linux/macOS
- PowerShell core (`pwsh`) for Linux/macOS

>Note: if you're running into a `langversion:9` error, try installing the latest mono-nightly

## Install steps

- Clone repository and `cd` into it
- Run `npm install`
- Run `pwsh scripts/build.ps1` (on Linux & MacOS) or `./scripts/build.ps1` in Windows PowerShell
- Open in Visual Studio Code (`code .`)
- Press <kbd>F5</kbd> to debug

## Updating the dependencies

The extension depends on two .NET **nanoFramework** tools: [nanoFirmwareFlasher](https://github.com/nanoframework/nanoFirmwareFlasher) and [nanoFrameworkDeployer](https://github.com/nanoframework/nanoFrameworkDeployer). These are made available as git sub-modules in their respective folders. To update them manually, you have to `cd` into each folder and use the following git command to update to the desired tag. For example to update `nanoFirmwareFlasher` to version `v2.0.3`.

```cmd
cd nanoFirmwareFlasher
git checkout tags/v2.0.3
```

Make sure to commit these update changes in a individual commit to the upstream repository.
