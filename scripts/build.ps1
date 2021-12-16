function DownloadArtifact ($project, $repo, $fileName) 
{
    Write-Host "Downloading Artifact $repo..."

    $url = "https://github.com/$project/$repo/archive/refs/tags/$fileName"
    Write-Host $url;

    Invoke-WebRequest -Uri $url -Out $fileName

    Write-Host Extracting release files

    Expand-Archive $fileName $repo -Force
}

function BuildDotnet ($repo, $fileName, $dotnetBuild, $outputDirectory)
{
    Write-Host "Building $repo..."

    # create folder
    $outFolder = (New-Item -Name "$outputDirectory/utils/$repo" -ItemType Directory -Force).ToString()

    # unpack in folder
    Get-ChildItem "$repo.sln" -Recurse | ForEach-Object { 
        nuget restore $PSItem.FullName
        
        if ($dotnetBuild)
        {
            Write-Host "Build with dotnet"
            dotnet build $PSItem.FullName -o $outFolder
        }
        else
        {
            Write-Host "Build with msbuild"
            msbuild $PSItem.FullName /p:OutDir=$outFolder
        }
    }

    #cleanup
    Remove-Item "$fileName.zip"
    Remove-Item $repo -Recurse -Force
}

# check if this is running on Azure Pipeline
$IsAzurePipelines = $env:Agent_HomeDirectory -and $env:Build_BuildNumber

## Defining variables
$outputDirectory = "dist" # dist for publishing, out for development

## Setup nanoFirmwareFlasher
$project = "nanoframework"
$repo = "nanoFirmwareFlasher"
$nanoFlasherVersion = "v2.0.3"

DownloadArtifact $project $repo "$nanoFlasherVersion.zip"

# skip build if running on Azure Pipeline
if($IsAzurePipelines -eq $null)
{
    BuildDotnet $repo $nanoFlasherVersion $true $outputDirectory
}

## Setup nanoFrameworkDeployer
$project = "nanoframework"
$repo = "nanoFrameworkDeployer"
$nanoFrameworkDeployerVersion = "v1.1.1"

DownloadArtifact $project $repo "$nanoFrameworkDeployerVersion.zip"

# skip build if running on Azure Pipeline
if($IsAzurePipelines -eq $null)
{
    BuildDotnet $repo $nanoFrameworkDeployerVersion $false $outputDirectory
}

## Setup nanoFrameworkSDK
$extName = "VS2019ext"
$version = "v2019.10.0.2"
Invoke-WebRequest -Uri "https://github.com/nanoframework/nf-Visual-Studio-extension/releases/download/$version/nanoFramework.Tools.VS2019.Extension.vsix" -Out "$extName.zip"
Expand-Archive "$extName.zip" -Force

Get-ChildItem '$MSBuild' -Directory -Recurse | ForEach-Object { 
    $SDKPath = Join-Path -Path $PSItem.FullName -ChildPath "nanoFramework"
    Copy-Item -Path $SDKPath -Destination "$outputDirectory/utils/" -Recurse -Force
}

# Clean nanoFramework SDK resources
Remove-Item "$extName.zip"
Remove-Item $extName -Recurse -Force

## Setup nuget
$nugetFolder = (New-Item -Name "$outputDirectory/utils/nuget" -ItemType Directory -Force).ToString()
Invoke-WebRequest -Uri "https://dist.nuget.org/win-x86-commandline/latest/nuget.exe" -Out "$nugetFolder/nuget.exe"

if ($IsMacOS -or $IsLinux)
{
    Write-Output "Adding executable rights to utils folder on Unix"
    chmod -R +x ./$outputDirectory/utils/
}
