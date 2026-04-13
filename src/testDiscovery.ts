/*---------------------------------------------------------------------------------------------
 * Copyright (c) .NET Foundation and Contributors.
 * Portions Copyright (c) Microsoft Corporation.  All rights reserved.
 * See LICENSE file in the project root for full license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';

/**
 * Represents a discovered test method.
 */
export interface TestMethodInfo {
    /** Fully qualified name: Namespace.ClassName.MethodName or Namespace.ClassName.MethodName.{index} for DataRow */
    fullyQualifiedName: string;
    className: string;
    methodName: string;
    /** 0-based line number in the source file */
    line: number;
    /** URI of the source file */
    uri: vscode.Uri;
    /** Type of test entry: TestMethod, Setup, Cleanup, or DataRow */
    traitType?: string;
    /** For DataRow entries: the raw argument text from [DataRow(...)] */
    dataRowArgs?: string;
}

/**
 * Represents a discovered test class.
 */
export interface TestClassInfo {
    className: string;
    /** Namespace extracted from source, may be empty */
    namespace: string;
    /** 0-based line number of the class declaration */
    line: number;
    uri: vscode.Uri;
    methods: TestMethodInfo[];
}

/**
 * Represents a nanoFramework test project.
 */
export interface TestProjectInfo {
    /** Display name (project filename without extension) */
    name: string;
    /** Full path to the .nfproj file */
    projectPath: string;
    /** Directory containing the .nfproj */
    projectDir: string;
    /** Discovered test classes */
    classes: TestClassInfo[];
}

// Regex patterns for C# source parsing
const namespacePattern = /^\s*namespace\s+([\w.]+)/;
const classPattern = /\[\s*TestClass\s*\]/;
const classDeclarationPattern = /^\s*(?:public\s+|internal\s+|static\s+|sealed\s+|abstract\s+)*class\s+(\w+)/;
const testMethodAttribute = /\[\s*TestMethod\s*\]/;
const setupAttribute = /\[\s*Setup\s*\]/;
const cleanupAttribute = /\[\s*Cleanup\s*\]/;
const dataRowAttribute = /\[\s*DataRow\s*\((.*)\)\s*\]/;
const methodDeclarationPattern = /^\s*(?:public\s+|static\s+|async\s+)*\w[\w<>,\s]*\s+(\w+)\s*\(/;

/**
 * Discovers nanoFramework test projects and test methods in the workspace.
 */
export class TestDiscovery {

    /**
     * Find all .nfproj files in the workspace that reference nanoFramework.TestFramework.
     */
    public static async findTestProjects(): Promise<TestProjectInfo[]> {
        const nfprojFiles = await vscode.workspace.findFiles('**/*.nfproj', '{**/node_modules/**,**/bin/**,**/obj/**}');
        const testProjects: TestProjectInfo[] = [];

        for (const uri of nfprojFiles) {
            const projectPath = uri.fsPath;
            if (this.isTestProject(projectPath)) {
                const projectDir = path.dirname(projectPath);
                const name = path.basename(projectPath, '.nfproj');
                const classes = await this.discoverTestsInProject(projectDir);
                testProjects.push({ name, projectPath, projectDir, classes });
            }
        }

        return testProjects;
    }

    /**
     * Checks if a .nfproj references nanoFramework.TestFramework (via PackageReference or packages.config).
     */
    public static isTestProject(projectPath: string): boolean {
        try {
            const content = fs.readFileSync(projectPath, 'utf-8');

            // Check PackageReference style
            if (/nanoFramework\.TestFramework/i.test(content)) {
                return true;
            }

            // Check packages.config in the same directory
            const packagesConfig = path.join(path.dirname(projectPath), 'packages.config');
            if (fs.existsSync(packagesConfig)) {
                const pkgContent = fs.readFileSync(packagesConfig, 'utf-8');
                if (/nanoFramework\.TestFramework/i.test(pkgContent)) {
                    return true;
                }
            }

            return false;
        } catch {
            return false;
        }
    }

    /**
     * Discover test classes and methods in all .cs files under the project directory.
     */
    public static async discoverTestsInProject(projectDir: string): Promise<TestClassInfo[]> {
        const classes: TestClassInfo[] = [];
        const csFiles = await this.findCsFiles(projectDir);

        for (const filePath of csFiles) {
            const fileClasses = this.parseTestFile(filePath);
            classes.push(...fileClasses);
        }

        return classes;
    }

    /**
     * Find all .cs files in a project directory (excluding bin/obj/packages).
     */
    private static async findCsFiles(projectDir: string): Promise<string[]> {
        const pattern = new vscode.RelativePattern(projectDir, '**/*.cs');
        const files = await vscode.workspace.findFiles(pattern, '{**/bin/**,**/obj/**,**/packages/**}');
        return files.map(f => f.fsPath);
    }

    /**
     * Parse a single C# file for [TestClass] and [TestMethod] attributes.
     * Returns discovered test classes with their methods.
     */
    public static parseTestFile(filePath: string): TestClassInfo[] {
        const results: TestClassInfo[] = [];
        let content: string;
        try {
            content = fs.readFileSync(filePath, 'utf-8');
        } catch {
            return results;
        }

        const uri = vscode.Uri.file(filePath);
        const lines = content.split(/\r?\n/);

        let currentNamespace = '';
        let insideTestClass = false;
        let pendingTestClass = false;
        let currentClass: TestClassInfo | null = null;
        let pendingTestMethod = false;
        let pendingTraitType = '';
        let pendingDataRows: string[] = [];
        let braceDepth = 0;
        let classStartBraceDepth = 0;

        for (let i = 0; i < lines.length; i++) {
            const line = lines[i];
            const trimmed = line.trim();

            // Skip comments and empty lines for attribute detection
            if (trimmed.startsWith('//') || trimmed.length === 0) {
                continue;
            }

            // Track namespace
            const nsMatch = line.match(namespacePattern);
            if (nsMatch) {
                currentNamespace = nsMatch[1];
                continue;
            }

            // Track brace depth
            for (const ch of line) {
                if (ch === '{') { braceDepth++; }
                if (ch === '}') {
                    braceDepth--;
                    // Check if we exited the current class
                    if (insideTestClass && currentClass && braceDepth < classStartBraceDepth) {
                        insideTestClass = false;
                        if (currentClass.methods.length > 0) {
                            results.push(currentClass);
                        }
                        currentClass = null;
                    }
                }
            }

            // Detect [TestClass] attribute
            if (classPattern.test(trimmed)) {
                pendingTestClass = true;
                continue;
            }

            // After [TestClass], look for class declaration
            if (pendingTestClass) {
                const classMatch = line.match(classDeclarationPattern);
                if (classMatch) {
                    pendingTestClass = false;
                    insideTestClass = true;
                    classStartBraceDepth = braceDepth;
                    currentClass = {
                        className: classMatch[1],
                        namespace: currentNamespace,
                        line: i,
                        uri,
                        methods: []
                    };
                    continue;
                }
                // If it's not a comment or attribute, reset pending
                if (!trimmed.startsWith('[') && !trimmed.startsWith('//')) {
                    pendingTestClass = false;
                }
            }

            // Inside a test class, look for [TestMethod], [Setup], [Cleanup], [DataRow]
            if (insideTestClass && currentClass) {
                if (testMethodAttribute.test(trimmed)) {
                    pendingTestMethod = true;
                    pendingTraitType = 'TestMethod';
                    continue;
                }

                if (setupAttribute.test(trimmed)) {
                    pendingTestMethod = true;
                    pendingTraitType = 'Setup';
                    continue;
                }

                if (cleanupAttribute.test(trimmed)) {
                    pendingTestMethod = true;
                    pendingTraitType = 'Cleanup';
                    continue;
                }

                const dataRowMatch = trimmed.match(dataRowAttribute);
                if (dataRowMatch) {
                    pendingDataRows.push(dataRowMatch[1].trim());
                    pendingTestMethod = true;
                    pendingTraitType = 'DataRow';
                    continue;
                }

                if (pendingTestMethod) {
                    const methodMatch = line.match(methodDeclarationPattern);
                    if (methodMatch) {
                        const methodName = methodMatch[1];
                        const baseFqn = currentNamespace
                            ? `${currentNamespace}.${currentClass.className}.${methodName}`
                            : `${currentClass.className}.${methodName}`;

                        if (pendingDataRows.length > 0) {
                            // DataRow: create one entry per DataRow attribute
                            for (let dr = 0; dr < pendingDataRows.length; dr++) {
                                currentClass.methods.push({
                                    fullyQualifiedName: `${baseFqn}.${dr}`,
                                    className: currentClass.className,
                                    methodName,
                                    line: i,
                                    uri,
                                    traitType: 'DataRow',
                                    dataRowArgs: pendingDataRows[dr]
                                });
                            }
                        } else {
                            currentClass.methods.push({
                                fullyQualifiedName: baseFqn,
                                className: currentClass.className,
                                methodName,
                                line: i,
                                uri,
                                traitType: pendingTraitType || 'TestMethod'
                            });
                        }

                        pendingTestMethod = false;
                        pendingTraitType = '';
                        pendingDataRows = [];
                        continue;
                    }
                    // If it's not a comment or attribute, reset pending
                    if (!trimmed.startsWith('[') && !trimmed.startsWith('//')) {
                        pendingTestMethod = false;
                        pendingTraitType = '';
                        pendingDataRows = [];
                    }
                }
            }
        }

        // Handle class that wasn't explicitly closed (e.g. namespace-scoped file)
        if (currentClass && currentClass.methods.length > 0 && !results.includes(currentClass)) {
            results.push(currentClass);
        }

        return results;
    }

    /**
     * Re-discover tests for a single project (on file change).
     */
    public static async refreshProject(projectPath: string): Promise<TestProjectInfo | undefined> {
        if (!this.isTestProject(projectPath)) {
            return undefined;
        }

        const projectDir = path.dirname(projectPath);
        const name = path.basename(projectPath, '.nfproj');
        const classes = await this.discoverTestsInProject(projectDir);
        return { name, projectPath, projectDir, classes };
    }
}
