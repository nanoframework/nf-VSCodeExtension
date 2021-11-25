/*---------------------------------------------------------------------------------------------
 * Copyright (c) .NET Foundation and Contributors.
 * Portions Copyright (c) Microsoft Corporation.  All rights reserved.
 * See LICENSE file in the project root for full license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { Dotnet } from "./dotnet";
import { Executor } from "./executor";

import { multiStepInput } from './multiStepInput';
import { getDocumentWorkspaceFolder, solvePath, chooseSerialPort, chooseTarget } from './utils';

// this method is called when your extension is activated
// your extension is activated the very first time the command is executed
export async function activate(context: vscode.ExtensionContext) {	
	console.log('The "vscode-nanoframework" is now active!');
    
    const workspaceFolder = getDocumentWorkspaceFolder() || '';
    const nanoFrameworkExtensionPath = context.extensionPath + '/dist/utils/';

	context.subscriptions.push(vscode.commands.registerCommand("vscode-nanoframework.nfbuild", async (fileUri: vscode.Uri, ) => {
        const path = await solvePath(fileUri, workspaceFolder);
        Dotnet.build(path, nanoFrameworkExtensionPath);
    }));

    context.subscriptions.push(vscode.commands.registerCommand("vscode-nanoframework.nfdeploy", async (fileUri: vscode.Uri, ) => {
        const path = await solvePath(fileUri, workspaceFolder);
        const serialPath = await chooseSerialPort(nanoFrameworkExtensionPath);
        Dotnet.deploy(path, serialPath, nanoFrameworkExtensionPath);
    }));

    context.subscriptions.push(vscode.commands.registerCommand("vscode-nanoframework.nfdeployalt", async (fileUri: vscode.Uri, ) => {
        const path = await solvePath(fileUri, workspaceFolder);
        const serialPath = await chooseSerialPort(nanoFrameworkExtensionPath);
        const target = await chooseTarget(nanoFrameworkExtensionPath);
        Dotnet.deployAlternative(path, serialPath, target, nanoFrameworkExtensionPath);
    }));

    context.subscriptions.push(vscode.commands.registerCommand('vscode-nanoframework.nfflash', async () => {
		multiStepInput(context, nanoFrameworkExtensionPath);
	}));

    context.subscriptions.push(vscode.window.onDidCloseTerminal((closedTerminal: vscode.Terminal) => {
        Executor.onDidCloseTerminal(closedTerminal);
    }));
}

// this method is called when your extension is deactivated
export function deactivate() {}
