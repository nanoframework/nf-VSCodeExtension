/*---------------------------------------------------------------------------------------------
 * Copyright (c) .NET Foundation and Contributors.
 * Portions Copyright (c) Microsoft Corporation.  All rights reserved.
 * See LICENSE file in the project root for full license information.
 *--------------------------------------------------------------------------------------------*/

import * as path from "path";
import * as os from 'os';

import { Executor } from "./executor";
import { Console, debug } from "console";

export class NfProject {
    /**
     * Creates an sln file in the given path
     * @param fileUri the path to create the sln file
     * @param toolPath the path to the dotnet tool and templates
     */
    public static CreateSolution(fileUri: string, toolPath: String) {
        Executor.runInTerminal("dotnet new sln -o " + fileUri);
    }

    public static async AddProject(fileUri: string, projectName: string, projectType: string, toolPath: String) {
        //TODO : Add the project
        var fs = require('fs');
        const nodePath = require('path');
        switch (projectType) {
            default:
            case "Blank Application":
                // First open the nfproj template file
                var filePath = nodePath.join(toolPath, 'CS.BlankApplication-vs2022', 'CS.BlankApplication-vs2022.vstemplate');
                fs.readFile(filePath, 'utf8', function (err: any, data: any) {
                    if (err) {
                        return console.log(err);
                    }
        
                    // Replace the tokens
                    var result = data.replace(/string to be replaced/g, 'replacement');
        
                    fs.writeFile(fileUri, result, 'utf8', function (err: any) {
                        if (err) return console.log(err);
                    });
                });

                break;
            case "Class Library":
                break;
            case "Unit Test":
                break;
        }
    }
}