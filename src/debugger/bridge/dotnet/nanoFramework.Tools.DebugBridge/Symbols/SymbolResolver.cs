// Licensed to the .NET Foundation under one or more agreements.
// The .NET Foundation licenses this file to you under the MIT license.

using System.Collections.Concurrent;
using System.Text.Json;
using System.Xml.Serialization;

namespace nanoFramework.Tools.DebugBridge.Symbols;

/// <summary>
/// Interface for PDB readers (both Portable and Windows PDB formats)
/// </summary>
public interface IPdbReader : IDisposable
{
    List<PdbSequencePoint>? GetSequencePoints(int methodToken);
    PdbSequencePoint? FindSequencePoint(int methodToken, int ilOffset);
    
    /// <summary>
    /// Get local variable names for a method
    /// </summary>
    /// <param name="methodToken">Method metadata token (CLR token 0x06XXXXXX)</param>
    /// <returns>Array of local variable names indexed by slot, or null if not available</returns>
    string[]? GetLocalVariableNames(int methodToken);
}

/// <summary>
/// Resolves source file locations to IL offsets and vice versa using .pdbx files.
/// The .pdbx format is an XML-based symbol file generated during nanoFramework compilation
/// that contains IL mappings between CLR and nanoFramework offsets.
/// </summary>
public class SymbolResolver : IDisposable
{
    private readonly ConcurrentDictionary<string, PdbxFile> _loadedSymbols = new();
    private readonly ConcurrentDictionary<string, IPdbReader> _loadedPdbs = new();
    private readonly ConcurrentDictionary<string, List<SequencePoint>> _sequencePointCache = new();
    private readonly ConcurrentDictionary<string, string[]?> _localVariableNamesCache = new();
    private bool _disposed;

    /// <summary>
    /// Load symbols from a .pdbx file
    /// </summary>
    /// <param name="pdbxPath">Path to the .pdbx file</param>
    /// <returns>True if symbols were loaded successfully</returns>
    public bool LoadSymbols(string pdbxPath)
    {
        if (string.IsNullOrEmpty(pdbxPath) || !File.Exists(pdbxPath))
        {
            return false;
        }

        try
        {
            var serializer = new XmlSerializer(typeof(PdbxFile));
            using var reader = new StreamReader(pdbxPath);
            var pdbxFile = (PdbxFile?)serializer.Deserialize(reader);

            if (pdbxFile?.Assembly != null)
            {
                // Initialize cross-references
                pdbxFile.Initialize();
                var assemblyKey = pdbxFile.Assembly.FileName ?? pdbxPath;
                _loadedSymbols[assemblyKey] = pdbxFile;
                
                // Try to load the corresponding PDB file (Portable or Windows)
                var pdbReader = LoadPdb(pdbxPath);
                if (pdbReader != null)
                {
                    _loadedPdbs[assemblyKey] = pdbReader;
                    Console.Error.WriteLine($"[DebugBridge] Loaded PDB for {assemblyKey}");
                }
                else
                {
                    Console.Error.WriteLine($"[DebugBridge] No PDB loaded for {assemblyKey} - source locations will not be available");
                }
                
                // Build sequence point cache for this assembly
                BuildSequencePointCache(pdbxFile, pdbReader);
                
                return true;
            }
        }
        catch (Exception ex)
        {
            Console.Error.WriteLine($"Failed to load symbols from {pdbxPath}: {ex.Message}");
        }

        return false;
    }

    /// <summary>
    /// Try to load a PDB file for a given pdbx file (supports both Portable and Windows PDB formats)
    /// </summary>
    private IPdbReader? LoadPdb(string pdbxPath)
    {
        // Try common PDB locations relative to pdbx file
        var directory = Path.GetDirectoryName(pdbxPath) ?? "";
        var baseName = Path.GetFileNameWithoutExtension(pdbxPath);
        
        // Try: same directory, with .pdb extension
        var pdbPath = Path.Combine(directory, baseName + ".pdb");
        
        if (File.Exists(pdbPath))
        {
            // Check if it's a Portable PDB or Windows PDB
            if (PortablePdbReader.IsPortablePdb(pdbPath))
            {
                Console.Error.WriteLine($"[DebugBridge] Loading Portable PDB: {pdbPath}");
                var portableReader = new PortablePdbReader();
                if (portableReader.Load(pdbPath))
                {
                    return portableReader;
                }
                portableReader.Dispose();
            }
            else
            {
                // It's a Windows PDB - try to load with WindowsPdbReader (using Mono.Cecil)
                Console.Error.WriteLine($"[DebugBridge] Loading Windows PDB with Mono.Cecil: {pdbPath}");
                var windowsReader = new WindowsPdbReader();
                
                // Find the PE file
                var pePath = Path.Combine(directory, baseName + ".exe");
                if (!File.Exists(pePath))
                {
                    pePath = Path.Combine(directory, baseName + ".dll");
                }
                
                if (windowsReader.Load(pdbPath, pePath))
                {
                    Console.Error.WriteLine($"[DebugBridge] Loaded {windowsReader.MethodSequencePoints.Count} methods with sequence points from {pdbPath}");
                    foreach (var doc in windowsReader.Documents)
                    {
                        Console.Error.WriteLine($"[DebugBridge]   Source document: {doc.Name}");
                    }
                    return windowsReader;
                }
                windowsReader.Dispose();
            }
        }

        // Try: PE file with embedded PDB
        var portableEmbeddedReader = new PortablePdbReader();
        
        var dllPath = Path.Combine(directory, baseName + ".dll");
        if (File.Exists(dllPath) && portableEmbeddedReader.LoadFromEmbeddedPdb(dllPath))
        {
            Console.Error.WriteLine($"[DebugBridge] Loaded embedded PDB from: {dllPath}");
            return portableEmbeddedReader;
        }

        var exePath = Path.Combine(directory, baseName + ".exe");
        if (File.Exists(exePath) && portableEmbeddedReader.LoadFromEmbeddedPdb(exePath))
        {
            Console.Error.WriteLine($"[DebugBridge] Loaded embedded PDB from: {exePath}");
            return portableEmbeddedReader;
        }

        portableEmbeddedReader.Dispose();
        return null;
    }

    /// <summary>
    /// Load symbols from multiple .pdbx files in a directory
    /// </summary>
    /// <param name="directory">Directory containing .pdbx files</param>
    /// <param name="recursive">Whether to search recursively</param>
    /// <returns>Number of symbol files loaded</returns>
    public int LoadSymbolsFromDirectory(string directory, bool recursive = true)
    {
        if (string.IsNullOrEmpty(directory) || !Directory.Exists(directory))
        {
            return 0;
        }

        int count = 0;
        var searchOption = recursive ? SearchOption.AllDirectories : SearchOption.TopDirectoryOnly;
        
        foreach (var pdbxFile in Directory.EnumerateFiles(directory, "*.pdbx", searchOption))
        {
            if (LoadSymbols(pdbxFile))
            {
                count++;
            }
        }

        return count;
    }

    /// <summary>
    /// Get the IL offset for a source location (for setting breakpoints)
    /// </summary>
    /// <param name="sourceFile">Source file path</param>
    /// <param name="line">Line number (1-based)</param>
    /// <returns>Breakpoint location info, or null if not found</returns>
    public BreakpointLocation? GetBreakpointLocation(string sourceFile, int line)
    {
        // Normalize the source file path
        var normalizedPath = Path.GetFullPath(sourceFile).ToLowerInvariant();
        
        // Collect all sequence points for this file from all methods
        var candidatePoints = new List<SequencePoint>();
        
        foreach (var kvp in _sequencePointCache)
        {
            foreach (var sp in kvp.Value)
            {
                if (sp.SourceFile != null && 
                    Path.GetFullPath(sp.SourceFile).ToLowerInvariant() == normalizedPath)
                {
                    candidatePoints.Add(sp);
                }
            }
        }
        
        if (candidatePoints.Count == 0)
        {
            Console.Error.WriteLine($"[DebugBridge] GetBreakpointLocation: No sequence points found for {sourceFile}");
            return null;
        }
        
        // Sort by start line to find the best match
        candidatePoints.Sort((a, b) => a.StartLine.CompareTo(b.StartLine));
        
        Console.Error.WriteLine($"[DebugBridge] GetBreakpointLocation: Looking for line {line}, have {candidatePoints.Count} sequence points");
        Console.Error.WriteLine($"[DebugBridge] Sequence points: {string.Join(", ", candidatePoints.Select(sp => $"L{sp.StartLine}-{sp.EndLine}(IL={sp.ILOffsetNanoCLR})"))}");
        
        // First, try to find exact match on StartLine
        var exactMatch = candidatePoints.FirstOrDefault(sp => sp.StartLine == line);
        if (exactMatch != null)
        {
            Console.Error.WriteLine($"[DebugBridge] GetBreakpointLocation: Exact match for line {line} -> IL offset {exactMatch.ILOffsetNanoCLR}");
            return new BreakpointLocation
            {
                AssemblyName = exactMatch.AssemblyName,
                MethodToken = exactMatch.MethodToken,
                ILOffset = exactMatch.ILOffsetNanoCLR,
                SourceFile = sourceFile,
                Line = exactMatch.StartLine,
                Verified = true
            };
        }
        
        // Second, check if the line falls within any sequence point's range
        var containingMatch = candidatePoints.FirstOrDefault(sp => sp.StartLine <= line && line <= sp.EndLine);
        if (containingMatch != null)
        {
            Console.Error.WriteLine($"[DebugBridge] GetBreakpointLocation: Line {line} is within range {containingMatch.StartLine}-{containingMatch.EndLine} -> IL offset {containingMatch.ILOffsetNanoCLR}");
            return new BreakpointLocation
            {
                AssemblyName = containingMatch.AssemblyName,
                MethodToken = containingMatch.MethodToken,
                ILOffset = containingMatch.ILOffsetNanoCLR,
                SourceFile = sourceFile,
                Line = containingMatch.StartLine,
                Verified = true
            };
        }
        
        // Third, find the NEXT sequence point AFTER the requested line (standard debugger behavior)
        // When you set a breakpoint on a non-code line, it moves to the next code line
        var nextMatch = candidatePoints.FirstOrDefault(sp => sp.StartLine > line);
        if (nextMatch != null)
        {
            Console.Error.WriteLine($"[DebugBridge] GetBreakpointLocation: Moving breakpoint from line {line} to next code line {nextMatch.StartLine} -> IL offset {nextMatch.ILOffsetNanoCLR}");
            return new BreakpointLocation
            {
                AssemblyName = nextMatch.AssemblyName,
                MethodToken = nextMatch.MethodToken,
                ILOffset = nextMatch.ILOffsetNanoCLR,
                SourceFile = sourceFile,
                Line = nextMatch.StartLine, // Report the actual line where breakpoint will hit
                Verified = true
            };
        }
        
        // No suitable sequence point found
        Console.Error.WriteLine($"[DebugBridge] GetBreakpointLocation: No suitable sequence point found for line {line}");
        return null;
    }

    /// <summary>
    /// Get the breakpoint location for the next source line after the given position.
    /// Used for breakpoint-based step over to avoid rapid IL stepping.
    /// </summary>
    /// <param name="sourceFile">Current source file</param>
    /// <param name="currentLine">Current line number</param>
    /// <param name="currentMethodToken">Current method token (to handle stepping out of method)</param>
    /// <returns>Location of next line, or null if not found</returns>
    public BreakpointLocation? GetNextLineBreakpointLocation(string sourceFile, int currentLine, int currentMethodToken)
    {
        // Normalize the source file path
        var normalizedPath = Path.GetFullPath(sourceFile).ToLowerInvariant();
        
        // Collect all sequence points for this file from all methods
        var candidatePoints = new List<SequencePoint>();
        
        foreach (var kvp in _sequencePointCache)
        {
            foreach (var sp in kvp.Value)
            {
                if (sp.SourceFile != null && 
                    Path.GetFullPath(sp.SourceFile).ToLowerInvariant() == normalizedPath)
                {
                    candidatePoints.Add(sp);
                }
            }
        }
        
        if (candidatePoints.Count == 0)
        {
            Console.Error.WriteLine($"[DebugBridge] GetNextLineBreakpointLocation: No sequence points found for {sourceFile}");
            return null;
        }
        
        // Sort by start line, then by IL offset for same line
        candidatePoints.Sort((a, b) => 
        {
            int lineCompare = a.StartLine.CompareTo(b.StartLine);
            if (lineCompare != 0) return lineCompare;
            return a.ILOffsetNanoCLR.CompareTo(b.ILOffsetNanoCLR);
        });
        
        // First, try to find a line AFTER currentLine (normal forward stepping)
        // Note: We don't filter by method token because the device method index (e.g., 0x00010001)
        // is different from the PDB method token (e.g., 0x06000001). For step-over, we just
        // want the next line in the same source file - any method is fine since we'll set a 
        // breakpoint at that location.
        SequencePoint? nextLinePoint = null;
        
        foreach (var sp in candidatePoints)
        {
            if (sp.StartLine > currentLine)
            {
                nextLinePoint = sp;
                break;
            }
        }
        
        // If no line after, look for the FIRST line in the file that's different from current
        // This handles loops where execution goes back to an earlier line
        if (nextLinePoint == null)
        {
            Console.Error.WriteLine($"[DebugBridge] GetNextLineBreakpointLocation: No line after {currentLine}, checking for earlier lines (loop scenario)");
            foreach (var sp in candidatePoints)
            {
                if (sp.StartLine != currentLine && sp.StartLine > 0)
                {
                    nextLinePoint = sp;
                    break;
                }
            }
        }
        
        // If we found a next line, use it
        if (nextLinePoint != null)
        {
            Console.Error.WriteLine($"[DebugBridge] GetNextLineBreakpointLocation: Found next line {nextLinePoint.StartLine} (current: {currentLine}) at IL={nextLinePoint.ILOffsetNanoCLR}, method=0x{nextLinePoint.MethodToken:X8}");
            return new BreakpointLocation
            {
                AssemblyName = nextLinePoint.AssemblyName,
                MethodToken = nextLinePoint.MethodToken,
                ILOffset = nextLinePoint.ILOffsetNanoCLR,
                SourceFile = sourceFile,
                Line = nextLinePoint.StartLine,
                Verified = true
            };
        }
        
        Console.Error.WriteLine($"[DebugBridge] GetNextLineBreakpointLocation: No next line found after line {currentLine} in {Path.GetFileName(sourceFile)}");
        return null;
    }

    /// <summary>
    /// Get the entry point location (first executable line in the user assembly)
    /// This is typically the first sequence point in the Main method or the first loaded assembly.
    /// </summary>
    /// <returns>The entry point location, or null if not found</returns>
    public BreakpointLocation? GetEntryPointLocation()
    {
        // Find the first sequence point across all loaded symbols
        // Prefer user assemblies (not mscorlib, System.*, nanoFramework.*)
        SequencePoint? entryPoint = null;
        
        foreach (var kvp in _sequencePointCache)
        {
            var assemblyName = kvp.Key.Split('|')[0]; // Key format is "assemblyName|methodToken"
            
            // Skip system assemblies
            if (assemblyName.StartsWith("mscorlib", StringComparison.OrdinalIgnoreCase) ||
                assemblyName.StartsWith("System.", StringComparison.OrdinalIgnoreCase) ||
                assemblyName.StartsWith("nanoFramework.", StringComparison.OrdinalIgnoreCase))
            {
                continue;
            }
            
            foreach (var sp in kvp.Value)
            {
                // Skip hidden/generated sequence points
                if (sp.StartLine <= 0 || sp.SourceFile == null)
                    continue;
                
                // Take the first non-hidden sequence point (by IL offset 0 or lowest line number)
                if (entryPoint == null || sp.StartLine < entryPoint.StartLine)
                {
                    entryPoint = sp;
                }
            }
        }
        
        if (entryPoint == null)
        {
            Console.Error.WriteLine("[DebugBridge] GetEntryPointLocation: No entry point found");
            return null;
        }
        
        Console.Error.WriteLine($"[DebugBridge] GetEntryPointLocation: Found entry at {Path.GetFileName(entryPoint.SourceFile ?? "unknown")}:{entryPoint.StartLine}, " +
                               $"assembly={entryPoint.AssemblyName}, method=0x{entryPoint.MethodToken:X8}, IL={entryPoint.ILOffsetNanoCLR}");
        
        return new BreakpointLocation
        {
            AssemblyName = entryPoint.AssemblyName,
            MethodToken = entryPoint.MethodToken,
            ILOffset = entryPoint.ILOffsetNanoCLR,
            SourceFile = entryPoint.SourceFile,
            Line = entryPoint.StartLine,
            Verified = true
        };
    }

    /// <summary>
    /// Get source location from an IL offset (for stack traces)
    /// </summary>
    /// <param name="assemblyName">Assembly name</param>
    /// <param name="methodToken">Method token (nanoFramework token)</param>
    /// <param name="ilOffset">IL offset</param>
    /// <returns>Source location info, or null if not found</returns>
    public SourceLocation? GetSourceLocation(string assemblyName, uint methodToken, uint ilOffset)
    {
        // The methodToken from the device is in format: (assembly_index << 16) | method_row
        // e.g., 0x00010001 = assembly 1, method row 1
        // The pdbx nanoCLR token is in format: (table_type << 24) | method_row
        // e.g., 0x06000001 = MethodDef table (0x06), method row 1
        // We need to convert device token to pdbx token for lookup
        
        // Extract method row from device token (lower 16 bits)
        uint methodRow = methodToken & 0xFFFF;
        // Convert to pdbx token format (MethodDef table type = 0x06)
        uint pdbxToken = 0x06000000 | methodRow;
        
        // Try to find sequence points with various assembly name formats
        List<SequencePoint>? sequencePoints = null;
        string key;
        
        // Try exact name first
        key = $"{assemblyName}::{pdbxToken:X8}";
        if (!_sequencePointCache.TryGetValue(key, out sequencePoints))
        {
            // Try with .exe extension
            key = $"{assemblyName}.exe::{pdbxToken:X8}";
            if (!_sequencePointCache.TryGetValue(key, out sequencePoints))
            {
                // Try with .dll extension
                key = $"{assemblyName}.dll::{pdbxToken:X8}";
                if (!_sequencePointCache.TryGetValue(key, out sequencePoints))
                {
                    // Try without extension
                    var nameWithoutExt = Path.GetFileNameWithoutExtension(assemblyName);
                    key = $"{nameWithoutExt}::{pdbxToken:X8}";
                    _sequencePointCache.TryGetValue(key, out sequencePoints);
                }
            }
        }
        
        if (sequencePoints != null)
        {
            // Find the sequence point that contains this IL offset
            // Sequence points are sorted by IL offset, find the last one <= ilOffset
            SequencePoint? bestMatch = null;
            
            foreach (var sp in sequencePoints)
            {
                if (sp.ILOffsetNanoCLR <= ilOffset)
                {
                    bestMatch = sp;
                }
                else
                {
                    break;
                }
            }

            if (bestMatch != null && bestMatch.SourceFile != null)
            {
                return new SourceLocation
                {
                    SourceFile = bestMatch.SourceFile,
                    Line = bestMatch.StartLine,
                    Column = bestMatch.StartColumn,
                    EndLine = bestMatch.EndLine,
                    EndColumn = bestMatch.EndColumn
                };
            }
        }

        return null;
    }

    /// <summary>
    /// Get method information by token
    /// </summary>
    /// <param name="assemblyName">Assembly name</param>
    /// <param name="methodToken">Device method token in format (assembly_index << 16) | method_row</param>
    /// <returns>Method info or null if not found</returns>
    public MethodInfo? GetMethodInfo(string assemblyName, uint methodToken)
    {
        // Convert device token to pdbx token format
        uint methodRow = methodToken & 0xFFFF;
        uint pdbxToken = 0x06000000 | methodRow;
        
        // Try to find the assembly with various name formats
        PdbxFile? pdbxFile = null;
        string? resolvedName = null;
        
        // Try exact name first
        if (_loadedSymbols.TryGetValue(assemblyName, out pdbxFile))
        {
            resolvedName = assemblyName;
        }
        // Try with .exe extension
        else if (_loadedSymbols.TryGetValue(assemblyName + ".exe", out pdbxFile))
        {
            resolvedName = assemblyName + ".exe";
        }
        // Try with .dll extension
        else if (_loadedSymbols.TryGetValue(assemblyName + ".dll", out pdbxFile))
        {
            resolvedName = assemblyName + ".dll";
        }
        // Try without extension
        else
        {
            var nameWithoutExt = Path.GetFileNameWithoutExtension(assemblyName);
            if (_loadedSymbols.TryGetValue(nameWithoutExt, out pdbxFile))
            {
                resolvedName = nameWithoutExt;
            }
        }
        
        if (pdbxFile != null && resolvedName != null)
        {
            foreach (var cls in pdbxFile.Assembly?.Classes ?? Array.Empty<PdbxClass>())
            {
                foreach (var method in cls.Methods ?? Array.Empty<PdbxMethod>())
                {
                    if (method.Token?.NanoCLR == pdbxToken)
                    {
                        return new MethodInfo
                        {
                            Name = method.Name ?? "unknown",
                            ClassName = cls.Name ?? "unknown",
                            AssemblyName = resolvedName,
                            Token = methodToken,
                            HasSymbols = method.ILMap != null && method.ILMap.Length > 0
                        };
                    }
                }
            }
        }

        return null;
    }

    /// <summary>
    /// Get local variable names for a method
    /// </summary>
    /// <param name="assemblyName">Assembly name</param>
    /// <param name="deviceMethodToken">Device method token (format: assembly_index << 16 | method_row)</param>
    /// <returns>Array of local variable names indexed by slot, or null if not available</returns>
    public string[]? GetLocalVariableNames(string assemblyName, uint deviceMethodToken)
    {
        // Build cache key
        string cacheKey = $"{assemblyName}::{deviceMethodToken:X8}";
        
        // Check cache first
        if (_localVariableNamesCache.TryGetValue(cacheKey, out var cachedNames))
        {
            return cachedNames;
        }
        
        // Convert device token to CLR token format for PDB lookup
        uint methodRow = deviceMethodToken & 0xFFFF;
        int clrToken = (int)(0x06000000 | methodRow);
        
        // Try various name formats
        IPdbReader? pdbReader = null;
        
        if (_loadedPdbs.TryGetValue(assemblyName, out pdbReader))
        {
            // Found with exact name
        }
        else if (_loadedPdbs.TryGetValue(assemblyName + ".exe", out pdbReader))
        {
            // Found with .exe extension
        }
        else if (_loadedPdbs.TryGetValue(assemblyName + ".dll", out pdbReader))
        {
            // Found with .dll extension
        }
        else
        {
            var nameWithoutExt = Path.GetFileNameWithoutExtension(assemblyName);
            _loadedPdbs.TryGetValue(nameWithoutExt, out pdbReader);
        }
        
        string[]? result = null;
        if (pdbReader != null)
        {
            result = pdbReader.GetLocalVariableNames(clrToken);
        }
        
        // Cache the result (even if null, to avoid repeated lookups)
        _localVariableNamesCache[cacheKey] = result;
        
        return result;
    }

    /// <summary>
    /// Get sequence points for a method from the PDB reader.
    /// Used for getting IL ranges for source-level stepping.
    /// </summary>
    /// <param name="assemblyName">Assembly name</param>
    /// <param name="methodToken">Method token (CLR format 0x06XXXXXX)</param>
    /// <returns>List of sequence points or null if not found</returns>
    public List<PdbSequencePoint>? GetSequencePointsForMethod(string assemblyName, int methodToken)
    {
        // Try various name formats
        IPdbReader? pdbReader = null;
        
        if (_loadedPdbs.TryGetValue(assemblyName, out pdbReader))
        {
            // Found with exact name
        }
        else if (_loadedPdbs.TryGetValue(assemblyName + ".exe", out pdbReader))
        {
            // Found with .exe extension
        }
        else if (_loadedPdbs.TryGetValue(assemblyName + ".dll", out pdbReader))
        {
            // Found with .dll extension
        }
        else
        {
            var nameWithoutExt = Path.GetFileNameWithoutExtension(assemblyName);
            _loadedPdbs.TryGetValue(nameWithoutExt, out pdbReader);
        }
        
        if (pdbReader != null)
        {
            return pdbReader.GetSequencePoints(methodToken);
        }
        
        return null;
    }

    /// <summary>
    /// Get the IL offset for the next source line after the current position.
    /// Used for implementing source-level step over.
    /// </summary>
    /// <param name="assemblyName">Assembly name</param>
    /// <param name="methodToken">Device method token</param>
    /// <param name="currentILOffset">Current nano IL offset</param>
    /// <returns>IL offset and source line for the next line, or null if not found</returns>
    public (uint ILOffset, int SourceLine, string? SourceFile)? GetNextSourceLine(
        string assemblyName, uint methodToken, uint currentILOffset)
    {
        // Try to resolve assembly name
        string? resolvedName = null;
        if (_loadedSymbols.ContainsKey(assemblyName))
            resolvedName = assemblyName;
        else if (_loadedSymbols.ContainsKey(assemblyName + ".exe"))
            resolvedName = assemblyName + ".exe";
        else if (_loadedSymbols.ContainsKey(assemblyName + ".dll"))
            resolvedName = assemblyName + ".dll";
        else
        {
            var nameWithoutExt = Path.GetFileNameWithoutExtension(assemblyName);
            if (_loadedSymbols.ContainsKey(nameWithoutExt))
                resolvedName = nameWithoutExt;
        }
        
        if (resolvedName == null) return null;

        // Build the cache key for this method
        uint pdbxToken = 0x06000000 | (methodToken & 0xFFFF);
        var key = $"{resolvedName}::{pdbxToken:X8}";
        
        if (!_sequencePointCache.TryGetValue(key, out var sequencePoints))
        {
            return null;
        }
        
        // Find current sequence point (the one at or before current IL offset)
        SequencePoint? currentSp = null;
        int currentLine = 0;
        
        foreach (var sp in sequencePoints)
        {
            if (sp.ILOffsetNanoCLR <= currentILOffset && sp.SourceFile != null)
            {
                currentSp = sp;
                currentLine = sp.StartLine;
            }
        }
        
        if (currentSp == null)
        {
            return null;
        }
        
        // Find the next sequence point that's on a different source line
        foreach (var sp in sequencePoints)
        {
            if (sp.ILOffsetNanoCLR > currentILOffset && 
                sp.SourceFile != null && 
                sp.StartLine != currentLine)
            {
                return (sp.ILOffsetNanoCLR, sp.StartLine, sp.SourceFile);
            }
        }
        
        // No next line found in this method - return null to indicate step out needed
        return null;
    }

    /// <summary>
    /// Get ALL potential next source lines for stepping. This handles loops
    /// where execution may jump back to earlier lines.
    /// Returns all sequence points that are on different lines than the current line.
    /// </summary>
    public List<(uint ILOffset, int SourceLine, string? SourceFile)> GetAllStepTargets(
        string assemblyName, uint methodToken, uint currentILOffset)
    {
        var result = new List<(uint ILOffset, int SourceLine, string? SourceFile)>();
        
        // Try to resolve assembly name
        string? resolvedName = null;
        if (_loadedSymbols.ContainsKey(assemblyName))
            resolvedName = assemblyName;
        else if (_loadedSymbols.ContainsKey(assemblyName + ".exe"))
            resolvedName = assemblyName + ".exe";
        else if (_loadedSymbols.ContainsKey(assemblyName + ".dll"))
            resolvedName = assemblyName + ".dll";
        else
        {
            var nameWithoutExt = Path.GetFileNameWithoutExtension(assemblyName);
            if (_loadedSymbols.ContainsKey(nameWithoutExt))
                resolvedName = nameWithoutExt;
        }
        
        if (resolvedName == null) return result;

        // Build the cache key for this method
        uint pdbxToken = 0x06000000 | (methodToken & 0xFFFF);
        var key = $"{resolvedName}::{pdbxToken:X8}";
        
        if (!_sequencePointCache.TryGetValue(key, out var sequencePoints))
        {
            return result;
        }
        
        // Find current line
        int currentLine = 0;
        foreach (var sp in sequencePoints)
        {
            if (sp.ILOffsetNanoCLR <= currentILOffset && sp.SourceFile != null)
            {
                currentLine = sp.StartLine;
            }
        }
        
        if (currentLine == 0) return result;
        
        // Collect all sequence points on different lines
        var seenLines = new HashSet<int> { currentLine };
        
        foreach (var sp in sequencePoints)
        {
            if (sp.SourceFile != null && !seenLines.Contains(sp.StartLine))
            {
                result.Add((sp.ILOffsetNanoCLR, sp.StartLine, sp.SourceFile));
                seenLines.Add(sp.StartLine);
            }
        }
        
        return result;
    }

    /// <summary>
    /// Get the IL range (in nanoFramework IL offsets) that contains the current IP.
    /// Used for range-based stepping where the device steps until IP exits the range.
    /// </summary>
    /// <param name="assemblyName">Assembly name</param>
    /// <param name="methodToken">Device method token</param>
    /// <param name="currentNanoIP">Current IP in nanoFramework IL offset</param>
    /// <returns>IL range (start, end) in nanoFramework IL offsets, or null if not found</returns>
    public (uint startNanoIL, uint endNanoIL)? GetILRangeForStepOver(
        string assemblyName, uint methodToken, uint currentNanoIP)
    {
        // Try to resolve assembly name
        string? resolvedName = null;
        if (_loadedSymbols.ContainsKey(assemblyName))
            resolvedName = assemblyName;
        else if (_loadedSymbols.ContainsKey(assemblyName + ".exe"))
            resolvedName = assemblyName + ".exe";
        else if (_loadedSymbols.ContainsKey(assemblyName + ".dll"))
            resolvedName = assemblyName + ".dll";
        else
        {
            var nameWithoutExt = Path.GetFileNameWithoutExtension(assemblyName);
            if (_loadedSymbols.ContainsKey(nameWithoutExt))
                resolvedName = nameWithoutExt;
        }
        
        if (resolvedName == null)
        {
            Console.Error.WriteLine($"[DebugBridge] GetILRangeForStepOver: Assembly not found: {assemblyName}");
            return null;
        }

        // Build the cache key for this method
        uint pdbxToken = 0x06000000 | (methodToken & 0xFFFF);
        var key = $"{resolvedName}::{pdbxToken:X8}";
        
        if (!_sequencePointCache.TryGetValue(key, out var sequencePoints) || sequencePoints.Count == 0)
        {
            Console.Error.WriteLine($"[DebugBridge] GetILRangeForStepOver: No sequence points for method 0x{methodToken:X8}");
            return null;
        }
        
        // Sort by IL offset (should already be sorted but ensure it)
        var sortedPoints = sequencePoints.OrderBy(sp => sp.ILOffsetNanoCLR).ToList();
        
        // First, find which SOURCE LINE the current IP is on
        int currentLine = -1;
        for (int i = 0; i < sortedPoints.Count; i++)
        {
            var sp = sortedPoints[i];
            uint nextOffset = (i + 1 < sortedPoints.Count) ? sortedPoints[i + 1].ILOffsetNanoCLR : uint.MaxValue;
            
            if (sp.ILOffsetNanoCLR <= currentNanoIP && currentNanoIP < nextOffset)
            {
                currentLine = sp.StartLine;
                break;
            }
        }
        
        if (currentLine < 0)
        {
            Console.Error.WriteLine($"[DebugBridge] GetILRangeForStepOver: Could not find sequence point containing NanoIP 0x{currentNanoIP:X4}");
            return null;
        }
        
        // Now find the FULL IL range for this source line
        // The range should cover ALL sequence points on this line
        // so stepping stops only when we reach a DIFFERENT line
        uint lineStartIL = uint.MaxValue;
        uint lineEndIL = 0;
        
        for (int i = 0; i < sortedPoints.Count; i++)
        {
            var sp = sortedPoints[i];
            
            if (sp.StartLine == currentLine)
            {
                // This sequence point is on the current line
                if (sp.ILOffsetNanoCLR < lineStartIL)
                {
                    lineStartIL = sp.ILOffsetNanoCLR;
                }
                
                // The end of this sequence point's range is the start of the next SP
                uint spEnd = (i + 1 < sortedPoints.Count) ? sortedPoints[i + 1].ILOffsetNanoCLR : uint.MaxValue;
                if (spEnd > lineEndIL)
                {
                    lineEndIL = spEnd;
                }
            }
        }
        
        if (lineStartIL == uint.MaxValue)
        {
            Console.Error.WriteLine($"[DebugBridge] GetILRangeForStepOver: Could not find IL range for line {currentLine}");
            return null;
        }
        
        Console.Error.WriteLine($"[DebugBridge] GetILRangeForStepOver: NanoIP 0x{currentNanoIP:X4} is on line {currentLine}, full line range: [0x{lineStartIL:X4}, 0x{lineEndIL:X4})");
        return (lineStartIL, lineEndIL);
    }

    /// <summary>
    /// Find a field by name in the class containing the specified method.
    /// This is used to look up static fields when evaluating expressions.
    /// NOTE: The pdbx file does NOT contain field names, only tokens.
    /// This method returns the type token so the caller can query the device for fields.
    /// </summary>
    /// <param name="assemblyName">Assembly name</param>
    /// <param name="methodToken">Device method token to identify the class context</param>
    /// <param name="fieldName">Name of the field to find (not used - pdbx doesn't have names)</param>
    /// <returns>Type token and assembly info for querying fields, or null if not found</returns>
    public (uint TypeToken, string AssemblyName)? GetClassForMethod(
        string assemblyName, uint methodToken)
    {
        // Convert device token to pdbx token format
        uint methodRow = methodToken & 0xFFFF;
        uint pdbxToken = 0x06000000 | methodRow;
        
        Console.Error.WriteLine($"[DebugBridge] GetClassForMethod: Looking for method 0x{pdbxToken:X8} (from device token 0x{methodToken:X8})");
        
        // Try to find the assembly with various name formats
        PdbxFile? pdbxFile = null;
        string? resolvedName = null;
        
        if (_loadedSymbols.TryGetValue(assemblyName, out pdbxFile))
        {
            resolvedName = assemblyName;
        }
        else if (_loadedSymbols.TryGetValue(assemblyName + ".exe", out pdbxFile))
        {
            resolvedName = assemblyName + ".exe";
        }
        else if (_loadedSymbols.TryGetValue(assemblyName + ".dll", out pdbxFile))
        {
            resolvedName = assemblyName + ".dll";
        }
        else
        {
            var nameWithoutExt = Path.GetFileNameWithoutExtension(assemblyName);
            if (_loadedSymbols.TryGetValue(nameWithoutExt, out pdbxFile))
            {
                resolvedName = nameWithoutExt;
            }
        }
        
        if (pdbxFile?.Assembly?.Classes == null || resolvedName == null)
        {
            Console.Error.WriteLine($"[DebugBridge] GetClassForMethod: Could not find pdbx for assembly '{assemblyName}'");
            return null;
        }
        
        // Find the class containing this method
        foreach (var cls in pdbxFile.Assembly.Classes)
        {
            foreach (var method in cls.Methods ?? Array.Empty<PdbxMethod>())
            {
                if (method.Token?.NanoCLR == pdbxToken)
                {
                    if (cls.Token?.NanoCLR != null)
                    {
                        Console.Error.WriteLine($"[DebugBridge] GetClassForMethod: Found class with type token 0x{cls.Token.NanoCLR:X8}");
                        return (cls.Token.NanoCLR, resolvedName);
                    }
                }
            }
        }
        
        Console.Error.WriteLine($"[DebugBridge] GetClassForMethod: Could not find class for method 0x{pdbxToken:X8}");
        return null;
    }

    /// <summary>
    /// Find a field by name in the class containing the specified method.
    /// This is used to look up static fields when evaluating expressions.
    /// NOTE: The pdbx file does NOT contain field names, only tokens.
    /// This method returns the type token so the caller can query the device for fields.
    /// </summary>
    /// <param name="assemblyName">Assembly name</param>
    /// <param name="methodToken">Device method token to identify the class context</param>
    /// <param name="fieldName">Name of the field to find (not used - pdbx doesn't have names)</param>
    /// <returns>Field info (nanoCLR token and type token) or null if not found</returns>
    public (uint FieldToken, uint TypeToken, string AssemblyName)? FindFieldByName(
        string assemblyName, uint methodToken, string fieldName)
    {
        // The pdbx file does NOT contain field names - only tokens.
        // We need to use the engine to resolve field names from the device.
        // This method is now deprecated - callers should use GetClassForMethod + engine.ResolveField
        Console.Error.WriteLine($"[DebugBridge] FindFieldByName: pdbx files don't contain field names, returning null");
        Console.Error.WriteLine($"[DebugBridge] FindFieldByName: Use GetClassForMethod + engine.ResolveField to find fields by name");
        return null;
    }

    /// <summary>
    /// Check if symbols are loaded for an assembly
    /// </summary>
    public bool HasSymbolsForAssembly(string assemblyName)
    {
        if (_loadedSymbols.ContainsKey(assemblyName))
            return true;
        if (_loadedSymbols.ContainsKey(assemblyName + ".exe"))
            return true;
        if (_loadedSymbols.ContainsKey(assemblyName + ".dll"))
            return true;
        
        var nameWithoutExt = Path.GetFileNameWithoutExtension(assemblyName);
        return _loadedSymbols.ContainsKey(nameWithoutExt);
    }

    /// <summary>
    /// Get all loaded assembly names
    /// </summary>
    public IEnumerable<string> GetLoadedAssemblies()
    {
        return _loadedSymbols.Keys;
    }

    /// <summary>
    /// Clear all loaded symbols
    /// </summary>
    public void ClearSymbols()
    {
        foreach (var pdbReader in _loadedPdbs.Values)
        {
            pdbReader.Dispose();
        }
        _loadedPdbs.Clear();
        _loadedSymbols.Clear();
        _sequencePointCache.Clear();
        _localVariableNamesCache.Clear();
    }

    private void BuildSequencePointCache(PdbxFile pdbxFile, IPdbReader? pdbReader)
    {
        if (pdbxFile.Assembly == null) return;

        var assemblyName = pdbxFile.Assembly.FileName ?? "unknown";
        int methodsWithSymbols = 0;
        int methodsWithoutSymbols = 0;

        foreach (var cls in pdbxFile.Assembly.Classes ?? Array.Empty<PdbxClass>())
        {
            foreach (var method in cls.Methods ?? Array.Empty<PdbxMethod>())
            {
                if (method.ILMap == null || method.ILMap.Length == 0)
                {
                    continue;
                }

                var key = $"{assemblyName}::{method.Token?.NanoCLR:X8}";
                var sequencePoints = new List<SequencePoint>();

                // Get PDB sequence points for source info if available
                List<PdbSequencePoint>? pdbSequencePoints = null;
                if (pdbReader != null && method.Token?.CLR != null)
                {
                    // CLR token in pdbx is the metadata token used in PDB
                    pdbSequencePoints = pdbReader.GetSequencePoints((int)method.Token.CLR);
                    if (pdbSequencePoints != null && pdbSequencePoints.Count > 0)
                    {
                        methodsWithSymbols++;
                    }
                    else
                    {
                        methodsWithoutSymbols++;
                    }
                }

                // Build sequence points from IL map, correlating with PDB data
                bool hasSourceInfo = false;
                foreach (var il in method.ILMap)
                {
                    var sp = new SequencePoint
                    {
                        AssemblyName = assemblyName,
                        MethodToken = method.Token?.NanoCLR ?? 0,
                        ILOffsetCLR = il.CLR,
                        ILOffsetNanoCLR = il.NanoCLR
                    };

                    // Try to find source info from PDB
                    if (pdbSequencePoints != null)
                    {
                        // Find the PDB sequence point that matches this CLR IL offset
                        var pdbSp = FindPdbSequencePointForOffset(pdbSequencePoints, (int)il.CLR);
                        if (pdbSp != null)
                        {
                            sp.SourceFile = pdbSp.DocumentPath;
                            sp.StartLine = pdbSp.StartLine;
                            sp.StartColumn = pdbSp.StartColumn;
                            sp.EndLine = pdbSp.EndLine;
                            sp.EndColumn = pdbSp.EndColumn;
                            hasSourceInfo = true;
                        }
                    }

                    sequencePoints.Add(sp);
                }

                // Log first method with source info for debugging
                if (hasSourceInfo && methodsWithSymbols == 1)
                {
                    var firstSp = sequencePoints.FirstOrDefault(s => s.SourceFile != null);
                    if (firstSp != null)
                    {
                        Console.Error.WriteLine($"[DebugBridge] Example source mapping: {cls.Name}::{method.Name} -> {firstSp.SourceFile}:{firstSp.StartLine}");
                    }
                }

                // Sort by nanoFramework IL offset
                sequencePoints.Sort((a, b) => a.ILOffsetNanoCLR.CompareTo(b.ILOffsetNanoCLR));
                _sequencePointCache[key] = sequencePoints;
            }
        }

        Console.Error.WriteLine($"[DebugBridge] {assemblyName}: {methodsWithSymbols} methods with source info, {methodsWithoutSymbols} methods without");
    }

    /// <summary>
    /// Find the PDB sequence point that matches a CLR IL offset
    /// </summary>
    private PdbSequencePoint? FindPdbSequencePointForOffset(List<PdbSequencePoint> points, int clrOffset)
    {
        // Find the last sequence point with offset <= clrOffset
        PdbSequencePoint? best = null;
        
        foreach (var sp in points)
        {
            if (sp.ILOffset <= clrOffset)
            {
                best = sp;
            }
            else
            {
                break;
            }
        }

        return best;
    }

    public void Dispose()
    {
        if (!_disposed)
        {
            ClearSymbols();
            _disposed = true;
        }
    }
}

/// <summary>
/// Information about a breakpoint location
/// </summary>
public class BreakpointLocation
{
    public string AssemblyName { get; set; } = string.Empty;
    
    /// <summary>
    /// The nanoCLR token from the pdbx file (e.g., 0x06000001 for MethodDef row 1)
    /// </summary>
    public uint MethodToken { get; set; }
    
    /// <summary>
    /// The assembly index from ResolveAllAssemblies (e.g., 1, 2, 3, etc.)
    /// </summary>
    public uint AssemblyIdx { get; set; }
    
    /// <summary>
    /// Gets the device method index in the format expected by the debugger protocol.
    /// Format: (assembly_index << 16) | method_row
    /// This is what should be passed to SetBreakpoints m_md field.
    /// </summary>
    public uint DeviceMethodIndex
    {
        get
        {
            // Extract the method row from the token (bottom 24 bits)
            uint methodRow = MethodToken & 0x00FFFFFF;
            // Shift assembly index and OR with method row
            return (AssemblyIdx << 16) | methodRow;
        }
    }
    
    public uint ILOffset { get; set; }
    public string SourceFile { get; set; } = string.Empty;
    public int Line { get; set; }
    public bool Verified { get; set; }
}

/// <summary>
/// Information about a source location
/// </summary>
public class SourceLocation
{
    public string SourceFile { get; set; } = string.Empty;
    public int Line { get; set; }
    public int Column { get; set; }
    public int EndLine { get; set; }
    public int EndColumn { get; set; }
}

/// <summary>
/// Information about a method
/// </summary>
public class MethodInfo
{
    public string Name { get; set; } = string.Empty;
    public string ClassName { get; set; } = string.Empty;
    public string AssemblyName { get; set; } = string.Empty;
    public uint Token { get; set; }
    public bool HasSymbols { get; set; }
}

/// <summary>
/// Internal sequence point representation
/// </summary>
internal class SequencePoint
{
    public string AssemblyName { get; set; } = string.Empty;
    public uint MethodToken { get; set; }
    public uint ILOffsetCLR { get; set; }
    public uint ILOffsetNanoCLR { get; set; }
    public string? SourceFile { get; set; }
    public int StartLine { get; set; }
    public int StartColumn { get; set; }
    public int EndLine { get; set; }
    public int EndColumn { get; set; }
}
