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
import *  as fs from "fs";

export class NfProject {
    /**
     * Creates an sln file in the given path
     * @param fileUri the path to create the sln file
     * @param toolPath the path to the dotnet tool and templates
     */
    public static CreateSolution(fileUri: string, toolPath: String) {
        Executor.runInTerminal("dotnet new sln -o " + fileUri);
    }

    /**
     * Add a project to an existing solution.
     * @param fileUri The solution file
     * @param projectName The project name
     * @param projectType The project type
     * @param toolPath The tool path
     */
    public static async AddProject(fileUri: string, projectName: string, projectType: string, toolPath: string) {
        var solutionPath = path.dirname(fileUri);

        switch (projectType) {
            default:
            case "Blank Application":
                // First open the nfproj template file
                var filePath = path.join(toolPath, 'CS.BlankApplication-vs2022', 'NFApp.nfproj');
                await NfProject.CreateProject(solutionPath, filePath, projectName).then(async function (err: any) {
                    if (err) {
                        return console.log(err);
                    }

                    // Second open the Program.cs file
                    var filePath = path.join(toolPath, 'CS.BlankApplication-vs2022', 'Program.cs');
                    await NfProject.CreateMainFile(solutionPath, filePath, projectName, 'Program.cs').then(async function (err: any) {
                        if (err) {
                            return console.log(err);
                        }

                        // Finally remove the year and organization from the AssemblyInfo.cs file
                        var filePath = path.join(toolPath, 'CS.BlankApplication-vs2022', 'AssemblyInfo.cs');
                        await NfProject.CreateAssemblyInfo(solutionPath, filePath, projectName).then(async function (err: any) {
                            if (err) {
                                return console.log(err);
                            }

                            NfProject.AddCreatedProjectToSln(solutionPath, fileUri, projectName, '11A8DD76-328B-46DF-9F39-F559912D0360').then(function (err: any) {
                                if (err) {
                                    return console.log(err);
                                }
                            });
                        });
                    });
                });
                break;

            case "Class Library":
                // First open the nfproj template file
                var filePath = path.join(toolPath, 'CS.ClassLibrary-vs2022', 'NFClassLibrary.nfproj');
                await NfProject.CreateProject(solutionPath, filePath, projectName).then(async function (err: any) {
                    if (err) {
                        return console.log(err);
                    }

                    // Second open the Class1.cs file
                    var filePath = path.join(toolPath, 'CS.ClassLibrary-vs2022', 'Class1.cs');
                    await NfProject.CreateMainFile(solutionPath, filePath, projectName, 'Class1.cs').then(async function (err: any) {
                        if (err) {
                            return console.log(err);
                        }

                        // Finally remove the year and organization from the AssemblyInfo.cs file
                        var filePath = path.join(toolPath, 'CS.ClassLibrary-vs2022', 'AssemblyInfo.cs');
                        await NfProject.CreateAssemblyInfo(solutionPath, filePath, projectName).then(async function (err: any) {
                            if (err) {
                                return console.log(err);
                            }

                            await NfProject.AddCreatedProjectToSln(solutionPath, fileUri, projectName, '11A8DD76-328B-46DF-9F39-F559912D0360').then(function (err: any) {
                                if (err) {
                                    return console.log(err);
                                }
                            });
                        });
                    });
                });
                break;
            case "Unit Test":
                // First open the nfproj template file
                var filePath = path.join(toolPath, 'CS.TestApplication-vs2022', 'NFUnitTest.nfproj');
                await NfProject.CreateProject(solutionPath, filePath, projectName).then(async function (err: any) {
                    if (err) {
                        return console.log(err);
                    }

                    // Second open the UnitTest1.cs file
                    var filePath = path.join(toolPath, 'CS.TestApplication-vs2022', 'UnitTest1.cs');
                    await NfProject.CreateMainFile(solutionPath, filePath, projectName, 'UnitTest1.cs').then(async function (err: any) {
                        if (err) {
                            return console.log(err);
                        }

                        // Finally remove the year and organization from the AssemblyInfo.cs file
                        var filePath = path.join(toolPath, 'CS.TestApplication-vs2022', 'AssemblyInfo.cs');
                        await NfProject.CreateAssemblyInfo(solutionPath, filePath, projectName).then(async function (err: any) {
                            if (err) {
                                return console.log(err);
                            }

                            await NfProject.AddCreatedProjectToSln(solutionPath, fileUri, projectName, '11A8DD76-328B-46DF-9F39-F559912D0360').then(async function (err: any) {
                                if (err) {
                                    return console.log(err);
                                }
                            });
                        });
                    });
                });
                break;
        }
    }

    private static async CreateProject(solutionPath: string, filePath: string, projectName: string) {
        await fs.readFile(filePath, 'utf8', async function (err: any, data: any) {
            if (err) {
                return err;
            }

            // Replace the tokens
            // First one is the project name $safeprojectname$
            var result = data.replace(/\$safeprojectname\$/g, projectName);

            // Second one is the project guid $guid1$
            let id = crypto.randomUUID();
            result = result.replace(/\$guid1\$/g, id);

            var filePath = path.join(solutionPath, projectName, projectName + '.nfproj');
            await fs.mkdir(path.dirname(filePath), { recursive: true }, async (err: any) => {
                if (err) {
                    return err;
                }

                await fs.writeFile(filePath, result, 'utf8', function (err: any) {
                    if (err) {
                        return err;
                    }

                    return null;
                });
            });
        });
    }

    private static async CreateMainFile(solutionPath: string, filePath: string, projectName: string, fileName: string) {
        await fs.readFile(filePath, 'utf8', async function (err: any, data: any) {
            if (err) {
                return err;
            }

            await fs.readFile(filePath, 'utf8', async function (err: any, data: any) {
                if (err) {
                    return console.log(err);
                }

                // Replace the tokens
                // First one is the project name $safeprojectname$
                var result = data.replace(/\$safeprojectname\$/g, projectName);
                var filePath = path.join(solutionPath, projectName, fileName);
                await fs.mkdir(path.dirname(filePath), { recursive: true }, async (err: any) => {
                    if (err) {
                        return console.log(err);
                    }

                    await fs.writeFile(filePath, result, 'utf8', function (err: any) {
                        if (err) {
                            return console.log(err);
                        }

                        return null;
                    });
                });
            });
        });
    }

    private static async CreateAssemblyInfo(solutionPath: string, filePath: string, projectName: string) {
        await fs.readFile(filePath, 'utf8', async function (err: any, data: any) {
            if (err) {
                return console.log(err);
            }

            // Replace the tokens
            // Remove both $registeredorganization$ $year$
            var result = data.replace(/\$registeredorganization\$/g, '');
            result = result.replace(/\$year\$/g, '');

            var filePath = path.join(solutionPath, projectName, 'Properties', 'AssemblyInfo.cs');
            await fs.mkdir(path.dirname(filePath), { recursive: true }, async (err: any) => {
                if (err) {
                    return console.log(err);
                }

                await fs.writeFile(filePath, result, 'utf8', function (err: any) {
                    if (err) {
                        return console.log(err);
                    }

                    return null;
                });
            });
        });
    }

    private static async AddCreatedProjectToSln(solutionPath: string, fileUri: string, projectName: string, guid: string) {
        // Finally add the project to the solution
        Executor.runInTerminal("dotnet sln " + fileUri + " add " + path.join(solutionPath, projectName, projectName + '.nfproj'));
        // Wait for 5 seconds to have the command executed
        setTimeout(() => {
            // And open the sln project, replace the GUID of the added project with the one in the nfproj file
            fs.readFile(fileUri, 'utf8', function (err: any, data: any) {
                if (err) {
                    return console.log(err);
                }

                // Replace the guid by te nanoframework one
                let stringToReplace = RegExp('(?<=Project\\("{)[^"]+(?=}"\\) = \"' + projectName + '\")', 'g');
                var result = data.replace(stringToReplace, guid);
                fs.writeFile(fileUri, result, 'utf8', function (err: any) {
                    if (err) {
                        return console.log(err);
                    }
                });
            });
        }, 5000);
    }
}