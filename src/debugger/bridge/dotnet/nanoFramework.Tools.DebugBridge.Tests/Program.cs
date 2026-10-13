using System.Text;
using nanoFramework.Tools.Debugger;
using nanoFramework.Tools.DebugBridge;
using nanoFramework.Tools.DebugBridge.Symbols;

var tests = new (string Name, Action Run)[]
{
    ("compatible native assembly", CompatibleNativeAssembly),
    ("missing native assembly", MissingNativeAssembly),
    ("mismatched native checksum", MismatchedNativeChecksum),
    ("managed-only assembly", ManagedOnlyAssembly),
    ("concatenated deployment image", ConcatenatedDeploymentImage),
    ("preview v2 assembly", PreviewV2Assembly),
    ("v2 firmware rejects v1 assembly", V2FirmwareRejectsV1Assembly),
    ("preview v2 JSON symbols", PreviewV2JsonSymbols)
};

foreach (var test in tests)
{
    test.Run();
    Console.WriteLine($"PASS: {test.Name}");
}

if (args.Length > 0)
{
    var resolver = new SymbolResolver();
    Assert(resolver.LoadSymbols(args[0]), $"Could not load symbols from {args[0]}.");
    var sourcePath = args.Length > 1 ? args[1] : "Program.cs";
    Assert(resolver.GetBreakpointLocation(sourcePath, 84) != null, $"No sequence point found for {sourcePath}.");
    Console.WriteLine("PASS: supplied symbol file");
}

static void CompatibleNativeAssembly()
{
    using var image = CreateImage(("System.Device.Gpio", new Version(1, 2, 3, 4), 0x12345678));
    var error = DeploymentCompatibility.Check(
        [image.Name],
        [new CLRCapabilities.NativeAssemblyProperties("System.Device.Gpio", 0x12345678, new Version(1, 2, 3, 4))]);

    Assert(error == null, error);
}

static void MissingNativeAssembly()
{
    using var image = CreateImage(("System.Device.Gpio", new Version(1, 2, 3, 4), 0x12345678));
    var error = DeploymentCompatibility.Check(imagePaths: [image.Name], deviceAssemblies: []);

    Assert(error?.Contains("does not have support", StringComparison.Ordinal) == true, error);
}

static void MismatchedNativeChecksum()
{
    using var image = CreateImage(("System.Device.Gpio", new Version(1, 2, 3, 4), 0x12345678));
    var error = DeploymentCompatibility.Check(
        [image.Name],
        [new CLRCapabilities.NativeAssemblyProperties("System.Device.Gpio", 0x87654321, new Version(1, 0, 0, 0))]);

    Assert(error?.Contains("0x12345678", StringComparison.Ordinal) == true, error);
    Assert(error?.Contains("0x87654321", StringComparison.Ordinal) == true, error);
}

static void ManagedOnlyAssembly()
{
    using var image = CreateImage(("MyApplication", new Version(1, 0, 0, 0), 0));
    var error = DeploymentCompatibility.Check(imagePaths: [image.Name], deviceAssemblies: []);

    Assert(error == null, error);
}

static void ConcatenatedDeploymentImage()
{
    using var image = CreateImage(
        ("MyApplication", new Version(1, 0, 0, 0), 0),
        ("System.Device.Gpio", new Version(1, 2, 3, 4), 0x12345678));
    var assemblies = DeploymentCompatibility.ReadAssemblies(image.Name).ToArray();

    Assert(assemblies.Length == 2, $"Expected 2 assemblies, found {assemblies.Length}.");
    Assert(assemblies[1].Name == "System.Device.Gpio", assemblies[1].Name);
}

static void PreviewV2Assembly()
{
    using var image = CreatePreviewImage(("System.Device.Gpio", new Version(2, 0, 0, 0), 0x12345678));
    var assembly = DeploymentCompatibility.ReadAssemblies(image.Name).Single();

    Assert(assembly.Name == "System.Device.Gpio", assembly.Name);
    Assert(assembly.Version == new Version(2, 0, 0, 0), assembly.Version.ToString());
    Assert(assembly.NativeContractHash == 0x12345678, $"0x{assembly.NativeContractHash:X8}");
    Assert(assembly.Format == PeFormat.V2, assembly.Format.ToString());
}

static void V2FirmwareRejectsV1Assembly()
{
    using var image = CreateImage(("Legacy.Library", new Version(1, 0, 0, 0), 0));
    var error = DeploymentCompatibility.Check(
        [image.Name],
        deviceAssemblies: [],
        nanoClrVersion: new Version(2, 0, 0, 0));

    Assert(error?.Contains("V1 (NFMRK1)", StringComparison.Ordinal) == true, error);
    Assert(error?.Contains("V2 (NFMRK2)", StringComparison.Ordinal) == true, error);
}

static void PreviewV2JsonSymbols()
{
        const string json = """
                {
                    "Assembly": {
                        "Token": { "CLR": "20000001", "NanoCLR": "00000000" },
                        "FileName": "Blinky.exe",
                        "Version": "1.0.0.0",
                        "Classes": [{
                            "Token": { "CLR": "02000004", "NanoCLR": "04000000" },
                            "Name": "Blinky.Program",
                            "Methods": [{
                                "Token": { "CLR": "06000003", "NanoCLR": "06000001" },
                                "Name": "Main",
                                "HasByteCode": true,
                                "ILMap": [{ "Token": { "CLR": "00000006", "NanoCLR": "00000004" } }]
                            }]
                        }]
                    }
                }
                """;

        var symbols = SymbolResolver.DeserializePdbx(json);
        var method = symbols?.Assembly?.Classes?.Single().Methods?.Single();
        Assert(symbols?.Assembly?.FileName == "Blinky.exe", symbols?.Assembly?.FileName);
        Assert(method?.Token?.CLR == 0x06000003, $"0x{method?.Token?.CLR:X8}");
        Assert(method?.Token?.NanoCLR == 0x06000001, $"0x{method?.Token?.NanoCLR:X8}");
        Assert(method?.ILMap?.Single().CLR == 6, method?.ILMap?.Single().CLR.ToString());
        Assert(method?.ILMap?.Single().NanoCLR == 4, method?.ILMap?.Single().NanoCLR.ToString());
        Assert(
            SymbolResolver.NormalizeSourcePath(@"C:\Repos\App\Program.cs") ==
            SymbolResolver.NormalizeSourcePath("/mnt/c/Repos/App/Program.cs"),
            "Windows and WSL source paths should match.");
}

static TemporaryImage CreateImage(params (string Name, Version Version, uint Checksum)[] assemblies)
    => CreateImageFile("NFMRK1", 28, 36, 40, 16, 108, 124, 11, 15, assemblies);

static TemporaryImage CreatePreviewImage(params (string Name, Version Version, uint Checksum)[] assemblies)
    => CreateImageFile("NFMRK2", 24, 32, 36, 18, 108, 128, 13, 17, assemblies);

static TemporaryImage CreateImageFile(
    string marker,
    int versionOffset,
    int assemblyNameOffset,
    int tablesOffset,
    int tableCount,
    int tablePaddingOffset,
    int headerSize,
    int stringsTableIndex,
    int endOfAssemblyTableIndex,
    params (string Name, Version Version, uint Checksum)[] assemblies)
{
    var path = Path.Combine(Path.GetTempPath(), $"nf-deployment-{Guid.NewGuid():N}.bin");
    using var output = File.Create(path);

    foreach (var assembly in assemblies)
    {
        var name = Encoding.UTF8.GetBytes(assembly.Name);
        var assemblySize = headerSize + name.Length + 1;
        var data = new byte[assemblySize];
        Encoding.ASCII.GetBytes(marker).CopyTo(data, 0);
        BitConverter.GetBytes(assembly.Checksum).CopyTo(data, 20);
        BitConverter.GetBytes((ushort)assembly.Version.Major).CopyTo(data, versionOffset);
        BitConverter.GetBytes((ushort)assembly.Version.Minor).CopyTo(data, versionOffset + 2);
        BitConverter.GetBytes((ushort)assembly.Version.Build).CopyTo(data, versionOffset + 4);
        BitConverter.GetBytes((ushort)assembly.Version.Revision).CopyTo(data, versionOffset + 6);
        BitConverter.GetBytes((ushort)0).CopyTo(data, assemblyNameOffset);
        for (var tableIndex = 0; tableIndex < tableCount; tableIndex++)
        {
            var tableStart = tableIndex <= stringsTableIndex ? headerSize : assemblySize;
            BitConverter.GetBytes((uint)tableStart).CopyTo(data, tablesOffset + tableIndex * sizeof(uint));
        }
        BitConverter.GetBytes((uint)assemblySize).CopyTo(
            data,
            tablesOffset + endOfAssemblyTableIndex * sizeof(uint));
        data[tablePaddingOffset + stringsTableIndex] = 0;
        name.CopyTo(data, headerSize);
        output.Write(data);
        while (output.Position % sizeof(uint) != 0)
        {
            output.WriteByte(0);
        }
    }

    return new TemporaryImage(path);
}

static void Assert(bool condition, string? message)
{
    if (!condition)
    {
        throw new InvalidOperationException(message ?? "Assertion failed.");
    }
}

sealed class TemporaryImage(string name) : IDisposable
{
    public string Name { get; } = name;

    public void Dispose() => File.Delete(Name);
}