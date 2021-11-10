// The module 'vscode' contains the VS Code extensibility API
// Import the module and reference it with the alias vscode in your code below
import * as vscode from 'vscode';
import { Dotnet } from "./dotnet";
import { Executor } from "./executor";

import { multiStepInput } from './multiStepInput';
import { solvePath } from './utils';

// this method is called when your extension is activated
// your extension is activated the very first time the command is executed
export async function activate(context: vscode.ExtensionContext) {
	
	console.log('The "nanoframeworkextension" is now active!');
    
    const workspaceFolder = vscode.workspace.workspaceFolders ? vscode.workspace.workspaceFolders[0].uri.path : '';
    const nanoFrameworkExtensionPath = context.extensionPath + '/out/utils/';

	context.subscriptions.push(vscode.commands.registerCommand("nanoframeworkextension.nfbuild", async (fileUri: vscode.Uri, ) => {
        let path = await solvePath(fileUri, workspaceFolder);
        Dotnet.build(path, nanoFrameworkExtensionPath);
    }));

    context.subscriptions.push(vscode.commands.registerCommand("nanoframeworkextension.nfdeploy", async (fileUri: vscode.Uri, ) => {
        let path = await solvePath(fileUri, workspaceFolder);
        Dotnet.deploy(path, nanoFrameworkExtensionPath);
    }));

	context.subscriptions.push(vscode.window.onDidCloseTerminal((closedTerminal: vscode.Terminal) => {
        Executor.onDidCloseTerminal(closedTerminal);
    }));

    context.subscriptions.push(vscode.commands.registerCommand('nanoframeworkextension.nfflash', async () => {
		multiStepInput(context, nanoFrameworkExtensionPath);
	}));
}

// this method is called when your extension is deactivated
export function deactivate() {}
