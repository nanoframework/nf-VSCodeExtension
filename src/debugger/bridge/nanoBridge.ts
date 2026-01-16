/*---------------------------------------------------------------------------------------------
 *  Copyright (c) .NET Foundation and Contributors. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { EventEmitter } from 'events';
import { ChildProcess, spawn } from 'child_process';
import * as path from 'path';
import {
    INanoThread,
    INanoStackTrace,
    INanoStackFrame,
    INanoVariable,
    INanoEvalResult,
    INanoModule,
    INanoExceptionInfo,
    StoppedReason
} from '../nanoRuntime';
import { DebugProtocol } from '@vscode/debugprotocol';

/**
 * Message types for bridge communication
 */
interface BridgeMessage {
    command: string;
    id?: number;
    args?: any;
}

interface BridgeResponse {
    id: number;
    success: boolean;
    data?: any;
    error?: string;
}

/**
 * NanoBridge
 * 
 * This class manages communication with the nf-debugger .NET bridge process.
 * It sends commands and receives responses/events via JSON-RPC over stdin/stdout.
 */
export class NanoBridge extends EventEmitter {

    private _process: ChildProcess | null = null;
    private _pendingRequests = new Map<number, { resolve: (value: any) => void; reject: (error: any) => void }>();
    private _requestId = 1;
    private _verbose = false;
    private _buffer = '';

    /**
     * Initialize the bridge
     */
    public async initialize(device?: string, verbose?: boolean): Promise<boolean> {
        this._verbose = verbose || false;

        try {
            // Find the bridge executable path
            const bridgePath = this.getBridgePath();
            
            this.log(`Starting bridge process: ${bridgePath}`);

            // Start the bridge process
            // On Windows, run the .exe directly; on other platforms, use dotnet to run the DLL
            const isWindows = process.platform === 'win32';
            if (isWindows) {
                this._process = spawn(bridgePath, [], {
                    stdio: ['pipe', 'pipe', 'pipe']
                });
            } else {
                this._process = spawn('dotnet', [bridgePath], {
                    stdio: ['pipe', 'pipe', 'pipe']
                });
            }

            if (!this._process || !this._process.stdout || !this._process.stdin) {
                this.log('Failed to start bridge process');
                return false;
            }

            // Handle stdout (responses and events)
            this._process.stdout.on('data', (data: Buffer) => {
                this.handleData(data.toString());
            });

            // Handle stderr (logging)
            this._process.stderr?.on('data', (data: Buffer) => {
                this.log(`Bridge stderr: ${data.toString()}`);
            });

            // Handle process exit
            this._process.on('exit', (code) => {
                this.log(`Bridge process exited with code ${code}`);
                this.emit('terminated');
            });

            // Wait for initialization confirmation
            const response = await this.sendCommand('initialize', { device, verbose });
            return response?.success || false;

        } catch (error) {
            this.log(`Initialize failed: ${error}`);
            return false;
        }
    }

    /**
     * Connect to device
     */
    public async connect(): Promise<boolean> {
        const response = await this.sendCommand('connect', {});
        return response?.success || false;
    }

    /**
     * Deploy application
     */
    public async deploy(program: string): Promise<boolean> {
        const response = await this.sendCommand('deploy', { program });
        return response?.success || false;
    }

    /**
     * Start execution
     */
    public async startExecution(stopOnEntry?: boolean): Promise<boolean> {
        const response = await this.sendCommand('startExecution', { stopOnEntry });
        return response?.success || false;
    }

    /**
     * Attach to running CLR
     */
    public async attach(): Promise<boolean> {
        const response = await this.sendCommand('attach', {});
        return response?.success || false;
    }

    /**
     * Set a breakpoint
     */
    public async setBreakpoint(path: string, line: number, id: number): Promise<boolean> {
        const response = await this.sendCommand('setBreakpoint', { path, line, id });
        return response?.data?.verified || false;
    }

    /**
     * Set a function breakpoint
     */
    public async setFunctionBreakpoint(functionName: string, id: number, condition?: string): Promise<boolean> {
        const response = await this.sendCommand('setFunctionBreakpoint', { functionName, id, condition });
        return response?.data?.verified || false;
    }

    /**
     * Clear a breakpoint
     */
    public async clearBreakpoint(id: number): Promise<void> {
        await this.sendCommand('clearBreakpoint', { id });
    }

    /**
     * Set exception handling options
     */
    public async setExceptionHandling(breakOnAll: boolean, breakOnUncaught: boolean): Promise<void> {
        await this.sendCommand('setExceptionHandling', { breakOnAll, breakOnUncaught });
    }

    /**
     * Continue execution
     */
    public async continue(): Promise<void> {
        await this.sendCommand('continue', {});
    }

    /**
     * Step over
     */
    public async stepOver(): Promise<void> {
        await this.sendCommand('stepOver', {});
    }

    /**
     * Step into
     */
    public async stepIn(): Promise<void> {
        await this.sendCommand('stepIn', {});
    }

    /**
     * Step out
     */
    public async stepOut(): Promise<void> {
        await this.sendCommand('stepOut', {});
    }

    /**
     * Pause execution
     */
    public async pause(): Promise<void> {
        await this.sendCommand('pause', {});
    }

    /**
     * Get threads
     */
    public async getThreads(): Promise<INanoThread[]> {
        const response = await this.sendCommand('getThreads', {});
        return response?.data?.threads || [];
    }

    /**
     * Get stack trace
     */
    public async getStackTrace(threadId: number, startFrame: number, maxLevels: number): Promise<INanoStackTrace> {
        const response = await this.sendCommand('getStackTrace', { threadId, startFrame, maxLevels });
        return response?.data || { frames: [], totalFrames: 0 };
    }

    /**
     * Get variables
     */
    public async getVariables(scope: string): Promise<INanoVariable[]> {
        const response = await this.sendCommand('getVariables', { scope });
        return response?.data?.variables || [];
    }

    /**
     * Evaluate expression
     */
    public async evaluate(expression: string, frameId?: number): Promise<INanoEvalResult | null> {
        const response = await this.sendCommand('evaluate', { expression, frameId });
        return response?.data || null;
    }

    /**
     * Set variable value
     */
    public async setVariable(scope: string, name: string, value: string): Promise<INanoEvalResult> {
        const response = await this.sendCommand('setVariable', { scope, name, value });
        return response?.data || { value: value, type: 'unknown', hasChildren: false, reference: '' };
    }

    /**
     * Get exception info
     */
    public async getExceptionInfo(threadId: number): Promise<INanoExceptionInfo> {
        const response = await this.sendCommand('getExceptionInfo', { threadId });
        return response?.data || {
            exceptionId: 'unknown',
            description: 'Unknown exception',
            breakMode: 'unhandled' as DebugProtocol.ExceptionBreakMode
        };
    }

    /**
     * Get loaded modules
     */
    public async getModules(): Promise<INanoModule[]> {
        const response = await this.sendCommand('getModules', {});
        return response?.data?.modules || [];
    }

    /**
     * Terminate debugging
     */
    public async terminate(): Promise<void> {
        await this.sendCommand('terminate', {});
        this.shutdown();
    }

    /**
     * Disconnect from device
     */
    public async disconnect(terminateDebuggee: boolean): Promise<void> {
        await this.sendCommand('disconnect', { terminateDebuggee });
        this.shutdown();
    }

    /**
     * Shutdown the bridge process
     */
    private shutdown(): void {
        if (this._process) {
            this._process.kill();
            this._process = null;
        }
    }

    /**
     * Get the path to the bridge executable
     */
    private getBridgePath(): string {
        // The bridge is expected to be in the extension's bin directory
        // On Windows, it's an .exe; on other platforms, it's a DLL that needs to be run with dotnet
        const isWindows = process.platform === 'win32';
        const fileName = isWindows ? 'nanoFramework.Tools.DebugBridge.exe' : 'nanoFramework.Tools.DebugBridge.dll';
        return path.join(__dirname, '..', '..', '..', 'bin', 'nanoDebugBridge', fileName);
    }

    /**
     * Send a command to the bridge
     */
    private async sendCommand(command: string, args: any): Promise<BridgeResponse | null> {
        return new Promise((resolve, reject) => {
            if (!this._process || !this._process.stdin) {
                resolve(null);
                return;
            }

            const id = this._requestId++;
            const message: BridgeMessage = {
                command: command,
                id: id,
                args: args
            };

            this._pendingRequests.set(id, { resolve, reject });

            const json = JSON.stringify(message) + '\n';
            this.log(`Sending: ${json.trim()}`);
            this._process.stdin.write(json);

            // Timeout after 30 seconds
            setTimeout(() => {
                if (this._pendingRequests.has(id)) {
                    this._pendingRequests.delete(id);
                    resolve(null);
                }
            }, 30000);
        });
    }

    /**
     * Handle data from the bridge
     */
    private handleData(data: string): void {
        this._buffer += data;

        // Process complete lines
        let newlineIndex: number;
        while ((newlineIndex = this._buffer.indexOf('\n')) !== -1) {
            const line = this._buffer.substring(0, newlineIndex).trim();
            this._buffer = this._buffer.substring(newlineIndex + 1);

            if (line) {
                this.processMessage(line);
            }
        }
    }

    /**
     * Process a message from the bridge
     */
    private processMessage(json: string): void {
        try {
            this.log(`Received: ${json}`);
            const message = JSON.parse(json);

            // Check if this is a response to a pending request
            if (message.id !== undefined && this._pendingRequests.has(message.id)) {
                const pending = this._pendingRequests.get(message.id)!;
                this._pendingRequests.delete(message.id);
                pending.resolve(message);
                return;
            }

            // Handle events
            switch (message.type) {
                case 'stopped':
                    this.emit('stopped', message.payload.reason, message.payload.threadId, message.payload.exception);
                    break;
                case 'breakpointValidated':
                    this.emit('breakpointValidated', message.payload);
                    break;
                case 'output':
                    this.emit('output', message.payload.text, message.payload.category || 'console');
                    break;
                case 'terminated':
                    this.emit('terminated');
                    break;
            }
        } catch (error) {
            this.log(`Failed to parse message: ${json}`);
        }
    }

    /**
     * Log a message
     */
    private log(message: string): void {
        if (this._verbose) {
            console.log(`[NanoBridge] ${message}`);
        }
    }
}
