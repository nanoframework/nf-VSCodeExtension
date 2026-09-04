/*---------------------------------------------------------------------------------------------
 * Copyright (c) .NET Foundation and Contributors.
 * Portions Copyright (c) Microsoft Corporation.  All rights reserved.
 * See LICENSE file in the project root for full license information.
 *--------------------------------------------------------------------------------------------*/

import * as path from "path";
import { Executor } from "./executor";
import * as crypto from "crypto";
import * as fs from "fs";
import {
    getTemplateDefinition,
    getTemplateDirectory,
    getTemplateKind,
    getTemplatePackages,
    ProjectFamily,
    TemplatePackage
} from "./projectTemplates";

type ProjectFlavor = 'stable' | 'preview';

/* eslint-disable @typescript-eslint/no-explicit-any, no-var, prefer-const, no-useless-escape */
// Note: This file uses legacy callback-style fs APIs with var declarations
// A future refactoring should modernize to async/await with fs.promises

export class NfProject {
    /**
     * Creates an sln file in the given path
     * @param fileUri the path to create the sln file
     * @param toolPath the path to the dotnet tool and templates
     */
    public static CreateSolution(fileUri: string, _toolPath: string) {
        Executor.runCommand("dotnet new sln -o " + fileUri);
    }

    /**
     * Add a project to an existing solution.
     * @param fileUri The solution file
     * @param projectName The project name
     * @param projectType The project type
     * @param toolPath The tool path
     */
    public static async AddProject(fileUri: string, projectName: string, projectType: string, toolPath: string, projectFlavor: ProjectFlavor) {
        const solutionPath = path.dirname(fileUri);
        const family: ProjectFamily = projectFlavor === 'preview' ? 2 : 1;
        const kind = getTemplateKind(projectType);
        const definition = getTemplateDefinition(kind);
        const templateDirectory = getTemplateDirectory(toolPath, family, kind);
        const packages = getTemplatePackages(toolPath, family, kind);

        await NfProject.CreateProject(
            solutionPath,
            path.join(templateDirectory, definition.projectFile),
            projectName,
            packages,
            family);
        await NfProject.CreateMainFile(
            solutionPath,
            path.join(templateDirectory, definition.sourceFile),
            projectName,
            definition.outputSourceFile);
        await NfProject.CreateAssemblyInfo(
            solutionPath,
            path.join(templateDirectory, 'AssemblyInfo.cs'),
            projectName);

        if (kind === 'unitTest') {
            await fs.promises.copyFile(
                path.join(templateDirectory, 'nano.runsettings'),
                path.join(solutionPath, projectName, 'nano.runsettings'));
        }

        await NfProject.AddCreatedProjectToSln(
            solutionPath,
            fileUri,
            projectName,
            '11A8DD76-328B-46DF-9F39-F559912D0360');
    }

    private static async CreateProject(
        solutionPath: string,
        templatePath: string,
        projectName: string,
        packages: TemplatePackage[],
        family: ProjectFamily
    ) {
        const projectDirectory = path.join(solutionPath, projectName);
        const projectPath = path.join(projectDirectory, `${projectName}.nfproj`);
        let project = await fs.promises.readFile(templatePath, 'utf8');
        project = project.replace(/\$safeprojectname\$/g, projectName);
        project = project.replace(/\$guid1\$/g, crypto.randomUUID());
        project = NfProject.AddTemplatePackages(project, packages, family);

        await fs.promises.mkdir(projectDirectory, { recursive: true });
        await Promise.all([
            fs.promises.writeFile(projectPath, project, 'utf8'),
            fs.promises.writeFile(
                path.join(projectDirectory, 'packages.config'),
                NfProject.CreatePackagesConfig(packages),
                'utf8')
        ]);
    }

    private static async CreateMainFile(solutionPath: string, filePath: string, projectName: string, fileName: string) {
        const data = await fs.promises.readFile(filePath, 'utf8');
        const result = data.replace(/\$safeprojectname\$/g, projectName);
        await fs.promises.writeFile(path.join(solutionPath, projectName, fileName), result, 'utf8');
    }

    private static async CreateAssemblyInfo(solutionPath: string, filePath: string, projectName: string) {
        const data = await fs.promises.readFile(filePath, 'utf8');
        const result = data
            .replace(/\$registeredorganization\$/g, '')
            .replace(/\$year\$/g, '');
        const outputPath = path.join(solutionPath, projectName, 'Properties', 'AssemblyInfo.cs');
        await fs.promises.mkdir(path.dirname(outputPath), { recursive: true });
        await fs.promises.writeFile(outputPath, result, 'utf8');
    }

    private static AddTemplatePackages(project: string, packages: TemplatePackage[], family: ProjectFamily): string {
        const targetsImport = /(\s*<Import Project="\$\(NanoFrameworkProjectSystemPath\)NFProjectSystem\.CSharp\.targets")/;
        if (!targetsImport.test(project)) {
            throw new Error('The project template is missing the required NFProjectSystem.CSharp.targets import.');
        }

        const references = packages.map(pkg => {
            if (pkg.id === 'nanoFramework.CoreLibrary') {
                const frameworkDirectory = family === 2 ? 'lib\\netnano1.0' : 'lib';
                return `    <Reference Include="mscorlib">\r\n      <HintPath>..\\packages\\${pkg.id}.${pkg.version}\\${frameworkDirectory}\\mscorlib.dll</HintPath>\r\n    </Reference>`;
            }
            if (pkg.id === 'nanoFramework.TestFramework') {
                return `    <Reference Include="nanoFramework.TestFramework">\r\n      <HintPath>..\\packages\\${pkg.id}.${pkg.version}\\lib\\nanoFramework.TestFramework.dll</HintPath>\r\n    </Reference>`;
            }
            throw new Error(`The project template declares unsupported package ${pkg.id}.`);
        });
        const contentItems = ['    <None Include="packages.config" />'];
        if (packages.some(pkg => pkg.id === 'nanoFramework.TestFramework')) {
            contentItems.push('    <None Include="nano.runsettings" />');
        }
        const itemGroup = `  <ItemGroup>\r\n${references.concat(contentItems).join('\r\n')}\r\n  </ItemGroup>\r\n`;
        return project.replace(targetsImport, `\r\n${itemGroup}$1`);
    }

    private static CreatePackagesConfig(packages: TemplatePackage[]): string {
        const packageEntries = packages
            .map(pkg => `  <package id="${pkg.id}" version="${pkg.version}" targetFramework="netnano1.0" />`)
            .join('\r\n');
        return `<?xml version="1.0" encoding="utf-8"?>\r\n<packages>\r\n${packageEntries}\r\n</packages>\r\n`;
    }

    private static async AddCreatedProjectToSln(solutionPath: string, fileUri: string, projectName: string, guid: string) {
        // Finally add the project to the solution
        Executor.runCommand("dotnet sln " + fileUri + " add " + path.join(solutionPath, projectName, projectName + '.nfproj'));
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