
import globby = require('globby');
import * as vscode from 'vscode';

export async function chooseSolution(workspaceFolder: string) {
	let i = 0;

    const paths = await globby(workspaceFolder + "/**/*.sln");  

	const result = await vscode.window.showQuickPick(paths, {
		placeHolder: 'Select the solution you would like to build/deploy',
	});
	// vscode.window.showInformationMessage(`Got: ${result}`);

    return result || '';
}

export async function solvePath(fileUri: vscode.Uri, workspaceFolder: string) {
	let path = fileUri ? fileUri.fsPath: '';
	if(!path && workspaceFolder) {
		
		path = await chooseSolution(workspaceFolder);         
	}
	
	return path;
}
