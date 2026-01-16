/*---------------------------------------------------------------------------------------------
 * Copyright (c) .NET Foundation and Contributors.
 * Portions Copyright (c) Microsoft Corporation.  All rights reserved.
 * See LICENSE file in the project root for full license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import * as path from 'path';
import { Dotnet } from "./dotnet";
import { Executor } from "./executor";
import { NfProject } from "./createProject";
import { NuGetManager, showNuGetPackagePicker, showInstalledPackagePicker, showProjectPicker, findProjectFiles } from "./nuget";

import { multiStepInput } from './multiStepInput';
import {
    getDocumentWorkspaceFolder, solvePath, chooseSerialPort, chooseSolutionWorkspace,
    chooseName, chooseProjectType
} from './utils';
import * as cp from 'child_process';
import { HttpClient } from 'typed-rest-client/HttpClient';
import * as semver from 'semver';
import { validatePrerequisites, showPrerequisiteStatus, getPlatformInfo } from './prerequisites';
import { SerialMonitor, chooseBaudRate } from './serialMonitor';

// this method is called when your extension is activated
// your extension is activated the very first time the command is executed
export async function activate(context: vscode.ExtensionContext) {
    const platformInfo = getPlatformInfo();
    console.log(`The "vscode-nanoframework" is now active on ${platformInfo.platform} (${platformInfo.arch})`);

    const workspaceFolder = getDocumentWorkspaceFolder() || '';
    const nanoFrameworkExtensionPath = path.join(context.extensionPath, 'dist', 'utils');

    // Register all commands FIRST before any async operations that might fail
    context.subscriptions.push(vscode.commands.registerCommand("vscode-nanoframework.nfbuild", async (fileUri: vscode.Uri,) => {
        const filePath = await solvePath(fileUri, workspaceFolder);
        const configuration = await vscode.window.showQuickPick(['Debug', 'Release'], { placeHolder: 'Select build configuration', canPickMany: false }) || 'Debug';
        await Dotnet.build(filePath, nanoFrameworkExtensionPath, configuration);
    }));

    context.subscriptions.push(vscode.commands.registerCommand("vscode-nanoframework.nfdeploy", async (fileUri: vscode.Uri,) => {
        const filePath = await solvePath(fileUri, workspaceFolder);
        const serialPath = await chooseSerialPort();
        if (serialPath) {
            const configuration = await vscode.window.showQuickPick(['Debug', 'Release'], { placeHolder: 'Select build configuration', canPickMany: false }) || 'Debug';
            Dotnet.deploy(filePath, serialPath, nanoFrameworkExtensionPath, configuration);
        }
    }));

    // Note: alternative deploy method removed; use `vscode-nanoframework.nfdeploy` instead

    context.subscriptions.push(vscode.commands.registerCommand('vscode-nanoframework.nfflash', async () => {
        multiStepInput(context, nanoFrameworkExtensionPath);
    }));

    context.subscriptions.push(vscode.window.onDidCloseTerminal((closedTerminal: vscode.Terminal) => {
        Executor.onDidCloseTerminal(closedTerminal);
    }));

    context.subscriptions.push(vscode.commands.registerCommand("vscode-nanoframework.nfcreate", async (fileUri: vscode.Uri,) => {
        const folderPath = await chooseSolutionWorkspace(fileUri, workspaceFolder);
        const solution = await chooseName();
        if (solution) {
            const solutionPath = path.join(folderPath, solution);
            NfProject.CreateSolution(solutionPath, nanoFrameworkExtensionPath);
        }
    }));

    context.subscriptions.push(vscode.commands.registerCommand("vscode-nanoframework.nfadd", async (fileUri: vscode.Uri,) => {
        const filePath = await solvePath(fileUri, workspaceFolder);
        const projectName = await chooseName();
        const projectType = await chooseProjectType();
        if (projectName && projectType) {
            NfProject.AddProject(filePath, projectName, projectType, nanoFrameworkExtensionPath);
        }
    }));

    // Register command to add NuGet packages
    context.subscriptions.push(vscode.commands.registerCommand("vscode-nanoframework.nfaddnuget", async (fileUri: vscode.Uri) => {
        try {
            let projectPath: string | undefined;
            
            if (fileUri) {
                const filePath = fileUri.fsPath;
                
                if (filePath.endsWith('.nfproj')) {
                    // Direct project file
                    projectPath = filePath;
                } else if (filePath.endsWith('.sln')) {
                    // Solution file - let user pick a project
                    projectPath = await showProjectPicker(filePath);
                }
            } else {
                // No file URI - try to find projects in workspace
                if (workspaceFolder) {
                    const projects = findProjectFiles(workspaceFolder);
                    if (projects.length === 1) {
                        projectPath = projects[0];
                    } else if (projects.length > 1) {
                        projectPath = await showProjectPicker(workspaceFolder);
                    } else {
                        vscode.window.showErrorMessage('No .nfproj files found in the workspace.');
                        return;
                    }
                } else {
                    vscode.window.showErrorMessage('No workspace folder is open.');
                    return;
                }
            }
            
            if (!projectPath) {
                return;
            }
            
            // Show the NuGet package picker
            const packageInfo = await showNuGetPackagePicker();
            
            if (!packageInfo) {
                return;
            }
            
            // Add the package
            await vscode.window.withProgress(
                {
                    location: vscode.ProgressLocation.Notification,
                    title: `Adding ${packageInfo.packageId}...`,
                    cancellable: false
                },
                async () => {
                    await NuGetManager.addPackage(projectPath!, packageInfo.packageId, packageInfo.version);
                }
            );
            
            vscode.window.showInformationMessage(
                `Successfully added ${packageInfo.packageId} v${packageInfo.version} to the project. Run 'nuget restore' or build to download the package.`
            );
        } catch (error) {
            vscode.window.showErrorMessage(`Failed to add NuGet package: ${error}`);
        }
    }));

    // Register command to remove NuGet packages
    context.subscriptions.push(vscode.commands.registerCommand("vscode-nanoframework.nfremovenuget", async (fileUri: vscode.Uri) => {
        try {
            let projectPath: string | undefined;
            
            if (fileUri) {
                const filePath = fileUri.fsPath;
                
                if (filePath.endsWith('.nfproj')) {
                    projectPath = filePath;
                } else if (filePath.endsWith('.sln')) {
                    projectPath = await showProjectPicker(filePath);
                }
            } else {
                if (workspaceFolder) {
                    const projects = findProjectFiles(workspaceFolder);
                    if (projects.length === 1) {
                        projectPath = projects[0];
                    } else if (projects.length > 1) {
                        projectPath = await showProjectPicker(workspaceFolder);
                    } else {
                        vscode.window.showErrorMessage('No .nfproj files found in the workspace.');
                        return;
                    }
                } else {
                    vscode.window.showErrorMessage('No workspace folder is open.');
                    return;
                }
            }
            
            if (!projectPath) {
                return;
            }
            
            // Show installed packages picker
            const packageId = await showInstalledPackagePicker(projectPath);
            
            if (!packageId) {
                return;
            }
            
            // Confirm removal
            const confirmation = await vscode.window.showWarningMessage(
                `Remove ${packageId} from the project?`,
                { modal: true },
                'Remove'
            );
            
            if (confirmation !== 'Remove') {
                return;
            }
            
            // Remove the package
            await vscode.window.withProgress(
                {
                    location: vscode.ProgressLocation.Notification,
                    title: `Removing ${packageId}...`,
                    cancellable: false
                },
                async () => {
                    await NuGetManager.removePackage(projectPath!, packageId);
                }
            );
            
            vscode.window.showInformationMessage(`Successfully removed ${packageId} from the project.`);
        } catch (error) {
            vscode.window.showErrorMessage(`Failed to remove NuGet package: ${error}`);
        }
    }));

    // Register a command to check prerequisites manually
    context.subscriptions.push(vscode.commands.registerCommand("vscode-nanoframework.checkPrerequisites", async () => {
        const result = await validatePrerequisites();
        await showPrerequisiteStatus(result, false);
    }));

    // Register the Serial Monitor command
    context.subscriptions.push(vscode.commands.registerCommand("vscode-nanoframework.serialMonitor", async () => {
        console.log('Serial Monitor command triggered');
        
        const monitor = SerialMonitor.getInstance();
        console.log(`Monitor state: isActive=${monitor.isActive()}, currentPort=${monitor.getCurrentPort()}`);
        
        // Check if already running
        if (monitor.isActive()) {
            const choice = await vscode.window.showQuickPick(
                ['Stop current monitor', 'Start new monitor on different port', 'Cancel'],
                { placeHolder: `Serial Monitor is already running on ${monitor.getCurrentPort()}` }
            );
            
            if (choice === 'Stop current monitor') {
                await monitor.stop();
                vscode.window.showInformationMessage('Serial Monitor stopped.');
                return;
            } else if (choice === 'Cancel' || !choice) {
                return;
            }
            // Otherwise continue to start new monitor
        }

        // Choose serial port
        console.log('Prompting for serial port selection...');
        const serialPort = await chooseSerialPort();
        console.log(`Serial port selected: ${serialPort}`);
        if (!serialPort) {
            console.log('No serial port selected, aborting');
            return;
        }

        // Choose baud rate
        console.log('Prompting for baud rate selection...');
        const baudRate = await chooseBaudRate();
        console.log(`Baud rate selected: ${baudRate}`);
        if (!baudRate) {
            console.log('No baud rate selected, aborting');
            return;
        }

        // Start the monitor
        console.log(`Starting monitor on ${serialPort} at ${baudRate} baud`);
        await monitor.start(serialPort, baudRate);
    }));

    // Register the Stop Serial Monitor command
    context.subscriptions.push(vscode.commands.registerCommand("vscode-nanoframework.stopSerialMonitor", async () => {
        const monitor = SerialMonitor.getInstance();
        
        if (monitor.isActive()) {
            await monitor.stop();
            vscode.window.showInformationMessage('Serial Monitor stopped.');
        } else {
            vscode.window.showInformationMessage('Serial Monitor is not running.');
        }
    }));

    // Dispose serial monitor on deactivation
    context.subscriptions.push({
        dispose: async () => {
            await SerialMonitor.reset();
        }
    });

    // Log that all commands are registered
    console.log('All nanoFramework commands registered successfully');

    // Now run async initialization tasks (these won't block command registration)
    // Validate prerequisites on activation
    try {
        const prereqResult = await validatePrerequisites();
        if (!prereqResult.allPassed) {
            // Show issues but don't block activation
            await showPrerequisiteStatus(prereqResult, false);
        } else if (prereqResult.warnings.length > 0) {
            // Show warnings silently (only if there are any)
            await showPrerequisiteStatus(prereqResult, true);
        }
    } catch (error) {
        console.error('Error validating prerequisites:', error);
    }

    // Check for nanoff tool updates (only if installed)
    try {
        await checkDotNetToolInstalled('nanoff');
    } catch (error) {
        console.error('Error checking nanoff tool:', error);
    }
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
