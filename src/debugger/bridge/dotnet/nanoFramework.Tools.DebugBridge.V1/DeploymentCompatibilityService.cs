using System.Text;
using nanoFramework.Tools.Debugger;

namespace nanoFramework.Tools.DebugBridge;

internal static class DeploymentCompatibilityService
{
    private const int NativeChecksumOffset = 20;
    private const int VersionOffset = 28;
    private const int AssemblyNameOffset = 36;
    private const int TablesOffset = 40;
    private const int StringsTableIndex = 11;
    private const int EndOfAssemblyTableIndex = 15;
    private const int MinimumHeaderSize = TablesOffset + 16 * sizeof(uint);

    internal static CompatibilityResult Check(IEnumerable<string> imagePaths, Engine engine)
    {
        var deviceByName = engine.Capabilities.NativeAssemblies
            .ToDictionary(assembly => assembly.Name, StringComparer.Ordinal);
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
                    errors.Add(
                        $"Managed library {assembly.Name} v{assembly.Version} requires native checksum " +
                        $"0x{assembly.Checksum:X8}, but that native assembly is not present on the device.");
                }
                else if (nativeAssembly.Checksum != assembly.Checksum)
                {
                    errors.Add(
                        $"{assembly.Name}: managed library v{assembly.Version} requires native checksum " +
                        $"0x{assembly.Checksum:X8}; device native library v{nativeAssembly.Version} has checksum " +
                        $"0x{nativeAssembly.Checksum:X8}.");
                }
            }
        }

        if (errors.Count == 0)
        {
            return new CompatibilityResult(true);
        }

        var message = "The device firmware is incompatible with the application libraries:"
            + Environment.NewLine
            + string.Join(Environment.NewLine, errors)
            + Environment.NewLine
            + "Update the device firmware or use compatible NuGet package versions before deploying.";
        return new CompatibilityResult(false, message);
    }

    internal static IEnumerable<V1AssemblyInfo> ReadAssemblies(string imagePath)
    {
        var data = File.ReadAllBytes(imagePath);
        var offset = 0;

        while (offset + MinimumHeaderSize <= data.Length
            && data.AsSpan(offset, 6).SequenceEqual("NFMRK1"u8))
        {
            var totalSize = checked((int)BitConverter.ToUInt32(
                data,
                offset + TablesOffset + EndOfAssemblyTableIndex * sizeof(uint)));
            if (totalSize < MinimumHeaderSize || offset + totalSize > data.Length)
            {
                throw new InvalidDataException($"Invalid nanoFramework v1 assembly size in '{imagePath}'.");
            }

            var version = new Version(
                BitConverter.ToUInt16(data, offset + VersionOffset),
                BitConverter.ToUInt16(data, offset + VersionOffset + 2),
                BitConverter.ToUInt16(data, offset + VersionOffset + 4),
                BitConverter.ToUInt16(data, offset + VersionOffset + 6));
            var name = ReadAssemblyName(
                data,
                offset,
                totalSize,
                BitConverter.ToUInt16(data, offset + AssemblyNameOffset),
                imagePath);

            yield return new V1AssemblyInfo(
                name,
                version,
                BitConverter.ToUInt32(data, offset + NativeChecksumOffset));

            var assemblyEnd = offset + totalSize;
            var alignedEnd = Math.Min((assemblyEnd + 3) & ~3, data.Length);
            if (data.AsSpan(assemblyEnd, alignedEnd - assemblyEnd).IndexOfAnyExcept((byte)0) >= 0)
            {
                throw new InvalidDataException(
                    $"Non-zero alignment padding after a nanoFramework v1 assembly in '{imagePath}'.");
            }

            offset = alignedEnd;
        }

        if (offset == 0)
        {
            throw new InvalidDataException($"'{imagePath}' is not a nanoFramework v1 deployment image.");
        }

        if (offset < data.Length && !IsFiller(data.AsSpan(offset)))
        {
            throw new InvalidDataException(
                $"Unexpected data after the last nanoFramework v1 assembly in '{imagePath}'.");
        }
    }

    private static bool IsFiller(ReadOnlySpan<byte> data)
    {
        var filler = data[0];
        return (filler == 0x00 || filler == 0xFF)
            && data.IndexOfAnyExcept(filler) < 0;
    }

    private static string ReadAssemblyName(
        byte[] data,
        int assemblyOffset,
        int totalSize,
        ushort nameToken,
        string imagePath)
    {
        if (nameToken == 0xFCD2)
        {
            return "mscorlib";
        }

        if (nameToken >= 0xFCA4)
        {
            throw new InvalidDataException(
                $"Unsupported shared assembly-name token 0x{nameToken:X4} in '{imagePath}'.");
        }

        var stringsOffset = checked((int)BitConverter.ToUInt32(
            data,
            assemblyOffset + TablesOffset + StringsTableIndex * sizeof(uint)));
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

    internal sealed record V1AssemblyInfo(string Name, Version Version, uint Checksum);
}
