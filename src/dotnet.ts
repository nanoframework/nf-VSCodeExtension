import * as path from "path";
import * as vscode from "vscode";

import { Executor } from "./executor";

export class Dotnet {
    public static build(fileUri: vscode.Uri, nanoFrameworkExtensionPath: String) {
        if (fileUri && fileUri.fsPath) {
            Executor.runInTerminal(`nuget restore && msbuild "${fileUri.fsPath}" -p:NanoFrameworkProjectSystemPath=${nanoFrameworkExtensionPath}/nanoFramework/v1.0/`);
        }
    }

    public static deploy(fileUri: vscode.Uri, nanoFrameworkExtensionPath: String) {
        if (fileUri && fileUri.fsPath) {
            let outputDir = path.dirname(fileUri.fsPath) + '/OutputDir/';

            Executor.runInTerminal(`nuget restore && \
                msbuild "${fileUri.fsPath}" /p:NanoFrameworkProjectSystemPath=${nanoFrameworkExtensionPath}/nanoFramework/v1.0/ /p:OutDir=${outputDir} && \
                mono ${nanoFrameworkExtensionPath}/nanoFrameworkDeployer/nanoFrameworkDeployer.exe -v -d ${outputDir}`);
        }   
    }

    public static flash(nanoFrameworkExtensionPath: String, cliArguments: String) {
        if(nanoFrameworkExtensionPath && cliArguments) {
            Executor.runInTerminal(`dotnet ${nanoFrameworkExtensionPath}/nanoFirmwareFlasher/nanoff.dll --update ${cliArguments}`);
        }
    }
}