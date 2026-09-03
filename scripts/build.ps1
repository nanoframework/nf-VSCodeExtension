#!/usr/bin/env pwsh
<#
.SYNOPSIS
    Build script for .NET nanoFramework VS Code Extension
.DESCRIPTION
    Downloads stable and Preview VS2022 Extension components and sets up both nanoFramework SDK families.
    Supports Windows, macOS, and Linux platforms.
.PARAMETER Clean
    Clean the output directory before building
#>

param(
    [switch]$Clean
)

$ErrorActionPreference = "Stop"
Add-Type -AssemblyName System.IO.Compression.FileSystem

# Detect operating system
$script:IsWindowsOS = ($PSVersionTable.PSEdition -eq 'Desktop') -or $IsWindows

if ($PSVersionTable.PSEdition -eq 'Desktop') {
    [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
}

function Invoke-Download {
    param(
        [Parameter(Mandatory = $true)][string]$Uri,
        [Parameter(Mandatory = $true)][string]$OutFile
    )

    $OutFile = [IO.Path]::GetFullPath($OutFile)

    try {
        Invoke-WebRequest -UseBasicParsing -Uri $Uri -OutFile $OutFile
    } catch {
        $curl = Get-Command curl.exe, curl -CommandType Application -ErrorAction SilentlyContinue |
            Select-Object -First 1
        if (-not $curl) {
            throw
        }
        & $curl.Source --fail --silent --show-error --location $Uri --output $OutFile
        if ($LASTEXITCODE -eq 0) {
            return
        }

        $wsl = Get-Command wsl.exe -ErrorAction SilentlyContinue
        if ($script:IsWindowsOS -and $wsl -and $OutFile -match '^([A-Za-z]):[\\/](.*)$') {
            $wslOutFile = "/mnt/$($Matches[1].ToLower())/$($Matches[2].Replace('\', '/'))"
            & $wsl.Source -- curl --fail --silent --show-error --location $Uri --output $wslOutFile
            if ($LASTEXITCODE -eq 0) {
                return
            }
        }

        throw "Unable to download $Uri with PowerShell or curl."
    }
}

# Check PowerShell version on non-Windows platforms
if (-not $script:IsWindowsOS -and $PSVersionTable.PSVersion.Major -lt 7) {
    Write-Error "PowerShell 7 or higher is required on macOS/Linux. Current version: $($PSVersionTable.PSVersion)"
    Write-Host "Install PowerShell 7: https://aka.ms/install-powershell" -ForegroundColor Yellow
    exit 1
}

## Defining variables
$outputDirectory = "dist"
$vsExtensions = @(
    @{
        Family = "v1"
        Version = "v2022.14.1.13"
        Url = "https://github.com/nanoframework/nf-Visual-Studio-extension/releases/download/v2022.14.1.13/nanoFramework.Tools.VS2022.Extension.vsix"
        Sha256 = "BCF3A56399A2244B1C7DA39BBECCD6648887FD7C88CA64A3D291F1C8E10C5B2B"
        SdkVersion = "v1.0"
    },
    @{
        Family = "v2"
        Version = "v2022.14.2.29"
        Url = "https://www.vsixgallery.com/extensions/bf694e17-fa5f-4877-9317-6d3664b2689a/.NET%20nanoFramework%20Extension%20v2022.14.2.29.vsix"
        Sha256 = "B27755A5C9311EE54CB145C54A84ED299AD80BD29EFB3C7858054B5687068EF1"
        SdkVersion = "v2.0"
    }
)
$templates = @('CS.BlankApplication-vs2022', 'CS.ClassLibrary-vs2022', 'CS.TestApplication-vs2022')
$previewMetadataTask = @{
    Version = "4.0.0-preview.101"
    Sha256 = "3DE4B40135D7FA13C11C74AA97C4D08439C63080588C8F338924D3F94EAF4B53"
}
$previewMetadataTask.Url = "https://api.nuget.org/v3-flatcontainer/nanoframework.tools.metadataprocessor.msbuildtask/$($previewMetadataTask.Version)/nanoframework.tools.metadataprocessor.msbuildtask.$($previewMetadataTask.Version).nupkg"

# Clean if requested
if ($Clean -and (Test-Path $outputDirectory)) {
    Write-Host "Cleaning output directory..." -ForegroundColor Yellow
    Remove-Item -Path $outputDirectory -Recurse -Force
}

# Ensure output directory exists
if (-not (Test-Path $outputDirectory)) {
    New-Item -ItemType Directory -Path $outputDirectory -Force | Out-Null
}

# Ensure utils directory exists
$utilsDir = Join-Path $outputDirectory "utils"
if (-not (Test-Path $utilsDir)) {
    New-Item -ItemType Directory -Path $utilsDir -Force | Out-Null
}

foreach ($legacyTemplate in $templates) {
    Remove-Item (Join-Path $utilsDir $legacyTemplate) -Recurse -Force -ErrorAction SilentlyContinue
}
Remove-Item (Join-Path $utilsDir "packages.config") -Force -ErrorAction SilentlyContinue

try {
    # Windows-specific module setup (only needed for local development, not on Azure Pipelines)
    if ($script:IsWindowsOS -and -Not $env:TF_BUILD) {
        Write-Host "Installing VSSetup PS1 module..." -ForegroundColor Cyan
        Install-Module VSSetup -Scope CurrentUser -Force -AllowClobber

        Write-Host "Installing BuildUtils PS1 module..." -ForegroundColor Cyan
        Install-Module BuildUtils -Scope CurrentUser -Force -AllowClobber

        # Get location for msbuild and setup alias
        $msbuildLocation = Get-LatestMsbuildLocation
        Set-Alias msbuild $msbuildLocation 
    }

    foreach ($extension in $vsExtensions) {
        $archivePath = Join-Path $outputDirectory "$($extension.Family)-templates.zip"
        $extractPath = Join-Path $outputDirectory "$($extension.Family)-extension"
        $templateDestination = Join-Path $utilsDir "projectTemplates/$($extension.Family)"
        $sdkDestination = Join-Path $utilsDir "nanoFramework/$($extension.SdkVersion)"

        Remove-Item $templateDestination -Recurse -Force -ErrorAction SilentlyContinue
        Remove-Item $sdkDestination -Recurse -Force -ErrorAction SilentlyContinue

        Write-Host "Downloading $($extension.Family) VS2022 Extension ($($extension.Version))..." -ForegroundColor Green
        Invoke-Download -Uri $extension.Url -OutFile $archivePath

        $actualHash = (Get-FileHash $archivePath -Algorithm SHA256).Hash
        if ($actualHash -ne $extension.Sha256) {
            throw "SHA-256 mismatch for $($extension.Family) VS2022 Extension. Expected $($extension.Sha256), got $actualHash."
        }

        Write-Host "Extracting $($extension.Family) VS2022 Extension..." -ForegroundColor Cyan
        Expand-Archive $archivePath -DestinationPath $extractPath -Force

        $sdkSource = Get-ChildItem -Path $extractPath -Filter '$MSBuild' -Directory -Recurse |
            ForEach-Object { Join-Path $_.FullName "nanoFramework/v1.0" } |
            Where-Object { Test-Path $_ } |
            Select-Object -First 1
        if (-not $sdkSource) {
            throw "The $($extension.Family) VS2022 Extension does not contain the nanoFramework SDK."
        }
        New-Item -ItemType Directory -Path $sdkDestination -Force | Out-Null
        Copy-Item -Path "$sdkSource/*" -Destination $sdkDestination -Recurse -Force

        if ($extension.Family -eq "v2") {
            $metadataPackagePath = Join-Path $outputDirectory "metadata-processor-task.zip"
            $metadataExtractPath = Join-Path $outputDirectory "metadata-processor-task"
            Invoke-Download -Uri $previewMetadataTask.Url -OutFile $metadataPackagePath

            $actualHash = (Get-FileHash $metadataPackagePath -Algorithm SHA256).Hash
            if ($actualHash -ne $previewMetadataTask.Sha256) {
                throw "SHA-256 mismatch for MetadataProcessor task. Expected $($previewMetadataTask.Sha256), got $actualHash."
            }

            Expand-Archive $metadataPackagePath -DestinationPath $metadataExtractPath -Force
            $metadataDestination = Join-Path $sdkDestination "mdp/net8.0"
            New-Item -ItemType Directory -Path $metadataDestination -Force | Out-Null
            Copy-Item -Path (Join-Path $metadataExtractPath "lib/net8.0/*") -Destination $metadataDestination -Force
        }

        New-Item -ItemType Directory -Path $templateDestination -Force | Out-Null
        foreach ($template in $templates) {
            $templateSource = Get-ChildItem -Path $extractPath -Filter $template -Directory -Recurse |
                Select-Object -First 1
            if (-not $templateSource) {
                throw "The $($extension.Family) VS2022 Extension does not contain $template."
            }
            Copy-Item -Path $templateSource.FullName -Destination $templateDestination -Recurse -Force
        }

        $testPackage = Get-ChildItem (Join-Path $extractPath "Packages") -Filter "nanoFramework.TestFramework.*.nupkg" |
            Select-Object -First 1
        if (-not $testPackage) {
            throw "The $($extension.Family) VS2022 Extension does not contain nanoFramework.TestFramework."
        }
        $packageArchive = [System.IO.Compression.ZipFile]::OpenRead($testPackage.FullName)
        try {
            $runSettingsEntry = $packageArchive.Entries | Where-Object { $_.FullName -eq "content/nano.runsettings" } | Select-Object -First 1
            if (-not $runSettingsEntry) {
                throw "The $($extension.Family) TestFramework package does not contain nano.runsettings."
            }
            $runSettingsPath = Join-Path $templateDestination "CS.TestApplication-vs2022/nano.runsettings"
            [System.IO.Compression.ZipFileExtensions]::ExtractToFile($runSettingsEntry, $runSettingsPath, $true)
        } finally {
            $packageArchive.Dispose()
        }
    }

    Write-Host "Build completed successfully!" -ForegroundColor Green

} catch {
    Write-Error "Build failed: $_"
    exit 1
} finally {
    # Clean up downloaded artifacts
    Write-Host "Cleaning up temporary files..." -ForegroundColor Cyan
    foreach ($extension in $vsExtensions) {
        Remove-Item (Join-Path $outputDirectory "$($extension.Family)-templates.zip") -Force -ErrorAction SilentlyContinue
        Remove-Item (Join-Path $outputDirectory "$($extension.Family)-extension") -Recurse -Force -ErrorAction SilentlyContinue
    }
    Remove-Item (Join-Path $outputDirectory "metadata-processor-task.zip") -Force -ErrorAction SilentlyContinue
    Remove-Item (Join-Path $outputDirectory "metadata-processor-task") -Recurse -Force -ErrorAction SilentlyContinue
}
