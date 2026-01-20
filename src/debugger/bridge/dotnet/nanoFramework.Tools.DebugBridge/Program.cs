// Licensed to the .NET Foundation under one or more agreements.
// The .NET Foundation licenses this file to you under the MIT license.

using System.Text.Json;
using nanoFramework.Tools.DebugBridge.Commands;
using nanoFramework.Tools.DebugBridge.Protocol;

namespace nanoFramework.Tools.DebugBridge;

/// <summary>
/// Main entry point for the Debug Bridge process.
/// This process acts as a bridge between the VS Code debug adapter (TypeScript/Node.js)
/// and the nf-debugger .NET library, communicating via JSON-RPC over stdin/stdout.
/// </summary>
class Program
{
    private static readonly JsonSerializerOptions _jsonOptions = new()
    {
        PropertyNamingPolicy = JsonNamingPolicy.CamelCase,
        WriteIndented = false
    };

    private static DebugBridgeSession? _session;
    private static bool _running = true;

    static async Task Main(string[] args)
    {
        // Set up console for JSON communication
        Console.InputEncoding = System.Text.Encoding.UTF8;
        Console.OutputEncoding = System.Text.Encoding.UTF8;

        _session = new DebugBridgeSession();
        _session.OnEvent += SendEvent;

        // Process commands from stdin
        while (_running)
        {
            try
            {
                var line = await Console.In.ReadLineAsync();
                if (string.IsNullOrEmpty(line))
                {
                    continue;
                }

                await ProcessCommand(line);
            }
            catch (Exception ex)
            {
                SendError(-1, $"Error processing command: {ex.Message}");
            }
        }
    }

    private static async Task ProcessCommand(string json)
    {
        try
        {
            var request = JsonSerializer.Deserialize<BridgeRequest>(json, _jsonOptions);
            if (request == null)
            {
                SendError(-1, "Invalid request format");
                return;
            }

            BridgeResponse response;
            
            switch (request.Command)
            {
                case "initialize":
                    response = await HandleInitialize(request);
                    break;
                case "connect":
                    response = await HandleConnect(request);
                    break;
                case "disconnect":
                    response = await HandleDisconnect(request);
                    break;
                case "setBreakpoint":
                    response = await HandleSetBreakpoint(request);
                    break;
                case "removeBreakpoint":
                    response = await HandleRemoveBreakpoint(request);
                    break;
                case "continue":
                    response = await HandleContinue(request);
                    break;
                case "pause":
                    response = await HandlePause(request);
                    break;
                case "stepOver":
                    response = await HandleStepOver(request);
                    break;
                case "stepIn":
                    response = await HandleStepIn(request);
                    break;
                case "stepOut":
                    response = await HandleStepOut(request);
                    break;
                case "getThreads":
                    response = await HandleGetThreads(request);
                    break;
                case "getStackTrace":
                    response = await HandleGetStackTrace(request);
                    break;
                case "getScopes":
                    response = await HandleGetScopes(request);
                    break;
                case "getVariables":
                    response = await HandleGetVariables(request);
                    break;
                case "setVariable":
                    response = await HandleSetVariable(request);
                    break;
                case "evaluate":
                    response = await HandleEvaluate(request);
                    break;
                case "deploy":
                    response = await HandleDeploy(request);
                    break;
                case "startExecution":
                    response = await HandleStartExecution(request);
                    break;
                case "attach":
                    response = await HandleAttach(request);
                    break;
                case "setExceptionHandling":
                    response = await HandleSetExceptionHandling(request);
                    break;
                case "reboot":
                    response = await HandleReboot(request);
                    break;
                case "loadSymbols":
                    response = await HandleLoadSymbols(request);
                    break;
                case "terminate":
                    response = await HandleTerminate(request);
                    break;
                case "exit":
                    _running = false;
                    response = new BridgeResponse { Id = request.Id, Success = true };
                    break;
                default:
                    response = new BridgeResponse
                    {
                        Id = request.Id,
                        Success = false,
                        Error = $"Unknown command: {request.Command}"
                    };
                    break;
            }

            SendResponse(response);
        }
        catch (Exception ex)
        {
            SendError(-1, ex.Message);
        }
    }

    #region Command Handlers

    private static async Task<BridgeResponse> HandleInitialize(BridgeRequest request)
    {
        // Initialize command - just acknowledge that the bridge is ready
        // The actual device connection happens in the connect command
        var args = JsonSerializer.Deserialize<InitializeArgs>(request.Args?.ToString() ?? "{}", _jsonOptions);
        
        // Configure verbosity level
        if (_session != null && args != null)
        {
            if (!string.IsNullOrEmpty(args.Verbosity))
            {
                // Use explicit verbosity setting
                _session.SetVerbosity(args.Verbosity);
            }
            else if (args.Verbose)
            {
                // Legacy verbose flag - sets to Debug level
                _session.SetVerbosity(VerbosityLevel.Debug);
            }
            else
            {
                // Default to Information level
                _session.SetVerbosity(VerbosityLevel.Information);
            }
        }

        return new BridgeResponse
        {
            Id = request.Id,
            Success = true,
            Data = new { version = "1.0.0", capabilities = new[] { "breakpoints", "variables", "stepping" } }
        };
    }

    private static async Task<BridgeResponse> HandleConnect(BridgeRequest request)
    {
        if (_session == null)
        {
            return new BridgeResponse { Id = request.Id, Success = false, Error = "Session not initialized" };
        }

        var args = JsonSerializer.Deserialize<ConnectArgs>(request.Args?.ToString() ?? "{}", _jsonOptions);
        if (args == null)
        {
            return new BridgeResponse { Id = request.Id, Success = false, Error = "Invalid connect arguments" };
        }

        var result = await _session.Connect(args.Device, args.BaudRate);
        return new BridgeResponse { Id = request.Id, Success = result.Success, Error = result.Error };
    }

    private static async Task<BridgeResponse> HandleDisconnect(BridgeRequest request)
    {
        if (_session == null)
        {
            return new BridgeResponse { Id = request.Id, Success = false, Error = "Session not initialized" };
        }

        await _session.Disconnect();
        return new BridgeResponse { Id = request.Id, Success = true };
    }

    private static async Task<BridgeResponse> HandleSetBreakpoint(BridgeRequest request)
    {
        if (_session == null)
        {
            return new BridgeResponse { Id = request.Id, Success = false, Error = "Session not initialized" };
        }

        var args = JsonSerializer.Deserialize<SetBreakpointArgs>(request.Args?.ToString() ?? "{}", _jsonOptions);
        if (args == null)
        {
            return new BridgeResponse { Id = request.Id, Success = false, Error = "Invalid breakpoint arguments" };
        }

        var result = await _session.SetBreakpoint(args.File, args.Line, args.Condition);
        return new BridgeResponse
        {
            Id = request.Id,
            Success = result.Success,
            Data = result.BreakpointId,
            Error = result.Error
        };
    }

    private static async Task<BridgeResponse> HandleRemoveBreakpoint(BridgeRequest request)
    {
        if (_session == null)
        {
            return new BridgeResponse { Id = request.Id, Success = false, Error = "Session not initialized" };
        }

        var args = JsonSerializer.Deserialize<RemoveBreakpointArgs>(request.Args?.ToString() ?? "{}", _jsonOptions);
        if (args == null)
        {
            return new BridgeResponse { Id = request.Id, Success = false, Error = "Invalid breakpoint arguments" };
        }

        var result = await _session.RemoveBreakpoint(args.BreakpointId);
        return new BridgeResponse { Id = request.Id, Success = result, Error = result ? null : "Failed to remove breakpoint" };
    }

    private static async Task<BridgeResponse> HandleContinue(BridgeRequest request)
    {
        if (_session == null)
        {
            return new BridgeResponse { Id = request.Id, Success = false, Error = "Session not initialized" };
        }

        var args = JsonSerializer.Deserialize<ThreadArgs>(request.Args?.ToString() ?? "{}", _jsonOptions);
        var result = await _session.Continue(args?.ThreadId ?? 0);
        return new BridgeResponse { Id = request.Id, Success = result };
    }

    private static async Task<BridgeResponse> HandlePause(BridgeRequest request)
    {
        if (_session == null)
        {
            return new BridgeResponse { Id = request.Id, Success = false, Error = "Session not initialized" };
        }

        var args = JsonSerializer.Deserialize<ThreadArgs>(request.Args?.ToString() ?? "{}", _jsonOptions);
        var result = await _session.Pause(args?.ThreadId ?? 0);
        return new BridgeResponse { Id = request.Id, Success = result };
    }

    private static async Task<BridgeResponse> HandleStepOver(BridgeRequest request)
    {
        if (_session == null)
        {
            return new BridgeResponse { Id = request.Id, Success = false, Error = "Session not initialized" };
        }

        var args = JsonSerializer.Deserialize<ThreadArgs>(request.Args?.ToString() ?? "{}", _jsonOptions);
        var result = await _session.StepOver(args?.ThreadId ?? 0);
        return new BridgeResponse { Id = request.Id, Success = result };
    }

    private static async Task<BridgeResponse> HandleStepIn(BridgeRequest request)
    {
        if (_session == null)
        {
            return new BridgeResponse { Id = request.Id, Success = false, Error = "Session not initialized" };
        }

        var args = JsonSerializer.Deserialize<ThreadArgs>(request.Args?.ToString() ?? "{}", _jsonOptions);
        var result = await _session.StepIn(args?.ThreadId ?? 0);
        return new BridgeResponse { Id = request.Id, Success = result };
    }

    private static async Task<BridgeResponse> HandleStepOut(BridgeRequest request)
    {
        if (_session == null)
        {
            return new BridgeResponse { Id = request.Id, Success = false, Error = "Session not initialized" };
        }

        var args = JsonSerializer.Deserialize<ThreadArgs>(request.Args?.ToString() ?? "{}", _jsonOptions);
        var result = await _session.StepOut(args?.ThreadId ?? 0);
        return new BridgeResponse { Id = request.Id, Success = result };
    }

    private static async Task<BridgeResponse> HandleGetThreads(BridgeRequest request)
    {
        if (_session == null)
        {
            return new BridgeResponse { Id = request.Id, Success = false, Error = "Session not initialized" };
        }

        var threads = await _session.GetThreads();
        return new BridgeResponse
        {
            Id = request.Id,
            Success = true,
            Data = threads
        };
    }

    private static async Task<BridgeResponse> HandleGetStackTrace(BridgeRequest request)
    {
        if (_session == null)
        {
            return new BridgeResponse { Id = request.Id, Success = false, Error = "Session not initialized" };
        }

        var args = JsonSerializer.Deserialize<StackTraceArgs>(request.Args?.ToString() ?? "{}", _jsonOptions);
        if (args == null)
        {
            return new BridgeResponse { Id = request.Id, Success = false, Error = "Invalid stack trace arguments" };
        }

        var frames = await _session.GetStackTrace(args.ThreadId, args.StartFrame, args.Levels);
        return new BridgeResponse
        {
            Id = request.Id,
            Success = true,
            Data = new { frames = frames, totalFrames = frames.Count }
        };
    }

    private static async Task<BridgeResponse> HandleGetScopes(BridgeRequest request)
    {
        if (_session == null)
        {
            return new BridgeResponse { Id = request.Id, Success = false, Error = "Session not initialized" };
        }

        var args = JsonSerializer.Deserialize<ScopesArgs>(request.Args?.ToString() ?? "{}", _jsonOptions);
        if (args == null)
        {
            return new BridgeResponse { Id = request.Id, Success = false, Error = "Invalid scopes arguments" };
        }

        var scopes = await _session.GetScopes(args.FrameId);
        return new BridgeResponse
        {
            Id = request.Id,
            Success = true,
            Data = scopes
        };
    }

    private static async Task<BridgeResponse> HandleGetVariables(BridgeRequest request)
    {
        if (_session == null)
        {
            return new BridgeResponse { Id = request.Id, Success = false, Error = "Session not initialized" };
        }

        var args = JsonSerializer.Deserialize<VariablesArgs>(request.Args?.ToString() ?? "{}", _jsonOptions);
        if (args == null)
        {
            return new BridgeResponse { Id = request.Id, Success = false, Error = "Invalid variables arguments" };
        }

        var variables = await _session.GetVariables(args.VariablesReference, args.Start, args.Count);
        return new BridgeResponse
        {
            Id = request.Id,
            Success = true,
            Data = variables
        };
    }

    private static async Task<BridgeResponse> HandleSetVariable(BridgeRequest request)
    {
        if (_session == null)
        {
            return new BridgeResponse { Id = request.Id, Success = false, Error = "Session not initialized" };
        }

        var args = JsonSerializer.Deserialize<SetVariableArgs>(request.Args?.ToString() ?? "{}", _jsonOptions);
        if (args == null)
        {
            return new BridgeResponse { Id = request.Id, Success = false, Error = "Invalid setVariable arguments" };
        }

        var (success, result, error) = await _session.SetVariable(args.VariablesReference, args.Name, args.Value);
        return new BridgeResponse
        {
            Id = request.Id,
            Success = success,
            Data = result,
            Error = error
        };
    }

    private static async Task<BridgeResponse> HandleEvaluate(BridgeRequest request)
    {
        if (_session == null)
        {
            return new BridgeResponse { Id = request.Id, Success = false, Error = "Session not initialized" };
        }

        var args = JsonSerializer.Deserialize<EvaluateArgs>(request.Args?.ToString() ?? "{}", _jsonOptions);
        if (args == null)
        {
            return new BridgeResponse { Id = request.Id, Success = false, Error = "Invalid evaluate arguments" };
        }

        var result = await _session.Evaluate(args.Expression, args.FrameId, args.Context);
        return new BridgeResponse
        {
            Id = request.Id,
            Success = result.Success,
            Data = result.Value,
            Error = result.Error
        };
    }

    private static async Task<BridgeResponse> HandleDeploy(BridgeRequest request)
    {
        if (_session == null)
        {
            return new BridgeResponse { Id = request.Id, Success = false, Error = "Session not initialized" };
        }

        var args = JsonSerializer.Deserialize<DeployArgs>(request.Args?.ToString() ?? "{}", _jsonOptions);
        if (args == null)
        {
            return new BridgeResponse { Id = request.Id, Success = false, Error = "Invalid deploy arguments" };
        }

        var result = await _session.Deploy(args.AssembliesPath);
        return new BridgeResponse { Id = request.Id, Success = result.Success, Error = result.Error };
    }

    private static async Task<BridgeResponse> HandleStartExecution(BridgeRequest request)
    {
        if (_session == null)
        {
            return new BridgeResponse { Id = request.Id, Success = false, Error = "Session not initialized" };
        }

        var args = JsonSerializer.Deserialize<StartExecutionArgs>(request.Args?.ToString() ?? "{}", _jsonOptions);
        var result = await _session.StartExecution(args?.StopOnEntry ?? true);
        return new BridgeResponse { Id = request.Id, Success = result };
    }

    private static async Task<BridgeResponse> HandleAttach(BridgeRequest request)
    {
        if (_session == null)
        {
            return new BridgeResponse { Id = request.Id, Success = false, Error = "Session not initialized" };
        }

        var result = await _session.Attach();
        return new BridgeResponse { Id = request.Id, Success = result };
    }

    private static async Task<BridgeResponse> HandleSetExceptionHandling(BridgeRequest request)
    {
        if (_session == null)
        {
            return new BridgeResponse { Id = request.Id, Success = false, Error = "Session not initialized" };
        }

        var args = JsonSerializer.Deserialize<SetExceptionHandlingArgs>(request.Args?.ToString() ?? "{}", _jsonOptions);
        await _session.SetExceptionHandling(args?.BreakOnAll ?? false, args?.BreakOnUncaught ?? true);
        return new BridgeResponse { Id = request.Id, Success = true };
    }

    private static async Task<BridgeResponse> HandleTerminate(BridgeRequest request)
    {
        if (_session == null)
        {
            return new BridgeResponse { Id = request.Id, Success = false, Error = "Session not initialized" };
        }

        await _session.Terminate();
        return new BridgeResponse { Id = request.Id, Success = true };
    }

    private static async Task<BridgeResponse> HandleReboot(BridgeRequest request)
    {
        if (_session == null)
        {
            return new BridgeResponse { Id = request.Id, Success = false, Error = "Session not initialized" };
        }

        var args = JsonSerializer.Deserialize<RebootArgs>(request.Args?.ToString() ?? "{}", _jsonOptions);
        var result = await _session.Reboot(args?.ClrOnly ?? false);
        return new BridgeResponse { Id = request.Id, Success = result };
    }

    private static async Task<BridgeResponse> HandleLoadSymbols(BridgeRequest request)
    {
        if (_session == null)
        {
            return new BridgeResponse { Id = request.Id, Success = false, Error = "Session not initialized" };
        }

        var args = JsonSerializer.Deserialize<LoadSymbolsArgs>(request.Args?.ToString() ?? "{}", _jsonOptions);
        
        if (string.IsNullOrEmpty(args?.Path))
        {
            return new BridgeResponse { Id = request.Id, Success = false, Error = "Path is required" };
        }

        await Task.CompletedTask;
        
        int count;
        if (Directory.Exists(args.Path))
        {
            // Load from directory
            count = _session.LoadSymbolsFromDirectory(args.Path, args.Recursive ?? true);
        }
        else if (File.Exists(args.Path))
        {
            // Load single file
            count = _session.LoadSymbols(args.Path) ? 1 : 0;
        }
        else
        {
            return new BridgeResponse 
            { 
                Id = request.Id, 
                Success = false, 
                Error = $"Path not found: {args.Path}" 
            };
        }

        return new BridgeResponse 
        { 
            Id = request.Id, 
            Success = count > 0,
            Data = new { SymbolsLoaded = count }
        };
    }

    #endregion

    #region Output Methods

    private static void SendResponse(BridgeResponse response)
    {
        var json = JsonSerializer.Serialize(response, _jsonOptions);
        Console.WriteLine(json);
    }

    private static void SendEvent(object? sender, BridgeEvent evt)
    {
        var json = JsonSerializer.Serialize(evt, _jsonOptions);
        Console.WriteLine(json);
    }

    private static void SendError(int requestId, string message)
    {
        var response = new BridgeResponse
        {
            Id = requestId,
            Success = false,
            Error = message
        };
        SendResponse(response);
    }

    #endregion
}
