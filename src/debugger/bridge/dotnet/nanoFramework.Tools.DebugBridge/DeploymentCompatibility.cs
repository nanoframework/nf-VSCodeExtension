using System.Text;
using nanoFramework.Tools.Debugger;

namespace nanoFramework.Tools.DebugBridge;

internal sealed record ManagedAssemblyNativeInfo(string Name, Version Version, uint Checksum);

internal static class DeploymentCompatibility
{
    private const int NativeChecksumOffset = 20;
    private const int VersionOffset = 28;
    private const int AssemblyNameOffset = 36;
    private const int TablesOffset = 40;
    private const int StringsTableIndex = 11;
    private const int EndOfAssemblyTableIndex = 15;
    private const int MinimumHeaderSize = TablesOffset + 16 * sizeof(uint);

    internal static string? Check(IEnumerable<string> imagePaths, IReadOnlyCollection<CLRCapabilities.NativeAssemblyProperties> deviceAssemblies)
    {
        var deviceByName = deviceAssemblies.ToDictionary(assembly => assembly.Name, StringComparer.Ordinal);
        var errors = new List<string>();

        foreach (var imagePath in imagePaths)
        {
            foreach (var assembly in ReadAssemblies(imagePath))
            {
                if (assembly.Checksum == 0)
                {
                    continue;
                }

                if (!deviceByName.TryGetValue(assembly.Name, out var nativeAssembly))
                {
                    errors.Add($"Managed library {assembly.Name} v{assembly.Version} requires native checksum 0x{assembly.Checksum:X8}, but that native assembly is not present on the device.");
                }
                else if (nativeAssembly.Checksum != assembly.Checksum)
                {
                    errors.Add($"{assembly.Name}: managed library v{assembly.Version} requires native checksum 0x{assembly.Checksum:X8}; device native library v{nativeAssembly.Version} has checksum 0x{nativeAssembly.Checksum:X8}.");
                }
            }
        }

        return errors.Count == 0
            ? null
            : "The device firmware is incompatible with the application libraries:\n" + string.Join("\n", errors) + "\nUpdate the device firmware or use compatible NuGet package versions before deploying.";
    }

    internal static IEnumerable<ManagedAssemblyNativeInfo> ReadAssemblies(string imagePath)
    {
        var data = File.ReadAllBytes(imagePath);
        var offset = 0;

        while (offset + MinimumHeaderSize <= data.Length && HasAssemblyMarker(data, offset))
        {
            var totalSize = checked((int)BitConverter.ToUInt32(data, offset + TablesOffset + EndOfAssemblyTableIndex * sizeof(uint)));
            if (totalSize < MinimumHeaderSize || offset + totalSize > data.Length)
            {
                throw new InvalidDataException($"Invalid nanoFramework assembly size in '{imagePath}'.");
            }

            var checksum = BitConverter.ToUInt32(data, offset + NativeChecksumOffset);
            var version = new Version(
                BitConverter.ToUInt16(data, offset + VersionOffset),
                BitConverter.ToUInt16(data, offset + VersionOffset + 2),
                BitConverter.ToUInt16(data, offset + VersionOffset + 4),
                BitConverter.ToUInt16(data, offset + VersionOffset + 6));
            var nameToken = BitConverter.ToUInt16(data, offset + AssemblyNameOffset);
            var name = ReadAssemblyName(data, offset, totalSize, nameToken, imagePath);

            yield return new ManagedAssemblyNativeInfo(name, version, checksum);
            offset = (offset + totalSize + 3) & ~3;
        }

        if (offset == 0)
        {
            throw new InvalidDataException($"'{imagePath}' is not a nanoFramework deployment image.");
        }
    }

    private static bool HasAssemblyMarker(byte[] data, int offset) =>
        data.AsSpan(offset, 6).SequenceEqual("NFMRK1"u8);

    private static string ReadAssemblyName(byte[] data, int assemblyOffset, int totalSize, ushort nameToken, string imagePath)
    {
        // mscorlib is stored in the shared string table instead of the assembly-local table.
        if (nameToken == 0xFCD2)
        {
            return "mscorlib";
        }

        if (nameToken >= 0xFCA4)
        {
            throw new InvalidDataException($"Unsupported shared assembly-name token 0x{nameToken:X4} in '{imagePath}'.");
        }

        var stringsOffset = checked((int)BitConverter.ToUInt32(data, assemblyOffset + TablesOffset + StringsTableIndex * sizeof(uint)));
        var nameOffset = assemblyOffset + stringsOffset + nameToken;
        var assemblyEnd = assemblyOffset + totalSize;
        if (nameOffset < assemblyOffset || nameOffset >= assemblyEnd)
        {
            throw new InvalidDataException($"Invalid assembly name in '{imagePath}'.");
        }

        var terminator = Array.IndexOf(data, (byte)0, nameOffset, assemblyEnd - nameOffset);
        if (terminator < 0)
        {
            throw new InvalidDataException($"Unterminated assembly name in '{imagePath}'.");
        }

        return Encoding.UTF8.GetString(data, nameOffset, terminator - nameOffset);
    }
}