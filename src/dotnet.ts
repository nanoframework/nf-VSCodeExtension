import * as path from "path";
import * as vscode from "vscode";

import { Executor } from "./executor";

export class Dotnet {
    public static build(fileUri: string, nanoFrameworkExtensionPath: String) {
        if (fileUri) {
            Executor.runInTerminal(`nuget restore "${fileUri}" && msbuild "${fileUri}" -p:NanoFrameworkProjectSystemPath=${nanoFrameworkExtensionPath}/nanoFramework/v1.0/`);
        }
    }

    public static deploy(fileUri: string, nanoFrameworkExtensionPath: String) {
        if (fileUri) {
            let outputDir = path.dirname(fileUri) + '/OutputDir/';

            Executor.runInTerminal(`nuget restore "${fileUri}" && \
                msbuild "${fileUri}" /p:NanoFrameworkProjectSystemPath=${nanoFrameworkExtensionPath}/nanoFramework/v1.0/ /p:OutDir=${outputDir} && \
                mono ${nanoFrameworkExtensionPath}/nanoFrameworkDeployer/nanoFrameworkDeployer.exe -v -d ${outputDir}`);
        }   
    }

    public static flash(nanoFrameworkExtensionPath: String, cliArguments: String) {
        if(nanoFrameworkExtensionPath && cliArguments) {
            Executor.runInTerminal(`dotnet ${nanoFrameworkExtensionPath}/nanoFirmwareFlasher/nanoff.dll --update ${cliArguments}`);
        }
    }
}