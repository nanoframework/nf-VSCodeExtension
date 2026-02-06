// Licensed to the .NET Foundation under one or more agreements.
// The .NET Foundation licenses this file to you under the MIT license.

using Mono.Cecil;
using Mono.Cecil.Cil;
using Mono.Cecil.Pdb;

namespace nanoFramework.Tools.DebugBridge.Symbols;

/// <summary>
/// Reads Windows PDB files using Mono.Cecil library.
/// This provides a managed way to read both Windows and Portable PDBs.
/// </summary>
public class WindowsPdbReader : IPdbReader, IDisposable
{
    private AssemblyDefinition? _assembly;
    private bool _disposed;

    /// <summary>
    /// The documents (source files) referenced in this PDB
    /// </summary>
    public List<PdbDocument> Documents { get; } = new();

    /// <summary>
    /// Method sequence points indexed by method token
    /// </summary>
    public Dictionary<int, List<PdbSequencePoint>> MethodSequencePoints { get; } = new();

    /// <summary>
    /// Local variable names indexed by method token
    /// </summary>
    private Dictionary<int, string[]> _localVariableNames = new();

    /// <summary>
    /// Load a PDB file using Mono.Cecil
    /// </summary>
    /// <param name="pdbPath">Path to the .pdb file</param>
    /// <param name="pePath">Optional path to the PE file (.exe or .dll)</param>
    /// <returns>True if loaded successfully</returns>
    public bool Load(string pdbPath, string? pePath = null)
    {
        if (string.IsNullOrEmpty(pdbPath) || !File.Exists(pdbPath))
        {
            return false;
        }

        try
        {
            // Try to find PE file if not provided
            if (string.IsNullOrEmpty(pePath))
            {
                var directory = Path.GetDirectoryName(pdbPath) ?? "";
                var baseName = Path.GetFileNameWithoutExtension(pdbPath);
                
                pePath = Path.Combine(directory, baseName + ".exe");
                if (!File.Exists(pePath))
                {
                    pePath = Path.Combine(directory, baseName + ".dll");
                }
            }

            if (string.IsNullOrEmpty(pePath) || !File.Exists(pePath))
            {
                Console.Error.WriteLine($"PE file not found for PDB: {pdbPath}");
                return false;
            }

            // Create reader parameters with symbol reader
            var readerParams = new ReaderParameters
            {
                ReadSymbols = true,
                SymbolReaderProvider = new PdbReaderProvider(),
                ReadingMode = ReadingMode.Deferred
            };

            // Load the assembly with symbols
            _assembly = AssemblyDefinition.ReadAssembly(pePath, readerParams);

            if (_assembly == null)
            {
                Console.Error.WriteLine($"Failed to load assembly: {pePath}");
                return false;
            }

            // Process all methods to extract sequence points
            LoadSequencePoints();

            return true;
        }
        catch (Exception ex)
        {
            Console.Error.WriteLine($"Failed to load PDB {pdbPath} with Mono.Cecil: {ex.Message}");
            return false;
        }
    }

    private void LoadSequencePoints()
    {
        if (_assembly == null) return;

        var documentSet = new HashSet<string>();

        foreach (var module in _assembly.Modules)
        {
            foreach (var type in module.Types)
            {
                ProcessType(type, documentSet);
            }
        }

        // Add unique documents
        foreach (var doc in documentSet)
        {
            Documents.Add(new PdbDocument { Name = doc });
        }
    }

    private void ProcessType(TypeDefinition type, HashSet<string> documentSet)
    {
        // Process methods in this type
        foreach (var method in type.Methods)
        {
            if (!method.HasBody || method.Body == null)
            {
                continue;
            }

            var debugInfo = method.DebugInformation;
            if (debugInfo == null || !debugInfo.HasSequencePoints)
            {
                continue;
            }

            // Get method token
            int methodToken = method.MetadataToken.ToInt32();
            var points = new List<PdbSequencePoint>();

            foreach (var sp in debugInfo.SequencePoints)
            {
                // Skip hidden sequence points
                if (sp.IsHidden)
                {
                    continue;
                }

                string? docPath = sp.Document?.Url;
                if (!string.IsNullOrEmpty(docPath))
                {
                    documentSet.Add(docPath);
                }

                points.Add(new PdbSequencePoint
                {
                    ILOffset = sp.Offset,
                    StartLine = sp.StartLine,
                    StartColumn = sp.StartColumn,
                    EndLine = sp.EndLine,
                    EndColumn = sp.EndColumn,
                    DocumentPath = docPath
                });
            }

            if (points.Count > 0)
            {
                // Sort by IL offset
                points.Sort((a, b) => a.ILOffset.CompareTo(b.ILOffset));
                MethodSequencePoints[methodToken] = points;
            }

            // Extract local variable names from debug information scope
            ExtractLocalVariableNames(method, methodToken);
        }

        // Process nested types
        foreach (var nestedType in type.NestedTypes)
        {
            ProcessType(nestedType, documentSet);
        }
    }

    private void ExtractLocalVariableNames(MethodDefinition method, int methodToken)
    {
        var debugInfo = method.DebugInformation;
        if (debugInfo?.Scope == null)
        {
            return;
        }

        // Build a list of local variable names indexed by slot
        var localVars = new List<(int Index, string Name)>();
        CollectLocalVariables(debugInfo.Scope, localVars);

        if (localVars.Count > 0)
        {
            int maxIndex = localVars.Max(v => v.Index);
            var names = new string[maxIndex + 1];
            
            // Fill with default names
            for (int i = 0; i < names.Length; i++)
            {
                names[i] = $"local{i}";
            }
            
            // Override with actual names where available
            foreach (var (index, name) in localVars)
            {
                if (index >= 0 && index < names.Length)
                {
                    names[index] = name;
                }
            }
            
            _localVariableNames[methodToken] = names;
        }
    }

    private void CollectLocalVariables(ScopeDebugInformation scope, List<(int Index, string Name)> localVars)
    {
        if (scope.HasVariables)
        {
            foreach (var variable in scope.Variables)
            {
                localVars.Add((variable.Index, variable.Name));
            }
        }

        // Recursively process nested scopes
        if (scope.HasScopes)
        {
            foreach (var nestedScope in scope.Scopes)
            {
                CollectLocalVariables(nestedScope, localVars);
            }
        }
    }

    /// <summary>
    /// Get sequence points for a method by its metadata token
    /// </summary>
    /// <param name="methodToken">Method metadata token (0x06XXXXXX)</param>
    /// <returns>List of sequence points or null if not found</returns>
    public List<PdbSequencePoint>? GetSequencePoints(int methodToken)
    {
        if (MethodSequencePoints.TryGetValue(methodToken, out var cached))
        {
            return cached;
        }

        // Try with just the row ID
        int rowId = methodToken & 0x00FFFFFF;
        int fullToken = 0x06000000 | rowId;
        
        if (MethodSequencePoints.TryGetValue(fullToken, out cached))
        {
            return cached;
        }

        return null;
    }

    /// <summary>
    /// Find the sequence point that contains the given IL offset
    /// </summary>
    /// <param name="methodToken">Method metadata token</param>
    /// <param name="ilOffset">IL offset within the method</param>
    /// <returns>The matching sequence point or null</returns>
    public PdbSequencePoint? FindSequencePoint(int methodToken, int ilOffset)
    {
        var points = GetSequencePoints(methodToken);
        if (points == null || points.Count == 0)
        {
            return null;
        }

        // Find the last sequence point with offset <= ilOffset
        PdbSequencePoint? best = null;
        foreach (var sp in points)
        {
            if (sp.ILOffset <= ilOffset)
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

    /// <summary>
    /// Get local variable names for a method
    /// </summary>
    /// <param name="methodToken">Method metadata token (CLR token 0x06XXXXXX)</param>
    /// <returns>Array of local variable names indexed by slot, or null if not available</returns>
    public string[]? GetLocalVariableNames(int methodToken)
    {
        if (_localVariableNames.TryGetValue(methodToken, out var names))
        {
            return names;
        }

        // Try with just the row ID
        int rowId = methodToken & 0x00FFFFFF;
        int fullToken = 0x06000000 | rowId;
        
        if (_localVariableNames.TryGetValue(fullToken, out names))
        {
            return names;
        }

        return null;
    }

    /// <summary>
    /// Find the sequence point for a given source location
    /// </summary>
    /// <param name="filePath">Source file path</param>
    /// <param name="line">Line number (1-based)</param>
    /// <returns>Tuple of (methodToken, sequencePoint) or null if not found</returns>
    public (int MethodToken, PdbSequencePoint SequencePoint)? FindSequencePointBySourceLocation(
        string filePath, int line)
    {
        var normalizedPath = Path.GetFullPath(filePath).ToLowerInvariant();

        foreach (var kvp in MethodSequencePoints)
        {
            foreach (var sp in kvp.Value)
            {
                if (sp.DocumentPath != null &&
                    Path.GetFullPath(sp.DocumentPath).ToLowerInvariant() == normalizedPath &&
                    sp.StartLine <= line && line <= sp.EndLine)
                {
                    return (kvp.Key, sp);
                }
            }
        }

        return null;
    }

    public void Dispose()
    {
        if (!_disposed)
        {
            _assembly?.Dispose();
            _assembly = null;
            _disposed = true;
        }
    }
}
