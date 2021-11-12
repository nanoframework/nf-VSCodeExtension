[![License](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE) [![#yourfirstpr](https://img.shields.io/badge/first--timers--only-friendly-blue.svg)](https://github.com/nanoframework/Home/blob/main/CONTRIBUTING.md) [![Discord](https://img.shields.io/discord/478725473862549535.svg?logo=discord&logoColor=white&label=Discord&color=7289DA)](https://discord.gg/gCyBu8T)

![nanoFramework logo](https://github.com/nanoframework/Home/blob/main/resources/logo/nanoFramework-repo-logo.png)

-----

# .NET nanoFramework VS Code Extension

This extension allows you to use VS Code to flash, build and deploy your C# code for .NET nanoFramework on your device regardless of the platform you're using. This has been tested on Mac, Linux (64 bits) and Windows (64 bits).

![vs code gif](docs/nano-vs-code.gif)

## Features

This .NET nanoFramework VS Code extension allow you to flash, build and deploy your C# .NET nanoFramework application on an ESP32 or STM32 MCU.

### Flashing the device

Select `nanoFramework: Flash device` and follow the steps.

![nanoFramework: Flash device](docs/step-by-step6.png)

Based on the target you will select, the menus will automatically adjust to help you finding the correct version, DFU or Serial Port.

![select options](docs/step-by-step8.png)

Once all options has been selected, you'll see the flashing happening:

![flash happening](docs/step-by-step12.png)

### Building your code

Select `nanoFramework: Build Project` and follow the steps.

![select options](docs/step-by-step2.png)

If you have multiple solutions in the open folder, you'll be able to select the one to build:

![select options](docs/step-by-step3.png)

Build result will be display in the Terminal:

![select options](docs/step-by-step5.png)

### Deploy to your device

Select `nanoFramework: Build Project` and follow the steps.

![select options](docs/step-by-step14.png)

Similar as building the project, you'll have to select the project to deploy. The code will be built and the deployment will start:

![select options](docs/step-by-step17.png)

You'll get as well the status of the deployment happening in the Terminal.

## Requirements

You will need to make sure you'll have the following elements installed:

- [.NET 5.0 or greater](https://dotnet.microsoft.com/download/dotnet)
- [Visual Studio build tools](https://visualstudio.microsoft.com/en/thank-you-downloading-visual-studio/?sku=BuildTools&rel=16) on Windows, `mono-complete` on [Linux/macOS](https://www.mono-project.com/docs/getting-started/install/)

## Known Issues

This extension will **not** allow you to debug the device. Debug is only available on Windows with [Visual Studio](https://visualstudio.microsoft.com/downloads/) (any edition) and the [.NET nanoFramework Extension](https://marketplace.visualstudio.com/items?itemName=nanoframework.nanoFramework-VS2022-Extension) installed.

This extension will work on any Mac version (x64 or M1), works only on Linux x64 and Windows x64. Other 32 bits OS or ARM platforms are not supported.

## Release Notes

### 1.0.0

Initial version.
