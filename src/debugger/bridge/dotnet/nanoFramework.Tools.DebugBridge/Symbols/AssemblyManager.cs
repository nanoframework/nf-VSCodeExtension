/*---------------------------------------------------------------------------------------------
 * Copyright (c) .NET Foundation and Contributors.
 * Portions Copyright (c) Microsoft Corporation.  All rights reserved.
 * See LICENSE file in the project root for full license information.
 *--------------------------------------------------------------------------------------------*/

using System.Collections.Concurrent;
using System.Security.Cryptography;

namespace nanoFramework.Tools.DebugBridge.Symbols;

/// <summary>
/// Manages assemblies loaded on the device and maps them to local source files.
/// Provides assembly identification by name, version, and checksum.
/// </summary>
public class AssemblyManager : IDisposable
{
    private readonly ConcurrentDictionary<string, AssemblyInfo> _deviceAssemblies = new();
    private readonly ConcurrentDictionary<string, LocalAssemblyInfo> _localAssemblies = new();
    private readonly HashSet<string> _searchPaths = new();
    private bool _disposed;

    /// <summary>
    /// Event raised when an assembly mismatch is detected
    /// </summary>
    public event EventHandler<AssemblyMismatchEventArgs>? AssemblyMismatchDetected;

    /// <summary>
    /// Add a search path for local assemblies
    /// </summary>
    /// <param name="path">Directory path to search</param>
    public void AddSearchPath(string path)
    {
        if (!string.IsNullOrEmpty(path) && Directory.Exists(path))
        {
            _searchPaths.Add(Path.GetFullPath(path));
        }
    }

    /// <summary>
    /// Add multiple search paths
    /// </summary>
    public void AddSearchPaths(IEnumerable<string> paths)
    {
        foreach (var path in paths)
        {
            AddSearchPath(path);
        }
    }

    /// <summary>
    /// Clear all search paths
    /// </summary>
    public void ClearSearchPaths()
    {
        _searchPaths.Clear();
    }

    /// <summary>
    /// Register an assembly that is loaded on the device
    /// </summary>
    /// <param name="name">Assembly name</param>
    /// <param name="version">Assembly version</param>
    /// <param name="checksum">Assembly checksum (CRC32 or similar from device)</param>
    /// <param name="index">Assembly index on the device</param>
    public void RegisterDeviceAssembly(string name, Version version, uint checksum, int index)
    {
        var info = new AssemblyInfo
        {
            Name = name,
            Version = version,
            Checksum = checksum,
            DeviceIndex = index,
            LoadedFromDevice = true
        };

        _deviceAssemblies[name] = info;

        // Try to find matching local assembly
        TryMatchLocalAssembly(info);
    }

    /// <summary>
    /// Register multiple assemblies from device
    /// </summary>
    public void RegisterDeviceAssemblies(IEnumerable<(string name, Version version, uint checksum, int index)> assemblies)
    {
        foreach (var (name, version, checksum, index) in assemblies)
        {
            RegisterDeviceAssembly(name, version, checksum, index);
        }
    }

    /// <summary>
    /// Scan search paths for local assemblies and their symbols
    /// </summary>
    public void ScanLocalAssemblies()
    {
        _localAssemblies.Clear();

        foreach (var searchPath in _searchPaths)
        {
            ScanDirectory(searchPath);
        }
    }

    private void ScanDirectory(string directory)
    {
        try
        {
            // Look for PE files
            foreach (var peFile in Directory.EnumerateFiles(directory, "*.pe", SearchOption.AllDirectories))
            {
                TryRegisterLocalAssembly(peFile);
            }

            // Also look for DLL files (in case PE hasn't been created yet, but pdbx exists)
            foreach (var pdbxFile in Directory.EnumerateFiles(directory, "*.pdbx", SearchOption.AllDirectories))
            {
                var assemblyName = Path.GetFileNameWithoutExtension(pdbxFile);
                if (!_localAssemblies.ContainsKey(assemblyName))
                {
                    // Found pdbx without PE, register it anyway for symbol lookup
                    RegisterPdbxOnly(pdbxFile);
                }
            }
        }
        catch (Exception ex)
        {
            Console.Error.WriteLine($"Error scanning directory {directory}: {ex.Message}");
        }
    }

    private void TryRegisterLocalAssembly(string peFilePath)
    {
        var assemblyName = Path.GetFileNameWithoutExtension(peFilePath);
        var directory = Path.GetDirectoryName(peFilePath) ?? "";

        var localInfo = new LocalAssemblyInfo
        {
            Name = assemblyName,
            PeFilePath = peFilePath,
            PdbxFilePath = Path.Combine(directory, assemblyName + ".pdbx"),
            PdbFilePath = Path.Combine(directory, assemblyName + ".pdb"),
            DllFilePath = Path.Combine(directory, assemblyName + ".dll")
        };

        // Check which symbol files exist
        localInfo.HasPdbx = File.Exists(localInfo.PdbxFilePath);
        localInfo.HasPdb = File.Exists(localInfo.PdbFilePath);

        // Compute checksum of PE file for matching
        localInfo.PeChecksum = ComputeFileChecksum(peFilePath);

        _localAssemblies[assemblyName] = localInfo;
    }

    private void RegisterPdbxOnly(string pdbxFilePath)
    {
        var assemblyName = Path.GetFileNameWithoutExtension(pdbxFilePath);
        var directory = Path.GetDirectoryName(pdbxFilePath) ?? "";

        var localInfo = new LocalAssemblyInfo
        {
            Name = assemblyName,
            PdbxFilePath = pdbxFilePath,
            PdbFilePath = Path.Combine(directory, assemblyName + ".pdb"),
            DllFilePath = Path.Combine(directory, assemblyName + ".dll"),
            HasPdbx = true,
            HasPdb = File.Exists(Path.Combine(directory, assemblyName + ".pdb"))
        };

        _localAssemblies[assemblyName] = localInfo;
    }

    private void TryMatchLocalAssembly(AssemblyInfo deviceAssembly)
    {
        if (_localAssemblies.TryGetValue(deviceAssembly.Name, out var localInfo))
        {
            // Check if checksums match (if we have both)
            if (localInfo.PeChecksum != 0 && deviceAssembly.Checksum != 0)
            {
                deviceAssembly.ChecksumMatch = localInfo.PeChecksum == deviceAssembly.Checksum;
                
                if (!deviceAssembly.ChecksumMatch)
                {
                    OnAssemblyMismatch(deviceAssembly, localInfo, AssemblyMismatchReason.ChecksumMismatch);
                }
            }

            deviceAssembly.LocalAssembly = localInfo;
        }
        else
        {
            // No local assembly found
            OnAssemblyMismatch(deviceAssembly, null, AssemblyMismatchReason.NotFound);
        }
    }

    private void OnAssemblyMismatch(AssemblyInfo deviceAssembly, LocalAssemblyInfo? localAssembly, AssemblyMismatchReason reason)
    {
        AssemblyMismatchDetected?.Invoke(this, new AssemblyMismatchEventArgs
        {
            DeviceAssembly = deviceAssembly,
            LocalAssembly = localAssembly,
            Reason = reason
        });
    }

    private static uint ComputeFileChecksum(string filePath)
    {
        try
        {
            // Compute CRC32 to match device checksum format
            // nanoFramework uses a simple checksum
            using var stream = File.OpenRead(filePath);
            var bytes = new byte[stream.Length];
            stream.Read(bytes, 0, bytes.Length);
            
            uint crc = 0;
            foreach (byte b in bytes)
            {
                crc = (crc >> 8) ^ Crc32Table[(crc ^ b) & 0xFF];
            }
            return crc ^ 0xFFFFFFFF;
        }
        catch
        {
            return 0;
        }
    }

    // CRC32 lookup table
    private static readonly uint[] Crc32Table = InitializeCrc32Table();

    private static uint[] InitializeCrc32Table()
    {
        var table = new uint[256];
        for (uint i = 0; i < 256; i++)
        {
            uint crc = i;
            for (int j = 0; j < 8; j++)
            {
                crc = (crc & 1) != 0 ? (crc >> 1) ^ 0xEDB88320 : crc >> 1;
            }
            table[i] = crc;
        }
        return table;
    }

    /// <summary>
    /// Get assembly info by name
    /// </summary>
    public AssemblyInfo? GetDeviceAssembly(string name)
    {
        return _deviceAssemblies.TryGetValue(name, out var info) ? info : null;
    }

    /// <summary>
    /// Get local assembly info by name
    /// </summary>
    public LocalAssemblyInfo? GetLocalAssembly(string name)
    {
        return _localAssemblies.TryGetValue(name, out var info) ? info : null;
    }

    /// <summary>
    /// Get all device assemblies
    /// </summary>
    public IEnumerable<AssemblyInfo> GetDeviceAssemblies()
    {
        return _deviceAssemblies.Values;
    }

    /// <summary>
    /// Get all local assemblies
    /// </summary>
    public IEnumerable<LocalAssemblyInfo> GetLocalAssemblies()
    {
        return _localAssemblies.Values;
    }

    /// <summary>
    /// Get the path to the .pdbx file for an assembly
    /// </summary>
    public string? GetPdbxPath(string assemblyName)
    {
        if (_deviceAssemblies.TryGetValue(assemblyName, out var deviceInfo) && 
            deviceInfo.LocalAssembly?.HasPdbx == true)
        {
            return deviceInfo.LocalAssembly.PdbxFilePath;
        }

        if (_localAssemblies.TryGetValue(assemblyName, out var localInfo) && localInfo.HasPdbx)
        {
            return localInfo.PdbxFilePath;
        }

        return null;
    }

    /// <summary>
    /// Get all .pdbx file paths for assemblies that have symbols
    /// </summary>
    public IEnumerable<string> GetAllPdbxPaths()
    {
        foreach (var localAssembly in _localAssemblies.Values)
        {
            if (localAssembly.HasPdbx && !string.IsNullOrEmpty(localAssembly.PdbxFilePath))
            {
                yield return localAssembly.PdbxFilePath;
            }
        }
    }

    /// <summary>
    /// Clear all registered assemblies
    /// </summary>
    public void Clear()
    {
        _deviceAssemblies.Clear();
        _localAssemblies.Clear();
    }

    public void Dispose()
    {
        if (!_disposed)
        {
            Clear();
            _disposed = true;
        }
    }
}

/// <summary>
/// Information about an assembly loaded on the device
/// </summary>
public class AssemblyInfo
{
    public string Name { get; set; } = string.Empty;
    public Version Version { get; set; } = new Version();
    public uint Checksum { get; set; }
    public int DeviceIndex { get; set; }
    public bool LoadedFromDevice { get; set; }
    public bool ChecksumMatch { get; set; } = true;
    public LocalAssemblyInfo? LocalAssembly { get; set; }
}

/// <summary>
/// Information about a local assembly with its symbol files
/// </summary>
public class LocalAssemblyInfo
{
    public string Name { get; set; } = string.Empty;
    public string? PeFilePath { get; set; }
    public string? PdbxFilePath { get; set; }
    public string? PdbFilePath { get; set; }
    public string? DllFilePath { get; set; }
    public bool HasPdbx { get; set; }
    public bool HasPdb { get; set; }
    public uint PeChecksum { get; set; }
}

/// <summary>
/// Event args for assembly mismatch detection
/// </summary>
public class AssemblyMismatchEventArgs : EventArgs
{
    public AssemblyInfo DeviceAssembly { get; set; } = new();
    public LocalAssemblyInfo? LocalAssembly { get; set; }
    public AssemblyMismatchReason Reason { get; set; }
}

/// <summary>
/// Reason for assembly mismatch
/// </summary>
public enum AssemblyMismatchReason
{
    /// <summary>No local assembly found matching device assembly name</summary>
    NotFound,
    /// <summary>Local assembly found but checksum doesn't match</summary>
    ChecksumMismatch,
    /// <summary>Local assembly found but version doesn't match</summary>
    VersionMismatch
}
