/*---------------------------------------------------------------------------------------------
 * Copyright (c) .NET Foundation and Contributors.
 * Portions Copyright (c) Microsoft Corporation.  All rights reserved.
 * See LICENSE file in the project root for full license information.
 *--------------------------------------------------------------------------------------------*/

using System.Reflection.Metadata;
using System.Reflection.Metadata.Ecma335;
using System.Reflection.PortableExecutable;

namespace nanoFramework.Tools.DebugBridge.Symbols;

/// <summary>
/// Reads portable PDB files to extract sequence point information (source file/line mappings).
/// Portable PDB is the standard debug symbol format for .NET that contains IL offset to
/// source location mappings.
/// </summary>
public class PortablePdbReader : IDisposable
{
    private MetadataReaderProvider? _pdbReaderProvider;
    private MetadataReader? _pdbReader;
    private PEReader? _peReader;
    private MetadataReader? _peMetadataReader;
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
    /// Load a portable PDB file
    /// </summary>
    /// <param name="pdbPath">Path to the .pdb file</param>
    /// <returns>True if loaded successfully</returns>
    public bool Load(string pdbPath)
    {
        if (string.IsNullOrEmpty(pdbPath) || !File.Exists(pdbPath))
        {
            return false;
        }

        try
        {
            // Open the PDB file
            var pdbStream = File.OpenRead(pdbPath);
            _pdbReaderProvider = MetadataReaderProvider.FromPortablePdbStream(pdbStream);
            _pdbReader = _pdbReaderProvider.GetMetadataReader();

            // Try to find and open the associated PE file for additional metadata
            var peFilePath = Path.ChangeExtension(pdbPath, ".dll");
            if (!File.Exists(peFilePath))
            {
                peFilePath = Path.ChangeExtension(pdbPath, ".exe");
            }

            if (File.Exists(peFilePath))
            {
                try
                {
                    var peStream = File.OpenRead(peFilePath);
                    _peReader = new PEReader(peStream);
                    if (_peReader.HasMetadata)
                    {
                        _peMetadataReader = _peReader.GetMetadataReader();
                    }
                }
                catch
                {
                    // PE file couldn't be loaded, continue with just PDB
                }
            }

            // Load documents (source files)
            LoadDocuments();

            // Load sequence points for all methods
            LoadSequencePoints();

            return true;
        }
        catch (Exception ex)
        {
            Console.Error.WriteLine($"Failed to load PDB {pdbPath}: {ex.Message}");
            return false;
        }
    }

    /// <summary>
    /// Load a portable PDB from a PE file that has embedded PDB
    /// </summary>
    /// <param name="pePath">Path to the PE file (.dll or .exe)</param>
    /// <returns>True if embedded PDB was found and loaded</returns>
    public bool LoadFromEmbeddedPdb(string pePath)
    {
        if (string.IsNullOrEmpty(pePath) || !File.Exists(pePath))
        {
            return false;
        }

        try
        {
            var peStream = File.OpenRead(pePath);
            _peReader = new PEReader(peStream);

            if (!_peReader.HasMetadata)
            {
                return false;
            }

            _peMetadataReader = _peReader.GetMetadataReader();

            // Check for embedded PDB
            var debugDirectory = _peReader.ReadDebugDirectory();
            var embeddedEntry = debugDirectory.FirstOrDefault(e => 
                e.Type == DebugDirectoryEntryType.EmbeddedPortablePdb);

            if (embeddedEntry.DataSize == 0)
            {
                return false;
            }

            _pdbReaderProvider = _peReader.ReadEmbeddedPortablePdbDebugDirectoryData(embeddedEntry);
            _pdbReader = _pdbReaderProvider.GetMetadataReader();

            LoadDocuments();
            LoadSequencePoints();

            return true;
        }
        catch (Exception ex)
        {
            Console.Error.WriteLine($"Failed to load embedded PDB from {pePath}: {ex.Message}");
            return false;
        }
    }

    private void LoadDocuments()
    {
        if (_pdbReader == null) return;

        foreach (var docHandle in _pdbReader.Documents)
        {
            var doc = _pdbReader.GetDocument(docHandle);
            var name = _pdbReader.GetString(doc.Name);

            Documents.Add(new PdbDocument
            {
                Handle = docHandle,
                Name = name,
                // Language GUID could be extracted from doc.Language if needed
            });
        }
    }

    private void LoadSequencePoints()
    {
        if (_pdbReader == null) return;

        foreach (var methodDebugInfoHandle in _pdbReader.MethodDebugInformation)
        {
            var methodDebugInfo = _pdbReader.GetMethodDebugInformation(methodDebugInfoHandle);
            
            // Get the method token (row number in MethodDef table)
            int methodToken = MetadataTokens.GetToken(methodDebugInfoHandle.ToDefinitionHandle());

            var sequencePoints = new List<PdbSequencePoint>();

            // Get document for this method
            string? documentPath = null;
            if (!methodDebugInfo.Document.IsNil)
            {
                var doc = _pdbReader.GetDocument(methodDebugInfo.Document);
                documentPath = _pdbReader.GetString(doc.Name);
            }

            foreach (var sp in methodDebugInfo.GetSequencePoints())
            {
                // Skip hidden sequence points
                if (sp.IsHidden)
                {
                    continue;
                }

                // Get document path for this sequence point
                string? spDocPath = documentPath;
                if (!sp.Document.IsNil && sp.Document != methodDebugInfo.Document)
                {
                    var spDoc = _pdbReader.GetDocument(sp.Document);
                    spDocPath = _pdbReader.GetString(spDoc.Name);
                }

                sequencePoints.Add(new PdbSequencePoint
                {
                    ILOffset = sp.Offset,
                    StartLine = sp.StartLine,
                    StartColumn = sp.StartColumn,
                    EndLine = sp.EndLine,
                    EndColumn = sp.EndColumn,
                    DocumentPath = spDocPath
                });
            }

            if (sequencePoints.Count > 0)
            {
                MethodSequencePoints[methodToken] = sequencePoints;
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
        // The token we get might be the full token (0x06XXXXXX) or just the row number
        // Try both
        if (MethodSequencePoints.TryGetValue(methodToken, out var points))
        {
            return points;
        }

        // If it's a full token, extract just the row number
        int rowNumber = methodToken & 0x00FFFFFF;
        if (MethodSequencePoints.TryGetValue(rowNumber, out points))
        {
            return points;
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

    /// <summary>
    /// Get method name from PE metadata if available
    /// </summary>
    /// <param name="methodToken">Method metadata token</param>
    /// <returns>Method name or null</returns>
    public string? GetMethodName(int methodToken)
    {
        if (_peMetadataReader == null) return null;

        try
        {
            var handle = MetadataTokens.MethodDefinitionHandle(methodToken & 0x00FFFFFF);
            var methodDef = _peMetadataReader.GetMethodDefinition(handle);
            return _peMetadataReader.GetString(methodDef.Name);
        }
        catch
        {
            return null;
        }
    }

    public void Dispose()
    {
        if (!_disposed)
        {
            _pdbReaderProvider?.Dispose();
            _peReader?.Dispose();
            _disposed = true;
        }
    }
}

/// <summary>
/// Represents a document (source file) in the PDB
/// </summary>
public class PdbDocument
{
    public DocumentHandle Handle { get; set; }
    public string Name { get; set; } = string.Empty;
}

/// <summary>
/// Represents a sequence point mapping IL offset to source location
/// </summary>
public class PdbSequencePoint
{
    /// <summary>
    /// IL offset within the method
    /// </summary>
    public int ILOffset { get; set; }

    /// <summary>
    /// Start line in source file (1-based)
    /// </summary>
    public int StartLine { get; set; }

    /// <summary>
    /// Start column in source file (1-based)
    /// </summary>
    public int StartColumn { get; set; }

    /// <summary>
    /// End line in source file (1-based)
    /// </summary>
    public int EndLine { get; set; }

    /// <summary>
    /// End column in source file (1-based)
    /// </summary>
    public int EndColumn { get; set; }

    /// <summary>
    /// Path to the source document
    /// </summary>
    public string? DocumentPath { get; set; }
}
