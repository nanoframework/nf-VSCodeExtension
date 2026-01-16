/*---------------------------------------------------------------------------------------------
 * Copyright (c) .NET Foundation and Contributors.
 * Portions Copyright (c) Microsoft Corporation.  All rights reserved.
 * See LICENSE file in the project root for full license information.
 *--------------------------------------------------------------------------------------------*/

using System.Collections.Concurrent;
using System.Text.Json;
using System.Xml.Serialization;

namespace nanoFramework.Tools.DebugBridge.Symbols;

/// <summary>
/// Resolves source file locations to IL offsets and vice versa using .pdbx files.
/// The .pdbx format is an XML-based symbol file generated during nanoFramework compilation
/// that contains IL mappings between CLR and nanoFramework offsets.
/// </summary>
public class SymbolResolver : IDisposable
{
    private readonly ConcurrentDictionary<string, PdbxFile> _loadedSymbols = new();
    private readonly ConcurrentDictionary<string, PortablePdbReader> _loadedPdbs = new();
    private readonly ConcurrentDictionary<string, List<SequencePoint>> _sequencePointCache = new();
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
                
                // Try to load the corresponding portable PDB file
                var pdbReader = LoadPortablePdb(pdbxPath);
                if (pdbReader != null)
                {
                    _loadedPdbs[assemblyKey] = pdbReader;
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
    /// Try to load a portable PDB file for a given pdbx file
    /// </summary>
    private PortablePdbReader? LoadPortablePdb(string pdbxPath)
    {
        // Try common PDB locations relative to pdbx file
        var directory = Path.GetDirectoryName(pdbxPath) ?? "";
        var baseName = Path.GetFileNameWithoutExtension(pdbxPath);
        
        // Try: same directory, with .pdb extension
        var pdbPath = Path.Combine(directory, baseName + ".pdb");
        
        var reader = new PortablePdbReader();
        
        if (File.Exists(pdbPath) && reader.Load(pdbPath))
        {
            return reader;
        }

        // Try: PE file with embedded PDB
        var dllPath = Path.Combine(directory, baseName + ".dll");
        if (File.Exists(dllPath) && reader.LoadFromEmbeddedPdb(dllPath))
        {
            return reader;
        }

        var exePath = Path.Combine(directory, baseName + ".exe");
        if (File.Exists(exePath) && reader.LoadFromEmbeddedPdb(exePath))
        {
            return reader;
        }

        reader.Dispose();
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
        
        // Look for sequence points that match this source location
        foreach (var kvp in _sequencePointCache)
        {
            foreach (var sp in kvp.Value)
            {
                if (sp.SourceFile != null && 
                    Path.GetFullPath(sp.SourceFile).ToLowerInvariant() == normalizedPath &&
                    sp.StartLine <= line && line <= sp.EndLine)
                {
                    return new BreakpointLocation
                    {
                        AssemblyName = sp.AssemblyName,
                        MethodToken = sp.MethodToken,
                        ILOffset = sp.ILOffsetNanoCLR,
                        SourceFile = sourceFile,
                        Line = sp.StartLine,
                        Verified = true
                    };
                }
            }
        }

        return null;
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
        var key = $"{assemblyName}::{methodToken:X8}";
        
        if (_sequencePointCache.TryGetValue(key, out var sequencePoints))
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
    /// <param name="methodToken">Method token</param>
    /// <returns>Method info or null if not found</returns>
    public MethodInfo? GetMethodInfo(string assemblyName, uint methodToken)
    {
        if (_loadedSymbols.TryGetValue(assemblyName, out var pdbxFile))
        {
            foreach (var cls in pdbxFile.Assembly?.Classes ?? Array.Empty<PdbxClass>())
            {
                foreach (var method in cls.Methods ?? Array.Empty<PdbxMethod>())
                {
                    if (method.Token?.NanoCLR == methodToken)
                    {
                        return new MethodInfo
                        {
                            Name = method.Name ?? "unknown",
                            ClassName = cls.Name ?? "unknown",
                            AssemblyName = assemblyName,
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
    /// Check if symbols are loaded for an assembly
    /// </summary>
    public bool HasSymbolsForAssembly(string assemblyName)
    {
        return _loadedSymbols.ContainsKey(assemblyName);
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
    }

    private void BuildSequencePointCache(PdbxFile pdbxFile, PortablePdbReader? pdbReader)
    {
        if (pdbxFile.Assembly == null) return;

        var assemblyName = pdbxFile.Assembly.FileName ?? "unknown";

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
                }

                // Build sequence points from IL map, correlating with PDB data
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
                        }
                    }

                    sequencePoints.Add(sp);
                }

                // Sort by nanoFramework IL offset
                sequencePoints.Sort((a, b) => a.ILOffsetNanoCLR.CompareTo(b.ILOffsetNanoCLR));
                _sequencePointCache[key] = sequencePoints;
            }
        }
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
    public uint MethodToken { get; set; }
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
