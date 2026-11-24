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

function Assert-ResourceBuildFailure {
    param([string]$ExpectedError)

    $failureOutput = & dotnet msbuild (Join-Path $testDirectory "Resources.proj") `
        -nologo -verbosity:minimal "-p:SdkPath=$SdkPath" 2>&1 | Out-String
    if ($LASTEXITCODE -eq 0 -or $failureOutput -notmatch $ExpectedError) {
        throw "Expected a resource build error matching '$ExpectedError': $failureOutput"
    }
}

function Read-NanoResources {
    param([string]$Path)

    $reader = [IO.BinaryReader]::new([IO.File]::OpenRead($Path))
    try {
        $magic = $reader.ReadUInt32()
        $version = $reader.ReadUInt32()
        if ($magic.ToString("X8") -ne "F995B0A8" -or $version -ne 2) {
            throw "Invalid nanoresources header: magic=$magic, version=$version."
        }
        $headerSize = $reader.ReadUInt32()
        $resourceHeaderSize = $reader.ReadUInt32()
        $count = $reader.ReadUInt32()
        $reader.BaseStream.Position = $headerSize
        $headers = for ($index = 0; $index -lt $count; $index++) {
            $id = $reader.ReadInt16()
            $kind = $reader.ReadByte()
            $reader.ReadByte() | Out-Null
            @{ Id = [int]$id; Kind = $kind; Size = $reader.ReadUInt32() }
        }
        $reader.BaseStream.Position = $headerSize + $resourceHeaderSize * $count
        $resources = @{}
        foreach ($header in $headers) {
            $resources[$header.Id] = @{ Kind = $header.Kind; Data = $reader.ReadBytes($header.Size) }
        }
        return $resources
    } finally {
        $reader.Dispose()
    }
}

function Assert-ResourceData {
    param([hashtable]$Resources, [int]$Id, [byte]$Kind, [byte[]]$Expected)

    $resource = $Resources[$Id]
    if (-not $resource -or $resource.Kind -ne $Kind -or
        [Convert]::ToBase64String($resource.Data) -ne [Convert]::ToBase64String($Expected)) {
        throw "Resource $Id did not have the expected type and binary payload."
    }
}

try {
    $taskDirectory = Join-Path $SdkPath "buildTasks/net8.0"
    $dependencies = Get-Content (Join-Path $taskDirectory "nanoFramework.Tools.BuildTasks.deps.json") -Raw
    if ($dependencies -match "SixLabors" -or (Get-ChildItem $taskDirectory -Filter "SixLabors*")) {
        throw "The bundled build tasks still depend on SixLabors."
    }

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
  <data name="Bitmap;10" type="System.Resources.ResXFileRef, System.Windows.Forms">
    <value>Resources\pixels.bmp;System.Byte[], mscorlib</value>
  </data>
  <data name="TopDownBitmap;11" type="System.Resources.ResXFileRef, System.Windows.Forms">
    <value>Resources\top-down.bmp;System.Byte[], mscorlib</value>
  </data>
  <data name="Gif;12" type="System.Resources.ResXFileRef, System.Windows.Forms">
    <value>Resources\pixel.gif;System.Byte[], mscorlib</value>
  </data>
  <data name="Jpeg;13" type="System.Resources.ResXFileRef, System.Windows.Forms">
    <value>Resources\pixel.jpg;System.Byte[], mscorlib</value>
  </data>
  <data name="Png;14" type="System.Resources.ResXFileRef, System.Windows.Forms">
    <value>Resources\unsupported.png;System.Byte[], mscorlib</value>
  </data>
</root>
'@ | Set-Content (Join-Path $testDirectory "Resources.resx")

    # Odd-width rows exercise BMP padding and bottom-up versus top-down storage.
    $bmp = New-Object byte[] 78
    $bmp[0] = 0x42; $bmp[1] = 0x4D
    [BitConverter]::GetBytes([int]78).CopyTo($bmp, 2)
    [BitConverter]::GetBytes([int]54).CopyTo($bmp, 10)
    [BitConverter]::GetBytes([int]40).CopyTo($bmp, 14)
    [BitConverter]::GetBytes([int]3).CopyTo($bmp, 18)
    [BitConverter]::GetBytes([int]2).CopyTo($bmp, 22)
    $bmp[26] = 1; $bmp[28] = 24
    ([byte[]](255, 255, 255, 0, 0, 0, 128, 128, 128, 0, 0, 0,
              0, 0, 255, 0, 255, 0, 255, 0, 0, 0, 0, 0)).CopyTo($bmp, 54)
    [IO.File]::WriteAllBytes((Join-Path $testDirectory "Resources/pixels.bmp"), $bmp)
    $topDownBmp = [byte[]]$bmp.Clone()
    [BitConverter]::GetBytes([int]-2).CopyTo($topDownBmp, 22)
    [Buffer]::BlockCopy($bmp, 66, $topDownBmp, 54, 12)
    [Buffer]::BlockCopy($bmp, 54, $topDownBmp, 66, 12)
    [IO.File]::WriteAllBytes((Join-Path $testDirectory "Resources/top-down.bmp"), $topDownBmp)
    $gif = [Convert]::FromBase64String("R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7")
    $jpeg = [Convert]::FromBase64String(@'
/9j/4AAQSkZJRgABAQAASABIAAD/4QBMRXhpZgAATU0AKgAAAAgAAYdpAAQAAAABAAAAGgAAAAAAA6ABAAMAAAABAAEAAKACAAQAAAABAAAAAaADAAQAAAABAAAAAQAAAAD/7QA4UGhvdG9zaG9wIDMuMAA4QklNBAQAAAAAAAA4QklNBCUAAAAAABDUHYzZjwCyBOmACZjs+EJ+/8AAEQgAAQABAwEiAAIRAQMRAf/EAB8AAAEFAQEBAQEBAAAAAAAAAAABAgMEBQYHCAkKC//EALUQAAIBAwMCBAMFBQQEAAABfQECAwAEEQUSITFBBhNRYQcicRQygZGhCCNCscEVUtHwJDNicoIJChYXGBkaJSYnKCkqNDU2Nzg5OkNERUZHSElKU1RVVldYWVpjZGVmZ2hpanN0dXZ3eHl6g4SFhoeIiYqSk5SVlpeYmZqio6Slpqeoqaqys7S1tre4ubrCw8TFxsfIycrS09TV1tfY2drh4uPk5ebn6Onq8fLz9PX29/j5+v/EAB8BAAMBAQEBAQEBAQEAAAAAAAABAgMEBQYHCAkKC//EALURAAIBAgQEAwQHBQQEAAECdwABAgMRBAUhMQYSQVEHYXETIjKBCBRCkaGxwQkjM1LwFWJy0QoWJDThJfEXGBkaJicoKSo1Njc4OTpDREVGR0hJSlNUVVZXWFlaY2RlZmdoaWpzdHV2d3h5eoKDhIWGh4iJipKTlJWWl5iZmqKjpKWmp6ipqrKztLW2t7i5usLDxMXGx8jJytLT1NXW19jZ2uLj5OXm5+jp6vLz9PX29/j5+v/bAEMAExMTExMTIBMTIC0gICAtPS0tLS09TT09PT09TV1NTU1NTU1dXV1dXV1dXXBwcHBwcIODg4ODk5OTk5OTk5OTk//bAEMBFxgYJSMlQCMjQJloVWiZmZmZmZmZmZmZmZmZmZmZmZmZmZmZmZmZmZmZmZmZmZmZmZmZmZmZmZmZmZmZmZmZmf/dAAQAAf/aAAwDAQACEQMRAD8AyaKKK4D6w//Z
'@)
    $png = [byte[]](0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A)
    [IO.File]::WriteAllBytes((Join-Path $testDirectory "Resources/pixel.gif"), $gif)
    [IO.File]::WriteAllBytes((Join-Path $testDirectory "Resources/pixel.jpg"), $jpeg)
    [IO.File]::WriteAllBytes((Join-Path $testDirectory "Resources/unsupported.png"), $png)

    $linkedFile = Join-Path $testDirectory "Resources/linked file.bin"
    [IO.File]::WriteAllBytes($linkedFile, [byte[]](1, 2, 3, 4))
    Set-Content (Join-Path $testDirectory "Resources/text;file.txt") "Linked text"
    Invoke-ResourceBuild
    $output = Join-Path $testDirectory "Resources.nanoresources"
    $initialBytes = [IO.File]::ReadAllBytes($output)
    if ($initialBytes.Length -eq 0) {
        throw "Resource generation produced an empty file."
    }
    $resources = Read-NanoResources $output
    $bitmapPayload = [byte[]](3, 0, 0, 0, 2, 0, 0, 0, 0, 0, 16, 0,
        0, 0xF8, 0xE0, 7, 0x1F, 0, 0xFF, 0xFF, 0, 0, 0x10, 0x84)
    Assert-ResourceData $resources 10 1 $bitmapPayload
    Assert-ResourceData $resources 11 1 $bitmapPayload
    Assert-ResourceData $resources 12 1 ([byte[]](1, 0, 0, 0, 1, 0, 0, 0, 0, 0, 1, 1) + $gif)
    Assert-ResourceData $resources 13 1 ([byte[]](1, 0, 0, 0, 1, 0, 0, 0, 0, 0, 1, 2) + $jpeg)
    Assert-ResourceData $resources 14 4 $png

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

    $bitmapPath = Join-Path $testDirectory "Resources/pixels.bmp"
    $oversizedBmp = [byte[]]$bmp.Clone()
    [BitConverter]::GetBytes([int]65536).CopyTo($oversizedBmp, 18)
    [IO.File]::WriteAllBytes($bitmapPath, $oversizedBmp)
    Assert-ResourceBuildFailure "bitmap dimensions out of range"
    [IO.File]::WriteAllBytes($bitmapPath, [byte[]](0x42, 0x4D))
    Assert-ResourceBuildFailure "Cannot read bitmap dimensions"
    [IO.File]::WriteAllBytes($bitmapPath, $bmp)

    Remove-Item $linkedFile
    Assert-ResourceBuildFailure "Cannot read linked resource file"

    $overridePath = & dotnet msbuild (Join-Path $testDirectory "Resources.proj") `
        -nologo "-p:SdkPath=$SdkPath" -p:NF_MSBUILDTASK_PATH=custom -getProperty:NF_MSBUILDTASK_PATH
    if ($LASTEXITCODE -ne 0 -or "$overridePath".Trim() -ne "custom") {
        throw "The bundled targets did not preserve an explicit task path override."
    }
    Write-Host "Resource generation regression tests passed."
} finally {
    Remove-Item $testDirectory -Recurse -Force
}
