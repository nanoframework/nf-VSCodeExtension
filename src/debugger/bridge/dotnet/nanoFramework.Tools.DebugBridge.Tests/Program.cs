using System.Text;
using nanoFramework.Tools.Debugger;
using nanoFramework.Tools.DebugBridge;

var tests = new (string Name, Action Run)[]
{
    ("compatible native assembly", CompatibleNativeAssembly),
    ("missing native assembly", MissingNativeAssembly),
    ("mismatched native checksum", MismatchedNativeChecksum),
    ("managed-only assembly", ManagedOnlyAssembly),
    ("concatenated deployment image", ConcatenatedDeploymentImage)
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

static TemporaryImage CreateImage(params (string Name, Version Version, uint Checksum)[] assemblies)
{
    var path = Path.Combine(Path.GetTempPath(), $"nf-deployment-{Guid.NewGuid():N}.bin");
    using var output = File.Create(path);

    foreach (var assembly in assemblies)
    {
        var data = new byte[160];
        Encoding.ASCII.GetBytes("NFMRK1").CopyTo(data, 0);
        BitConverter.GetBytes(assembly.Checksum).CopyTo(data, 20);
        BitConverter.GetBytes((ushort)assembly.Version.Major).CopyTo(data, 28);
        BitConverter.GetBytes((ushort)assembly.Version.Minor).CopyTo(data, 30);
        BitConverter.GetBytes((ushort)assembly.Version.Build).CopyTo(data, 32);
        BitConverter.GetBytes((ushort)assembly.Version.Revision).CopyTo(data, 34);
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