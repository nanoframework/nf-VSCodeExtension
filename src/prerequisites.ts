/*---------------------------------------------------------------------------------------------
 * Copyright (c) .NET Foundation and Contributors.
 * Portions Copyright (c) Microsoft Corporation.  All rights reserved.
 * See LICENSE file in the project root for full license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import * as os from 'os';
import * as fs from 'fs';
import * as cp from 'child_process';
import { ExecutionKind, Executor } from './executor';

export interface PrerequisiteCheckResult {
    allPassed: boolean;
    issues: string[];
    warnings: string[];
}

/**
 * Checks if a command exists in the system PATH.
 * Uses execFile with separate arguments to avoid shell injection vulnerabilities.
 * @param command The command to check
 * @param kind The execution context in which the command is required
 * @returns true if the command exists, false otherwise
 */
async function commandExists(command: string, kind: ExecutionKind): Promise<boolean> {
    const checkCommand = os.platform() === 'win32' && !Executor.shouldUseWsl(kind) ? 'where' : 'which';
    const result = await Executor.runExecFile(checkCommand, [command], undefined, kind);
    return result.success;
}

function getExecutionPlatform(kind: ExecutionKind): NodeJS.Platform {
    return Executor.shouldUseWsl(kind) ? 'linux' : os.platform();
}

function getContextLabel(kind: ExecutionKind): string {
    return Executor.shouldUseWsl(kind) ? `WSL ${kind}` : `native ${kind}`;
}

/**
 * Checks if a file exists at the given path
 * @param filePath The path to check
 * @returns true if the file exists, false otherwise
 */
function fileExists(filePath: string): boolean {
    try {
        return fs.existsSync(filePath);
    } catch {
        return false;
    }
}

/**
 * Validates all prerequisites for the extension to work properly
 * @returns PrerequisiteCheckResult with status and any issues found
 */
export async function validatePrerequisites(): Promise<PrerequisiteCheckResult> {
    const issues = new Set<string>();
    const warnings = new Set<string>();
    const toolingPlatform = getExecutionPlatform('tooling');
    
    if (!await commandExists('dotnet', 'tooling')) {
        issues.add(`.NET SDK is not installed in the ${getContextLabel('tooling')} context. Download from: https://dotnet.microsoft.com/download`);
    }
    
    if (!await commandExists('nanoff', 'tooling')) {
        issues.add(`nanoff tool is not installed in the ${getContextLabel('tooling')} context. Run: dotnet tool install -g nanoff`);
        
        if (toolingPlatform !== 'win32') {
            warnings.add('After installing nanoff, add ~/.dotnet/tools to your PATH');
        }
    }

    if (Executor.shouldUseWsl('tooling') && !await commandExists('curl', 'tooling')) {
        issues.add('curl is not installed in the WSL tooling context. Install curl in WSL.');
    }

    if (Executor.shouldUseWsl('deployment') !== Executor.shouldUseWsl('tooling') &&
        !await commandExists('nanoff', 'deployment')) {
        issues.add(`nanoff tool is not installed in the ${getContextLabel('deployment')} context. Run: dotnet tool install -g nanoff`);
    }

    for (const kind of ['build', 'test'] as const) {
        const platform = getExecutionPlatform(kind);
        const context = getContextLabel(kind);

        if (platform === 'win32') {
            const vsWherePath = `${process.env['ProgramFiles(x86)']}\\Microsoft Visual Studio\\Installer\\vswhere.exe`;
            if (!fileExists(vsWherePath)) {
                issues.add('Visual Studio or Visual Studio Build Tools not found. Download from: https://visualstudio.microsoft.com/downloads/');
            }
            continue;
        }

        if (Executor.shouldUseWsl(kind)) {
            if (!await commandExists('dotnet', kind)) {
                issues.add(`.NET SDK is not installed in the ${context} context. Download from: https://dotnet.microsoft.com/download`);
            }
            if (!await commandExists('curl', kind)) {
                issues.add(`curl is not installed in the ${context} context. Install curl in WSL.`);
            }
        }

        if (!await commandExists('mono', kind)) {
            issues.add(`Mono is not installed in the ${context} context. Install mono-complete from: https://www.mono-project.com/download/stable/`);
        }

        if (!await commandExists('msbuild', kind)) {
            issues.add(`msbuild was not found in the ${context} context. Install mono-complete from the Mono Project (not from your distribution's package manager).`);
        }

        if (!Executor.shouldUseWsl(kind) && !await commandExists('nuget', kind)) {
            const nugetInstallHint = platform === 'darwin'
                ? 'Install with: brew install nuget'
                : 'Install with: sudo apt install nuget (or equivalent for your distribution)';
            issues.add(`nuget CLI was not found in the ${context} context. ${nugetInstallHint}`);
        }
    }

    if (toolingPlatform === 'linux') {
        try {
            const groups = (await Executor.runExecFile('groups', [], undefined, 'tooling')).stdout || '';
            if (!groups.includes('dialout')) {
                warnings.add('User is not in the dialout group. Serial port access may fail. Run: sudo usermod -a -G dialout $USER (then log out and back in)');
            }
        } catch {
            // Could not check groups
        }
    }

    if (toolingPlatform === 'darwin') {
        try {
            const arch = cp.execSync('uname -m', { encoding: 'utf-8' }).trim();
            if (arch === 'arm64') {
                // Running on Apple Silicon
            }
        } catch {
            // Could not determine architecture
        }
    }
    
    return {
        allPassed: issues.size === 0,
        issues: Array.from(issues),
        warnings: Array.from(warnings)
    };
}

/**
 * Shows the prerequisite check results to the user
 * @param result The prerequisite check result
 * @param silent If true, only show messages if there are issues
 */
export async function showPrerequisiteStatus(result: PrerequisiteCheckResult, silent: boolean = false): Promise<void> {
    if (result.issues.length > 0) {
        const message = `nanoFramework Extension: ${result.issues.length} prerequisite(s) missing.\n\n${result.issues.join('\n\n')}`;
        
        const selection = await vscode.window.showErrorMessage(
            message,
            'View Documentation',
            'Dismiss'
        );
        
        if (selection === 'View Documentation') {
            const platform = os.platform();
            const docUrl = platform === 'win32' 
                ? 'https://github.com/nanoframework/nf-VSCodeExtension#requirements'
                : 'https://github.com/nanoframework/nf-VSCodeExtension#requirements';
            vscode.env.openExternal(vscode.Uri.parse(docUrl));
        }
    } else if (result.warnings.length > 0) {
        const message = `nanoFramework Extension: ${result.warnings.length} warning(s).\n\n${result.warnings.join('\n\n')}`;
        
        await vscode.window.showWarningMessage(message, 'OK');
    } else if (!silent) {
        vscode.window.showInformationMessage('nanoFramework Extension: All prerequisites are installed.');
    }
}

/**
 * Gets platform-specific information for troubleshooting
 * @returns Object with platform details
 */
export function getPlatformInfo(): { platform: string; arch: string; isAppleSilicon: boolean } {
    const platform = os.platform();
    const arch = os.arch();
    let isAppleSilicon = false;
    
    if (platform === 'darwin') {
        try {
            const cpuBrand = cp.execSync('sysctl -n machdep.cpu.brand_string', { encoding: 'utf-8' }).trim();
            isAppleSilicon = cpuBrand.includes('Apple');
        } catch {
            // Fallback to arch check
            isAppleSilicon = arch === 'arm64';
        }
    }
    
    return {
        platform: platform === 'darwin' ? 'macOS' : platform === 'win32' ? 'Windows' : 'Linux',
        arch,
        isAppleSilicon
    };
}
