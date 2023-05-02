function BuildDotnet ($solution, $dotnetBuild, $outputDirectory)
{
    Write-Host "Building $solution..."

    # create folder
    $outFolder = (New-Item -Name "$outputDirectory/utils/$solution" -ItemType Directory -Force).ToString()

    # unpack in folder
    Get-ChildItem "$solution.sln" -Recurse | ForEach-Object { 
        nuget restore $PSItem.FullName -UseLockFile
        
        if ($dotnetBuild)
        {
            Write-Host "Building with dotnet"
            dotnet build $PSItem.FullName -o $outFolder
        }
        else
        {
            Write-Host "Building with msbuild"
            msbuild $PSItem.FullName /p:OutDir=$outFolder
        }
    }
}

# check if this is running on Azure Pipeline
$IsAzurePipelines = $env:Agent_HomeDirectory + $env:Build_BuildNumber

# only need these modules if not running on Azure Pipeline
if(-Not $env:TF_BUILD)
{
    "Installing VSSetup PS1 module" | Write-Host
    Install-Module VSSetup -Scope CurrentUser -Force
    "Installing BuildUtils PS1 module" | Write-Host
    Install-Module BuildUtils -Scope CurrentUser -Force

    # get location for msbuild and setup alias
    $msbuildLocation = Get-LatestMsbuildLocation
    set-alias msbuild $msbuildLocation 
}

## Defining variables
$outputDirectory = "dist"

## Setup nanoFirmwareFlasher
$solution = "nanoFirmwareFlasher"

# skip build if running on Azure Pipeline
if(-Not $env:TF_BUILD)
{
    "Setup build for $solution" | Write-Host
    BuildDotnet $solution $true $outputDirectory
}

## Setup nanoFrameworkDeployer
$solution = "nanoFrameworkDeployer"

# skip build if running on Azure Pipeline
if(-Not $env:TF_BUILD)
{
    "Setup build for $solution" | Write-Host
    BuildDotnet $solution $false $outputDirectory
}

## Setup nanoFrameworkSDK
$extName = "VS2022ext"
$vsExtensionVersion = "v2022.2.0.19"

"Downloading VS2022 Extension..." | Write-Host

Invoke-WebRequest -Uri "https://github.com/nanoframework/nf-Visual-Studio-extension/releases/download/$vsExtensionVersion/nanoFramework.Tools.VS2022.Extension.vsix" -Out "$extName.zip"
Expand-Archive "$extName.zip" -Force

Get-ChildItem '$MSBuild' -Directory -Recurse | ForEach-Object { 
    $SDKPath = Join-Path -Path $PSItem.FullName -ChildPath "nanoFramework"
    Copy-Item -Path $SDKPath -Destination "$outputDirectory/utils/" -Recurse -Force
}

## move the templates

Get-ChildItem 'CS.BlankApplication-vs2022' -Directory -Recurse | ForEach-Object { 
    Copy-Item -Path $PSItem.FullName -Destination "$outputDirectory/utils" -Recurse -Force
}

Get-ChildItem 'CS.ClassLibrary-vs2022' -Directory -Recurse | ForEach-Object { 
    Copy-Item -Path $PSItem.FullName -Destination "$outputDirectory/utils" -Recurse -Force
}

Get-ChildItem 'CS.TestApplication-vs2022' -Directory -Recurse | ForEach-Object { 
    Copy-Item -Path $PSItem.FullName -Destination "$outputDirectory/utils" -Recurse -Force
}

# Clean nanoFramework SDK resources
Remove-Item "$extName.zip"
Remove-Item $extName -Recurse -Force

## Setup nuget
$nugetFolder = (New-Item -Name "$outputDirectory/utils/nuget" -ItemType Directory -Force).ToString()

"Downloading nuget CLI..." | Write-Host

Invoke-WebRequest -Uri "https://dist.nuget.org/win-x86-commandline/latest/nuget.exe" -Out "$nugetFolder/nuget.exe"

if ((-Not $env:TF_BUILD) -And ($IsMacOS -Or $IsLinux))
{
    Write-Output "Adding executable rights to utils folder on Unix"
    chmod -R +x ./$outputDirectory/utils/
}
