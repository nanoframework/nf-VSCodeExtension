#!/usr/bin/env pwsh
param(
    [string]$SdkPath = (Join-Path $PSScriptRoot "../dist/utils/nanoFramework/v2.0")
)

$ErrorActionPreference = "Stop"
$SdkPath = (Resolve-Path $SdkPath).Path
$testDirectory = Join-Path ([IO.Path]::GetTempPath()) ("nf-resources-" + [Guid]::NewGuid().ToString("N"))
New-Item -ItemType Directory -Path (Join-Path $testDirectory "Resources") -Force | Out-Null

function Invoke-ResourceBuild {
    & dotnet msbuild (Join-Path $testDirectory "Resources.proj") -nologo -verbosity:minimal `
        "-p:SdkPath=$SdkPath"
    if ($LASTEXITCODE -ne 0) {
        throw "Resource build failed."
    }
}

try {
    @'
<Project DefaultTargets="Build">
  <Import Project="$(SdkPath)/NFProjectSystem.MDP.targets" />
  <Target Name="Build">
    <GenerateNanoResourceTask Sources="$(MSBuildThisFileDirectory)Resources.resx"
        OutputResources="$(MSBuildThisFileDirectory)Resources.nanoresources"
        StateFile="$(MSBuildThisFileDirectory)Resources.cache" UseSourcePath="true" />
  </Target>
</Project>
'@ | Set-Content (Join-Path $testDirectory "Resources.proj")

    @'
<root>
  <data name="Message"><value>Hello from nanoFramework</value></data>
  <data name="WindowsPath" type="System.Resources.ResXFileRef, System.Windows.Forms">
    <value>Resources\linked file.bin;System.Byte[], mscorlib</value>
  </data>
  <data name="UnixPath" type="System.Resources.ResXFileRef, System.Windows.Forms">
    <value>Resources/linked file.bin;System.Byte[], mscorlib</value>
  </data>
  <data name="QuotedText" type="System.Resources.ResXFileRef, System.Windows.Forms">
    <value>"Resources\text;file.txt";System.String, mscorlib;utf-8</value>
  </data>
</root>
'@ | Set-Content (Join-Path $testDirectory "Resources.resx")

    $linkedFile = Join-Path $testDirectory "Resources/linked file.bin"
    [IO.File]::WriteAllBytes($linkedFile, [byte[]](1, 2, 3, 4))
    Set-Content (Join-Path $testDirectory "Resources/text;file.txt") "Linked text"
    Invoke-ResourceBuild
    $output = Join-Path $testDirectory "Resources.nanoresources"
    $initialBytes = [IO.File]::ReadAllBytes($output)
    if ($initialBytes.Length -eq 0) {
        throw "Resource generation produced an empty file."
    }

    $initialWriteTime = [IO.File]::GetLastWriteTimeUtc($output)
    Invoke-ResourceBuild
    if ([IO.File]::GetLastWriteTimeUtc($output) -ne $initialWriteTime) {
        throw "An unchanged linked resource caused an unnecessary rebuild."
    }

    [IO.File]::WriteAllBytes($linkedFile, [byte[]](5, 6, 7, 8))
    [IO.File]::SetLastWriteTimeUtc($linkedFile, $initialWriteTime.AddSeconds(2))
    Invoke-ResourceBuild
    $updatedBytes = [IO.File]::ReadAllBytes($output)
    if ([Convert]::ToBase64String($initialBytes) -eq [Convert]::ToBase64String($updatedBytes)) {
        throw "Changing a linked resource did not update the generated resource."
    }

    Remove-Item $linkedFile
    $failureOutput = & dotnet msbuild (Join-Path $testDirectory "Resources.proj") `
        -nologo -verbosity:minimal "-p:SdkPath=$SdkPath" 2>&1 | Out-String
    if ($LASTEXITCODE -eq 0 -or $failureOutput -notmatch "Cannot read linked resource file") {
        throw "A missing linked resource did not produce the expected build error: $failureOutput"
    }

    $overridePath = & dotnet msbuild (Join-Path $testDirectory "Resources.proj") `
        -nologo "-p:SdkPath=$SdkPath" -p:NF_MSBUILDTASK_PATH=custom -getProperty:NF_MSBUILDTASK_PATH
    if ($LASTEXITCODE -ne 0 -or "$overridePath".Trim() -ne "custom") {
        throw "The bundled targets did not preserve an explicit task path override."
    }
    Write-Host "Resource generation regression tests passed."
} finally {
    Remove-Item $testDirectory -Recurse -Force
}
