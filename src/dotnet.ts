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

    public static deploy(fileUri: string, nanoFrameworkExtensionPath: String) {
        if (fileUri) {
            let outputDir = path.dirname(fileUri) + '/OutputDir/';
            let cliArguments = `/p:NanoFrameworkProjectSystemPath=${nanoFrameworkExtensionPath}/nanoFramework/v1.0/ /p:OutDir=${outputDir}`;

            if(os.platform() === "win32") {
                Executor.runInTerminal('$path = & "${env:ProgramFiles(x86)}\\microsoft visual studio\\installer\\vswhere.exe" -latest -prerelease -requires Microsoft.Component.MSBuild -find MSBuild\\**\\Bin\\MSBuild.exe | select-object -first 1; ' +
                    nanoFrameworkExtensionPath + '/nuget/nuget.exe restore ' + fileUri + '; ' +
                    '& $path ' + fileUri + ' ' + cliArguments + '; '+ 
                    nanoFrameworkExtensionPath + 'nanoFrameworkDeployer/nanoFrameworkDeployer.exe  -d ' + outputDir);            
            }
            else {
                Executor.runInTerminal(`nuget restore "${fileUri}" && \
                    msbuild "${fileUri}" ${cliArguments} && \
                    mono ${nanoFrameworkExtensionPath}/nanoFrameworkDeployer/nanoFrameworkDeployer.exe -v -d ${outputDir}`);
            }
        }   
    }

    public static flash(nanoFrameworkExtensionPath: String, cliArguments: String) {
        if(nanoFrameworkExtensionPath && cliArguments) {
            Executor.runInTerminal(`dotnet ${nanoFrameworkExtensionPath}/nanoFirmwareFlasher/nanoff.dll --update ${cliArguments}`);
        }
    }
}