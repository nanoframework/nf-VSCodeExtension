
import globby = require('globby');
import * as vscode from 'vscode';
import * as os from 'os';

export function getDocumentWorkspaceFolder(): string | undefined {
    return vscode.workspace.workspaceFolders
      ?.map((folder) => folder.uri.fsPath)[0];
}

export async function chooseSolution(workspaceFolder: string) {
    const paths = await globby(`${workspaceFolder}/**/*.sln`);  

	const result = await vscode.window.showQuickPick(paths, {
		placeHolder: 'Select the solution you would like to build/deploy',
	});

    return result || '';
}

export async function solvePath(fileUri: vscode.Uri, workspaceFolder: string) {
	let path = fileUri ? fileUri.fsPath: '';
	if(!path && workspaceFolder) {
		path = await chooseSolution(
			os.platform() === 'win32' ? 
				workspaceFolder.replace(/\\/g, "/") : 
				workspaceFolder);         
	}
	
	return path;
}
