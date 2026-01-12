/*---------------------------------------------------------------------------------------------
 * Copyright (c) .NET Foundation and Contributors.
 * Portions Copyright (c) Microsoft Corporation.  All rights reserved.
 * See LICENSE file in the project root for full license information.
 *--------------------------------------------------------------------------------------------*/

import * as path from "path";
import * as os from 'os';
import * as fs from 'fs';
import { Executor } from "./executor";
import * as cp from 'child_process';
import * as vscode from 'vscode';

const mdpBuildProperties = ' -p:NFMDP_PE_Verbose=false -p:NFMDP_PE_VerboseMinimize=false';

/**
 * Finds the msbuild executable path on Unix systems (macOS/Linux)
 * @returns The path to msbuild or null if not found
 */
function findUnixMsBuild(): string | null {
    // Common locations for msbuild on Unix systems
    const locations = [
        '/usr/bin/msbuild',
        '/usr/local/bin/msbuild',
        '/Library/Frameworks/Mono.framework/Versions/Current/Commands/msbuild',
        '/Library/Frameworks/Mono.framework/Commands/msbuild',
        path.join(os.homedir(), '.dotnet/tools/msbuild')
    ];
    
    for (const loc of locations) {
        if (fs.existsSync(loc)) {
            return loc;
        }
    }
    
    // Try to find via 'which' command
    try {
        const result = cp.execSync('which msbuild', { encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] });
        const msbuildPath = result.trim();
        if (msbuildPath && fs.existsSync(msbuildPath)) {
            return msbuildPath;
        }
    } catch {
        // which command failed, msbuild not in PATH
    }
    
    return null;
}

/**
 * Finds the nuget executable path on Unix systems (macOS/Linux)
 * @returns The path to nuget or null if not found
 */
function findUnixNuget(): string | null {
    // Common locations for nuget on Unix systems
    const locations = [
        '/usr/bin/nuget',
        '/usr/local/bin/nuget',
        '/Library/Frameworks/Mono.framework/Versions/Current/Commands/nuget',
        '/Library/Frameworks/Mono.framework/Commands/nuget'
    ];
    
    for (const loc of locations) {
        if (fs.existsSync(loc)) {
            return loc;
        }
    }
    
    // Try to find via 'which' command
    try {
        const result = cp.execSync('which nuget', { encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] });
        const nugetPath = result.trim();
        if (nugetPath && fs.existsSync(nugetPath)) {
            return nugetPath;
        }
    } catch {
        // which command failed, nuget not in PATH
    }
    
    return null;
}

/**
 * Builds the nanoFramework project system path using proper path separators
 * @param toolPath The base tool path
 * @returns Properly formatted path for the current platform
 */
function buildNanoFrameworkProjectSystemPath(toolPath: string): string {
    return path.join(toolPath, 'nanoFramework', 'v1.0') + path.sep;
}

export class Dotnet {
    /**
     * Builds the nanoFramework solution in a Terminal using MSBuild.exe (win32) or msbuild from mono (linux/macOS)
     * @param fileUri absolute path to *.sln
     * @param toolPath absolute path to root of nanoFramework extension 
     */
    public static build(fileUri: string, toolPath: string) {
        if (fileUri) {
            const nfProjectSystemPath = buildNanoFrameworkProjectSystemPath(toolPath);
            
            // Using dynamically-solved MSBuild.exe when run from win32
            if (os.platform() === "win32") {
                Executor.runInTerminal('$path = & "${env:ProgramFiles(x86)}\\microsoft visual studio\\installer\\vswhere.exe" -products * -latest -prerelease -requires Microsoft.Component.MSBuild -find MSBuild\\**\\Bin\\amd64\\MSBuild.exe | select-object -first 1; ' +
                    'nuget restore "' + fileUri + '"; ' +
                    '& $path "' + fileUri + '" -p:platform="Any CPU" "-p:NanoFrameworkProjectSystemPath=' + nfProjectSystemPath + '" ' + mdpBuildProperties + ' -verbosity:minimal');
            }
            // Using msbuild (comes with mono-complete) on Unix 
            else {
                const msbuildPath = findUnixMsBuild();
                const nugetPath = findUnixNuget();
                
                if (!msbuildPath) {
                    vscode.window.showErrorMessage(
                        'msbuild not found. Please install mono-complete from the Mono Project (not from your distribution\'s package manager). ' +
                        'Visit: https://www.mono-project.com/download/stable/',
                        'View Installation Guide'
                    ).then(selection => {
                        if (selection === 'View Installation Guide') {
                            vscode.env.openExternal(vscode.Uri.parse('https://www.mono-project.com/download/stable/'));
                        }
                    });
                    return;
                }
                
                if (!nugetPath) {
                    vscode.window.showErrorMessage(
                        'nuget not found. Please install nuget CLI. ' +
                        'On macOS: brew install nuget | On Linux: sudo apt install nuget',
                        'View NuGet Downloads'
                    ).then(selection => {
                        if (selection === 'View NuGet Downloads') {
                            vscode.env.openExternal(vscode.Uri.parse('https://www.nuget.org/downloads'));
                        }
                    });
                    return;
                }
                
                // Use the found paths with proper quoting for paths with spaces
                const buildCommand = `"${nugetPath}" restore "${fileUri}" && "${msbuildPath}" "${fileUri}" -p:platform="Any CPU" "-p:NanoFrameworkProjectSystemPath=${nfProjectSystemPath}" ${mdpBuildProperties} -verbosity:minimal`;
                Executor.runInTerminal(buildCommand);
            }
        }
    }

    /**
     * First builds nanoFramework solution, then deploys this built solution to selected device
     * @param fileUri absolute path to *.sln 
     * @param serialPath path to connected nanoFramework device (e.g. COM4 or /dev/tty.usbserial*)
     * @param toolPath absolute path to root of nanoFramework extension 
     */
    public static async deploy(fileUri: string, serialPath: string, toolPath: string) {
        if (fileUri) {
            const outputDir = path.join(path.dirname(fileUri), 'OutputDir') + path.sep;
            const nfProjectSystemPath = buildNanoFrameworkProjectSystemPath(toolPath);
            
            const cliBuildArgumentsBase = `-p:platform="Any CPU" "-p:NanoFrameworkProjectSystemPath=${nfProjectSystemPath}" ${mdpBuildProperties} -verbosity:minimal "-p:OutDir=${outputDir}"`;
            const cliDeployArguments = `nanoff --nanodevice --deploy --serialport "${serialPath}" --image "${outputDir}`;
            let binaryFile: string;

            if (os.platform() === "win32") {
                // Run nuget restore and call msbuild 
                Executor.runInTerminal('$path = & "${env:ProgramFiles(x86)}\\microsoft visual studio\\installer\\vswhere.exe" -products * -latest -prerelease -requires Microsoft.Component.MSBuild -find MSBuild\\**\\Bin\\amd64\\MSBuild.exe | select-object -first 1; ' +
                    'nuget restore "' + fileUri + '"; ' +
                    '& $path "' + fileUri + '" ' + cliBuildArgumentsBase);

                // Grab the binary file name
                binaryFile = await executeMSBuildAndFindBinaryFile(fileUri, cliBuildArgumentsBase);
            }
            else {
                const msbuildPath = findUnixMsBuild();
                const nugetPath = findUnixNuget();
                
                if (!msbuildPath || !nugetPath) {
                    vscode.window.showErrorMessage(
                        'msbuild or nuget not found. Please install mono-complete from the Mono Project and nuget CLI.',
                        'View Installation Guide'
                    ).then(selection => {
                        if (selection === 'View Installation Guide') {
                            vscode.env.openExternal(vscode.Uri.parse('https://www.mono-project.com/download/stable/'));
                        }
                    });
                    return;
                }
                
                // Run nuget restore and call msbuild with proper quoting
                Executor.runInTerminal(`"${nugetPath}" restore "${fileUri}" && "${msbuildPath}" "${fileUri}" ${cliBuildArgumentsBase}`);

                // Grab the binary file name
                binaryFile = await executeMSBuildAndFindBinaryFile(fileUri, cliBuildArgumentsBase, msbuildPath);
            }

            // Deploy the binary file to the selected device
            Executor.runInTerminal(cliDeployArguments + binaryFile + '"');
        }
    }

    /**
     * Flashes the selected device to new firmware using nanoFirmwareFlasher
     * @param cliArguments CLI arguments passed to nanoff
     */
    public static flash(cliArguments: string) {
        if (cliArguments) {
            Executor.runInTerminal(`nanoff --update ${cliArguments}`);
        }
    }
}

/**
 * Function to run the build again and grab the binary file name
 * @param fileUri absolute path to *.sln
 * @param cliBuildArguments CLI arguments passed to msbuild
 * @param unixMsBuildPath optional path to msbuild on Unix systems
 * @returns binary file name
 * @throws Error if the binary file name is not found in the build output
 * @throws Error if the MSBuild path is not found
 * @throws Error if the MSBuild command fails
 * @throws Error if the executable name is not found in the build output
 */
function executeMSBuildAndFindBinaryFile(fileUri: string, cliBuildArguments: string, unixMsBuildPath?: string): Promise<string> {
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
                const msBuildPath = paths.find(p => p.trim() !== '');

                if (!msBuildPath) {
                    vscode.window.showErrorMessage('MSBuild path not found.');
                    reject(new Error('MSBuild path not found.'));
                    return;
                }

                // Construct MSBuild command using the found path
                const buildCmd = `"${msBuildPath}" "${fileUri}" ${cliBuildArguments}`;

                // Second execution to run MSBuild
                cp.exec(buildCmd, (error, stdout, stderr) => {
                    if (error) {
                        vscode.window.showErrorMessage(`Error rebuilding: ${error}`);
                        reject(error);
                        return;
                    }
                    // Parse stdout to find the binary file name
                    const binName = extractBinaryFileName(stdout);
                    if (binName) {
                        resolve(binName);
                    } else {
                        vscode.window.showErrorMessage('Executable name not found in build output.');
                        reject(new Error('Executable name not found in build output.'));
                    }
                });
            });
        } else {
            // For non-Windows platforms, use the provided msbuild path or try to find it
            const msbuildPath = unixMsBuildPath || findUnixMsBuild();
            
            if (!msbuildPath) {
                vscode.window.showErrorMessage('msbuild not found. Please install mono-complete from the Mono Project.');
                reject(new Error('msbuild not found.'));
                return;
            }
            
            const buildCmd = `"${msbuildPath}" "${fileUri}" ${cliBuildArguments}`;

            // Execute msbuild
            cp.exec(buildCmd, (error, stdout, stderr) => {
                if (error) {
                    vscode.window.showErrorMessage(`Error rebuilding: ${error.message}`);
                    reject(error);
                    return;
                }
                // Parse stdout to find the binary file name
                const binName = extractBinaryFileName(stdout);
                if (binName) {
                    resolve(binName);
                } else {
                    vscode.window.showErrorMessage('Executable name not found in build output.');
                    reject(new Error('Executable name not found in build output.'));
                }
            });
        }
    });
}

/**
 * Extracts the binary file name from MSBuild output
 * @param stdout The stdout from MSBuild
 * @returns The binary file name (.bin) or null if not found
 */
function extractBinaryFileName(stdout: string): string | null {
    const lines = stdout.split('\n');
    const exeLine = lines.find(line => line.trim().endsWith('.exe'));
    if (exeLine) {
        const exeName = path.basename(exeLine.trim());
        // Rename the executable from .exe to .bin
        return exeName.replace('.exe', '.bin');
    }
    return null;
}
