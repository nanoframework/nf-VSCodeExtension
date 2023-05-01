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
        // TODO: create the SLN file
        console.log("Creating project in " + fileUri);
    }

    public static async AddProject(fileUri: string, projectName : string, projectType : string, toolPath: String) {
        //TODO : Add the project
    }
}