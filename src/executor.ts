/*---------------------------------------------------------------------------------------------
 * Copyright (c) .NET Foundation and Contributors.
 * Portions Copyright (c) Microsoft Corporation.  All rights reserved.
 * See LICENSE file in the project root for full license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from "vscode";
import * as cp from 'child_process';
import * as os from 'os';

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
            
            // Use cp.exec with shell option for proper command execution
            // This ensures PATH and environment variables are properly available
            const options: cp.ExecOptions = {
                maxBuffer: 10 * 1024 * 1024,  // 10MB buffer for large outputs
                env: process.env,  // Pass current environment variables
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

    private static terminals: { [id: string]: vscode.Terminal } = {};
}