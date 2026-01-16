/*---------------------------------------------------------------------------------------------
 * Copyright (c) .NET Foundation and Contributors.
 * Portions Copyright (c) Microsoft Corporation.  All rights reserved.
 * See LICENSE file in the project root for full license information.
 *--------------------------------------------------------------------------------------------*/

using System.Text.Json;
using System.Text.Json.Serialization;

namespace nanoFramework.Tools.DebugBridge.Protocol;

/// <summary>
/// Represents a request from the TypeScript debug adapter to the .NET bridge
/// </summary>
public class BridgeRequest
{
    /// <summary>
    /// Unique request ID for correlating responses
    /// </summary>
    [JsonPropertyName("id")]
    public int Id { get; set; }

    /// <summary>
    /// The command to execute
    /// </summary>
    [JsonPropertyName("command")]
    public string Command { get; set; } = string.Empty;

    /// <summary>
    /// Command-specific arguments as a JSON element
    /// </summary>
    [JsonPropertyName("args")]
    public JsonElement? Args { get; set; }
}

/// <summary>
/// Represents a response from the .NET bridge to the TypeScript debug adapter
/// </summary>
public class BridgeResponse
{
    /// <summary>
    /// The request ID this response corresponds to
    /// </summary>
    [JsonPropertyName("id")]
    public int Id { get; set; }

    /// <summary>
    /// Whether the command succeeded
    /// </summary>
    [JsonPropertyName("success")]
    public bool Success { get; set; }

    /// <summary>
    /// Error message if the command failed
    /// </summary>
    [JsonPropertyName("error")]
    public string? Error { get; set; }

    /// <summary>
    /// Command-specific response data
    /// </summary>
    [JsonPropertyName("data")]
    public object? Data { get; set; }
}

/// <summary>
/// Represents an event from the .NET bridge to the TypeScript debug adapter
/// </summary>
public class BridgeEvent
{
    /// <summary>
    /// The event type
    /// </summary>
    [JsonPropertyName("event")]
    public string Event { get; set; } = string.Empty;

    /// <summary>
    /// Event-specific data
    /// </summary>
    [JsonPropertyName("body")]
    public object? Body { get; set; }
}

#region Event Bodies

/// <summary>
/// Event body for stopped events (breakpoint hit, step completed, etc.)
/// </summary>
public class StoppedEventBody
{
    [JsonPropertyName("reason")]
    public string Reason { get; set; } = string.Empty;

    [JsonPropertyName("threadId")]
    public int ThreadId { get; set; }

    [JsonPropertyName("allThreadsStopped")]
    public bool AllThreadsStopped { get; set; }

    [JsonPropertyName("text")]
    public string? Text { get; set; }
}

/// <summary>
/// Event body for thread events (thread started, thread exited)
/// </summary>
public class ThreadEventBody
{
    [JsonPropertyName("reason")]
    public string Reason { get; set; } = string.Empty;

    [JsonPropertyName("threadId")]
    public int ThreadId { get; set; }
}

/// <summary>
/// Event body for output events (debug console output)
/// </summary>
public class OutputEventBody
{
    [JsonPropertyName("category")]
    public string Category { get; set; } = "console";

    [JsonPropertyName("output")]
    public string Output { get; set; } = string.Empty;
}

/// <summary>
/// Event body for breakpoint events (breakpoint verified, etc.)
/// </summary>
public class BreakpointEventBody
{
    [JsonPropertyName("reason")]
    public string Reason { get; set; } = string.Empty;

    [JsonPropertyName("breakpoint")]
    public BreakpointInfo? Breakpoint { get; set; }
}

/// <summary>
/// Breakpoint information
/// </summary>
public class BreakpointInfo
{
    [JsonPropertyName("id")]
    public int Id { get; set; }

    [JsonPropertyName("verified")]
    public bool Verified { get; set; }

    [JsonPropertyName("line")]
    public int? Line { get; set; }

    [JsonPropertyName("source")]
    public SourceInfo? Source { get; set; }

    [JsonPropertyName("message")]
    public string? Message { get; set; }
}

/// <summary>
/// Source file information
/// </summary>
public class SourceInfo
{
    [JsonPropertyName("name")]
    public string? Name { get; set; }

    [JsonPropertyName("path")]
    public string? Path { get; set; }
}

#endregion

#region Thread and Stack Types

/// <summary>
/// Thread information
/// </summary>
public class ThreadInfo
{
    [JsonPropertyName("id")]
    public int Id { get; set; }

    [JsonPropertyName("name")]
    public string Name { get; set; } = string.Empty;
}

/// <summary>
/// Stack frame information
/// </summary>
public class StackFrameInfo
{
    [JsonPropertyName("id")]
    public int Id { get; set; }

    [JsonPropertyName("name")]
    public string Name { get; set; } = string.Empty;

    [JsonPropertyName("source")]
    public SourceInfo? Source { get; set; }

    [JsonPropertyName("line")]
    public int Line { get; set; }

    [JsonPropertyName("column")]
    public int Column { get; set; }

    [JsonPropertyName("endLine")]
    public int? EndLine { get; set; }

    [JsonPropertyName("endColumn")]
    public int? EndColumn { get; set; }
}

/// <summary>
/// Scope information
/// </summary>
public class ScopeInfo
{
    [JsonPropertyName("name")]
    public string Name { get; set; } = string.Empty;

    [JsonPropertyName("variablesReference")]
    public int VariablesReference { get; set; }

    [JsonPropertyName("expensive")]
    public bool Expensive { get; set; }

    [JsonPropertyName("namedVariables")]
    public int? NamedVariables { get; set; }

    [JsonPropertyName("indexedVariables")]
    public int? IndexedVariables { get; set; }
}

/// <summary>
/// Variable information
/// </summary>
public class VariableInfo
{
    [JsonPropertyName("name")]
    public string Name { get; set; } = string.Empty;

    [JsonPropertyName("value")]
    public string Value { get; set; } = string.Empty;

    [JsonPropertyName("type")]
    public string? Type { get; set; }

    [JsonPropertyName("variablesReference")]
    public int VariablesReference { get; set; }

    [JsonPropertyName("namedVariables")]
    public int? NamedVariables { get; set; }

    [JsonPropertyName("indexedVariables")]
    public int? IndexedVariables { get; set; }
}

#endregion
