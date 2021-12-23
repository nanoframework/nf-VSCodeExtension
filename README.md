[![License](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE) [![#yourfirstpr](https://img.shields.io/badge/first--timers--only-friendly-blue.svg)](https://github.com/nanoframework/Home/blob/main/CONTRIBUTING.md) [![Discord](https://img.shields.io/discord/478725473862549535.svg?logo=discord&logoColor=white&label=Discord&color=7289DA)](https://discord.gg/gCyBu8T) [![Build Status](https://dev.azure.com/nanoframework/VSCodeExtension/_apis/build/status/nanoframework.nf-VSCodeExtension?branchName=develop)](https://dev.azure.com/nanoframework/VSCodeExtension/_build/latest?definitionId=86&branchName=develop) [![Visual Studio Marketplace](https://img.shields.io/vscode-marketplace/d/nanoframework.vscode-nanoframework.svg)](https://marketplace.visualstudio.com/items?itemName=nanoframework.vscode-nanoframework)

![nanoFramework logo](https://raw.githubusercontent.com/nanoframework/Home/main/resources/logo/nanoFramework-repo-logo.png)

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

Select `nanoFramework: Deploy Project` and follow the steps.

![select options](docs/step-by-step14.png)

Similar as building the project, you'll have to select the project to deploy. The code will be built and the deployment will start:

![select options](docs/step-by-step17.png)

You'll get as well the status of the deployment happening in the Terminal.

Some ESP32 devices have issues with the initial discovery process and require an alternative deployment method.
If you're having issues with the deployment, you can use an _alternative_ method: you have to select `nanoFramework: Deploy Project (alternative method)` instead and follow the prompts, same as with the other steps.

## Requirements

You will need to make sure you'll have the following elements installed:

- [.NET 6.0](https://dotnet.microsoft.com/download/dotnet)
- [Visual Studio build tools](https://visualstudio.microsoft.com/en/thank-you-downloading-visual-studio/?sku=BuildTools&rel=16) on Windows, `mono-complete` on [Linux/macOS](https://www.mono-project.com/docs/getting-started/install/)

## Known Issues

This extension will **not** allow you to debug the device. Debug is only available on Windows with [Visual Studio](https://visualstudio.microsoft.com/downloads/) (any edition) and the [.NET nanoFramework Extension](https://marketplace.visualstudio.com/items?itemName=nanoframework.nanoFramework-VS2022-Extension) installed.

This extension will work on any Mac version (x64 or M1), works only on Linux x64 and Windows x64. Other 32 bits OS or ARM platforms are not supported.

## Install path issues

:warning: That are know issues running commands for STM32 devices when the user path contains diacritic characters. This causes issues with with STM32 Cube Programmer which is used by `nanoff` a dependency of the extension.
Note that if you're not using the extension with with STM32 devices, this limitation does not apply.

## Developing for the VS Code extension

Documentation about development for the extension can be found [here](instalation.md).

## Feedback and documentation

For documentation, providing feedback, issues and finding out how to contribute please refer to the [Home repo](https://github.com/nanoframework/Home).

Join our Discord community [here](https://discord.gg/gCyBu8T).

## Credits

The list of contributors to this project can be found at [CONTRIBUTORS](https://github.com/nanoframework/Home/blob/main/CONTRIBUTORS.md).

## License

The **nanoFramework** Class Libraries are licensed under the [MIT license](LICENSE.md).

## Code of Conduct

This project has adopted the code of conduct defined by the Contributor Covenant to clarify expected behaviour in our community.
For more information see the [.NET Foundation Code of Conduct](https://dotnetfoundation.org/code-of-conduct).

### .NET Foundation

This project is supported by the [.NET Foundation](https://dotnetfoundation.org).
