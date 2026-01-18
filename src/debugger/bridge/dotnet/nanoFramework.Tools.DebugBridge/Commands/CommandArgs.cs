/*---------------------------------------------------------------------------------------------
 * Copyright (c) .NET Foundation and Contributors.
 * Portions Copyright (c) Microsoft Corporation.  All rights reserved.
 * See LICENSE file in the project root for full license information.
 *--------------------------------------------------------------------------------------------*/

using System.Text.Json.Serialization;

namespace nanoFramework.Tools.DebugBridge.Commands;

/// <summary>
/// Arguments for the initialize command
/// </summary>
public class InitializeArgs
{
    /// <summary>
    /// Optional device path to store for later connection
    /// </summary>
    [JsonPropertyName("device")]
    public string? Device { get; set; }

    /// <summary>
    /// Enable verbose logging
    /// </summary>
    [JsonPropertyName("verbose")]
    public bool Verbose { get; set; }
}

/// <summary>
/// Arguments for the connect command
/// </summary>
public class ConnectArgs
{
    /// <summary>
    /// Device path (serial port like COM3 or /dev/ttyUSB0, or IP:port)
    /// </summary>
    [JsonPropertyName("device")]
    public string Device { get; set; } = string.Empty;

    /// <summary>
    /// Baud rate for serial connections (default: 921600)
    /// </summary>
    [JsonPropertyName("baudRate")]
    public int BaudRate { get; set; } = 921600;
}

/// <summary>
/// Arguments for setting a breakpoint
/// </summary>
public class SetBreakpointArgs
{
    /// <summary>
    /// Source file path
    /// </summary>
    [JsonPropertyName("file")]
    public string File { get; set; } = string.Empty;

    /// <summary>
    /// Line number (1-based)
    /// </summary>
    [JsonPropertyName("line")]
    public int Line { get; set; }

    /// <summary>
    /// Optional breakpoint condition
    /// </summary>
    [JsonPropertyName("condition")]
    public string? Condition { get; set; }
}

/// <summary>
/// Arguments for removing a breakpoint
/// </summary>
public class RemoveBreakpointArgs
{
    /// <summary>
    /// The breakpoint ID to remove
    /// </summary>
    [JsonPropertyName("breakpointId")]
    public int BreakpointId { get; set; }
}

/// <summary>
/// Arguments that include a thread ID
/// </summary>
public class ThreadArgs
{
    /// <summary>
    /// Thread ID (0 for all threads)
    /// </summary>
    [JsonPropertyName("threadId")]
    public int ThreadId { get; set; }
}

/// <summary>
/// Arguments for getting a stack trace
/// </summary>
public class StackTraceArgs
{
    /// <summary>
    /// Thread ID
    /// </summary>
    [JsonPropertyName("threadId")]
    public int ThreadId { get; set; }

    /// <summary>
    /// Start frame index (0-based)
    /// </summary>
    [JsonPropertyName("startFrame")]
    public int StartFrame { get; set; }

    /// <summary>
    /// Maximum number of frames to return (0 = all)
    /// </summary>
    [JsonPropertyName("levels")]
    public int Levels { get; set; }
}

/// <summary>
/// Arguments for getting scopes
/// </summary>
public class ScopesArgs
{
    /// <summary>
    /// Frame ID
    /// </summary>
    [JsonPropertyName("frameId")]
    public int FrameId { get; set; }
}

/// <summary>
/// Arguments for getting variables
/// </summary>
public class VariablesArgs
{
    /// <summary>
    /// Variables reference (scope or parent variable)
    /// </summary>
    [JsonPropertyName("variablesReference")]
    public int VariablesReference { get; set; }

    /// <summary>
    /// Start index for paging (optional)
    /// </summary>
    [JsonPropertyName("start")]
    public int? Start { get; set; }

    /// <summary>
    /// Number of variables to return (optional, 0 = all)
    /// </summary>
    [JsonPropertyName("count")]
    public int? Count { get; set; }
}

/// <summary>
/// Arguments for evaluating an expression
/// </summary>
public class EvaluateArgs
{
    /// <summary>
    /// The expression to evaluate
    /// </summary>
    [JsonPropertyName("expression")]
    public string Expression { get; set; } = string.Empty;

    /// <summary>
    /// Frame ID for context (optional)
    /// </summary>
    [JsonPropertyName("frameId")]
    public int? FrameId { get; set; }

    /// <summary>
    /// Evaluation context (watch, repl, hover)
    /// </summary>
    [JsonPropertyName("context")]
    public string? Context { get; set; }
}

/// <summary>
/// Arguments for deploying assemblies
/// </summary>
public class DeployArgs
{
    /// <summary>
    /// Path to the folder containing assemblies to deploy
    /// </summary>
    [JsonPropertyName("assembliesPath")]
    public string AssembliesPath { get; set; } = string.Empty;
}

/// <summary>
/// Arguments for starting execution
/// </summary>
public class StartExecutionArgs
{
    /// <summary>
    /// Whether to stop at the entry point
    /// </summary>
    [JsonPropertyName("stopOnEntry")]
    public bool StopOnEntry { get; set; } = true;
}

/// <summary>
/// Arguments for setting exception handling options
/// </summary>
public class SetExceptionHandlingArgs
{
    /// <summary>
    /// Whether to break on all exceptions
    /// </summary>
    [JsonPropertyName("breakOnAll")]
    public bool BreakOnAll { get; set; }

    /// <summary>
    /// Whether to break on uncaught exceptions
    /// </summary>
    [JsonPropertyName("breakOnUncaught")]
    public bool BreakOnUncaught { get; set; } = true;
}

/// <summary>
/// Arguments for rebooting the device
/// </summary>
public class RebootArgs
{
    /// <summary>
    /// If true, only reboot the CLR; if false, full device reboot
    /// </summary>
    [JsonPropertyName("clrOnly")]
    public bool ClrOnly { get; set; }
}

/// <summary>
/// Arguments for loading symbols
/// </summary>
public class LoadSymbolsArgs
{
    /// <summary>
    /// Path to a .pdbx file or directory containing .pdbx files
    /// </summary>
    [JsonPropertyName("path")]
    public string? Path { get; set; }

    /// <summary>
    /// If path is a directory, whether to search recursively (default: true)
    /// </summary>
    [JsonPropertyName("recursive")]
    public bool? Recursive { get; set; }
}

/// <summary>
/// Arguments for setting a variable value
/// </summary>
public class SetVariableArgs
{
    /// <summary>
    /// The variables reference (identifies the scope or parent container)
    /// </summary>
    [JsonPropertyName("variablesReference")]
    public int VariablesReference { get; set; }

    /// <summary>
    /// The name of the variable to set
    /// </summary>
    [JsonPropertyName("name")]
    public string Name { get; set; } = string.Empty;

    /// <summary>
    /// The new value for the variable (as a string)
    /// </summary>
    [JsonPropertyName("value")]
    public string Value { get; set; } = string.Empty;
}
