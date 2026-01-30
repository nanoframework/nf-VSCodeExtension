/*---------------------------------------------------------------------------------------------
 * Copyright (c) .NET Foundation and Contributors.
 * Portions Copyright (c) Microsoft Corporation.  All rights reserved.
 * See LICENSE file in the project root for full license information.
 *--------------------------------------------------------------------------------------------*/

/* eslint-disable @typescript-eslint/no-require-imports, @typescript-eslint/no-explicit-any */
// Note: axios uses CommonJS require pattern

import { QuickPickItem, window, Disposable, QuickInputButton, QuickInput, ExtensionContext, QuickInputButtons } from 'vscode';
import { Dotnet } from './dotnet';
import { SerialPortCtrl } from "./serialportctrl";

const axios = require('axios');

/**
 * A multi-step input using window.createQuickPick() and window.createInputBox().
 * @param _context 
 * @param _toolPath 
 */
export async function multiStepInput(_context: ExtensionContext, _toolPath: string) {
	const dfuJtagOptions: QuickPickItem[] = ['DFU mode', 'JTAG mode']
		.map(label => ({ label }));

	const baudRates: QuickPickItem[] = [
		{ label: 'Default (auto)', description: 'Let nanoff choose the best speed' },
		{ label: '1500000', description: 'Fastest - may not work on all devices' },
		{ label: '921600' },
		{ label: '460800' },
		{ label: '115200', description: 'Most compatible' }
	];

	const backupOptions: QuickPickItem[] = [
		{ label: 'No', description: 'Flash without backup (faster)' },
		{ label: 'Yes', description: 'Backup device before flashing' }
	];

	const massEraseOptions: QuickPickItem[] = [
		{ label: 'No', description: 'Keep existing data on device' },
		{ label: 'Yes', description: 'Erase entire flash before flashing' }
	];

	interface State {
		title: string;
		step: number;
		totalSteps: number;
		targetName: string;
		targetNameType: string;
		imageVersion: QuickPickItem;
		dfuOrJtag: QuickPickItem;
		devicePath: string;
		baudrate: string;
		backupDevice: boolean;
		massErase: boolean;
	}

	async function collectInputs() {
		const state = {} as Partial<State>;
		await MultiStepInput.run(input => picktargetName(input, state));
		return state as State;
	}

	const title = 'Flash connected device with nanoFramework';

	async function picktargetName(input: MultiStepInput, state: Partial<State>) {
		const targetImages = await getTargetNames();
		const pick = await input.showQuickPick({
			title,
			step: 1,
			totalSteps: 4,
			placeholder: 'Choose a target board',
			items: targetImages,
			shouldResume: shouldResume
		});

		state.targetName = pick.label || '';

		switch (state.targetName?.substring(0, 3)) {
			case 'ST_':
			case 'MBN':
			case 'NET':
			case 'GHI':
			case 'Ing':
			case 'WeA':
			case 'ORG':
			case 'Pyb':
				state.targetNameType = 'STM32';
				state.totalSteps = 3;
				break;
			case 'TI_':
				state.targetNameType = 'TI';
				state.totalSteps = 2;
				break;
			case 'SL_':
				state.targetNameType = 'SL';
				state.totalSteps = 2;
				break;
			default:
				state.targetNameType = 'ESP32';
				state.totalSteps = 6;  // target, version, device, baud, backup, masserase
				break;
		}

		return (input: MultiStepInput) => imageVersion(input, state);
	}

	async function imageVersion(input: MultiStepInput, state: Partial<State>) {
		const imageVersions = await getImageVersions(state.targetName);

		const imageVersion = await input.showQuickPick({
			title,
			step: 2,
			totalSteps: state.totalSteps || 5,
			placeholder: 'Choose the image version for your target board (' + state.targetName + ')',
			items: imageVersions,
			shouldResume: shouldResume,
			// Set the default selection to the latest version
			activeItem: imageVersions[0]
		});

		state.imageVersion = imageVersion;

		if ((state.targetNameType !== 'TI') && (state.targetNameType !== 'SL')) {
			return (input: MultiStepInput) => state.targetNameType === 'ESP32' ? pickDevicePath(input, state) : pickJTAGOrDFU(input, state);
		}
	}

	// step 3, only for ESP32 devices
	async function pickDevicePath(input: MultiStepInput, state: Partial<State>) {
		const devices = await getDevices();

		const devicePath = await input.showQuickPick({
			title,
			step: 3,
			totalSteps: 5,
			placeholder: 'Choose the device path that you want to flash',
			items: devices,
			shouldResume: shouldResume
		});

		state.devicePath = devicePath.label;

		return (input: MultiStepInput) => pickBaudrate(input, state);
	}

	// step 4, only for ESP32 devices
	async function pickBaudrate(input: MultiStepInput, state: Partial<State>) {
		const baudrate = await input.showQuickPick({
			title,
			step: 4,
			totalSteps: 5,
			placeholder: 'Pick a baud rate (Default recommended)',
			items: baudRates,
			shouldResume: shouldResume,
			// Set the default selection to the default (auto) baud rate
			activeItem: baudRates[0]
		});

		// Store the label - will check for "Default" when building CLI args
		state.baudrate = baudrate.label;

		return (input: MultiStepInput) => pickBackupOption(input, state);
	}

	// step 5, only for ESP32 devices - ask about backup
	async function pickBackupOption(input: MultiStepInput, state: Partial<State>) {
		const backup = await input.showQuickPick({
			title,
			step: 5,
			totalSteps: 6,
			placeholder: 'Backup device before flashing?',
			items: backupOptions,
			shouldResume: shouldResume,
			// Default to "No" (no backup)
			activeItem: backupOptions[0]
		});

		state.backupDevice = backup.label === 'Yes';

		return (input: MultiStepInput) => pickMassEraseOption(input, state);
	}

	// step 6, only for ESP32 devices - ask about mass erase
	async function pickMassEraseOption(input: MultiStepInput, state: Partial<State>) {
		const massErase = await input.showQuickPick({
			title,
			step: 6,
			totalSteps: 6,
			placeholder: 'Mass erase device before flashing?',
			items: massEraseOptions,
			shouldResume: shouldResume,
			// Default to "No" (no mass erase)
			activeItem: massEraseOptions[0]
		});

		state.massErase = massErase.label === 'Yes';
	}

	// step 3, only for Texas Instrument devices
	async function pickJTAGOrDFU(input: MultiStepInput, state: Partial<State>) {
		state.dfuOrJtag = await input.showQuickPick({
			title,
			step: 3,
			totalSteps: 3,
			placeholder: 'In what mode would you like to flash the device?',
			items: dfuJtagOptions,
			shouldResume: shouldResume
		});
	}

	function shouldResume() {
		// Could show a notification with the option to resume.
		return new Promise<boolean>((_resolve, _reject) => {
			// noop
		});
	}

	/**
	 * Helper function that dynamically gets all possible target images from different APIs
	 * @returns QuickPickItem[] with distinct (unique), sorted (a-z) list of target boards
	 */
	async function getTargetNames(): Promise<QuickPickItem[]> {
		const apiUrl = 'https://api.cloudsmith.io/v1/packages/net-nanoframework/';

		const apiRepos = ['nanoframework-images-dev', 'nanoframework-images', 'nanoframework-images-community-targets']
			.map(repo => axios.get(apiUrl + repo + '/?page_size=500&q=uploaded:>\'1 month ago\''));

		const imageArray: string[] = [];
		let targetImages: QuickPickItem[] = [];

		await Promise
			.all(apiRepos)
			.then((responses: any) => {
				responses.forEach((res: { data: { name: string; }[]; }) => {
					res.data.forEach((resData: { name: string; }) => {
						imageArray.push(resData.name);
					});
				});

				targetImages = imageArray
					// Exclude elements starting with "WIN"
					.filter((value: string) => !value.startsWith('WIN'))
					// Remove duplicates
					.filter((value, index, self) => self.indexOf(value) === index)
					.sort()
					.map(label => ({ label }));
			})
			.catch((err: any) => {
				window.showErrorMessage(`Couldn't retrieve live boards from API: ${JSON.stringify(err)}`);

				// return default options if (one) of the HTTP requests fails
				targetImages = ['ESP32_REV0', 'ESP32_PICO']
					.map(label => ({ label }));
			});

		return targetImages;
	}

	/**
	 * Helper function that requests all versions for a given targetName from different APIs
	 * @param targetName target board to get image versions for
	 * @returns QuickPickItem[] with sorted (newest first) list of image versions
	 */
	async function getImageVersions(targetName: string | undefined): Promise<QuickPickItem[]> {
		const apiUrl = 'https://api.cloudsmith.io/v1/packages/net-nanoframework/';

		const apiRepos = ['nanoframework-images-dev', 'nanoframework-images', 'nanoframework-images-community-targets']
			.map(repo => axios.get(apiUrl + repo + '/?page_size=5&query=' + targetName));

		const imageVersions: string[] = [];
		let targetImages: QuickPickItem[] = [];

		await Promise
			.all(apiRepos)
			.then((responses: any) => {
				responses.forEach((res: { data: { version: string; }[]; }) => {
					res.data.forEach((resData: { version: string; }) => {
						imageVersions.push(resData.version);
					});
				});

				targetImages = imageVersions
					.map(label => ({ label }));
			})
			.catch((err: any) => {
				window.showErrorMessage(`Couldn't retrieve live board versions from API: ${JSON.stringify(err)}`);

				// return default options if (one) of the HTTP requests fails
				targetImages = ['latest']
					.map(label => ({ label }));
			});

		// sort versions descending, versions are not sorted properly as string
		targetImages = targetImages.sort((a, b) => {
			const a1 = a.label!.split('.');
			const b1 = b.label!.split('.');
			const len = Math.max(a1.length, b1.length);

			for (let i = 0; i < len; i++) {
				const _a = +a1[i] || 0;
				const _b = +b1[i] || 0;
				if (_a === _b) {
					continue;
				}
				else {
					return _a < _b ? 1 : -1;
				}
			}
			return 0;
		});

		return targetImages;
	}

	/**
	 * Returns a list of all connected serial devices using SerialPortCtrl
	 * @returns QuickPickItem[] with list of serial devices available
	 */
	async function getDevices() {
		try {
			const ports = await SerialPortCtrl.list();

			if (ports.length === 0) {
				window.showWarningMessage('No serial ports found. Please check that your device is connected.');
				return [];
			}

			const devicePaths: QuickPickItem[] = ports
				.map((port) => ({ 
					label: port.port, 
					description: port.desc || `VID:${port.vendorId} PID:${port.productId}` 
				}));

			return devicePaths;
		} catch (error) {
			console.error('Error listing serial ports:', error);
			window.showErrorMessage('Failed to list serial ports. Please check your permissions and device connection.');
			return [];
		}
	}

	const state = await collectInputs();

	window.showInformationMessage(`Flashing '${state.targetName}' device on ${state.devicePath}`);

	let cliArguments: string;

	// build the CLI arguments for the nanoFrameworkFlasher
	// starts with the target name and version
	cliArguments = `--target ${state.targetName} --fwversion ${state.imageVersion.label} `;

	// adds --preview for the nanoFrameworkFlasher when the imageVersion selected is in preview
	if (state.imageVersion.label && state.imageVersion.label.includes("preview")) {
		cliArguments += " --preview";
	}

	// different CLI arguments are given to the nanoFrameworkFlasher based on type of targetName selected
	switch (state.targetName?.substring(0, 3)) {
		case 'ST_':
		case 'MBN':
		case 'NET':
		case 'GHI':
		case 'Ing':
		case 'WeA':
		case 'ORG':
		case 'Pyb':
			cliArguments += ` ${state.dfuOrJtag.label === 'DFU mode' ? '--dfu' : '--jtag'}`;
			break;

		case 'TI_':
		case 'SL_':
			// SL and TI only requires the target and version
			break;

		default:
			// ESP32 devices
			cliArguments += ` --serialport ${state.devicePath}`;
			
			// Only add baud rate if not using default (auto)
			if (state.baudrate && !state.baudrate.startsWith('Default')) {
				cliArguments += ` --baud ${state.baudrate}`;
			}
			
			// Add backup flag if user requested it
			if (state.backupDevice) {
				cliArguments += ' --backup';
			}
			
			// Add mass erase flag if user requested it
			if (state.massErase) {
				cliArguments += ' --masserase';
			}
			break;
	}

	Dotnet.flash(cliArguments);
}

// -------------------------------------------------------
// Helper code that wraps the API for the multi-step case.
// -------------------------------------------------------

class InputFlowAction {
	static back = new InputFlowAction();
	static cancel = new InputFlowAction();
	static resume = new InputFlowAction();
}

type InputStep = (input: MultiStepInput) => Thenable<InputStep | void>;

interface QuickPickParameters<T extends QuickPickItem> {
	title: string;
	step: number;
	totalSteps: number;
	items: T[];
	activeItem?: T;
	placeholder: string;
	buttons?: QuickInputButton[];
	shouldResume: () => Thenable<boolean>;
}

interface InputBoxParameters {
	title: string;
	step: number;
	totalSteps: number;
	value: string;
	prompt: string;
	validate: (value: string) => Promise<string | undefined>;
	buttons?: QuickInputButton[];
	shouldResume: () => Thenable<boolean>;
}

class MultiStepInput {
	private current?: QuickInput;
	private steps: InputStep[] = [];

	static async run(_start: InputStep) {
		const input = new MultiStepInput();
		return input.stepThrough(_start);
	}

	private async stepThrough(start: InputStep) {
		let step: InputStep | void = start;
		while (step) {
			this.steps.push(step);
			if (this.current) {
				this.current.enabled = false;
				this.current.busy = true;
			}
			try {
				step = await step(this);
			} catch (err) {
				if (err === InputFlowAction.back) {
					this.steps.pop();
					step = this.steps.pop();
				} else if (err === InputFlowAction.resume) {
					step = this.steps.pop();
				} else if (err === InputFlowAction.cancel) {
					step = undefined;
				} else {
					throw err;
				}
			}
		}
		if (this.current) {
			this.current.dispose();
		}
	}

	async showQuickPick<T extends QuickPickItem, P extends QuickPickParameters<T>>({ title, step, totalSteps, items, activeItem, placeholder, buttons, shouldResume }: P) {
		const disposables: Disposable[] = [];
		try {
			return await new Promise<T | (P extends { buttons: (infer I)[] } ? I : never)>((resolve, reject) => {
				const input = window.createQuickPick<T>();
				input.title = title;
				input.step = step;
				input.totalSteps = totalSteps;
				input.placeholder = placeholder;
				input.items = items;
				if (activeItem) {
					input.activeItems = [activeItem];
				}
				input.buttons = [
					...(this.steps.length > 1 ? [QuickInputButtons.Back] : []),
					...(buttons || [])
				];
				disposables.push(
					input.onDidTriggerButton(item => {
						if (item === QuickInputButtons.Back) {
							reject(InputFlowAction.back);
						} else {
							resolve(<any>item);
						}
					}),
					input.onDidChangeSelection(items => resolve(items[0])),
					input.onDidHide(() => {
						(async () => {
							reject(shouldResume && await shouldResume() ? InputFlowAction.resume : InputFlowAction.cancel);
						})()
							.catch(reject);
					})
				);
				if (this.current) {
					this.current.dispose();
				}
				this.current = input;
				this.current.show();
			});
		} finally {
			disposables.forEach(d => d.dispose());
		}
	}

	async showInputBox<P extends InputBoxParameters>({ title, step, totalSteps, value, prompt, validate, buttons, shouldResume }: P) {
		const disposables: Disposable[] = [];
		try {
			return await new Promise<string | (P extends { buttons: (infer I)[] } ? I : never)>((resolve, reject) => {
				const input = window.createInputBox();
				input.title = title;
				input.step = step;
				input.totalSteps = totalSteps;
				input.value = value || '';
				input.prompt = prompt;
				input.buttons = [
					...(this.steps.length > 1 ? [QuickInputButtons.Back] : []),
					...(buttons || [])
				];
				let validating = validate('');
				disposables.push(
					input.onDidTriggerButton(item => {
						if (item === QuickInputButtons.Back) {
							reject(InputFlowAction.back);
						} else {
							resolve(<any>item);
						}
					}),
					input.onDidAccept(async () => {
						const value = input.value;
						input.enabled = false;
						input.busy = true;
						if (!(await validate(value))) {
							resolve(value);
						}
						input.enabled = true;
						input.busy = false;
					}),
					input.onDidChangeValue(async text => {
						const current = validate(text);
						validating = current;
						const validationMessage = await current;
						if (current === validating) {
							input.validationMessage = validationMessage;
						}
					}),
					input.onDidHide(() => {
						(async () => {
							reject(shouldResume && await shouldResume() ? InputFlowAction.resume : InputFlowAction.cancel);
						})()
							.catch(reject);
					})
				);
				if (this.current) {
					this.current.dispose();
				}
				this.current = input;
				this.current.show();
			});
		} finally {
			disposables.forEach(d => d.dispose());
		}
	}
}
