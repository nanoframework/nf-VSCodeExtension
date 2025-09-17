/*---------------------------------------------------------------------------------------------
 * Copyright (c) .NET Foundation and Contributors.
 * Portions Copyright (c) Microsoft Corporation.  All rights reserved.
 * See LICENSE file in the project root for full license information.
 *--------------------------------------------------------------------------------------------*/

import * as path from "path";
import * as os from 'os';
import { Executor } from "./executor";
import * as cp from 'child_process';
import * as vscode from 'vscode';

const mdpBuildProperties = ' -p:NFMDP_PE_Verbose=false -p:NFMDP_PE_VerboseMinimize=false';

export class Dotnet {
    /**
     * Builds the nanoFramework solution in a Terminal using MSBuild.exe (win32) or msbuild from mono (linux/macOS)
     * @param fileUri absolute path to *.sln
     * @param toolPath absolute path to root of nanoFramework extension 
     */
    public static build(fileUri: string, toolPath: String) {
        if (fileUri) {
            // using dynamicly-solved MSBuild.exe when ran from win32
            if (os.platform() === "win32") {
                Executor.runInTerminal('$path = & "${env:ProgramFiles(x86)}\\microsoft visual studio\\installer\\vswhere.exe" -products * -latest -prerelease -requires Microsoft.Component.MSBuild -find MSBuild\\**\\Bin\\amd64\\MSBuild.exe | select-object -first 1; ' +
                    'nuget restore "' + fileUri + '"; ' +
                    '& $path "' + fileUri + '" -p:platform="Any CPU" -p:NanoFrameworkProjectSystemPath=' + toolPath + '\\nanoFramework\\v1.0\\ ' + mdpBuildProperties + ' -verbosity:minimal');
            }
            // using msbuild (comes with mono-complete) on unix 
            else {
                Executor.runInTerminal(`nuget restore "${fileUri}" && msbuild "${fileUri}" -p:platform="Any CPU" -p:NanoFrameworkProjectSystemPath=${toolPath}/nanoFramework/v1.0/ -verbosity:minimal`);
            }
        }
    }

    /**
     * First builds nanoFramework solution, then deploys this built solution to selected device
     * @param fileUri absolute path to *.sln 
     * @param serialPath path to connected nanoFramework device (e.g. COM4 or /dev/tty.usbserial*)
     * @param toolPath absolute path to root of nanoFramework extension 
     */
    public static async deploy(fileUri: string, serialPath: string, toolPath: String) {
        if (fileUri) {
            const outputDir = path.dirname(fileUri) + '/OutputDir/';
            const cliBuildArgumentsLinux = `-p:platform="Any CPU" /p:NanoFrameworkProjectSystemPath=${toolPath}/nanoFramework/v1.0/ ${mdpBuildProperties} -verbosity:minimal /p:OutDir=${outputDir}`;
            const cliBuildArgumentsWindows = `-p:platform="Any CPU" /p:NanoFrameworkProjectSystemPath=` + toolPath + `\\nanoFramework\\v1.0\\  ${mdpBuildProperties} -verbosity:minimal /p:OutDir=${outputDir}`;
            const cliDeployArguments = `nanoff --nanodevice --deploy --serialport  ${serialPath} --image ${outputDir}`;
            var binaryFile;

            if (os.platform() === "win32") {
                // run nuget restore and call msbuild 
                Executor.runInTerminal('$path = & "${env:ProgramFiles(x86)}\\microsoft visual studio\\installer\\vswhere.exe" -products * -latest -prerelease -requires Microsoft.Component.MSBuild -find MSBuild\\**\\Bin\\amd64\\MSBuild.exe | select-object -first 1; ' +
                    'nuget restore "' + fileUri + '"; ' +
                    '& $path ' + fileUri + ' ' + cliBuildArgumentsWindows);

                // grab the binary file name
                binaryFile = await executeMSBuildAndFindBinaryFile(fileUri, cliBuildArgumentsWindows);
            }
            else {
                // run nuget restore and call msbuild 
                Executor.runInTerminal(`nuget restore "${fileUri}" && \
                    msbuild "${fileUri}" ${cliBuildArgumentsLinux}`);

                // grab the binary file name
                binaryFile = await executeMSBuildAndFindBinaryFile(fileUri, cliBuildArgumentsLinux);
            }

            // deploy the binary file to the selected device
            Executor.runInTerminal(cliDeployArguments + binaryFile);
        }
    }

    /**
     * Flashes the selected device to new firmware using nanoFirmwareFlasher
     * @param cliArguments CLI arguments passed to nanoff
     */
    public static flash(cliArguments: String) {
        if (cliArguments) {
            Executor.runInTerminal(`nanoff --update ${cliArguments}`);
        }
    }
}

/**
 * Function to run the build again and grab the binary file name
 * @param fileUri absolute path to *.sln
 * @param cliBuildArguments CLI arguments passed to msbuild
 * @returns binary file name
 * @throws Error if the binary file name is not found in the build output
 * @throws Error if the MSBuild path is not found
 * @throws Error if the MSBuild command fails
 * @throws Error if the executable name is not found in the build output
 */
function executeMSBuildAndFindBinaryFile(fileUri: string, cliBuildArguments: string): Promise<string> {
    return new Promise(async (resolve, reject) => {

        if (os.platform() === "win32") {

            // Command to find MSBuild
            const findMSBuildCmd = `"${process.env['ProgramFiles(x86)']}\\microsoft visual studio\\installer\\vswhere.exe" -products * -latest -prerelease -requires Microsoft.Component.MSBuild -find MSBuild\\**\\Bin\\amd64\\MSBuild.exe`;

            // First execution to find MSBuild path
            cp.exec(findMSBuildCmd, (error, stdout, stderr) => {
                if (error) {
                    vscode.window.showErrorMessage(`Error finding MSBuild: ${error}`);
                    reject(error);
                    return;
                }

                // Split the output by new lines to get an array of paths
                const paths = stdout.split(/\r?\n/);

                // Select the first non-empty path as the MSBuild path
                const msBuildPath = paths.find(path => path.trim() !== '');

                if (!msBuildPath) {
                    vscode.window.showErrorMessage('MSBuild path not found.');
                    reject(new Error('MSBuild path not found.'));
                    return;
                }

                // Construct MSBuild command using the found path
                const buildCmd = `"${msBuildPath}" ${fileUri} ${cliBuildArguments}`;

                // Second execution to run MSBuild
                cp.exec(buildCmd, (error, stdout, stderr) => {
                    if (error) {
                        vscode.window.showErrorMessage(`Error rebuilding: ${error}`);
                        reject(error);
                        return;
                    }
                    // Parse stdout to find the binary file name
                    const lines = stdout.split('\n');
                    const exeLine = lines.find(line => line.trim().endsWith('.exe'));
                    if (exeLine) {
                        const exeName = path.basename(exeLine.trim());
                        // Rename the executable from .exe to .bin
                        const binName = exeName.replace('.exe', '.bin');
                        // Resolve the promise with the binary file name
                        resolve(binName);
                    } else {
                        vscode.window.showErrorMessage('Executable name not found in build output.');
                        reject(new Error('Executable name not found in build output.'));
                    }
                });
            });
        } else {
            // For non-Windows platforms, we can directly call msbuild
            const buildCmd = `msbuild "${fileUri}" ${cliBuildArguments}`;

            // Second execution to run MSBuild
            cp.exec(buildCmd, (error, stdout, stderr) => {
                if (error) {
                    vscode.window.showErrorMessage(`Error rebuilding: ${error}`);
                    reject(error);
                    return;
                }
                // Parse stdout to find the binary file name
                const lines = stdout.split('\n');
                const exeLine = lines.find(line => line.trim().endsWith('.exe'));
                if (exeLine) {
                    const exeName = path.basename(exeLine.trim());
                    // Rename the executable from .exe to .bin
                    const binName = exeName.replace('.exe', '.bin');
                    // Resolve the promise with the binary file name
                    resolve(binName);
                } else {
                    vscode.window.showErrorMessage('Executable name not found in build output.');
                    reject(new Error('Executable name not found in build output.'));
                }
            });
        }
    });
}
