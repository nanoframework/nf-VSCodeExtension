/*---------------------------------------------------------------------------------------------
 *  Copyright (c) .NET Foundation and Contributors. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { EventEmitter } from 'events';
import { NanoBridge } from './bridge/nanoBridge';
import { DebugProtocol } from '@vscode/debugprotocol';

/**
 * Breakpoint interface for nanoFramework
 */
export interface INanoBreakpoint {
    id: number;
    line: number;
    verified: boolean;
    source: string;
}

/**
 * Thread information
 */
export interface INanoThread {
    id: number;
    name: string;
}

/**
 * Stack frame information
 */
export interface INanoStackFrame {
    index: number;
    name: string;
    file: string | undefined;
    line: number;
    column?: number;
}

/**
 * Stack trace result
 */
export interface INanoStackTrace {
    frames: INanoStackFrame[];
    totalFrames: number;
}

/**
 * Variable information
 */
export interface INanoVariable {
    name: string;
    value: string;
    type: string;
    hasChildren: boolean;
    reference: string;
    namedVariables?: number;
    indexedVariables?: number;
}

/**
 * Evaluation result
 */
export interface INanoEvalResult {
    value: string;
    type: string;
    hasChildren: boolean;
    reference: string;
}

/**
 * Module (assembly) information
 */
export interface INanoModule {
    id: number;
    name: string;
    path?: string;
    version?: string;
}

/**
 * Exception information
 */
export interface INanoExceptionInfo {
    exceptionId: string;
    description: string;
    breakMode: DebugProtocol.ExceptionBreakMode;
    details?: DebugProtocol.ExceptionDetails;
}

/**
 * Stopped reason
 */
export type StoppedReason = 'entry' | 'step' | 'breakpoint' | 'exception' | 'pause' | 'data breakpoint';

/**
 * Function breakpoint interface
 */
export interface INanoFunctionBreakpoint {
    id: number;
    name: string;
    condition?: string;
    verified: boolean;
}

/**
 * nanoFramework Runtime
 * 
 * This class manages communication with a nanoFramework device via the .NET bridge.
 * It translates high-level debugging operations into Wire Protocol commands.
 */
export class NanoRuntime extends EventEmitter {

    // The .NET bridge for Wire Protocol communication
    private _bridge: NanoBridge;

    // Current breakpoints
    private _breakpoints = new Map<string, INanoBreakpoint[]>();
    private _functionBreakpoints: INanoFunctionBreakpoint[] = [];
    private _breakpointId = 1;

    // Exception handling settings
    private _breakOnAllExceptions = false;
    private _breakOnUncaughtExceptions = true;

    // Debug state
    private _isRunning = false;
    private _isPaused = false;
    private _verbose = false;

    constructor() {
        super();
        this._bridge = new NanoBridge();
        this.setupBridgeEvents();
    }

    /**
     * Setup event handlers for the bridge
     */
    private setupBridgeEvents(): void {
        this._bridge.on('stopped', (reason: StoppedReason, threadId: number, exception?: string) => {
            this._isPaused = true;
            switch (reason) {
                case 'entry':
                    this.emit('stopOnEntry');
                    break;
                case 'step':
                    this.emit('stopOnStep');
                    break;
                case 'breakpoint':
                    this.emit('stopOnBreakpoint');
                    break;
                case 'exception':
                    this.emit('stopOnException', exception);
                    break;
                case 'data breakpoint':
                    this.emit('stopOnDataBreakpoint');
                    break;
            }
        });

        this._bridge.on('breakpointValidated', (bp: INanoBreakpoint) => {
            this.emit('breakpointValidated', bp);
        });

        this._bridge.on('output', (text: string, category: string) => {
            this.emit('output', text, category);
        });

        this._bridge.on('terminated', () => {
            this._isRunning = false;
            this.emit('end');
        });
    }

    /**
     * Start debugging - deploy and run
     */
    public async start(program: string, device?: string, stopOnEntry?: boolean, verbose?: boolean): Promise<boolean> {
        this._verbose = verbose || false;
        
        this.log(`Starting debug session for ${program}`);
        
        try {
            // Initialize the bridge
            if (!await this._bridge.initialize(device, verbose)) {
                this.log('Failed to initialize bridge');
                return false;
            }

            // Connect to device
            if (!await this._bridge.connect()) {
                this.log('Failed to connect to device');
                return false;
            }

            // Deploy the application
            if (!await this._bridge.deploy(program)) {
                this.log('Failed to deploy application');
                return false;
            }

            // Set initial breakpoints
            await this.sendBreakpointsToDevice();

            // Configure exception handling
            await this._bridge.setExceptionHandling(this._breakOnAllExceptions, this._breakOnUncaughtExceptions);

            // Start execution
            if (!await this._bridge.startExecution(stopOnEntry)) {
                this.log('Failed to start execution');
                return false;
            }

            this._isRunning = true;
            return true;
        } catch (error) {
            this.log(`Start failed: ${error}`);
            return false;
        }
    }

    /**
     * Attach to a running device
     */
    public async attach(device: string, verbose?: boolean): Promise<boolean> {
        this._verbose = verbose || false;
        
        this.log(`Attaching to device: ${device}`);
        
        try {
            // Initialize the bridge
            if (!await this._bridge.initialize(device, verbose)) {
                this.log('Failed to initialize bridge');
                return false;
            }

            // Connect to device
            if (!await this._bridge.connect()) {
                this.log('Failed to connect to device');
                return false;
            }

            // Attach to running CLR
            if (!await this._bridge.attach()) {
                this.log('Failed to attach to CLR');
                return false;
            }

            // Set breakpoints
            await this.sendBreakpointsToDevice();

            // Configure exception handling
            await this._bridge.setExceptionHandling(this._breakOnAllExceptions, this._breakOnUncaughtExceptions);

            this._isRunning = true;
            return true;
        } catch (error) {
            this.log(`Attach failed: ${error}`);
            return false;
        }
    }

    /**
     * Set a breakpoint
     */
    public async setBreakpoint(path: string, line: number): Promise<INanoBreakpoint> {
        const bp: INanoBreakpoint = {
            id: this._breakpointId++,
            line: line,
            verified: false,
            source: path
        };

        let bps = this._breakpoints.get(path);
        if (!bps) {
            bps = [];
            this._breakpoints.set(path, bps);
        }
        bps.push(bp);

        // If connected, send to device immediately
        if (this._isRunning) {
            const verified = await this._bridge.setBreakpoint(path, line, bp.id);
            bp.verified = verified;
            if (verified) {
                this.emit('breakpointValidated', bp);
            }
        }

        return bp;
    }

    /**
     * Clear breakpoints for a file
     */
    public async clearBreakpoints(path: string): Promise<void> {
        const bps = this._breakpoints.get(path);
        if (bps) {
            if (this._isRunning) {
                for (const bp of bps) {
                    await this._bridge.clearBreakpoint(bp.id);
                }
            }
            this._breakpoints.delete(path);
        }
    }

    /**
     * Send all breakpoints to the device
     */
    private async sendBreakpointsToDevice(): Promise<void> {
        for (const [path, bps] of this._breakpoints) {
            for (const bp of bps) {
                const verified = await this._bridge.setBreakpoint(path, bp.line, bp.id);
                bp.verified = verified;
                if (verified) {
                    this.emit('breakpointValidated', bp);
                }
            }
        }
        
        // Also send function breakpoints
        for (const bp of this._functionBreakpoints) {
            const verified = await this._bridge.setFunctionBreakpoint(bp.name, bp.id, bp.condition);
            bp.verified = verified;
            if (verified) {
                this.emit('breakpointValidated', { id: bp.id, verified: bp.verified, line: 0, source: bp.name });
            }
        }
    }

    /**
     * Set exception breakpoint options
     */
    public setExceptionBreakpoints(breakOnAll: boolean, breakOnUncaught: boolean): void {
        this._breakOnAllExceptions = breakOnAll;
        this._breakOnUncaughtExceptions = breakOnUncaught;

        if (this._isRunning) {
            this._bridge.setExceptionHandling(breakOnAll, breakOnUncaught);
        }
    }

    /**
     * Set a function breakpoint
     */
    public async setFunctionBreakpoint(functionName: string, condition?: string): Promise<INanoBreakpoint> {
        const bp: INanoFunctionBreakpoint = {
            id: this._breakpointId++,
            name: functionName,
            condition: condition,
            verified: false
        };

        this._functionBreakpoints.push(bp);

        // If connected, send to device immediately
        if (this._isRunning) {
            const verified = await this._bridge.setFunctionBreakpoint(functionName, bp.id, condition);
            bp.verified = verified;
        }

        return {
            id: bp.id,
            line: 0,
            verified: bp.verified,
            source: functionName
        };
    }

    /**
     * Clear all function breakpoints
     */
    public async clearFunctionBreakpoints(): Promise<void> {
        if (this._isRunning) {
            for (const bp of this._functionBreakpoints) {
                await this._bridge.clearBreakpoint(bp.id);
            }
        }
        this._functionBreakpoints = [];
    }

    /**
     * Continue execution
     */
    public async continue(): Promise<void> {
        this._isPaused = false;
        await this._bridge.continue();
    }

    /**
     * Step over
     */
    public async stepOver(): Promise<void> {
        await this._bridge.stepOver();
    }

    /**
     * Step into
     */
    public async stepIn(): Promise<void> {
        await this._bridge.stepIn();
    }

    /**
     * Step out
     */
    public async stepOut(): Promise<void> {
        await this._bridge.stepOut();
    }

    /**
     * Pause execution
     */
    public async pause(): Promise<void> {
        await this._bridge.pause();
    }

    /**
     * Get threads
     */
    public async getThreads(): Promise<INanoThread[]> {
        return await this._bridge.getThreads();
    }

    /**
     * Get stack trace for a thread
     */
    public async getStackTrace(threadId: number, startFrame: number, maxLevels: number): Promise<INanoStackTrace> {
        return await this._bridge.getStackTrace(threadId, startFrame, maxLevels);
    }

    /**
     * Get variables for a scope
     */
    public async getVariables(scope: string): Promise<INanoVariable[]> {
        return await this._bridge.getVariables(scope);
    }

    /**
     * Evaluate an expression
     */
    public async evaluate(expression: string, frameId?: number): Promise<INanoEvalResult | null> {
        return await this._bridge.evaluate(expression, frameId);
    }

    /**
     * Set a variable value
     */
    public async setVariable(scope: string, name: string, value: string): Promise<INanoEvalResult> {
        return await this._bridge.setVariable(scope, name, value);
    }

    /**
     * Get exception info
     */
    public async getExceptionInfo(threadId: number): Promise<INanoExceptionInfo> {
        return await this._bridge.getExceptionInfo(threadId);
    }

    /**
     * Get loaded modules (assemblies)
     */
    public async getModules(): Promise<INanoModule[]> {
        return await this._bridge.getModules();
    }

    /**
     * Terminate the debug session
     */
    public async terminate(): Promise<void> {
        this.log('Terminating debug session');
        await this._bridge.terminate();
        this._isRunning = false;
    }

    /**
     * Disconnect from the device
     */
    public async disconnect(terminateDebuggee: boolean): Promise<void> {
        this.log(`Disconnecting (terminate: ${terminateDebuggee})`);
        await this._bridge.disconnect(terminateDebuggee);
        this._isRunning = false;
    }

    /**
     * Log a message
     */
    private log(message: string): void {
        if (this._verbose) {
            this.emit('output', `[NanoRuntime] ${message}`, 'console');
        }
    }
}
