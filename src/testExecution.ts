/*---------------------------------------------------------------------------------------------
 * Copyright (c) .NET Foundation and Contributors.
 * Portions Copyright (c) Microsoft Corporation.  All rights reserved.
 * See LICENSE file in the project root for full license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import * as cp from 'child_process';
import * as os from 'os';
import { parseTestOutput, TestRunResult } from './testResultParser';
import type { NanoBridge } from './debugger/bridge/nanoBridge';

/**
 * Builds the NanoFrameworkProjectSystemPath from the extension utils folder.
 * Uses forward slashes so MSBuild property quoting works on Windows.
 */
function nfProjectSystemPath(extensionPath: string): string {
    const nfPath = path.join(extensionPath, 'nanoFramework', 'v1.0');
    return nfPath.replace(/\\/g, '/') + '/';
}

/**
 * Resolves the nuget restore target for a .nfproj file.
 * If a packages.config exists next to the project, returns it with -SolutionDirectory.
 * Otherwise looks for a parent .sln.
 * Falls back to the project file itself.
 */
function resolveRestoreTarget(projectPath: string): { target: string; solutionDir?: string } {
    const projectDir = path.dirname(projectPath);
    const parentDir = path.dirname(projectDir);

    const packagesConfig = path.join(projectDir, 'packages.config');
    if (fs.existsSync(packagesConfig)) {
        return { target: packagesConfig, solutionDir: parentDir };
    }

    try {
        const slnFiles = fs.readdirSync(parentDir).filter(f => f.endsWith('.sln') || f.endsWith('.slnx'));
        if (slnFiles.length > 0) {
            return { target: path.join(parentDir, slnFiles[0]) };
        }
    } catch {
        // ignore
    }

    return { target: projectPath };
}

/**
 * Locates MSBuild on Windows using vswhere.exe.
 * Tries the amd64 variant first, then falls back to the default (x86) path.
 */
async function findMSBuildWindows(): Promise<string | undefined> {
    const vsWherePath = path.join(
        process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)',
        'microsoft visual studio', 'installer', 'vswhere.exe'
    );

    for (const pattern of [
        'MSBuild\\**\\Bin\\amd64\\MSBuild.exe',
        'MSBuild\\**\\Bin\\MSBuild.exe'
    ]) {
        const found = await new Promise<string>((resolve) => {
            cp.execFile(vsWherePath, [
                '-products', '*', '-all', '-prerelease',
                '-requires', 'Microsoft.Component.MSBuild',
                '-find', pattern
            ], (_error, stdout) => {
                const first = (stdout || '').trim().split(/\r?\n/)[0] || '';
                resolve(first);
            });
        });
        if (found) { return found; }
    }

    return undefined;
}

/**
 * Runs a build-step process with an argument array (no shell interpolation).
 * Returns true when the process exits with code 0.
 */
function runBuildStep(
    command: string,
    args: string[],
    channel: vscode.OutputChannel,
    token?: vscode.CancellationToken
): Promise<boolean> {
    return new Promise<boolean>((resolve) => {
        channel.appendLine(`> ${command} ${args.join(' ')}`);

        const child = cp.execFile(command, args, {
            timeout: 120000,
            maxBuffer: 10 * 1024 * 1024
        }, (error, stdout, stderr) => {
            if (stdout) { channel.append(String(stdout)); }
            if (stderr) { channel.append(String(stderr)); }
            resolve(!error);
        });

        token?.onCancellationRequested(() => child.kill());
    });
}

/**
 * Builds a nanoFramework test project using MSBuild and returns whether the build succeeded.
 *
 * On Windows: uses vswhere to locate MSBuild, nuget.exe for restore, then MSBuild for build.
 * On Unix: uses msbuild and nuget from the system PATH (Mono installation).
 *
 * @param projectPath Full path to the .nfproj file
 * @param extensionPath Path to the extension's dist/utils folder (for NanoFrameworkProjectSystemPath)
 * @param configuration Build configuration (Debug/Release)
 * @param channel Output channel for logging
 * @param token Cancellation token
 * @returns true if build succeeded
 */
export async function buildTestProject(
    projectPath: string,
    extensionPath: string,
    configuration: string,
    channel: vscode.OutputChannel,
    token?: vscode.CancellationToken
): Promise<boolean> {
    channel.appendLine(`Building ${path.basename(projectPath)} (${configuration})...`);

    if (token?.isCancellationRequested) { return false; }

    const nfProjSysPath = nfProjectSystemPath(extensionPath);
    const restore = resolveRestoreTarget(projectPath);

    // Locate MSBuild
    let msbuildExe: string;
    if (os.platform() === 'win32') {
        const found = await findMSBuildWindows();
        if (!found) {
            channel.appendLine(
                'MSBuild not found. Install Visual Studio with .NET desktop development workload.'
            );
            return false;
        }
        msbuildExe = found;
    } else {
        msbuildExe = 'msbuild';
    }

    if (token?.isCancellationRequested) { return false; }

    // nuget restore (best-effort — nuget.exe may not be on PATH)
    const nugetArgs = ['restore', restore.target];
    if (restore.solutionDir) {
        nugetArgs.push('-SolutionDirectory', restore.solutionDir);
    }
    if (os.platform() === 'win32') {
        nugetArgs.push('-MSBuildPath', path.dirname(msbuildExe));
    }

    const nugetOk = await runBuildStep('nuget', nugetArgs, channel, token);
    if (!nugetOk) {
        channel.appendLine(
            'nuget restore failed (packages may already be restored). Continuing with build...'
        );
    }

    if (token?.isCancellationRequested) { return false; }

    // MSBuild arguments as an array — avoids shell interpolation (CodeQL js/shell-command-constructed-from-input)
    const msbuildArgs = [
        projectPath,
        `-p:Configuration=${configuration}`,
        `-p:NanoFrameworkProjectSystemPath=${nfProjSysPath}`,
        '-p:NFMDP_PE_Verbose=false',
        '-p:UseSharedCompilation=false',
        '-verbosity:minimal'
    ];

    const buildOk = await runBuildStep(msbuildExe, msbuildArgs, channel, token);
    if (!buildOk) {
        channel.appendLine(
            'Tip: You can also build using "nanoFramework: Build Project" command before running tests.'
        );
        return false;
    }

    channel.appendLine('Build succeeded.');
    return true;
}

/**
 * Finds all .pe files in the build output directory for a test project.
 */
export function findPeFiles(projectDir: string, configuration: string): string[] {
    const outputDir = path.join(projectDir, 'bin', configuration);
    if (!fs.existsSync(outputDir)) {
        return [];
    }

    try {
        return fs.readdirSync(outputDir)
            .filter(f => f.endsWith('.pe'))
            .map(f => path.join(outputDir, f));
    } catch {
        return [];
    }
}

/**
 * Runs tests on the nanoCLR emulator.
 *
 * @param projectDir Project directory
 * @param configuration Build configuration
 * @param channel Output channel
 * @param token Cancellation token
 * @returns Parsed test results
 */
export async function runTestsOnEmulator(
    projectDir: string,
    configuration: string,
    channel: vscode.OutputChannel,
    token?: vscode.CancellationToken
): Promise<TestRunResult> {
    const peFiles = findPeFiles(projectDir, configuration);
    if (peFiles.length === 0) {
        return {
            completed: false,
            results: [],
            rawOutput: '',
            runError: `No .pe files found in ${path.join(projectDir, 'bin', configuration)}. Build may have failed.`
        };
    }

    // Build nanoclr arguments
    const args = ['run', '--assemblies'];
    for (const pe of peFiles) {
        args.push(pe);
    }

    const config = vscode.workspace.getConfiguration('nanoFramework.test');
    const logging = config.get<string>('logging', 'None');
    if (logging !== 'None') {
        args.push('-v', 'diag');
    }

    const localClrPath = config.get<string>('pathToLocalCLRInstance', '');
    if (localClrPath) {
        args.push('--localinstance', localClrPath);
    }

    const timeout = config.get<number>('sessionTimeout', 120000);

    channel.appendLine(`Running tests: nanoclr ${args.join(' ')}`);

    return new Promise<TestRunResult>((resolve) => {
        if (token?.isCancellationRequested) {
            resolve({
                completed: false,
                results: [],
                rawOutput: '',
                runError: 'Cancelled'
            });
            return;
        }

        const child = cp.spawn('nanoclr', args, {
            env: { ...process.env },
            stdio: ['pipe', 'pipe', 'pipe']
        });

        let stdout = '';
        let stderr = '';

        child.stdout?.on('data', (data: Buffer) => {
            const text = data.toString();
            stdout += text;
            channel.append(text);
        });

        child.stderr?.on('data', (data: Buffer) => {
            const text = data.toString();
            stderr += text;
        });

        // Timeout handling
        const timer = setTimeout(() => {
            child.kill();
            channel.appendLine(`Test execution timed out after ${timeout}ms`);
        }, timeout);

        const onCancel = token?.onCancellationRequested(() => {
            child.kill();
            clearTimeout(timer);
        });

        child.on('error', (err) => {
            clearTimeout(timer);
            onCancel?.dispose();
            channel.appendLine(`nanoclr error: ${err.message}`);
            resolve({
                completed: false,
                results: [],
                rawOutput: stdout,
                runError: `Failed to launch nanoclr: ${err.message}. Is the nanoclr tool installed? Run 'dotnet tool install -g nanoclr'`
            });
        });

        child.on('close', (code) => {
            clearTimeout(timer);
            onCancel?.dispose();

            if (code !== 0 && code !== null) {
                channel.appendLine(`nanoclr exited with code ${code}`);
                if (stderr) {
                    channel.appendLine(stderr);
                }
            }

            const parsed = parseTestOutput(stdout);
            if (code !== 0 && code !== null && !parsed.runError) {
                parsed.runError = `nanoclr exited with code ${code}. ${stderr || ''}`.trim();
            }
            resolve(parsed);
        });
    });
}

// ---------------------------------------------------------------------------
// Hardware execution (via nanoDebugBridge)
// ---------------------------------------------------------------------------

/**
 * Runs tests on a real nanoFramework device by deploying assemblies via the
 * debug bridge and capturing device output.
 *
 * Flow:
 *  1. Spawn the debug bridge process and initialize it
 *  2. Connect to the device on the given serial port
 *  3. Deploy all .pe assemblies
 *  4. Start execution (reboot CLR)
 *  5. Capture output events and parse test results
 *
 * @param projectDir   Project directory
 * @param configuration Build configuration (Debug / Release)
 * @param device       Serial port or IP:port of the device
 * @param channel      Output channel for logging
 * @param token        Cancellation token
 * @returns Parsed test results
 */
export async function runTestsOnHardware(
    projectDir: string,
    configuration: string,
    device: string,
    channel: vscode.OutputChannel,
    token?: vscode.CancellationToken
): Promise<TestRunResult> {
    // Lazy-import NanoBridge to avoid circular dependency on the debugger module
    // at file-parse time.
    const { NanoBridge: nanoBridgeClass } = await import('./debugger/bridge/nanoBridge');

    const assembliesPath = path.join(projectDir, 'bin', configuration);
    const peFiles = findPeFiles(projectDir, configuration);
    if (peFiles.length === 0) {
        return {
            completed: false,
            results: [],
            rawOutput: '',
            runError: `No .pe files found in ${assembliesPath}. Build may have failed.`
        };
    }

    const config = vscode.workspace.getConfiguration('nanoFramework.test');
    const timeout = config.get<number>('sessionTimeout', 120000);
    const maxRetries = config.get<number>('hardwareRetries', 3);
    const logging = config.get<string>('logging', 'None');
    const verbosity = logging === 'None' ? 'none' : (logging === 'Verbose' ? 'debug' : 'information');

    channel.appendLine(`Deploying tests to device: ${device}`);
    channel.appendLine(`Assemblies path: ${assembliesPath}`);

    // We may retry the entire connect→deploy→run cycle if the device is flaky.
    let lastError = '';
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
        if (token?.isCancellationRequested) {
            return { completed: false, results: [], rawOutput: '', runError: 'Cancelled' };
        }

        const bridge = new nanoBridgeClass();
        let rawOutput = '';

        try {
            // Collect output from the device
            bridge.on('output', (text: string, _category: string) => {
                if (text) {
                    rawOutput += text;
                    channel.append(text);
                }
            });

            // 1. Initialize
            channel.appendLine(`[Attempt ${attempt}/${maxRetries}] Initializing bridge...`);
            const initOk = await bridge.initialize(device, false, verbosity);
            if (!initOk) {
                lastError = 'Failed to initialize debug bridge';
                channel.appendLine(lastError);
                await cleanupBridge(bridge);
                continue;
            }

            if (token?.isCancellationRequested) { await cleanupBridge(bridge); break; }

            // 2. Connect
            channel.appendLine('Connecting to device...');
            const connectOk = await bridge.connect();
            if (!connectOk) {
                lastError = `Could not connect to device on ${device}. Check the port and device state.`;
                channel.appendLine(lastError);
                await cleanupBridge(bridge);
                if (attempt < maxRetries) {
                    channel.appendLine('Retrying in 2 seconds...');
                    await delay(2000);
                }
                continue;
            }

            if (token?.isCancellationRequested) { await cleanupBridge(bridge); break; }

            // 3. Deploy
            channel.appendLine('Deploying assemblies...');
            const deployOk = await bridge.deploy(assembliesPath);
            if (!deployOk) {
                lastError = 'Deployment to device failed';
                channel.appendLine(lastError);
                await cleanupBridge(bridge);
                if (attempt < maxRetries) {
                    channel.appendLine('Retrying in 2 seconds...');
                    await delay(2000);
                }
                continue;
            }

            if (token?.isCancellationRequested) { await cleanupBridge(bridge); break; }

            // 4. Start execution (reboot CLR, no stop-on-entry)
            channel.appendLine('Starting test execution on device...');
            const startOk = await bridge.startExecution(false);
            if (!startOk) {
                lastError = 'Failed to start execution on device';
                channel.appendLine(lastError);
                await cleanupBridge(bridge);
                if (attempt < maxRetries) {
                    channel.appendLine('Retrying in 3 seconds...');
                    await delay(3000);
                }
                continue;
            }

            // 5. Wait for "Done." marker or timeout
            channel.appendLine('Waiting for test output...');
            const result = await waitForTestCompletion(rawOutput, bridge, timeout, token);
            await cleanupBridge(bridge);
            return result;

        } catch (err) {
            lastError = `Unexpected error: ${err}`;
            channel.appendLine(lastError);
            await cleanupBridge(bridge);
            if (attempt < maxRetries) {
                await delay(2000);
            }
        }
    }

    // All retries exhausted
    return {
        completed: false,
        results: [],
        rawOutput: '',
        runError: `Hardware test failed after ${maxRetries} attempts. Last error: ${lastError}`
    };
}

/**
 * Waits for device test output to contain the "Done." marker or time out.
 * The output events that accumulate in `rawOutputSoFar` need to be re-read
 * because more data arrives after this function is called, so we poll.
 */
function waitForTestCompletion(
    _initialOutput: string,
    bridge: NanoBridge,
    timeout: number,
    token?: vscode.CancellationToken
): Promise<TestRunResult> {
    return new Promise<TestRunResult>((resolve) => {
        let rawOutput = _initialOutput;
        let resolved = false;

        const finish = (result: TestRunResult) => {
            if (resolved) { return; }
            resolved = true;
            cancelSub?.dispose();
            clearTimeout(timer);
            resolve(result);
        };

        // Accumulate further output
        bridge.on('output', (text: string) => {
            if (text) {
                rawOutput += text;
                // Check if we've seen the "Done." marker
                if (rawOutput.includes('Done.')) {
                    finish(parseTestOutput(rawOutput));
                }
            }
        });

        // Also finish on bridge termination (device disconnected, etc.)
        bridge.on('terminated', () => {
            const result = parseTestOutput(rawOutput);
            if (!result.completed && !result.runError) {
                result.runError = 'Device disconnected before tests completed.';
            }
            finish(result);
        });

        const timer = setTimeout(() => {
            const result = parseTestOutput(rawOutput);
            if (!result.completed) {
                result.runError = `Test execution timed out after ${timeout}ms`;
            }
            finish(result);
        }, timeout);

        const cancelSub = token?.onCancellationRequested(() => {
            finish({
                completed: false,
                results: [],
                rawOutput,
                runError: 'Cancelled'
            });
        });

        // If output already has "Done." (accumulated before this listener was added)
        if (rawOutput.includes('Done.')) {
            finish(parseTestOutput(rawOutput));
        }
    });
}

/** Safely disconnect and terminate a bridge instance. */
async function cleanupBridge(bridge: NanoBridge): Promise<void> {
    try {
        await bridge.disconnect(false);
    } catch {
        // ignore disconnect errors
    }
}

function delay(ms: number): Promise<void> {
    return new Promise(r => setTimeout(r, ms));
}
