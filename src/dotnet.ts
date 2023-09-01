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
     * @param toolPath absolute path to root of nanoFramework extension 
     */
    public static build(fileUri: string, toolPath: String) {
        if (fileUri) {
            // using dynamicly-solved MSBuild.exe when ran from win32
            if(os.platform() === "win32") {
                Executor.runInTerminal('$path = & "${env:ProgramFiles(x86)}\\microsoft visual studio\\installer\\vswhere.exe" -products * -latest -prerelease -requires Microsoft.Component.MSBuild -find MSBuild\\**\\Bin\\MSBuild.exe | select-object -first 1; ' +
                    toolPath + '/nuget/nuget.exe restore "' + fileUri + '"; ' +
                    '& $path "' + fileUri + '" -p:NanoFrameworkProjectSystemPath=' + toolPath + '\\nanoFramework\\v1.0\\');
            }
            // using msbuild (comes with mono-complete) on unix 
            else {
                Executor.runInTerminal(`nuget restore "${fileUri}" && msbuild "${fileUri}" -p:NanoFrameworkProjectSystemPath=${toolPath}/nanoFramework/v1.0/`);
            }
        }
    }

    /**
     * First builds nanoFramework solution, then deploys this built solution to selected device
     * @param fileUri absolute path to *.sln 
     * @param serialPath path to connected nanoFramework device (e.g. COM4 or /dev/tty.usbserial*)
     * @param toolPath absolute path to root of nanoFramework extension 
     */
    public static deploy(fileUri: string, serialPath: string, toolPath: String) {
        if (fileUri) {
            const outputDir = path.dirname(fileUri) + '/OutputDir/';
            const cliBuildArgumentsLinux = `/p:NanoFrameworkProjectSystemPath=${toolPath}/nanoFramework/v1.0/ /p:OutDir=${outputDir}`;
            const cliBuildArgumentsWindows = `/p:NanoFrameworkProjectSystemPath=`+ toolPath + `\\nanoFramework\\v1.0\\ /p:OutDir=${outputDir}`;
            const cliDeployArgumentsLinux = `${toolPath}/nanoFirmwareFlasher/nanoff.dll --nanodevice --deploy --serialport  ${serialPath} --image ${outputDir}`;
            const cliDeployArgumentsWindows = toolPath + `\\nanoFirmwareFlasher\\nanoff.exe --nanodevice --deploy --serialport  ${serialPath} --image ${outputDir}`;

            if(os.platform() === "win32") {
                Executor.runInTerminal('$path = & "${env:ProgramFiles(x86)}\\microsoft visual studio\\installer\\vswhere.exe" -products * -latest -prerelease -requires Microsoft.Component.MSBuild -find MSBuild\\**\\Bin\\MSBuild.exe | select-object -first 1; ' +
                    toolPath + '/nuget/nuget.exe restore "' + fileUri + '"; ' +
                    '& $path ' + fileUri + ' ' + cliBuildArgumentsWindows + '; '+ 
                    cliDeployArgumentsWindows);            
            }
            else {
                Executor.runInTerminal(`nuget restore "${fileUri}" && \
                    msbuild "${fileUri}" ${cliBuildArgumentsLinux} && \
                    dotnet ${cliDeployArgumentsLinux}`);
            }
        }   
    }



    /**
     * Flashes the selected device to new firmware using nanoFirmwareFlasher
     * @param toolPath absolute path to root of nanoFramework extension 
     * @param cliArguments CLI arguments passed to nanoff
     */
    public static flash(toolPath: String, cliArguments: String) {
        if(toolPath && cliArguments) {
            if(os.platform() === "win32") {
                Executor.runInTerminal(`${toolPath}\\nanoFirmwareFlasher\\nanoff.exe --update ${cliArguments}`);
            }
            else
            {
                Executor.runInTerminal(`dotnet ${toolPath}/nanoFirmwareFlasher/nanoff.dll --update ${cliArguments}`);
            }
        }
    }
}