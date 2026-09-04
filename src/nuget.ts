/*---------------------------------------------------------------------------------------------
 * Copyright (c) .NET Foundation and Contributors.
 * Portions Copyright (c) Microsoft Corporation.  All rights reserved.
 * See LICENSE file in the project root for full license information.
 *--------------------------------------------------------------------------------------------*/

/* eslint-disable @typescript-eslint/no-explicit-any */
// Note: NuGet API responses use any for flexible JSON parsing

import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import * as https from 'https';
import extractZip from 'extract-zip';
import { detectTemplateKind, getTemplateDirectory, getTemplatePackages, ProjectFamily } from './projectTemplates';
import { ExecutionKind, Executor } from './executor';

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
// eslint-disable-next-line @typescript-eslint/no-unused-vars
interface NuGetPackageVersion {
    version: string;
    downloads: number;
}

interface NuGetEndpoints {
    source: string;
    search?: string;
    packageBase?: string;
}

export function parseEnabledNugetSources(output: string): string[] {
    return output
        .split(/\r?\n/)
        .map(line => /^\s*EM?\s+(.+?)\s*$/.exec(line)?.[1])
        .filter((source): source is string => !!source);
}

export function selectNugetSources(output: string, defaultSource: string): string[] {
    const enabledSources = parseEnabledNugetSources(output);
    return enabledSources.length > 0 ? enabledSources : [defaultSource];
}

let nugetOutputChannel: vscode.OutputChannel | undefined;

export function getNuGetOutputChannel(): vscode.OutputChannel {
    if (!nugetOutputChannel) {
        nugetOutputChannel = vscode.window.createOutputChannel('nanoFramework NuGet');
    }
    return nugetOutputChannel;
}

/**
 * NuGet service for searching and managing packages
 */
export class NuGetService {
    private static readonly defaultSource = 'https://api.nuget.org/v3/index.json';
    private static readonly sourceEndpointsPromises = new Map<string, Promise<NuGetEndpoints[]>>();

    /**
     * Search for NuGet packages
     * @param query Search query
     * @param take Maximum number of results
     * @returns Array of matching packages
     */
    public static async searchPackages(query: string, take: number = 20): Promise<NuGetPackage[]> {
        const output = getNuGetOutputChannel();
        output.appendLine(`Searching enabled NuGet sources for "${query}"...`);
        try {
            const endpoints = await this.getSourceEndpoints();
            const results = await Promise.allSettled(endpoints
                .filter(endpoint => endpoint.search)
                .map(async endpoint => {
                    const url = new URL(endpoint.search!);
                    url.searchParams.set('q', query);
                    url.searchParams.set('take', String(take));
                    url.searchParams.set('prerelease', 'true');
                    const data = JSON.parse(await this.httpGet(url.toString()));
                    if (!Array.isArray(data.data)) {
                        throw new Error(`NuGet search response from ${endpoint.source} did not contain a data array.`);
                    }
                    return data.data as any[];
                }));
            const packages = new Map<string, NuGetPackage>();

            for (const result of results) {
                if (result.status !== 'fulfilled') {
                    console.warn('NuGet source search failed:', result.reason);
                    continue;
                }
                for (const pkg of result.value) {
                    const key = pkg.id.toLowerCase();
                    if (!packages.has(key)) {
                        packages.set(key, {
                            id: pkg.id,
                            version: pkg.version,
                            description: pkg.description || '',
                            authors: pkg.authors || [],
                            totalDownloads: pkg.totalDownloads || 0
                        });
                    }
                }
            }

            if (results.length > 0 && results.every(result => result.status === 'rejected')) {
                throw new Error('All enabled NuGet sources failed.');
            }
            const matches = Array.from(packages.values()).slice(0, take);
            output.appendLine(`Found ${matches.length} package(s).`);
            return matches;
        } catch (error) {
            console.error('Error searching NuGet packages:', error);
            output.appendLine(`Search failed: ${error}`);
            output.show(true);
            throw new Error(`Failed to search NuGet packages: ${error}`, { cause: error });
        }
    }

    /**
     * Get available versions for a package
     * @param packageId The package ID
     * @returns Array of available versions (newest first)
     */
    public static async getPackageVersions(packageId: string): Promise<string[]> {
        const output = getNuGetOutputChannel();
        output.appendLine(`Getting versions for ${packageId}...`);
        try {
            const endpoints = await this.getSourceEndpoints();
            let lastError: unknown;
            for (const endpoint of endpoints) {
                if (!endpoint.packageBase) {
                    continue;
                }
                const url = `${endpoint.packageBase.replace(/\/$/, '')}/${packageId.toLowerCase()}/index.json`;
                try {
                    const data = JSON.parse(await this.httpGet(url));
                    if (Array.isArray(data.versions) && data.versions.length > 0) {
                        output.appendLine(`Found ${data.versions.length} version(s) for ${packageId} from ${endpoint.source}.`);
                        return data.versions.reverse();
                    }
                } catch (error) {
                    lastError = error;
                }
            }
            if (lastError) {
                throw lastError;
            }
            return [];
        } catch (error) {
            console.error(`Error getting versions for ${packageId}:`, error);
            throw new Error(`Failed to get package versions: ${error}`, { cause: error });
        }
    }

    public static async restorePackage(
        packageId: string,
        version: string,
        packagesDirectory: string,
        kind: ExecutionKind
    ): Promise<void> {
        const destination = path.join(packagesDirectory, `${packageId}.${version}`);
        if (fs.existsSync(destination) && fs.readdirSync(destination).length > 0) {
            return;
        }

        fs.mkdirSync(packagesDirectory, { recursive: true });
        const archivePath = path.join(os.tmpdir(), `${packageId}.${version}.${Date.now()}.nupkg`);
        const endpoints = await this.getSourceEndpoints(kind);
        let lastError = '';

        try {
            for (const endpoint of endpoints) {
                if (!endpoint.packageBase) {
                    continue;
                }
                const base = endpoint.packageBase.replace(/\/$/, '');
                const normalizedId = packageId.toLowerCase();
                const normalizedVersion = version.toLowerCase();
                const url = `${base}/${normalizedId}/${normalizedVersion}/${normalizedId}.${normalizedVersion}.nupkg`;
                this.requireHttpsUrl(url);
                const result = await Executor.runExecFile(
                    'curl',
                    ['--fail', '--silent', '--show-error', '--location', '--proto', '=https', '--proto-redir', '=https', '--output', archivePath, url],
                    undefined,
                    kind
                );
                if (!result.success) {
                    lastError = result.stderr || `curl exited with code ${result.exitCode}`;
                    continue;
                }

                const verification = await Executor.runExecFile(
                    'dotnet',
                    ['nuget', 'verify', archivePath, '--all'],
                    undefined,
                    kind
                );
                if (!verification.success) {
                    lastError = verification.stderr || verification.stdout || `dotnet nuget verify exited with code ${verification.exitCode}`;
                    continue;
                }

                const stagingDirectory = fs.mkdtempSync(path.join(packagesDirectory, `.${packageId}.${version}.`));
                try {
                    await extractZip(archivePath, { dir: stagingDirectory });
                    fs.rmSync(destination, { recursive: true, force: true });
                    fs.renameSync(stagingDirectory, destination);
                    return;
                } catch (error) {
                    lastError = `Could not extract ${packageId} ${version}: ${error}`;
                } finally {
                    fs.rmSync(stagingDirectory, { recursive: true, force: true });
                }
            }
        } finally {
            fs.rmSync(archivePath, { force: true });
        }

        throw new Error(`Could not download ${packageId} ${version}: ${lastError || 'no package source provided a download endpoint'}`);
    }

    public static async restorePackagesConfigFiles(
        packagesConfigPaths: string[],
        packagesDirectory: string,
        kind: ExecutionKind
    ): Promise<void> {
        const packages = new Map<string, { id: string; version: string }>();
        for (const packagesConfigPath of packagesConfigPaths) {
            const content = fs.readFileSync(packagesConfigPath, 'utf8');
            const packagePattern = /<package\b[^>]*\bid="([^"]+)"[^>]*\bversion="([^"]+)"[^>]*\/?>/gi;
            let match: RegExpExecArray | null;
            while ((match = packagePattern.exec(content)) !== null) {
                packages.set(`${match[1].toLowerCase()}@${match[2].toLowerCase()}`, {
                    id: match[1],
                    version: match[2]
                });
            }
        }

        const output = getNuGetOutputChannel();
        output.appendLine(`Restoring ${packages.size} package(s) to ${packagesDirectory}...`);
        for (const pkg of packages.values()) {
            output.appendLine(`Restoring ${pkg.id} ${pkg.version}...`);
            await this.restorePackage(pkg.id, pkg.version, packagesDirectory, kind);
        }
        output.appendLine('Package restore completed.');
    }

    private static async getSourceEndpoints(kind: ExecutionKind = 'tooling'): Promise<NuGetEndpoints[]> {
        const environment = `${kind}:${Executor.shouldUseWsl(kind) ? 'wsl' : 'native'}`;
        let promise = this.sourceEndpointsPromises.get(environment);
        if (!promise) {
            promise = this.loadSourceEndpoints(kind);
            this.sourceEndpointsPromises.set(environment, promise);
        }
        try {
            return await promise;
        } catch (error) {
            this.sourceEndpointsPromises.delete(environment);
            throw error;
        }
    }

    private static async loadSourceEndpoints(kind: ExecutionKind): Promise<NuGetEndpoints[]> {
        const sourceResult = await Executor.runExecFile(
            'dotnet',
            ['nuget', 'list', 'source', '--format', 'Short'],
            undefined,
            kind
        );
        const sourceOutput = sourceResult.success ? sourceResult.stdout || '' : '';
        const enabledSources = parseEnabledNugetSources(sourceOutput);
        const sources = selectNugetSources(sourceOutput, this.defaultSource);

        const output = getNuGetOutputChannel();
        output.appendLine(enabledSources.length > 0
            ? `Using ${enabledSources.length} enabled source(s) from dotnet NuGet configuration.`
            : `No enabled dotnet NuGet sources were found; using ${this.defaultSource}.`);
        sources.forEach(source => output.appendLine(`Source: ${source}`));

        const endpoints: NuGetEndpoints[] = [];
        for (const source of sources) {
            try {
                const serviceIndex = JSON.parse(await this.httpGet(source, kind));
                const resources = Array.isArray(serviceIndex.resources) ? serviceIndex.resources : [];
                const hasType = (resource: any, expected: string): boolean => {
                    const types = Array.isArray(resource['@type']) ? resource['@type'] : [resource['@type']];
                    return types.some((type: unknown) => typeof type === 'string' && type.startsWith(expected));
                };
                const endpoint: NuGetEndpoints = {
                    source,
                    search: resources.find((resource: any) => hasType(resource, 'SearchQueryService'))?.['@id'],
                    packageBase: resources.find((resource: any) => hasType(resource, 'PackageBaseAddress'))?.['@id']
                };
                if (!endpoint.search && !endpoint.packageBase) {
                    throw new Error('The service index exposes no supported NuGet v3 resources.');
                }
                endpoints.push(endpoint);
            } catch (error) {
                console.warn(`Could not load NuGet source ${source}:`, error);
                output.appendLine(`Could not load source ${source}: ${error}`);
            }
        }

        if (endpoints.length === 0) {
            throw new Error('No enabled NuGet v3 source could be loaded.');
        }
        return endpoints;
    }

    /**
     * HTTP GET helper
     */
    private static async httpGet(url: string, kind: ExecutionKind = 'tooling'): Promise<string> {
        const secureUrl = this.requireHttpsUrl(url);
        if (Executor.shouldUseWsl(kind)) {
            const result = await Executor.runExecFile(
                'curl',
                ['--fail', '--silent', '--show-error', '--location', '--proto', '=https', '--proto-redir', '=https', secureUrl.toString()],
                undefined,
                kind
            );
            if (!result.success) {
                throw new Error(`WSL curl failed: ${result.stderr || `exit code ${result.exitCode}`}`);
            }
            return result.stdout || '';
        }

        return new Promise((resolve, reject) => {
            https.get(secureUrl, (response) => {
                // Handle redirects
                if ([301, 302, 303, 307, 308].includes(response.statusCode || 0)) {
                    const redirectUrl = response.headers.location;
                    if (redirectUrl) {
                        response.resume();
                        this.httpGet(new URL(redirectUrl, secureUrl).toString(), kind).then(resolve).catch(reject);
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

    private static requireHttpsUrl(url: string): URL {
        const parsedUrl = new URL(url);
        if (parsedUrl.protocol !== 'https:') {
            throw new Error(`NuGet URL must use HTTPS: ${url}`);
        }
        return parsedUrl;
    }
}

/**
 * Manages NuGet packages in nanoFramework projects
 */
export class NuGetManager {
    private static readonly coreLibraryPackage = 'nanoFramework.CoreLibrary';

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
     * Update a NuGet package version in a project
     * @param projectPath Path to the .nfproj file
     * @param packageId The package ID to update
     * @param newVersion The new package version
     */
    public static async updatePackageVersion(projectPath: string, packageId: string, newVersion: string): Promise<void> {
        const projectDir = path.dirname(projectPath);
        const packagesConfigPath = path.join(projectDir, 'packages.config');

        // Validate paths exist
        if (!fs.existsSync(projectPath)) {
            throw new Error(`Project file not found: ${projectPath}`);
        }

        if (!fs.existsSync(packagesConfigPath)) {
            throw new Error(`packages.config not found: ${packagesConfigPath}`);
        }

        // Update version in packages.config
        await this.updateVersionInPackagesConfig(packagesConfigPath, packageId, newVersion);

        // Update version in .nfproj HintPath
        await this.updateVersionInNfproj(projectPath, packageId, newVersion);

        console.log(`Successfully updated ${packageId} to v${newVersion}`);
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

    public static getProjectVersion(projectPath: string): 1 | 2 {
        const coreLibrary = this.getInstalledPackages(projectPath)
            .find(pkg => pkg.id.toLowerCase() === this.coreLibraryPackage.toLowerCase());
        if (!coreLibrary) {
            throw new Error(`${this.coreLibraryPackage} was not found in packages.config`);
        }

        if (coreLibrary.version.startsWith('1.')) {
            return 1;
        }
        if (coreLibrary.version.startsWith('2.')) {
            return 2;
        }
        throw new Error(`Unsupported ${this.coreLibraryPackage} version ${coreLibrary.version}.`);
    }

    public static async migrateProjectVersion(projectPath: string, targetVersion: ProjectFamily, toolPath: string): Promise<void> {
        const packagesConfigPath = path.join(path.dirname(projectPath), 'packages.config');
        if (!fs.existsSync(projectPath) || !fs.existsSync(packagesConfigPath)) {
            throw new Error('The project and its packages.config file are required for migration.');
        }

        const projectContent = fs.readFileSync(projectPath, 'utf-8');
        const sourceVersion = this.getProjectVersion(projectPath);
        const templateKind = detectTemplateKind(projectContent);
        const sourceTemplatePackages = getTemplatePackages(toolPath, sourceVersion, templateKind);
        const targetTemplatePackages = getTemplatePackages(toolPath, targetVersion, templateKind);
        const sourceTemplateIds = new Set(sourceTemplatePackages.map(pkg => pkg.id.toLowerCase()));
        const targetTemplateIds = new Set(targetTemplatePackages.map(pkg => pkg.id.toLowerCase()));
        const installedPackages = this.getInstalledPackages(projectPath);
        const customPackages = installedPackages.filter(pkg => !sourceTemplateIds.has(pkg.id.toLowerCase()));
        const resolvedCustomVersions = await Promise.all(customPackages.map(async pkg => {
            const versions = await NuGetService.getPackageVersions(pkg.id);
            const version = versions.find(candidate => targetVersion === 2
                ? candidate.startsWith('2.') && candidate.includes('-')
                : candidate.startsWith('1.') && !candidate.includes('-'));
            if (!version) {
                throw new Error(`No compatible ${targetVersion === 2 ? '2.x preview' : '1.x stable'} version of ${pkg.id} is available.`);
            }
            return { id: pkg.id, version };
        }));
        const resolvedVersions = [...targetTemplatePackages, ...resolvedCustomVersions];
        const packagesToRemove = sourceTemplatePackages
            .filter(pkg => !targetTemplateIds.has(pkg.id.toLowerCase()));

        const originalProject = fs.readFileSync(projectPath, 'utf-8');
        const originalPackages = fs.readFileSync(packagesConfigPath, 'utf-8');
        const runSettingsPath = path.join(path.dirname(projectPath), 'nano.runsettings');
        const hadRunSettings = fs.existsSync(runSettingsPath);
        try {
            for (const pkg of packagesToRemove) {
                if (installedPackages.some(candidate => candidate.id.toLowerCase() === pkg.id.toLowerCase())) {
                    await this.removePackage(projectPath, pkg.id);
                }
            }
            for (const pkg of resolvedVersions) {
                if (installedPackages.some(candidate => candidate.id.toLowerCase() === pkg.id.toLowerCase())) {
                    await this.updatePackageVersion(projectPath, pkg.id, pkg.version);
                } else {
                    await this.addPackage(projectPath, pkg.id, pkg.version);
                }
            }

            if (templateKind === 'unitTest' && !hadRunSettings) {
                fs.copyFileSync(
                    path.join(getTemplateDirectory(toolPath, targetVersion, templateKind), 'nano.runsettings'),
                    runSettingsPath);
            }

            const migratedProject = fs.readFileSync(projectPath, 'utf-8');
            const migratedPackages = this.getInstalledPackages(projectPath);
            for (const pkg of resolvedVersions) {
                const configVersion = migratedPackages.find(candidate => candidate.id.toLowerCase() === pkg.id.toLowerCase())?.version;
                const escapedPackageId = pkg.id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
                const escapedVersion = pkg.version.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
                const hintPath = new RegExp(`[/\\\\]packages[/\\\\]${escapedPackageId}\\.${escapedVersion}[/\\\\]lib[/\\\\]`, 'i');
                if (configVersion !== pkg.version || !hintPath.test(migratedProject)) {
                    throw new Error(`Could not update every ${pkg.id} reference to ${pkg.version}.`);
                }
            }
        } catch (error) {
            fs.writeFileSync(projectPath, originalProject, 'utf-8');
            fs.writeFileSync(packagesConfigPath, originalPackages, 'utf-8');
            if (!hadRunSettings) {
                fs.rmSync(runSettingsPath, { force: true });
            }
            throw error;
        }
    }

    /**
     * Update version of a package in packages.config
     */
    private static async updateVersionInPackagesConfig(packagesConfigPath: string, packageId: string, newVersion: string): Promise<void> {
        let content = fs.readFileSync(packagesConfigPath, 'utf-8');
        const escapedPackageId = packageId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

        const updateRegex = new RegExp(
            `(<package\\s+id="${escapedPackageId}"\\s+version=")[^"]+(")`,
            'i'
        );

        if (!updateRegex.test(content)) {
            throw new Error(`Package ${packageId} not found in packages.config`);
        }

        content = content.replace(updateRegex, `$1${newVersion}$2`);
        fs.writeFileSync(packagesConfigPath, content, 'utf-8');
    }

    /**
     * Update version of a package reference in .nfproj file (HintPath and Reference Include version)
     */
    private static async updateVersionInNfproj(projectPath: string, packageId: string, newVersion: string): Promise<void> {
        let content = fs.readFileSync(projectPath, 'utf-8');
        const targetLibraryPath = this.getLibraryPath(packageId, this.getProjectVersion(projectPath));

        // Escape package ID for safe use in regex (dots in names like nanoFramework.System.Net must not match arbitrary characters)
        const escapedPackageId = packageId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

        // Update version in HintPath: ...\packages\PackageId.OldVersion\lib\... -> ...\packages\PackageId.NewVersion\lib\...
        // Support both backslash and forward slash path separators
        const hintPathRegex = new RegExp(
            `(<HintPath>[^<]*[/\\\\]packages[/\\\\]${escapedPackageId}\\.)([^/\\\\]+)([/\\\\]lib(?:[/\\\\]netnano1\\.0)?[/\\\\])([^<]+</HintPath>)`,
            'gi'
        );

        content = content.replace(hintPathRegex, (_match, prefix: string, _oldVersion: string, libraryPath: string, tail: string) => {
            const separator = libraryPath[0];
            const formattedLibraryPath = `${separator}${targetLibraryPath.replace(/\\/g, separator)}${separator}`;
            return `${prefix}${newVersion}${formattedLibraryPath}${tail}`;
        });

        // Update version in Reference Include attribute when present (VS-created projects)
        // e.g. <Reference Include="AssemblyName, Version=1.2.3.0, Culture=neutral, ...">
        //        <HintPath>..\packages\PackageId.1.2.3\lib\AssemblyName.dll</HintPath>
        const refBlockRegex = /<Reference\s+Include="[^"]*"[^>]*>[\s\S]*?<\/Reference>/gi;
        const packageHintPathTest = new RegExp(
            `[/\\\\]packages[/\\\\]${escapedPackageId}\\.[^/\\\\]+[/\\\\]lib(?:[/\\\\]netnano1\\.0)?[/\\\\]`,
            'i'
        );
        content = content.replace(refBlockRegex, (match) => {
            if (packageHintPathTest.test(match)) {
                // Update Version=X.Y.Z.0 in the Include attribute
                const assemblyVersion = `${newVersion.split('-')[0]}.0`;
                return match.replace(
                    /(<Reference\s+Include="[^"]*?,\s*Version=)[\d.]+/i,
                    `$1${assemblyVersion}`
                );
            }
            return match;
        });

        fs.writeFileSync(projectPath, content, 'utf-8');
    }

    /**
     * Add package to packages.config
     */
    private static async addToPackagesConfig(packagesConfigPath: string, packageId: string, version: string): Promise<void> {
        let content: string;
        const escapedPackageId = packageId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        
        if (fs.existsSync(packagesConfigPath)) {
            content = fs.readFileSync(packagesConfigPath, 'utf-8');
            
            // Check if package already exists
            const existingRegex = new RegExp(`<package\\s+id="${escapedPackageId}"`, 'i');
            if (existingRegex.test(content)) {
                // Update existing package version
                const updateRegex = new RegExp(
                    `(<package\\s+id="${escapedPackageId}"\\s+version=")[^"]+("\\s+targetFramework="[^"]*"\\s*/>)`,
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
        const escapedPackageId = packageId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        
        // Remove the package line
        const removeRegex = new RegExp(
            `\\s*<package\\s+id="${escapedPackageId}"[^/]*/>`,
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
        const projectFamily = this.getProjectVersion(projectPath);
        
        // Determine the assembly name (usually the package ID without 'nanoFramework.' prefix, or the full name)
        const assemblyName = this.getAssemblyName(packageId);
        
        // Escape names for safe use in regex
        const escapedAssemblyName = assemblyName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const escapedPackageId = packageId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

        // Check if reference already exists
        const existingRefRegex = new RegExp(`<Reference\\s+Include="${escapedAssemblyName}`, 'i');
        if (existingRefRegex.test(content)) {
            // Update existing reference version in HintPath (support both / and \ separators)
            const updateRegex = new RegExp(
                `(<HintPath>[^<]*[/\\\\]packages[/\\\\]${escapedPackageId}\\.)([^/\\\\]+)([/\\\\]lib(?:[/\\\\]netnano1\\.0)?[/\\\\])([^<]+</HintPath>)`,
                'gi'
            );
            content = content.replace(updateRegex, (_match, prefix: string, _oldVersion: string, libraryPath: string, tail: string) => {
                const separator = libraryPath[0];
                const targetLibraryPath = this.getLibraryPath(packageId, projectFamily).replace(/\\/g, separator);
                return `${prefix}${version}${separator}${targetLibraryPath}${separator}${tail}`;
            });
        } else {
            // Create the new reference
            const newReference = this.createReferenceElement(packageId, version, assemblyName, projectFamily);
            
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
            'nanoFramework.TestFramework': 'nanoFramework.TestFramework',
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
    private static createReferenceElement(packageId: string, version: string, assemblyName: string, projectFamily: ProjectFamily): string {
        // Determine the DLL name (usually matches assembly name)
        const dllName = assemblyName;
        const libraryPath = this.getLibraryPath(packageId, projectFamily);
        
        return `    <Reference Include="${assemblyName}">
            <HintPath>..\\packages\\${packageId}.${version}\\${libraryPath}\\${dllName}.dll</HintPath>
      <Private>True</Private>
    </Reference>\n`;
    }

    private static getLibraryPath(packageId: string, projectFamily: ProjectFamily): string {
        if (packageId.toLowerCase() === 'nanoframework.testframework') {
            return 'lib';
        }
        return projectFamily === 2 ? 'lib\\netnano1.0' : 'lib';
    }
}

/**
 * Shows a quick pick to search and select a NuGet package
 * @returns Selected package info or undefined if cancelled
 */
export async function showNuGetPackagePicker(): Promise<{ packageId: string; version: string } | undefined> {
    const output = getNuGetOutputChannel();
    output.clear();
    output.appendLine('Add NuGet Package started.');
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
        output.appendLine('Package search cancelled.');
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
        output.appendLine(`No packages found for "${searchQuery}".`);
        const selection = await vscode.window.showWarningMessage(
            `No nanoFramework packages found for "${searchQuery}".`,
            'Show NuGet Output'
        );
        if (selection === 'Show NuGet Output') {
            output.show(true);
        }
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
        output.appendLine('Package selection cancelled.');
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

    if (versions.length === 0) {
        output.appendLine(`No versions found for ${selectedPackage.package.id}.`);
        vscode.window.showWarningMessage(`No versions found for ${selectedPackage.package.id}.`);
        return undefined;
    }

    const stableVersions = versions.filter(version => !version.includes('-')).slice(0, 10);
    const previewVersions = versions.filter(version => version.includes('-')).slice(0, 10);
    const versionItems: vscode.QuickPickItem[] = [];

    if (stableVersions.length > 0) {
        versionItems.push({ label: 'Stable Versions', kind: vscode.QuickPickItemKind.Separator });
        stableVersions.forEach((version, index) => versionItems.push({
            label: version,
            description: index === 0 ? '(latest stable)' : ''
        }));
    }

    if (previewVersions.length > 0) {
        versionItems.push({ label: 'Preview Versions', kind: vscode.QuickPickItemKind.Separator });
        previewVersions.forEach((version, index) => versionItems.push({
            label: version,
            description: index === 0 ? '(latest preview)' : ''
        }));
    }

    const selectedVersion = await vscode.window.showQuickPick(versionItems, {
        placeHolder: 'Select a stable or preview version'
    });

    if (!selectedVersion) {
        output.appendLine('Version selection cancelled.');
        return undefined;
    }

    output.appendLine(`Selected ${selectedPackage.package.id} ${selectedVersion.label}.`);

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
 * Shows a quick pick to select an installed package and choose a new version
 * @param projectPath Path to the project file
 * @returns Selected package ID and new version, or undefined if cancelled
 */
export async function showUpdatePackagePicker(projectPath: string): Promise<{ packageId: string; version: string } | undefined> {
    const installedPackages = NuGetManager.getInstalledPackages(projectPath);

    if (installedPackages.length === 0) {
        vscode.window.showInformationMessage('No packages are installed in this project.');
        return undefined;
    }

    // Step 1: Pick an installed package
    const packageItems = installedPackages.map(pkg => ({
        label: pkg.id,
        description: `v${pkg.version}`
    }));

    const selectedPackage = await vscode.window.showQuickPick(packageItems, {
        placeHolder: 'Select a package to update'
    });

    if (!selectedPackage) {
        return undefined;
    }

    const currentVersion = installedPackages.find(p => p.id === selectedPackage.label)!.version;

    // Step 2: Fetch available versions
    const versions = await vscode.window.withProgress(
        {
            location: vscode.ProgressLocation.Notification,
            title: `Getting versions for ${selectedPackage.label}...`,
            cancellable: false
        },
        async () => {
            return await NuGetService.getPackageVersions(selectedPackage.label);
        }
    );

    if (versions.length === 0) {
        vscode.window.showWarningMessage(`No versions found for ${selectedPackage.label}`);
        return undefined;
    }

    // Separate stable and preview versions
    const stableVersions = versions.filter(v => !v.includes('-'));
    const previewVersions = versions.filter(v => v.includes('-'));

    // Take latest N of each category
    const latestStable = stableVersions.slice(0, 10);
    const latestPreview = previewVersions.slice(0, 10);

    // Build version items with separators
    const versionItems: vscode.QuickPickItem[] = [];

    if (latestStable.length > 0) {
        versionItems.push({ label: 'Stable Versions', kind: vscode.QuickPickItemKind.Separator });
        for (const ver of latestStable) {
            const isCurrent = ver === currentVersion;
            versionItems.push({
                label: ver,
                description: isCurrent ? '(current)' : (ver === latestStable[0] ? '(latest stable)' : '')
            });
        }
    }

    if (latestPreview.length > 0) {
        versionItems.push({ label: 'Preview Versions', kind: vscode.QuickPickItemKind.Separator });
        for (const ver of latestPreview) {
            const isCurrent = ver === currentVersion;
            versionItems.push({
                label: ver,
                description: isCurrent ? '(current)' : (ver === latestPreview[0] ? '(latest preview)' : '')
            });
        }
    }

    const selectedVersion = await vscode.window.showQuickPick(versionItems, {
        placeHolder: `Select a new version for ${selectedPackage.label} (current: v${currentVersion})`
    });

    if (!selectedVersion) {
        return undefined;
    }

    if (selectedVersion.label === currentVersion) {
        vscode.window.showInformationMessage(`${selectedPackage.label} is already at v${currentVersion}.`);
        return undefined;
    }

    return {
        packageId: selectedPackage.label,
        version: selectedVersion.label
    };
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
