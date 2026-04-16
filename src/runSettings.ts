/*---------------------------------------------------------------------------------------------
 * Copyright (c) .NET Foundation and Contributors.
 * Portions Copyright (c) Microsoft Corporation.  All rights reserved.
 * See LICENSE file in the project root for full license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';

/**
 * Settings extracted from a nano.runsettings file, merged with VS Code settings.
 * VS Code settings take precedence when explicitly set; runsettings provides
 * defaults for projects that already have a runsettings file (e.g. for CI).
 */
export interface NanoTestSettings {
    sessionTimeout: number;
    logging: string;
    isRealHardware: boolean;
    realHardwarePort: string;
    clrVersion: string;
    pathToLocalCLRInstance: string;
    resultsDirectory: string;
}

const defaultSettings: NanoTestSettings = {
    sessionTimeout: 120000,
    logging: 'None',
    isRealHardware: false,
    realHardwarePort: '',
    clrVersion: '',
    pathToLocalCLRInstance: '',
    resultsDirectory: '.\\TestResults'
};

/**
 * Parses a nano.runsettings XML file into a NanoTestSettings object.
 * Only the <nanoFrameworkAdapter> and <RunConfiguration> sections are read.
 *
 * We use simple regex parsing to avoid dragging in an XML library.
 */
function parseRunSettings(content: string): Partial<NanoTestSettings> {
    const result: Partial<NanoTestSettings> = {};

    const tagValue = (tag: string): string | undefined => {
        const match = content.match(new RegExp(`<${tag}>([^<]*)</${tag}>`, 'i'));
        return match ? match[1].trim() : undefined;
    };

    const timeout = tagValue('TestSessionTimeout');
    if (timeout) {
        const n = parseInt(timeout, 10);
        if (!isNaN(n)) { result.sessionTimeout = n; }
    }

    const logging = tagValue('Logging');
    if (logging) { result.logging = logging; }

    const isReal = tagValue('IsRealHardware');
    if (isReal) { result.isRealHardware = /true/i.test(isReal); }

    const port = tagValue('RealHardwarePort');
    if (port) { result.realHardwarePort = port; }

    const clr = tagValue('CLRVersion');
    if (clr) { result.clrVersion = clr; }

    const localClr = tagValue('PathToLocalCLRInstance');
    if (localClr) { result.pathToLocalCLRInstance = localClr; }

    const resultsDir = tagValue('ResultsDirectory');
    if (resultsDir) { result.resultsDirectory = resultsDir; }

    return result;
}

/**
 * Searches for a nano.runsettings file:
 *  1. Check VS Code setting nanoFramework.test.runSettingsPath
 *  2. Search workspace roots for nano.runsettings
 *  3. Return undefined if none found
 */
async function findRunSettingsFile(): Promise<string | undefined> {
    const config = vscode.workspace.getConfiguration('nanoFramework.test');
    const explicit = config.get<string>('runSettingsPath', '');
    if (explicit && fs.existsSync(explicit)) {
        return explicit;
    }

    // Search workspace folders
    const files = await vscode.workspace.findFiles(
        '**/nano.runsettings',
        '{**/node_modules/**,**/bin/**,**/obj/**}',
        1
    );
    if (files.length > 0) {
        return files[0].fsPath;
    }

    return undefined;
}

/**
 * Resolves the effective test settings by layering:
 *   defaults  ←  nano.runsettings  ←  VS Code settings
 *
 * VS Code settings (nanoFramework.test.*) always win when they have a
 * non-default value; runsettings fills in any gaps.
 */
export async function resolveTestSettings(): Promise<NanoTestSettings> {
    // Start from defaults
    const merged: NanoTestSettings = { ...defaultSettings };

    // Layer 1: nano.runsettings file
    const rsPath = await findRunSettingsFile();
    if (rsPath) {
        try {
            const content = fs.readFileSync(rsPath, 'utf-8');
            const rs = parseRunSettings(content);
            Object.assign(merged, rs);
        } catch {
            // Ignore parse errors — fall through to defaults
        }
    }

    // Layer 2: VS Code settings (take precedence)
    const config = vscode.workspace.getConfiguration('nanoFramework.test');

    const timeout = config.get<number>('sessionTimeout');
    if (timeout !== undefined && timeout !== defaultSettings.sessionTimeout) {
        merged.sessionTimeout = timeout;
    }

    const logging = config.get<string>('logging');
    if (logging !== undefined && logging !== defaultSettings.logging) {
        merged.logging = logging;
    }

    const port = config.get<string>('hardwarePort');
    if (port) {
        merged.realHardwarePort = port;
        merged.isRealHardware = true;
    }

    const clr = config.get<string>('nanoclrVersion');
    if (clr) { merged.clrVersion = clr; }

    const localClr = config.get<string>('pathToLocalCLRInstance');
    if (localClr) { merged.pathToLocalCLRInstance = localClr; }

    return merged;
}

/**
 * Generates a nano.runsettings XML string from a NanoTestSettings object.
 */
function generateRunSettingsXml(settings: NanoTestSettings): string {
    return `<?xml version="1.0" encoding="utf-8"?>
<RunSettings>
  <RunConfiguration>
    <ResultsDirectory>${escapeXml(settings.resultsDirectory)}</ResultsDirectory>
    <TestSessionTimeout>${settings.sessionTimeout}</TestSessionTimeout>
  </RunConfiguration>
  <nanoFrameworkAdapter>
    <Logging>${escapeXml(settings.logging)}</Logging>
    <IsRealHardware>${settings.isRealHardware ? 'True' : 'False'}</IsRealHardware>
    <RealHardwarePort>${escapeXml(settings.realHardwarePort)}</RealHardwarePort>
    <CLRVersion>${escapeXml(settings.clrVersion)}</CLRVersion>
    <PathToLocalCLRInstance>${escapeXml(settings.pathToLocalCLRInstance)}</PathToLocalCLRInstance>
  </nanoFrameworkAdapter>
</RunSettings>
`;
}

function escapeXml(s: string): string {
    return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;').replace(/'/g, '&apos;');
}

/**
 * Command handler: opens existing or creates a new nano.runsettings file.
 */
export async function configureRunSettings(): Promise<void> {
    const existing = await findRunSettingsFile();
    if (existing) {
        const doc = await vscode.workspace.openTextDocument(existing);
        await vscode.window.showTextDocument(doc);
        return;
    }

    // No existing file — generate one from current settings
    const settings = await resolveTestSettings();
    const xml = generateRunSettingsXml(settings);

    // Place in the first workspace folder root
    const folder = vscode.workspace.workspaceFolders?.[0];
    if (!folder) {
        vscode.window.showWarningMessage('Open a workspace folder first.');
        return;
    }

    const filePath = path.join(folder.uri.fsPath, 'nano.runsettings');

    try {
        fs.writeFileSync(filePath, xml, 'utf-8');
    } catch (err) {
        vscode.window.showErrorMessage(`Failed to write ${filePath}: ${err instanceof Error ? err.message : err}`);
        return;
    }

    const doc = await vscode.workspace.openTextDocument(filePath);
    await vscode.window.showTextDocument(doc);
    vscode.window.showInformationMessage(`Created ${path.basename(filePath)}`);
}
