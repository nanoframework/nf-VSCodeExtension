// Licensed to the .NET Foundation under one or more agreements.
// The .NET Foundation licenses this file to you under the MIT license.

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
/// Verbosity level for debug logging.
/// </summary>
public enum VerbosityLevel
{
    /// <summary>
    /// No logging output.
    /// </summary>
    None = 0,
    
    /// <summary>
    /// Informational messages only (connection status, major operations).
    /// </summary>
    Information = 1,
    
    /// <summary>
    /// Detailed debug messages including internal operations.
    /// </summary>
    Debug = 2
}

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
    private VerbosityLevel _verbosity = VerbosityLevel.None;
    
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
    /// Set the verbosity level for logging.
    /// </summary>
    /// <param name="level">The verbosity level: None, Information, or Debug</param>
    public void SetVerbosity(VerbosityLevel level)
    {
        _verbosity = level;
        LogMessage(LogLevel.Info, $"Verbosity level set to: {level}");
    }

    /// <summary>
    /// Set verbosity from string value (for command-line parsing).
    /// </summary>
    /// <param name="level">Verbosity level as string: "none", "information", "debug"</param>
    public void SetVerbosity(string level)
    {
        _verbosity = level?.ToLowerInvariant() switch
        {
            "none" => VerbosityLevel.None,
            "information" or "info" => VerbosityLevel.Information,
            "debug" or "verbose" => VerbosityLevel.Debug,
            _ => VerbosityLevel.Information
        };
        LogMessage(LogLevel.Info, $"Verbosity level set to: {_verbosity}");
    }

    /// <summary>
    /// Enable or disable verbose logging (legacy method, sets to Debug if true).
    /// </summary>
    [Obsolete("Use SetVerbosity(VerbosityLevel) instead")]
    public void SetVerbose(bool verbose)
    {
        _verbosity = verbose ? VerbosityLevel.Debug : VerbosityLevel.None;
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
            LogInfo($"Connecting to device: {device} at baud rate {baudRate}");

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
                LogDebug("Device enumeration timed out, attempting direct connection...");
            }

            // Find the device
            _device = _portManager.NanoFrameworkDevices.FirstOrDefault(d => 
                d.ConnectionId?.Contains(device, StringComparison.OrdinalIgnoreCase) == true ||
                d.Description?.Contains(device, StringComparison.OrdinalIgnoreCase) == true);

            if (_device == null)
            {
                // Try direct connection if device not found in enumeration
                LogDebug($"Device not found in enumeration, checking available devices...");
                
                foreach (var dev in _portManager.NanoFrameworkDevices)
                {
                    LogDebug($"  Available: {dev.Description} ({dev.ConnectionId})");
                }

                return new ConnectResult(false, $"Device '{device}' not found. Make sure it's connected and running nanoFramework.");
            }

            LogInfo($"Found device: {_device.Description}");

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
            LogDebug("Connecting to debug engine...");
            bool connected = false;
            int maxRetries = 3;
            
            for (int attempt = 1; attempt <= maxRetries && !connected; attempt++)
            {
                if (attempt > 1)
                {
                    LogDebug($"Retry attempt {attempt}/{maxRetries}...");
                    await Task.Delay(1000); // Wait a bit before retry
                }
                
                try
                {
                    connected = _engine.Connect(5000, true, true);
                }
                catch (Exception ex)
                {
                    LogDebug($"Connect attempt {attempt} failed: {ex.Message}");
                }
            }

            if (!connected)
            {
                return new ConnectResult(false, "Failed to connect to device debug engine. Try resetting the device or unplugging and reconnecting it.");
            }

            // Update debug flags to enable source-level debugging
            LogDebug("Enabling source-level debugging...");
            bool debugFlagsUpdated = _engine.UpdateDebugFlags();
            LogDebug($"UpdateDebugFlags returned: {debugFlagsUpdated}");
            
            // Get current execution mode to verify
            var executionMode = _engine.GetExecutionMode();
            LogDebug($"Current execution mode: 0x{(uint)executionMode:X8}");
            
            // If device is already running and we haven't enabled source-level debugging, do it explicitly
            if (!debugFlagsUpdated)
            {
                LogDebug("Explicitly setting SourceLevelDebugging mode...");
                bool modeSet = _engine.SetExecutionMode(
                    nanoFramework.Tools.Debugger.WireProtocol.Commands.DebuggingExecutionChangeConditions.State.SourceLevelDebugging, 
                    0);
                LogDebug($"SetExecutionMode returned: {modeSet}");
            }

            _isConnected = true;
            
            // Send initialized event
            RaiseEvent("initialized", new { });
            
            LogInfo("Connected successfully!");
            return new ConnectResult(true);
        }
        catch (Exception ex)
        {
            LogInfo($"Connection error: {ex.Message}");
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
            LogInfo($"Disconnect error: {ex.Message}");
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
            LogDebug($"SetBreakpoint: Requested breakpoint at {file}:{line}");
            
            var breakpointId = _nextBreakpointId++;
            
            // Try to resolve the source location to an IL offset using loaded symbols
            var bpLocation = _symbolResolver.GetBreakpointLocation(file, line);
            
            if (bpLocation != null)
            {
                LogDebug($"SetBreakpoint: Resolved to line {bpLocation.Line}, IL offset {bpLocation.ILOffset}");
            }
            
            BreakpointInfo breakpoint;
            
            if (bpLocation != null)
            {
                // Get the assembly Idx from the device (already in shifted format: assembly_index << 16)
                var assemblyInfo = _assemblyManager.GetDeviceAssembly(bpLocation.AssemblyName);
                if (assemblyInfo != null)
                {
                    bpLocation.AssemblyIdx = (uint)assemblyInfo.DeviceIndex;
                    LogDebug($"Assembly '{bpLocation.AssemblyName}' has device Idx 0x{bpLocation.AssemblyIdx:X8}");
                }
                else
                {
                    // Try to find by assembly name without extension
                    var assemblyNameNoExt = Path.GetFileNameWithoutExtension(bpLocation.AssemblyName);
                    assemblyInfo = _assemblyManager.GetDeviceAssembly(assemblyNameNoExt);
                    if (assemblyInfo != null)
                    {
                        bpLocation.AssemblyIdx = (uint)assemblyInfo.DeviceIndex;
                        LogDebug($"Assembly '{assemblyNameNoExt}' has device Idx 0x{bpLocation.AssemblyIdx:X8}");
                    }
                    else
                    {
                        LogDebug($"WARNING: Could not find device Idx for assembly '{bpLocation.AssemblyName}'");
                        // Default to 0x10000 which is assembly index 1 (typical user assembly)
                        bpLocation.AssemblyIdx = 0x10000;
                    }
                }
                
                // Symbols found - create a verified breakpoint
                LogDebug($"Symbol resolved: assembly={bpLocation.AssemblyName}, pdbxToken=0x{bpLocation.MethodToken:X8}, deviceIndex=0x{bpLocation.DeviceMethodIndex:X8}, IL={bpLocation.ILOffset}");
                
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
                
                LogDebug($"Setting breakpoint on device: id={breakpointId}, md=0x{bpDef.m_md:X8}, IP={bpDef.m_IP}, flags=0x{bpDef.m_flags:X4}");
                LogDebug($"Total active breakpoints: {_activeBreakpointDefs.Count}");
                
                // Set breakpoints on the device
                bool success = _engine.SetBreakpoints(_activeBreakpointDefs.ToArray());
                LogDebug($"SetBreakpoints returned: {success}");
                
                if (!success)
                {
                    LogDebug("Warning: Failed to set breakpoint on device");
                    breakpoint.Verified = false;
                    breakpoint.Message = "Failed to set breakpoint on device";
                }
            }
            else
            {
                // No symbols - create an unverified breakpoint (pending)
                LogDebug("No symbols found for source location, breakpoint pending");
                
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
            LogInfo($"SetBreakpoint error: {ex.Message}");
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
            LogDebug($"Removing breakpoint {breakpointId}");
            
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
            LogInfo($"RemoveBreakpoint error: {ex.Message}");
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
            LogDebug($"Continuing execution (thread {threadId})");
            
            // Cancel any existing polling task
            _breakpointPollCts?.Cancel();
            _breakpointPollCts = new CancellationTokenSource();
            
            // Resume execution using Wire Protocol
            bool success = _engine.ResumeExecution();
            
            if (success)
            {
                LogDebug("Execution resumed");
                
                // Start background task to poll for breakpoint hits
                _ = PollForBreakpointHitAsync(_breakpointPollCts.Token);
            }
            else
            {
                LogDebug("Failed to resume execution");
            }
            
            await Task.CompletedTask;
            return success;
        }
        catch (Exception ex)
        {
            LogInfo($"Continue error: {ex.Message}");
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
            LogDebug($"Initial state after resume: {initialState}");
            
            // If still stopped, check if there's a breakpoint hit
            if (((uint)initialState & 0x80000000) != 0)
            {
                LogDebug("Device still stopped after resume - checking for breakpoint hit");
                
                var bpStatus = _engine.GetBreakpointStatus();
                if (bpStatus != null && bpStatus.m_id > 0)
                {
                    LogDebug($"Immediate breakpoint hit: id={bpStatus.m_id}, md=0x{bpStatus.m_md:X8}, IP=0x{bpStatus.m_IP:X4}");
                    
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
            LogDebug("Polling for breakpoint hit...");
            
            while (!cancellationToken.IsCancellationRequested && _isConnected && _engine != null)
            {
                await Task.Delay(50, cancellationToken);
                
                // Check execution state
                var state = _engine.GetExecutionMode();
                
                // State.Stopped = 0x80000000
                if (((uint)state & 0x80000000) != 0)
                {
                    LogDebug($"Device stopped (state={state}) - checking breakpoint status");
                    
                    // Check what caused the stop
                    var bpStatus = _engine.GetBreakpointStatus();
                    
                    if (bpStatus != null)
                    {
                        LogDebug($"Breakpoint hit: id={bpStatus.m_id}, md=0x{bpStatus.m_md:X8}, IP=0x{bpStatus.m_IP:X4}");
                        
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
            LogInfo($"Breakpoint poll error: {ex.Message}");
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
            LogDebug($"Pausing execution (thread {threadId})");
            
            // Cancel polling task
            _breakpointPollCts?.Cancel();
            
            // Pause execution using Wire Protocol
            bool success = _engine.PauseExecution();
            
            if (success)
            {
                LogDebug("Execution paused");
                
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
                LogDebug("Failed to pause execution");
            }
            
            await Task.CompletedTask;
            return success;
        }
        catch (Exception ex)
        {
            LogInfo($"Pause error: {ex.Message}");
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
            LogDebug($"Step over (thread {threadId})");
            
            // Get current stack frame
            uint pid = threadId > 0 ? (uint)threadId : _stoppedThreadId;
            var stack = _engine.GetThreadStack(pid);
            
            if (stack == null || stack.m_data == null || stack.m_data.Length == 0)
            {
                LogDebug("Could not get thread stack for stepping");
                return false;
            }

            // Find the first frame with source location (user code)
            // Use TryGetSourceLocationForFrame which works with both pdbx files and Portable PDBs
            WPCommands.Debugging_Thread_Stack.Reply.Call? userFrame = null;
            string? assemblyName = null;
            int userFrameDepth = -1;
            SourceLocation? currentLocation = null;
            
            for (int i = 0; i < stack.m_data.Length; i++)
            {
                var frame = stack.m_data[i];
                var methodName = _engine.GetMethodName(frame.m_md, true);
                var (location, asmName) = TryGetSourceLocationForFrame(frame.m_md, frame.m_IP);
                bool hasSource = location != null;
                
                LogDebug($"Frame {i}: md=0x{frame.m_md:X8}, IP=0x{frame.m_IP:X4}, method={methodName}, hasSource={hasSource}");
                
                if (hasSource && location != null && asmName != null)
                {
                    userFrame = frame;
                    assemblyName = asmName;
                    userFrameDepth = i;
                    currentLocation = location;
                    break;
                }
            }
            
            if (userFrame == null || assemblyName == null)
            {
                // No user code found, just resume with a simple step
                LogDebug("No frame with source found, using simple step");
                return await PerformDeviceStepOver(pid, stack.m_data[0], 0);
            }
            
            LogDebug($"User frame at depth {userFrameDepth}: md=0x{userFrame.m_md:X8}, IP=0x{userFrame.m_IP:X4}");
            
            // Log current source line info
            if (currentLocation != null)
            {
                LogDebug($"Current location: {Path.GetFileName(currentLocation.SourceFile)}:{currentLocation.Line}");
            }
            
            // Use device-level stepping with c_STEP_OVER flag
            // The device will step over function calls and stop at next IL instruction
            // We track stack depth to ensure we stop at the right level
            return await PerformDeviceStepOver(pid, userFrame, (uint)userFrameDepth);
        }
        catch (Exception ex)
        {
            LogInfo($"StepOver error: {ex.Message}");
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
        LogDebug($"Device step over: pid={pid}, depth={frameDepth}, md=0x{currentFrame.m_md:X8}, IP=0x{currentFrame.m_IP:X4}");
        
        // Get the current source line - we'll step to the next different line
        var (startLocation, _) = TryGetSourceLocationForFrame(currentFrame.m_md, currentFrame.m_IP);
        int startLine = startLocation?.Line ?? -1;
        string? startFile = startLocation?.SourceFile;
        
        LogDebug($"Starting step from line {startLine} in {Path.GetFileName(startFile ?? "unknown")}");
        
        // BREAKPOINT-BASED STEP OVER:
        // Instead of rapid IL stepping (which causes issues with native code),
        // we set a temporary breakpoint at the next source line and resume.
        
        if (startFile != null && startLine > 0)
        {
            // Try to find the next source line's IL offset
            var nextLineLocation = _symbolResolver.GetNextLineBreakpointLocation(startFile, startLine, (int)currentFrame.m_md);
            
            if (nextLineLocation != null)
            {
                LogDebug($"Using breakpoint-based step: setting temp bp at line {nextLineLocation.Line}, IL={nextLineLocation.ILOffset}");
                
                // Resolve the assembly index for the device using _assemblyManager
                uint? deviceAssemblyIndex = null;
                var assemblyInfo = _assemblyManager.GetDeviceAssembly(nextLineLocation.AssemblyName);
                if (assemblyInfo != null)
                {
                    deviceAssemblyIndex = (uint)assemblyInfo.DeviceIndex;
                }
                else
                {
                    // Try without extension
                    var assemblyNameNoExt = Path.GetFileNameWithoutExtension(nextLineLocation.AssemblyName);
                    assemblyInfo = _assemblyManager.GetDeviceAssembly(assemblyNameNoExt);
                    if (assemblyInfo != null)
                    {
                        deviceAssemblyIndex = (uint)assemblyInfo.DeviceIndex;
                    }
                }
                
                if (deviceAssemblyIndex.HasValue)
                {
                    // Create temporary step breakpoint at the next line
                    var stepBp = new WPCommands.Debugging_Execution_BreakpointDef
                    {
                        m_id = -100, // Special ID for step breakpoint
                        m_flags = WPCommands.Debugging_Execution_BreakpointDef.c_HARD,
                        m_pid = 0,
                        m_depth = 0,
                        m_md = (deviceAssemblyIndex.Value << 16) | ((uint)nextLineLocation.MethodToken & 0xFFFF),
                        m_IP = (uint)nextLineLocation.ILOffset,
                        m_IPStart = 0,
                        m_IPEnd = 0
                    };
                    
                    // Also add step-out breakpoint in case we step out of the method
                    var stepOutBp = new WPCommands.Debugging_Execution_BreakpointDef
                    {
                        m_id = -101, // Special ID for step-out
                        m_flags = (ushort)(WPCommands.Debugging_Execution_BreakpointDef.c_STEP_OUT |
                                          WPCommands.Debugging_Execution_BreakpointDef.c_EXCEPTION_CAUGHT |
                                          WPCommands.Debugging_Execution_BreakpointDef.c_THREAD_TERMINATED),
                        m_pid = pid,
                        m_depth = (uint)frameDepth,
                        m_md = currentFrame.m_md,
                        m_IP = currentFrame.m_IP,
                        m_IPStart = 0,
                        m_IPEnd = 0
                    };
                    
                    // Set breakpoints: user breakpoints + temp step breakpoint + step-out
                    var allBreakpoints = _activeBreakpointDefs.ToList();
                    allBreakpoints.Add(stepBp);
                    allBreakpoints.Add(stepOutBp);
                    _engine.SetBreakpoints(allBreakpoints.ToArray());
                    
                    LogDebug($"Set temp breakpoint at md=0x{stepBp.m_md:X8}, IP={stepBp.m_IP}");
                    
                    // Resume execution (not step!)
                    _engine.ResumeExecution();
                    
                    // Wait for breakpoint or reboot
                    var result = await WaitForBreakpointBasedStep(pid, nextLineLocation.Line, stepBp.m_IP, stepBp.m_md);
                    
                    // Restore original breakpoints
                    _engine.SetBreakpoints(_activeBreakpointDefs.ToArray());
                    
                    if (result.deviceRebooted)
                    {
                        LogDebug("Device rebooted during breakpoint-based step");
                        await HandleDeviceRebootDuringDebug();
                        return true;
                    }
                    
                    if (result.hitUserBreakpoint)
                    {
                        LogDebug($"Hit user breakpoint {result.userBpId} during step");
                        RaiseEvent("stopped", new StoppedEventBody
                        {
                            Reason = "breakpoint",
                            ThreadId = (int)pid,
                            AllThreadsStopped = true,
                            HitBreakpointIds = new[] { result.userBpId }
                        });
                        return true;
                    }
                    
                    // Normal step completion
                    LogDebug($"Breakpoint-based step complete");
                    RaiseEvent("stopped", new StoppedEventBody
                    {
                        Reason = "step",
                        ThreadId = (int)pid,
                        AllThreadsStopped = true
                    });
                    return true;
                }
            }
        }
        
        // Fallback to IL-based stepping if we couldn't find next line
        // (e.g., at end of method, or no symbols)
        LogDebug("Falling back to IL-based stepping");
        return await PerformILBasedStepOver(pid, currentFrame, frameDepth, startLine, startFile);
    }
    
    /// <summary>
    /// Wait for a breakpoint-based step to complete.
    /// Returns when device stops at breakpoint, user breakpoint, or reboots.
    /// </summary>
    private async Task<(bool stopped, bool hitUserBreakpoint, int userBpId, bool deviceRebooted)> WaitForBreakpointBasedStep(
        uint pid, int targetLine, uint targetIP, uint targetMd)
    {
        await Task.Delay(20);
        
        for (int i = 0; i < 200; i++) // Up to 20 seconds
        {
            try
            {
                if (!_engine.IsConnectedTonanoCLR)
                {
                    LogDebug("Lost connection to nanoCLR during breakpoint-based step");
                    return (true, false, 0, true);
                }
                
                var state = _engine.GetExecutionMode();
                bool isStopped = (state & WPCommands.DebuggingExecutionChangeConditions.State.Stopped) != 0;
                
                if (isStopped)
                {
                    var threads = _engine.GetThreadList();
                    if (threads == null || threads.Length == 0)
                    {
                        LogDebug("Device rebooted during breakpoint-based step (no threads)");
                        return (true, false, 0, true);
                    }
                    
                    var stack = _engine.GetThreadStack(pid);
                    if (stack == null || stack.m_data == null || stack.m_data.Length == 0)
                    {
                        LogDebug("Lost thread during breakpoint-based step");
                        return (true, false, 0, false);
                    }
                    
                    uint currentIP = stack.m_data[0].m_IP;
                    uint currentMd = stack.m_data[0].m_md;
                    
                    // Check if we hit a user breakpoint
                    var userBp = _activeBreakpointDefs.FirstOrDefault(bp => 
                        bp.m_IP == currentIP && bp.m_md == currentMd);
                    
                    if (userBp != null)
                    {
                        LogDebug($"Hit user breakpoint {userBp.m_id} at IP={currentIP}");
                        return (true, true, (int)userBp.m_id, false);
                    }
                    
                    // Otherwise, step completed (hit our temp breakpoint or stepped out)
                    LogDebug($"Breakpoint-based step stopped at IP=0x{currentIP:X4}, md=0x{currentMd:X8}");
                    return (true, false, 0, false);
                }
            }
            catch (Exception ex)
            {
                LogDebug($"Error during breakpoint-based step wait: {ex.Message}");
                if (!_engine.IsConnectedTonanoCLR)
                {
                    return (true, false, 0, true);
                }
            }
            
            await Task.Delay(100);
        }
        
        // Timeout - try to pause
        LogDebug("Breakpoint-based step timeout");
        try
        {
            if (_engine.IsConnectedTonanoCLR)
            {
                _engine.PauseExecution();
            }
            else
            {
                return (true, false, 0, true);
            }
        }
        catch { }
        
        return (true, false, 0, false);
    }
    
    /// <summary>
    /// Fallback IL-based step over (when breakpoint-based stepping isn't possible).
    /// </summary>
    private async Task<bool> PerformILBasedStepOver(uint pid, 
        WPCommands.Debugging_Thread_Stack.Reply.Call currentFrame, uint frameDepth,
        int startLine, string? startFile)
    {
        LogDebug($"IL-based step starting from line {startLine} in {Path.GetFileName(startFile ?? "unknown")}");
        
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
            try
            {
                // Check if device is still connected before each step iteration
                if (!_engine.IsConnectedTonanoCLR)
                {
                    LogDebug("Device disconnected during step loop");
                    await HandleDeviceRebootDuringDebug();
                    return true;
                }
                
                // Get current frame state
                var stack = _engine.GetThreadStack(pid);
                if (stack == null || stack.m_data == null || stack.m_data.Length == 0)
                {
                    LogDebug("Lost thread stack during step - checking for reboot");
                    var threads = _engine.GetThreadList();
                    if (threads == null || threads.Length == 0)
                    {
                        LogDebug("No threads found - device likely rebooted");
                        await HandleDeviceRebootDuringDebug();
                        return true;
                    }
                    LogDebug($"Found {threads.Length} threads but lost current thread stack");
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
                // Pass starting IP/method so we can detect if we've actually moved before reporting a breakpoint hit
                var (stopped, hitUserBreakpoint, userBpId, deviceRebooted) = await WaitForSingleILStep(pid, frame.m_IP, frame.m_md);
                
                if (deviceRebooted)
                {
                    // Device rebooted during step - this can happen when stepping over native code
                    // that causes a device reset (e.g., hardware initialization, watchdog, etc.)
                    LogDebug("Device rebooted during step operation");
                    try { _engine.SetBreakpoints(_activeBreakpointDefs.ToArray()); } catch { }
                    
                    // Try to reconnect and re-apply breakpoints
                    await HandleDeviceRebootDuringDebug();
                    return true;
                }
            
            if (!stopped)
            {
                LogDebug("Step did not complete");
                break;
            }
            
            if (hitUserBreakpoint)
            {
                // Hit a user breakpoint - stop here
                LogDebug($"Hit user breakpoint {userBpId} during step");
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
                LogDebug("Lost thread stack after step");
                break;
            }
            
            var newFrame = newStack.m_data[0];
            // Use TryGetSourceLocationForFrame which searches all loaded assemblies (works with Portable PDBs)
            var (newLocation, _) = TryGetSourceLocationForFrame(newFrame.m_md, newFrame.m_IP);
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
                LogDebug($"Step complete: moved from line {startLine} to line {newLine} (steps={stepCount + 1})");
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
                LogDebug($"Still on line {newLine}, continuing (step {stepCount + 1}, IP=0x{newFrame.m_IP:X4})");
            }
            } // end try
            catch (Exception ex)
            {
                LogDebug($"Exception during step loop: {ex.Message}");
                // Check if this is a communication/reboot issue
                if (!_engine.IsConnectedTonanoCLR)
                {
                    LogDebug("Device disconnected - handling reboot");
                    await HandleDeviceRebootDuringDebug();
                    return true;
                }
                // Other error - break out of loop
                break;
            }
        }
        
        // Safety limit reached or error
        LogDebug("Step limit reached or error");
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
    /// Returns (stopped, hitUserBreakpoint, userBpId, deviceRebooted)
    /// </summary>
    /// <param name="pid">Thread ID</param>
    /// <param name="startingIP">The IP we started from - used to detect if we actually moved</param>
    /// <param name="startingMd">The method we started from</param>
    private async Task<(bool stopped, bool hitUserBreakpoint, int userBpId, bool deviceRebooted)> WaitForSingleILStep(uint pid, uint startingIP, uint startingMd)
    {
        await Task.Delay(20);
        
        int consecutiveErrors = 0;
        const int maxConsecutiveErrors = 3;
        
        for (int i = 0; i < 100; i++) // Up to 10 seconds
        {
            try
            {
                // First check if we're still connected to the CLR
                if (!_engine.IsConnectedTonanoCLR)
                {
                    LogDebug("Lost connection to nanoCLR during step - device may have rebooted");
                    return (true, false, 0, true); // deviceRebooted = true
                }
                
                var state = _engine.GetExecutionMode();
                bool isStopped = (state & WPCommands.DebuggingExecutionChangeConditions.State.Stopped) != 0;
                
                // Reset error counter on successful call
                consecutiveErrors = 0;
                
                if (isStopped)
                {
                    // Get actual current position from the stack
                    var stack = _engine.GetThreadStack(pid);
                    
                    // Check if we lost the thread - this could mean the device rebooted
                    if (stack == null || stack.m_data == null || stack.m_data.Length == 0)
                    {
                        // Try to get thread list to verify device state
                        var threads = _engine.GetThreadList();
                        if (threads == null || threads.Length == 0)
                        {
                            LogDebug("Device appears to have rebooted during step (no threads)");
                            return (true, false, 0, true); // deviceRebooted = true
                        }
                        
                        // We have threads but lost this specific one
                        LogDebug($"Lost thread {pid} during step");
                        return (true, false, 0, false);
                    }
                    
                    uint currentIP = stack.m_data[0].m_IP;
                    uint currentMd = stack.m_data[0].m_md;
                    
                    // Check if we've actually moved
                    bool hasMoved = (currentIP != startingIP) || (currentMd != startingMd);
                    
                    // Check if current position matches any active breakpoint
                    // Only report breakpoint hit if we're EXACTLY at a breakpoint's IP
                    var matchingBp = _activeBreakpointDefs.FirstOrDefault(bp => 
                        bp.m_IP == currentIP && bp.m_md == currentMd);
                    
                    if (matchingBp != null && hasMoved)
                    {
                        LogDebug($"Hit breakpoint {matchingBp.m_id}: currentIP=0x{currentIP:X4} matches bp IP=0x{matchingBp.m_IP:X4}");
                        return (true, true, (int)matchingBp.m_id, false);
                    }
                    
                    // Step completed normally (no breakpoint at current location, or haven't moved)
                    return (true, false, 0, false);
                }
            }
            catch (Exception ex)
            {
                consecutiveErrors++;
                LogDebug($"Error during step wait (attempt {consecutiveErrors}): {ex.Message}");
                
                if (consecutiveErrors >= maxConsecutiveErrors)
                {
                    LogDebug("Multiple consecutive errors during step - device may have rebooted");
                    return (true, false, 0, true); // deviceRebooted = true
                }
            }
            
            await Task.Delay(100);
        }
        
        // Timeout - check if device is still connected before pausing
        try
        {
            if (_engine.IsConnectedTonanoCLR)
            {
                _engine.PauseExecution();
            }
            else
            {
                LogDebug("Device disconnected during step timeout");
                return (true, false, 0, true);
            }
        }
        catch (Exception ex)
        {
            LogDebug($"Error pausing after step timeout: {ex.Message}");
            return (true, false, 0, true);
        }
        
        return (true, false, 0, false);
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
                    LogDebug($"Step stopped: id={bpStatus.m_id}, IP=0x{bpStatus.m_IP:X4}, flags=0x{bpStatus.m_flags:X4}, depth={bpStatus.m_depth}");
                    
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
                        LogDebug($"Step complete at depth {bpStatus.m_depth}");
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
                        LogDebug($"Hit user breakpoint {bpStatus.m_id} during step");
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
                LogDebug("Device stopped, assuming step complete");
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
        LogDebug("Step timeout, forcing pause");
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
        
        LogDebug($"Setting {tempBreakpointIds.Count} temp breakpoints for step");
        
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
                    LogDebug($"Breakpoint hit: id={bpStatus.m_id}, IP=0x{bpStatus.m_IP:X4}, flags=0x{bpStatus.m_flags:X4}");
                    
                    // Check if we stopped at one of our target IL offsets
                    // This handles the case where a user breakpoint is at the same location
                    if (targetILOffsets.Contains(bpStatus.m_IP))
                    {
                        // We hit a target location - step complete!
                        LogDebug($"Hit step target at IP=0x{bpStatus.m_IP:X4} - step complete");
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
                        LogDebug($"Hit user breakpoint {bpStatus.m_id} at unexpected location");
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
                LogDebug("Device stopped, assuming step complete");
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
        LogDebug("Step timeout, forcing pause");
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
        
        LogDebug($"Setting temp breakpoint {tempBpId} at IL offset 0x{ilOffset:X4}");
        
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
        LogDebug($"Simple step: flags=0x{stepFlags:X4}, depth=0x{depth:X8}");
        
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
                    LogDebug($"Breakpoint hit: id={bpStatus.m_id}, IP=0x{bpStatus.m_IP:X4}, flags=0x{bpStatus.m_flags:X4}");
                    
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
                        LogDebug($"Hit user breakpoint {bpStatus.m_id} while stepping");
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
        LogDebug("Step timeout, forcing pause");
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
                    LogDebug($"Step completed at IP: 0x{bpStatus.m_IP:X4}, flags=0x{bpStatus.m_flags:X4}");
                    
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
                        LogDebug($"Hit breakpoint {bpStatus.m_id} while stepping");
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
                LogDebug("Device stopped, assuming step complete");
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
        LogDebug("Step timeout, forcing pause");
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
            LogDebug($"Step into (thread {threadId})");
            
            uint pid = threadId > 0 ? (uint)threadId : _stoppedThreadId;
            var stack = _engine.GetThreadStack(pid);
            
            if (stack == null || stack.m_data == null || stack.m_data.Length == 0)
            {
                LogDebug("Could not get thread stack for stepping");
                return false;
            }

            // Find the first frame that has source (user code)
            WPCommands.Debugging_Thread_Stack.Reply.Call? targetFrame = null;
            
            for (int i = 0; i < stack.m_data.Length; i++)
            {
                var frame = stack.m_data[i];
                var (location, _) = TryGetSourceLocationForFrame(frame.m_md, frame.m_IP);
                bool hasSource = location != null;
                
                if (hasSource)
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
            LogInfo($"StepIn error: {ex.Message}");
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
            LogDebug($"Step out (thread {threadId})");
            
            uint pid = threadId > 0 ? (uint)threadId : _stoppedThreadId;
            var stack = _engine.GetThreadStack(pid);
            
            if (stack == null || stack.m_data == null || stack.m_data.Length == 0)
            {
                LogDebug("Could not get thread stack for stepping");
                return false;
            }

            // Find the first frame that has source (user code)
            WPCommands.Debugging_Thread_Stack.Reply.Call? targetFrame = null;
            
            for (int i = 0; i < stack.m_data.Length; i++)
            {
                var frame = stack.m_data[i];
                var (location, _) = TryGetSourceLocationForFrame(frame.m_md, frame.m_IP);
                bool hasSource = location != null;
                
                if (hasSource)
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
            LogInfo($"StepOut error: {ex.Message}");
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
            LogDebug("Getting thread list...");
            
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
                
                LogDebug($"Found {threads.Count} threads");
            }
            else
            {
                LogDebug("No threads found, adding default main thread");
                threads.Add(new ThreadInfo { Id = 1, Name = "Main Thread" });
            }
        }
        catch (Exception ex)
        {
            LogInfo($"GetThreads error: {ex.Message}");
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
            LogDebug("GetStackTrace: Not connected or engine is null");
            return frames;
        }

        try
        {
            LogDebug($"Getting stack trace for thread {threadId} (startFrame={startFrame}, levels={levels})...");
            
            // Make sure we have a valid thread ID - use stored ID if 0 was passed
            uint pid = threadId > 0 ? (uint)threadId : _stoppedThreadId;
            LogDebug($"Using thread PID: {pid} (passed threadId={threadId}, _stoppedThreadId={_stoppedThreadId})");
            
            // Get thread stack from device
            var stack = _engine.GetThreadStack(pid);
            
            if (stack != null && stack.m_data != null)
            {
                int endFrame = levels > 0 
                    ? Math.Min(startFrame + levels, stack.m_data.Length) 
                    : stack.m_data.Length;
                
                LogDebug($"Stack has {stack.m_data.Length} frames, returning {startFrame} to {endFrame}");
                
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
                        LogDebug($"Frame {i}: {methodName} at {sourceLocation.SourceFile}:{line}");
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
                LogDebug($"Could not get stack trace from device for thread {pid} (stack={stack}, m_data={(stack?.m_data == null ? "null" : stack.m_data.Length.ToString() + " frames")})");
                
                // Try refreshing the thread list to see what's available
                var currentThreads = _engine.GetThreadList();
                if (currentThreads != null)
                {
                    LogDebug($"Current thread list: [{string.Join(", ", currentThreads)}]");
                }
                else
                {
                    LogDebug("Current thread list is NULL");
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
            LogInfo($"GetStackTrace error: {ex.Message}");
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
            LogDebug($"Getting scopes for frame {frameId} (thread {threadId}, depth {depth}, method 0x{methodToken:X8}, assembly {assemblyName ?? "unknown"})");
            
            // Get stack frame info to determine number of locals and arguments
            var (numArgs, numLocals, evalStackDepth, success) = _engine.GetStackFrameInfo((uint)threadId, (uint)depth);
            
            if (success)
            {
                LogDebug($"Frame has {numArgs} arguments, {numLocals} locals, eval stack depth {evalStackDepth}");
                
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
                LogDebug("Could not get stack frame info, using placeholders");
                
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
            LogInfo($"GetScopes error: {ex.Message}");
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
                LogDebug($"Getting variables for {scopeRef.Type} scope (thread {scopeRef.ThreadId}, depth {scopeRef.Depth})");
                
                // Try to get local variable names from PDB
                string[]? variableNames = null;
                if (scopeRef.Type == ScopeType.Locals && scopeRef.AssemblyName != null && scopeRef.MethodToken != 0)
                {
                    variableNames = _symbolResolver.GetLocalVariableNames(scopeRef.AssemblyName, scopeRef.MethodToken);
                    if (variableNames != null)
                    {
                        LogDebug($"Found {variableNames.Length} local variable names from PDB: [{string.Join(", ", variableNames)}]");
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
                    string? varName = null;
                    bool isUserVariable = true;
                    
                    if (variableNames != null && i < variableNames.Length)
                    {
                        varName = variableNames[i];
                        // Check if this is a compiler-generated variable (name like "local0", "local1", etc.)
                        // These are internal compiler variables that shouldn't be shown to the user
                        if (System.Text.RegularExpressions.Regex.IsMatch(varName, @"^local\d+$"))
                        {
                            isUserVariable = false;
                        }
                    }
                    else
                    {
                        // No symbol info for this variable - it's likely a compiler-generated temporary
                        varName = scopeRef.Type == ScopeType.Arguments ? $"arg{i}" : $"local{i}";
                        // For locals without symbol names, hide them (compiler-generated)
                        // For arguments, we always show them
                        isUserVariable = scopeRef.Type == ScopeType.Arguments;
                    }
                    
                    // Skip compiler-generated variables (locals without proper names from PDB)
                    if (!isUserVariable)
                    {
                        LogDebug($"Skipping compiler-generated variable: {varName}");
                        continue;
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
                        LogDebug($"Error getting variable {i}: {ex.Message}");
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
                LogDebug("Expanding runtime value children");
                
                if (rvRef.Value == null || _engine == null)
                {
                    LogDebug("RuntimeValue or engine is null");
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
            LogInfo($"GetVariables error: {ex.Message}");
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
            LogDebug($"Getting array elements, length={length}");
            
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
                    LogDebug($"Error getting array element {i}: {ex.Message}");
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
            LogInfo($"GetArrayElements error: {ex.Message}");
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
            LogDebug($"Getting object fields, numFields={numFields}");
            
            if (numFields == 0)
            {
                LogDebug("Object has no fields");
                return fields;
            }
            
            // Get the type descriptor to resolve field information
            uint td = objValue.Type;
            LogDebug($"Object type descriptor: 0x{td:X8}");
            
            // Extract assembly index from type descriptor
            uint assemblyIdx = (td >> 16) & 0xFFFF;
            uint typeIdx = td & 0xFFFF;
            LogDebug($"Type descriptor breakdown: assembly={assemblyIdx}, typeIdx={typeIdx}");
            
            // Get type name for logging
            string? typeName = null;
            if (_engine != null)
            {
                try
                {
                    var typeInfo = _engine.ResolveType(td);
                    typeName = typeInfo?.m_name;
                    LogDebug($"Type name: {typeName ?? "unknown"}");
                }
                catch (Exception ex) 
                { 
                    LogDebug($"Failed to resolve type: {ex.Message}");
                }
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
                        LogDebug($"Field {offset}: {fieldName} = {varInfo.Value}");
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
                    LogDebug($"Error getting field at offset {offset}: {ex.Message}");
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
            LogInfo($"GetObjectFields error: {ex.Message}");
        }
        
        return fields;
    }
    
    /// <summary>
    /// Try to resolve a field name by directly querying the engine for field descriptors.
    /// This is the most efficient approach - no assembly scanning needed.
    /// </summary>
    private string? TryResolveFieldName(uint td, uint assemblyIdx, uint fieldOffset, uint numFields)
    {
        if (_engine == null) return null;
        
        try
        {
            // Check cache first
            string cacheKey = $"{td}:{fieldOffset}";
            if (_fieldNameCache.TryGetValue(cacheKey, out string? cachedName))
            {
                return cachedName;
            }
            
            // Strategy: Build a field table for this type by querying fields from the type's assembly
            // The fd (field descriptor) format is: (assemblyIdx << 16) | fieldIdx
            // We query fields and match by m_td (declaring type) and m_offset
            
            // First, ensure we have the field table for this type's assembly
            if (!_typeFieldTablesBuilt.Contains(td))
            {
                BuildTypeFieldTable(td, assemblyIdx);
                _typeFieldTablesBuilt.Add(td);
            }
            
            // Try to find the field in our cached table
            if (_typeFieldTables.TryGetValue(td, out var fieldTable))
            {
                if (fieldTable.TryGetValue(fieldOffset, out string? fieldName))
                {
                    _fieldNameCache[cacheKey] = fieldName;
                    return fieldName;
                }
            }
            
            // Field not found for this type - might be an inherited field
            // Try looking it up directly by scanning a small range of field descriptors
            string? resolvedName = TryResolveFieldByScanning(td, assemblyIdx, fieldOffset);
            if (resolvedName != null)
            {
                _fieldNameCache[cacheKey] = resolvedName;
                return resolvedName;
            }
            
            LogDebug($"Field not found for td=0x{td:X8}, offset={fieldOffset}");
        }
        catch (Exception ex)
        {
            LogDebug($"Error resolving field name: {ex.Message}");
        }
        
        return null;
    }
    
    /// <summary>
    /// Build a field table for a specific type by querying field descriptors
    /// </summary>
    private void BuildTypeFieldTable(uint td, uint assemblyIdx)
    {
        if (_engine == null) return;
        
        LogDebug($"Building field table for type 0x{td:X8} in assembly {assemblyIdx}");
        
        var fieldTable = new Dictionary<uint, string>();
        
        // Query fields from this type's assembly
        // Field descriptors are sequential: (assemblyIdx << 16) | fieldIdx
        // We scan until we find all fields for this type
        
        int fieldsFound = 0;
        int maxFieldIdx = 500; // Reasonable limit per assembly type
        int consecutiveFailures = 0;
        
        for (uint fieldIdx = 0; fieldIdx < maxFieldIdx; fieldIdx++)
        {
            uint fd = (assemblyIdx << 16) | fieldIdx;
            
            try
            {
                var result = _engine.ResolveField(fd);
                
                if (result != null && !string.IsNullOrEmpty(result.m_name))
                {
                    consecutiveFailures = 0;
                    
                    // If this field belongs to our target type, add it to the table
                    if (result.m_td == td)
                    {
                        fieldTable[result.m_offset] = result.m_name;
                        fieldsFound++;
                        LogDebug($"Found field for type: fd=0x{fd:X8}, offset={result.m_offset}, name={result.m_name}");
                    }
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
            
            // Stop if we've had too many consecutive failures
            if (consecutiveFailures > 50)
            {
                break;
            }
        }
        
        _typeFieldTables[td] = fieldTable;
        LogDebug($"Field table for type 0x{td:X8}: {fieldsFound} fields found");
    }
    
    /// <summary>
    /// Try to resolve a field by scanning a range of field descriptors
    /// This handles inherited fields by checking multiple assemblies
    /// </summary>
    private string? TryResolveFieldByScanning(uint td, uint assemblyIdx, uint fieldOffset)
    {
        if (_engine == null) return null;
        
        // For inherited fields, we need to look in other assemblies
        // Common base type assemblies: 0 (mscorlib), 1-3 (nanoFramework.*)
        uint[] assembliesToCheck = { assemblyIdx, 0, 1, 2, 3 };
        
        foreach (uint asmIdx in assembliesToCheck)
        {
            // Scan a limited range of field descriptors
            for (uint fieldIdx = 0; fieldIdx < 200; fieldIdx++)
            {
                uint fd = (asmIdx << 16) | fieldIdx;
                
                try
                {
                    var result = _engine.ResolveField(fd);
                    
                    if (result != null && !string.IsNullOrEmpty(result.m_name))
                    {
                        // Check if this field matches our criteria:
                        // - Same offset as what we're looking for
                        // - Could be from this type or a base type
                        if (result.m_offset == fieldOffset)
                        {
                            // Store in type field table for future lookups
                            if (!_typeFieldTables.ContainsKey(result.m_td))
                            {
                                _typeFieldTables[result.m_td] = new Dictionary<uint, string>();
                            }
                            _typeFieldTables[result.m_td][result.m_offset] = result.m_name;
                            
                            // For the original type, cache this mapping too
                            string cacheKey = $"{td}:{fieldOffset}";
                            _fieldNameCache[cacheKey] = result.m_name;
                            
                            return result.m_name;
                        }
                    }
                }
                catch
                {
                    // Ignore errors, continue scanning
                }
            }
        }
        
        return null;
    }
    
    // Cache for field names: key = "{td}:{offset}", value = field name
    private readonly Dictionary<string, string> _fieldNameCache = new();
    
    // Field tables per type: key = td, value = dictionary of offset -> name
    private readonly Dictionary<uint, Dictionary<uint, string>> _typeFieldTables = new();
    
    // Track which types have had their field tables built
    private readonly HashSet<uint> _typeFieldTablesBuilt = new();

    /// <summary>
    /// Set the value of a variable
    /// </summary>
    /// <param name="variablesReference">The scope or parent variable reference</param>
    /// <param name="name">The name of the variable to set</param>
    /// <param name="value">The new value as a string</param>
    /// <returns>Result containing the new value if successful</returns>
    public async Task<(bool Success, SetVariableResult? Result, string? Error)> SetVariable(int variablesReference, string name, string value)
    {
        if (!_isConnected || _engine == null)
        {
            return (false, null, "Not connected");
        }

        if (!_variablesReferences.TryGetValue(variablesReference, out var reference))
        {
            return (false, null, "Invalid variables reference");
        }

        try
        {
            LogDebug($"SetVariable: variablesReference={variablesReference}, name='{name}', value='{value}'");

            RuntimeValue? targetValue = null;
            string? typeName = null;

            if (reference is ScopeReference scopeRef)
            {
                // Setting a local variable or argument
                LogDebug($"Setting variable in {scopeRef.Type} scope (thread {scopeRef.ThreadId}, depth {scopeRef.Depth})");

                // Get local variable names from PDB to find the index
                string[]? variableNames = null;
                if (scopeRef.AssemblyName != null && scopeRef.MethodToken != 0)
                {
                    variableNames = _symbolResolver.GetLocalVariableNames(scopeRef.AssemblyName, scopeRef.MethodToken);
                }

                // Find the variable index by name
                int varIndex = -1;
                if (scopeRef.Type == ScopeType.Arguments)
                {
                    // For arguments, parse "arg0", "arg1" etc if numeric, otherwise search by name
                    if (name.StartsWith("arg") && int.TryParse(name.Substring(3), out varIndex))
                    {
                        // Already have index from name
                    }
                    else
                    {
                        // TODO: Could get argument names from PDB in the future
                        return (false, null, $"Cannot find argument '{name}'");
                    }
                }
                else
                {
                    // For locals, search by name in variable names array
                    if (variableNames != null)
                    {
                        for (int i = 0; i < variableNames.Length; i++)
                        {
                            if (variableNames[i] == name)
                            {
                                varIndex = i;
                                break;
                            }
                        }
                    }

                    if (varIndex < 0)
                    {
                        // Try parsing "local0", "local1" format
                        if (name.StartsWith("local") && int.TryParse(name.Substring(5), out varIndex))
                        {
                            // Already have index from name
                        }
                        else
                        {
                            return (false, null, $"Cannot find local variable '{name}'");
                        }
                    }
                }

                // Get the current runtime value for this variable
                Engine.StackValueKind kind = scopeRef.Type == ScopeType.Arguments
                    ? Engine.StackValueKind.Argument
                    : Engine.StackValueKind.Local;

                targetValue = _engine.GetStackFrameValue(
                    (uint)scopeRef.ThreadId,
                    (uint)scopeRef.Depth,
                    kind,
                    (uint)varIndex);

                if (targetValue == null)
                {
                    return (false, null, $"Cannot get runtime value for '{name}'");
                }
            }
            else if (reference is RuntimeValueReference rvRef)
            {
                // Setting a field or array element within an object
                if (rvRef.Value == null)
                {
                    return (false, null, "Parent value is null");
                }

                if (rvRef.Value.IsArray || rvRef.Value.IsArrayReference)
                {
                    // Array element: name should be "[index]"
                    if (name.StartsWith("[") && name.EndsWith("]"))
                    {
                        string indexStr = name.Substring(1, name.Length - 2);
                        if (uint.TryParse(indexStr, out uint index))
                        {
                            targetValue = rvRef.Value.GetElement(index);
                        }
                        else
                        {
                            return (false, null, $"Invalid array index: {name}");
                        }
                    }
                    else
                    {
                        return (false, null, $"Expected array index format '[n]', got '{name}'");
                    }
                }
                else
                {
                    // Object field: find by name
                    uint numFields = rvRef.Value.NumOfFields;
                    uint td = rvRef.Value.Type;
                    uint assemblyIdx = (td >> 16) & 0xFFFF;

                    for (uint offset = 0; offset < numFields; offset++)
                    {
                        string? fieldName = TryResolveFieldName(td, assemblyIdx, offset, numFields);
                        if (fieldName == name)
                        {
                            targetValue = rvRef.Value.GetField(offset, 0);
                            break;
                        }
                    }

                    if (targetValue == null)
                    {
                        return (false, null, $"Cannot find field '{name}'");
                    }
                }
            }
            else
            {
                return (false, null, "Invalid reference type");
            }

            // Now set the value
            if (targetValue == null)
            {
                return (false, null, "Target value not found");
            }

            // Resolve type name
            if (_engine != null && targetValue.Type != 0)
            {
                try
                {
                    var typeInfo = _engine.ResolveType(targetValue.Type);
                    typeName = typeInfo?.m_name;
                }
                catch { }
            }

            // Parse and set the value based on the target type
            bool setSuccess = false;
            object? newValue = null;

            if (targetValue.IsPrimitive)
            {
                // Parse the string value based on the data type
                newValue = ParsePrimitiveValue(targetValue, value);
                if (newValue != null)
                {
                    targetValue.Value = newValue;
                    setSuccess = true;
                }
                else
                {
                    return (false, null, $"Cannot parse '{value}' as {typeName ?? "primitive"}");
                }
            }
            else if (value == "null")
            {
                // Setting to null (for reference types)
                // This requires using Assign with a null reference
                // For now, return error - full null assignment requires more complex handling
                return (false, null, "Setting to null is not currently supported");
            }
            else
            {
                // Non-primitive types can't be easily set from a string value
                return (false, null, $"Cannot set value for type {typeName ?? "object"} - only primitive types supported");
            }

            if (!setSuccess)
            {
                return (false, null, "Failed to set variable value");
            }

            // Return the new value info
            var result = new SetVariableResult
            {
                Value = newValue?.ToString() ?? "null",
                Type = typeName ?? "unknown",
                VariablesReference = 0 // Primitives don't have children
            };

            LogDebug($"Successfully set {name} = {result.Value}");

            await Task.CompletedTask;
            return (true, result, null);
        }
        catch (Exception ex)
        {
            LogInfo($"SetVariable error: {ex.Message}");
            return (false, null, ex.Message);
        }
    }

    /// <summary>
    /// Parse a string value into the appropriate primitive type
    /// </summary>
    private object? ParsePrimitiveValue(RuntimeValue targetValue, string value)
    {
        try
        {
            var dataType = targetValue.DataType;
            
            switch (dataType)
            {
                case nanoClrDataType.DATATYPE_BOOLEAN:
                    if (bool.TryParse(value, out bool boolVal))
                        return boolVal;
                    if (value == "1" || value.ToLower() == "true")
                        return true;
                    if (value == "0" || value.ToLower() == "false")
                        return false;
                    break;

                case nanoClrDataType.DATATYPE_I1:
                    if (sbyte.TryParse(value, out sbyte sbyteVal))
                        return sbyteVal;
                    break;

                case nanoClrDataType.DATATYPE_U1:
                    if (byte.TryParse(value, out byte byteVal))
                        return byteVal;
                    break;

                case nanoClrDataType.DATATYPE_CHAR:
                    if (value.Length == 1)
                        return value[0];
                    if (value.Length == 3 && value.StartsWith("'") && value.EndsWith("'"))
                        return value[1];
                    if (char.TryParse(value, out char charVal))
                        return charVal;
                    break;

                case nanoClrDataType.DATATYPE_I2:
                    if (short.TryParse(value, out short shortVal))
                        return shortVal;
                    break;

                case nanoClrDataType.DATATYPE_U2:
                    if (ushort.TryParse(value, out ushort ushortVal))
                        return ushortVal;
                    break;

                case nanoClrDataType.DATATYPE_I4:
                    if (int.TryParse(value, out int intVal))
                        return intVal;
                    break;

                case nanoClrDataType.DATATYPE_U4:
                    if (uint.TryParse(value, out uint uintVal))
                        return uintVal;
                    break;

                case nanoClrDataType.DATATYPE_I8:
                    if (long.TryParse(value, out long longVal))
                        return longVal;
                    break;

                case nanoClrDataType.DATATYPE_U8:
                    if (ulong.TryParse(value, out ulong ulongVal))
                        return ulongVal;
                    break;

                case nanoClrDataType.DATATYPE_R4:
                    if (float.TryParse(value, System.Globalization.NumberStyles.Float, 
                        System.Globalization.CultureInfo.InvariantCulture, out float floatVal))
                        return floatVal;
                    break;

                case nanoClrDataType.DATATYPE_R8:
                    if (double.TryParse(value, System.Globalization.NumberStyles.Float,
                        System.Globalization.CultureInfo.InvariantCulture, out double doubleVal))
                        return doubleVal;
                    break;
            }
        }
        catch (Exception ex)
        {
            LogDebug($"Error parsing primitive value: {ex.Message}");
        }

        return null;
    }

    /// <summary>
    /// Get the type name for a runtime value, with fallback to data type name
    /// </summary>
    private string GetTypeName(RuntimeValue runtimeValue)
    {
        // First, try to resolve from the type descriptor
        if (_engine != null && runtimeValue.Type != 0)
        {
            try
            {
                var typeInfo = _engine.ResolveType(runtimeValue.Type);
                if (typeInfo != null && !string.IsNullOrEmpty(typeInfo.m_name))
                {
                    LogDebug($"GetTypeName: Resolved type 0x{runtimeValue.Type:X8} to '{typeInfo.m_name}'");
                    return typeInfo.m_name;
                }
                else
                {
                    LogDebug($"GetTypeName: ResolveType returned null/empty for type 0x{runtimeValue.Type:X8}");
                }
            }
            catch (Exception ex)
            {
                LogDebug($"GetTypeName: Exception resolving type 0x{runtimeValue.Type:X8}: {ex.Message}");
            }
        }
        else
        {
            LogDebug($"GetTypeName: Type is 0 or engine is null, DataType={runtimeValue.DataType}");
        }

        // Fallback: use the DataType enum to provide a meaningful name
        var dataType = runtimeValue.DataType;
        var fallbackName = dataType switch
        {
            nanoClrDataType.DATATYPE_BOOLEAN => "Boolean",
            nanoClrDataType.DATATYPE_I1 => "SByte",
            nanoClrDataType.DATATYPE_U1 => "Byte",
            nanoClrDataType.DATATYPE_CHAR => "Char",
            nanoClrDataType.DATATYPE_I2 => "Int16",
            nanoClrDataType.DATATYPE_U2 => "UInt16",
            nanoClrDataType.DATATYPE_I4 => "Int32",
            nanoClrDataType.DATATYPE_U4 => "UInt32",
            nanoClrDataType.DATATYPE_I8 => "Int64",
            nanoClrDataType.DATATYPE_U8 => "UInt64",
            nanoClrDataType.DATATYPE_R4 => "Single",
            nanoClrDataType.DATATYPE_R8 => "Double",
            nanoClrDataType.DATATYPE_STRING => "String",
            nanoClrDataType.DATATYPE_DATETIME => "DateTime",
            nanoClrDataType.DATATYPE_TIMESPAN => "TimeSpan",
            nanoClrDataType.DATATYPE_SZARRAY => "Array",
            nanoClrDataType.DATATYPE_OBJECT => "Object",
            nanoClrDataType.DATATYPE_CLASS => "Class",
            nanoClrDataType.DATATYPE_VALUETYPE => "ValueType",
            nanoClrDataType.DATATYPE_BYREF => "ByRef",
            _ => $"Unknown({dataType})"
        };
        
        LogDebug($"GetTypeName: Using fallback name '{fallbackName}' for DataType={dataType}");
        return fallbackName;
    }

    private VariableInfo CreateVariableInfo(RuntimeValue runtimeValue, string defaultName)
    {
        string name = defaultName;
        string value;
        string typeName = GetTypeName(runtimeValue);
        int childRef = 0;
        
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
            // Reference type - show full type name
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
            LogDebug($"Evaluate: expression='{expression}', frameId={frameId}, context={context}");
            LogDebug($"Evaluate: _frameIdMap has {_frameIdMap.Count} entries: [{string.Join(", ", _frameIdMap.Keys)}]");
            
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
                                    LogDebug($"Evaluate result: {varName} = {varInfo.Value}");
                                    
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
                                LogDebug($"Error getting variable {varName}: {ex.Message}");
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
                                    LogDebug($"Evaluate result: {argName} = {varInfo.Value}");
                                    
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
                                LogDebug($"Error getting argument {argName}: {ex.Message}");
                            }
                        }
                    }
                    
                    // Try to find the variable as a static field by scanning all fields
                    // Note: pdbx files don't contain field names, only tokens
                    // So we need to query the device directly for field names
                    if (assemblyName != null)
                    {
                        LogDebug($"Evaluate: Looking for static field '{expression}' by scanning device fields");
                        
                        // Get assembly index
                        uint? assemblyIdx = _assemblyManager.GetAssemblyIndex(assemblyName);
                        if (!assemblyIdx.HasValue)
                        {
                            assemblyIdx = _assemblyManager.GetAssemblyIndex(assemblyName + ".exe");
                        }
                        if (!assemblyIdx.HasValue)
                        {
                            assemblyIdx = _assemblyManager.GetAssemblyIndex(assemblyName + ".dll");
                        }
                        
                        if (assemblyIdx.HasValue)
                        {
                            LogDebug($"Evaluate: Scanning fields in assembly index {assemblyIdx.Value} for '{expression}'");
                            
                            // Scan fields in this assembly to find one with the matching name
                            uint? foundFd = null;
                            int fieldsFound = 0;
                            int consecutiveFailures = 0;
                            
                            for (uint fieldIdx = 0; fieldIdx < 500 && consecutiveFailures < 50; fieldIdx++)
                            {
                                uint fd = (assemblyIdx.Value << 16) | fieldIdx;
                                
                                try
                                {
                                    var resolved = _engine.ResolveField(fd);
                                    if (resolved != null && !string.IsNullOrEmpty(resolved.m_name))
                                    {
                                        fieldsFound++;
                                        consecutiveFailures = 0;
                                        
                                        // Log first few fields to help debug
                                        if (fieldsFound <= 10)
                                        {
                                            LogDebug($"Evaluate: Found field at fd=0x{fd:X8}: '{resolved.m_name}' (type=0x{resolved.m_td:X8})");
                                        }
                                        
                                        // Field names from device are fully qualified: "Namespace.Class::FieldName"
                                        // Extract just the field name for comparison
                                        string fieldNameOnly = resolved.m_name;
                                        int separatorIdx = resolved.m_name.LastIndexOf("::", StringComparison.Ordinal);
                                        if (separatorIdx >= 0)
                                        {
                                            fieldNameOnly = resolved.m_name.Substring(separatorIdx + 2);
                                        }
                                        
                                        if (string.Equals(fieldNameOnly, expression, StringComparison.Ordinal))
                                        {
                                            LogDebug($"Evaluate: MATCH! Field '{expression}' found at fd=0x{fd:X8} (full name: '{resolved.m_name}')");
                                            foundFd = fd;
                                            break;
                                        }
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
                            }
                            
                            LogDebug($"Evaluate: Scanned fields, found {fieldsFound} total fields in assembly");
                            
                            if (foundFd.HasValue)
                            {
                                try
                                {
                                    var runtimeValue = _engine.GetStaticFieldValue(foundFd.Value);
                                    if (runtimeValue != null)
                                    {
                                        var varInfo = CreateVariableInfo(runtimeValue, expression);
                                        LogDebug($"Evaluate result: static field {expression} = {varInfo.Value}");
                                        
                                        return new EvaluateResult(true, new EvaluateResultData
                                        {
                                            Value = varInfo.Value,
                                            Type = varInfo.Type,
                                            HasChildren = varInfo.VariablesReference > 0,
                                            VariablesReference = varInfo.VariablesReference
                                        });
                                    }
                                    else
                                    {
                                        LogDebug($"Evaluate: GetStaticFieldValue returned null for fd=0x{foundFd.Value:X8}");
                                    }
                                }
                                catch (Exception ex)
                                {
                                    LogDebug($"Error getting static field {expression}: {ex.Message}");
                                }
                            }
                            else
                            {
                                LogDebug($"Evaluate: Field '{expression}' not found in assembly {assemblyIdx.Value} (scanned {fieldsFound} fields)");
                            }
                        }
                        else
                        {
                            LogDebug($"Evaluate: Could not get assembly index for '{assemblyName}'");
                        }
                    }
                }
            }
            
            // Variable not found or no frame specified
            LogDebug($"Evaluate: variable '{expression}' not found");
            await Task.CompletedTask;
            return new EvaluateResult(false, Error: $"Cannot evaluate '{expression}'");
        }
        catch (Exception ex)
        {
            LogInfo($"Evaluate error: {ex.Message}");
            return new EvaluateResult(false, Error: ex.Message);
        }
    }

    /// <summary>
    /// Deploy assemblies to the device
    /// </summary>
    public async Task<DeployResult> Deploy(string assembliesPath)
    {
        if (!_isConnected || _engine == null)
        {
            return new DeployResult(false, "Not connected");
        }

        try
        {
            LogInfo($"Deploying assemblies from {assembliesPath}...");
            
            // Get all .pe files from the assemblies folder
            var peFiles = Directory.GetFiles(assembliesPath, "*.pe");
            
            if (peFiles.Length == 0)
            {
                LogDebug("No .pe files found in assembly path");
                return new DeployResult(false, "No .pe files found");
            }
            
            LogDebug($"Found {peFiles.Length} assembly file(s) to deploy");
            
            // Load assemblies as byte arrays (word-aligned to 4 bytes)
            List<byte[]> assemblies = new List<byte[]>();
            
            foreach (var peFile in peFiles)
            {
                var fileName = Path.GetFileName(peFile);
                LogDebug($"Loading assembly: {fileName}");
                
                using var fs = File.Open(peFile, FileMode.Open, FileAccess.Read);
                // Word-align to 4 bytes (required by nanoFramework)
                long length = (fs.Length + 3) / 4 * 4;
                byte[] buffer = new byte[length];
                fs.Read(buffer, 0, (int)fs.Length);
                assemblies.Add(buffer);
                
                LogDebug($"  Loaded {fs.Length} bytes (padded to {length})");
            }
            
            // Progress reporting
            var progress = new Progress<MessageWithProgress>(msg =>
            {
                RaiseEvent("output", new OutputEventBody
                {
                    Category = "console",
                    Output = $"[Deploy] {msg.Message}\n"
                });
            });
            
            var log = new Progress<string>(msg =>
            {
                LogDebug($"[Deploy] {msg}");
            });
            
            // Deploy using nf-debugger Engine
            // rebootAfterDeploy: false - we'll manually control execution
            // skipErase: false - erase before writing for clean deployment
            LogDebug("Starting deployment to device...");
            
            bool result = _engine.DeploymentExecute(
                assemblies,
                rebootAfterDeploy: false,  // Don't reboot - we want to start debugging
                skipErase: false,
                progress: progress,
                log: log);
            
            if (result)
            {
                LogInfo("Deployment completed successfully");
                
                RaiseEvent("output", new OutputEventBody
                {
                    Category = "console",
                    Output = $"Deployed {peFiles.Length} assembly file(s) successfully\n"
                });
            }
            else
            {
                LogDebug("Deployment failed");
            }
            
            await Task.CompletedTask;
            return new DeployResult(result, result ? null : "Deployment failed");
        }
        catch (Exception ex)
        {
            LogInfo($"Deploy error: {ex.Message}");
            return new DeployResult(false, ex.Message);
        }
    }

    /// <summary>
    /// Start execution on the device (for launch mode - after deployment)
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
            LogDebug($"Starting execution (stopOnEntry: {stopOnEntry})");
            
            // After deployment, we need to reboot the CLR to start fresh execution
            LogDebug("Rebooting CLR to start execution...");
            
            // Use RebootDevice with ClrOnly option to restart just the CLR
            // This is faster than a full reboot and starts the deployed application
            bool rebooted = _engine.RebootDevice(RebootOptions.ClrOnly);
            LogDebug($"RebootDevice returned: {rebooted}");
            
            if (!rebooted)
            {
                LogDebug("Failed to reboot CLR");
                return false;
            }
            
            // Wait for the device to reboot and reconnect
            LogDebug("Waiting for device to restart...");
            await Task.Delay(1000);
            
            // Re-establish connection after reboot
            for (int attempt = 0; attempt < 10; attempt++)
            {
                await Task.Delay(500);
                
                if (_engine.IsConnectedTonanoCLR)
                {
                    LogDebug("Device reconnected to nanoCLR");
                    break;
                }
                
                LogDebug($"Waiting for reconnect (attempt {attempt + 1}/10)...");
            }
            
            if (!_engine.IsConnectedTonanoCLR)
            {
                LogDebug("Failed to reconnect after reboot");
                return false;
            }
            
            // Re-enable source-level debugging after reboot
            LogDebug("Re-enabling source-level debugging...");
            _engine.UpdateDebugFlags();
            
            // Query device assemblies again after reboot
            await QueryDeviceAssemblies();
            
            // Re-apply breakpoints now that assemblies are loaded with correct indices
            await ReapplyBreakpointsAfterReboot();
            
            if (stopOnEntry)
            {
                // For stopOnEntry, we need to set a breakpoint at the entry point and let it run
                // We can't just pause - there are no threads yet before Main() starts
                LogDebug("Setting up stop at entry point...");
                
                // Find the entry point method from symbols and set a temporary breakpoint
                var entryPointBp = SetEntryPointBreakpoint();
                
                if (entryPointBp != null)
                {
                    LogDebug($"Entry point breakpoint set at IL offset {entryPointBp.m_IP}");
                }
                else
                {
                    LogDebug("Could not set entry point breakpoint, will stop at first breakpoint");
                }
                
                // Resume execution so the program can start and hit the entry point
                LogDebug("Resuming execution to hit entry point...");
                _engine.ResumeExecution();
                
                // Wait for the entry point breakpoint to be hit
                await WaitForEntryPointHit(entryPointBp);
            }
            else
            {
                // Resume execution and set up breakpoint polling
                LogDebug("Resuming execution...");
                _engine.ResumeExecution();
                
                // Cancel any existing polling task and start a new one
                _breakpointPollCts?.Cancel();
                _breakpointPollCts = new CancellationTokenSource();
                _ = PollForBreakpointHitAsync(_breakpointPollCts.Token);
            }

            return true;
        }
        catch (Exception ex)
        {
            LogDebug($"StartExecution error: {ex.Message}");
            return false;
        }
    }
    
    /// <summary>
    /// Set a temporary breakpoint at the program entry point (first line of Main)
    /// </summary>
    private WPCommands.Debugging_Execution_BreakpointDef? SetEntryPointBreakpoint()
    {
        if (_engine == null) return null;
        
        try
        {
            // Find the entry point from loaded symbols
            // The entry point is typically the first method in the user assembly (Blinky.exe)
            // We need to find the first executable line
            var entryPoint = _symbolResolver.GetEntryPointLocation();
            
            if (entryPoint == null)
            {
                LogDebug("Could not find entry point from symbols");
                return null;
            }
            
            LogDebug($"Entry point found: {Path.GetFileName(entryPoint.SourceFile ?? "unknown")}:{entryPoint.Line}, " +
                      $"assembly={entryPoint.AssemblyName}, method=0x{entryPoint.MethodToken:X8}, IL={entryPoint.ILOffset}");
            
            // Get device assembly index
            var assemblyInfo = _assemblyManager.GetDeviceAssembly(entryPoint.AssemblyName);
            if (assemblyInfo == null)
            {
                var nameNoExt = Path.GetFileNameWithoutExtension(entryPoint.AssemblyName);
                assemblyInfo = _assemblyManager.GetDeviceAssembly(nameNoExt);
            }
            
            if (assemblyInfo == null)
            {
                LogDebug($"Could not find device assembly for '{entryPoint.AssemblyName}'");
                return null;
            }
            
            entryPoint.AssemblyIdx = (uint)assemblyInfo.DeviceIndex;
            
            // Create entry point breakpoint with special ID (-2 to distinguish from user breakpoints)
            var entryBp = new WPCommands.Debugging_Execution_BreakpointDef
            {
                m_id = -2, // Special ID for entry point breakpoint
                m_flags = WPCommands.Debugging_Execution_BreakpointDef.c_HARD,
                m_md = entryPoint.DeviceMethodIndex,
                m_IP = entryPoint.ILOffset,
                m_pid = WPCommands.Debugging_Execution_BreakpointDef.c_PID_ANY,
                m_depth = 0
            };
            
            // Add to active breakpoints and set on device
            var allBreakpoints = _activeBreakpointDefs.ToList();
            allBreakpoints.Add(entryBp);
            
            LogDebug($"Setting entry point breakpoint: md=0x{entryBp.m_md:X8}, IP={entryBp.m_IP}");
            bool success = _engine.SetBreakpoints(allBreakpoints.ToArray());
            LogDebug($"SetBreakpoints (with entry point) returned: {success}");
            
            return success ? entryBp : null;
        }
        catch (Exception ex)
        {
            LogDebug($"Error setting entry point breakpoint: {ex.Message}");
            return null;
        }
    }
    
    /// <summary>
    /// Wait for the entry point breakpoint to be hit
    /// </summary>
    private async Task WaitForEntryPointHit(WPCommands.Debugging_Execution_BreakpointDef? entryBp)
    {
        if (_engine == null) return;
        
        LogDebug("Waiting for entry point hit...");
        
        // Poll for breakpoint hit (up to 30 seconds)
        for (int i = 0; i < 300; i++)
        {
            await Task.Delay(100);
            
            var state = _engine.GetExecutionMode();
            bool isStopped = ((uint)state & 0x80000000) != 0;
            
            if (isStopped)
            {
                LogDebug($"Device stopped (state: {state})");
                
                // Get thread list now that we have a running thread
                _lastThreadList = _engine.GetThreadList();
                _stoppedThreadId = _lastThreadList?.FirstOrDefault() ?? 1u;
                LogDebug($"Thread list: [{string.Join(", ", _lastThreadList ?? Array.Empty<uint>())}], using {_stoppedThreadId}");
                
                // Check if we hit the entry point breakpoint or a user breakpoint
                var bpStatus = _engine.GetBreakpointStatus();
                if (bpStatus != null)
                {
                    LogDebug($"Breakpoint status: id={bpStatus.m_id}, flags=0x{bpStatus.m_flags:X4}, IP={bpStatus.m_IP}");
                    
                    if (bpStatus.m_id == -2)
                    {
                        // Hit entry point breakpoint - remove it and notify
                        LogDebug("Hit entry point breakpoint");
                        
                        // Remove the entry point breakpoint (keep only user breakpoints)
                        _engine.SetBreakpoints(_activeBreakpointDefs.ToArray());
                        
                        RaiseEvent("stopped", new StoppedEventBody
                        {
                            Reason = "entry",
                            ThreadId = (int)_stoppedThreadId,
                            AllThreadsStopped = true,
                            Text = "Stopped at entry point"
                        });
                        return;
                    }
                    else if (bpStatus.m_id > 0)
                    {
                        // Hit a user breakpoint
                        LogDebug($"Hit user breakpoint {bpStatus.m_id}");
                        
                        // Remove entry point breakpoint if set
                        if (entryBp != null)
                        {
                            _engine.SetBreakpoints(_activeBreakpointDefs.ToArray());
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
                
                // Stopped for some other reason (step, pause, etc.)
                LogDebug("Stopped (no specific breakpoint)");
                
                // Remove entry point breakpoint if set
                if (entryBp != null)
                {
                    _engine.SetBreakpoints(_activeBreakpointDefs.ToArray());
                }
                
                RaiseEvent("stopped", new StoppedEventBody
                {
                    Reason = "entry",
                    ThreadId = (int)_stoppedThreadId,
                    AllThreadsStopped = true,
                    Text = "Stopped at entry point"
                });
                return;
            }
        }
        
        LogDebug("Timeout waiting for entry point hit");
        
        // Timed out - try to pause and report
        _engine.PauseExecution();
        await Task.Delay(200);
        
        _lastThreadList = _engine.GetThreadList();
        _stoppedThreadId = _lastThreadList?.FirstOrDefault() ?? 1u;
        
        RaiseEvent("stopped", new StoppedEventBody
        {
            Reason = "pause",
            ThreadId = (int)_stoppedThreadId,
            AllThreadsStopped = true,
            Text = "Execution paused (entry point timeout)"
        });
    }
    
    /// <summary>
    /// Query device for loaded assemblies and register them
    /// </summary>
    private async Task QueryDeviceAssemblies()
    {
        if (_engine == null) return;
        
        try
        {
            LogDebug("Querying device assemblies...");
            
            // Get list of resolved assemblies from the device
            var assemblies = _engine.ResolveAllAssemblies();
            
            if (assemblies != null && assemblies.Count > 0)
            {
                LogDebug($"Device has {assemblies.Count} assemblies loaded:");
                
                foreach (var assembly in assemblies)
                {
                    if (assembly.Result != null)
                    {
                        var name = assembly.Result.Name;
                        var version = new Version(
                            assembly.Result.Version.MajorVersion,
                            assembly.Result.Version.MinorVersion,
                            assembly.Result.Version.BuildNumber,
                            assembly.Result.Version.RevisionNumber);
                        // Idx from device is in format (assembly_index << 16), extract actual index
                        var rawIdx = assembly.Idx;
                        var idx = (int)(rawIdx >> 16);
                        
                        LogDebug($"  Assembly Idx=0x{rawIdx:X8} (index={idx}): {name} v{version}");
                        _assemblyManager.RegisterDeviceAssembly(name, version, 0, idx);
                    }
                }
            }
            else
            {
                LogDebug("No assemblies found on device");
            }
        }
        catch (Exception ex)
        {
            LogDebug($"Error querying assemblies: {ex.Message}");
        }
        
        await Task.CompletedTask;
    }

    /// <summary>
    /// Handle device reboot that occurred during a debug operation (like stepping).
    /// This can happen when stepping over native code that causes a device reset.
    /// </summary>
    private async Task HandleDeviceRebootDuringDebug()
    {
        LogDebug("Handling device reboot during debug operation...");
        
        try
        {
            // Wait for device to come back up
            LogDebug("Waiting for device to restart...");
            await Task.Delay(500);
            
            // Try to reconnect
            for (int attempt = 0; attempt < 20; attempt++)
            {
                await Task.Delay(500);
                
                if (_engine.IsConnectedTonanoCLR)
                {
                    LogDebug("Device reconnected after reboot");
                    break;
                }
                
                LogDebug($"Waiting for reconnect (attempt {attempt + 1}/20)...");
            }
            
            if (!_engine.IsConnectedTonanoCLR)
            {
                LogDebug("Failed to reconnect after unexpected reboot");
                RaiseEvent("stopped", new StoppedEventBody
                {
                    Reason = "exception",
                    ThreadId = 1,
                    AllThreadsStopped = true,
                    Text = "Device rebooted unexpectedly during step operation"
                });
                return;
            }
            
            // Re-enable source-level debugging
            LogDebug("Re-enabling source-level debugging after unexpected reboot...");
            _engine.UpdateDebugFlags();
            
            // Query device assemblies again
            await QueryDeviceAssemblies();
            
            // Re-apply breakpoints
            await ReapplyBreakpointsAfterReboot();
            
            // Wait for a thread to appear
            for (int i = 0; i < 20; i++)
            {
                await Task.Delay(200);
                var threads = _engine.GetThreadList();
                if (threads != null && threads.Length > 0)
                {
                    LogDebug($"Thread appeared: pid={threads[0]}");
                    _stoppedThreadId = threads[0];
                    
                    // Pause execution
                    _engine.PauseExecution();
                    await Task.Delay(100);
                    
                    // Send stopped event
                    RaiseEvent("stopped", new StoppedEventBody
                    {
                        Reason = "step",
                        ThreadId = (int)_stoppedThreadId,
                        AllThreadsStopped = true,
                        Text = "Stopped after device reboot"
                    });
                    return;
                }
            }
            
            // No threads appeared - resume execution and start polling
            LogDebug("No threads appeared after reboot, resuming execution...");
            _engine.ResumeExecution();
            
            // Start breakpoint polling
            _breakpointPollCts?.Cancel();
            _breakpointPollCts = new CancellationTokenSource();
            _ = PollForBreakpointHitAsync(_breakpointPollCts.Token);
        }
        catch (Exception ex)
        {
            LogDebug($"Error handling device reboot: {ex.Message}");
            RaiseEvent("stopped", new StoppedEventBody
            {
                Reason = "exception",
                ThreadId = 1,
                AllThreadsStopped = true,
                Text = $"Error recovering from device reboot: {ex.Message}"
            });
        }
    }

    /// <summary>
    /// Re-apply all breakpoints after CLR reboot.
    /// This is necessary because after deployment and CLR reboot, the assembly indices change
    /// and breakpoints need to be re-created with the correct indices.
    /// </summary>
    private async Task ReapplyBreakpointsAfterReboot()
    {
        if (_engine == null || _breakpoints.Count == 0)
        {
            return;
        }

        try
        {
            LogDebug($"Re-applying {_breakpoints.Count} breakpoint(s) after CLR reboot...");
            
            // Clear old device breakpoint definitions (they had wrong assembly indices)
            _activeBreakpointDefs.Clear();
            
            // Collect breakpoint info to re-apply
            var breakpointsToReapply = _breakpoints.Values.ToList();
            
            foreach (var bp in breakpointsToReapply)
            {
                if (bp.Source?.Path == null || bp.Line == null)
                {
                    LogDebug($"  Breakpoint {bp.Id}: Missing source info, skipping");
                    continue;
                }
                
                var file = bp.Source.Path;
                var line = bp.Line.Value;
                
                LogDebug($"  Re-applying breakpoint {bp.Id} at {Path.GetFileName(file)}:{line}");
                
                // Re-resolve the source location with updated assembly indices
                var bpLocation = _symbolResolver.GetBreakpointLocation(file, line);
                
                if (bpLocation != null)
                {
                    // Get the assembly Idx from the device (now should have correct index)
                    var assemblyInfo = _assemblyManager.GetDeviceAssembly(bpLocation.AssemblyName);
                    if (assemblyInfo == null)
                    {
                        // Try without extension
                        var assemblyNameNoExt = Path.GetFileNameWithoutExtension(bpLocation.AssemblyName);
                        assemblyInfo = _assemblyManager.GetDeviceAssembly(assemblyNameNoExt);
                    }
                    
                    if (assemblyInfo != null)
                    {
                        bpLocation.AssemblyIdx = (uint)assemblyInfo.DeviceIndex;
                        LogDebug($"    Assembly '{bpLocation.AssemblyName}' has device Idx 0x{bpLocation.AssemblyIdx:X8}");
                        
                        // Create the breakpoint definition for the device
                        var bpDef = new WPCommands.Debugging_Execution_BreakpointDef
                        {
                            m_id = (short)bp.Id,
                            m_flags = WPCommands.Debugging_Execution_BreakpointDef.c_HARD,
                            m_md = bpLocation.DeviceMethodIndex,
                            m_IP = bpLocation.ILOffset,
                            m_pid = WPCommands.Debugging_Execution_BreakpointDef.c_PID_ANY,
                            m_depth = 0
                        };
                        _activeBreakpointDefs.Add(bpDef);
                        
                        LogDebug($"    Created breakpoint def: id={bp.Id}, md=0x{bpDef.m_md:X8}, IP={bpDef.m_IP}");
                        
                        // Update breakpoint as verified
                        bp.Verified = true;
                        bp.Message = null;
                    }
                    else
                    {
                        LogDebug($"    WARNING: Could not find device assembly for '{bpLocation.AssemblyName}'");
                        bp.Verified = false;
                        bp.Message = "Assembly not found on device";
                    }
                }
                else
                {
                    LogDebug($"    Could not resolve breakpoint location");
                    bp.Verified = false;
                    bp.Message = "Could not resolve source location";
                }
            }
            
            // Set all breakpoints on the device at once
            if (_activeBreakpointDefs.Count > 0)
            {
                LogDebug($"Setting {_activeBreakpointDefs.Count} breakpoint(s) on device...");
                bool success = _engine.SetBreakpoints(_activeBreakpointDefs.ToArray());
                LogDebug($"SetBreakpoints returned: {success}");
                
                if (!success)
                {
                    LogDebug("Warning: Failed to set breakpoints on device");
                    foreach (var bp in breakpointsToReapply)
                    {
                        bp.Verified = false;
                        bp.Message = "Failed to set breakpoint on device";
                    }
                }
                else
                {
                    LogDebug($"Successfully re-applied {_activeBreakpointDefs.Count} breakpoint(s)");
                    
                    // Send breakpoint verified events
                    foreach (var bp in breakpointsToReapply.Where(b => b.Verified))
                    {
                        RaiseEvent("breakpoint", new BreakpointEventBody
                        {
                            Reason = "changed",
                            Breakpoint = bp
                        });
                    }
                }
            }
        }
        catch (Exception ex)
        {
            LogDebug($"Error re-applying breakpoints: {ex.Message}");
        }
        
        await Task.CompletedTask;
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
            LogDebug("Attaching to running CLR...");
            
            // Check device state
            LogDebug($"Device connected to nanoCLR: {_engine.IsConnectedTonanoCLR}");
            LogDebug($"Device connected to nanoBooter: {_engine.IsConnectedTonanoBooter}");
            
            // Get initial execution state
            var initialState = _engine.GetExecutionMode();
            LogDebug($"Initial execution state: {initialState}");

            // Pause execution to allow debugging
            LogDebug("Calling PauseExecution...");
            bool paused = _engine.PauseExecution();
            LogDebug($"PauseExecution returned: {paused}");
            
            if (!paused)
            {
                LogDebug("Failed to pause execution for attach");
                return false;
            }

            // Wait for the device to actually stop and verify state
            // The device needs time to process the stop command
            for (int i = 0; i < 10; i++)
            {
                await Task.Delay(200);  // Wait 200ms between checks
                
                var state = _engine.GetExecutionMode();
                LogDebug($"Execution state check {i+1}: {state}");
                
                // Check if the Stopped flag is set
                if (((uint)state & 0x80000000) != 0)  // State.Stopped = 0x80000000
                {
                    LogDebug("Device confirmed stopped");
                    break;
                }
                
                if (i == 9)
                {
                    LogDebug("WARNING: Device may not be fully stopped after 2 seconds");
                }
            }

            // Query and register device assemblies
            LogDebug("Querying device assemblies...");
            var deviceAssemblies = _engine.ResolveAllAssemblies();
            if (deviceAssemblies != null && deviceAssemblies.Count > 0)
            {
                LogDebug($"Device has {deviceAssemblies.Count} assemblies loaded:");
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
                        // Idx from device is in format (assembly_index << 16), extract actual index
                        var rawIdx = assembly.Idx;
                        var idx = (int)(rawIdx >> 16);
                        
                        LogDebug($"  Assembly Idx=0x{rawIdx:X8} (index={idx}): {name} v{version}");
                        _assemblyManager.RegisterDeviceAssembly(name, version, 0, idx);
                    }
                }
            }
            else
            {
                LogDebug("WARNING: Could not resolve device assemblies");
            }

            // Get thread list
            LogDebug("Getting thread list...");
            _lastThreadList = _engine.GetThreadList();
            
            if (_lastThreadList != null)
            {
                LogDebug($"Thread list contains {_lastThreadList.Length} thread(s): [{string.Join(", ", _lastThreadList)}]");
            }
            else
            {
                LogDebug("Thread list is NULL - device may not have running threads or debugging may not be enabled");
            }
            
            _stoppedThreadId = _lastThreadList?.FirstOrDefault() ?? 1u;
            LogDebug($"Using stopped thread ID: {_stoppedThreadId}");
            
            // Try to get stack for the first thread to verify debugging is working
            if (_lastThreadList != null && _lastThreadList.Length > 0)
            {
                var testStack = _engine.GetThreadStack(_lastThreadList[0]);
                if (testStack != null && testStack.m_data != null)
                {
                    LogDebug($"Test stack has {testStack.m_data.Length} frames - debugging is working!");
                    foreach (var frame in testStack.m_data)
                    {
                        var methodName = _engine.GetMethodName(frame.m_md, true);
                        LogDebug($"  Frame: {methodName} (token=0x{frame.m_md:X8}, IP=0x{frame.m_IP:X4})");
                    }
                }
                else
                {
                    LogDebug("WARNING: Test GetThreadStack returned null or empty data - debugging may not be fully working");
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
            LogDebug("Attached successfully");
            return true;
        }
        catch (Exception ex)
        {
            LogDebug($"Attach error: {ex.Message}");
            return false;
        }
    }

    /// <summary>
    /// Set exception handling options
    /// </summary>
    public async Task SetExceptionHandling(bool breakOnAll, bool breakOnUncaught)
    {
        LogDebug($"Setting exception handling: breakOnAll={breakOnAll}, breakOnUncaught={breakOnUncaught}");
        
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
        LogDebug("Terminating debug session");
        
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
            LogDebug($"Terminate error: {ex.Message}");
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
            LogDebug($"Rebooting device (CLR only: {clrOnly})");
            
            var rebootOption = clrOnly 
                ? RebootOptions.ClrOnly 
                : RebootOptions.NormalReboot;
                
            _engine.RebootDevice(rebootOption);
            
            await Task.CompletedTask;
            return true;
        }
        catch (Exception ex)
        {
            LogInfo($"Reboot error: {ex.Message}");
            return false;
        }
    }

    /// <summary>
    /// Internal log level for categorizing messages.
    /// </summary>
    private enum LogLevel
    {
        /// <summary>Informational message (shown at Information verbosity and above)</summary>
        Info,
        /// <summary>Debug/diagnostic message (shown only at Debug verbosity)</summary>
        Debug
    }

    private void LogMessage(LogLevel level, string message)
    {
        // Check if we should log based on verbosity level
        if (_verbosity == VerbosityLevel.None)
        {
            return;
        }

        if (_verbosity == VerbosityLevel.Information && level == LogLevel.Debug)
        {
            return;
        }

        var prefix = level == LogLevel.Debug ? "[nF-Debug:DBG]" : "[nF-Debug]";
        
        // Send log message as output event
        RaiseEvent("output", new OutputEventBody
        {
            Category = "console",
            Output = $"{prefix} {message}\n"
        });
        
        // Also write to stderr for debugging
        Console.Error.WriteLine($"[DebugBridge:{level}] {message}");
    }

    /// <summary>
    /// Log an informational message (shown at Information verbosity and above).
    /// </summary>
    private void LogInfo(string message) => LogMessage(LogLevel.Info, message);

    /// <summary>
    /// Log a debug message (shown only at Debug verbosity).
    /// </summary>
    private void LogDebug(string message) => LogMessage(LogLevel.Debug, message);

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
        LogDebug($"Loading symbols from {pdbxPath}");
        bool result = _symbolResolver.LoadSymbols(pdbxPath);
        if (result)
        {
            LogDebug($"Symbols loaded successfully");
            // After loading symbols, try to verify any pending breakpoints
            RebindPendingBreakpoints();
        }
        else
        {
            LogDebug($"Failed to load symbols from {pdbxPath}");
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
        LogDebug($"Loading symbols from directory {directory} (recursive={recursive})");
        
        // Add this directory to assembly manager search paths and scan
        _assemblyManager.AddSearchPath(directory);
        _assemblyManager.ScanLocalAssemblies();
        LogDebug($"Found {_assemblyManager.GetLocalAssemblies().Count()} local assemblies");
        
        int count = _symbolResolver.LoadSymbolsFromDirectory(directory, recursive);
        LogDebug($"Loaded {count} symbol file(s)");
        
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
                    LogDebug($"Rebinding breakpoint {bp.Id} at {bp.Source.Path}:{bp.Line}");
                    
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
                LogDebug($"Source found via assembly index: {assemblyInfo.Name} -> {location.SourceFile}:{location.Line}");
                return (location, assemblyInfo.Name);
            }
        }
        
        // Fall back to searching all loaded symbols
        foreach (var assemblyName in _symbolResolver.GetLoadedAssemblies())
        {
            var location = _symbolResolver.GetSourceLocation(assemblyName, methodToken, ilOffset);
            if (location != null)
            {
                LogDebug($"Source found via search: {assemblyName} -> {location.SourceFile}:{location.Line}");
                return (location, assemblyName);
            }
        }
        
        LogDebug($"No source found for token 0x{methodToken:X8}, IL offset {ilOffset}");
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
