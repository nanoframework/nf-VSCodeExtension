/*---------------------------------------------------------------------------------------------
 * Copyright (c) .NET Foundation and Contributors.
 * Portions Copyright (c) Microsoft Corporation.  All rights reserved.
 * See LICENSE file in the project root for full license information.
 *--------------------------------------------------------------------------------------------*/

import * as fs from 'fs';
import * as path from 'path';

export type ProjectFamily = 1 | 2;
export type ProjectTemplateKind = 'application' | 'classLibrary' | 'unitTest';

export interface TemplatePackage {
    id: string;
    version: string;
}

interface TemplateDefinition {
    directory: string;
    projectFile: string;
    sourceFile: string;
    outputSourceFile: string;
}

const templateDefinitions: Record<ProjectTemplateKind, TemplateDefinition> = {
    application: {
        directory: 'CS.BlankApplication-vs2022',
        projectFile: 'NFApp.nfproj',
        sourceFile: 'Program.cs',
        outputSourceFile: 'Program.cs'
    },
    classLibrary: {
        directory: 'CS.ClassLibrary-vs2022',
        projectFile: 'NFClassLibrary.nfproj',
        sourceFile: 'Class1.cs',
        outputSourceFile: 'Class1.cs'
    },
    unitTest: {
        directory: 'CS.TestApplication-vs2022',
        projectFile: 'NFUnitTest.nfproj',
        sourceFile: 'UnitTest1.cs',
        outputSourceFile: 'UnitTest1.cs'
    }
};

export function getTemplateKind(projectType: string): ProjectTemplateKind {
    if (projectType === 'Class Library') {
        return 'classLibrary';
    }
    if (projectType === 'Unit Test') {
        return 'unitTest';
    }
    return 'application';
}

export function detectTemplateKind(projectContent: string): ProjectTemplateKind {
    if (/<IsTestProject>\s*true\s*<\/IsTestProject>/i.test(projectContent)) {
        return 'unitTest';
    }
    if (/<OutputType>\s*Library\s*<\/OutputType>/i.test(projectContent)) {
        return 'classLibrary';
    }
    return 'application';
}

export function getTemplateDirectory(toolPath: string, family: ProjectFamily, kind: ProjectTemplateKind): string {
    return path.join(toolPath, 'projectTemplates', `v${family}`, templateDefinitions[kind].directory);
}

export function getTemplateDefinition(kind: ProjectTemplateKind): TemplateDefinition {
    return templateDefinitions[kind];
}

export function getTemplatePackages(toolPath: string, family: ProjectFamily, kind: ProjectTemplateKind): TemplatePackage[] {
    const definition = templateDefinitions[kind];
    const templatePath = path.join(
        getTemplateDirectory(toolPath, family, kind),
        `${definition.directory}.vstemplate`);
    const content = fs.readFileSync(templatePath, 'utf8');
    const packages: TemplatePackage[] = [];
    const packageRegex = /<package\s+id="([^"]+)"\s+version="([^"]+)"\s*\/>/gi;
    let match: RegExpExecArray | null;

    while ((match = packageRegex.exec(content)) !== null) {
        packages.push({ id: match[1], version: match[2] });
    }

    if (packages.length === 0) {
        throw new Error(`No package manifest was found in ${templatePath}.`);
    }
    return packages;
}
