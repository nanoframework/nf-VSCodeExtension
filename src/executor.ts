/*---------------------------------------------------------------------------------------------
 * Copyright (c) .NET Foundation and Contributors.
 * Portions Copyright (c) Microsoft Corporation.  All rights reserved.
 * See LICENSE file in the project root for full license information.
 *--------------------------------------------------------------------------------------------*/

/* eslint-disable @typescript-eslint/no-explicit-any */
// Note: The 'any' type is used for error.code which may be number or undefined in Node.js callback APIs

import * as vscode from "vscode";
import * as cp from 'child_process';
import * as os from 'os';
import { convertWindowsPathsInCommand, toWslPathArgument } from './wsl';

export { convertWindowsPathsInCommand, toWslPathArgument } from './wsl';

/**
 * Result of executing a command
 */
export interface ExecutionResult {
    success: boolean;
    stdout?: string;
    stderr?: string;
    exitCode?: number | null;
}

export interface TerminalExecutionResult extends ExecutionResult {
    status: 'success' | 'failure' | 'indeterminate';
}

export type ExecutionKind = 'build' | 'deployment' | 'test' | 'debug' | 'tooling';

export class Executor {
    /**
     * Gets the current setting for showing terminal output
     * @returns true if commands should be shown in terminal, false for hidden execution
     */
    public static shouldShowTerminal(): boolean {
        const config = vscode.workspace.getConfiguration('nanoFramework');
        return config.get<boolean>('showTerminalOutput', true);
    }

    public static shouldUseWsl(kind: ExecutionKind = 'tooling'): boolean {
        return os.platform() === 'win32' &&
            vscode.workspace.getConfiguration('nanoFramework').get<boolean>(`wsl.${kind}`, false);
    }

    /**
     * Runs a command respecting the showTerminalOutput setting.
     * If showTerminalOutput is true (default), runs in visible terminal.
     * If false, runs hidden and returns a promise with the result.
     * @param command command to be executed
     * @param terminal type of terminal (defaults to dotnet)
     * @returns Promise that resolves when command completes (for hidden mode) or immediately (for terminal mode)
     */
    public static async runCommand(command: string, terminal: string = "dotnet", kind: ExecutionKind = 'tooling'): Promise<{ success: boolean; stdout?: string; stderr?: string }> {
        if (this.shouldShowTerminal()) {
            this.runInTerminal(command, terminal, kind);
            // Terminal mode doesn't wait for completion
            return { success: true };
        } else {
            return this.runHidden(command, kind);
        }
    }

    /**
     * Parses a command string into command and arguments array.
     * Handles quoted arguments properly to avoid shell injection.
     * @param commandString The full command string to parse
     * @returns Object with command and args array
     */
    private static parseCommand(commandString: string): { command: string; args: string[] } {
        const tokens: string[] = [];
        let current = '';
        let inQuote = false;
        let quoteChar = '';

        for (let i = 0; i < commandString.length; i++) {
            const char = commandString[i];

            if (!inQuote && (char === '"' || char === "'")) {
                inQuote = true;
                quoteChar = char;
            } else if (inQuote && char === quoteChar) {
                inQuote = false;
                quoteChar = '';
            } else if (!inQuote && char === ' ') {
                if (current.length > 0) {
                    tokens.push(current);
                    current = '';
                }
            } else {
                current += char;
            }
        }

        if (current.length > 0) {
            tokens.push(current);
        }

        const [command, ...args] = tokens;
        return { command: command || '', args };
    }

    /**
     * Runs a command hidden (not in terminal) and returns the result.
     * Uses spawn internally to avoid shell injection vulnerabilities.
     * @param command command to be executed
     * @returns Promise with success status and output
     */
    public static runHidden(command: string, kind: ExecutionKind = 'tooling'): Promise<{ success: boolean; stdout?: string; stderr?: string; exitCode?: number | null }> {
        return new Promise((resolve) => {
            console.log(`Executing hidden command: ${command}`);
            
            // Parse command string into command and arguments to avoid shell injection
            const parsed = this.parseCommand(command);
            
            if (!parsed.command) {
                resolve({
                    success: false,
                    stdout: '',
                    stderr: 'Empty command',
                    exitCode: null
                });
                return;
            }

            const env = this.buildEnvironment();
            
            const spawnOptions: cp.SpawnOptions = {
                env: env,
                stdio: ['pipe', 'pipe', 'pipe']
            };

            console.log(`Parsed command: ${parsed.command}, args: ${JSON.stringify(parsed.args)}`);
            
            const invocation = this.getInvocation(parsed.command, parsed.args, process.cwd(), kind);
            const child = cp.spawn(invocation.command, invocation.args, spawnOptions);

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
                console.error(`Hidden command error: ${error.message}`);
                resolve({
                    success: false,
                    stdout: stdout,
                    stderr: stderr || error.message,
                    exitCode: null
                });
            });

            child.on('close', (code) => {
                const exitCode = code;
                const success = code === 0;

                if (!success) {
                    console.error(`Hidden command failed with exit code: ${code}`);
                    console.error(`stderr: ${stderr}`);
                    console.log(`stdout: ${stdout}`);
                } else {
                    console.log(`Hidden command completed successfully`);
                    console.log(`stdout: ${stdout}`);
                    if (stderr) {
                        console.log(`stderr: ${stderr}`);
                    }
                }

                resolve({
                    success: success,
                    stdout: stdout,
                    stderr: stderr,
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
    public static runInTerminal(command: string, terminal: string = "dotnet", kind: ExecutionKind = 'tooling'): void {
        const useWsl = this.shouldUseWsl(kind);
        const terminalId = useWsl ? `${terminal}-${kind}-wsl` : terminal;
        if (this.terminals[terminalId] === undefined ) {
            this.terminals[terminalId] = useWsl
                ? vscode.window.createTerminal({ name: `${terminal} ${kind} (WSL)`, shellPath: 'wsl.exe' })
                : vscode.window.createTerminal(terminal);
        }
        this.terminals[terminalId].show();
        this.terminals[terminalId].sendText(useWsl ? this.getWslShellCommand(command, process.cwd()) : command);
    }

    /**
     * Runs a command in a visible terminal and waits for its exit code.
     */
    public static async runInTerminalAndWait(command: string, terminal: string = "dotnet", kind: ExecutionKind = 'tooling'): Promise<TerminalExecutionResult> {
        const useWsl = this.shouldUseWsl(kind);
        const terminalId = useWsl ? `${terminal}-${kind}-wsl` : terminal;
        if (this.terminals[terminalId] === undefined) {
            this.terminals[terminalId] = useWsl
                ? vscode.window.createTerminal({ name: `${terminal} ${kind} (WSL)`, shellPath: 'wsl.exe' })
                : vscode.window.createTerminal(terminal);
        }

        const targetTerminal = this.terminals[terminalId];
        targetTerminal.show();

        const shellIntegration = targetTerminal.shellIntegration || await new Promise<vscode.TerminalShellIntegration | undefined>((resolve) => {
            const timeout = setTimeout(() => {
                subscription.dispose();
                resolve(undefined);
            }, 3000);
            const subscription = vscode.window.onDidChangeTerminalShellIntegration(event => {
                if (event.terminal === targetTerminal) {
                    clearTimeout(timeout);
                    subscription.dispose();
                    resolve(event.shellIntegration);
                }
            });
        });

        if (!shellIntegration) {
            const result = await this.runHidden(command, kind);
            return { ...result, status: result.success ? 'success' : 'failure' };
        }

        let execution: vscode.TerminalShellExecution;
        try {
            execution = shellIntegration.executeCommand(
                useWsl ? this.getWslShellCommand(command, process.cwd()) : command);
        } catch {
            const result = await this.runHidden(command, kind);
            return { ...result, status: result.success ? 'success' : 'failure' };
        }

        return new Promise((resolve) => {
            let finished = false;
            const finish = (result: TerminalExecutionResult) => {
                if (finished) {
                    return;
                }
                finished = true;
                executionSubscription.dispose();
                closeSubscription.dispose();
                clearTimeout(timeout);
                resolve(result);
            };
            const executionSubscription = vscode.window.onDidEndTerminalShellExecution(event => {
                if (event.execution === execution) {
                    if (event.exitCode === undefined) {
                        finish({
                            success: false,
                            status: 'indeterminate',
                            stderr: 'VS Code could not determine the terminal command exit status.',
                            exitCode: null
                        });
                        return;
                    }
                    finish({
                        success: event.exitCode === 0,
                        status: event.exitCode === 0 ? 'success' : 'failure',
                        exitCode: event.exitCode
                    });
                }
            });
            const closeSubscription = vscode.window.onDidCloseTerminal(closedTerminal => {
                if (closedTerminal === targetTerminal) {
                    finish({
                        success: false,
                        status: 'indeterminate',
                        stderr: 'The terminal closed before the command status was reported.',
                        exitCode: null
                    });
                }
            });
            const timeout = setTimeout(() => finish({
                success: false,
                status: 'indeterminate',
                stderr: 'Timed out waiting for the terminal command status.',
                exitCode: null
            }), 10 * 60 * 1000);
        });
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
        options?: cp.SpawnOptions,
        kind: ExecutionKind = 'tooling'
    ): Promise<ExecutionResult> {
        return new Promise((resolve) => {
            console.log(`Executing spawn command: ${command} ${args.join(' ')}`);

            const env = this.buildEnvironment();
            const spawnOptions: cp.SpawnOptions = {
                env: env,
                stdio: ['pipe', 'pipe', 'pipe'],
                ...options
            };

            const child = this.spawnProcess(command, args, spawnOptions, kind);

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

    public static spawnProcess(command: string, args: string[], options?: cp.SpawnOptions, kind: ExecutionKind = 'tooling'): cp.ChildProcess {
        const spawnOptions = { ...options };
        const invocation = this.getInvocation(command, args, spawnOptions.cwd?.toString() || process.cwd(), kind);
        if (this.shouldUseWsl(kind)) {
            delete spawnOptions.cwd;
        }
        return cp.spawn(invocation.command, invocation.args, spawnOptions);
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
        options?: cp.ExecFileOptions,
        kind: ExecutionKind = 'tooling'
    ): Promise<ExecutionResult> {
        return new Promise((resolve) => {
            console.log(`Executing file: ${file} ${args.join(' ')}`);

            const env = this.buildEnvironment();
            const execOptions: cp.ExecFileOptions = {
                maxBuffer: 10 * 1024 * 1024,  // 10MB buffer for large outputs
                env: env,
                ...options
            };

            const invocation = this.getInvocation(file, args, options?.cwd?.toString() || process.cwd(), kind);
            if (this.shouldUseWsl(kind)) {
                delete execOptions.cwd;
            }
            cp.execFile(invocation.command, invocation.args, execOptions, (error, stdout, stderr) => {
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
        stopOnError: boolean = true,
        kind: ExecutionKind = 'tooling'
    ): Promise<ExecutionResult> {
        let combinedStdout = '';
        let combinedStderr = '';
        let lastExitCode: number | null = 0;

        for (const cmd of commands) {
            const result = await this.runSpawn(cmd.command, cmd.args, cmd.cwd ? { cwd: cmd.cwd } : undefined, kind);
            
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

    private static getInvocation(command: string, args: string[], cwd: string, kind: ExecutionKind): { command: string; args: string[] } {
        if (!this.shouldUseWsl(kind)) {
            return { command, args };
        }

        const commandLine = [command, ...args]
            .map(value => this.shellQuote(toWslPathArgument(value)))
            .join(' ');
        return {
            command: 'wsl.exe',
            args: ['--', 'bash', '-lc', this.getWslShellCommand(commandLine, cwd)]
        };
    }

    private static getWslShellCommand(command: string, cwd: string): string {
        const convertedCommand = convertWindowsPathsInCommand(command);
        const wslCwd = toWslPathArgument(cwd);
        return `cd ${this.shellQuote(wslCwd)} && export PATH="$HOME/.dotnet/tools:$PATH" && ${convertedCommand}`;
    }

    private static shellQuote(value: string): string {
        return `'${value.replace(/'/g, `'"'"'`)}'`;
    }

    private static terminals: { [id: string]: vscode.Terminal } = {};
}