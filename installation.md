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
>Note: Do not use the `mono-complete` package provided by your Linux distribution  
> as it may not include `msbuild` which is required for this extension to work.  
>
> Instead install the `mono-complete` package provided by the Mono Project.  
> The [preview](https://www.mono-project.com/download/preview/) version is recommended
> as the [stable](https://www.mono-project.com/download/stable/) version is outdated.

## Install steps

- Clone repository and `cd` into it
- Run `npm install`
- Run `pwsh scripts/build.ps1` (on Linux & MacOS) or `./scripts/build.ps1` in Windows PowerShell
- Open in Visual Studio Code (`code .`)
- Press <kbd>F5</kbd> to debug

## Updating the dependencies

The extension depends on a .NET **nanoFramework** tool: [nanoFirmwareFlasher](https://github.com/nanoframework/nanoFirmwareFlasher). This is made available as git sub-module in the respective folder. To it manually, you have to `cd` into the folder and use the following git command to update to the desired tag. For example to update `nanoFirmwareFlasher` to version `v2.5.78`.

```cmd
cd nanoFirmwareFlasher
git checkout tags/v2.5.78
```

Make sure to commit these update changes in a individual commit to the upstream repository.
