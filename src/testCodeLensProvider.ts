/*---------------------------------------------------------------------------------------------
 * Copyright (c) .NET Foundation and Contributors.
 * Portions Copyright (c) Microsoft Corporation.  All rights reserved.
 * See LICENSE file in the project root for full license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';

// Regex patterns matching those in testDiscovery.ts
const testClassAttribute = /\[\s*TestClass\s*\]/;
const classDeclaration = /^\s*(?:public\s+|internal\s+|static\s+|sealed\s+|abstract\s+)*class\s+(\w+)/;
const testMethodAttribute = /\[\s*TestMethod\s*\]/;
const setupAttribute = /\[\s*Setup\s*\]/;
const cleanupAttribute = /\[\s*Cleanup\s*\]/;
const dataRowAttributePattern = /\[\s*DataRow\s*\(/;
const methodDeclaration = /^\s*(?:public\s+|static\s+|async\s+)*\w[\w<>,\s]*\s+(\w+)\s*\(/;
const namespacePattern = /^\s*namespace\s+([\w.]+)/;

/**
 * Provides Run Test / Run Class CodeLens above [TestMethod] and [TestClass] in C# files.
 * Uses the existing nanoframework-tests TestController.
 */
export class TestCodeLensProvider implements vscode.CodeLensProvider {

    private _onDidChangeCodeLenses = new vscode.EventEmitter<void>();
    public readonly onDidChangeCodeLenses = this._onDidChangeCodeLenses.event;

    /** Notify VS Code to refresh the lenses (e.g. after discovery changes). */
    public refresh(): void {
        this._onDidChangeCodeLenses.fire();
    }

    public provideCodeLenses(
        document: vscode.TextDocument,
        _token: vscode.CancellationToken
    ): vscode.CodeLens[] {
        // Only operate on C# files
        if (document.languageId !== 'csharp') { return []; }

        const lenses: vscode.CodeLens[] = [];
        const lines = document.getText().split(/\r?\n/);

        let currentNamespace = '';
        let insideTestClass = false;
        let pendingTestClass = false;
        let currentClassName = '';
        let pendingTestMethod = false;
        let braceDepth = 0;
        let classStartBraceDepth = 0;

        for (let i = 0; i < lines.length; i++) {
            const line = lines[i];
            const trimmed = line.trim();

            if (trimmed.startsWith('//') || trimmed.length === 0) { continue; }

            // Track namespace
            const nsMatch = line.match(namespacePattern);
            if (nsMatch) {
                currentNamespace = nsMatch[1];
                continue;
            }

            // Track braces
            for (const ch of line) {
                if (ch === '{') { braceDepth++; }
                if (ch === '}') {
                    braceDepth--;
                    if (insideTestClass && braceDepth < classStartBraceDepth) {
                        insideTestClass = false;
                        currentClassName = '';
                    }
                }
            }

            // [TestClass]
            if (testClassAttribute.test(trimmed)) {
                pendingTestClass = true;
                continue;
            }

            if (pendingTestClass) {
                const classMatch = line.match(classDeclaration);
                if (classMatch) {
                    pendingTestClass = false;
                    insideTestClass = true;
                    classStartBraceDepth = braceDepth;
                    currentClassName = classMatch[1];

                    const fqClass = currentNamespace
                        ? `${currentNamespace}.${currentClassName}`
                        : currentClassName;

                    const range = new vscode.Range(i, 0, i, line.length);
                    lenses.push(new vscode.CodeLens(range, {
                        title: '$(play) Run Class',
                        command: 'nanoframework-tests.runClass',
                        arguments: [fqClass, document.uri]
                    }));
                    continue;
                }
                if (!trimmed.startsWith('[') && !trimmed.startsWith('//')) {
                    pendingTestClass = false;
                }
            }

            // [TestMethod], [Setup], [Cleanup], [DataRow] inside a test class
            if (insideTestClass) {
                if (testMethodAttribute.test(trimmed)
                    || setupAttribute.test(trimmed)
                    || cleanupAttribute.test(trimmed)) {
                    pendingTestMethod = true;
                    continue;
                }

                if (dataRowAttributePattern.test(trimmed)) {
                    pendingTestMethod = true;
                    continue;
                }

                if (pendingTestMethod) {
                    const methodMatch = line.match(methodDeclaration);
                    if (methodMatch) {
                        const methodName = methodMatch[1];
                        const fqMethod = currentNamespace
                            ? `${currentNamespace}.${currentClassName}.${methodName}`
                            : `${currentClassName}.${methodName}`;

                        const range = new vscode.Range(i, 0, i, line.length);
                        lenses.push(new vscode.CodeLens(range, {
                            title: '$(play) Run Test',
                            command: 'nanoframework-tests.runMethod',
                            arguments: [fqMethod, document.uri]
                        }));
                        pendingTestMethod = false;
                        continue;
                    }
                    if (!trimmed.startsWith('[') && !trimmed.startsWith('//')) {
                        pendingTestMethod = false;
                    }
                }
            }
        }

        return lenses;
    }
}
