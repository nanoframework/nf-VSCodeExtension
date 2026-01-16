/*---------------------------------------------------------------------------------------------
 *  Copyright (c) .NET Foundation and Contributors. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import {
    LoggingDebugSession,
    InitializedEvent,
    TerminatedEvent,
    StoppedEvent,
    BreakpointEvent,
    OutputEvent,
    Thread,
    StackFrame,
    Scope,
    Source,
    Handles,
    Breakpoint,
    MemoryEvent
} from '@vscode/debugadapter';
import { DebugProtocol } from '@vscode/debugprotocol';
import { NanoRuntime, INanoBreakpoint, StoppedReason } from './nanoRuntime';
import { Subject } from './utils/subject';
import * as path from 'path';

/**
 * Launch request arguments for nanoFramework debugging
 */
interface ILaunchRequestArguments extends DebugProtocol.LaunchRequestArguments {
    /** Path to the .nfproj or .sln file */
    program: string;
    /** Target device (COM port or IP address) */
    device?: string;
    /** Automatically stop after launch */
    stopOnEntry?: boolean;
    /** Enable verbose logging */
    verbose?: boolean;
    /** Working directory */
    cwd?: string;
}

/**
 * Attach request arguments for nanoFramework debugging
 */
interface IAttachRequestArguments extends DebugProtocol.AttachRequestArguments {
    /** Target device (COM port or IP address) */
    device: string;
    /** Enable verbose logging */
    verbose?: boolean;
}

/**
 * nanoFramework Debug Session
 * 
 * Implements the Debug Adapter Protocol for nanoFramework devices.
 * This class translates DAP requests into Wire Protocol commands via NanoRuntime.
 */
export class NanoDebugSession extends LoggingDebugSession {

    // We don't support multiple threads, so we use a hardcoded thread ID
    private static readonly THREAD_ID = 1;

    private _runtime: NanoRuntime;
    private _variableHandles = new Handles<'locals' | 'globals' | string>();
    private _configurationDone = new Subject();
    private _cancellationTokens = new Map<number, boolean>();
    private _isAttach = false;

    /**
     * Creates a new debug session
     */
    public constructor() {
        super("nanoframework-debug.log");

        // Create the runtime that communicates with the device
        this._runtime = new NanoRuntime();

        // Setup event handlers
        this._runtime.on('stopOnEntry', () => {
            this.sendEvent(new StoppedEvent('entry', NanoDebugSession.THREAD_ID));
        });

        this._runtime.on('stopOnStep', () => {
            this.sendEvent(new StoppedEvent('step', NanoDebugSession.THREAD_ID));
        });

        this._runtime.on('stopOnBreakpoint', () => {
            this.sendEvent(new StoppedEvent('breakpoint', NanoDebugSession.THREAD_ID));
        });

        this._runtime.on('stopOnDataBreakpoint', () => {
            this.sendEvent(new StoppedEvent('data breakpoint', NanoDebugSession.THREAD_ID));
        });

        this._runtime.on('stopOnException', (exception: string) => {
            this.sendEvent(new StoppedEvent('exception', NanoDebugSession.THREAD_ID, exception));
        });

        this._runtime.on('breakpointValidated', (bp: INanoBreakpoint) => {
            this.sendEvent(new BreakpointEvent('changed', {
                verified: bp.verified,
                id: bp.id
            } as DebugProtocol.Breakpoint));
        });

        this._runtime.on('output', (text: string, category: string) => {
            const e: DebugProtocol.OutputEvent = new OutputEvent(text + '\n', category);
            this.sendEvent(e);
        });

        this._runtime.on('end', () => {
            this.sendEvent(new TerminatedEvent());
        });
    }

    /**
     * Initialize request - first request from VS Code
     * Returns the capabilities of this debug adapter
     */
    protected initializeRequest(response: DebugProtocol.InitializeResponse, args: DebugProtocol.InitializeRequestArguments): void {

        // Build and return the capabilities of this debug adapter
        response.body = response.body || {};

        // Adapter supports the configurationDone request
        response.body.supportsConfigurationDoneRequest = true;

        // Adapter supports evaluate request for data hovers
        response.body.supportsEvaluateForHovers = true;

        // Adapter supports stepping back (not currently implemented)
        response.body.supportsStepBack = false;

        // Adapter supports setting variables
        response.body.supportsSetVariable = true;

        // Adapter supports restarting a frame
        response.body.supportsRestartFrame = false;

        // Adapter supports goto targets request (not implemented)
        response.body.supportsGotoTargetsRequest = false;

        // Adapter supports stepping in targets request (not implemented)
        response.body.supportsStepInTargetsRequest = false;

        // Adapter supports completions request for REPL
        response.body.supportsCompletionsRequest = false;

        // Adapter supports modules request
        response.body.supportsModulesRequest = true;

        // Adapter supports function breakpoints
        response.body.supportsFunctionBreakpoints = true;

        // Adapter supports exception options
        response.body.supportsExceptionOptions = true;
        response.body.exceptionBreakpointFilters = [
            {
                filter: 'all',
                label: 'All Exceptions',
                description: 'Break on all exceptions',
                default: false
            },
            {
                filter: 'uncaught',
                label: 'Uncaught Exceptions',
                description: 'Break on uncaught exceptions',
                default: true
            }
        ];

        // Adapter supports value formatting
        response.body.supportsValueFormattingOptions = false;

        // Adapter supports exception info request
        response.body.supportsExceptionInfoRequest = true;

        // Adapter supports terminate request
        response.body.supportsTerminateRequest = true;

        // Adapter supports delayed stack trace loading
        response.body.supportsDelayedStackTraceLoading = true;

        // Adapter supports loaded sources request
        response.body.supportsLoadedSourcesRequest = false;

        // Adapter supports log points
        response.body.supportsLogPoints = false;

        // Adapter supports terminate threads request
        response.body.supportsTerminateThreadsRequest = false;

        // Adapter supports set expression
        response.body.supportsSetExpression = false;

        // Adapter supports terminate debuggee
        response.body.supportTerminateDebuggee = true;

        // Adapter supports suspend/resume all threads
        response.body.supportSuspendDebuggee = true;

        // Adapter supports breakpoint locations request
        response.body.supportsBreakpointLocationsRequest = false;

        // Adapter supports clipboard context
        response.body.supportsClipboardContext = false;

        // Adapter supports stepping granularity
        response.body.supportsSteppingGranularity = false;

        // Adapter supports instruction breakpoints
        response.body.supportsInstructionBreakpoints = false;

        // Adapter supports single thread execution requests
        response.body.supportsSingleThreadExecutionRequests = false;

        this.sendResponse(response);

        // Signal that we are ready to accept configuration requests (breakpoints, etc.)
        this.sendEvent(new InitializedEvent());
    }

    /**
     * Called at the end of the configuration sequence.
     * Indicates that all breakpoints etc. have been sent to the DA and that the 'launch' can start.
     */
    protected configurationDoneRequest(response: DebugProtocol.ConfigurationDoneResponse, args: DebugProtocol.ConfigurationDoneArguments): void {
        super.configurationDoneRequest(response, args);

        // Notify the launchRequest that configuration is done
        this._configurationDone.notify();
    }

    /**
     * Launch request - start debugging
     */
    protected async launchRequest(response: DebugProtocol.LaunchResponse, args: ILaunchRequestArguments) {
        try {
            this._isAttach = false;

            // Wait until configuration is done (breakpoints are set)
            await this._configurationDone.wait(3000);

            // Start the runtime
            const success = await this._runtime.start(
                args.program,
                args.device,
                !!args.stopOnEntry,
                args.verbose || false
            );

            if (!success) {
                this.sendErrorResponse(response, {
                    id: 1001,
                    format: 'Failed to start debugging session. Check device connection.',
                    showUser: true
                });
                return;
            }

            this.sendResponse(response);
        } catch (error) {
            this.sendErrorResponse(response, {
                id: 1002,
                format: `Launch failed: ${error instanceof Error ? error.message : String(error)}`,
                showUser: true
            });
        }
    }

    /**
     * Attach request - attach to running device
     */
    protected async attachRequest(response: DebugProtocol.AttachResponse, args: IAttachRequestArguments) {
        try {
            this._isAttach = true;

            // Wait until configuration is done
            await this._configurationDone.wait(3000);

            // Attach to the device
            const success = await this._runtime.attach(
                args.device,
                args.verbose || false
            );

            if (!success) {
                this.sendErrorResponse(response, {
                    id: 1003,
                    format: 'Failed to attach to device. Check device connection.',
                    showUser: true
                });
                return;
            }

            this.sendResponse(response);
        } catch (error) {
            this.sendErrorResponse(response, {
                id: 1004,
                format: `Attach failed: ${error instanceof Error ? error.message : String(error)}`,
                showUser: true
            });
        }
    }

    /**
     * Set breakpoints request
     */
    protected async setBreakPointsRequest(response: DebugProtocol.SetBreakpointsResponse, args: DebugProtocol.SetBreakpointsArguments): Promise<void> {

        const sourcePath = args.source.path as string;
        const clientLines = args.lines || [];

        // Clear existing breakpoints for this file
        await this._runtime.clearBreakpoints(sourcePath);

        // Set new breakpoints
        const actualBreakpoints = await Promise.all(clientLines.map(async (line) => {
            const bp = await this._runtime.setBreakpoint(sourcePath, this.convertClientLineToDebugger(line));
            return new Breakpoint(
                bp.verified,
                this.convertDebuggerLineToClient(bp.line),
                undefined,
                new Source(path.basename(sourcePath), sourcePath)
            ) as DebugProtocol.Breakpoint;
        }));

        // Send back the actual breakpoints
        response.body = {
            breakpoints: actualBreakpoints
        };
        this.sendResponse(response);
    }

    /**
     * Set exception breakpoints request
     */
    protected setExceptionBreakPointsRequest(response: DebugProtocol.SetExceptionBreakpointsResponse, args: DebugProtocol.SetExceptionBreakpointsArguments): void {
        
        const filters = args.filters || [];
        
        // Configure exception handling
        this._runtime.setExceptionBreakpoints(
            filters.includes('all'),
            filters.includes('uncaught')
        );

        response.body = {
            breakpoints: filters.map(f => ({ verified: true }))
        };
        this.sendResponse(response);
    }

    /**
     * Set function breakpoints request
     */
    protected async setFunctionBreakPointsRequest(response: DebugProtocol.SetFunctionBreakpointsResponse, args: DebugProtocol.SetFunctionBreakpointsArguments): Promise<void> {
        const functionBreakpoints = args.breakpoints || [];
        
        // Clear existing function breakpoints
        await this._runtime.clearFunctionBreakpoints();
        
        // Set new function breakpoints
        const actualBreakpoints = await Promise.all(functionBreakpoints.map(async (fbp) => {
            const bp = await this._runtime.setFunctionBreakpoint(fbp.name, fbp.condition);
            return {
                verified: bp.verified,
                id: bp.id,
                message: bp.verified ? undefined : 'Function not found'
            } as DebugProtocol.Breakpoint;
        }));
        
        response.body = {
            breakpoints: actualBreakpoints
        };
        this.sendResponse(response);
    }

    /**
     * Threads request - return list of threads
     */
    protected async threadsRequest(response: DebugProtocol.ThreadsResponse): Promise<void> {
        const threads = await this._runtime.getThreads();
        
        response.body = {
            threads: threads.map(t => new Thread(t.id, t.name))
        };
        this.sendResponse(response);
    }

    /**
     * Stack trace request - return call stack
     */
    protected async stackTraceRequest(response: DebugProtocol.StackTraceResponse, args: DebugProtocol.StackTraceArguments): Promise<void> {
        const startFrame = typeof args.startFrame === 'number' ? args.startFrame : 0;
        const maxLevels = typeof args.levels === 'number' ? args.levels : 1000;

        const stack = await this._runtime.getStackTrace(args.threadId, startFrame, maxLevels);

        response.body = {
            stackFrames: stack.frames.map((f, ix) => {
                const sf = new StackFrame(
                    f.index,
                    f.name,
                    f.file ? new Source(path.basename(f.file), f.file) : undefined,
                    this.convertDebuggerLineToClient(f.line)
                );
                if (f.column) {
                    sf.column = this.convertDebuggerColumnToClient(f.column);
                }
                return sf;
            }),
            totalFrames: stack.totalFrames
        };
        this.sendResponse(response);
    }

    /**
     * Scopes request - return scopes for a stack frame
     */
    protected scopesRequest(response: DebugProtocol.ScopesResponse, args: DebugProtocol.ScopesArguments): void {

        response.body = {
            scopes: [
                new Scope("Locals", this._variableHandles.create('locals'), false),
                new Scope("Globals", this._variableHandles.create('globals'), true)
            ]
        };
        this.sendResponse(response);
    }

    /**
     * Variables request - return variables for a scope
     */
    protected async variablesRequest(response: DebugProtocol.VariablesResponse, args: DebugProtocol.VariablesArguments, request?: DebugProtocol.Request): Promise<void> {

        const reference = this._variableHandles.get(args.variablesReference);
        
        if (reference) {
            const variables = await this._runtime.getVariables(reference);
            
            response.body = {
                variables: variables.map(v => ({
                    name: v.name,
                    value: v.value,
                    type: v.type,
                    variablesReference: v.hasChildren ? this._variableHandles.create(v.reference) : 0,
                    namedVariables: v.namedVariables,
                    indexedVariables: v.indexedVariables
                }))
            };
        } else {
            response.body = {
                variables: []
            };
        }

        this.sendResponse(response);
    }

    /**
     * Continue request - resume execution
     */
    protected continueRequest(response: DebugProtocol.ContinueResponse, args: DebugProtocol.ContinueArguments): void {
        this._runtime.continue();
        response.body = {
            allThreadsContinued: true
        };
        this.sendResponse(response);
    }

    /**
     * Next request - step over
     */
    protected nextRequest(response: DebugProtocol.NextResponse, args: DebugProtocol.NextArguments): void {
        this._runtime.stepOver();
        this.sendResponse(response);
    }

    /**
     * Step in request
     */
    protected stepInRequest(response: DebugProtocol.StepInResponse, args: DebugProtocol.StepInArguments): void {
        this._runtime.stepIn();
        this.sendResponse(response);
    }

    /**
     * Step out request
     */
    protected stepOutRequest(response: DebugProtocol.StepOutResponse, args: DebugProtocol.StepOutArguments): void {
        this._runtime.stepOut();
        this.sendResponse(response);
    }

    /**
     * Pause request
     */
    protected pauseRequest(response: DebugProtocol.PauseResponse, args: DebugProtocol.PauseArguments): void {
        this._runtime.pause();
        this.sendResponse(response);
    }

    /**
     * Evaluate request - evaluate an expression
     */
    protected async evaluateRequest(response: DebugProtocol.EvaluateResponse, args: DebugProtocol.EvaluateArguments): Promise<void> {

        const result = await this._runtime.evaluate(args.expression, args.frameId);

        if (result) {
            response.body = {
                result: result.value,
                type: result.type,
                variablesReference: result.hasChildren ? this._variableHandles.create(result.reference) : 0
            };
        } else {
            response.body = {
                result: 'undefined',
                variablesReference: 0
            };
        }

        this.sendResponse(response);
    }

    /**
     * Set variable request
     */
    protected async setVariableRequest(response: DebugProtocol.SetVariableResponse, args: DebugProtocol.SetVariableArguments): Promise<void> {

        const result = await this._runtime.setVariable(
            this._variableHandles.get(args.variablesReference) || '',
            args.name,
            args.value
        );

        response.body = {
            value: result.value,
            type: result.type,
            variablesReference: result.hasChildren ? this._variableHandles.create(result.reference) : 0
        };
        this.sendResponse(response);
    }

    /**
     * Terminate request
     */
    protected async terminateRequest(response: DebugProtocol.TerminateResponse, args: DebugProtocol.TerminateArguments): Promise<void> {
        await this._runtime.terminate();
        this.sendResponse(response);
    }

    /**
     * Disconnect request
     */
    protected async disconnectRequest(response: DebugProtocol.DisconnectResponse, args: DebugProtocol.DisconnectArguments): Promise<void> {
        await this._runtime.disconnect(args.terminateDebuggee || false);
        this.sendResponse(response);
    }

    /**
     * Exception info request
     */
    protected async exceptionInfoRequest(response: DebugProtocol.ExceptionInfoResponse, args: DebugProtocol.ExceptionInfoArguments): Promise<void> {
        const info = await this._runtime.getExceptionInfo(args.threadId);
        
        response.body = {
            exceptionId: info.exceptionId,
            description: info.description,
            breakMode: info.breakMode,
            details: info.details
        };
        this.sendResponse(response);
    }

    /**
     * Modules request - return loaded assemblies
     */
    protected async modulesRequest(response: DebugProtocol.ModulesResponse, args: DebugProtocol.ModulesArguments): Promise<void> {
        const modules = await this._runtime.getModules();
        
        response.body = {
            modules: modules.map(m => ({
                id: m.id,
                name: m.name,
                path: m.path,
                version: m.version
            })),
            totalModules: modules.length
        };
        this.sendResponse(response);
    }
}
