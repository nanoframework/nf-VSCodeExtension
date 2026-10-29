using System.Text;
using nanoFramework.Tools.DebugBridge;

var tests = new (string Name, Action Run)[]
{
    ("valid v1 image", ValidV1Image),
    ("zero trailing filler", ZeroTrailingFiller),
    ("erased trailing filler", ErasedTrailingFiller),
    ("appended v2 assembly", AppendedV2Assembly),
    ("invalid trailing data", InvalidTrailingData),
    ("non-zero alignment padding", NonZeroAlignmentPadding)
};

foreach (var test in tests)
{
    test.Run();
    Console.WriteLine($"PASS: {test.Name}");
}

static void ValidV1Image()
{
    using var image = CreateImage(CreateAssembly("NFMRK1", "App"));
    var assemblies = DeploymentCompatibilityService.ReadAssemblies(image.Name).ToArray();

    Assert(assemblies.Length == 1, $"Expected one assembly, found {assemblies.Length}.");
    Assert(assemblies[0].Name == "App", assemblies[0].Name);
}

static void ZeroTrailingFiller()
{
    using var image = CreateImage(CreateAssembly("NFMRK1", "App"), new byte[16]);
    Assert(DeploymentCompatibilityService.ReadAssemblies(image.Name).Count() == 1, "Zero filler was rejected.");
}

static void ErasedTrailingFiller()
{
    using var image = CreateImage(CreateAssembly("NFMRK1", "App"), Enumerable.Repeat((byte)0xFF, 16).ToArray());
    Assert(DeploymentCompatibilityService.ReadAssemblies(image.Name).Count() == 1, "Erased filler was rejected.");
}

static void AppendedV2Assembly()
{
    using var image = CreateImage(CreateAssembly("NFMRK1", "App"), CreateAssembly("NFMRK2", "Other"));
    AssertInvalid(image.Name, "Unexpected data");
}

static void InvalidTrailingData()
{
    using var image = CreateImage(CreateAssembly("NFMRK1", "App"), [0x00, 0x01]);
    AssertInvalid(image.Name, "Unexpected data");
}

static void NonZeroAlignmentPadding()
{
    var assembly = CreateAssembly("NFMRK1", "Even");
    Array.Resize(ref assembly, assembly.Length + 1);
    assembly[^1] = 0x7F;
    using var image = CreateImage(assembly);

    AssertInvalid(image.Name, "alignment padding");
}

static byte[] CreateAssembly(string marker, string name)
{
    const int headerSize = 124;
    const int tablesOffset = 40;
    const int stringsTableIndex = 11;
    const int endOfAssemblyTableIndex = 15;
    var nameBytes = Encoding.UTF8.GetBytes(name);
    var data = new byte[headerSize + nameBytes.Length + 1];

    Encoding.ASCII.GetBytes(marker).CopyTo(data, 0);
    BitConverter.GetBytes((ushort)1).CopyTo(data, 28);
    BitConverter.GetBytes((ushort)0).CopyTo(data, 36);
    for (var tableIndex = 0; tableIndex < 16; tableIndex++)
    {
        var tableStart = tableIndex <= stringsTableIndex ? headerSize : data.Length;
        BitConverter.GetBytes((uint)tableStart).CopyTo(data, tablesOffset + tableIndex * sizeof(uint));
    }
    BitConverter.GetBytes((uint)data.Length).CopyTo(
        data,
        tablesOffset + endOfAssemblyTableIndex * sizeof(uint));
    nameBytes.CopyTo(data, headerSize);
    return data;
}

static TemporaryImage CreateImage(params byte[][] parts)
{
    var path = Path.Combine(Path.GetTempPath(), $"nf-v1-deployment-{Guid.NewGuid():N}.bin");
    using var output = File.Create(path);
    foreach (var part in parts)
    {
        output.Write(part);
        if (part.Length >= 6
            && Encoding.ASCII.GetString(part, 0, 6) is "NFMRK1" or "NFMRK2")
        {
            while (output.Position % sizeof(uint) != 0)
            {
                output.WriteByte(0);
            }
        }
    }
    return new TemporaryImage(path);
}

static void AssertInvalid(string path, string expectedMessage)
{
    try
    {
        _ = DeploymentCompatibilityService.ReadAssemblies(path).ToArray();
        throw new InvalidOperationException("Expected InvalidDataException.");
    }
    catch (InvalidDataException exception)
    {
        Assert(exception.Message.Contains(expectedMessage, StringComparison.OrdinalIgnoreCase), exception.Message);
    }
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
