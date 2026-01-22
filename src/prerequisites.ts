/*---------------------------------------------------------------------------------------------
 * Copyright (c) .NET Foundation and Contributors.
 * Portions Copyright (c) Microsoft Corporation.  All rights reserved.
 * See LICENSE file in the project root for full license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import * as os from 'os';
import * as fs from 'fs';
import * as cp from 'child_process';

export interface PrerequisiteCheckResult {
    allPassed: boolean;
    issues: string[];
    warnings: string[];
}

/**
 * Checks if a command exists in the system PATH.
 * Uses execFile with separate arguments to avoid shell injection vulnerabilities.
 * @param command The command to check
 * @returns true if the command exists, false otherwise
 */
async function commandExists(command: string): Promise<boolean> {
    return new Promise((resolve) => {
        const checkCommand = os.platform() === 'win32' ? 'where' : 'which';
        // Use execFile with command as argument to avoid shell injection
        cp.execFile(checkCommand, [command], (error: Error | null) => {
            resolve(!error);
        });
    });
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
 * Finds msbuild on Unix systems
 * @returns The path to msbuild or null if not found
 */
function findUnixMsBuild(): string | null {
    const locations = [
        '/usr/bin/msbuild',
        '/usr/local/bin/msbuild',
        '/Library/Frameworks/Mono.framework/Versions/Current/Commands/msbuild',
        '/Library/Frameworks/Mono.framework/Commands/msbuild'
    ];
    
    for (const loc of locations) {
        if (fileExists(loc)) {
            return loc;
        }
    }
    
    try {
        const result = cp.execSync('which msbuild', { encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] });
        const msbuildPath = result.trim();
        if (msbuildPath && fileExists(msbuildPath)) {
            return msbuildPath;
        }
    } catch {
        // which command failed
    }
    
    return null;
}

/**
 * Validates all prerequisites for the extension to work properly
 * @returns PrerequisiteCheckResult with status and any issues found
 */
export async function validatePrerequisites(): Promise<PrerequisiteCheckResult> {
    const issues: string[] = [];
    const warnings: string[] = [];
    const platform = os.platform();
    
    // Check .NET SDK
    if (!await commandExists('dotnet')) {
        issues.push('.NET SDK is not installed. Download from: https://dotnet.microsoft.com/download');
    }
    
    // Check nanoff tool
    if (!await commandExists('nanoff')) {
        issues.push('nanoff tool is not installed. Run: dotnet tool install -g nanoff');
        
        if (platform !== 'win32') {
            warnings.push('After installing nanoff, add ~/.dotnet/tools to your PATH');
        }
    }
    
    // Platform-specific checks
    if (platform === 'win32') {
        // Check for Visual Studio Build Tools or Visual Studio
        const vsWherePath = `${process.env['ProgramFiles(x86)']}\\Microsoft Visual Studio\\Installer\\vswhere.exe`;
        if (!fileExists(vsWherePath)) {
            issues.push('Visual Studio or Visual Studio Build Tools not found. Download from: https://visualstudio.microsoft.com/downloads/');
        }
        
        // Note: nuget.exe is automatically downloaded by the extension when needed on Windows
    } else {
        // macOS and Linux checks
        
        // Check mono
        if (!await commandExists('mono')) {
            issues.push('Mono is not installed. Install mono-complete from: https://www.mono-project.com/download/stable/');
        }
        
        // Check msbuild
        const msbuildPath = findUnixMsBuild();
        if (!msbuildPath) {
            issues.push('msbuild not found. Install mono-complete from Mono Project (NOT from your distribution\'s package manager).');
        }
        
        // Check nuget
        if (!await commandExists('nuget')) {
            const nugetInstallHint = platform === 'darwin' 
                ? 'Install with: brew install nuget'
                : 'Install with: sudo apt install nuget (or equivalent for your distribution)';
            issues.push(`nuget CLI not found. ${nugetInstallHint}`);
        }
        
        // Linux-specific: Check serial port permissions
        if (platform === 'linux') {
            try {
                const groups = cp.execSync('groups', { encoding: 'utf-8' });
                if (!groups.includes('dialout')) {
                    warnings.push('User is not in the dialout group. Serial port access may fail. Run: sudo usermod -a -G dialout $USER (then log out and back in)');
                }
            } catch {
                // Could not check groups
            }
        }
        
        // macOS-specific: Check for Apple Silicon considerations
        if (platform === 'darwin') {
            try {
                const arch = cp.execSync('uname -m', { encoding: 'utf-8' }).trim();
                if (arch === 'arm64') {
                    // Running on Apple Silicon
                    // This is informational, serialport should work on both architectures
                }
            } catch {
                // Could not determine architecture
            }
        }
    }
    
    return {
        allPassed: issues.length === 0,
        issues,
        warnings
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
