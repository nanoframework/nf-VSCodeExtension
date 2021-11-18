import * as path from "path";
import * as vscode from "vscode";
import * as os from 'os';

import { Executor } from "./executor";

export class Dotnet {
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

    public static flash(nanoFrameworkExtensionPath: String, cliArguments: String) {
        if(nanoFrameworkExtensionPath && cliArguments) {
            Executor.runInTerminal(`dotnet ${nanoFrameworkExtensionPath}/nanoFirmwareFlasher/nanoff.dll --update ${cliArguments}`);
        }
    }
}