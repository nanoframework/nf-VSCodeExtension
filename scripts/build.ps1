function DownloadArtifact ($project, $repo, $fileName) 
{
    Write-Host "Downloading Artifact..."

    $url = "https://github.com/$project/$repo/archive/refs/tags/$fileName";
    Write-Host $url;

    Invoke-WebRequest -Uri $url -Out $fileName

    Write-Host Extracting release files

    Expand-Archive $fileName -Force
}

function BuildDotnet ($repo, $fileName, $dotnet5, $outputDirectory)
{
    # create folder
    $outFolder = (New-Item -Name "$outputDirectory/utils/$repo" -ItemType Directory -Force).ToString();

    # unpack in folder
    Get-ChildItem "$repo.sln" -Recurse | ForEach-Object { 
        nuget restore $PSItem.FullName ;
        
        if ($dotnet5) {
            Write-Host "Using dotnet build";
            dotnet build $PSItem.FullName -o $outFolder
        }
        else {
            Write-Host "Using msbuild"
            msbuild $PSItem.FullName /p:OutDir=$outFolder; 
        }
    }

    #cleanup
    Remove-Item "$fileName.zip"
    Remove-Item $fileName -Recurse -Force
}

## Defining variables
$outputDirectory = "dist" # dist for publishing, out for development

## Setup nanoFirmwareFlasher
$project = "nanoframework"
$repo = "nanoFirmwareFlasher"
$nanoFlasherVersion = "v2.0.3"

DownloadArtifact $project $repo "$nanoFlasherVersion.zip"
BuildDotnet $repo $nanoFlasherVersion $true $outputDirectory

## Setup nanoFrameworkDeployer
$project = "nanoframework"
$repo = "nanoFrameworkDeployer"
$nanoFrameworkDeployerVersion = "v1.0.19"

DownloadArtifact $project $repo "$nanoFrameworkDeployerVersion.zip"
BuildDotnet $repo $nanoFrameworkDeployerVersion $false $outputDirectory

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
$nugetFolder = (New-Item -Name "$outputDirectory/utils/nuget" -ItemType Directory -Force).ToString();
Invoke-WebRequest -Uri "https://dist.nuget.org/win-x86-commandline/latest/nuget.exe" -Out "$nugetFolder/nuget.exe"

if ($IsMacOS -or $IsLinux) {
    Write-Output "Adding executable rights to utils folder on Unix"
    chmod -R +x ./$outputDirectory/utils/
}
