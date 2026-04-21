#!/usr/bin/env pwsh
<#
.SYNOPSIS
    Build script for .NET nanoFramework VS Code Extension
.DESCRIPTION
    Downloads VS2022 Extension components and sets up the nanoFramework SDK.
    Supports Windows, macOS, and Linux platforms.
.PARAMETER Clean
    Clean the output directory before building
#>

param(
    [switch]$Clean
)

$ErrorActionPreference = "Stop"

# Detect operating system
$script:IsWindowsOS = ($PSVersionTable.PSEdition -eq 'Desktop') -or $IsWindows

# Check PowerShell version on non-Windows platforms
if (-not $script:IsWindowsOS -and $PSVersionTable.PSVersion.Major -lt 7) {
    Write-Error "PowerShell 7 or higher is required on macOS/Linux. Current version: $($PSVersionTable.PSVersion)"
    Write-Host "Install PowerShell 7: https://aka.ms/install-powershell" -ForegroundColor Yellow
    exit 1
}

## Defining variables
$outputDirectory = "dist"
$extName = "VS2022ext"
$vsExtensionVersion = "v2022.14.1.5"
$zipFile = "$extName.zip"

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

    ## Setup nanoFrameworkSDK
    Write-Host "Downloading VS2022 Extension ($vsExtensionVersion)..." -ForegroundColor Green

    $downloadUrl = "https://github.com/nanoframework/nf-Visual-Studio-extension/releases/download/$vsExtensionVersion/nanoFramework.Tools.VS2022.Extension.vsix"
    Invoke-WebRequest -Uri $downloadUrl -OutFile $zipFile

    Write-Host "Extracting VS2022 Extension..." -ForegroundColor Cyan
    Expand-Archive $zipFile -DestinationPath $extName -Force

    # Copy nanoFramework SDK
    Write-Host "Copying nanoFramework SDK..." -ForegroundColor Cyan
    Get-ChildItem -Path $extName -Filter '$MSBuild' -Directory -Recurse -ErrorAction SilentlyContinue | ForEach-Object { 
        $SDKPath = Join-Path -Path $_.FullName -ChildPath "nanoFramework"
        $DestinationPath = Join-Path -Path "$outputDirectory/utils" -ChildPath "nanoFramework"
        if (Test-Path $SDKPath) {
            Copy-Item -Path $SDKPath -Destination $DestinationPath -Recurse -Force
        }
    }

    ## Copy the templates
    Write-Host "Copying project templates..." -ForegroundColor Cyan
    $templates = @('CS.BlankApplication-vs2022', 'CS.ClassLibrary-vs2022', 'CS.TestApplication-vs2022')
    foreach ($template in $templates) {
        Get-ChildItem -Path $extName -Filter $template -Directory -Recurse -ErrorAction SilentlyContinue | ForEach-Object { 
            Copy-Item -Path $_.FullName -Destination "$outputDirectory/utils" -Recurse -Force
        }
    }

    # Copy the packages.config file
    $packagesConfig = Join-Path $PSScriptRoot "packages.config"
    if (Test-Path $packagesConfig) {
        Copy-Item $packagesConfig $utilsDir -Force
    }

    ## Setup v2 MDP (generics support) from NuGet
    Write-Host "Downloading v2 MDP (MetadataProcessor 4.0.0-preview) from NuGet..." -ForegroundColor Green
    $mdpV2Version = "4.0.0-preview.73"
    $mdpV2Package = "nanoframework.tools.metadataprocessor.msbuildtask"
    $mdpV2Zip = "mdp-v2.zip"
    $mdpV2ExtractDir = "mdp-v2"

    $mdpV2Url = "https://api.nuget.org/v3-flatcontainer/$mdpV2Package/$mdpV2Version/$mdpV2Package.$mdpV2Version.nupkg"
    Invoke-WebRequest -Uri $mdpV2Url -OutFile $mdpV2Zip

    Write-Host "Extracting v2 MDP..." -ForegroundColor Cyan
    if (Test-Path $mdpV2ExtractDir) { Remove-Item $mdpV2ExtractDir -Recurse -Force }
    Expand-Archive $mdpV2Zip -DestinationPath $mdpV2ExtractDir -Force

    # Create v2.0 directory by copying v1.0 structure (targets, props, Rules, BuildTasks)
    $v1SdkPath = Join-Path "$outputDirectory/utils/nanoFramework" "v1.0"
    $v2SdkPath = Join-Path "$outputDirectory/utils/nanoFramework" "v2.0"
    if (Test-Path $v1SdkPath) {
        Write-Host "Creating v2.0 SDK from v1.0 base + v2 MDP binaries..." -ForegroundColor Cyan
        Copy-Item -Path $v1SdkPath -Destination $v2SdkPath -Recurse -Force

        # Replace DLLs with v2 versions from NuGet package (net472 target)
        $mdpV2LibDir = Join-Path $mdpV2ExtractDir "lib/net472"
        if (Test-Path $mdpV2LibDir) {
            Get-ChildItem -Path $mdpV2LibDir -Filter "*.dll" | ForEach-Object {
                Copy-Item -Path $_.FullName -Destination $v2SdkPath -Force
                Write-Host "  Replaced: $($_.Name)" -ForegroundColor DarkGray
            }
        }
    }

    # Clean up v2 MDP temp files
    if (Test-Path $mdpV2Zip) { Remove-Item $mdpV2Zip -Force -ErrorAction SilentlyContinue }
    if (Test-Path $mdpV2ExtractDir) { Remove-Item $mdpV2ExtractDir -Recurse -Force -ErrorAction SilentlyContinue }

    Write-Host "Build completed successfully!" -ForegroundColor Green

} catch {
    Write-Error "Build failed: $_"
    exit 1
} finally {
    # Clean up downloaded artifacts
    Write-Host "Cleaning up temporary files..." -ForegroundColor Cyan
    if (Test-Path $zipFile) {
        Remove-Item $zipFile -Force -ErrorAction SilentlyContinue
    }
    if (Test-Path $extName) {
        Remove-Item $extName -Recurse -Force -ErrorAction SilentlyContinue
    }
}
