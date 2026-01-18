/*---------------------------------------------------------------------------------------------
 * Copyright (c) .NET Foundation and Contributors.
 * Portions Copyright (c) Microsoft Corporation.  All rights reserved.
 * See LICENSE file in the project root for full license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { Dotnet } from "./dotnet";
import { Executor } from "./executor";
import { NfProject } from "./createProject";

import { multiStepInput } from './multiStepInput';
import {
    getDocumentWorkspaceFolder, solvePath, chooseSerialPort, chooseTarget, chooseSolutionWorkspace,
    chooseName, chooseProjectType
} from './utils';
import { SerialPortCtrl } from './serialportctrl';
import * as os from 'os';
import * as cp from 'child_process';
import { HttpClient } from 'typed-rest-client/HttpClient';
import * as semver from 'semver';

// Import debug adapter components
import { NanoDebugSession } from './debugger/nanoDebugSession';

/**
 * Debug Adapter Descriptor Factory for inline debugging
 * This runs the debug adapter in the same process as the extension
 */
class InlineDebugAdapterFactory implements vscode.DebugAdapterDescriptorFactory {
    createDebugAdapterDescriptor(_session: vscode.DebugSession): vscode.ProviderResult<vscode.DebugAdapterDescriptor> {
        return new vscode.DebugAdapterInlineImplementation(new NanoDebugSession());
    }
}

/**
 * Debug Configuration Provider for nanoFramework
 * Resolves and validates debug configurations before a debug session starts
 */
class NanoDebugConfigurationProvider implements vscode.DebugConfigurationProvider {
    private _context: vscode.ExtensionContext | undefined;
    private _extensionPath: string = '';

    /**
     * Set the extension context for accessing state storage
     */
    setContext(context: vscode.ExtensionContext): void {
        this._context = context;
        this._extensionPath = context.extensionPath + '/dist/utils';
    }

    /**
     * Massage a debug configuration just before a debug session is being launched
     */
    async resolveDebugConfiguration(
        folder: vscode.WorkspaceFolder | undefined,
        config: vscode.DebugConfiguration,
        _token?: vscode.CancellationToken
    ): Promise<vscode.DebugConfiguration | undefined> {
        // If launch.json is missing or empty
        if (!config.type && !config.request && !config.name) {
            const editor = vscode.window.activeTextEditor;
            if (editor && editor.document.languageId === 'csharp') {
                config.type = 'nanoframework';
                config.name = 'nanoFramework: Launch';
                config.request = 'launch';
                config.program = '${workspaceFolder}/bin/Debug/';
                config.stopOnEntry = true;
            }
        }

        // Validate required fields
        if (config.request === 'launch' && !config.program) {
            vscode.window.showInformationMessage("Cannot find a program to debug");
            return undefined;
        }

        // Handle device selection for attach or launch
        if (!config.device) {
            config.device = await this.resolveDevice();
            if (!config.device) {
                if (config.request === 'attach') {
                    vscode.window.showInformationMessage("No device selected. Please select a device to attach to.");
                    return undefined;
                }
                // For launch, we can continue without device for now (will use first available)
            }
        }

        return config;
    }

    /**
     * Resolve device - use stored device or prompt for selection
     */
    private async resolveDevice(): Promise<string | undefined> {
        if (!this._context) {
            return undefined;
        }

        // Check for stored device preference
        const storedDevice = this._context.workspaceState.get<string>('nanoframework.debugDevice');
        
        // Get available ports
        let ports: { port: string; desc: string }[] = [];
        try {
            ports = await SerialPortCtrl.list(this._extensionPath);
        } catch (e) {
            // No ports available
        }

        // If stored device is available, use it
        if (storedDevice && ports.some(p => p.port === storedDevice)) {
            return storedDevice;
        }

        // If only one port, use it automatically
        if (ports.length === 1) {
            return ports[0].port;
        }

        // If multiple ports, show picker
        if (ports.length > 1) {
            const devicePaths = ports.map((p) => ({
                label: p.port,
                description: p.desc
            }));

            const selectedPort = await vscode.window.showQuickPick(devicePaths, {
                placeHolder: 'Select the device to debug',
                title: 'nanoFramework: Select Debug Device'
            });

            if (selectedPort) {
                // Store selection for future use
                await this._context.workspaceState.update('nanoframework.debugDevice', selectedPort.label);
                return selectedPort.label;
            }
        }

        return undefined;
    }

    /**
     * Provide initial debug configurations
     */
    provideDebugConfigurations(
        _folder: vscode.WorkspaceFolder | undefined,
        _token?: vscode.CancellationToken
    ): vscode.ProviderResult<vscode.DebugConfiguration[]> {
        return [
            {
                type: 'nanoframework',
                request: 'deployAndRun',
                name: 'nanoFramework: Launch and Debug',
                program: '${workspaceFolder}/bin/Debug',
                device: ''
            },
            {
                type: 'nanoframework',
                request: 'attach',
                name: 'nanoFramework: Attach to Device',
                device: '',
                program: '${workspaceFolder}/bin/Debug'
            }
        ];
    }
}

// this method is called when your extension is activated
// your extension is activated the very first time the command is executed
export async function activate(context: vscode.ExtensionContext) {
    console.log('The "vscode-nanoframework" is now active!');

    // check for nanoff tool installation
    await checkDotNetToolInstalled('nanoff');

    const workspaceFolder = getDocumentWorkspaceFolder() || '';
    const nanoFrameworkExtensionPath = context.extensionPath + '/dist/utils';

    // Register debug adapter
    const debugConfigProvider = new NanoDebugConfigurationProvider();
    debugConfigProvider.setContext(context);
    context.subscriptions.push(
        vscode.debug.registerDebugConfigurationProvider('nanoframework', debugConfigProvider)
    );

    // Register inline debug adapter factory
    const debugAdapterFactory = new InlineDebugAdapterFactory();
    context.subscriptions.push(
        vscode.debug.registerDebugAdapterDescriptorFactory('nanoframework', debugAdapterFactory)
    );

    // Register command to select debug device
    context.subscriptions.push(vscode.commands.registerCommand("vscode-nanoframework.selectDebugDevice", async () => {
        const serialPath = await chooseSerialPort(nanoFrameworkExtensionPath);
        if (serialPath) {
            vscode.window.showInformationMessage(`Selected debug device: ${serialPath}`);
            // Store the selected device for the debug session
            context.workspaceState.update('nanoframework.debugDevice', serialPath);
        }
    }));

    context.subscriptions.push(vscode.commands.registerCommand("vscode-nanoframework.nfbuild", async (fileUri: vscode.Uri,) => {
        const path = await solvePath(fileUri, workspaceFolder);
        Dotnet.build(path, nanoFrameworkExtensionPath);
    }));

    context.subscriptions.push(vscode.commands.registerCommand("vscode-nanoframework.nfdeploy", async (fileUri: vscode.Uri,) => {
        const path = await solvePath(fileUri, workspaceFolder);
        const serialPath = await chooseSerialPort(nanoFrameworkExtensionPath);
        Dotnet.deploy(path, serialPath, nanoFrameworkExtensionPath);
    }));

    context.subscriptions.push(vscode.commands.registerCommand('vscode-nanoframework.nfflash', async () => {
        multiStepInput(context, nanoFrameworkExtensionPath);
    }));

    context.subscriptions.push(vscode.window.onDidCloseTerminal((closedTerminal: vscode.Terminal) => {
        Executor.onDidCloseTerminal(closedTerminal);
    }));

    context.subscriptions.push(vscode.commands.registerCommand("vscode-nanoframework.nfcreate", async (fileUri: vscode.Uri,) => {
        const path = await chooseSolutionWorkspace(fileUri, workspaceFolder);
        const solution = await chooseName();
        NfProject.CreateSolution(path + (os.platform() === 'win32' ? "\\" : "/") + solution, nanoFrameworkExtensionPath);
    }));

    context.subscriptions.push(vscode.commands.registerCommand("vscode-nanoframework.nfadd", async (fileUri: vscode.Uri,) => {
        const path = await solvePath(fileUri, workspaceFolder);
        const projectName = await chooseName();
        const projectType = await chooseProjectType();
        NfProject.AddProject(path, projectName, projectType, nanoFrameworkExtensionPath);
    }));
}

/**
 * Installs a .NET tool globally using `dotnet tool install -g`.
 * @param toolName The name of the .NET tool to install.
 * @returns A promise that resolves when the installation is complete.
 */
async function installDotNetTool(toolName: string): Promise<void> {
    return new Promise((resolve, reject) => {
        let command = `dotnet tool install -g ${toolName}`;

        cp.exec(command, (error, stdout, stderr) => {
            if (error) {
                console.error(`Error installing ${toolName}: ${error}`);
                vscode.window.showErrorMessage(`Error installing ${toolName}: ${stderr}`);
                reject(error);
            } else {
                vscode.window.showInformationMessage(`${toolName} has been successfully installed/updated.`);
                resolve();
            }
        });
    });
}

/**
 * Checks if a .NET tool is installed by running `<toolName> --help` and checking the result.
 * @param toolName The name of the .NET tool to check.
 * @returns A promise that resolves to `true` if the tool is installed, otherwise `false`.
 */
function checkDotNetToolInstalled(toolName: string): Promise<void> {
    return new Promise<void>((resolve, reject) => {
        try {
            // Execute the CLI command to get the version
            cp.exec(`${toolName} --help`, async (error, stdout, stderr) => {
                if (error) {
                    vscode.window.showErrorMessage('Error executing dotnet nanoclr: ' + error.message);
                    reject();
                    return;
                }

                // Use regex to extract the version number from the CLI output
                const regexResult = stderr.match(/(\d+\.\d+\.\d+)/);

                if (regexResult && regexResult.length > 0) {
                    const installedVersion = regexResult[0];

                    // Check the latest version from the NuGet API
                    const httpClient = new HttpClient('vsts');
                    const response = await httpClient.get('https://api.nuget.org/v3-flatcontainer/nanoff/index.json');
                    const responseBody = await response.readBody();
                    const packageInfo = JSON.parse(responseBody);
                    const latestVersion = packageInfo.versions[packageInfo.versions.length - 1];

                    // Compare installed version with the latest version
                    if (semver.gt(latestVersion, installedVersion)) {
                        vscode.window.showInformationMessage('A new version of nanoff is available. Updating.');
                        await installDotNetTool('nanoff');
                    }
                } else {
                    vscode.window.showErrorMessage('Failed to parse current nanoff CLI version');
                }

                resolve();
            });
        } catch (e) {
            if (e instanceof Error) {
                vscode.window.showErrorMessage('An error occurred while checking nanoff version: ' + e.message);
            } else {
                // Handle cases where e is not an Error object
                vscode.window.showErrorMessage('An unknown error occurred while checking nanoff version.');
            }

            reject();
        }
    });
}

// this method is called when your extension is deactivated
export function deactivate() { }
