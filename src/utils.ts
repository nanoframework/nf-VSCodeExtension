
import globby = require('globby');
import * as vscode from 'vscode';

export function getDocumentWorkspaceFolder(): string | undefined {
    const fileName = vscode.window.activeTextEditor?.document.fileName;
    return vscode.workspace.workspaceFolders
      ?.map((folder) => folder.uri.fsPath)
      .filter((fsPath) => fileName?.startsWith(fsPath))[0]
	  .replace(/\\/g, "/"); 
}

export async function chooseSolution(workspaceFolder: string) {
    const paths = await globby(`${workspaceFolder}/**/*.sln`);  

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
