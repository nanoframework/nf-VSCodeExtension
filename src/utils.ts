/*---------------------------------------------------------------------------------------------
 * Copyright (c) .NET Foundation and Contributors.
 * Portions Copyright (c) Microsoft Corporation.  All rights reserved.
 * See LICENSE file in the project root for full license information.
 *--------------------------------------------------------------------------------------------*/

/* eslint-disable @typescript-eslint/no-require-imports, @typescript-eslint/no-explicit-any */
// Note: axios uses CommonJS require pattern

import * as vscode from 'vscode';
import * as os from 'os';
import { SerialPortCtrl } from "./serialportctrl";

const axios = require('axios');

/**
 * Gets absolute path of current open workspace in VSCode
 * @returns (first) absolute path of the workspace folder
 */
export function getDocumentWorkspaceFolder(): string | undefined {
    return vscode.workspace.workspaceFolders?.map((folder) => folder.uri.fsPath)[0];
}

/**
 * Finds all *.sln files in your VSCode Workspace
 * Shows a QuickPick window that lets the user select one of these solutions
 * Returns the absolute path to the selected solution
 * @param workspaceFolder absolute path to workspace
 * @returns absolute path to selected *.sln
 */
export async function chooseSolution(workspaceFolder: string) {
    // Use VS Code's built-in findFiles API instead of globby
    const files = await vscode.workspace.findFiles('**/*.sln', '**/node_modules/**');
    const paths = files.map(file => file.fsPath);

	const result = await vscode.window.showQuickPick(paths, {
		placeHolder: 'Select the solution you would like to build/deploy',
	});

    return result || '';
}

/**
 * Dynamically gets all connected serial ports and lets the user select the port they would like to flash
 * @returns selected serial port path or empty string if cancelled
 */
export async function chooseSerialPort(): Promise<string> {
	try {
		const ports = await SerialPortCtrl.list();

		if (ports.length === 0) {
			vscode.window.showWarningMessage(
				'No serial ports found. Please check that your device is connected.',
				'Troubleshooting'
			).then(selection => {
				if (selection === 'Troubleshooting') {
					vscode.env.openExternal(vscode.Uri.parse('https://github.com/nanoframework/nf-VSCodeExtension#troubleshooting'));
				}
			});
			return '';
		}

		const devicePaths = ports.map((port) => ({ 
			label: port.port, 
			description: port.desc || `VID:${port.vendorId} PID:${port.productId}` 
		}));

		const selectedPort = await vscode.window.showQuickPick(devicePaths, {
			placeHolder: 'Select the serial port for your device',
		});
		
		return selectedPort ? selectedPort.label : '';
	} catch (error) {
		console.error('Error listing serial ports:', error);
		vscode.window.showErrorMessage(
			'Failed to list serial ports. Please check your permissions and device connection.'
		);
		return '';
	}
}

/**
 * Dynamically fetches all possible types of target boards and lets user select the appropriate one
 * @param _toolPath absolute path to nanoFramework extension (kept for backward compatibility)
 * @returns selected target board
 */
export async function chooseTarget(_toolPath: string) {
	const apiUrl = 'https://api.cloudsmith.io/v1/packages/net-nanoframework/';

	const apiRepos = ['nanoframework-images-dev', 'nanoframework-images', 'nanoframework-images-community-targets']
		.map(repo => axios.get(apiUrl + repo));

	let imageArray:string[] = [];

	await Promise
		.all(apiRepos)
		.then((responses: any)=>{
			responses.forEach((res: { data: { name: string; }[]; }) => {
				res.data.forEach((resData: { name: string; }) => {
					imageArray.push(resData.name);
				});
			});
		})
		.catch((err: any) => {
			vscode.window.showErrorMessage(`Couldn't retrieve live boards from API: ${JSON.stringify(err)}`);

			// return default options if (one) of the HTTP requests fails
			imageArray = ['ESP32_WROOM_32', 'ESP32_PICO'];
		});

	const targetImages = imageArray
		.filter((v, i, a) => a.indexOf(v) === i) // remove duplicates
		.sort() //sort
		.map((label) => label);

	const selectedTarget = await vscode.window.showQuickPick(targetImages, {
		placeHolder: 'Select the target for your device',
	});

	return selectedTarget ? selectedTarget : '';
}

/**
 * If a path to a specific .sln is given, this is used. 
 * Otherwise, the user is prompted with a selection of all *.sln in workspace to choose from
 * @param fileUri *.sln (can be empty)
 * @param workspaceFolder absolute path to workspace
 * @returns absolute path to selected *.sln file
 */
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

/**
 * Pick a folder where to put the solution
 * Shows a workspace folder picker
 * Returns the absolute path to the selected folder
 * @returns absolute path to the selected folder
 */
export async function chooseSolutionWorkspace(fileUri: vscode.Uri, workspaceFolder: string) {
	let path = fileUri ? fileUri.fsPath: '';
	if(!path && workspaceFolder) {
		const result = await vscode.window.showWorkspaceFolderPick();
		path = result?.uri.fsPath || workspaceFolder;
	}
	path = os.platform() === 'win32' ? path.replace(/\//g, "\\") : path;
    return path;
}

/**
 * Choose the name of the solution.
 * @returns the name of the solution
 */
export async function chooseName() {
	const result = await vscode.window.showInputBox({
		placeHolder: 'Enter the name of the solution/project',
	});
	return result || '';
}

/**
 * Choose one of the available project types.
 * @returns the type of the project
 */
export async function chooseProjectType() {
	const result = await vscode.window.showQuickPick(['Blank Application', 'Class Library', 'Unit Test'], {
		placeHolder: 'Select the type of project',
	});
	return result || '';
}