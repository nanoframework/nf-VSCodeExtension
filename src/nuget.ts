/*---------------------------------------------------------------------------------------------
 * Copyright (c) .NET Foundation and Contributors.
 * Portions Copyright (c) Microsoft Corporation.  All rights reserved.
 * See LICENSE file in the project root for full license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import * as https from 'https';
import * as http from 'http';

/**
 * Represents a NuGet package search result
 */
interface NuGetPackage {
    id: string;
    version: string;
    description: string;
    authors: string[];
    totalDownloads: number;
}

/**
 * Represents a NuGet package version
 */
interface NuGetPackageVersion {
    version: string;
    downloads: number;
}

/**
 * NuGet service for searching and managing packages
 */
export class NuGetService {
    private static readonly NUGET_SEARCH_URL = 'https://api-v2v3search-0.nuget.org/query';
    private static readonly NUGET_VERSIONS_URL = 'https://api.nuget.org/v3-flatcontainer';

    /**
     * Search for NuGet packages
     * @param query Search query
     * @param take Maximum number of results
     * @returns Array of matching packages
     */
    public static async searchPackages(query: string, take: number = 20): Promise<NuGetPackage[]> {
        const url = `${this.NUGET_SEARCH_URL}?q=${encodeURIComponent(query)}&take=${take}&prerelease=false`;
        
        try {
            const response = await this.httpGet(url);
            const data = JSON.parse(response);
            
            return data.data.map((pkg: any) => ({
                id: pkg.id,
                version: pkg.version,
                description: pkg.description || '',
                authors: pkg.authors || [],
                totalDownloads: pkg.totalDownloads || 0
            }));
        } catch (error) {
            console.error('Error searching NuGet packages:', error);
            throw new Error(`Failed to search NuGet packages: ${error}`);
        }
    }

    /**
     * Get available versions for a package
     * @param packageId The package ID
     * @returns Array of available versions (newest first)
     */
    public static async getPackageVersions(packageId: string): Promise<string[]> {
        const url = `${this.NUGET_VERSIONS_URL}/${packageId.toLowerCase()}/index.json`;
        
        try {
            const response = await this.httpGet(url);
            const data = JSON.parse(response);
            
            // Return versions in reverse order (newest first)
            return data.versions.reverse();
        } catch (error) {
            console.error(`Error getting versions for ${packageId}:`, error);
            throw new Error(`Failed to get package versions: ${error}`);
        }
    }

    /**
     * HTTP GET helper
     */
    private static httpGet(url: string): Promise<string> {
        return new Promise((resolve, reject) => {
            const protocol = url.startsWith('https') ? https : http;
            
            protocol.get(url, (response) => {
                // Handle redirects
                if (response.statusCode === 301 || response.statusCode === 302) {
                    const redirectUrl = response.headers.location;
                    if (redirectUrl) {
                        this.httpGet(redirectUrl).then(resolve).catch(reject);
                        return;
                    }
                }
                
                if (response.statusCode !== 200) {
                    reject(new Error(`HTTP ${response.statusCode}`));
                    return;
                }
                
                let data = '';
                response.on('data', chunk => data += chunk);
                response.on('end', () => resolve(data));
                response.on('error', reject);
            }).on('error', reject);
        });
    }
}

/**
 * Manages NuGet packages in nanoFramework projects
 */
export class NuGetManager {
    /**
     * Add a NuGet package to a project
     * @param projectPath Path to the .nfproj file
     * @param packageId The package ID to add
     * @param version The package version
     */
    public static async addPackage(projectPath: string, packageId: string, version: string): Promise<void> {
        const projectDir = path.dirname(projectPath);
        const packagesConfigPath = path.join(projectDir, 'packages.config');
        
        // Validate paths exist
        if (!fs.existsSync(projectPath)) {
            throw new Error(`Project file not found: ${projectPath}`);
        }

        // Add to packages.config
        await this.addToPackagesConfig(packagesConfigPath, packageId, version);
        
        // Add reference to .nfproj
        await this.addToNfproj(projectPath, packageId, version);
        
        console.log(`Successfully added ${packageId} v${version} to project`);
    }

    /**
     * Remove a NuGet package from a project
     * @param projectPath Path to the .nfproj file
     * @param packageId The package ID to remove
     */
    public static async removePackage(projectPath: string, packageId: string): Promise<void> {
        const projectDir = path.dirname(projectPath);
        const packagesConfigPath = path.join(projectDir, 'packages.config');
        
        // Remove from packages.config
        await this.removeFromPackagesConfig(packagesConfigPath, packageId);
        
        // Remove reference from .nfproj
        await this.removeFromNfproj(projectPath, packageId);
        
        console.log(`Successfully removed ${packageId} from project`);
    }

    /**
     * Get currently installed packages from a project
     * @param projectPath Path to the .nfproj file
     * @returns Array of installed package IDs and versions
     */
    public static getInstalledPackages(projectPath: string): { id: string; version: string }[] {
        const projectDir = path.dirname(projectPath);
        const packagesConfigPath = path.join(projectDir, 'packages.config');
        
        if (!fs.existsSync(packagesConfigPath)) {
            return [];
        }
        
        const content = fs.readFileSync(packagesConfigPath, 'utf-8');
        const packages: { id: string; version: string }[] = [];
        
        // Parse packages from packages.config
        const packageRegex = /<package\s+id="([^"]+)"\s+version="([^"]+)"/gi;
        let match;
        
        while ((match = packageRegex.exec(content)) !== null) {
            packages.push({
                id: match[1],
                version: match[2]
            });
        }
        
        return packages;
    }

    /**
     * Add package to packages.config
     */
    private static async addToPackagesConfig(packagesConfigPath: string, packageId: string, version: string): Promise<void> {
        let content: string;
        
        if (fs.existsSync(packagesConfigPath)) {
            content = fs.readFileSync(packagesConfigPath, 'utf-8');
            
            // Check if package already exists
            const existingRegex = new RegExp(`<package\\s+id="${packageId}"`, 'i');
            if (existingRegex.test(content)) {
                // Update existing package version
                const updateRegex = new RegExp(
                    `(<package\\s+id="${packageId}"\\s+version=")[^"]+("\\s+targetFramework="[^"]*"\\s*/>)`,
                    'i'
                );
                content = content.replace(updateRegex, `$1${version}$2`);
            } else {
                // Add new package before </packages>
                const newPackage = `  <package id="${packageId}" version="${version}" targetFramework="netnano1.0" />\n`;
                content = content.replace('</packages>', newPackage + '</packages>');
            }
        } else {
            // Create new packages.config
            content = `<?xml version="1.0" encoding="utf-8"?>
<packages>
  <package id="${packageId}" version="${version}" targetFramework="netnano1.0" />
</packages>`;
        }
        
        fs.writeFileSync(packagesConfigPath, content, 'utf-8');
    }

    /**
     * Remove package from packages.config
     */
    private static async removeFromPackagesConfig(packagesConfigPath: string, packageId: string): Promise<void> {
        if (!fs.existsSync(packagesConfigPath)) {
            return;
        }
        
        let content = fs.readFileSync(packagesConfigPath, 'utf-8');
        
        // Remove the package line
        const removeRegex = new RegExp(
            `\\s*<package\\s+id="${packageId}"[^/]*/>`,
            'gi'
        );
        content = content.replace(removeRegex, '');
        
        fs.writeFileSync(packagesConfigPath, content, 'utf-8');
    }

    /**
     * Add reference to .nfproj file
     * Adds the reference to the same ItemGroup as mscorlib (CoreLibrary), or creates a new ItemGroup if none exists
     */
    private static async addToNfproj(projectPath: string, packageId: string, version: string): Promise<void> {
        let content = fs.readFileSync(projectPath, 'utf-8');
        
        // Determine the assembly name (usually the package ID without 'nanoFramework.' prefix, or the full name)
        const assemblyName = this.getAssemblyName(packageId);
        
        // Check if reference already exists
        const existingRefRegex = new RegExp(`<Reference\\s+Include="${assemblyName}`, 'i');
        if (existingRefRegex.test(content)) {
            // Update existing reference version in HintPath
            const updateRegex = new RegExp(
                `(<HintPath>[^<]*\\\\packages\\\\${packageId}\\.)([^\\\\]+)(\\\\lib\\\\[^<]+</HintPath>)`,
                'gi'
            );
            content = content.replace(updateRegex, `$1${version}$3`);
        } else {
            // Create the new reference
            const newReference = this.createReferenceElement(packageId, version, assemblyName);
            
            // Find the ItemGroup that contains mscorlib by finding all ItemGroups and checking each one
            const itemGroupToUse = this.findMscorlibItemGroup(content);
            
            if (itemGroupToUse) {
                // Add to the same ItemGroup as mscorlib (insert before </ItemGroup>)
                const insertPosition = itemGroupToUse.endIndex;
                content = content.slice(0, insertPosition) + newReference + content.slice(insertPosition);
            } else {
                // No mscorlib found - create a new ItemGroup before the Import statements
                const importIndex = content.indexOf('<Import Project="$(NanoFrameworkProjectSystemPath)NFProjectSystem.CSharp.targets"');
                if (importIndex !== -1) {
                    const newItemGroup = `  <ItemGroup>\n${newReference}  </ItemGroup>\n\n  `;
                    content = content.slice(0, importIndex) + newItemGroup + content.slice(importIndex);
                }
            }
        }
        
        fs.writeFileSync(projectPath, content, 'utf-8');
    }

    /**
     * Find the ItemGroup that contains the mscorlib reference
     * Returns the position info for inserting new references
     */
    private static findMscorlibItemGroup(content: string): { startIndex: number; endIndex: number } | null {
        // Find all ItemGroup elements with their positions
        const itemGroupRegex = /<ItemGroup>([\s\S]*?)<\/ItemGroup>/gi;
        let match;
        
        while ((match = itemGroupRegex.exec(content)) !== null) {
            const itemGroupContent = match[1];
            
            // Check if this ItemGroup contains a Reference to mscorlib
            if (/<Reference\s+Include="mscorlib/i.test(itemGroupContent)) {
                // Found the mscorlib ItemGroup
                // Return the position just before </ItemGroup>
                const endTagPosition = match.index + match[0].lastIndexOf('</ItemGroup>');
                return {
                    startIndex: match.index,
                    endIndex: endTagPosition
                };
            }
        }
        
        return null;
    }

    /**
     * Remove reference from .nfproj file
     */
    private static async removeFromNfproj(projectPath: string, packageId: string): Promise<void> {
        let content = fs.readFileSync(projectPath, 'utf-8');
        
        const assemblyName = this.getAssemblyName(packageId);
        
        // Remove the Reference element
        // Handle both self-closing and full Reference elements
        const removeRegex = new RegExp(
            `\\s*<Reference\\s+Include="${assemblyName}[^"]*"[^>]*(?:/>|>[\\s\\S]*?</Reference>)`,
            'gi'
        );
        content = content.replace(removeRegex, '');
        
        // Clean up empty ItemGroups
        content = content.replace(/<ItemGroup>\s*<\/ItemGroup>/g, '');
        
        fs.writeFileSync(projectPath, content, 'utf-8');
    }

    /**
     * Get the assembly name from a package ID
     * For most nanoFramework packages, the assembly name matches a pattern
     */
    private static getAssemblyName(packageId: string): string {
        // Special mappings for common packages
        const mappings: { [key: string]: string } = {
            'nanoFramework.CoreLibrary': 'mscorlib',
            'nanoFramework.Runtime.Events': 'nanoFramework.Runtime.Events',
            'nanoFramework.System.Device.Gpio': 'System.Device.Gpio',
            'nanoFramework.System.Device.I2c': 'System.Device.I2c',
            'nanoFramework.System.Device.Spi': 'System.Device.Spi',
            'nanoFramework.System.Device.Pwm': 'System.Device.Pwm',
            'nanoFramework.System.Device.Adc': 'System.Device.Adc',
            'nanoFramework.System.Device.Dac': 'System.Device.Dac',
            'nanoFramework.System.Device.WiFi': 'System.Device.Wifi',
            'nanoFramework.System.IO.Ports': 'System.IO.Ports',
            'nanoFramework.System.IO.Streams': 'System.IO.Streams',
            'nanoFramework.System.IO.FileSystem': 'System.IO.FileSystem',
            'nanoFramework.System.Math': 'System.Math',
            'nanoFramework.System.Net': 'System.Net',
            'nanoFramework.System.Net.Http': 'System.Net.Http',
            'nanoFramework.System.Net.Sockets': 'System.Net.Sockets',
            'nanoFramework.System.Text': 'System.Text',
            'nanoFramework.System.Threading': 'System.Threading',
            'nanoFramework.System.Collections': 'System.Collections',
            'nanoFramework.Json': 'nanoFramework.Json',
            'nanoFramework.Logging': 'nanoFramework.Logging',
            'nanoFramework.Hardware.Esp32': 'nanoFramework.Hardware.Esp32',
            'nanoFramework.Hardware.Stm32': 'nanoFramework.Hardware.Stm32',
        };
        
        if (mappings[packageId]) {
            return mappings[packageId];
        }
        
        // For other packages, remove the 'nanoFramework.' prefix if present
        if (packageId.startsWith('nanoFramework.')) {
            return packageId.substring('nanoFramework.'.length);
        }
        
        return packageId;
    }

    /**
     * Create a Reference XML element for the .nfproj file
     */
    private static createReferenceElement(packageId: string, version: string, assemblyName: string): string {
        // Determine the DLL name (usually matches assembly name)
        const dllName = assemblyName;
        
        return `    <Reference Include="${assemblyName}">
      <HintPath>..\\packages\\${packageId}.${version}\\lib\\${dllName}.dll</HintPath>
      <Private>True</Private>
    </Reference>\n`;
    }
}

/**
 * Shows a quick pick to search and select a NuGet package
 * @returns Selected package info or undefined if cancelled
 */
export async function showNuGetPackagePicker(): Promise<{ packageId: string; version: string } | undefined> {
    // Step 1: Search for packages
    const searchQuery = await vscode.window.showInputBox({
        prompt: 'Search for nanoFramework NuGet packages',
        placeHolder: 'Enter package name (e.g., Gpio, I2c, Json)',
        validateInput: (value) => {
            if (!value || value.trim().length === 0) {
                return 'Please enter a search term';
            }
            return null;
        }
    });

    if (!searchQuery) {
        return undefined;
    }

    // Search packages with progress
    const packages = await vscode.window.withProgress(
        {
            location: vscode.ProgressLocation.Notification,
            title: 'Searching NuGet packages...',
            cancellable: false
        },
        async () => {
            return await NuGetService.searchPackages(searchQuery);
        }
    );

    if (packages.length === 0) {
        vscode.window.showWarningMessage(`No nanoFramework packages found for "${searchQuery}"`);
        return undefined;
    }

    // Step 2: Select package
    const packageItems = packages.map(pkg => ({
        label: pkg.id,
        description: `v${pkg.version}`,
        detail: pkg.description ? pkg.description.substring(0, 100) : '',
        package: pkg
    }));

    const selectedPackage = await vscode.window.showQuickPick(packageItems, {
        placeHolder: 'Select a package to install',
        matchOnDescription: true,
        matchOnDetail: true
    });

    if (!selectedPackage) {
        return undefined;
    }

    // Step 3: Select version
    const versions = await vscode.window.withProgress(
        {
            location: vscode.ProgressLocation.Notification,
            title: `Getting versions for ${selectedPackage.package.id}...`,
            cancellable: false
        },
        async () => {
            return await NuGetService.getPackageVersions(selectedPackage.package.id);
        }
    );

    // Take only the latest 10 versions for simplicity
    const recentVersions = versions.slice(0, 10);
    
    const versionItems = recentVersions.map((ver, index) => ({
        label: ver,
        description: index === 0 ? '(latest)' : ''
    }));

    const selectedVersion = await vscode.window.showQuickPick(versionItems, {
        placeHolder: 'Select a version'
    });

    if (!selectedVersion) {
        return undefined;
    }

    return {
        packageId: selectedPackage.package.id,
        version: selectedVersion.label
    };
}

/**
 * Shows a quick pick to select and remove an installed package
 * @param projectPath Path to the project file
 * @returns Selected package ID or undefined if cancelled
 */
export async function showInstalledPackagePicker(projectPath: string): Promise<string | undefined> {
    const installedPackages = NuGetManager.getInstalledPackages(projectPath);
    
    if (installedPackages.length === 0) {
        vscode.window.showInformationMessage('No packages are installed in this project.');
        return undefined;
    }

    const packageItems = installedPackages.map(pkg => ({
        label: pkg.id,
        description: `v${pkg.version}`
    }));

    const selected = await vscode.window.showQuickPick(packageItems, {
        placeHolder: 'Select a package to remove'
    });

    return selected?.label;
}

/**
 * Find project files in a solution directory
 * @param solutionPath Path to the solution file or directory
 * @returns Array of .nfproj file paths
 */
export function findProjectFiles(solutionPath: string): string[] {
    const solutionDir = fs.statSync(solutionPath).isDirectory() 
        ? solutionPath 
        : path.dirname(solutionPath);
    
    const projectFiles: string[] = [];
    
    function searchDir(dir: string) {
        try {
            const entries = fs.readdirSync(dir, { withFileTypes: true });
            
            for (const entry of entries) {
                const fullPath = path.join(dir, entry.name);
                
                if (entry.isDirectory() && !entry.name.startsWith('.') && entry.name !== 'packages' && entry.name !== 'bin' && entry.name !== 'obj') {
                    searchDir(fullPath);
                } else if (entry.isFile() && entry.name.endsWith('.nfproj')) {
                    projectFiles.push(fullPath);
                }
            }
        } catch (error) {
            console.error(`Error searching directory ${dir}:`, error);
        }
    }
    
    searchDir(solutionDir);
    return projectFiles;
}

/**
 * Show a picker to select a project file
 * @param solutionPath Path to the solution
 * @returns Selected project path or undefined
 */
export async function showProjectPicker(solutionPath: string): Promise<string | undefined> {
    const projectFiles = findProjectFiles(solutionPath);
    
    if (projectFiles.length === 0) {
        vscode.window.showErrorMessage('No .nfproj files found in the solution.');
        return undefined;
    }
    
    if (projectFiles.length === 1) {
        return projectFiles[0];
    }
    
    const items = projectFiles.map(p => ({
        label: path.basename(p, '.nfproj'),
        description: path.relative(path.dirname(solutionPath), p)
    }));
    
    const selected = await vscode.window.showQuickPick(items, {
        placeHolder: 'Select a project'
    });
    
    if (!selected) {
        return undefined;
    }
    
    return projectFiles.find(p => path.basename(p, '.nfproj') === selected.label);
}
