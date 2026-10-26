using nanoFramework.Tools.Debugger;
using nanoFramework.Tools.Debugger.Compatibility;

namespace nanoFramework.Tools.DebugBridge;

internal static class DeploymentCompatibilityService
{
    internal static CompatibilityResult Check(IEnumerable<string> imagePaths, Engine engine)
    {
        var compatibility = DeploymentCompatibility.Check(imagePaths, engine);
        return new CompatibilityResult(
            compatibility.IsCompatible,
            compatibility.IsCompatible ? null : compatibility.FormatMessage());
    }
}
