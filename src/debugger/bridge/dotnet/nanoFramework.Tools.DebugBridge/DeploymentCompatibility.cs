using System.Text;
using nanoFramework.Tools.Debugger;

namespace nanoFramework.Tools.DebugBridge;

internal enum PeFormat
{
    V1 = 1,
    V2 = 2
}

internal sealed record ManagedAssemblyReference(string Name, Version Version);

internal sealed record ManagedAssemblyInfo(
    string Name,
    Version Version,
    uint NativeContractHash,
    PeFormat Format,
    IReadOnlyList<ManagedAssemblyReference> References,
    string SourcePath,
    int Offset);

internal static class DeploymentCompatibility
{
    private const int MarkerLength = 6;
    private const int NativeContractHashOffset = 20;
    private const int AssemblyRefTableIndex = 0;
    private const int SharedStringTableSize = 0x35C;
    private const int SharedStringsFirstIndex = 0xFFFF - SharedStringTableSize;
    private const ushort SharedStringMscorlibIndex = 0xFFFF - 0x32D;
    private const string TroubleshootingGuideUrl = "https://docs.nanoframework.net/content/faq/working-with-vs-extension.html";

    private static readonly byte[] MarkerV1 = Encoding.ASCII.GetBytes("NFMRK1");
    private static readonly byte[] MarkerV2 = Encoding.ASCII.GetBytes("NFMRK2");

    internal static string? Check(
        IEnumerable<string> imagePaths,
        IReadOnlyCollection<CLRCapabilities.NativeAssemblyProperties> deviceAssemblies,
        Version? nanoClrVersion = null)
    {
        var assemblies = imagePaths.SelectMany(ReadAssemblies).ToList();
        var issues = new List<string>();
        var requiredFormat = GetRequiredFormat(assemblies, nanoClrVersion);

        foreach (var assembly in assemblies.Where(assembly => assembly.Format != requiredFormat))
        {
            issues.Add(
                $"'{assembly.Name}' v{assembly.Version} ({FormatLocation(assembly)}) is a {FormatPeFormat(assembly.Format)} PE, " +
                $"but {FormatPeFormat(requiredFormat)} is required.");
        }

        var compatibleAssemblies = assemblies.Where(assembly => assembly.Format == requiredFormat).ToList();
        CheckNativeCompatibility(compatibleAssemblies, deviceAssemblies, issues);
        CheckReferences(compatibleAssemblies, assemblies, issues);

        return issues.Count == 0 ? null : FormatMessage(issues);
    }

    internal static IReadOnlyList<ManagedAssemblyInfo> ReadAssemblies(string imagePath)
    {
        var data = File.ReadAllBytes(imagePath);
        var assemblies = new List<ManagedAssemblyInfo>();
        var offset = 0;

        while (offset < data.Length)
        {
            if (!TryGetFormat(data, offset, out var format))
            {
                if (assemblies.Count > 0 && IsFiller(data, offset))
                {
                    break;
                }

                throw new InvalidDataException(
                    assemblies.Count == 0
                        ? $"'{imagePath}' is not a nanoFramework deployment image."
                        : $"Unexpected data in '{imagePath}' at offset 0x{offset:X}.");
            }

            var assembly = ReadAssembly(data, offset, format, imagePath);
            assemblies.Add(assembly);
            var nextOffset = ((long)offset + GetAssemblySize(data, offset, format) + 3) & ~3L;
            offset = nextOffset >= data.Length ? data.Length : checked((int)nextOffset);
        }

        if (assemblies.Count == 0)
        {
            throw new InvalidDataException($"'{imagePath}' is empty.");
        }

        return assemblies;
    }

    private static ManagedAssemblyInfo ReadAssembly(byte[] data, int offset, PeFormat format, string imagePath)
    {
        var layout = GetLayout(format);
        if (data.Length - offset < layout.HeaderSize)
        {
            throw new InvalidDataException(
                $"'{imagePath}': assembly at offset 0x{offset:X} is truncated.");
        }

        var tableOffsets = new uint[layout.TableCount];
        for (var index = 0; index < tableOffsets.Length; index++)
        {
            tableOffsets[index] = ReadUInt32(data, offset + layout.TablesOffset + index * sizeof(uint));
        }

        var totalSize = tableOffsets[layout.EndOfAssemblyTableIndex];
        if (totalSize < layout.HeaderSize || totalSize > data.Length - offset)
        {
            throw new InvalidDataException(
                $"'{imagePath}': assembly at offset 0x{offset:X} declares an invalid size ({totalSize} bytes).");
        }

        for (var index = 0; index < layout.EndOfAssemblyTableIndex; index++)
        {
            if (tableOffsets[index] < layout.HeaderSize || tableOffsets[index] > tableOffsets[index + 1])
            {
                throw new InvalidDataException(
                    $"'{imagePath}': assembly at offset 0x{offset:X} has an invalid table layout.");
            }
        }

        var stringsStart = checked((int)tableOffsets[layout.StringsTableIndex]);
        var stringsEnd = checked((int)tableOffsets[layout.StringsTableIndex + 1])
            - data[offset + layout.TablePaddingOffset + layout.StringsTableIndex];
        var version = ReadVersion(data, offset + layout.VersionOffset);
        var name = ReadString(
            data,
            offset,
            stringsStart,
            stringsEnd,
            ReadUInt16(data, offset + layout.AssemblyNameOffset),
            imagePath,
            "assembly name");

        var assemblyRefStart = checked((int)tableOffsets[AssemblyRefTableIndex]);
        var assemblyRefSize = checked((int)tableOffsets[AssemblyRefTableIndex + 1])
            - assemblyRefStart
            - data[offset + layout.TablePaddingOffset + AssemblyRefTableIndex];
        if (assemblyRefSize < 0 || assemblyRefSize % layout.AssemblyRefRowSize != 0)
        {
            throw new InvalidDataException(
                $"'{imagePath}': assembly '{name}' has an invalid AssemblyRef table.");
        }

        var references = new List<ManagedAssemblyReference>(assemblyRefSize / layout.AssemblyRefRowSize);
        for (var row = 0; row < assemblyRefSize; row += layout.AssemblyRefRowSize)
        {
            var rowOffset = offset + assemblyRefStart + row;
            references.Add(new ManagedAssemblyReference(
                ReadString(
                    data,
                    offset,
                    stringsStart,
                    stringsEnd,
                    ReadUInt16(data, rowOffset),
                    imagePath,
                    $"assembly reference in '{name}'"),
                ReadVersion(data, rowOffset + layout.AssemblyRefVersionOffset)));
        }

        return new ManagedAssemblyInfo(
            name,
            version,
            ReadUInt32(data, offset + NativeContractHashOffset),
            format,
            references,
            imagePath,
            offset);
    }

    private static void CheckNativeCompatibility(
        IEnumerable<ManagedAssemblyInfo> assemblies,
        IEnumerable<CLRCapabilities.NativeAssemblyProperties> deviceAssemblies,
        ICollection<string> issues)
    {
        var deviceByName = deviceAssemblies.ToLookup(assembly => assembly.Name, StringComparer.Ordinal);
        var checkedAssemblies = new HashSet<string>(StringComparer.Ordinal);

        foreach (var assembly in assemblies)
        {
            if (assembly.NativeContractHash == 0
                || !checkedAssemblies.Add($"{assembly.Name}|{assembly.Version}|{assembly.NativeContractHash}"))
            {
                continue;
            }

            var candidates = deviceByName[assembly.Name].ToList();
            if (candidates.Count == 0)
            {
                issues.Add(
                    $"'{assembly.Name}' v{assembly.Version} requires native contract hash " +
                    $"0x{assembly.NativeContractHash:X8}, but the target does not have support for '{assembly.Name}'.");
            }
            else if (!candidates.Any(candidate => candidate.Checksum == assembly.NativeContractHash))
            {
                var actual = string.Join(
                    " or ",
                    candidates.Select(candidate =>
                        $"v{candidate.Version}, contract hash 0x{candidate.Checksum:X8}"));
                issues.Add(
                    $"'{assembly.Name}' v{assembly.Version} requires native contract hash " +
                    $"0x{assembly.NativeContractHash:X8}, but the target has {actual}.");
            }
        }
    }

    private static void CheckReferences(
        IEnumerable<ManagedAssemblyInfo> assemblies,
        IEnumerable<ManagedAssemblyInfo> deployment,
        ICollection<string> issues)
    {
        var deploymentByName = deployment.ToLookup(assembly => assembly.Name, StringComparer.Ordinal);
        var checkedReferences = new HashSet<string>(StringComparer.Ordinal);

        foreach (var assembly in assemblies)
        {
            foreach (var reference in assembly.References)
            {
                if (!checkedReferences.Add(
                    $"{assembly.Name}|{assembly.Version}|{reference.Name}|{reference.Version}"))
                {
                    continue;
                }

                var versions = deploymentByName[reference.Name]
                    .Select(candidate => candidate.Version)
                    .Distinct()
                    .ToList();
                if (versions.Count == 0)
                {
                    issues.Add(
                        $"'{assembly.Name}' v{assembly.Version} references '{reference.Name}' " +
                        $"v{reference.Version}, which is not part of the deployment.");
                }
                else if (!versions.Any(version =>
                    version.Major == reference.Version.Major
                    && version.Minor == reference.Version.Minor))
                {
                    issues.Add(
                        $"'{assembly.Name}' v{assembly.Version} references '{reference.Name}' " +
                        $"v{reference.Version} (requires v{reference.Version.Major}.{reference.Version.Minor}.*.*), " +
                        $"but the deployment has {string.Join(" and ", versions.Select(version => $"'{reference.Name}' v{version}"))}.");
                }
            }
        }
    }

    private static PeFormat GetRequiredFormat(
        IReadOnlyCollection<ManagedAssemblyInfo> assemblies,
        Version? nanoClrVersion)
    {
        if (nanoClrVersion?.Major >= 1)
        {
            return nanoClrVersion.Major >= 2 ? PeFormat.V2 : PeFormat.V1;
        }

        return assemblies.Max(assembly => assembly.Format);
    }

    private static string FormatMessage(IEnumerable<string> issues)
    {
        var newline = Environment.NewLine;
        return "Deploy failed." + newline + newline
            + "***************************************************************************" + newline + newline
            + string.Join(newline, issues.Select(issue => $"    {issue}")) + newline + newline
            + "Please update the target firmware or use consistent v2 nanoFramework NuGet packages and build tools." + newline
            + $"Our Visual Studio FAQ has a troubleshooting guide: {TroubleshootingGuideUrl}" + newline + newline
            + "***************************************************************************" + newline;
    }

    private static string FormatLocation(ManagedAssemblyInfo assembly) =>
        assembly.Offset == 0 ? assembly.SourcePath : $"{assembly.SourcePath} @ 0x{assembly.Offset:X}";

    private static string FormatPeFormat(PeFormat format) =>
        format == PeFormat.V1 ? "V1 (NFMRK1)" : "V2 (NFMRK2)";

    private static int GetAssemblySize(byte[] data, int offset, PeFormat format)
    {
        var layout = GetLayout(format);
        return checked((int)ReadUInt32(
            data,
            offset + layout.TablesOffset + layout.EndOfAssemblyTableIndex * sizeof(uint)));
    }

    private static PeLayout GetLayout(PeFormat format) =>
        format == PeFormat.V2
            ? new PeLayout(24, 32, 36, 18, 108, 128, 13, 17, 10, 2)
            : new PeLayout(28, 36, 40, 16, 108, 124, 11, 15, 12, 4);

    private static bool TryGetFormat(byte[] data, int offset, out PeFormat format)
    {
        if (StartsWith(data, offset, MarkerV2))
        {
            format = PeFormat.V2;
            return true;
        }

        if (StartsWith(data, offset, MarkerV1))
        {
            format = PeFormat.V1;
            return true;
        }

        format = default;
        return false;
    }

    private static bool StartsWith(byte[] data, int offset, byte[] marker) =>
        data.Length - offset >= MarkerLength
        && data.AsSpan(offset, MarkerLength).SequenceEqual(marker);

    private static bool IsFiller(byte[] data, int offset)
    {
        var filler = data[offset];
        return (filler == 0x00 || filler == 0xFF)
            && data.AsSpan(offset).IndexOfAnyExcept(filler) < 0;
    }

    private static string ReadString(
        byte[] data,
        int assemblyOffset,
        int stringsStart,
        int stringsEnd,
        ushort index,
        string imagePath,
        string description)
    {
        if (index >= SharedStringsFirstIndex)
        {
            if (index == SharedStringMscorlibIndex)
            {
                return "mscorlib";
            }

            throw new InvalidDataException(
                $"'{imagePath}': {description} uses unsupported nanoCLR built-in string 0x{index:X4}.");
        }

        if (index >= stringsEnd - stringsStart)
        {
            throw new InvalidDataException(
                $"'{imagePath}': {description} is outside the strings table.");
        }

        var start = assemblyOffset + stringsStart + index;
        var end = assemblyOffset + stringsEnd;
        var terminator = Array.IndexOf(data, (byte)0, start, end - start);
        if (terminator < 0)
        {
            throw new InvalidDataException(
                $"'{imagePath}': {description} is not terminated.");
        }

        return Encoding.UTF8.GetString(data, start, terminator - start);
    }

    private static Version ReadVersion(byte[] data, int offset) =>
        new(
            ReadUInt16(data, offset),
            ReadUInt16(data, offset + 2),
            ReadUInt16(data, offset + 4),
            ReadUInt16(data, offset + 6));

    private static ushort ReadUInt16(byte[] data, int offset) =>
        (ushort)(data[offset] | (data[offset + 1] << 8));

    private static uint ReadUInt32(byte[] data, int offset) =>
        (uint)(data[offset]
            | (data[offset + 1] << 8)
            | (data[offset + 2] << 16)
            | (data[offset + 3] << 24));

    private sealed record PeLayout(
        int VersionOffset,
        int AssemblyNameOffset,
        int TablesOffset,
        int TableCount,
        int TablePaddingOffset,
        int HeaderSize,
        int StringsTableIndex,
        int EndOfAssemblyTableIndex,
        int AssemblyRefRowSize,
        int AssemblyRefVersionOffset);
}
