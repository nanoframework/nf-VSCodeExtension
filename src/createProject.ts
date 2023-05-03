/*---------------------------------------------------------------------------------------------
 * Copyright (c) .NET Foundation and Contributors.
 * Portions Copyright (c) Microsoft Corporation.  All rights reserved.
 * See LICENSE file in the project root for full license information.
 *--------------------------------------------------------------------------------------------*/

import * as path from "path";
import * as os from 'os';

import { Executor } from "./executor";
import { Console, debug } from "console";
import * as crypto from "crypto";

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
        const path = require('path');
        var solutionPath = path.dirname(fileUri);
        switch (projectType) {
            default:
            case "Blank Application":
                // First open the nfproj template file
                var filePath = path.join(toolPath, 'CS.BlankApplication-vs2022', 'NFApp.nfproj');
                fs.readFile(filePath, 'utf8', function (err: any, data: any) {
                    if (err) {
                        return console.log(err);
                    }

                    // Replace the tokens
                    // First one is the project name $safeprojectname$
                    var result = data.replace(/\$safeprojectname\$/g, projectName);

                    // Second one is the project guid $guid1$
                    let id = crypto.randomUUID();
                    result = result.replace(/\$guid1\$/g, id);

                    var filePath = path.join(solutionPath, projectName, projectName + '.nfproj');
                    fs.mkdir(path.dirname(filePath), { recursive: true }, (err: any) => {
                        if (err) {
                            return console.log(err);
                        }

                    });

                    fs.writeFile(filePath, result, 'utf8', function (err: any) {
                        if (err) {
                            return console.log(err);
                        }

                        // Second open the Program.cs file
                        var filePath = path.join(toolPath, 'CS.BlankApplication-vs2022', 'Program.cs');
                        fs.readFile(filePath, 'utf8', function (err: any, data: any) {
                            if (err) {
                                return console.log(err);
                            }

                            // Replace the tokens
                            // First one is the project name $safeprojectname$
                            var result = data.replace(/\$safeprojectname\$/g, projectName);
                            var filePath = path.join(solutionPath, projectName, 'Program.cs');
                            fs.mkdir(path.dirname(filePath), { recursive: true }, (err: any) => {
                                if (err) {
                                    return console.log(err);
                                }

                            });

                            fs.writeFile(filePath, result, 'utf8', function (err: any) {
                                if (err) {
                                    return console.log(err);
                                }

                                // Finally remove the year and organization from the AssemblyInfo.cs file
                                var filePath = path.join(toolPath, 'CS.BlankApplication-vs2022', 'AssemblyInfo.cs');
                                fs.readFile(filePath, 'utf8', function (err: any, data: any) {
                                    if (err) {
                                        return console.log(err);
                                    }

                                    // Replace the tokens
                                    // Remove both $registeredorganization$ $year$
                                    var result = data.replace(/\$registeredorganization\$/g, '');
                                    result = result.replace(/\$year\$/g, '');

                                    var filePath = path.join(solutionPath, projectName, 'Properties', 'AssemblyInfo.cs');
                                    fs.mkdir(path.dirname(filePath), { recursive: true }, (err: any) => {
                                        if (err) {
                                            return console.log(err);
                                        }

                                    });

                                    fs.writeFile(filePath, result, 'utf8', function (err: any) {
                                        if (err) {
                                            return console.log(err);
                                        }

                                        // Finally add the project to the solution
                                        Executor.runInTerminal("dotnet sln " + fileUri + " add " + path.join(solutionPath, projectName, projectName + '.nfproj'));
                                        // Wait for a second to have the command executed
                                        setTimeout(() => {
                                            // And open the sln project, replace the GUID of the added project with the one in the nfproj file
                                            fs.readFile(fileUri, 'utf8', function (err: any, data: any) {
                                                if (err) {
                                                    return console.log(err);
                                                }

                                                // Replace the guid by te nanoframework one
                                                let stringToReplace = RegExp('Project\(\"{(.*)}\"\) = \"' + projectName, 'g');
                                                var result = data.replace(stringToReplace, '11A8DD76-328B-46DF-9F39-F559912D0360');
                                                fs.writeFile(fileUri, result, 'utf8', function (err: any) {
                                                    if (err) {
                                                        return console.log(err);
                                                    }
                                                });
                                            });
                                        }, 3000);
                                    });
                                });
                            });
                        });
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