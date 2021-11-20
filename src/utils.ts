/*---------------------------------------------------------------------------------------------
 * Copyright (c) .NET Foundation and Contributors.
 * Portions Copyright (c) Microsoft Corporation.  All rights reserved.
 * See LICENSE file in the project root for full license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import * as os from 'os';
import { SerialPortCtrl } from "./serialportctrl";

const globby = require('globby');
const axios = require('axios');

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

export async function chooseSerialPort(nanoFrameworkExtensionPath: string) {
	const ports = await SerialPortCtrl.list(nanoFrameworkExtensionPath);

	const devicePaths = ports
			.map((label) => ({ label: label.port, description: label.desc }));

	const selectedPort = await vscode.window.showQuickPick(devicePaths, {
		placeHolder: 'Select the ports you would like to build/deploy',
	});
	
	return selectedPort ? selectedPort.label : '';
}

export async function chooseTarget(nanoFrameworkExtensionPath: string) {
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
