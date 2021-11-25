# .NET nanoFramework Visual Studio Code Extension

This extension allows you to use VS Code to flash, build and deploy your C# code for .NET nanoFramework on your device regardless of the platform you're using. This has been tested on Mac, Linux (64 bits) and Windows (64 bits).

![vs code gif](../../docs/nano-vs-code.gif)

## Features

This .NET nanoFramework VS Code extension allow you to flash, build and deploy your C# .NET nanoFramework application on an ESP32 or STM32 MCU.
For a full description and usage instruction please check [here](https://github.com/nanoframework/nf-VSCodeExtension).

## Requirements

You will need to make sure you'll have the following elements installed:

- [.NET 5.0 or greater](https://dotnet.microsoft.com/download/dotnet)
- [Visual Studio build tools](https://visualstudio.microsoft.com/en/thank-you-downloading-visual-studio/?sku=BuildTools&rel=16) on Windows, `mono-complete` on [Linux/macOS](https://www.mono-project.com/docs/getting-started/install/)

## What is .NET nanoFramework?

.NET nanoFramework is an open-source platform that enables the writing of managed code applications for constrained embedded devices like IoT sensors, wearables, academic proof of concept, robotics, hobbyist/makers creations or even complex industrial equipment. 

Developers can harness a powerful and familiar Microsoft Visual Studio IDE and their .NET C# knowledge to quickly write code without having to worry about the low-level hardware intricacies of a microcontroller. Desktop .NET developers will feel at home and are able to use their skills in embedded systems, enlarging the pool of qualified embedded developers.

It includes a reduced version of the .NET Common Language Runtime (CLR) and features a subset of the .NET base class libraries along with the most common APIs included in .NET IoT allowing code reuse from .NET IoT applications, thousands of code examples and open source projects.
Using Microsoft Visual Studio, a developer can deploy and debug the code directly on the real hardware.

## Supported platforms

We currently have support for ARM Cortex-M cores and Xtensa LX6 and LX7 (Espressif ESP32 and ESP32_S2). We have reference targets for several STM32 Nucleo and Discovery boards, ESP32 and ESP32_S2 boards, Texas Instruments CC3220 and CC1352 and also for NXP MIMXRT1060.

You can find out more in the project GitHub [here](https://github.com/nanoframework).

To report issues go to our issue tracker on GitHub [here](https://github.com/nanoframework/Home/issues).

For conversations, sharing ideas and support please join our Discord community [here](https://discord.gg/gCyBu8T).

Please note that we also offer a full Visual Studio extension compatible with [VS2022](https://marketplace.visualstudio.com/items?itemName=nanoframework.nanoFramework-VS2022-Extension) and another one compatible with [VS2019](https://marketplace.visualstudio.com/items?itemName=nanoframework.nanoFramework-VS2019-Extension).
