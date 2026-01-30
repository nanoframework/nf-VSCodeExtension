/*---------------------------------------------------------------------------------------------
 *  Copyright (c) .NET Foundation and Contributors. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { EventEmitter } from 'events';
import { ChildProcess, spawn } from 'child_process';
import * as path from 'path';
import * as fs from 'fs';
import {
    INanoThread,
    INanoStackTrace,
    INanoVariable,
    INanoEvalResult,
    INanoModule,
    INanoExceptionInfo,
    INanoScope
} from '../nanoRuntime';
import { DebugProtocol } from '@vscode/debugprotocol';

/**
 * Message types for bridge communication
 */
interface BridgeMessage {
    command: string;
    id?: number;
    args?: unknown;
}

interface BridgeResponse {
    id: number;
    success: boolean;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
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
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    private _pendingRequests = new Map<number, { resolve: (value: any) => void; reject: (error: any) => void }>();
    private _requestId = 1;
    private _verbose = false;
    private _verbosity = 'information';
    private _buffer = '';
    private _device?: string;

    /**
     * Initialize the bridge
     * @param device The device to connect to
     * @param verbose Legacy verbose flag (deprecated, use verbosity instead)
     * @param verbosity Verbosity level: 'none', 'information', or 'debug'
     */
    public async initialize(device?: string, verbose?: boolean, verbosity?: string): Promise<boolean> {
        this._verbose = verbose || false;
        this._verbosity = verbosity || (verbose ? 'debug' : 'information');
        this._device = device;

        try {
            // Find the bridge executable path
            const bridgePath = this.getBridgePath();
            
            this.log(`Starting bridge process: ${bridgePath}`);
            
            // Check if the bridge executable exists
            if (!fs.existsSync(bridgePath)) {
                this.logError(`Bridge executable not found at: ${bridgePath}`);
                this.logError(`Please ensure the extension is properly built. Run 'npx gulp build-debug-bridge' to build the debug bridge.`);
                return false;
            }

            // Start the bridge process
            // Self-contained executable - run directly on all platforms
            this._process = spawn(bridgePath, [], {
                stdio: ['pipe', 'pipe', 'pipe']
            });
            
            // Handle spawn error (e.g., permission denied)
            this._process.on('error', (err) => {
                this.logError(`Failed to start bridge process: ${err.message}`);
                this.emit('terminated');
            });

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
            const response = await this.sendCommand('initialize', { device, verbose, verbosity: this._verbosity });
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
        const response = await this.sendCommand('connect', { device: this._device });
        return response?.success || false;
    }

    /**
     * Deploy application
     */
    public async deploy(assembliesPath: string): Promise<boolean> {
        const response = await this.sendCommand('deploy', { assembliesPath });
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
        const response = await this.sendCommand('setBreakpoint', { file: path, line, id });
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
        return response?.data?.threads || response?.data || [];
    }

    /**
     * Get stack trace
     */
    public async getStackTrace(threadId: number, startFrame: number, maxLevels: number): Promise<INanoStackTrace> {
        const response = await this.sendCommand('getStackTrace', { threadId, startFrame, levels: maxLevels });
        return response?.data || { frames: [], totalFrames: 0 };
    }

    /**
     * Get scopes for a frame
     */
    public async getScopes(frameId: number): Promise<INanoScope[]> {
        const response = await this.sendCommand('getScopes', { frameId });
        return response?.data || [];
    }

    /**
     * Get variables
     */
    public async getVariables(variablesReference: number): Promise<INanoVariable[]> {
        const response = await this.sendCommand('getVariables', { variablesReference });
        return response?.data?.variables || response?.data || [];
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
    public async setVariable(variablesReference: number, name: string, value: string): Promise<INanoEvalResult> {
        const response = await this.sendCommand('setVariable', { variablesReference, name, value });
        return response?.data || { value: value, type: 'unknown', hasChildren: false, variablesReference: 0 };
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
     * Load symbols from a path (directory or .pdbx file)
     */
    public async loadSymbols(symbolPath: string, recursive: boolean = true): Promise<number> {
        const response = await this.sendCommand('loadSymbols', { path: symbolPath, recursive });
        return response?.data?.symbolsLoaded || 0;
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
        // Platform-specific self-contained executables
        const platform = process.platform;
        const arch = process.arch;
        
        let platformFolder: string;
        let fileName: string;
        
        if (platform === 'win32') {
            platformFolder = arch === 'arm64' ? 'win32-arm64' : 'win32-x64';
            fileName = 'nanoFramework.Tools.DebugBridge.exe';
        } else if (platform === 'darwin') {
            platformFolder = arch === 'arm64' ? 'darwin-arm64' : 'darwin-x64';
            fileName = 'nanoFramework.Tools.DebugBridge';
        } else {
            // Linux and others default to linux-x64
            platformFolder = 'linux-x64';
            fileName = 'nanoFramework.Tools.DebugBridge';
        }
        
        return path.join(__dirname, '..', '..', '..', 'bin', 'nanoDebugBridge', platformFolder, fileName);
    }

    /**
     * Send a command to the bridge
     */
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
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

            // Handle events (bridge sends "event" and "body" properties)
            const eventType = message.event || message.type;
            const eventBody = message.body || message.payload;
            
            if (eventType) {
                switch (eventType) {
                    case 'stopped':
                        this.emit('stopped', eventBody?.reason, eventBody?.threadId, eventBody?.text);
                        break;
                    case 'breakpointValidated':
                    case 'breakpoint':
                        this.emit('breakpointValidated', eventBody);
                        break;
                    case 'output':
                        this.emit('output', eventBody?.output || eventBody?.text, eventBody?.category || 'console');
                        break;
                    case 'terminated':
                        this.emit('terminated');
                        break;
                    case 'initialized':
                        this.emit('initialized');
                        break;
                    default:
                        this.log(`Unknown event type: ${eventType}`);
                }
            }
        } catch (_error) {
            this.log(`Failed to parse message: ${json}`);
        }
    }

    /**
     * Log a message - emits output event based on verbosity
     */
    private log(message: string): void {
        // Log if verbosity is 'information' or 'debug' (not 'none')
        if (this._verbosity !== 'none') {
            // Emit as output event so it shows in Debug Console
            this.emit('output', `[NanoBridge] ${message}`, 'console');
        }
        // Always log to stderr for debugging (visible in extension host logs)
        console.error(`[NanoBridge] ${message}`);
    }
    
    /**
     * Log an error message - always emits regardless of verbosity
     */
    private logError(message: string): void {
        // Always emit errors to Debug Console
        this.emit('output', `[NanoBridge ERROR] ${message}`, 'stderr');
        console.error(`[NanoBridge ERROR] ${message}`);
    }
}
