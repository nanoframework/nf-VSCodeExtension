using System.Text;
using nanoFramework.Tools.Debugger;
using nanoFramework.Tools.DebugBridge;

var tests = new (string Name, Action Run)[]
{
    ("compatible native assembly", CompatibleNativeAssembly),
    ("missing native assembly", MissingNativeAssembly),
    ("mismatched native checksum", MismatchedNativeChecksum),
    ("managed-only assembly", ManagedOnlyAssembly),
    ("concatenated deployment image", ConcatenatedDeploymentImage),
    ("preview v2 assembly", PreviewV2Assembly)
};

foreach (var test in tests)
{
    test.Run();
    Console.WriteLine($"PASS: {test.Name}");
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

    Assert(error?.Contains("not present", StringComparison.Ordinal) == true, error);
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
    Assert(assembly.Checksum == 0x12345678, $"0x{assembly.Checksum:X8}");
}

static TemporaryImage CreateImage(params (string Name, Version Version, uint Checksum)[] assemblies)
    => CreateImageFile("NFMRK1", 28, 36, assemblies);

static TemporaryImage CreatePreviewImage(params (string Name, Version Version, uint Checksum)[] assemblies)
    => CreateImageFile("NFMRK2", 24, 32, assemblies);

static TemporaryImage CreateImageFile(
    string marker,
    int versionOffset,
    int assemblyNameOffset,
    params (string Name, Version Version, uint Checksum)[] assemblies)
{
    var path = Path.Combine(Path.GetTempPath(), $"nf-deployment-{Guid.NewGuid():N}.bin");
    using var output = File.Create(path);

    foreach (var assembly in assemblies)
    {
        var data = new byte[160];
        Encoding.ASCII.GetBytes(marker).CopyTo(data, 0);
        BitConverter.GetBytes(assembly.Checksum).CopyTo(data, 20);
        BitConverter.GetBytes((ushort)assembly.Version.Major).CopyTo(data, versionOffset);
        BitConverter.GetBytes((ushort)assembly.Version.Minor).CopyTo(data, versionOffset + 2);
        BitConverter.GetBytes((ushort)assembly.Version.Build).CopyTo(data, versionOffset + 4);
        BitConverter.GetBytes((ushort)assembly.Version.Revision).CopyTo(data, versionOffset + 6);
        BitConverter.GetBytes((ushort)0).CopyTo(data, assemblyNameOffset);
        BitConverter.GetBytes((uint)120).CopyTo(data, 40 + 11 * sizeof(uint));
        BitConverter.GetBytes((uint)data.Length).CopyTo(data, 40 + 15 * sizeof(uint));
        Encoding.UTF8.GetBytes(assembly.Name).CopyTo(data, 120);
        output.Write(data);
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