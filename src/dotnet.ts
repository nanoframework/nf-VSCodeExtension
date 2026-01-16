/*---------------------------------------------------------------------------------------------
 * Copyright (c) .NET Foundation and Contributors.
 * Portions Copyright (c) Microsoft Corporation.  All rights reserved.
 * See LICENSE file in the project root for full license information.
 *--------------------------------------------------------------------------------------------*/

import * as path from "path";
import * as os from 'os';
import * as fs from 'fs';
import * as https from 'https';
import { Executor } from "./executor";
import * as cp from 'child_process';
import * as vscode from 'vscode';

const mdpBuildProperties = ' -p:NFMDP_PE_Verbose=false -p:NFMDP_PE_VerboseMinimize=false';

// Deploy operation tracking - used to cancel previous deploys when a new one starts
let currentDeployId = 0;

// Shared output channel for build logs
let buildOutputChannel: vscode.OutputChannel | null = null;
function getBuildOutputChannel(): vscode.OutputChannel {
    if (!buildOutputChannel) {
        buildOutputChannel = vscode.window.createOutputChannel('nanoFramework Build');
    }
    return buildOutputChannel;
}

/**
 * Represents a file to be deployed to device storage
 */
interface FileDeploymentEntry {
    DestinationFilePath: string;
    SourceFilePath: string;
}

/**
 * Represents the file deployment JSON structure for nanoff
 */
interface FileDeploymentConfig {
    files: FileDeploymentEntry[];
}

/**
 * Parses a .csproj or .nfproj file to find content files marked for deployment
 * @param projectPath Path to the project file (.csproj or .nfproj)
 * @param configuration Build configuration (Debug/Release)
 * @returns Array of file deployment entries
 */
function parseProjectForContentFiles(projectPath: string, configuration: string): FileDeploymentEntry[] {
    const entries: FileDeploymentEntry[] = [];
    const projectDir = path.dirname(projectPath);
    
    if (!fs.existsSync(projectPath)) {
        console.log(`Project file not found: ${projectPath}`);
        return entries;
    }
    
    const projectContent = fs.readFileSync(projectPath, 'utf-8');
    
    // Match Content or None items with CopyToOutputDirectory set to Always or PreserveNewest
    // Pattern matches:
    // <Content Include="path">
    //   <CopyToOutputDirectory>Always|PreserveNewest</CopyToOutputDirectory>
    //   <NF_StoragePath>optional custom path</NF_StoragePath>
    // </Content>
    // Also handles: <None Include="..."> with same structure
    
    // Regex to find Content or None items
    const itemPattern = /<(Content|None)\s+Include="([^"]+)"[^>]*(?:\/\s*>|>([\s\S]*?)<\/\1>)/gi;
    
    let match;
    while ((match = itemPattern.exec(projectContent)) !== null) {
        const includePath = match[2];
        const innerContent = match[3] || '';
        
        // Check if CopyToOutputDirectory is Always or PreserveNewest
        const copyMatch = innerContent.match(/<CopyToOutputDirectory>\s*(Always|PreserveNewest)\s*<\/CopyToOutputDirectory>/i);
        
        if (copyMatch) {
            // Get the source file path (relative to project directory)
            const sourceRelativePath = includePath.replace(/\\/g, path.sep);
            const sourceFullPath = path.join(projectDir, sourceRelativePath);
            
            // Check if source file exists
            if (!fs.existsSync(sourceFullPath)) {
                console.log(`Content file not found: ${sourceFullPath}`);
                continue;
            }
            
            // Check for custom NF_StoragePath
            const storagePathMatch = innerContent.match(/<NF_StoragePath>\s*([^<]+)\s*<\/NF_StoragePath>/i);
            
            let destinationPath: string;
            if (storagePathMatch) {
                // Use custom storage path
                destinationPath = storagePathMatch[1].trim();
                // Ensure it uses Windows-style paths for the device
                destinationPath = destinationPath.replace(/\//g, '\\');
            } else {
                // Use the relative path from the project, prefixed with I:
                // Convert to Windows-style path for device
                const relativePath = includePath.replace(/\//g, '\\');
                destinationPath = `I:\\${relativePath}`;
            }
            
            entries.push({
                DestinationFilePath: destinationPath,
                SourceFilePath: sourceFullPath
            });
            
            console.log(`Found content file for deployment: ${sourceFullPath} -> ${destinationPath}`);
        }
    }
    
    return entries;
}

/**
 * Finds all project files in a solution and collects content files for deployment
 * @param solutionPath Path to the solution file
 * @param configuration Build configuration (Debug/Release)
 * @returns Array of file deployment entries from all projects
 */
function findContentFilesForDeployment(solutionPath: string, configuration: string): FileDeploymentEntry[] {
    const solutionDir = path.dirname(solutionPath);
    const allEntries: FileDeploymentEntry[] = [];
    
    // Find all .nfproj and .csproj files in the solution directory
    try {
        const entries = fs.readdirSync(solutionDir, { withFileTypes: true });
        
        for (const entry of entries) {
            if (entry.isDirectory()) {
                const projectDir = path.join(solutionDir, entry.name);
                const projectFiles = fs.readdirSync(projectDir).filter(f => 
                    f.endsWith('.nfproj') || f.endsWith('.csproj')
                );
                
                for (const projectFile of projectFiles) {
                    const projectPath = path.join(projectDir, projectFile);
                    const contentFiles = parseProjectForContentFiles(projectPath, configuration);
                    allEntries.push(...contentFiles);
                }
            }
        }
    } catch (error) {
        console.error(`Error finding content files: ${error}`);
    }
    
    return allEntries;
}

/**
 * Creates a file deployment JSON file for nanoff
 * @param solutionPath Path to the solution file
 * @param configuration Build configuration (Debug/Release)
 * @returns Path to the created JSON file, or null if no files to deploy
 */
function createFileDeploymentJson(solutionPath: string, configuration: string): string | null {
    const contentFiles = findContentFilesForDeployment(solutionPath, configuration);
    
    if (contentFiles.length === 0) {
        console.log('No content files found for file deployment');
        return null;
    }
    
    const deploymentConfig: FileDeploymentConfig = {
        files: contentFiles
    };
    
    // Find the output directory (bin/Debug or bin/Release of first project)
    const solutionDir = path.dirname(solutionPath);
    let outputDir = solutionDir;
    
    try {
        const entries = fs.readdirSync(solutionDir, { withFileTypes: true });
        for (const entry of entries) {
            if (entry.isDirectory()) {
                const binDir = path.join(solutionDir, entry.name, 'bin', configuration);
                if (fs.existsSync(binDir)) {
                    outputDir = binDir;
                    break;
                }
            }
        }
    } catch (error) {
        console.error(`Error finding output directory: ${error}`);
    }
    
    const jsonPath = path.join(outputDir, 'filedeployment.json');
    
    try {
        fs.writeFileSync(jsonPath, JSON.stringify(deploymentConfig, null, 2), 'utf-8');
        console.log(`Created file deployment JSON: ${jsonPath}`);
        return jsonPath;
    } catch (error) {
        console.error(`Error writing file deployment JSON: ${error}`);
        return null;
    }
}

/**
 * Finds the msbuild executable path on Unix systems (macOS/Linux)
 * @returns The path to msbuild or null if not found
 */
function findUnixMsBuild(): string | null {
    // Common locations for msbuild on Unix systems
    const locations = [
        '/usr/bin/msbuild',
        '/usr/local/bin/msbuild',
        '/Library/Frameworks/Mono.framework/Versions/Current/Commands/msbuild',
        '/Library/Frameworks/Mono.framework/Commands/msbuild',
        path.join(os.homedir(), '.dotnet/tools/msbuild')
    ];
    
    for (const loc of locations) {
        if (fs.existsSync(loc)) {
            return loc;
        }
    }
    
    // Try to find via 'which' command
    try {
        const result = cp.execSync('which msbuild', { encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] });
        const msbuildPath = result.trim();
        if (msbuildPath && fs.existsSync(msbuildPath)) {
            return msbuildPath;
        }
    } catch {
        // which command failed, msbuild not in PATH
    }
    
    return null;
}

/**
 * Finds the nuget executable path on Unix systems (macOS/Linux)
 * @returns The path to nuget or null if not found
 */
function findUnixNuget(): string | null {
    // Common locations for nuget on Unix systems
    const locations = [
        '/usr/bin/nuget',
        '/usr/local/bin/nuget',
        '/Library/Frameworks/Mono.framework/Versions/Current/Commands/nuget',
        '/Library/Frameworks/Mono.framework/Commands/nuget'
    ];
    
    for (const loc of locations) {
        if (fs.existsSync(loc)) {
            return loc;
        }
    }
    
    // Try to find via 'which' command
    try {
        const result = cp.execSync('which nuget', { encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] });
        const nugetPath = result.trim();
        if (nugetPath && fs.existsSync(nugetPath)) {
            return nugetPath;
        }
    } catch {
        // which command failed, nuget not in PATH
    }
    
    return null;
}

/**
 * Finds or downloads nuget.exe on Windows
 * @param extensionPath The extension's installation path for storing nuget.exe
 * @returns The path to nuget.exe or null if not found and download failed
 */
async function findOrDownloadWindowsNuget(extensionPath: string): Promise<string | null> {
    // First check if nuget is in PATH
    try {
        const result = cp.execSync('where nuget', { encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] });
        const nugetPath = result.trim().split('\n')[0];
        if (nugetPath && fs.existsSync(nugetPath)) {
            return nugetPath;
        }
    } catch {
        // nuget not in PATH
    }

    // Common Visual Studio locations for nuget.exe
    const vsLocations = [
        path.join(process.env['ProgramFiles(x86)'] || '', 'NuGet', 'nuget.exe'),
        path.join(process.env['ProgramFiles'] || '', 'NuGet', 'nuget.exe'),
        path.join(process.env['LOCALAPPDATA'] || '', 'NuGet', 'nuget.exe'),
    ];

    for (const loc of vsLocations) {
        if (fs.existsSync(loc)) {
            return loc;
        }
    }

    // Check if we already downloaded nuget.exe to the extension folder
    const cachedNugetPath = path.join(extensionPath, 'nuget.exe');
    if (fs.existsSync(cachedNugetPath)) {
        return cachedNugetPath;
    }

    // Download nuget.exe from nuget.org
    const downloadUrl = 'https://dist.nuget.org/win-x86-commandline/latest/nuget.exe';
    
    return new Promise((resolve) => {
        vscode.window.withProgress(
            {
                location: vscode.ProgressLocation.Notification,
                title: 'Downloading nuget.exe...',
                cancellable: false
            },
            async () => {
                try {
                    const file = fs.createWriteStream(cachedNugetPath);
                    https.get(downloadUrl, (response) => {
                        // Handle redirects
                        if (response.statusCode === 301 || response.statusCode === 302) {
                            const redirectUrl = response.headers.location;
                            if (redirectUrl) {
                                https.get(redirectUrl, (redirectResponse) => {
                                    redirectResponse.pipe(file);
                                    file.on('finish', () => {
                                        file.close();
                                        resolve(cachedNugetPath);
                                    });
                                }).on('error', (err) => {
                                    fs.unlink(cachedNugetPath, () => {});
                                    console.error('Error downloading nuget.exe:', err);
                                    resolve(null);
                                });
                            } else {
                                resolve(null);
                            }
                        } else {
                            response.pipe(file);
                            file.on('finish', () => {
                                file.close();
                                resolve(cachedNugetPath);
                            });
                        }
                    }).on('error', (err) => {
                        fs.unlink(cachedNugetPath, () => {});
                        console.error('Error downloading nuget.exe:', err);
                        resolve(null);
                    });
                } catch (err) {
                    console.error('Error downloading nuget.exe:', err);
                    resolve(null);
                }
            }
        );
    });
}

/**
 * Builds the nanoFramework project system path using proper path separators
 * @param toolPath The base tool path
 * @returns Properly formatted path for the current platform (with trailing separator)
 */
function buildNanoFrameworkProjectSystemPath(toolPath: string): string {
    // Use forward slashes to avoid escaping issues with trailing backslash in quoted paths
    // MSBuild accepts forward slashes on Windows
    const nfPath = path.join(toolPath, 'nanoFramework', 'v1.0');
    return nfPath.replace(/\\/g, '/') + '/';
}

export class Dotnet {
    /**
     * Builds the nanoFramework solution in a Terminal using MSBuild.exe (win32) or msbuild from mono (linux/macOS)
     * @param fileUri absolute path to *.sln
     * @param toolPath absolute path to root of nanoFramework extension 
     */
    public static async build(fileUri: string, toolPath: string, configuration?: string) {
        if (!configuration) {
            configuration = await vscode.window.showQuickPick(['Debug', 'Release'], { placeHolder: 'Select build configuration', canPickMany: false }) || 'Debug';
        }
        if (fileUri) {
            // Clean .bin files before building to avoid stale files
            cleanBinFiles(fileUri, configuration);

            const nfProjectSystemPath = buildNanoFrameworkProjectSystemPath(toolPath);
            
            // Using dynamically-solved MSBuild.exe when run from win32
            if (os.platform() === "win32") {
                const nugetPath = await findOrDownloadWindowsNuget(toolPath);
                
                if (!nugetPath) {
                    vscode.window.showErrorMessage(
                        'nuget.exe not found and could not be downloaded. Please download manually from https://www.nuget.org/downloads',
                        'Download NuGet'
                    ).then(selection => {
                        if (selection === 'Download NuGet') {
                            vscode.env.openExternal(vscode.Uri.parse('https://www.nuget.org/downloads'));
                        }
                    });
                    return;
                }
                
                Executor.runCommand('$path = & "${env:ProgramFiles(x86)}\\microsoft visual studio\\installer\\vswhere.exe" -products * -latest -prerelease -requires Microsoft.Component.MSBuild -find MSBuild\\**\\Bin\\amd64\\MSBuild.exe | select-object -first 1; ' +
                    '& "' + nugetPath + '" restore "' + fileUri + '"; ' +
                    '& $path "' + fileUri + '" -p:platform="Any CPU" -p:Configuration="' + configuration + '" "-p:NanoFrameworkProjectSystemPath=' + nfProjectSystemPath + '" ' + mdpBuildProperties + ' -verbosity:minimal');
            }
            // Using msbuild (comes with mono-complete) on Unix 
            else {
                const msbuildPath = findUnixMsBuild();
                const nugetPath = findUnixNuget();
                
                if (!msbuildPath) {
                    vscode.window.showErrorMessage(
                        'msbuild not found. Please install mono-complete from the Mono Project (not from your distribution\'s package manager). ' +
                        'Visit: https://www.mono-project.com/download/stable/',
                        'View Installation Guide'
                    ).then(selection => {
                        if (selection === 'View Installation Guide') {
                            vscode.env.openExternal(vscode.Uri.parse('https://www.mono-project.com/download/stable/'));
                        }
                    });
                    return;
                }
                
                if (!nugetPath) {
                    vscode.window.showErrorMessage(
                        'nuget not found. Please install nuget CLI. ' +
                        'On macOS: brew install nuget | On Linux: sudo apt install nuget',
                        'View NuGet Downloads'
                    ).then(selection => {
                        if (selection === 'View NuGet Downloads') {
                            vscode.env.openExternal(vscode.Uri.parse('https://www.nuget.org/downloads'));
                        }
                    });
                    return;
                }
                
                // Use the found paths with proper quoting for paths with spaces
                const buildCommand = `"${nugetPath}" restore "${fileUri}" && "${msbuildPath}" "${fileUri}" -p:platform="Any CPU" -p:Configuration="${configuration}" "-p:NanoFrameworkProjectSystemPath=${nfProjectSystemPath}" ${mdpBuildProperties} -verbosity:minimal`;
                Executor.runCommand(buildCommand);
            }
        }
    }

    /**
     * First builds nanoFramework solution, then deploys this built solution to selected device
     * Uses the same build process as the build command, then finds .bin files in project output directories
     * @param fileUri absolute path to *.sln 
     * @param serialPath path to connected nanoFramework device (e.g. COM4 or /dev/tty.usbserial*)
     * @param toolPath absolute path to root of nanoFramework extension 
     */
    public static async deploy(fileUri: string, serialPath: string, toolPath: string, configuration?: string) {
        if (!configuration) {
            configuration = await vscode.window.showQuickPick(['Debug', 'Release'], { placeHolder: 'Select build configuration', canPickMany: false }) || 'Debug';
        }
        if (!fileUri) {
            vscode.window.showErrorMessage('No solution file selected. Please select a .sln file.');
            return;
        }

        // Cancel any previous deploy operation by incrementing the deploy ID
        currentDeployId++;
        const thisDeployId = currentDeployId;
        console.log(`Deploy #${thisDeployId} starting - Solution: ${fileUri}, Port: ${serialPath}, ToolPath: ${toolPath}`);

        // Clean .bin files before building to avoid stale files
        cleanBinFiles(fileUri, configuration);

        const nfProjectSystemPath = buildNanoFrameworkProjectSystemPath(toolPath);
        
        // Verify the nanoFramework project system path exists (check without trailing slash)
        const nfPathToCheck = nfProjectSystemPath.endsWith('/') ? nfProjectSystemPath.slice(0, -1) : nfProjectSystemPath;
        if (!fs.existsSync(nfPathToCheck)) {
            vscode.window.showErrorMessage(
                `nanoFramework SDK not found at: ${nfProjectSystemPath}. ` +
                'Please run the build.ps1 script to set up the extension.'
            );
            return;
        }

        // Use the same build arguments as the regular build command (no custom OutDir)
        const cliBuildArguments = `-p:platform="Any CPU" -p:Configuration="${configuration}" "-p:NanoFrameworkProjectSystemPath=${nfProjectSystemPath}" ${mdpBuildProperties} -verbosity:minimal`;

        // Check if we should show terminal output
        const showTerminal = Executor.shouldShowTerminal();

        if (showTerminal) {
            // Run build in terminal (visible to user), then prompt for deploy
            if (os.platform() === "win32") {
                const nugetPath = await findOrDownloadWindowsNuget(toolPath);
                
                if (!nugetPath) {
                    vscode.window.showErrorMessage(
                        'nuget.exe not found and could not be downloaded.',
                        'Download NuGet'
                    ).then(selection => {
                        if (selection === 'Download NuGet') {
                            vscode.env.openExternal(vscode.Uri.parse('https://www.nuget.org/downloads'));
                        }
                    });
                    return;
                }
                
                // Build command for terminal - same as regular build
                const buildCommand = '$path = & "${env:ProgramFiles(x86)}\\microsoft visual studio\\installer\\vswhere.exe" -products * -latest -prerelease -requires Microsoft.Component.MSBuild -find MSBuild\\**\\Bin\\amd64\\MSBuild.exe | select-object -first 1; ' +
                    '& "' + nugetPath + '" restore "' + fileUri + '"; ' +
                    '& $path "' + fileUri + '" ' + cliBuildArguments;
                
                Executor.runInTerminal(buildCommand);
            } else {
                const msbuildPath = findUnixMsBuild();
                const nugetPath = findUnixNuget();
                
                if (!msbuildPath || !nugetPath) {
                    vscode.window.showErrorMessage(
                        'msbuild or nuget not found. Please install mono-complete from the Mono Project and nuget CLI.',
                        'View Installation Guide'
                    ).then(selection => {
                        if (selection === 'View Installation Guide') {
                            vscode.env.openExternal(vscode.Uri.parse('https://www.mono-project.com/download/stable/'));
                        }
                    });
                    return;
                }
                
                // Build command - same as regular build
                const buildCommand = `"${nugetPath}" restore "${fileUri}" && "${msbuildPath}" "${fileUri}" ${cliBuildArguments}`;
                Executor.runInTerminal(buildCommand);
            }

            // Automatically wait for build to finish by polling for .bin files, then deploy
            // We wait for .bin files to appear and then wait a bit longer to ensure build is complete
            // The deployId parameter is used to check if this deploy has been cancelled
            const pollForBinFiles = async (solutionPath: string, deployId: number, timeoutMs = 120000, intervalMs = 2000, configurationParam: string = configuration): Promise<string[] | null> => {
                const end = Date.now() + timeoutMs;
                
                while (Date.now() < end) {
                    // Check if this deploy has been cancelled (a new deploy started)
                    if (currentDeployId !== deployId) {
                        console.log(`Deploy #${deployId} cancelled - a newer deploy #${currentDeployId} has started`);
                        return null; // Return null to indicate cancellation
                    }
                    
                    const files = await findDeployableBinFiles(solutionPath, configurationParam);
                    
                    if (files.length > 0) {
                        // Found .bin files - wait a bit more to ensure build is fully complete
                        console.log(`Deploy #${deployId}: Found ${files.length} .bin file(s), waiting for build to fully complete...`);
                        await new Promise(r => setTimeout(r, 3000));
                        
                        // Check again if cancelled during the wait
                        if (currentDeployId !== deployId) {
                            console.log(`Deploy #${deployId} cancelled during wait - a newer deploy #${currentDeployId} has started`);
                            return null;
                        }
                        
                        // Re-check to get final list
                        const finalFiles = await findDeployableBinFiles(solutionPath, configurationParam);
                        return finalFiles;
                    }
                    
                    await new Promise(r => setTimeout(r, intervalMs));
                }
                return [];
            };

            vscode.window.showInformationMessage('Build started in terminal. Waiting for build to finish...');

            const binFiles = await pollForBinFiles(fileUri, thisDeployId, 120000, 2000, configuration);

            // Check if deploy was cancelled
            if (binFiles === null) {
                console.log(`Deploy #${thisDeployId} was cancelled, stopping`);
                return;
            }

            if (binFiles.length === 0) {
                vscode.window.showErrorMessage('No .bin files found after build finished. Make sure the build completed successfully.');
                return;
            }

            // Final check if this deploy is still the current one before flashing
            if (currentDeployId !== thisDeployId) {
                console.log(`Deploy #${thisDeployId} cancelled before flash - a newer deploy #${currentDeployId} has started`);
                return;
            }

            // Build the deploy command with all BIN files (using full paths)
            // Deduplicate files (resolve to absolute paths to avoid duplicates)
            const uniqueBinFiles = Array.from(new Set(binFiles.map(f => path.resolve(f))));
            const imageArgs = uniqueBinFiles.map(f => `--image "${f}"`).join(' ');
            let cliDeployArguments = `nanoff --nanodevice --deploy --serialport "${serialPath}" ${imageArgs}`;

            // Check for content files to deploy
            const fileDeploymentJsonPath = createFileDeploymentJson(fileUri, configuration);
            if (fileDeploymentJsonPath) {
                cliDeployArguments += ` --filedeployment "${fileDeploymentJsonPath}"`;
                vscode.window.showInformationMessage(`File deployment enabled: deploying content files to device storage.`);
            }

            console.log(`Deploy command: ${cliDeployArguments}`);
            
            // Wait a moment to ensure terminal is ready for the next command
            // This helps when the build just finished and the terminal needs to process
            await new Promise(resolve => setTimeout(resolve, 1000));
            
            // Send the deploy command to terminal
            Executor.runInTerminal(cliDeployArguments);
            console.log('Deploy command sent to terminal');
            vscode.window.showInformationMessage(`Deploying ${binFiles.length} BIN file(s) to ${serialPath}...`);
        } else {
            // Run build hidden with progress notification
            try {
                await vscode.window.withProgress({
                    location: vscode.ProgressLocation.Notification,
                    title: "nanoFramework",
                    cancellable: false
                }, async (progress) => {
                    // Check if this deploy has been cancelled
                    if (currentDeployId !== thisDeployId) {
                        console.log(`Deploy #${thisDeployId} cancelled at start of hidden build`);
                        return;
                    }

                    progress.report({ message: "Building project..." });

                    // Get the output channel for logging
                    const outChannel = getBuildOutputChannel();
                    outChannel.clear();
                    outChannel.appendLine('=== nanoFramework Build & Deploy ===');
                    outChannel.appendLine(`Solution: ${fileUri}`);
                    outChannel.appendLine(`Configuration: ${configuration}`);
                    outChannel.appendLine('');

                    let buildSuccess = false;
                    let buildResult: { success: boolean; stdout?: string; stderr?: string; exitCode?: number | null } | null = null;

                    if (os.platform() === "win32") {
                        const nugetPath = await findOrDownloadWindowsNuget(toolPath);
                        
                        if (!nugetPath) {
                            vscode.window.showErrorMessage(
                                'nuget.exe not found and could not be downloaded. Please download manually from https://www.nuget.org/downloads',
                                'Download NuGet'
                            ).then(selection => {
                                if (selection === 'Download NuGet') {
                                    vscode.env.openExternal(vscode.Uri.parse('https://www.nuget.org/downloads'));
                                }
                            });
                            return;
                        }
                        
                        // Build the project and wait for completion - same args as regular build
                        buildResult = await executeBuildWindows(fileUri, cliBuildArguments, nugetPath);
                        buildSuccess = !!(buildResult && buildResult.success);
                    }
                    else {
                        const msbuildPath = findUnixMsBuild();
                        const nugetPath = findUnixNuget();
                        
                        if (!msbuildPath || !nugetPath) {
                            vscode.window.showErrorMessage(
                                'msbuild or nuget not found. Please install mono-complete from the Mono Project and nuget CLI.',
                                'View Installation Guide'
                            ).then(selection => {
                                if (selection === 'View Installation Guide') {
                                    vscode.env.openExternal(vscode.Uri.parse('https://www.mono-project.com/download/stable/'));
                                }
                            });
                            return;
                        }
                        
                        // Build the project and wait for completion - same args as regular build
                        buildResult = await executeBuildUnix(fileUri, cliBuildArguments, msbuildPath, nugetPath);
                        buildSuccess = !!(buildResult && buildResult.success);
                    }

                    // Write build output to channel
                    outChannel.appendLine('=== Build Output ===');
                    if (buildResult) {
                        if (buildResult.stdout) {
                            outChannel.appendLine(buildResult.stdout);
                        }
                        if (buildResult.stderr) {
                            outChannel.appendLine('--- stderr ---');
                            outChannel.appendLine(buildResult.stderr);
                        }
                    }
                    outChannel.appendLine('');

                    if (!buildSuccess) {
                        // Extract and display error lines
                        const errorLineRegex = /:\s*error\s.*?:/i;
                        const allOutput = (buildResult?.stdout || '') + '\n' + (buildResult?.stderr || '');
                        const errorLines = allOutput.split(/\r?\n/).filter(l => errorLineRegex.test(l));
                        
                        if (errorLines.length > 0) {
                            outChannel.appendLine('=== Build Errors ===');
                            errorLines.forEach(l => outChannel.appendLine('ERROR: ' + l.trim()));
                        }
                        
                        outChannel.appendLine('');
                        outChannel.appendLine('Build FAILED');
                        outChannel.show(true);
                        
                        vscode.window.showErrorMessage('Build failed. See Output panel for details.');
                        return;
                    }

                    outChannel.appendLine('Build succeeded.');
                    outChannel.appendLine('');

                    // Check if this deploy has been cancelled
                    if (currentDeployId !== thisDeployId) {
                        console.log(`Deploy #${thisDeployId} cancelled after build`);
                        outChannel.appendLine('Deploy cancelled - a newer deploy was started.');
                        return;
                    }

                    progress.report({ message: "Finding BIN files to deploy..." });

                    // Find all BIN files in project output directories
                    const binFiles = await findDeployableBinFiles(fileUri, configuration);
                    
                    if (binFiles.length === 0) {
                        outChannel.appendLine('No .bin files found in project output directories.');
                        outChannel.show(true);
                        vscode.window.showErrorMessage(
                            'No .bin files found in project output directories. ' +
                            'Make sure the build completed successfully.'
                        );
                        return;
                    }

                    progress.report({ message: `Deploying ${binFiles.length} BIN file(s) to ${serialPath}...` });

                    // Check if this deploy has been cancelled before flashing
                    if (currentDeployId !== thisDeployId) {
                        console.log(`Deploy #${thisDeployId} cancelled before flash`);
                        outChannel.appendLine('Deploy cancelled - a newer deploy was started.');
                        return;
                    }

                    // Build the deploy command with all BIN files (using full paths)
                    // Deduplicate files (resolve to absolute paths to avoid duplicates)
                    const uniqueBinFiles = Array.from(new Set(binFiles.map(f => path.resolve(f))));
                    const imageArgs = uniqueBinFiles.map(f => `--image "${f}"`).join(' ');
                    let cliDeployArguments = `nanoff --nanodevice --deploy --serialport "${serialPath}" ${imageArgs}`;
                    
                    // Check for content files to deploy
                    const fileDeploymentJsonPath = createFileDeploymentJson(fileUri, configuration);
                    if (fileDeploymentJsonPath) {
                        cliDeployArguments += ` --filedeployment "${fileDeploymentJsonPath}"`;
                        outChannel.appendLine('=== File Deployment ===');
                        outChannel.appendLine(`File deployment JSON: ${fileDeploymentJsonPath}`);
                        try {
                            const jsonContent = fs.readFileSync(fileDeploymentJsonPath, 'utf-8');
                            outChannel.appendLine(jsonContent);
                        } catch (e) {
                            outChannel.appendLine('Could not read file deployment JSON');
                        }
                        outChannel.appendLine('');
                    }
                    
                    console.log(`Deploy command: ${cliDeployArguments}`);
                    outChannel.appendLine('=== Deploy ===');
                    outChannel.appendLine(`Command: ${cliDeployArguments}`);
                    outChannel.appendLine('');
                    
                    // Run deploy hidden as well
                    const deployResult = await Executor.runHidden(cliDeployArguments);
                    
                    // Write deploy output to channel
                    if (deployResult.stdout) {
                        outChannel.appendLine('--- stdout ---');
                        outChannel.appendLine(deployResult.stdout);
                    }
                    if (deployResult.stderr) {
                        outChannel.appendLine('--- stderr ---');
                        outChannel.appendLine(deployResult.stderr);
                    }
                    outChannel.appendLine('');
                    
                    if (deployResult.success) {
                        outChannel.appendLine(`Deploy succeeded. ${uniqueBinFiles.length} BIN file(s) deployed to ${serialPath}`);
                        outChannel.show(true);
                        vscode.window.showInformationMessage(`Successfully deployed ${uniqueBinFiles.length} BIN file(s) to ${serialPath}`);
                    } else {
                        outChannel.appendLine('Deploy FAILED');
                        outChannel.show(true);
                        // Show detailed error information
                        const errorDetails = deployResult.stdout || deployResult.stderr || 'Unknown error';
                        console.error(`Deploy failed. stdout: ${deployResult.stdout}, stderr: ${deployResult.stderr}`);
                        vscode.window.showErrorMessage(`Deploy failed. See Output panel for details.`);
                    }
                });
            } catch (error) {
                const errorMessage = error instanceof Error ? error.message : String(error);
                vscode.window.showErrorMessage(`Deploy failed: ${errorMessage}`);
            }
        }
    }

    /**
     * Flashes the selected device to new firmware using nanoFirmwareFlasher
     * @param cliArguments CLI arguments passed to nanoff
     */
    public static async flash(cliArguments: string) {
        if (!cliArguments) {
            return;
        }

        const cmd = `nanoff --update ${cliArguments}`;

        if (Executor.shouldShowTerminal()) {
            // Running in visible terminal — parsing not possible here
            Executor.runInTerminal(cmd);
            vscode.window.showInformationMessage('Flash started in terminal. Output parsing is disabled when showing terminal output.');
            return;
        }

        // Run hidden and parse output for error codes
        const result = await Executor.runHidden(cmd);

        const combinedOutput = `${result.stdout || ''}\n${result.stderr || ''}`;

        // Mapping of exit codes to human-readable descriptions (from ExitCodes.cs)
        const exitCodeDescriptions: { [code: string]: string } = {
            '0': 'OK',
            'E1000': "No DFU device found. Make sure it's connected and has booted in DFU mode",
            '1000': "No DFU device found. Make sure it's connected and has booted in DFU mode",
            'E1002': "Couldn't find DFU file. Check the path.",
            '1002': "Couldn't find DFU file. Check the path.",
            'E1003': 'Error flashing DFU device.',
            '1003': 'Error flashing DFU device.',
            'E1004': "Firmware package doesn't have a DFU package.",
            '1004': "Firmware package doesn't have a DFU package.",
            'E1005': "Can't connect to specified DFU device. Make sure it's connected and that the ID is correct.",
            '1005': "Can't connect to specified DFU device. Make sure it's connected and that the ID is correct.",
            'E1006': 'Failed to start execution on the connected device.',
            '1006': 'Failed to start execution on the connected device.',
            'E2000': 'Error connecting to nano device.',
            '2000': 'Error connecting to nano device.',
            'E2001': 'Error occurred with listing nano devices.',
            '2001': 'Error occurred with listing nano devices.',
            'E2002': 'Error executing operation with nano device.',
            '2002': 'Error executing operation with nano device.',
            'E2003': 'Error executing file deployment on nano device.',
            '2003': 'Error executing file deployment on nano device.',
            'E4000': 'Error executing esptool command.',
            '4000': 'Error executing esptool command.',
            'E4001': 'Unsupported flash size for ESP32 target.',
            '4001': 'Unsupported flash size for ESP32 target.',
            'E4002': 'Failed to erase ESP32 flash.',
            '4002': 'Failed to erase ESP32 flash.',
            'E4003': 'Failed to write new firmware to ESP32.',
            '4003': 'Failed to write new firmware to ESP32.',
            'E4004': 'Failed to read from ESP32 flash.',
            '4004': 'Failed to read from ESP32 flash.',
            'E4005': 'Failed to open specified COM port.',
            '4005': 'Failed to open specified COM port.',
            'E5000': 'Error executing STM32 Programmer CLI command.',
            '5000': 'Error executing STM32 Programmer CLI command.',
            'E5001': 'No JTAG device found. Make sure it\'s connected',
            '5001': 'No JTAG device found. Make sure it\'s connected',
            'E5002': "Can't connect to specified JTAG device. Make sure it's connected and that the ID is correct.",
            '5002': "Can't connect to specified JTAG device. Make sure it's connected and that the ID is correct.",
            'E5003': "Couldn't find HEX file. Check the path.",
            '5003': "Couldn't find HEX file. Check the path.",
            'E5004': "Couldn't find BIN file. Check the path.",
            '5004': "Couldn't find BIN file. Check the path.",
            'E5005': 'Failed to perform mass erase on device.',
            '5005': 'Failed to perform mass erase on device.',
            'E5006': 'Failed to write new firmware to device.',
            '5006': 'Failed to write new firmware to device.',
            'E5007': "Can't program BIN file without specifying an address.",
            '5007': "Can't program BIN file without specifying an address.",
            'E5008': 'Invalid address specified. Hexadecimal (0x0000F000) format required.',
            '5008': 'Invalid address specified. Hexadecimal (0x0000F000) format required.',
            'E5009': 'Address count doesn\'t match BIN files count. An address needs to be specified for each BIN file.',
            '5009': 'Address count doesn\'t match BIN files count. An address needs to be specified for each BIN file.',
            'E5010': 'Failed to reset MCU on connected device.',
            '5010': 'Failed to reset MCU on connected device.',
            'E6000': "Couldn't open serial device. Make sure the COM port exists, that the device is connected and that it's not being used by another application.",
            '6000': "Couldn't open serial device. Make sure the COM port exists, that the device is connected and that it's not being used by another application.",
            'E6001': 'Need to specify a COM port.',
            '6001': 'Need to specify a COM port.',
            'E6002': "Couldn't access serial device. Another (nanoFramework) application has exclusive access to the device.",
            '6002': "Couldn't access serial device. Another (nanoFramework) application has exclusive access to the device.",
            'E7000': 'Unsupported device.',
            '7000': 'Unsupported device.',
            'E8000': 'Error executing J-Link CLI command.',
            '8000': 'Error executing J-Link CLI command.',
            'E8001': 'No J-Link device found. Make sure it\'s connected.',
            '8001': 'No J-Link device found. Make sure it\'s connected.',
            'E8002': 'Error executing silink CLI command.',
            '8002': 'Error executing silink CLI command.',
            'E8003': 'Path of BIN file contains spaces or diacritic characters.',
            '8003': 'Path of BIN file contains spaces or diacritic characters.',
            'E9000': 'Invalid or missing arguments.',
            '9000': 'Invalid or missing arguments.',
            'E9002': "Can't access or create backup directory.",
            '9002': "Can't access or create backup directory.",
            'E9003': "Can't delete existing backup file.",
            '9003': "Can't delete existing backup file.",
            'E9004': 'Backup file specified without backup path. Specify backup path with --backuppath.',
            '9004': 'Backup file specified without backup path. Specify backup path with --backuppath.',
            'E9005': "Can't find the target in Cloudsmith repository.",
            '9005': "Can't find the target in Cloudsmith repository.",
            'E9006': "Can't create temporary directory to download firmware.",
            '9006': "Can't create temporary directory to download firmware.",
            'E9007': 'Error downloading firmware file.',
            '9007': 'Error downloading firmware file.',
            'E9008': "Couldn't find application file. Check the path.",
            '9008': "Couldn't find application file. Check the path.",
            'E9009': "Can't program deployment BIN file without specifying a valid deployment address.",
            '9009': "Can't program deployment BIN file without specifying a valid deployment address.",
            'E9010': "Couldn't find any device connected.",
            '9010': "Couldn't find any device connected.",
            'E9011': "Couldn't find CLR image file. Check the path.",
            '9011': "Couldn't find CLR image file. Check the path.",
            'E9012': "CLR image file has wrong format. It has to be a binary file.",
            '9012': "CLR image file has wrong format. It has to be a binary file.",
            'E9013': 'Unsupported platform. Valid options are: esp32, stm32, cc13x2',
            '9013': 'Unsupported platform. Valid options are: esp32, stm32, cc13x2',
            'E9014': 'Error occurred when clearing the firmware cache location.',
            '9014': 'Error occurred when clearing the firmware cache location.',
            'E9015': "Can't find the target in the firmware archive.",
            '9015': "Can't find the target in the firmware archive."
        };

        // Search for error codes like E1000 or numeric exit codes (e.g., 5004)
        const detected = new Set<string>();

        const eMatches = combinedOutput.match(/E\d{4}/g);
        if (eMatches) {
            eMatches.forEach(m => detected.add(m));
        }

        const nMatches = combinedOutput.match(/\b(\d{4})\b/g);
        if (nMatches) {
            nMatches.forEach(m => detected.add(m));
        }

        if (typeof result.exitCode === 'number' && result.exitCode !== 0) {
            detected.add(String(result.exitCode));
        }

        // Write flash output to the OutputChannel
        const outChannel = getBuildOutputChannel();
        outChannel.clear();
        outChannel.appendLine(`Flash command: ${cmd}`);
        outChannel.appendLine('');
        if (result.stdout) {
            outChannel.appendLine('--- stdout ---');
            outChannel.appendLine(result.stdout);
        }
        if (result.stderr) {
            outChannel.appendLine('--- stderr ---');
            outChannel.appendLine(result.stderr);
        }

        if (detected.size > 0) {
            const details = Array.from(detected).map(code => {
                const desc = exitCodeDescriptions[code] || exitCodeDescriptions['E' + code] || exitCodeDescriptions[String(Number(code))] || 'Unknown error';
                return `${code}: ${desc}`;
            }).join('; ');

            outChannel.appendLine('');
            outChannel.appendLine('--- Errors ---');
            Array.from(detected).forEach(code => {
                const desc = exitCodeDescriptions[code] || exitCodeDescriptions['E' + code] || exitCodeDescriptions[String(Number(code))] || 'Unknown error';
                outChannel.appendLine(`ERROR ${code}: ${desc}`);
            });
            outChannel.show(true);

            vscode.window.showErrorMessage(`Flash finished with error code(s): ${details}`);
        } else {
            if (result.success) {
                outChannel.appendLine('');
                outChannel.appendLine('Flash completed successfully.');
                outChannel.show(true);
                vscode.window.showInformationMessage('Flash completed successfully.');
            } else {
                outChannel.appendLine('');
                outChannel.appendLine('Flash failed. See output above for details.');
                outChannel.show(true);
                vscode.window.showErrorMessage(`Flash failed. See output for details.`);
            }
        }
    }
}

/**
 * Function to run the build again and grab the binary file name
 * @param fileUri absolute path to *.sln
 * @param cliBuildArguments CLI arguments passed to msbuild
 * @param unixMsBuildPath optional path to msbuild on Unix systems
 * @returns binary file name
 * @throws Error if the binary file name is not found in the build output
 * @throws Error if the MSBuild path is not found
 * @throws Error if the MSBuild command fails
 * @throws Error if the executable name is not found in the build output
 */
function executeMSBuildAndFindBinaryFile(fileUri: string, cliBuildArguments: string, unixMsBuildPath?: string): Promise<string> {
    return new Promise(async (resolve, reject) => {

        if (os.platform() === "win32") {

            // Command to find MSBuild
            const findMSBuildCmd = `"${process.env['ProgramFiles(x86)']}\\microsoft visual studio\\installer\\vswhere.exe" -products * -latest -prerelease -requires Microsoft.Component.MSBuild -find MSBuild\\**\\Bin\\amd64\\MSBuild.exe`;

            // First execution to find MSBuild path
            cp.exec(findMSBuildCmd, (error, stdout, stderr) => {
                if (error) {
                    vscode.window.showErrorMessage(`Error finding MSBuild: ${error}`);
                    reject(error);
                    return;
                }

                // Split the output by new lines to get an array of paths
                const paths = stdout.split(/\r?\n/);

                // Select the first non-empty path as the MSBuild path
                const msBuildPath = paths.find(p => p.trim() !== '');

                if (!msBuildPath) {
                    vscode.window.showErrorMessage('MSBuild path not found.');
                    reject(new Error('MSBuild path not found.'));
                    return;
                }

                // Construct MSBuild command using the found path
                const buildCmd = `"${msBuildPath}" "${fileUri}" ${cliBuildArguments}`;

                // Second execution to run MSBuild
                cp.exec(buildCmd, (error, stdout, stderr) => {
                    if (error) {
                        vscode.window.showErrorMessage(`Error rebuilding: ${error}`);
                        reject(error);
                        return;
                    }
                    // Parse stdout to find the binary file name
                    const binName = extractBinaryFileName(stdout);
                    if (binName) {
                        resolve(binName);
                    } else {
                        vscode.window.showErrorMessage('Executable name not found in build output.');
                        reject(new Error('Executable name not found in build output.'));
                    }
                });
            });
        } else {
            // For non-Windows platforms, use the provided msbuild path or try to find it
            const msbuildPath = unixMsBuildPath || findUnixMsBuild();
            
            if (!msbuildPath) {
                vscode.window.showErrorMessage('msbuild not found. Please install mono-complete from the Mono Project.');
                reject(new Error('msbuild not found.'));
                return;
            }
            
            const buildCmd = `"${msbuildPath}" "${fileUri}" ${cliBuildArguments}`;

            // Execute msbuild
            cp.exec(buildCmd, (error, stdout, stderr) => {
                if (error) {
                    vscode.window.showErrorMessage(`Error rebuilding: ${error.message}`);
                    reject(error);
                    return;
                }
                // Parse stdout to find the binary file name
                const binName = extractBinaryFileName(stdout);
                if (binName) {
                    resolve(binName);
                } else {
                    vscode.window.showErrorMessage('Executable name not found in build output.');
                    reject(new Error('Executable name not found in build output.'));
                }
            });
        }
    });
}

/**
 * Extracts the binary file name from MSBuild output
 * @param stdout The stdout from MSBuild
 * @returns The binary file name (.bin) or null if not found
 */
function extractBinaryFileName(stdout: string): string | null {
    const lines = stdout.split('\n');
    const exeLine = lines.find(line => line.trim().endsWith('.exe'));
    if (exeLine) {
        const exeName = path.basename(exeLine.trim());
        // Rename the executable from .exe to .bin
        return exeName.replace('.exe', '.bin');
    }
    return null;
}

/**
 * Executes the build on Windows and waits for completion
 * @param fileUri absolute path to *.sln
 * @param cliBuildArguments CLI arguments passed to msbuild
 * @param nugetPath path to nuget.exe
 * @returns object with success, stdout and stderr
 */
function executeBuildWindows(fileUri: string, cliBuildArguments: string, nugetPath: string): Promise<{ success: boolean; stdout?: string; stderr?: string; exitCode?: number | null }> {
    return new Promise((resolve) => {
        // Command to find MSBuild using vswhere
        const vswhereExe = path.join(process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)', 
            'microsoft visual studio', 'installer', 'vswhere.exe');
        
        if (!fs.existsSync(vswhereExe)) {
            console.error(`vswhere.exe not found at: ${vswhereExe}`);
            vscode.window.showErrorMessage('Visual Studio installation not found. Please install Visual Studio with MSBuild.');
            resolve({ success: false, stdout: '', stderr: `vswhere.exe not found at: ${vswhereExe}`, exitCode: null });
            return;
        }

        const findMSBuildCmd = `"${vswhereExe}" -products * -latest -prerelease -requires Microsoft.Component.MSBuild -find MSBuild\\**\\Bin\\amd64\\MSBuild.exe`;

        // First execution to find MSBuild path
            cp.exec(findMSBuildCmd, { shell: 'cmd.exe' }, (error, stdout, stderr) => {
            if (error) {
                console.error(`Error finding MSBuild: ${error.message}`);
                console.error(`stderr: ${stderr}`);
                vscode.window.showErrorMessage(`Error finding MSBuild: ${error.message}`);
                resolve({ success: false, stdout: stdout, stderr: stderr || error.message, exitCode: (error as any).code || null });
                return;
            }

            // Split the output by new lines to get an array of paths
            const paths = stdout.split(/\r?\n/);

            // Select the first non-empty path as the MSBuild path
            const msBuildPath = paths.find(p => p.trim() !== '');

            if (!msBuildPath) {
                console.error('MSBuild path not found in vswhere output.');
                vscode.window.showErrorMessage('MSBuild not found. Please install Visual Studio with .NET desktop development workload.');
                resolve({ success: false, stdout: '', stderr: 'MSBuild path not found in vswhere output.', exitCode: null });
                return;
            }

            console.log(`Found MSBuild at: ${msBuildPath}`);

            // First run nuget restore
            const restoreCmd = `"${nugetPath}" restore "${fileUri}"`;
            console.log(`Running nuget restore: ${restoreCmd}`);
            
            cp.exec(restoreCmd, { maxBuffer: 10 * 1024 * 1024, shell: 'cmd.exe' }, (error, stdout, stderr) => {
                if (error) {
                    console.error(`Error restoring packages: ${error.message}`);
                    // Continue anyway, packages might already be restored
                }

                // Construct MSBuild command using the found path
                const buildCmd = `"${msBuildPath.trim()}" "${fileUri}" ${cliBuildArguments}`;
                console.log(`Running MSBuild: ${buildCmd}`);

                // Execute MSBuild
                cp.exec(buildCmd, { maxBuffer: 10 * 1024 * 1024, shell: 'cmd.exe' }, (error, stdout, stderr) => {
                    const exitCode = (error && (error as any).code && typeof (error as any).code === 'number') ? (error as any).code : (error ? null : 0);

                    if (error) {
                        console.error(`Build error: ${error.message}`);
                        console.error(`Build stdout: ${stdout}`);
                        console.error(`Build stderr: ${stderr}`);
                        // don't return yet; we'll inspect output for failure
                    }

                    // Detect build failures by looking for MSBuild error lines (e.g. ": error CS1003:")
                    const msbuildErrorRegex = /:\s*error\s+[A-Z0-9]+:/i;
                    const genericErrorRegex = /:\s*error\s/i;
                    const buildFailed = error || (stdout && (msbuildErrorRegex.test(stdout) || genericErrorRegex.test(stdout))) || (stderr && (msbuildErrorRegex.test(stderr) || genericErrorRegex.test(stderr)));

                    if (buildFailed) {
                        console.error('Build explicitly failed.');

                        // Write detailed output and detected error lines to the OutputChannel
                        try {
                            const outChannel = getBuildOutputChannel();
                            outChannel.clear();
                            outChannel.appendLine(`MSBuild command: ${buildCmd}`);
                            if (stdout) {
                                outChannel.appendLine('--- stdout ---');
                                outChannel.appendLine(stdout);
                            }
                            if (stderr) {
                                outChannel.appendLine('--- stderr ---');
                                outChannel.appendLine(stderr);
                            }

                            const errorLineRegex = /:\s*error\s.*?:/i;
                            const errorLines: string[] = [];
                            if (stdout) {
                                stdout.split(/\r?\n/).forEach(l => { if (errorLineRegex.test(l)) errorLines.push(l); });
                            }
                            if (stderr) {
                                stderr.split(/\r?\n/).forEach(l => { if (errorLineRegex.test(l)) errorLines.push(l); });
                            }

                            if (errorLines.length > 0) {
                                outChannel.appendLine('--- Errors ---');
                                errorLines.forEach(l => outChannel.appendLine('ERROR: ' + l.trim()));
                            }

                            outChannel.show(true);
                        } catch (e) {
                            console.error('Failed writing to OutputChannel', e);
                        }

                        resolve({ success: false, stdout: stdout, stderr: stderr, exitCode: exitCode });
                        return;
                    }

                    // If we got here without explicit failure, consider it a success
                    console.log('Build completed.');
                    resolve({ success: true, stdout: stdout, stderr: stderr, exitCode: exitCode });
                });
            });
        });
    });
}

/**
 * Executes the build on Unix (macOS/Linux) and waits for completion
 * @param fileUri absolute path to *.sln
 * @param cliBuildArguments CLI arguments passed to msbuild
 * @param msbuildPath path to msbuild
 * @param nugetPath path to nuget
 * @returns true if build succeeded, false otherwise
 */
function executeBuildUnix(fileUri: string, cliBuildArguments: string, msbuildPath: string, nugetPath: string): Promise<{ success: boolean; stdout?: string; stderr?: string; exitCode?: number | null }> {
    return new Promise((resolve) => {
        // First run nuget restore
        const restoreCmd = `"${nugetPath}" restore "${fileUri}"`;
        cp.exec(restoreCmd, { maxBuffer: 10 * 1024 * 1024 }, (error, stdout, stderr) => {
            if (error) {
                console.error(`Error restoring packages: ${error}`);
                // Continue anyway, packages might already be restored
            }

            // Construct msbuild command
            const buildCmd = `"${msbuildPath}" "${fileUri}" ${cliBuildArguments}`;

            // Execute msbuild
            cp.exec(buildCmd, { maxBuffer: 10 * 1024 * 1024 }, (error, stdout, stderr) => {
                const exitCode = (error && (error as any).code && typeof (error as any).code === 'number') ? (error as any).code : (error ? null : 0);

                if (error) {
                    console.error(`Build error: ${error.message}`);
                    console.error(`Build stderr: ${stderr}`);
                    // don't return yet; we'll inspect output
                }

                // Detect build failures by looking for MSBuild error lines (e.g. ": error CS1003:")
                const msbuildErrorRegex = /:\s*error\s+[A-Z0-9]+:/i;
                const genericErrorRegex = /:\s*error\s/i;
                const buildFailed = error || (stdout && (msbuildErrorRegex.test(stdout) || genericErrorRegex.test(stdout))) || (stderr && (msbuildErrorRegex.test(stderr) || genericErrorRegex.test(stderr)));

                if (buildFailed) {
                    console.error('Build failed.');

                    // Write detailed output and detected error lines to the OutputChannel
                    try {
                        const outChannel = getBuildOutputChannel();
                        outChannel.clear();
                        outChannel.appendLine(`MSBuild command: ${buildCmd}`);
                        if (stdout) {
                            outChannel.appendLine('--- stdout ---');
                            outChannel.appendLine(stdout);
                        }
                        if (stderr) {
                            outChannel.appendLine('--- stderr ---');
                            outChannel.appendLine(stderr);
                        }

                        const errorLineRegex = /:\s*error\s.*?:/i;
                        const errorLines: string[] = [];
                        if (stdout) {
                            stdout.split(/\r?\n/).forEach(l => { if (errorLineRegex.test(l)) errorLines.push(l); });
                        }
                        if (stderr) {
                            stderr.split(/\r?\n/).forEach(l => { if (errorLineRegex.test(l)) errorLines.push(l); });
                        }

                        if (errorLines.length > 0) {
                            outChannel.appendLine('--- Errors ---');
                            errorLines.forEach(l => outChannel.appendLine('ERROR: ' + l.trim()));
                        }

                        outChannel.show(true);
                    } catch (e) {
                        console.error('Failed writing to OutputChannel', e);
                    }

                    resolve({ success: false, stdout: stdout, stderr: stderr, exitCode: exitCode });
                    return;
                }

                resolve({ success: true, stdout: stdout, stderr: stderr, exitCode: exitCode });
            });
        });
    });
}

/**
 * Finds all deployable .bin files in the solution's project directories
 * Searches in bin/<configuration> folders of each project
 * @param solutionPath The path to the solution file
 * @param configuration The build configuration to search for (Debug|Release)
 * @returns Array of full paths to .bin files found
 */
async function findDeployableBinFiles(solutionPath: string, configuration: string = 'Debug'): Promise<string[]> {
    const solutionDir = path.dirname(solutionPath);
    const binFiles: string[] = [];
    
    console.log(`Searching for .bin files in solution directory: ${solutionDir}`);
    
    try {
        // Get all subdirectories (project folders)
        const entries = fs.readdirSync(solutionDir, { withFileTypes: true });
        
        for (const entry of entries) {
            if (entry.isDirectory()) {
                // Check bin/<configuration> folder
                const configDir = path.join(solutionDir, entry.name, 'bin', configuration);

                if (fs.existsSync(configDir)) {
                    const files = fs.readdirSync(configDir);
                    for (const file of files) {
                        const lower = file.toLowerCase();
                        const fullPath = path.join(configDir, file);

                        // If it's already a .bin, just add it
                        if (lower.endsWith('.bin')) {
                            binFiles.push(fullPath);
                            console.log(`Found .bin file: ${fullPath}`);
                        }                        
                    }
                }
            }
        }
        
        if (binFiles.length === 0) {
            console.log('No .bin files found in any project bin folders');
        } else {
            console.log(`Found ${binFiles.length} .bin file(s) total`);
        }
        
        return binFiles;
    } catch (error) {
        console.error(`Error searching for .bin files: ${error}`);
        return [];
    }
}

/**
 * Cleans (deletes) all .bin files in the solution's project directories for a specific configuration
 * This ensures that stale .bin files from previous builds don't get picked up during deployment
 * @param solutionPath The path to the solution file
 * @param configuration The build configuration to clean (Debug|Release)
 */
function cleanBinFiles(solutionPath: string, configuration: string = 'Debug'): void {
    const solutionDir = path.dirname(solutionPath);
    
    console.log(`Cleaning .bin files in solution directory: ${solutionDir} for configuration: ${configuration}`);
    
    try {
        // Get all subdirectories (project folders)
        const entries = fs.readdirSync(solutionDir, { withFileTypes: true });
        
        for (const entry of entries) {
            if (entry.isDirectory()) {
                // Check bin/<configuration> folder
                const configDir = path.join(solutionDir, entry.name, 'bin', configuration);

                if (fs.existsSync(configDir)) {
                    const files = fs.readdirSync(configDir);
                    for (const file of files) {
                        const lower = file.toLowerCase();
                        const fullPath = path.join(configDir, file);

                        // Delete .bin files
                        if (lower.endsWith('.bin')) {
                            try {
                                fs.unlinkSync(fullPath);
                                console.log(`Deleted .bin file: ${fullPath}`);
                            } catch (deleteError) {
                                console.error(`Failed to delete ${fullPath}: ${deleteError}`);
                            }
                        }                        
                    }
                }
            }
        }
        
        console.log(`Finished cleaning .bin files for configuration: ${configuration}`);
    } catch (error) {
        console.error(`Error cleaning .bin files: ${error}`);
    }
}
