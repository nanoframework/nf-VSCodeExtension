/*---------------------------------------------------------------------------------------------
 * Copyright (c) .NET Foundation and Contributors.
 * Portions Copyright (c) Microsoft Corporation.  All rights reserved.
 * See LICENSE file in the project root for full license information.
 *--------------------------------------------------------------------------------------------*/

using nanoFramework.Tools.Debugger;
using nanoFramework.Tools.Debugger.WireProtocol;
using nanoFramework.Tools.DebugBridge.Protocol;
using nanoFramework.Tools.DebugBridge.Symbols;
using WPCommands = nanoFramework.Tools.Debugger.WireProtocol.Commands;

namespace nanoFramework.Tools.DebugBridge;

/// <summary>
/// Result of a connect operation
/// </summary>
public record ConnectResult(bool Success, string? Error = null);

/// <summary>
/// Result of setting a breakpoint
/// </summary>
public record SetBreakpointResult(bool Success, int BreakpointId = 0, string? Error = null);

/// <summary>
/// Result of an evaluate operation
/// </summary>
public record EvaluateResult(bool Success, object? Value = null, string? Error = null);

/// <summary>
/// Result of a deploy operation
/// </summary>
public record DeployResult(bool Success, string? Error = null);

/// <summary>
/// Manages a debug session with a nanoFramework device.
/// This class wraps the nf-debugger library and provides a simplified interface
/// for the debug bridge protocol.
/// </summary>
public class DebugBridgeSession : IDisposable
{
    private PortBase? _portManager;
    private NanoDeviceBase? _device;
    private Engine? _engine;

    private bool _isConnected;
    private bool _disposed;
    private bool _verbose;
    
    // Symbol resolver for source mapping
    private readonly SymbolResolver _symbolResolver = new();
    
    // Assembly manager for tracking device/local assemblies
    private readonly AssemblyManager _assemblyManager = new();
    
    // Variable reference management
    private int _nextVariablesReference = 1;
    private readonly Dictionary<int, object> _variablesReferences = new();

    // Frame ID management  
    private int _nextFrameId = 1;
    private readonly Dictionary<int, (int ThreadId, int Depth)> _frameIdMap = new();

    // Breakpoint management
    private int _nextBreakpointId = 1;
    private readonly Dictionary<int, BreakpointInfo> _breakpoints = new();
    private readonly List<WPCommands.Debugging_Execution_BreakpointDef> _activeBreakpointDefs = new();

    // Current execution state
    private uint[]? _lastThreadList;
    private uint _stoppedThreadId;

    /// <summary>
    /// Event raised when a debug event occurs (stopped, thread, output, etc.)
    /// </summary>
    public event EventHandler<BridgeEvent>? OnEvent;

    /// <summary>
    /// Enable or disable verbose logging
    /// </summary>
    public void SetVerbose(bool verbose)
    {
        _verbose = verbose;
    }

    /// <summary>
    /// Connect to a nanoFramework device
    /// </summary>
    /// <param name="device">Device path (COM port, IP address, etc.)</param>
    /// <param name="baudRate">Baud rate for serial connections</param>
    /// <returns>Result indicating success or failure</returns>
    public async Task<ConnectResult> Connect(string device, int baudRate = 921600)
    {
        try
        {
            LogMessage($"Connecting to device: {device} at baud rate {baudRate}");

            // Determine if this is a serial or network connection
            bool isNetworkConnection = device.Contains(':') && !device.StartsWith("COM", StringComparison.OrdinalIgnoreCase);
            
            if (isNetworkConnection)
            {
                // TCP/IP connection
                _portManager = PortBase.CreateInstanceForNetwork(true);
            }
            else
            {
                // Serial connection
                _portManager = PortBase.CreateInstanceForSerial(
                    startDeviceWatchers: false, // We'll manually connect
                    portExclusionList: null,
                    bootTime: 1000);
            }

            // Wait for device enumeration
            var waitForEnumeration = Task.Run(async () =>
            {
                while (!_portManager.IsDevicesEnumerationComplete)
                {
                    await Task.Delay(100);
                }
            });

            // Start device scanning
            _portManager.StartDeviceWatchers();
            
            // Wait for enumeration with timeout
            if (await Task.WhenAny(waitForEnumeration, Task.Delay(5000)) != waitForEnumeration)
            {
                LogMessage("Device enumeration timed out, attempting direct connection...");
            }

            // Find the device
            _device = _portManager.NanoFrameworkDevices.FirstOrDefault(d => 
                d.ConnectionId?.Contains(device, StringComparison.OrdinalIgnoreCase) == true ||
                d.Description?.Contains(device, StringComparison.OrdinalIgnoreCase) == true);

            if (_device == null)
            {
                // Try direct connection if device not found in enumeration
                LogMessage($"Device not found in enumeration, checking available devices...");
                
                foreach (var dev in _portManager.NanoFrameworkDevices)
                {
                    LogMessage($"  Available: {dev.Description} ({dev.ConnectionId})");
                }

                return new ConnectResult(false, $"Device '{device}' not found. Make sure it's connected and running nanoFramework.");
            }

            LogMessage($"Found device: {_device.Description}");

            // Create debug engine
            _device.CreateDebugEngine();
            _engine = _device.DebugEngine;

            if (_engine == null)
            {
                return new ConnectResult(false, "Failed to create debug engine");
            }

            // Configure debug engine
            _engine.StopDebuggerOnConnect = true;
            _engine.Silent = false;

            // Subscribe to debug engine events
            _engine.OnMessage += OnEngineMessage;

            // Connect to the device
            LogMessage("Connecting to debug engine...");
            bool connected = _engine.Connect(5000, true, true);

            if (!connected)
            {
                return new ConnectResult(false, "Failed to connect to device debug engine");
            }

            // Update debug flags to enable source-level debugging
            LogMessage("Enabling source-level debugging...");
            _engine.UpdateDebugFlags();

            _isConnected = true;
            
            // Send initialized event
            RaiseEvent("initialized", new { });
            
            LogMessage("Connected successfully!");
            return new ConnectResult(true);
        }
        catch (Exception ex)
        {
            LogMessage($"Connection error: {ex.Message}");
            return new ConnectResult(false, ex.Message);
        }
    }

    /// <summary>
    /// Disconnect from the device
    /// </summary>
    public async Task Disconnect()
    {
        try
        {
            if (_engine != null)
            {
                // Unsubscribe from events
                _engine.OnMessage -= OnEngineMessage;
                
                _engine.Stop();
                _engine.Dispose();
                _engine = null;
            }

            if (_device != null)
            {
                _device.Disconnect(true);
                _device = null;
            }

            if (_portManager != null)
            {
                _portManager.StopDeviceWatchers();
                _portManager = null;
            }
        }
        catch (Exception ex)
        {
            LogMessage($"Disconnect error: {ex.Message}");
        }
        
        await Task.CompletedTask;
        _isConnected = false;
        
        ClearState();
    }

    /// <summary>
    /// Set a breakpoint at the specified location
    /// </summary>
    public async Task<SetBreakpointResult> SetBreakpoint(string file, int line, string? condition = null)
    {
        if (!_isConnected || _engine == null)
        {
            return new SetBreakpointResult(false, Error: "Not connected");
        }

        try
        {
            LogMessage($"Setting breakpoint at {file}:{line}");
            
            var breakpointId = _nextBreakpointId++;
            
            // Try to resolve the source location to an IL offset using loaded symbols
            var bpLocation = _symbolResolver.GetBreakpointLocation(file, line);
            
            BreakpointInfo breakpoint;
            
            if (bpLocation != null)
            {
                // Symbols found - create a verified breakpoint
                LogMessage($"Symbol resolved: assembly={bpLocation.AssemblyName}, token={bpLocation.MethodToken:X8}, IL={bpLocation.ILOffset}");
                
                breakpoint = new BreakpointInfo
                {
                    Id = breakpointId,
                    Verified = true,
                    Line = bpLocation.Line,
                    Source = new SourceInfo { Path = bpLocation.SourceFile ?? file, Name = Path.GetFileName(file) }
                };
                
                // Create the breakpoint definition for the device
                var bpDef = new WPCommands.Debugging_Execution_BreakpointDef
                {
                    m_id = (short)breakpointId,
                    m_flags = WPCommands.Debugging_Execution_BreakpointDef.c_HARD,
                    m_md = bpLocation.MethodToken,
                    m_IP = bpLocation.ILOffset,
                    m_pid = WPCommands.Debugging_Execution_BreakpointDef.c_PID_ANY,
                    m_depth = 0
                };
                _activeBreakpointDefs.Add(bpDef);
                
                // Set breakpoints on the device
                bool success = _engine.SetBreakpoints(_activeBreakpointDefs.ToArray());
                if (!success)
                {
                    LogMessage("Warning: Failed to set breakpoint on device");
                    breakpoint.Verified = false;
                    breakpoint.Message = "Failed to set breakpoint on device";
                }
            }
            else
            {
                // No symbols - create an unverified breakpoint (pending)
                LogMessage("No symbols found for source location, breakpoint pending");
                
                breakpoint = new BreakpointInfo
                {
                    Id = breakpointId,
                    Verified = false,
                    Line = line,
                    Source = new SourceInfo { Path = file, Name = Path.GetFileName(file) },
                    Message = "Breakpoint pending - symbols not loaded"
                };
            }
            
            _breakpoints[breakpointId] = breakpoint;

            await Task.CompletedTask;
            
            // Send breakpoint event
            RaiseEvent("breakpoint", new BreakpointEventBody
            {
                Reason = "changed",
                Breakpoint = breakpoint
            });
            
            return new SetBreakpointResult(true, breakpointId);
        }
        catch (Exception ex)
        {
            LogMessage($"SetBreakpoint error: {ex.Message}");
            return new SetBreakpointResult(false, Error: ex.Message);
        }
    }

    /// <summary>
    /// Remove a breakpoint
    /// </summary>
    public async Task<bool> RemoveBreakpoint(int breakpointId)
    {
        if (!_isConnected || _engine == null)
        {
            return false;
        }

        try
        {
            LogMessage($"Removing breakpoint {breakpointId}");
            
            if (_breakpoints.Remove(breakpointId))
            {
                // Remove from active breakpoint definitions
                _activeBreakpointDefs.RemoveAll(bp => bp.m_id == breakpointId);
                
                // Update breakpoints on device (send empty array if none left, or updated list)
                if (_activeBreakpointDefs.Count > 0)
                {
                    _engine.SetBreakpoints(_activeBreakpointDefs.ToArray());
                }
                else
                {
                    // Clear all breakpoints
                    _engine.SetBreakpoints(Array.Empty<WPCommands.Debugging_Execution_BreakpointDef>());
                }
                
                await Task.CompletedTask;
                return true;
            }
            
            return false;
        }
        catch (Exception ex)
        {
            LogMessage($"RemoveBreakpoint error: {ex.Message}");
            return false;
        }
    }

    /// <summary>
    /// Continue execution
    /// </summary>
    public async Task<bool> Continue(int threadId)
    {
        if (!_isConnected || _engine == null)
        {
            return false;
        }

        try
        {
            LogMessage($"Continuing execution (thread {threadId})");
            
            // Resume execution using Wire Protocol
            bool success = _engine.ResumeExecution();
            
            if (success)
            {
                LogMessage("Execution resumed");
            }
            else
            {
                LogMessage("Failed to resume execution");
            }
            
            await Task.CompletedTask;
            return success;
        }
        catch (Exception ex)
        {
            LogMessage($"Continue error: {ex.Message}");
            return false;
        }
    }

    /// <summary>
    /// Pause execution
    /// </summary>
    public async Task<bool> Pause(int threadId)
    {
        if (!_isConnected || _engine == null)
        {
            return false;
        }

        try
        {
            LogMessage($"Pausing execution (thread {threadId})");
            
            // Pause execution using Wire Protocol
            bool success = _engine.PauseExecution();
            
            if (success)
            {
                LogMessage("Execution paused");
                
                // Get thread list to find stopped thread
                _lastThreadList = _engine.GetThreadList();
                _stoppedThreadId = threadId > 0 ? (uint)threadId : (_lastThreadList?.FirstOrDefault() ?? 1u);
                
                // Notify that execution stopped
                RaiseEvent("stopped", new StoppedEventBody
                {
                    Reason = "pause",
                    ThreadId = (int)_stoppedThreadId,
                    AllThreadsStopped = true
                });
            }
            else
            {
                LogMessage("Failed to pause execution");
            }
            
            await Task.CompletedTask;
            return success;
        }
        catch (Exception ex)
        {
            LogMessage($"Pause error: {ex.Message}");
            return false;
        }
    }

    /// <summary>
    /// Step over (next line)
    /// </summary>
    public async Task<bool> StepOver(int threadId)
    {
        if (!_isConnected || _engine == null)
        {
            return false;
        }

        try
        {
            LogMessage($"Step over (thread {threadId})");
            
            // Get current stack frame to set stepping breakpoint
            uint pid = threadId > 0 ? (uint)threadId : _stoppedThreadId;
            var stack = _engine.GetThreadStack(pid);
            
            if (stack == null || stack.m_data == null || stack.m_data.Length == 0)
            {
                LogMessage("Could not get thread stack for stepping");
                return false;
            }

            var currentFrame = stack.m_data[0];
            
            // Create step over breakpoint
            var stepBp = new WPCommands.Debugging_Execution_BreakpointDef
            {
                m_id = -1, // Stepping breakpoint
                m_flags = WPCommands.Debugging_Execution_BreakpointDef.c_STEP_OVER,
                m_pid = pid,
                m_depth = WPCommands.Debugging_Execution_BreakpointDef.c_DEPTH_STEP_NORMAL,
                m_md = currentFrame.m_md,
                m_IP = currentFrame.m_IP
            };
            
            // Set the stepping breakpoint and resume
            var allBreakpoints = _activeBreakpointDefs.ToList();
            allBreakpoints.Add(stepBp);
            _engine.SetBreakpoints(allBreakpoints.ToArray());
            
            // Resume execution
            _engine.ResumeExecution();
            
            // The device will hit the stepping breakpoint and we'll get a breakpoint hit notification
            // For now, simulate the stop after step
            await Task.Delay(100);
            
            // Check for breakpoint hit
            var bpStatus = _engine.GetBreakpointStatus();
            if (bpStatus != null)
            {
                LogMessage($"Step completed at IP: 0x{bpStatus.m_IP:X4}");
            }
            
            // Pause and notify
            _engine.PauseExecution();
            
            RaiseEvent("stopped", new StoppedEventBody
            {
                Reason = "step",
                ThreadId = (int)pid,
                AllThreadsStopped = true
            });
            
            await Task.CompletedTask;
            return true;
        }
        catch (Exception ex)
        {
            LogMessage($"StepOver error: {ex.Message}");
            return false;
        }
    }

    /// <summary>
    /// Step into (enter function)
    /// </summary>
    public async Task<bool> StepIn(int threadId)
    {
        if (!_isConnected || _engine == null)
        {
            return false;
        }

        try
        {
            LogMessage($"Step into (thread {threadId})");
            
            uint pid = threadId > 0 ? (uint)threadId : _stoppedThreadId;
            var stack = _engine.GetThreadStack(pid);
            
            if (stack == null || stack.m_data == null || stack.m_data.Length == 0)
            {
                LogMessage("Could not get thread stack for stepping");
                return false;
            }

            var currentFrame = stack.m_data[0];
            
            // Create step into breakpoint
            var stepBp = new WPCommands.Debugging_Execution_BreakpointDef
            {
                m_id = -1,
                m_flags = WPCommands.Debugging_Execution_BreakpointDef.c_STEP_IN,
                m_pid = pid,
                m_depth = WPCommands.Debugging_Execution_BreakpointDef.c_DEPTH_STEP_CALL,
                m_md = currentFrame.m_md,
                m_IP = currentFrame.m_IP
            };
            
            var allBreakpoints = _activeBreakpointDefs.ToList();
            allBreakpoints.Add(stepBp);
            _engine.SetBreakpoints(allBreakpoints.ToArray());
            
            _engine.ResumeExecution();
            
            await Task.Delay(100);
            
            _engine.PauseExecution();
            
            RaiseEvent("stopped", new StoppedEventBody
            {
                Reason = "step",
                ThreadId = (int)pid,
                AllThreadsStopped = true
            });
            
            await Task.CompletedTask;
            return true;
        }
        catch (Exception ex)
        {
            LogMessage($"StepIn error: {ex.Message}");
            return false;
        }
    }

    /// <summary>
    /// Step out (return from function)
    /// </summary>
    public async Task<bool> StepOut(int threadId)
    {
        if (!_isConnected || _engine == null)
        {
            return false;
        }

        try
        {
            LogMessage($"Step out (thread {threadId})");
            
            uint pid = threadId > 0 ? (uint)threadId : _stoppedThreadId;
            var stack = _engine.GetThreadStack(pid);
            
            if (stack == null || stack.m_data == null || stack.m_data.Length == 0)
            {
                LogMessage("Could not get thread stack for stepping");
                return false;
            }

            var currentFrame = stack.m_data[0];
            
            // Create step out breakpoint
            var stepBp = new WPCommands.Debugging_Execution_BreakpointDef
            {
                m_id = -1,
                m_flags = WPCommands.Debugging_Execution_BreakpointDef.c_STEP_OUT,
                m_pid = pid,
                m_depth = WPCommands.Debugging_Execution_BreakpointDef.c_DEPTH_STEP_RETURN,
                m_md = currentFrame.m_md,
                m_IP = currentFrame.m_IP
            };
            
            var allBreakpoints = _activeBreakpointDefs.ToList();
            allBreakpoints.Add(stepBp);
            _engine.SetBreakpoints(allBreakpoints.ToArray());
            
            _engine.ResumeExecution();
            
            await Task.Delay(100);
            
            _engine.PauseExecution();
            
            RaiseEvent("stopped", new StoppedEventBody
            {
                Reason = "step",
                ThreadId = (int)pid,
                AllThreadsStopped = true
            });
            
            await Task.CompletedTask;
            return true;
        }
        catch (Exception ex)
        {
            LogMessage($"StepOut error: {ex.Message}");
            return false;
        }
    }

    /// <summary>
    /// Get list of threads
    /// </summary>
    public async Task<List<ThreadInfo>> GetThreads()
    {
        var threads = new List<ThreadInfo>();
        
        if (!_isConnected || _engine == null)
        {
            return threads;
        }

        try
        {
            LogMessage("Getting thread list...");
            
            // Get thread list from device
            _lastThreadList = _engine.GetThreadList();
            
            if (_lastThreadList != null)
            {
                foreach (var pid in _lastThreadList)
                {
                    // Get thread stack to determine thread status
                    var stack = _engine.GetThreadStack(pid);
                    
                    string threadName;
                    if (stack != null && stack.m_data != null && stack.m_data.Length > 0)
                    {
                        // Try to get method name for top frame
                        var topFrame = stack.m_data[0];
                        var methodName = _engine.GetMethodName(topFrame.m_md, false);
                        threadName = !string.IsNullOrEmpty(methodName) 
                            ? $"Thread {pid} ({methodName})" 
                            : $"Thread {pid}";
                    }
                    else
                    {
                        threadName = $"Thread {pid}";
                    }
                    
                    threads.Add(new ThreadInfo { Id = (int)pid, Name = threadName });
                }
                
                LogMessage($"Found {threads.Count} threads");
            }
            else
            {
                LogMessage("No threads found, adding default main thread");
                threads.Add(new ThreadInfo { Id = 1, Name = "Main Thread" });
            }
        }
        catch (Exception ex)
        {
            LogMessage($"GetThreads error: {ex.Message}");
            // Return at least a main thread placeholder
            threads.Add(new ThreadInfo { Id = 1, Name = "Main Thread" });
        }

        await Task.CompletedTask;
        return threads;
    }

    /// <summary>
    /// Get stack trace for a thread
    /// </summary>
    public async Task<List<StackFrameInfo>> GetStackTrace(int threadId, int startFrame, int levels)
    {
        var frames = new List<StackFrameInfo>();
        
        if (!_isConnected || _engine == null)
        {
            return frames;
        }

        try
        {
            LogMessage($"Getting stack trace for thread {threadId}...");
            
            // Get thread stack from device
            var stack = _engine.GetThreadStack((uint)threadId);
            
            if (stack != null && stack.m_data != null)
            {
                int endFrame = levels > 0 
                    ? Math.Min(startFrame + levels, stack.m_data.Length) 
                    : stack.m_data.Length;
                
                LogMessage($"Stack has {stack.m_data.Length} frames, returning {startFrame} to {endFrame}");
                
                for (int i = startFrame; i < endFrame; i++)
                {
                    var frame = stack.m_data[i];
                    var frameId = _nextFrameId++;
                    _frameIdMap[frameId] = (threadId, i);
                    
                    // Get method name
                    var methodName = _engine.GetMethodName(frame.m_md, true) ?? $"Frame {i}";
                    
                    // Try to get source location from symbols
                    SourceInfo? sourceInfo = null;
                    int line = 0;
                    int column = 0;
                    
                    // Look up source location using the symbol resolver
                    // The method token from the device is the nanoFramework token
                    // We need to match it against our loaded .pdbx files
                    var sourceLocation = TryGetSourceLocationForFrame(frame.m_md, frame.m_IP);
                    
                    if (sourceLocation != null)
                    {
                        sourceInfo = new SourceInfo
                        {
                            Path = sourceLocation.SourceFile,
                            Name = Path.GetFileName(sourceLocation.SourceFile)
                        };
                        line = sourceLocation.Line;
                        column = sourceLocation.Column;
                        LogMessage($"Frame {i}: {methodName} at {sourceLocation.SourceFile}:{line}");
                    }
                    
                    var stackFrame = new StackFrameInfo
                    {
                        Id = frameId,
                        Name = methodName,
                        Source = sourceInfo,
                        Line = line,
                        Column = column
                    };
                    
                    frames.Add(stackFrame);
                }
            }
            else
            {
                LogMessage("Could not get stack trace from device");
                
                // Return placeholder frame
                var frameId = _nextFrameId++;
                _frameIdMap[frameId] = (threadId, 0);
                
                frames.Add(new StackFrameInfo
                {
                    Id = frameId,
                    Name = "Main()",
                    Line = 1,
                    Column = 1
                });
            }
        }
        catch (Exception ex)
        {
            LogMessage($"GetStackTrace error: {ex.Message}");
        }

        await Task.CompletedTask;
        return frames;
    }

    /// <summary>
    /// Get scopes for a stack frame
    /// </summary>
    public async Task<List<ScopeInfo>> GetScopes(int frameId)
    {
        var scopes = new List<ScopeInfo>();
        
        if (!_isConnected || _engine == null || !_frameIdMap.ContainsKey(frameId))
        {
            return scopes;
        }

        try
        {
            var (threadId, depth) = _frameIdMap[frameId];
            LogMessage($"Getting scopes for frame {frameId} (thread {threadId}, depth {depth})");
            
            // Get stack frame info to determine number of locals and arguments
            var (numArgs, numLocals, evalStackDepth, success) = _engine.GetStackFrameInfo((uint)threadId, (uint)depth);
            
            if (success)
            {
                LogMessage($"Frame has {numArgs} arguments, {numLocals} locals, eval stack depth {evalStackDepth}");
                
                // Create Locals scope
                var localsRef = _nextVariablesReference++;
                _variablesReferences[localsRef] = new ScopeReference 
                { 
                    Type = ScopeType.Locals, 
                    ThreadId = threadId, 
                    Depth = depth,
                    Count = (int)numLocals
                };
                scopes.Add(new ScopeInfo 
                { 
                    Name = "Locals", 
                    VariablesReference = localsRef, 
                    NamedVariables = (int)numLocals,
                    Expensive = false 
                });
                
                // Create Arguments scope if there are any
                if (numArgs > 0)
                {
                    var argsRef = _nextVariablesReference++;
                    _variablesReferences[argsRef] = new ScopeReference 
                    { 
                        Type = ScopeType.Arguments, 
                        ThreadId = threadId, 
                        Depth = depth,
                        Count = (int)numArgs
                    };
                    scopes.Add(new ScopeInfo 
                    { 
                        Name = "Arguments", 
                        VariablesReference = argsRef,
                        NamedVariables = (int)numArgs,
                        Expensive = false 
                    });
                }
            }
            else
            {
                LogMessage("Could not get stack frame info, using placeholders");
                
                // Placeholder scopes
                var localsRef = _nextVariablesReference++;
                _variablesReferences[localsRef] = new ScopeReference 
                { 
                    Type = ScopeType.Locals, 
                    ThreadId = threadId, 
                    Depth = depth 
                };
                scopes.Add(new ScopeInfo { Name = "Locals", VariablesReference = localsRef, Expensive = false });
            }
        }
        catch (Exception ex)
        {
            LogMessage($"GetScopes error: {ex.Message}");
        }

        await Task.CompletedTask;
        return scopes;
    }

    /// <summary>
    /// Get variables for a scope or parent variable
    /// </summary>
    public async Task<List<VariableInfo>> GetVariables(int variablesReference, int? start, int? count)
    {
        var variables = new List<VariableInfo>();
        
        if (!_isConnected || _engine == null || !_variablesReferences.ContainsKey(variablesReference))
        {
            return variables;
        }

        try
        {
            var reference = _variablesReferences[variablesReference];
            
            if (reference is ScopeReference scopeRef)
            {
                LogMessage($"Getting variables for {scopeRef.Type} scope (thread {scopeRef.ThreadId}, depth {scopeRef.Depth})");
                
                int startIndex = start ?? 0;
                int maxCount = count ?? scopeRef.Count;
                
                for (int i = startIndex; i < Math.Min(startIndex + maxCount, scopeRef.Count); i++)
                {
                    Engine.StackValueKind kind = scopeRef.Type == ScopeType.Arguments 
                        ? Engine.StackValueKind.Argument 
                        : Engine.StackValueKind.Local;
                    
                    try
                    {
                        var runtimeValue = _engine.GetStackFrameValue(
                            (uint)scopeRef.ThreadId, 
                            (uint)scopeRef.Depth, 
                            kind, 
                            (uint)i);
                        
                        if (runtimeValue != null)
                        {
                            var varInfo = CreateVariableInfo(runtimeValue, $"[{i}]");
                            variables.Add(varInfo);
                        }
                        else
                        {
                            variables.Add(new VariableInfo
                            {
                                Name = scopeRef.Type == ScopeType.Arguments ? $"arg{i}" : $"local{i}",
                                Value = "<unavailable>",
                                Type = "unknown",
                                VariablesReference = 0
                            });
                        }
                    }
                    catch (Exception ex)
                    {
                        LogMessage($"Error getting variable {i}: {ex.Message}");
                        variables.Add(new VariableInfo
                        {
                            Name = scopeRef.Type == ScopeType.Arguments ? $"arg{i}" : $"local{i}",
                            Value = "<error>",
                            Type = "unknown",
                            VariablesReference = 0
                        });
                    }
                }
            }
            else if (reference is RuntimeValueReference rvRef)
            {
                // Expanding a complex object
                LogMessage("Expanding runtime value children");
                
                // TODO: Implement child retrieval using Debugging_Value_GetField
                // This requires understanding the object's type and fields
                variables.Add(new VariableInfo
                {
                    Name = "...",
                    Value = "<expansion not yet implemented>",
                    Type = "",
                    VariablesReference = 0
                });
            }
        }
        catch (Exception ex)
        {
            LogMessage($"GetVariables error: {ex.Message}");
        }

        await Task.CompletedTask;
        return variables;
    }

    private VariableInfo CreateVariableInfo(RuntimeValue runtimeValue, string defaultName)
    {
        string name = defaultName;
        string value;
        string typeName = "object";
        int childRef = 0;
        
        try
        {
            // Try to resolve the type name
            if (_engine != null && runtimeValue.Type != 0)
            {
                var typeInfo = _engine.ResolveType(runtimeValue.Type);
                if (typeInfo != null)
                {
                    typeName = typeInfo.m_name ?? "object";
                }
            }
        }
        catch
        {
            // Use default type name on error
        }
        
        // Format the value based on its type
        if (runtimeValue.IsNull)
        {
            value = "null";
        }
        else if (runtimeValue.IsPrimitive)
        {
            value = runtimeValue.Value?.ToString() ?? "null";
        }
        else if (runtimeValue.IsValueType)
        {
            value = $"{{{typeName}}}";
            // If it has fields, allow expansion
            if (runtimeValue.NumOfFields > 0)
            {
                childRef = _nextVariablesReference++;
                _variablesReferences[childRef] = new RuntimeValueReference { Value = runtimeValue };
            }
        }
        else if (runtimeValue.IsArrayReference || runtimeValue.IsArray)
        {
            uint length = runtimeValue.Length;
            value = $"{typeName}[{length}]";
            if (length > 0)
            {
                childRef = _nextVariablesReference++;
                _variablesReferences[childRef] = new RuntimeValueReference { Value = runtimeValue };
            }
        }
        else if (runtimeValue.IsBoxed)
        {
            value = $"boxed {runtimeValue.Value}";
        }
        else
        {
            // Reference type
            value = $"{{{typeName}}}";
            if (runtimeValue.NumOfFields > 0)
            {
                childRef = _nextVariablesReference++;
                _variablesReferences[childRef] = new RuntimeValueReference { Value = runtimeValue };
            }
        }
        
        return new VariableInfo
        {
            Name = name,
            Value = value,
            Type = typeName,
            VariablesReference = childRef
        };
    }

    /// <summary>
    /// Evaluate an expression
    /// </summary>
    public async Task<EvaluateResult> Evaluate(string expression, int? frameId, string? context)
    {
        if (!_isConnected)
        {
            return new EvaluateResult(false, Error: "Not connected");
        }

        try
        {
            // TODO: Implement expression evaluation
            // This is complex and may require:
            // 1. Parsing the expression
            // 2. Looking up variables in scope
            // 3. Using Debugging_Value_* commands to read values
            // 4. For method calls, potentially using Debugging_Thread_CreateVirtual
            
            await Task.CompletedTask;
            
            // Placeholder
            return new EvaluateResult(true, $"Evaluated: {expression}");
        }
        catch (Exception ex)
        {
            return new EvaluateResult(false, Error: ex.Message);
        }
    }

    /// <summary>
    /// Deploy assemblies to the device
    /// </summary>
    public async Task<DeployResult> Deploy(string assembliesPath)
    {
        if (!_isConnected)
        {
            return new DeployResult(false, "Not connected");
        }

        try
        {
            // TODO: Implement deployment using nf-debugger deployment APIs
            // var assemblies = Directory.GetFiles(assembliesPath, "*.pe");
            // foreach (var assembly in assemblies)
            // {
            //     var data = File.ReadAllBytes(assembly);
            //     await _engine.DeployAsync(data);
            // }
            
            await Task.CompletedTask;
            
            // Send progress events
            RaiseEvent("output", new OutputEventBody
            {
                Category = "console",
                Output = $"Deploying assemblies from {assembliesPath}...\n"
            });
            
            return new DeployResult(true);
        }
        catch (Exception ex)
        {
            return new DeployResult(false, ex.Message);
        }
    }

    /// <summary>
    /// Reboot the device
    /// </summary>
    public async Task<bool> Reboot(bool clrOnly)
    {
        if (!_isConnected || _engine == null)
        {
            return false;
        }

        try
        {
            LogMessage($"Rebooting device (CLR only: {clrOnly})");
            
            var rebootOption = clrOnly 
                ? RebootOptions.ClrOnly 
                : RebootOptions.NormalReboot;
                
            _engine.RebootDevice(rebootOption);
            
            await Task.CompletedTask;
            return true;
        }
        catch (Exception ex)
        {
            LogMessage($"Reboot error: {ex.Message}");
            return false;
        }
    }

    private void LogMessage(string message)
    {
        // Send log message as output event
        RaiseEvent("output", new OutputEventBody
        {
            Category = "console",
            Output = $"[nF-Debug] {message}\n"
        });
        
        // Also write to stderr for debugging
        Console.Error.WriteLine($"[DebugBridge] {message}");
    }

    private void ClearState()
    {
        _variablesReferences.Clear();
        _frameIdMap.Clear();
        _breakpoints.Clear();
        _nextVariablesReference = 1;
        _nextFrameId = 1;
        _nextBreakpointId = 1;
    }

    private void RaiseEvent(string eventName, object? body)
    {
        OnEvent?.Invoke(this, new BridgeEvent
        {
            Event = eventName,
            Body = body
        });
    }

    /// <summary>
    /// Handle debug output from the nanoFramework device engine
    /// This captures Debug.WriteLine, Console.WriteLine, and other debug output
    /// </summary>
    private void OnEngineMessage(IncomingMessage message, string text)
    {
        if (!string.IsNullOrEmpty(text))
        {
            // Send output to debug console
            RaiseEvent("output", new OutputEventBody
            {
                Category = "stdout",
                Output = text + "\n"
            });
        }
    }

    #region Symbol Resolution

    /// <summary>
    /// Load symbols from a .pdbx file
    /// </summary>
    /// <param name="pdbxPath">Path to the .pdbx file</param>
    /// <returns>True if symbols were loaded successfully</returns>
    public bool LoadSymbols(string pdbxPath)
    {
        LogMessage($"Loading symbols from {pdbxPath}");
        bool result = _symbolResolver.LoadSymbols(pdbxPath);
        if (result)
        {
            LogMessage($"Symbols loaded successfully");
            // After loading symbols, try to verify any pending breakpoints
            RebindPendingBreakpoints();
        }
        else
        {
            LogMessage($"Failed to load symbols from {pdbxPath}");
        }
        return result;
    }

    /// <summary>
    /// Load symbols from all .pdbx files in a directory
    /// </summary>
    /// <param name="directory">Directory containing .pdbx files</param>
    /// <param name="recursive">Whether to search recursively</param>
    /// <returns>Number of symbol files loaded</returns>
    public int LoadSymbolsFromDirectory(string directory, bool recursive = true)
    {
        LogMessage($"Loading symbols from directory {directory} (recursive={recursive})");
        
        // Add this directory to assembly manager search paths and scan
        _assemblyManager.AddSearchPath(directory);
        _assemblyManager.ScanLocalAssemblies();
        LogMessage($"Found {_assemblyManager.GetLocalAssemblies().Count()} local assemblies");
        
        int count = _symbolResolver.LoadSymbolsFromDirectory(directory, recursive);
        LogMessage($"Loaded {count} symbol file(s)");
        
        if (count > 0)
        {
            // After loading symbols, try to verify any pending breakpoints
            RebindPendingBreakpoints();
        }
        
        return count;
    }

    /// <summary>
    /// Get information about device and local assemblies
    /// </summary>
    public AssemblyManager GetAssemblyManager()
    {
        return _assemblyManager;
    }

    /// <summary>
    /// Try to rebind any unverified breakpoints using newly loaded symbols
    /// </summary>
    private void RebindPendingBreakpoints()
    {
        foreach (var kvp in _breakpoints)
        {
            var bp = kvp.Value;
            if (!bp.Verified && bp.Source?.Path != null && bp.Line.HasValue)
            {
                // Try to resolve this breakpoint
                var location = _symbolResolver.GetBreakpointLocation(bp.Source.Path, bp.Line.Value);
                if (location != null)
                {
                    LogMessage($"Rebinding breakpoint {bp.Id} at {bp.Source.Path}:{bp.Line}");
                    
                    bp.Verified = true;
                    bp.Message = null;
                    
                    // Create the breakpoint definition for the device
                    var bpDef = new WPCommands.Debugging_Execution_BreakpointDef
                    {
                        m_id = (short)bp.Id,
                        m_flags = WPCommands.Debugging_Execution_BreakpointDef.c_HARD,
                        m_md = location.MethodToken,
                        m_IP = location.ILOffset,
                        m_pid = WPCommands.Debugging_Execution_BreakpointDef.c_PID_ANY,
                        m_depth = 0
                    };
                    _activeBreakpointDefs.Add(bpDef);
                    
                    // Update on device if connected
                    if (_isConnected && _engine != null)
                    {
                        _engine.SetBreakpoints(_activeBreakpointDefs.ToArray());
                    }
                    
                    // Notify about the verified breakpoint
                    RaiseEvent("breakpoint", new BreakpointEventBody
                    {
                        Reason = "changed",
                        Breakpoint = bp
                    });
                }
            }
        }
    }

    /// <summary>
    /// Try to get source location for a stack frame
    /// </summary>
    private SourceLocation? TryGetSourceLocationForFrame(uint methodToken, uint ilOffset)
    {
        // The method token from the device includes information about which assembly it belongs to
        // In nanoFramework, the high bits of the token encode the assembly index
        // For now, we search all loaded symbols to find a matching method
        
        // First try using the assembly name from the method resolution
        foreach (var assemblyName in _symbolResolver.GetLoadedAssemblies())
        {
            var location = _symbolResolver.GetSourceLocation(assemblyName, methodToken, ilOffset);
            if (location != null)
            {
                return location;
            }
        }
        
        return null;
    }

    #endregion

    public void Dispose()
    {
        if (!_disposed)
        {
            _symbolResolver.Dispose();
            _assemblyManager.Dispose();
            Disconnect().Wait();
            _disposed = true;
        }
    }
}

/// <summary>
/// Type of scope for variable retrieval
/// </summary>
internal enum ScopeType
{
    Locals,
    Arguments,
    EvalStack
}

/// <summary>
/// Reference to a scope for lazy variable loading
/// </summary>
internal class ScopeReference
{
    public ScopeType Type { get; set; }
    public int ThreadId { get; set; }
    public int Depth { get; set; }
    public int Count { get; set; }
}

/// <summary>
/// Reference to a runtime value for expanding children
/// </summary>
internal class RuntimeValueReference
{
    public RuntimeValue? Value { get; set; }
}
