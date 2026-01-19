/*---------------------------------------------------------------------------------------------
 * Copyright (c) .NET Foundation and Contributors.
 * Portions Copyright (c) Microsoft Corporation.  All rights reserved.
 * See LICENSE file in the project root for full license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from "vscode";
import * as cp from 'child_process';
import * as os from 'os';

/**
 * Result of executing a command
 */
export interface ExecutionResult {
    success: boolean;
    stdout?: string;
    stderr?: string;
    exitCode?: number | null;
}

export class Executor {
    /**
     * Gets the current setting for showing terminal output
     * @returns true if commands should be shown in terminal, false for hidden execution
     */
    public static shouldShowTerminal(): boolean {
        const config = vscode.workspace.getConfiguration('nanoFramework');
        return config.get<boolean>('showTerminalOutput', true);
    }

    /**
     * Runs a command respecting the showTerminalOutput setting.
     * If showTerminalOutput is true (default), runs in visible terminal.
     * If false, runs hidden and returns a promise with the result.
     * @param command command to be executed
     * @param terminal type of terminal (defaults to dotnet)
     * @returns Promise that resolves when command completes (for hidden mode) or immediately (for terminal mode)
     */
    public static async runCommand(command: string, terminal: string = "dotnet"): Promise<{ success: boolean; stdout?: string; stderr?: string }> {
        if (this.shouldShowTerminal()) {
            this.runInTerminal(command, terminal);
            // Terminal mode doesn't wait for completion
            return { success: true };
        } else {
            return this.runHidden(command);
        }
    }

    /**
     * Runs a command hidden (not in terminal) and returns the result
     * @param command command to be executed
     * @returns Promise with success status and output
     */
    public static runHidden(command: string): Promise<{ success: boolean; stdout?: string; stderr?: string; exitCode?: number | null }> {
        return new Promise((resolve) => {
            console.log(`Executing hidden command: ${command}`);
            
            // Build environment with properly expanded PATH
            const env = { ...process.env };
            
            // On non-Windows platforms, ensure ~/.dotnet/tools is in PATH (expanded)
            if (os.platform() !== 'win32') {
                const homeDir = os.homedir();
                const dotnetToolsPath = `${homeDir}/.dotnet/tools`;
                const currentPath = env.PATH || '';
                
                // Add dotnet tools path if not already present (with expanded home dir)
                if (!currentPath.includes(dotnetToolsPath)) {
                    env.PATH = `${dotnetToolsPath}:${currentPath}`;
                    console.log(`Added ${dotnetToolsPath} to PATH`);
                }
            }
            
            // Use cp.exec with shell option for proper command execution
            // This ensures PATH and environment variables are properly available
            const options: cp.ExecOptions = {
                maxBuffer: 10 * 1024 * 1024,  // 10MB buffer for large outputs
                env: env,  // Pass modified environment variables
                // Use cmd.exe on Windows for hidden commands to better match interactive terminal behavior
                // and improve resolution of CLI tools. Use /bin/bash on Unix-like systems.
                shell: os.platform() === 'win32' ? 'cmd.exe' : '/bin/bash'
            };
            
            cp.exec(command, options, (error, stdout, stderr) => {
                // Try to extract exit code from error if present
                const exitCode = (error && (error as any).code && typeof (error as any).code === 'number') ? (error as any).code : (error ? null : 0);
                
                // Convert stdout/stderr to strings (they may be Buffer in newer Node types)
                const stdoutStr = stdout?.toString() ?? '';
                const stderrStr = stderr?.toString() ?? '';

                if (error) {
                    console.error(`Hidden command error: ${error.message}`);
                    console.error(`stderr: ${stderrStr}`);
                    console.log(`stdout: ${stdoutStr}`);
                    resolve({
                        success: false,
                        stdout: stdoutStr,
                        stderr: stderrStr || error.message,
                        exitCode: exitCode
                    });
                    return;
                }

                console.log(`Hidden command completed successfully`);
                console.log(`stdout: ${stdoutStr}`);
                if (stderrStr) {
                    console.log(`stderr: ${stderrStr}`);
                }

                resolve({
                    success: true,
                    stdout: stdoutStr,
                    stderr: stderrStr,
                    exitCode: exitCode
                });
            });
        });
    }

    /**
     * Runs given command in VSCode Terminal
     * @param command command to be executed in terminal
     * @param terminal type of terminal (defaults to dotnet)
     */
    public static runInTerminal(command: string, terminal: string = "dotnet"): void {
        if (this.terminals[terminal] === undefined ) {
            this.terminals[terminal] = vscode.window.createTerminal(terminal);
        }
        this.terminals[terminal].show();
        this.terminals[terminal].sendText(command);
    }

    /**
     * Removes the terminal window from memory when window is closed
     * @param closedTerminal 
     */
    public static onDidCloseTerminal(closedTerminal: vscode.Terminal): void {
        delete this.terminals[closedTerminal.name];
    }

    /**
     * Builds the environment variables for command execution.
     * On non-Windows platforms, ensures ~/.dotnet/tools is in PATH.
     * @returns Modified environment variables
     */
    private static buildEnvironment(): NodeJS.ProcessEnv {
        const env = { ...process.env };

        // On non-Windows platforms, ensure ~/.dotnet/tools is in PATH (expanded)
        if (os.platform() !== 'win32') {
            const homeDir = os.homedir();
            const dotnetToolsPath = `${homeDir}/.dotnet/tools`;
            const currentPath = env.PATH || '';

            // Add dotnet tools path if not already present (with expanded home dir)
            if (!currentPath.includes(dotnetToolsPath)) {
                env.PATH = `${dotnetToolsPath}:${currentPath}`;
                console.log(`Added ${dotnetToolsPath} to PATH`);
            }
        }

        return env;
    }

    /**
     * Executes a command securely using spawn with separate arguments array.
     * This method avoids shell injection vulnerabilities by not using shell interpolation.
     * 
     * @param command The executable command (e.g., "dotnet", "nuget", "msbuild")
     * @param args Array of arguments to pass to the command
     * @param options Optional spawn options (cwd, env, etc.)
     * @returns Promise with execution result
     */
    public static runSpawn(
        command: string,
        args: string[],
        options?: cp.SpawnOptions
    ): Promise<ExecutionResult> {
        return new Promise((resolve) => {
            console.log(`Executing spawn command: ${command} ${args.join(' ')}`);

            const env = this.buildEnvironment();
            const spawnOptions: cp.SpawnOptions = {
                env: env,
                stdio: ['pipe', 'pipe', 'pipe'],
                ...options
            };

            const child = cp.spawn(command, args, spawnOptions);

            let stdout = '';
            let stderr = '';

            if (child.stdout) {
                child.stdout.on('data', (data: Buffer) => {
                    stdout += data.toString();
                });
            }

            if (child.stderr) {
                child.stderr.on('data', (data: Buffer) => {
                    stderr += data.toString();
                });
            }

            child.on('error', (error) => {
                console.error(`Spawn command error: ${error.message}`);
                resolve({
                    success: false,
                    stdout: stdout,
                    stderr: stderr || error.message,
                    exitCode: null
                });
            });

            child.on('close', (code) => {
                const success = code === 0;
                if (success) {
                    console.log(`Spawn command completed successfully`);
                } else {
                    console.error(`Spawn command failed with exit code: ${code}`);
                }
                console.log(`stdout: ${stdout}`);
                if (stderr) {
                    console.log(`stderr: ${stderr}`);
                }

                resolve({
                    success: success,
                    stdout: stdout,
                    stderr: stderr,
                    exitCode: code
                });
            });
        });
    }

    /**
     * Executes a file directly without shell interpretation.
     * This is the safest method for executing external programs.
     * 
     * @param file The path to the executable file
     * @param args Array of arguments to pass to the executable
     * @param options Optional exec file options
     * @returns Promise with execution result
     */
    public static runExecFile(
        file: string,
        args: string[],
        options?: cp.ExecFileOptions
    ): Promise<ExecutionResult> {
        return new Promise((resolve) => {
            console.log(`Executing file: ${file} ${args.join(' ')}`);

            const env = this.buildEnvironment();
            const execOptions: cp.ExecFileOptions = {
                maxBuffer: 10 * 1024 * 1024,  // 10MB buffer for large outputs
                env: env,
                ...options
            };

            cp.execFile(file, args, execOptions, (error, stdout, stderr) => {
                const exitCode = (error && (error as any).code && typeof (error as any).code === 'number') 
                    ? (error as any).code 
                    : (error ? null : 0);

                const stdoutStr = stdout?.toString() ?? '';
                const stderrStr = stderr?.toString() ?? '';

                if (error) {
                    console.error(`ExecFile command error: ${error.message}`);
                    console.error(`stderr: ${stderrStr}`);
                    console.log(`stdout: ${stdoutStr}`);
                    resolve({
                        success: false,
                        stdout: stdoutStr,
                        stderr: stderrStr || error.message,
                        exitCode: exitCode
                    });
                    return;
                }

                console.log(`ExecFile command completed successfully`);
                console.log(`stdout: ${stdoutStr}`);
                if (stderrStr) {
                    console.log(`stderr: ${stderrStr}`);
                }

                resolve({
                    success: true,
                    stdout: stdoutStr,
                    stderr: stderrStr,
                    exitCode: exitCode
                });
            });
        });
    }

    /**
     * Runs a command sequence securely using spawn for multiple commands.
     * Each command is executed separately without shell interpolation.
     * 
     * @param commands Array of command objects with command and args
     * @param stopOnError Whether to stop execution on first error (default: true)
     * @returns Promise with combined execution result
     */
    public static async runCommandSequence(
        commands: Array<{ command: string; args: string[]; cwd?: string }>,
        stopOnError: boolean = true
    ): Promise<ExecutionResult> {
        let combinedStdout = '';
        let combinedStderr = '';
        let lastExitCode: number | null = 0;

        for (const cmd of commands) {
            const result = await this.runSpawn(cmd.command, cmd.args, cmd.cwd ? { cwd: cmd.cwd } : undefined);
            
            combinedStdout += result.stdout || '';
            combinedStderr += result.stderr || '';
            lastExitCode = result.exitCode ?? null;

            if (!result.success && stopOnError) {
                return {
                    success: false,
                    stdout: combinedStdout,
                    stderr: combinedStderr,
                    exitCode: lastExitCode
                };
            }
        }

        return {
            success: lastExitCode === 0,
            stdout: combinedStdout,
            stderr: combinedStderr,
            exitCode: lastExitCode
        };
    }

    private static terminals: { [id: string]: vscode.Terminal } = {};
}