/*---------------------------------------------------------------------------------------------
 *  Copyright (c) .NET Foundation and Contributors. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Type definitions for nanoFramework debugging
 */

/**
 * Launch configuration for nanoFramework debugging
 */
export interface NanoLaunchConfig {
    /** Type of debug configuration */
    type: 'nanoframework';
    /** Request type (launch or attach) */
    request: 'launch' | 'attach';
    /** Configuration name */
    name: string;
    /** Path to the .nfproj or .sln file */
    program?: string;
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
 * Attach configuration for nanoFramework debugging
 */
export interface NanoAttachConfig {
    /** Type of debug configuration */
    type: 'nanoframework';
    /** Request type */
    request: 'attach';
    /** Configuration name */
    name: string;
    /** Target device (COM port or IP address) */
    device: string;
    /** Enable verbose logging */
    verbose?: boolean;
}

/**
 * Device information
 */
export interface DeviceInfo {
    /** Device identifier (e.g., COM port or IP) */
    id: string;
    /** Human-readable name */
    name: string;
    /** Device type (serial, usb, network) */
    type: 'serial' | 'usb' | 'network';
    /** Target name (e.g., ESP32, STM32) */
    targetName?: string;
    /** Firmware version */
    firmwareVersion?: string;
    /** CLR version */
    clrVersion?: string;
}

/**
 * Wire Protocol breakpoint definition
 * Maps to Debugging_Execution_BreakpointDef in the interpreter
 */
export interface WireProtocolBreakpoint {
    /** Breakpoint ID */
    id: number;
    /** Flags (STEP_IN, STEP_OVER, STEP_OUT, HARD, EXCEPTION_*) */
    flags: number;
    /** Thread ID (-1 for any thread) */
    pid: number;
    /** Stack depth */
    depth: number;
    /** IP range start */
    ipStart: number;
    /** IP range end */
    ipEnd: number;
    /** Method definition token */
    md: number;
    /** IL offset */
    ip: number;
    /** Type definition token */
    td: number;
    /** Exception handler depth */
    depthExceptionHandler: number;
}

/**
 * Wire Protocol breakpoint flags
 * Maps to c_STEP_*, c_EXCEPTION_*, etc. in nanoCLR_Debugging.h
 */
export const BreakpointFlags = {
    STEP_IN: 0x0001,
    STEP_OVER: 0x0002,
    STEP_OUT: 0x0004,
    HARD: 0x0008,
    EXCEPTION_THROWN: 0x0010,
    EXCEPTION_CAUGHT: 0x0020,
    EXCEPTION_UNCAUGHT: 0x0040,
    THREAD_TERMINATED: 0x0080,
    THREAD_CREATED: 0x0100,
    ASSEMBLIES_LOADED: 0x0200,
    LAST_BREAKPOINT: 0x0400,
    STEP_JMC: 0x0800,
    BREAK: 0x1000,
    EVAL_COMPLETE: 0x2000,
    EXCEPTION_UNWIND: 0x4000,
    EXCEPTION_FINALLY: 0x8000
};

/**
 * Wire Protocol execution state flags
 * Maps to DebuggingExecutionChangeConditions in nf-debugger
 */
export const ExecutionStateFlags = {
    SourceLevelDebugging: 0x0001,
    PseudoSourceLevelDebugging: 0x0002,
    Stopped: 0x0004,
    NoCompaction: 0x0008,
    PauseTimers: 0x0010,
    NoStackTraceInExceptions: 0x0020,
    FreezeTimersWhileDebugging: 0x0040
};

/**
 * Assembly resolution status
 * Maps to ResolvedStatus in nf-debugger
 */
export enum AssemblyStatus {
    Resolved = 0x00000001,
    Patched = 0x00000002,
    PreparedForExecution = 0x00000004,
    Deployed = 0x00000008,
    PreparingForExecution = 0x00000010
}
