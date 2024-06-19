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
import * as os from 'os';
import * as cp from 'child_process';
import { HttpClient } from 'typed-rest-client/HttpClient';
import * as semver from 'semver';

// this method is called when your extension is activated
// your extension is activated the very first time the command is executed
export async function activate(context: vscode.ExtensionContext) {
    console.log('The "vscode-nanoframework" is now active!');

    // check for nanoff tool installation
    await checkDotNetToolInstalled('nanoff');

    const workspaceFolder = getDocumentWorkspaceFolder() || '';
    const nanoFrameworkExtensionPath = context.extensionPath + '/dist/utils';

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
