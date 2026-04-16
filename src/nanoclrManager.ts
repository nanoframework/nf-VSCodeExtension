/*---------------------------------------------------------------------------------------------
 * Copyright (c) .NET Foundation and Contributors.
 * Portions Copyright (c) Microsoft Corporation.  All rights reserved.
 * See LICENSE file in the project root for full license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { Executor } from './executor';

/** Manages the nanoclr .NET global tool (install, update, version check). */
export class NanoCLRManager {
    private static _installed: boolean | undefined;
    private static _outputChannel: vscode.OutputChannel | null = null;

    private static getOutputChannel(): vscode.OutputChannel {
        if (!this._outputChannel) {
            this._outputChannel = vscode.window.createOutputChannel('nanoFramework Tests');
        }
        return this._outputChannel;
    }

    /** Returns the shared output channel for test logging. */
    public static get outputChannel(): vscode.OutputChannel {
        return this.getOutputChannel();
    }

    /**
     * Checks whether `nanoclr` is installed and available on the PATH.
     * Caches result after first successful check.
     */
    public static async isInstalled(): Promise<boolean> {
        if (this._installed !== undefined) {
            return this._installed;
        }

        const result = await Executor.runHidden('nanoclr --version');
        this._installed = result.success;
        return this._installed;
    }

    /**
     * Ensures nanoclr is installed and its runtime instance is up to date.
     * Returns true if nanoclr is ready to use.
     */
    public static async ensureReady(token?: vscode.CancellationToken): Promise<boolean> {
        const channel = this.getOutputChannel();

        if (token?.isCancellationRequested) { return false; }

        const installed = await this.isInstalled();
        if (!installed) {
            channel.appendLine('Installing nanoclr .NET tool...');
            const ok = await this.install();
            if (!ok) {
                channel.appendLine('ERROR: Failed to install nanoclr. Make sure .NET SDK is installed.');
                return false;
            }
        }

        if (token?.isCancellationRequested) { return false; }

        await this.updateInstance(token);
        return true;
    }

    /**
     * Installs or updates the nanoclr global tool.
     */
    public static async install(): Promise<boolean> {
        const channel = this.getOutputChannel();

        // Try update first (covers both install and update scenarios)
        const result = await Executor.runHidden('dotnet tool update -g nanoclr');
        if (result.success) {
            this._installed = true;
            const version = this.parseVersion(result.stdout || '');
            channel.appendLine(`nanoclr installed/updated${version ? ` (v${version})` : ''}`);
            return true;
        }

        channel.appendLine(`Failed to install nanoclr: ${result.stderr || result.stdout || 'unknown error'}`);
        this._installed = false;
        return false;
    }

    /**
     * Updates the nanoclr runtime instance to the latest version.
     */
    public static async updateInstance(token?: vscode.CancellationToken): Promise<void> {
        if (token?.isCancellationRequested) { return; }

        const channel = this.getOutputChannel();
        const config = vscode.workspace.getConfiguration('nanoFramework.test');
        const usePreview = config.get<boolean>('usePreviewClr', false);
        const clrVersion = config.get<string>('nanoclrVersion', '');

        let args = 'instance --update';
        if (usePreview) {
            args += ' --preview';
        } else if (clrVersion) {
            if (!/^\d+\.\d+\.\d+/.test(clrVersion)) {
                channel.appendLine(`Invalid nanoclrVersion "${clrVersion}" — expected semver (e.g. 1.2.3). Skipping version pin.`);
            } else {
                args += ` --version ${clrVersion}`;
            }
        }

        channel.appendLine(`Updating nanoCLR instance: nanoclr ${args}`);
        const result = await Executor.runHidden(`nanoclr ${args}`);
        if (result.success) {
            const version = this.parseInstanceVersion(result.stdout || '');
            channel.appendLine(`nanoCLR instance${version ? ` at v${version}` : ' updated'}`);
        } else {
            channel.appendLine(`Warning: Failed to update nanoCLR instance: ${result.stderr || result.stdout || ''}`);
        }
    }

    /** Reset cached installation state, e.g. after user changes settings. */
    public static resetCache(): void {
        this._installed = undefined;
    }

    /**
     * Parse version from `dotnet tool update` output.
     * Matches patterns like: version '1.0.208' or (version '1.0.208')
     */
    private static parseVersion(output: string): string | undefined {
        const match = output.match(/version\s+'?([\d.]+)'?/i);
        return match?.[1];
    }

    /**
     * Parse version from `nanoclr instance --update` output.
     * Matches patterns like: Updated to v1.8.1.102 or Already at v1.8.1.102
     */
    private static parseInstanceVersion(output: string): string | undefined {
        const match = output.match(/v([\d.]+)/);
        return match?.[1];
    }
}
