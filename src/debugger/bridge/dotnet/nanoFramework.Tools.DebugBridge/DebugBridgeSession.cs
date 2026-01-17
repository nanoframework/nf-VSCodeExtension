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
/// Data returned from successful evaluation
/// </summary>
public class EvaluateResultData
{
    public string Value { get; set; } = "";
    public string Type { get; set; } = "";
    public bool HasChildren { get; set; }
    public int VariablesReference { get; set; }
}

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
    private readonly Dictionary<int, (int ThreadId, int Depth, uint MethodToken, string? AssemblyName)> _frameIdMap = new();

    // Breakpoint management
    private int _nextBreakpointId = 1;
    private readonly Dictionary<int, BreakpointInfo> _breakpoints = new();
    private readonly List<WPCommands.Debugging_Execution_BreakpointDef> _activeBreakpointDefs = new();

    // Current execution state
    private uint[]? _lastThreadList;
    private uint _stoppedThreadId;
    private CancellationTokenSource? _breakpointPollCts;

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

            // Connect to the device with retries
            LogMessage("Connecting to debug engine...");
            bool connected = false;
            int maxRetries = 3;
            
            for (int attempt = 1; attempt <= maxRetries && !connected; attempt++)
            {
                if (attempt > 1)
                {
                    LogMessage($"Retry attempt {attempt}/{maxRetries}...");
                    await Task.Delay(1000); // Wait a bit before retry
                }
                
                try
                {
                    connected = _engine.Connect(5000, true, true);
                }
                catch (Exception ex)
                {
                    LogMessage($"Connect attempt {attempt} failed: {ex.Message}");
                }
            }

            if (!connected)
            {
                return new ConnectResult(false, "Failed to connect to device debug engine. Try resetting the device or unplugging and reconnecting it.");
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
            // Cancel any polling task
            _breakpointPollCts?.Cancel();
            _breakpointPollCts = null;
            
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
                // Get the assembly Idx from the device (already in shifted format: assembly_index << 16)
                var assemblyInfo = _assemblyManager.GetDeviceAssembly(bpLocation.AssemblyName);
                if (assemblyInfo != null)
                {
                    bpLocation.AssemblyIdx = (uint)assemblyInfo.DeviceIndex;
                    LogMessage($"Assembly '{bpLocation.AssemblyName}' has device Idx 0x{bpLocation.AssemblyIdx:X8}");
                }
                else
                {
                    // Try to find by assembly name without extension
                    var assemblyNameNoExt = Path.GetFileNameWithoutExtension(bpLocation.AssemblyName);
                    assemblyInfo = _assemblyManager.GetDeviceAssembly(assemblyNameNoExt);
                    if (assemblyInfo != null)
                    {
                        bpLocation.AssemblyIdx = (uint)assemblyInfo.DeviceIndex;
                        LogMessage($"Assembly '{assemblyNameNoExt}' has device Idx 0x{bpLocation.AssemblyIdx:X8}");
                    }
                    else
                    {
                        LogMessage($"WARNING: Could not find device Idx for assembly '{bpLocation.AssemblyName}'");
                        // Default to 0x10000 which is assembly index 1 (typical user assembly)
                        bpLocation.AssemblyIdx = 0x10000;
                    }
                }
                
                // Symbols found - create a verified breakpoint
                LogMessage($"Symbol resolved: assembly={bpLocation.AssemblyName}, pdbxToken=0x{bpLocation.MethodToken:X8}, deviceIndex=0x{bpLocation.DeviceMethodIndex:X8}, IL={bpLocation.ILOffset}");
                
                breakpoint = new BreakpointInfo
                {
                    Id = breakpointId,
                    Verified = true,
                    Line = bpLocation.Line,
                    Source = new SourceInfo { Path = bpLocation.SourceFile ?? file, Name = Path.GetFileName(file) }
                };
                
                // Create the breakpoint definition for the device
                // Use DeviceMethodIndex which combines assembly index with method row
                var bpDef = new WPCommands.Debugging_Execution_BreakpointDef
                {
                    m_id = (short)breakpointId,
                    m_flags = WPCommands.Debugging_Execution_BreakpointDef.c_HARD,
                    m_md = bpLocation.DeviceMethodIndex,  // Use device method index, not pdbx token
                    m_IP = bpLocation.ILOffset,
                    m_pid = WPCommands.Debugging_Execution_BreakpointDef.c_PID_ANY,
                    m_depth = 0
                };
                _activeBreakpointDefs.Add(bpDef);
                
                LogMessage($"Setting breakpoint on device: id={breakpointId}, md=0x{bpDef.m_md:X8}, IP={bpDef.m_IP}, flags=0x{bpDef.m_flags:X4}");
                LogMessage($"Total active breakpoints: {_activeBreakpointDefs.Count}");
                
                // Set breakpoints on the device
                bool success = _engine.SetBreakpoints(_activeBreakpointDefs.ToArray());
                LogMessage($"SetBreakpoints returned: {success}");
                
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
            
            // Cancel any existing polling task
            _breakpointPollCts?.Cancel();
            _breakpointPollCts = new CancellationTokenSource();
            
            // Resume execution using Wire Protocol
            bool success = _engine.ResumeExecution();
            
            if (success)
            {
                LogMessage("Execution resumed");
                
                // Start background task to poll for breakpoint hits
                _ = PollForBreakpointHitAsync(_breakpointPollCts.Token);
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
    /// Poll for breakpoint hits in the background
    /// </summary>
    private async Task PollForBreakpointHitAsync(CancellationToken cancellationToken)
    {
        try
        {
            // Give the device a moment to process the resume command
            await Task.Delay(100, cancellationToken);
            
            // Check if we're still stopped - might have hit a breakpoint immediately
            var initialState = _engine.GetExecutionMode();
            LogMessage($"Initial state after resume: {initialState}");
            
            // If still stopped, check if there's a breakpoint hit
            if (((uint)initialState & 0x80000000) != 0)
            {
                LogMessage("Device still stopped after resume - checking for breakpoint hit");
                
                var bpStatus = _engine.GetBreakpointStatus();
                if (bpStatus != null && bpStatus.m_id > 0)
                {
                    LogMessage($"Immediate breakpoint hit: id={bpStatus.m_id}, md=0x{bpStatus.m_md:X8}, IP=0x{bpStatus.m_IP:X4}");
                    
                    _lastThreadList = _engine.GetThreadList();
                    if (_lastThreadList != null && _lastThreadList.Length > 0)
                    {
                        _stoppedThreadId = _lastThreadList[0];
                    }
                    
                    RaiseEvent("stopped", new StoppedEventBody
                    {
                        Reason = "breakpoint",
                        ThreadId = (int)_stoppedThreadId,
                        AllThreadsStopped = true,
                        HitBreakpointIds = new[] { (int)bpStatus.m_id }
                    });
                    return;
                }
            }
            
            // Poll for when execution stops (breakpoint hit)
            LogMessage("Polling for breakpoint hit...");
            
            while (!cancellationToken.IsCancellationRequested && _isConnected && _engine != null)
            {
                await Task.Delay(50, cancellationToken);
                
                // Check execution state
                var state = _engine.GetExecutionMode();
                
                // State.Stopped = 0x80000000
                if (((uint)state & 0x80000000) != 0)
                {
                    LogMessage($"Device stopped (state={state}) - checking breakpoint status");
                    
                    // Check what caused the stop
                    var bpStatus = _engine.GetBreakpointStatus();
                    
                    if (bpStatus != null)
                    {
                        LogMessage($"Breakpoint hit: id={bpStatus.m_id}, md=0x{bpStatus.m_md:X8}, IP=0x{bpStatus.m_IP:X4}");
                        
                        // Get thread list to find the stopped thread
                        _lastThreadList = _engine.GetThreadList();
                        if (_lastThreadList != null && _lastThreadList.Length > 0)
                        {
                            _stoppedThreadId = _lastThreadList[0];
                        }
                        
                        // Notify VS Code that we hit a breakpoint
                        RaiseEvent("stopped", new StoppedEventBody
                        {
                            Reason = bpStatus.m_id > 0 ? "breakpoint" : "step",
                            ThreadId = (int)_stoppedThreadId,
                            AllThreadsStopped = true,
                            HitBreakpointIds = bpStatus.m_id > 0 ? new[] { (int)bpStatus.m_id } : null
                        });
                    }
                    else
                    {
                        // Stopped but no breakpoint - likely paused
                        _lastThreadList = _engine.GetThreadList();
                        if (_lastThreadList != null && _lastThreadList.Length > 0)
                        {
                            _stoppedThreadId = _lastThreadList[0];
                        }
                        
                        RaiseEvent("stopped", new StoppedEventBody
                        {
                            Reason = "pause",
                            ThreadId = (int)_stoppedThreadId,
                            AllThreadsStopped = true
                        });
                    }
                    
                    break; // Stop polling
                }
            }
        }
        catch (TaskCanceledException)
        {
            // Expected when cancellation is requested
        }
        catch (Exception ex)
        {
            LogMessage($"Breakpoint poll error: {ex.Message}");
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
            
            // Cancel polling task
            _breakpointPollCts?.Cancel();
            
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
    /// Step over (next line) - Uses device-level stepping like VS extension
    /// The device handles stepping using the c_STEP_OVER flag with stack depth tracking.
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
            
            // Get current stack frame
            uint pid = threadId > 0 ? (uint)threadId : _stoppedThreadId;
            var stack = _engine.GetThreadStack(pid);
            
            if (stack == null || stack.m_data == null || stack.m_data.Length == 0)
            {
                LogMessage("Could not get thread stack for stepping");
                return false;
            }

            // Find the first frame with symbols (user code)
            WPCommands.Debugging_Thread_Stack.Reply.Call? userFrame = null;
            string? assemblyName = null;
            int userFrameDepth = -1;
            
            for (int i = 0; i < stack.m_data.Length; i++)
            {
                var frame = stack.m_data[i];
                var asmName = GetAssemblyNameForToken(frame.m_md);
                var methodInfo = _symbolResolver.GetMethodInfo(asmName, frame.m_md);
                var methodName = _engine.GetMethodName(frame.m_md, true);
                
                LogMessage($"Frame {i}: md=0x{frame.m_md:X8}, IP=0x{frame.m_IP:X4}, method={methodName}, hasSymbols={methodInfo != null}");
                
                if (methodInfo != null)
                {
                    userFrame = frame;
                    assemblyName = asmName;
                    userFrameDepth = i;
                    break;
                }
            }
            
            if (userFrame == null || assemblyName == null)
            {
                // No user code found, just resume with a simple step
                LogMessage("No frame with symbols found, using simple step");
                return await PerformDeviceStepOver(pid, stack.m_data[0], 0);
            }
            
            LogMessage($"User frame at depth {userFrameDepth}: md=0x{userFrame.m_md:X8}, IP=0x{userFrame.m_IP:X4}");
            
            // Get current source line info for logging
            var currentLine = _symbolResolver.GetSourceLocation(assemblyName, userFrame.m_md, userFrame.m_IP);
            if (currentLine != null)
            {
                LogMessage($"Current location: {Path.GetFileName(currentLine.SourceFile)}:{currentLine.Line}");
            }
            
            // Use device-level stepping with c_STEP_OVER flag
            // The device will step over function calls and stop at next IL instruction
            // We track stack depth to ensure we stop at the right level
            return await PerformDeviceStepOver(pid, userFrame, (uint)userFrameDepth);
        }
        catch (Exception ex)
        {
            LogMessage($"StepOver error: {ex.Message}");
            return false;
        }
    }
    
    /// <summary>
    /// Perform device-level step over using c_STEP_OVER flag.
    /// The device does IL-level stepping, so we loop until we reach a different source line.
    /// </summary>
    private async Task<bool> PerformDeviceStepOver(uint pid, 
        WPCommands.Debugging_Thread_Stack.Reply.Call currentFrame, uint frameDepth)
    {
        LogMessage($"Device step over: pid={pid}, depth={frameDepth}, md=0x{currentFrame.m_md:X8}, IP=0x{currentFrame.m_IP:X4}");
        
        // Get the current source line - we'll keep stepping until we're on a different line
        var assemblyName = GetAssemblyNameForToken(currentFrame.m_md);
        var startLocation = _symbolResolver.GetSourceLocation(assemblyName, currentFrame.m_md, currentFrame.m_IP);
        int startLine = startLocation?.Line ?? -1;
        string? startFile = startLocation?.SourceFile;
        
        LogMessage($"Starting step from line {startLine} in {Path.GetFileName(startFile ?? "unknown")}");
        
        // Create step breakpoint using VS extension approach
        ushort stepFlags = (ushort)(
            WPCommands.Debugging_Execution_BreakpointDef.c_STEP_OVER |
            WPCommands.Debugging_Execution_BreakpointDef.c_STEP_OUT |
            WPCommands.Debugging_Execution_BreakpointDef.c_EXCEPTION_CAUGHT |
            WPCommands.Debugging_Execution_BreakpointDef.c_THREAD_TERMINATED);
        
        // Loop until we reach a different source line (source-level stepping)
        int maxSteps = 1000; // Safety limit to prevent infinite loops
        for (int stepCount = 0; stepCount < maxSteps; stepCount++)
        {
            // Get current frame state
            var stack = _engine.GetThreadStack(pid);
            if (stack == null || stack.m_data == null || stack.m_data.Length == 0)
            {
                LogMessage("Lost thread stack during step");
                break;
            }
            
            var frame = stack.m_data[0];
            
            var stepBp = new WPCommands.Debugging_Execution_BreakpointDef
            {
                m_id = -1,
                m_flags = stepFlags,
                m_pid = pid,
                m_depth = (uint)stack.m_data.Length - 1,  // Use actual current depth
                m_md = frame.m_md,
                m_IP = frame.m_IP,
                m_IPStart = 0,
                m_IPEnd = 0
            };
            
            // Add step breakpoint along with existing user breakpoints
            var allBreakpoints = _activeBreakpointDefs.ToList();
            allBreakpoints.Add(stepBp);
            _engine.SetBreakpoints(allBreakpoints.ToArray());
            
            // Resume execution
            _engine.ResumeExecution();
            
            // Wait for step to complete (IL-level)
            var (stopped, hitUserBreakpoint, userBpId) = await WaitForSingleILStep(pid);
            
            if (!stopped)
            {
                LogMessage("Step did not complete");
                break;
            }
            
            if (hitUserBreakpoint)
            {
                // Hit a user breakpoint - stop here
                LogMessage($"Hit user breakpoint {userBpId} during step");
                _engine.SetBreakpoints(_activeBreakpointDefs.ToArray());
                RaiseEvent("stopped", new StoppedEventBody
                {
                    Reason = "breakpoint",
                    ThreadId = (int)pid,
                    AllThreadsStopped = true,
                    HitBreakpointIds = new[] { userBpId }
                });
                return true;
            }
            
            // Check if we're now on a different source line
            var newStack = _engine.GetThreadStack(pid);
            if (newStack == null || newStack.m_data == null || newStack.m_data.Length == 0)
            {
                LogMessage("Lost thread stack after step");
                break;
            }
            
            var newFrame = newStack.m_data[0];
            var newAssemblyName = GetAssemblyNameForToken(newFrame.m_md);
            var newLocation = _symbolResolver.GetSourceLocation(newAssemblyName, newFrame.m_md, newFrame.m_IP);
            int newLine = newLocation?.Line ?? -1;
            string? newFile = newLocation?.SourceFile;
            
            // Check if we've moved to a different source line
            bool differentLine = (newLine != startLine) || 
                                 (newFile != startFile) ||
                                 (newFrame.m_md != currentFrame.m_md);  // Different method
            
            // Also check if stack depth changed (stepped into or out of a method)
            bool depthChanged = newStack.m_data.Length != (frameDepth + 1);
            
            if (differentLine || depthChanged || newLine < 0)
            {
                LogMessage($"Step complete: moved from line {startLine} to line {newLine} (steps={stepCount + 1})");
                _engine.SetBreakpoints(_activeBreakpointDefs.ToArray());
                RaiseEvent("stopped", new StoppedEventBody
                {
                    Reason = "step",
                    ThreadId = (int)pid,
                    AllThreadsStopped = true
                });
                return true;
            }
            
            // Still on same line - continue stepping
            if (stepCount % 10 == 0)
            {
                LogMessage($"Still on line {newLine}, continuing (step {stepCount + 1}, IP=0x{newFrame.m_IP:X4})");
            }
        }
        
        // Safety limit reached or error
        LogMessage("Step limit reached or error");
        _engine.SetBreakpoints(_activeBreakpointDefs.ToArray());
        RaiseEvent("stopped", new StoppedEventBody
        {
            Reason = "step",
            ThreadId = (int)pid,
            AllThreadsStopped = true
        });
        return true;
    }
    
    /// <summary>
    /// Wait for a single IL-level step to complete.
    /// Returns (stopped, hitUserBreakpoint, userBpId)
    /// </summary>
    private async Task<(bool stopped, bool hitUserBreakpoint, int userBpId)> WaitForSingleILStep(uint pid)
    {
        await Task.Delay(20);
        
        for (int i = 0; i < 100; i++) // Up to 10 seconds
        {
            var state = _engine.GetExecutionMode();
            bool isStopped = (state & WPCommands.DebuggingExecutionChangeConditions.State.Stopped) != 0;
            
            if (isStopped)
            {
                var bpStatus = _engine.GetBreakpointStatus();
                if (bpStatus != null)
                {
                    // Check if we hit a user breakpoint
                    if (bpStatus.m_id > 0 && _activeBreakpointDefs.Any(bp => bp.m_id == bpStatus.m_id))
                    {
                        return (true, true, (int)bpStatus.m_id);
                    }
                }
                
                // Step completed normally
                return (true, false, 0);
            }
            
            await Task.Delay(100);
        }
        
        // Timeout - force pause
        _engine.PauseExecution();
        return (true, false, 0);
    }
    
    /// <summary>
    /// Wait for device-level step to complete (legacy - kept for reference).
    /// </summary>
    private async Task WaitForDeviceStepComplete(uint pid, uint expectedDepth)
    {
        await Task.Delay(50);
        
        for (int i = 0; i < 100; i++) // Up to 10 seconds
        {
            var state = _engine.GetExecutionMode();
            bool isStopped = (state & WPCommands.DebuggingExecutionChangeConditions.State.Stopped) != 0;
            
            if (isStopped)
            {
                var bpStatus = _engine.GetBreakpointStatus();
                if (bpStatus != null)
                {
                    LogMessage($"Step stopped: id={bpStatus.m_id}, IP=0x{bpStatus.m_IP:X4}, flags=0x{bpStatus.m_flags:X4}, depth={bpStatus.m_depth}");
                    
                    // Check if this is a step completion (flags indicate step)
                    ushort stepMask = (ushort)(
                        WPCommands.Debugging_Execution_BreakpointDef.c_STEP_IN |
                        WPCommands.Debugging_Execution_BreakpointDef.c_STEP_OVER |
                        WPCommands.Debugging_Execution_BreakpointDef.c_STEP_OUT);
                    
                    bool isStepComplete = (bpStatus.m_flags & stepMask) != 0;
                    bool isUserBreakpoint = bpStatus.m_id > 0 && _activeBreakpointDefs.Any(bp => bp.m_id == bpStatus.m_id);
                    
                    if (isStepComplete && !isUserBreakpoint)
                    {
                        // Step completed - check if we're at correct depth
                        LogMessage($"Step complete at depth {bpStatus.m_depth}");
                        RaiseEvent("stopped", new StoppedEventBody
                        {
                            Reason = "step",
                            ThreadId = (int)pid,
                            AllThreadsStopped = true
                        });
                        return;
                    }
                    else if (isUserBreakpoint)
                    {
                        // Hit a user breakpoint during step
                        LogMessage($"Hit user breakpoint {bpStatus.m_id} during step");
                        RaiseEvent("stopped", new StoppedEventBody
                        {
                            Reason = "breakpoint",
                            ThreadId = (int)pid,
                            AllThreadsStopped = true,
                            HitBreakpointIds = new[] { (int)bpStatus.m_id }
                        });
                        return;
                    }
                }
                
                // Stopped for unknown reason - assume step complete
                LogMessage("Device stopped, assuming step complete");
                RaiseEvent("stopped", new StoppedEventBody
                {
                    Reason = "step",
                    ThreadId = (int)pid,
                    AllThreadsStopped = true
                });
                return;
            }
            
            await Task.Delay(100);
        }
        
        // Timeout
        LogMessage("Step timeout, forcing pause");
        _engine.PauseExecution();
        
        RaiseEvent("stopped", new StoppedEventBody
        {
            Reason = "step",
            ThreadId = (int)pid,
            AllThreadsStopped = true
        });
    }

    /// <summary>
    /// Step to one of multiple target IL offsets using temporary breakpoints.
    /// This handles loops where execution might go to any of several lines.
    /// </summary>
    private async Task<bool> StepToMultipleTargets(uint pid, uint methodToken, 
        List<(uint ILOffset, int SourceLine, string? SourceFile)> targets)
    {
        var tempBreakpointIds = new List<int>();
        var targetILOffsets = new HashSet<uint>();
        var allBreakpoints = _activeBreakpointDefs.ToList();
        
        // Create temporary breakpoints at all target offsets
        foreach (var target in targets)
        {
            var tempBpId = _nextBreakpointId++;
            tempBreakpointIds.Add(tempBpId);
            targetILOffsets.Add(target.ILOffset);
            
            var tempBp = new WPCommands.Debugging_Execution_BreakpointDef
            {
                m_id = (short)tempBpId,
                m_flags = WPCommands.Debugging_Execution_BreakpointDef.c_HARD,
                m_pid = 0, // Any thread
                m_depth = 0,
                m_md = methodToken,
                m_IP = target.ILOffset
            };
            
            allBreakpoints.Add(tempBp);
        }
        
        LogMessage($"Setting {tempBreakpointIds.Count} temp breakpoints for step");
        
        // Set all breakpoints on device
        _engine.SetBreakpoints(allBreakpoints.ToArray());
        
        // Resume execution
        _engine.ResumeExecution();
        
        // Wait for any breakpoint hit - pass target offsets so we can recognize step complete
        await WaitForStepTargetHit(pid, tempBreakpointIds, targetILOffsets);
        
        // Remove temp breakpoints by resetting to only the active user breakpoints
        _engine.SetBreakpoints(_activeBreakpointDefs.ToArray());
        
        return true;
    }
    
    /// <summary>
    /// Wait for step to complete by hitting one of the target IL offsets.
    /// When a user breakpoint is at the same location as a target, the device reports
    /// the user breakpoint ID, so we check both the ID and the IP address.
    /// </summary>
    private async Task WaitForStepTargetHit(uint pid, List<int> tempBreakpointIds, HashSet<uint> targetILOffsets)
    {
        await Task.Delay(50);
        
        for (int i = 0; i < 100; i++) // Up to 10 seconds
        {
            var state = _engine.GetExecutionMode();
            bool isStopped = (state & WPCommands.DebuggingExecutionChangeConditions.State.Stopped) != 0;
            
            if (isStopped)
            {
                var bpStatus = _engine.GetBreakpointStatus();
                if (bpStatus != null)
                {
                    LogMessage($"Breakpoint hit: id={bpStatus.m_id}, IP=0x{bpStatus.m_IP:X4}, flags=0x{bpStatus.m_flags:X4}");
                    
                    // Check if we stopped at one of our target IL offsets
                    // This handles the case where a user breakpoint is at the same location
                    if (targetILOffsets.Contains(bpStatus.m_IP))
                    {
                        // We hit a target location - step complete!
                        LogMessage($"Hit step target at IP=0x{bpStatus.m_IP:X4} - step complete");
                        RaiseEvent("stopped", new StoppedEventBody
                        {
                            Reason = "step",
                            ThreadId = (int)pid,
                            AllThreadsStopped = true
                        });
                        return;
                    }
                    else if (bpStatus.m_id > 0 && _activeBreakpointDefs.Any(bp => bp.m_id == bpStatus.m_id))
                    {
                        // Hit a user breakpoint that's NOT at a step target
                        // This means we skipped past our targets (shouldn't normally happen)
                        LogMessage($"Hit user breakpoint {bpStatus.m_id} at unexpected location");
                        RaiseEvent("stopped", new StoppedEventBody
                        {
                            Reason = "breakpoint",
                            ThreadId = (int)pid,
                            AllThreadsStopped = true,
                            HitBreakpointIds = new[] { (int)bpStatus.m_id }
                        });
                        return;
                    }
                }
                
                // Stopped but no recognized breakpoint - assume step complete
                LogMessage("Device stopped, assuming step complete");
                RaiseEvent("stopped", new StoppedEventBody
                {
                    Reason = "step",
                    ThreadId = (int)pid,
                    AllThreadsStopped = true
                });
                return;
            }
            
            await Task.Delay(100);
        }
        
        // Timeout
        LogMessage("Step timeout, forcing pause");
        _engine.PauseExecution();
        
        RaiseEvent("stopped", new StoppedEventBody
        {
            Reason = "step",
            ThreadId = (int)pid,
            AllThreadsStopped = true
        });
    }

    /// <summary>
    /// Step to a specific IL offset using a temporary breakpoint
    /// </summary>
    private async Task<bool> StepToILOffset(uint pid, uint methodToken, uint ilOffset)
    {
        // Create a temporary breakpoint at the target IL offset
        var tempBpId = _nextBreakpointId++;
        var tempBp = new WPCommands.Debugging_Execution_BreakpointDef
        {
            m_id = (short)tempBpId,
            m_flags = WPCommands.Debugging_Execution_BreakpointDef.c_HARD,
            m_pid = 0, // Any thread
            m_depth = 0,
            m_md = methodToken,
            m_IP = ilOffset
        };
        
        LogMessage($"Setting temp breakpoint {tempBpId} at IL offset 0x{ilOffset:X4}");
        
        // Add temp breakpoint to active breakpoints and set on device
        var allBreakpoints = _activeBreakpointDefs.ToList();
        allBreakpoints.Add(tempBp);
        _engine.SetBreakpoints(allBreakpoints.ToArray());
        
        // Resume execution
        _engine.ResumeExecution();
        
        // Wait for breakpoint hit
        await WaitForBreakpointHit(pid, tempBpId);
        
        // Remove temp breakpoint
        _engine.SetBreakpoints(_activeBreakpointDefs.ToArray());
        
        return true;
    }
    
    /// <summary>
    /// Perform a simple device-level step
    /// </summary>
    private async Task<bool> PerformSimpleStep(uint pid, 
        WPCommands.Debugging_Thread_Stack.Reply.Call targetFrame,
        ushort stepFlags, uint depth)
    {
        LogMessage($"Simple step: flags=0x{stepFlags:X4}, depth=0x{depth:X8}");
        
        var stepBp = new WPCommands.Debugging_Execution_BreakpointDef
        {
            m_id = -1,
            m_flags = stepFlags,
            m_pid = pid,
            m_depth = depth,
            m_md = targetFrame.m_md,
            m_IP = targetFrame.m_IP
        };
        
        var allBreakpoints = _activeBreakpointDefs.ToList();
        allBreakpoints.Add(stepBp);
        _engine.SetBreakpoints(allBreakpoints.ToArray());
        
        _engine.ResumeExecution();
        
        await WaitForStepComplete(pid);
        
        return true;
    }
    
    /// <summary>
    /// Wait for a specific breakpoint to be hit
    /// </summary>
    private async Task WaitForBreakpointHit(uint pid, int targetBpId)
    {
        await Task.Delay(50);
        
        for (int i = 0; i < 100; i++) // Up to 10 seconds
        {
            var state = _engine.GetExecutionMode();
            bool isStopped = (state & WPCommands.DebuggingExecutionChangeConditions.State.Stopped) != 0;
            
            if (isStopped)
            {
                var bpStatus = _engine.GetBreakpointStatus();
                if (bpStatus != null)
                {
                    LogMessage($"Breakpoint hit: id={bpStatus.m_id}, IP=0x{bpStatus.m_IP:X4}, flags=0x{bpStatus.m_flags:X4}");
                    
                    if (bpStatus.m_id == targetBpId)
                    {
                        // Hit our temp breakpoint - this is a step completion
                        RaiseEvent("stopped", new StoppedEventBody
                        {
                            Reason = "step",
                            ThreadId = (int)pid,
                            AllThreadsStopped = true
                        });
                        return;
                    }
                    else if (bpStatus.m_id > 0 && _activeBreakpointDefs.Any(bp => bp.m_id == bpStatus.m_id))
                    {
                        // Hit a user breakpoint
                        LogMessage($"Hit user breakpoint {bpStatus.m_id} while stepping");
                        RaiseEvent("stopped", new StoppedEventBody
                        {
                            Reason = "breakpoint",
                            ThreadId = (int)pid,
                            AllThreadsStopped = true,
                            HitBreakpointIds = new[] { (int)bpStatus.m_id }
                        });
                        return;
                    }
                }
                
                // Stopped but no recognized breakpoint - assume step complete
                RaiseEvent("stopped", new StoppedEventBody
                {
                    Reason = "step",
                    ThreadId = (int)pid,
                    AllThreadsStopped = true
                });
                return;
            }
            
            await Task.Delay(100);
        }
        
        // Timeout
        LogMessage("Step timeout, forcing pause");
        _engine.PauseExecution();
        
        RaiseEvent("stopped", new StoppedEventBody
        {
            Reason = "step",
            ThreadId = (int)pid,
            AllThreadsStopped = true
        });
    }
    
    /// <summary>
    /// Get assembly name for a device method token
    /// </summary>
    private string GetAssemblyNameForToken(uint methodToken)
    {
        // Device token format: (assembly_index << 16) | method_row
        uint assemblyIdx = methodToken & 0xFFFF0000;
        
        // Find the assembly with this index
        var assemblyInfo = _assemblyManager.GetAssemblyByDeviceIndex((int)assemblyIdx);
        if (assemblyInfo != null)
        {
            return assemblyInfo.Name;
        }
        
        return "unknown";
    }
    
    /// <summary>
    /// Wait for a step operation to complete
    /// </summary>
    private async Task WaitForStepComplete(uint pid)
    {
        // Give the device time to execute the step
        await Task.Delay(50);
        
        // Poll for step completion
        for (int i = 0; i < 50; i++) // Up to 5 seconds
        {
            var state = _engine.GetExecutionMode();
            bool isStopped = (state & WPCommands.DebuggingExecutionChangeConditions.State.Stopped) != 0;
            
            if (isStopped)
            {
                // Check if we hit the step breakpoint
                var bpStatus = _engine.GetBreakpointStatus();
                if (bpStatus != null)
                {
                    LogMessage($"Step completed at IP: 0x{bpStatus.m_IP:X4}, flags=0x{bpStatus.m_flags:X4}");
                    
                    // Check if this is a step completion (m_id == -1) or a regular breakpoint
                    if (bpStatus.m_id == -1 || 
                        (bpStatus.m_flags & WPCommands.Debugging_Execution_BreakpointDef.c_STEP) != 0)
                    {
                        // Step completed
                        RaiseEvent("stopped", new StoppedEventBody
                        {
                            Reason = "step",
                            ThreadId = (int)pid,
                            AllThreadsStopped = true
                        });
                        return;
                    }
                    else if (bpStatus.m_id > 0)
                    {
                        // Hit a regular breakpoint while stepping
                        LogMessage($"Hit breakpoint {bpStatus.m_id} while stepping");
                        RaiseEvent("stopped", new StoppedEventBody
                        {
                            Reason = "breakpoint",
                            ThreadId = (int)pid,
                            AllThreadsStopped = true,
                            HitBreakpointIds = new[] { (int)bpStatus.m_id }
                        });
                        return;
                    }
                }
                
                // Device is stopped but no breakpoint info - assume step complete
                LogMessage("Device stopped, assuming step complete");
                RaiseEvent("stopped", new StoppedEventBody
                {
                    Reason = "step",
                    ThreadId = (int)pid,
                    AllThreadsStopped = true
                });
                return;
            }
            
            await Task.Delay(100);
        }
        
        // Timeout - force pause
        LogMessage("Step timeout, forcing pause");
        _engine.PauseExecution();
        
        RaiseEvent("stopped", new StoppedEventBody
        {
            Reason = "step",
            ThreadId = (int)pid,
            AllThreadsStopped = true
        });
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

            // Find the first frame that has symbols (user code)
            WPCommands.Debugging_Thread_Stack.Reply.Call? targetFrame = null;
            
            for (int i = 0; i < stack.m_data.Length; i++)
            {
                var frame = stack.m_data[i];
                bool hasSymbols = _symbolResolver.GetMethodInfo(GetAssemblyNameForToken(frame.m_md), frame.m_md) != null;
                
                if (hasSymbols)
                {
                    targetFrame = frame;
                    break;
                }
            }
            
            if (targetFrame == null)
            {
                targetFrame = stack.m_data[0];
            }
            
            // Create step into breakpoint
            var stepBp = new WPCommands.Debugging_Execution_BreakpointDef
            {
                m_id = -1,
                m_flags = WPCommands.Debugging_Execution_BreakpointDef.c_STEP_IN,
                m_pid = pid,
                m_depth = WPCommands.Debugging_Execution_BreakpointDef.c_DEPTH_STEP_CALL,
                m_md = targetFrame.m_md,
                m_IP = targetFrame.m_IP
            };
            
            var allBreakpoints = _activeBreakpointDefs.ToList();
            allBreakpoints.Add(stepBp);
            _engine.SetBreakpoints(allBreakpoints.ToArray());
            
            _engine.ResumeExecution();
            
            // Wait for step to complete
            await WaitForStepComplete(pid);
            
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

            // Find the first frame that has symbols (user code)
            WPCommands.Debugging_Thread_Stack.Reply.Call? targetFrame = null;
            
            for (int i = 0; i < stack.m_data.Length; i++)
            {
                var frame = stack.m_data[i];
                bool hasSymbols = _symbolResolver.GetMethodInfo(GetAssemblyNameForToken(frame.m_md), frame.m_md) != null;
                
                if (hasSymbols)
                {
                    targetFrame = frame;
                    break;
                }
            }
            
            if (targetFrame == null)
            {
                targetFrame = stack.m_data[0];
            }
            
            // Create step out breakpoint
            var stepBp = new WPCommands.Debugging_Execution_BreakpointDef
            {
                m_id = -1,
                m_flags = WPCommands.Debugging_Execution_BreakpointDef.c_STEP_OUT,
                m_pid = pid,
                m_depth = WPCommands.Debugging_Execution_BreakpointDef.c_DEPTH_STEP_RETURN,
                m_md = targetFrame.m_md,
                m_IP = targetFrame.m_IP
            };
            
            var allBreakpoints = _activeBreakpointDefs.ToList();
            allBreakpoints.Add(stepBp);
            _engine.SetBreakpoints(allBreakpoints.ToArray());
            
            _engine.ResumeExecution();
            
            // Wait for step to complete
            await WaitForStepComplete(pid);
            
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
            LogMessage("GetStackTrace: Not connected or engine is null");
            return frames;
        }

        try
        {
            LogMessage($"Getting stack trace for thread {threadId} (startFrame={startFrame}, levels={levels})...");
            
            // Make sure we have a valid thread ID - use stored ID if 0 was passed
            uint pid = threadId > 0 ? (uint)threadId : _stoppedThreadId;
            LogMessage($"Using thread PID: {pid} (passed threadId={threadId}, _stoppedThreadId={_stoppedThreadId})");
            
            // Get thread stack from device
            var stack = _engine.GetThreadStack(pid);
            
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
                    
                    // Get method name
                    var methodName = _engine.GetMethodName(frame.m_md, true) ?? $"Frame {i}";
                    
                    // Try to get source location from symbols
                    SourceInfo? sourceInfo = null;
                    int line = 0;
                    int column = 0;
                    string? assemblyName = null;
                    
                    // Look up source location using the symbol resolver
                    // The method token from the device is the nanoFramework token
                    // We need to match it against our loaded .pdbx files
                    var (sourceLocation, foundAssemblyName) = TryGetSourceLocationForFrame(frame.m_md, frame.m_IP);
                    
                    if (sourceLocation != null)
                    {
                        sourceInfo = new SourceInfo
                        {
                            Path = sourceLocation.SourceFile,
                            Name = Path.GetFileName(sourceLocation.SourceFile)
                        };
                        line = sourceLocation.Line;
                        column = sourceLocation.Column;
                        assemblyName = foundAssemblyName;
                        LogMessage($"Frame {i}: {methodName} at {sourceLocation.SourceFile}:{line}");
                    }
                    
                    // Store frame info including method token and assembly name for variable lookup
                    _frameIdMap[frameId] = (threadId, i, frame.m_md, assemblyName);
                    
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
                LogMessage($"Could not get stack trace from device for thread {pid} (stack={stack}, m_data={(stack?.m_data == null ? "null" : stack.m_data.Length.ToString() + " frames")})");
                
                // Try refreshing the thread list to see what's available
                var currentThreads = _engine.GetThreadList();
                if (currentThreads != null)
                {
                    LogMessage($"Current thread list: [{string.Join(", ", currentThreads)}]");
                }
                else
                {
                    LogMessage("Current thread list is NULL");
                }
                
                // Return placeholder frame
                var frameId = _nextFrameId++;
                _frameIdMap[frameId] = ((int)pid, 0, 0, null);
                
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
            var (threadId, depth, methodToken, assemblyName) = _frameIdMap[frameId];
            LogMessage($"Getting scopes for frame {frameId} (thread {threadId}, depth {depth}, method 0x{methodToken:X8}, assembly {assemblyName ?? "unknown"})");
            
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
                    Count = (int)numLocals,
                    MethodToken = methodToken,
                    AssemblyName = assemblyName
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
                        Count = (int)numArgs,
                        MethodToken = methodToken,
                        AssemblyName = assemblyName
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
                    Depth = depth,
                    MethodToken = methodToken,
                    AssemblyName = assemblyName
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
                
                // Try to get local variable names from PDB
                string[]? variableNames = null;
                if (scopeRef.Type == ScopeType.Locals && scopeRef.AssemblyName != null && scopeRef.MethodToken != 0)
                {
                    variableNames = _symbolResolver.GetLocalVariableNames(scopeRef.AssemblyName, scopeRef.MethodToken);
                    if (variableNames != null)
                    {
                        LogMessage($"Found {variableNames.Length} local variable names from PDB: [{string.Join(", ", variableNames)}]");
                    }
                }
                
                int startIndex = start ?? 0;
                int maxCount = count ?? scopeRef.Count;
                
                for (int i = startIndex; i < Math.Min(startIndex + maxCount, scopeRef.Count); i++)
                {
                    Engine.StackValueKind kind = scopeRef.Type == ScopeType.Arguments 
                        ? Engine.StackValueKind.Argument 
                        : Engine.StackValueKind.Local;
                    
                    // Determine the variable name
                    string varName;
                    if (variableNames != null && i < variableNames.Length)
                    {
                        varName = variableNames[i];
                    }
                    else
                    {
                        varName = scopeRef.Type == ScopeType.Arguments ? $"arg{i}" : $"local{i}";
                    }
                    
                    try
                    {
                        var runtimeValue = _engine.GetStackFrameValue(
                            (uint)scopeRef.ThreadId,
                            (uint)scopeRef.Depth, 
                            kind, 
                            (uint)i);
                        
                        if (runtimeValue != null)
                        {
                            var varInfo = CreateVariableInfo(runtimeValue, varName);
                            variables.Add(varInfo);
                        }
                        else
                        {
                            variables.Add(new VariableInfo
                            {
                                Name = varName,
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
                            Name = varName,
                            Value = "<error>",
                            Type = "unknown",
                            VariablesReference = 0
                        });
                    }
                }
            }
            else if (reference is RuntimeValueReference rvRef)
            {
                // Expanding a complex object - lazy load fields/elements
                LogMessage("Expanding runtime value children");
                
                if (rvRef.Value == null || _engine == null)
                {
                    LogMessage("RuntimeValue or engine is null");
                }
                else if (rvRef.Value.IsArray || rvRef.Value.IsArrayReference)
                {
                    // Expand array elements
                    variables.AddRange(GetArrayElements(rvRef.Value));
                }
                else
                {
                    // Expand object fields
                    variables.AddRange(GetObjectFields(rvRef.Value));
                }
            }
        }
        catch (Exception ex)
        {
            LogMessage($"GetVariables error: {ex.Message}");
        }

        await Task.CompletedTask;
        return variables;
    }
    
    /// <summary>
    /// Get array elements for expansion
    /// </summary>
    private List<VariableInfo> GetArrayElements(RuntimeValue arrayValue)
    {
        var elements = new List<VariableInfo>();
        
        try
        {
            uint length = arrayValue.Length;
            LogMessage($"Getting array elements, length={length}");
            
            // Limit to first 100 elements for performance
            uint maxElements = Math.Min(length, 100);
            
            for (uint i = 0; i < maxElements; i++)
            {
                try
                {
                    var element = arrayValue.GetElement(i);
                    if (element != null)
                    {
                        var varInfo = CreateVariableInfo(element, $"[{i}]");
                        elements.Add(varInfo);
                    }
                    else
                    {
                        elements.Add(new VariableInfo
                        {
                            Name = $"[{i}]",
                            Value = "<null>",
                            Type = "object",
                            VariablesReference = 0
                        });
                    }
                }
                catch (Exception ex)
                {
                    LogMessage($"Error getting array element {i}: {ex.Message}");
                    elements.Add(new VariableInfo
                    {
                        Name = $"[{i}]",
                        Value = "<error>",
                        Type = "unknown",
                        VariablesReference = 0
                    });
                }
            }
            
            if (length > maxElements)
            {
                elements.Add(new VariableInfo
                {
                    Name = "...",
                    Value = $"({length - maxElements} more elements)",
                    Type = "",
                    VariablesReference = 0
                });
            }
        }
        catch (Exception ex)
        {
            LogMessage($"GetArrayElements error: {ex.Message}");
        }
        
        return elements;
    }
    
    /// <summary>
    /// Get object fields for expansion
    /// </summary>
    private List<VariableInfo> GetObjectFields(RuntimeValue objValue)
    {
        var fields = new List<VariableInfo>();
        
        try
        {
            uint numFields = objValue.NumOfFields;
            LogMessage($"Getting object fields, numFields={numFields}");
            
            if (numFields == 0)
            {
                LogMessage("Object has no fields");
                return fields;
            }
            
            // Get the type descriptor to resolve field information
            uint td = objValue.Type;
            LogMessage($"Object type descriptor: 0x{td:X8}");
            
            // Extract assembly index from type descriptor
            uint assemblyIdx = (td >> 16) & 0xFFFF;
            uint typeIdx = td & 0xFFFF;
            LogMessage($"Type descriptor breakdown: assembly={assemblyIdx}, typeIdx={typeIdx}");
            
            // Get type name for logging
            string? typeName = null;
            if (_engine != null)
            {
                try
                {
                    var typeInfo = _engine.ResolveType(td);
                    typeName = typeInfo?.m_name;
                    LogMessage($"Type name: {typeName ?? "unknown"}");
                }
                catch (Exception ex) 
                { 
                    LogMessage($"Failed to resolve type: {ex.Message}");
                }
            }
            
            // Ensure we scan the correct assembly for this object's type
            if (!_scannedAssemblies.Contains(assemblyIdx))
            {
                LogMessage($"Pre-scanning assembly {assemblyIdx} for type 0x{td:X8}");
                ScanAssemblyFields(assemblyIdx);
                _scannedAssemblies.Add(assemblyIdx);
            }
            
            for (uint offset = 0; offset < numFields; offset++)
            {
                try
                {
                    var fieldValue = objValue.GetField(offset, 0);
                    string fieldName = $"field{offset}";
                    
                    // Try to resolve field name from the engine
                    // We'll try different field descriptor values to find the right one
                    if (_engine != null)
                    {
                        fieldName = TryResolveFieldName(td, assemblyIdx, offset, numFields) ?? $"field{offset}";
                    }
                    
                    if (fieldValue != null)
                    {
                        var varInfo = CreateVariableInfo(fieldValue, fieldName);
                        fields.Add(varInfo);
                        LogMessage($"Field {offset}: {fieldName} = {varInfo.Value}");
                    }
                    else
                    {
                        fields.Add(new VariableInfo
                        {
                            Name = fieldName,
                            Value = "<null>",
                            Type = "object",
                            VariablesReference = 0
                        });
                    }
                }
                catch (Exception ex)
                {
                    LogMessage($"Error getting field at offset {offset}: {ex.Message}");
                    fields.Add(new VariableInfo
                    {
                        Name = $"field{offset}",
                        Value = "<error>",
                        Type = "unknown",
                        VariablesReference = 0
                    });
                }
            }
        }
        catch (Exception ex)
        {
            LogMessage($"GetObjectFields error: {ex.Message}");
        }
        
        return fields;
    }
    
    /// <summary>
    /// Try to resolve a field name using the engine's GetFieldName API
    /// </summary>
    private string? TryResolveFieldName(uint td, uint assemblyIdx, uint fieldOffset, uint numFields)
    {
        if (_engine == null) return null;
        
        try
        {
            // Build cache key for this type and field offset
            string cacheKey = $"{td}:{fieldOffset}";
            if (_fieldNameCache.TryGetValue(cacheKey, out string? cachedName))
            {
                return cachedName;
            }
            
            // Method 1: Scan the assembly if not already done
            if (!_scannedAssemblies.Contains(assemblyIdx))
            {
                LogMessage($"Scanning field table for assembly {assemblyIdx} (td=0x{td:X8})");
                ScanAssemblyFields(assemblyIdx);
                _scannedAssemblies.Add(assemblyIdx);
            }
            
            // Check cache after scanning
            if (_fieldNameCache.TryGetValue(cacheKey, out cachedName))
            {
                return cachedName;
            }
            
            // Method 2: Try using ResolveField directly by searching for matching td and offset
            // This requires iterating over field descriptors
            LogMessage($"Field not found in cache for td=0x{td:X8}, offset={fieldOffset}, trying direct resolve...");
            
            // Try a range of field descriptors for this assembly
            for (uint fieldIdx = 0; fieldIdx < 500; fieldIdx++)
            {
                uint fd = (assemblyIdx << 16) | fieldIdx;
                try
                {
                    var fieldInfo = _engine.ResolveField(fd);
                    if (fieldInfo != null && fieldInfo.m_td == td && fieldInfo.m_offset == fieldOffset)
                    {
                        LogMessage($"Found field via ResolveField: fd=0x{fd:X8}, name={fieldInfo.m_name}");
                        _fieldNameCache[cacheKey] = fieldInfo.m_name;
                        return fieldInfo.m_name;
                    }
                }
                catch
                {
                    // Ignore individual field lookup failures
                }
            }
            
            // If still not found, the field might be inherited from a base class
            LogMessage($"Field not found for td=0x{td:X8}, offset={fieldOffset} after all methods");
        }
        catch (Exception ex)
        {
            LogMessage($"Error resolving field name: {ex.Message}");
        }
        
        return null;
    }
    
    /// <summary>
    /// Scan all fields in an assembly and cache their names
    /// </summary>
    private void ScanAssemblyFields(uint assemblyIdx)
    {
        if (_engine == null) return;
        
        uint maxFieldsToScan = 1000; // Reasonable limit for most assemblies
        int consecutiveFailures = 0;
        int fieldsFound = 0;
        
        for (uint fieldIdx = 0; fieldIdx < maxFieldsToScan; fieldIdx++)
        {
            uint fd = (assemblyIdx << 16) | fieldIdx;
            
            try
            {
                // Use ResolveField which returns td, offset, and name
                var result = _engine.ResolveField(fd);
                
                if (result != null && !string.IsNullOrEmpty(result.m_name))
                {
                    consecutiveFailures = 0;
                    fieldsFound++;
                    
                    // Cache this field name: key is "{type_td}:{offset_within_type}"
                    string fieldCacheKey = $"{result.m_td}:{result.m_offset}";
                    _fieldNameCache[fieldCacheKey] = result.m_name;
                    
                    LogMessage($"Scanned field: fd=0x{fd:X8}, td=0x{result.m_td:X8}, offset={result.m_offset}, name={result.m_name}");
                }
                else
                {
                    consecutiveFailures++;
                }
            }
            catch
            {
                consecutiveFailures++;
            }
            
            // If we've had many consecutive failures, we're probably past the field table
            if (consecutiveFailures > 50 && fieldsFound > 0)
            {
                LogMessage($"Stopping field scan after {fieldsFound} fields found, {consecutiveFailures} consecutive failures");
                break;
            }
        }
        
        LogMessage($"Assembly {assemblyIdx} scan complete: {fieldsFound} fields cached");
    }
    
    // Cache for field names: key = "td:offset", value = field name
    private readonly Dictionary<string, string> _fieldNameCache = new();
    
    // Track which assemblies have been scanned
    private readonly HashSet<uint> _scannedAssemblies = new();

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
        if (!_isConnected || _engine == null)
        {
            return new EvaluateResult(false, Error: "Not connected");
        }

        try
        {
            LogMessage($"Evaluate: expression='{expression}', frameId={frameId}, context={context}");
            
            // For simple variable lookups, try to find the variable in the current frame
            if (frameId.HasValue && _frameIdMap.TryGetValue(frameId.Value, out var frameInfo))
            {
                var (threadId, depth, methodToken, assemblyName) = frameInfo;
                
                // Get local variable names from PDB
                string[]? variableNames = null;
                if (assemblyName != null && methodToken != 0)
                {
                    variableNames = _symbolResolver.GetLocalVariableNames(assemblyName, methodToken);
                }
                
                // Get stack frame info using the tuple-returning method
                var (numArgs, numLocals, evalStackDepth, success) = _engine.GetStackFrameInfo((uint)threadId, (uint)depth);
                if (success)
                {
                    // Search in local variables
                    for (int i = 0; i < (int)numLocals; i++)
                    {
                        string varName;
                        if (variableNames != null && i < variableNames.Length)
                        {
                            varName = variableNames[i];
                        }
                        else
                        {
                            varName = $"local{i}";
                        }
                        
                        if (varName.Equals(expression, StringComparison.OrdinalIgnoreCase))
                        {
                            // Found matching variable
                            try
                            {
                                var runtimeValue = _engine.GetStackFrameValue(
                                    (uint)threadId, (uint)depth, 
                                    Engine.StackValueKind.Local, (uint)i);
                                
                                if (runtimeValue != null)
                                {
                                    var varInfo = CreateVariableInfo(runtimeValue, varName);
                                    LogMessage($"Evaluate result: {varName} = {varInfo.Value}");
                                    
                                    return new EvaluateResult(true, new EvaluateResultData
                                    {
                                        Value = varInfo.Value,
                                        Type = varInfo.Type,
                                        HasChildren = varInfo.VariablesReference > 0,
                                        VariablesReference = varInfo.VariablesReference
                                    });
                                }
                            }
                            catch (Exception ex)
                            {
                                LogMessage($"Error getting variable {varName}: {ex.Message}");
                            }
                        }
                    }
                    
                    // Search in arguments
                    for (int i = 0; i < (int)numArgs; i++)
                    {
                        string argName = $"arg{i}";
                        // TODO: Get argument names from PDB if available
                        
                        if (argName.Equals(expression, StringComparison.OrdinalIgnoreCase))
                        {
                            try
                            {
                                var runtimeValue = _engine.GetStackFrameValue(
                                    (uint)threadId, (uint)depth,
                                    Engine.StackValueKind.Argument, (uint)i);
                                
                                if (runtimeValue != null)
                                {
                                    var varInfo = CreateVariableInfo(runtimeValue, argName);
                                    LogMessage($"Evaluate result: {argName} = {varInfo.Value}");
                                    
                                    return new EvaluateResult(true, new EvaluateResultData
                                    {
                                        Value = varInfo.Value,
                                        Type = varInfo.Type,
                                        HasChildren = varInfo.VariablesReference > 0,
                                        VariablesReference = varInfo.VariablesReference
                                    });
                                }
                            }
                            catch (Exception ex)
                            {
                                LogMessage($"Error getting argument {argName}: {ex.Message}");
                            }
                        }
                    }
                }
            }
            
            // Variable not found or no frame specified
            LogMessage($"Evaluate: variable '{expression}' not found");
            await Task.CompletedTask;
            return new EvaluateResult(false, Error: $"Cannot evaluate '{expression}'");
        }
        catch (Exception ex)
        {
            LogMessage($"Evaluate error: {ex.Message}");
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
    /// Start execution on the device
    /// </summary>
    /// <param name="stopOnEntry">Whether to stop at the entry point</param>
    /// <returns>True if execution started successfully</returns>
    public async Task<bool> StartExecution(bool stopOnEntry)
    {
        if (!_isConnected || _engine == null)
        {
            return false;
        }

        try
        {
            LogMessage($"Starting execution (stopOnEntry: {stopOnEntry})");

            if (stopOnEntry)
            {
                // First pause, then we'll get a stopped event
                _engine.PauseExecution();
                
                // Get thread list
                _lastThreadList = _engine.GetThreadList();
                _stoppedThreadId = _lastThreadList?.FirstOrDefault() ?? 1u;
                
                // Notify that we're stopped at entry
                RaiseEvent("stopped", new StoppedEventBody
                {
                    Reason = "entry",
                    ThreadId = (int)_stoppedThreadId,
                    AllThreadsStopped = true
                });
            }
            else
            {
                // Just resume execution
                _engine.ResumeExecution();
            }

            await Task.CompletedTask;
            return true;
        }
        catch (Exception ex)
        {
            LogMessage($"StartExecution error: {ex.Message}");
            return false;
        }
    }

    /// <summary>
    /// Attach to a running program on the device
    /// </summary>
    /// <returns>True if attached successfully</returns>
    public async Task<bool> Attach()
    {
        if (!_isConnected || _engine == null)
        {
            return false;
        }

        try
        {
            LogMessage("Attaching to running CLR...");
            
            // Check device state
            LogMessage($"Device connected to nanoCLR: {_engine.IsConnectedTonanoCLR}");
            LogMessage($"Device connected to nanoBooter: {_engine.IsConnectedTonanoBooter}");
            
            // Get initial execution state
            var initialState = _engine.GetExecutionMode();
            LogMessage($"Initial execution state: {initialState}");

            // Pause execution to allow debugging
            LogMessage("Calling PauseExecution...");
            bool paused = _engine.PauseExecution();
            LogMessage($"PauseExecution returned: {paused}");
            
            if (!paused)
            {
                LogMessage("Failed to pause execution for attach");
                return false;
            }

            // Wait for the device to actually stop and verify state
            // The device needs time to process the stop command
            for (int i = 0; i < 10; i++)
            {
                await Task.Delay(200);  // Wait 200ms between checks
                
                var state = _engine.GetExecutionMode();
                LogMessage($"Execution state check {i+1}: {state}");
                
                // Check if the Stopped flag is set
                if (((uint)state & 0x80000000) != 0)  // State.Stopped = 0x80000000
                {
                    LogMessage("Device confirmed stopped");
                    break;
                }
                
                if (i == 9)
                {
                    LogMessage("WARNING: Device may not be fully stopped after 2 seconds");
                }
            }

            // Query and register device assemblies
            LogMessage("Querying device assemblies...");
            var deviceAssemblies = _engine.ResolveAllAssemblies();
            if (deviceAssemblies != null && deviceAssemblies.Count > 0)
            {
                LogMessage($"Device has {deviceAssemblies.Count} assemblies loaded:");
                foreach (var assembly in deviceAssemblies)
                {
                    if (assembly.Result != null)
                    {
                        var name = assembly.Result.Name;
                        var version = new Version(
                            assembly.Result.Version.MajorVersion,
                            assembly.Result.Version.MinorVersion,
                            assembly.Result.Version.BuildNumber,
                            assembly.Result.Version.RevisionNumber);
                        // Idx is already in format (assembly_index << 16)
                        var idx = (int)assembly.Idx;
                        
                        LogMessage($"  Assembly Idx=0x{idx:X8}: {name} v{version}");
                        _assemblyManager.RegisterDeviceAssembly(name, version, 0, idx);
                    }
                }
            }
            else
            {
                LogMessage("WARNING: Could not resolve device assemblies");
            }

            // Get thread list
            LogMessage("Getting thread list...");
            _lastThreadList = _engine.GetThreadList();
            
            if (_lastThreadList != null)
            {
                LogMessage($"Thread list contains {_lastThreadList.Length} thread(s): [{string.Join(", ", _lastThreadList)}]");
            }
            else
            {
                LogMessage("Thread list is NULL - device may not have running threads or debugging may not be enabled");
            }
            
            _stoppedThreadId = _lastThreadList?.FirstOrDefault() ?? 1u;
            LogMessage($"Using stopped thread ID: {_stoppedThreadId}");
            
            // Try to get stack for the first thread to verify debugging is working
            if (_lastThreadList != null && _lastThreadList.Length > 0)
            {
                var testStack = _engine.GetThreadStack(_lastThreadList[0]);
                if (testStack != null && testStack.m_data != null)
                {
                    LogMessage($"Test stack has {testStack.m_data.Length} frames - debugging is working!");
                    foreach (var frame in testStack.m_data)
                    {
                        var methodName = _engine.GetMethodName(frame.m_md, true);
                        LogMessage($"  Frame: {methodName} (token=0x{frame.m_md:X8}, IP=0x{frame.m_IP:X4})");
                    }
                }
                else
                {
                    LogMessage("WARNING: Test GetThreadStack returned null or empty data - debugging may not be fully working");
                }
            }

            // Notify that we're stopped (attached)
            RaiseEvent("stopped", new StoppedEventBody
            {
                Reason = "pause",
                ThreadId = (int)_stoppedThreadId,
                AllThreadsStopped = true,
                Text = "Attached to device"
            });

            await Task.CompletedTask;
            LogMessage("Attached successfully");
            return true;
        }
        catch (Exception ex)
        {
            LogMessage($"Attach error: {ex.Message}");
            return false;
        }
    }

    /// <summary>
    /// Set exception handling options
    /// </summary>
    public async Task SetExceptionHandling(bool breakOnAll, bool breakOnUncaught)
    {
        LogMessage($"Setting exception handling: breakOnAll={breakOnAll}, breakOnUncaught={breakOnUncaught}");
        
        // TODO: Configure the engine for exception handling
        // This would typically involve setting up breakpoints or flags 
        // for exception handling
        
        await Task.CompletedTask;
    }

    /// <summary>
    /// Terminate the debug session
    /// </summary>
    public async Task Terminate()
    {
        LogMessage("Terminating debug session");
        
        try
        {
            if (_engine != null)
            {
                // Stop execution
                _engine.Stop();
            }
            
            await Disconnect();
            
            // Notify that debug session has terminated
            RaiseEvent("terminated", new { });
        }
        catch (Exception ex)
        {
            LogMessage($"Terminate error: {ex.Message}");
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
    private (SourceLocation? Location, string? AssemblyName) TryGetSourceLocationForFrame(uint methodToken, uint ilOffset)
    {
        // The method token from the device is in format: (assembly_index << 16) | method_row
        // Extract the assembly index to try finding the right assembly first
        uint assemblyIdx = methodToken & 0xFFFF0000;
        
        // Try to find the assembly by its device index
        var assemblyInfo = _assemblyManager.GetAssemblyByDeviceIndex((int)assemblyIdx);
        if (assemblyInfo != null)
        {
            var location = _symbolResolver.GetSourceLocation(assemblyInfo.Name, methodToken, ilOffset);
            if (location != null)
            {
                LogMessage($"Source found via assembly index: {assemblyInfo.Name} -> {location.SourceFile}:{location.Line}");
                return (location, assemblyInfo.Name);
            }
        }
        
        // Fall back to searching all loaded symbols
        foreach (var assemblyName in _symbolResolver.GetLoadedAssemblies())
        {
            var location = _symbolResolver.GetSourceLocation(assemblyName, methodToken, ilOffset);
            if (location != null)
            {
                LogMessage($"Source found via search: {assemblyName} -> {location.SourceFile}:{location.Line}");
                return (location, assemblyName);
            }
        }
        
        LogMessage($"No source found for token 0x{methodToken:X8}, IL offset {ilOffset}");
        return (null, null);
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
    
    /// <summary>
    /// The method token (device format) for looking up local variable names
    /// </summary>
    public uint MethodToken { get; set; }
    
    /// <summary>
    /// The assembly name for looking up local variable names
    /// </summary>
    public string? AssemblyName { get; set; }
}

/// <summary>
/// Reference to a runtime value for expanding children
/// </summary>
internal class RuntimeValueReference
{
    public RuntimeValue? Value { get; set; }
}
