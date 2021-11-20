/*---------------------------------------------------------------------------------------------
 * Copyright (c) .NET Foundation and Contributors.
 * Portions Copyright (c) Microsoft Corporation.  All rights reserved.
 * See LICENSE file in the project root for full license information.
 *--------------------------------------------------------------------------------------------*/

import * as path from "path";
import * as os from 'os';

import { Executor } from "./executor";

export class Dotnet {
    /**
     * Builds the nanoFramework solution in a Terminal using MSBuild.exe (win32) or msbuild from mono (linux/macOS)
     * @param fileUri absolute path to *.sln
     * @param nanoFrameworkExtensionPath absolute path to root of nanoFramework extension 
     */
    public static build(fileUri: string, nanoFrameworkExtensionPath: String) {
        if (fileUri) {
            if(os.platform() === "win32") {
                Executor.runInTerminal('$path = & "${env:ProgramFiles(x86)}\\microsoft visual studio\\installer\\vswhere.exe" -latest -prerelease -requires Microsoft.Component.MSBuild -find MSBuild\\**\\Bin\\MSBuild.exe | select-object -first 1; ' +
                    nanoFrameworkExtensionPath + '/nuget/nuget.exe restore ' + fileUri + '; ' +
                    '& $path ' + fileUri + ' -p:NanoFrameworkProjectSystemPath=' + nanoFrameworkExtensionPath + '/nanoFramework/v1.0/');
            }
            else {
                Executor.runInTerminal(`nuget restore "${fileUri}" && msbuild "${fileUri}" -p:NanoFrameworkProjectSystemPath=${nanoFrameworkExtensionPath}/nanoFramework/v1.0/`);
            }
        }
    }

    /**
     * First builds nanoFramework solution, then deploys this built solution to selected device
     * @param fileUri absolute path to *.sln 
     * @param serialPath path to connected nanoFramework device (e.g. COM4 or /dev/tty.usbserial*)
     * @param nanoFrameworkExtensionPath absolute path to root of nanoFramework extension 
     */
    public static deploy(fileUri: string, serialPath: string, nanoFrameworkExtensionPath: String) {
        if (fileUri) {
            const outputDir = path.dirname(fileUri) + '/OutputDir/';
            const cliBuildArguments = `/p:NanoFrameworkProjectSystemPath=${nanoFrameworkExtensionPath}/nanoFramework/v1.0/ /p:OutDir=${outputDir}`;
            const cliDeployArguments = `${nanoFrameworkExtensionPath}/nanoFrameworkDeployer/nanoFrameworkDeployer.exe -v ${serialPath ? '-c '+ serialPath : ''} -d ${outputDir}`;

            if(os.platform() === "win32") {
                Executor.runInTerminal('$path = & "${env:ProgramFiles(x86)}\\microsoft visual studio\\installer\\vswhere.exe" -latest -prerelease -requires Microsoft.Component.MSBuild -find MSBuild\\**\\Bin\\MSBuild.exe | select-object -first 1; ' +
                    nanoFrameworkExtensionPath + '/nuget/nuget.exe restore ' + fileUri + '; ' +
                    '& $path ' + fileUri + ' ' + cliBuildArguments + '; '+ 
                    cliDeployArguments);            
            }
            else {
                Executor.runInTerminal(`nuget restore "${fileUri}" && \
                    msbuild "${fileUri}" ${cliBuildArguments} && \
                    mono ${cliDeployArguments}`);
            }
        }   
    }

    /**
     * Alternative deploy method, which uses the nanoFrameworkDeployer to create a deploy.bin, which is then 'deployed' through the nanoFrameworkFlasher
     * This deploy method solves compatibility issues that sometimes occur on Linux/macOS when using the nanoFrameworkDeployer
     * @param fileUri absolute path to *.sln 
     * @param serialPath path to connected nanoFramework device (e.g. COM4 or /dev/tty.usbserial*)
     * @param targetImage the type of device connected (e.g. ESP32_REV0, ESP32_PICO)
     * @param nanoFrameworkExtensionPath absolute path to root of nanoFramework extension 
     */
    public static deployAlternative(fileUri: string, serialPath: string, targetImage: string, nanoFrameworkExtensionPath: String) {
        if (fileUri && targetImage) {
            const outputDir = path.dirname(fileUri) + '/OutputDir/';
            const cliBuildArguments = `/p:NanoFrameworkProjectSystemPath=${nanoFrameworkExtensionPath}/nanoFramework/v1.0/ /p:OutDir=${outputDir}`;
            const cliBuildBin = `${nanoFrameworkExtensionPath}/nanoFrameworkDeployer/nanoFrameworkDeployer.exe -v -d ${outputDir} -b`;
            const cliDeploy = `dotnet ${nanoFrameworkExtensionPath}/nanoFirmwareFlasher/nanoff.dll --target ${targetImage} --serialport ${serialPath} --deploy --image ${outputDir}deploy.bin`;

            if(os.platform() === "win32") {
                Executor.runInTerminal('$path = & "${env:ProgramFiles(x86)}\\microsoft visual studio\\installer\\vswhere.exe" -latest -prerelease -requires Microsoft.Component.MSBuild -find MSBuild\\**\\Bin\\MSBuild.exe | select-object -first 1; ' +
                    nanoFrameworkExtensionPath + '/nuget/nuget.exe restore ' + fileUri + '; ' +
                    '& $path ' + fileUri + ' ' + cliBuildArguments + '; '+ 
                    cliBuildBin + '; ' +
                    cliDeploy);            
            }
            else {
                Executor.runInTerminal(`nuget restore "${fileUri}" && \
                    msbuild "${fileUri}" ${cliBuildArguments} && \
                    mono ${cliBuildBin}; \
                    ${cliDeploy}`);
            }
        }   
    }

    /**
     * Flashes the selected device to new firmware using nanoFirmwareFlasher
     * @param nanoFrameworkExtensionPath absolute path to root of nanoFramework extension 
     * @param cliArguments CLI arguments passed to nanoff.dll
     */
    public static flash(nanoFrameworkExtensionPath: String, cliArguments: String) {
        if(nanoFrameworkExtensionPath && cliArguments) {
            Executor.runInTerminal(`dotnet ${nanoFrameworkExtensionPath}/nanoFirmwareFlasher/nanoff.dll --update ${cliArguments}`);
        }
    }
}