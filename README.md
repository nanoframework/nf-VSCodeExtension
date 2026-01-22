[![Visual Studio Marketplace](https://img.shields.io/vscode-marketplace/v/nanoframework.vscode-nanoframework.svg)](https://marketplace.visualstudio.com/items?itemName=nanoframework.vscode-nanoframework) [![Build Status](https://dev.azure.com/nanoframework/VSCodeExtension/_apis/build/status/nanoframework.nf-VSCodeExtension?branchName=develop)](https://dev.azure.com/nanoframework/VSCodeExtension/_build/latest?definitionId=86&branchName=develop) [![Discord](https://img.shields.io/discord/478725473862549535.svg?logo=discord&logoColor=white&label=Discord&color=7289DA)](https://discord.gg/gCyBu8T)

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

### Create solutions and projects

To create a solution, you can select any folder on your workspace, right click and select the create solution option.

![create solution](docs/create-solution-step1.png)

You then need to place a valid name and your solution is created.

On the solution, right click and select `Add project to existing Solution`

![Add project to existing solution](docs/create-solution-step2.png)

 Place a valid name like in this example `MyApplication`.

![project name](docs/create-solution-step3.png)

Then select the type of project you want to add.

![type of project](docs/create-solution-step4.png)

## Debugging

The extension provides full debugging support for .NET nanoFramework applications running on connected devices.

### Quick Start

1. **Connect your device** - Ensure your nanoFramework device is connected via USB/Serial
2. **Build your project** - Use `nanoFramework: Build Project` command
3. **Start debugging** - Press `F5` or use `Run > Start Debugging`

### Debug Features

| Feature | Description |
|---------|-------------|
| **Breakpoints** | Set breakpoints by clicking in the gutter or pressing `F9` |
| **Step Through Code** | Step Over (`F10`), Step Into (`F11`), Step Out (`Shift+F11`) |
| **Variable Inspection** | View local variables, arguments, and object properties |
| **Watch Expressions** | Add expressions to the Watch panel |
| **Call Stack** | View the current call stack with source locations |
| **Debug Console** | See `Debug.WriteLine` output and evaluate expressions |
| **Exception Handling** | Break on exceptions (configurable) |

### launch.json Configuration

Create a `.vscode/launch.json` file in your workspace with the following configurations:

```json
{
    "version": "0.2.0",
    "configurations": [
        {
            "name": "nanoFramework: Launch and Debug",
            "type": "nanoframework",
            "request": "launch",
            "program": "${workspaceFolder}/bin/Debug/${workspaceFolderBasename}.pe",
            "device": "",
            "stopOnEntry": true,
            "deployAssemblies": true
        },
        {
            "name": "nanoFramework: Attach to Device",
            "type": "nanoframework",
            "request": "attach",
            "device": "",
            "program": "${workspaceFolder}/bin/Debug"
        }
    ]
}
```

#### Configuration Options

| Option | Type | Description |
|--------|------|-------------|
| `type` | string | Must be `"nanoframework"` |
| `request` | string | `"launch"` to deploy and debug, `"attach"` to debug running code |
| `program` | string | Path to the `.pe` file or directory containing assemblies |
| `device` | string | COM port (e.g., `"COM3"`) or IP address. Leave empty for auto-detect |
| `stopOnEntry` | boolean | Pause at program entry point (default: `true`) |
| `deployAssemblies` | boolean | Deploy assemblies before debugging (launch only) |
| `verbose` | boolean | Enable verbose debug output |

### Device Selection

- If `device` is empty, the extension will:
  - Use the last selected device if available
  - Auto-select if only one device is connected
  - Show a device picker if multiple devices are found

- Use the `nanoFramework: Select Debug Device` command to manually choose a device

### Troubleshooting

**Device not detected:**
- Ensure the device is properly connected and running nanoFramework firmware
- Check that the correct drivers are installed for your device
- Try unplugging and reconnecting the device

**Breakpoints not hitting:**
- Ensure the deployed code matches your source files
- Rebuild the project before debugging
- Check that symbol files (.pdbx, .pdb) are present in the output directory

**Debug session won't start:**
- Verify .NET 8.0 runtime is installed
- Check the Debug Console for error messages
- Ensure no other application is using the COM port

## Requirements

You will need to make sure you'll have the following elements installed:

- [.NET 8.0](https://dotnet.microsoft.com/download/dotnet/8.0) or later
- [nanoff](https://github.com/nanoframework/nanoFirmwareFlasher) - Install via: `dotnet tool install -g nanoff`
- **Windows only:** [Visual Studio Build Tools](https://visualstudio.microsoft.com/downloads/#build-tools-for-visual-studio-2022) with ".NET desktop build tools" workload
- **Linux/macOS only:** [mono-complete](https://www.mono-project.com/docs/getting-started/install/) with msbuild, and [nuget CLI](https://www.nuget.org/downloads)

### Linux-specific Requirements

On Linux, you may need to add your user to the `dialout` group to access serial ports:

```bash
sudo usermod -aG dialout $USER
```

Log out and back in for this to take effect.

> **Note:** Do not use the `mono-complete` package provided by your Linux distribution  
> as it may not include `msbuild` which is required for this extension to work.  
>
> Instead install the `mono-complete` package provided by the Mono Project.  
> The [preview](https://www.mono-project.com/download/preview/) version is recommended.

## Known Issues

~~This extension will **not** allow you to debug the device.~~ **Debugging is now supported!** See the [Debugging](#debugging) section below.

This extension works on:

- **Windows**: x64 and ARM64
- **macOS**: x64 (Intel) and ARM64 (Apple Silicon M1/M2/M3)
- **Linux**: x64 and ARM64

32-bit operating systems are not supported.

## Developing for the VS Code extension

Documentation about development for the extension can be found [here](installation.md).

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
