/*---------------------------------------------------------------------------------------------
 * Copyright (c) .NET Foundation and Contributors.
 * Portions Copyright (c) Microsoft Corporation.  All rights reserved.
 * See LICENSE file in the project root for full license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from "vscode";

export class Executor {
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