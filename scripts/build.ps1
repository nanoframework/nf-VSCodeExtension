function DownloadArtifact ($project, $repo, $fileName) 
{
    Write-Host "Downloading Artifact..."

    $url = "https://github.com/$project/$repo/archive/refs/tags/$fileName";
    Write-Host $url;

    Invoke-WebRequest -Uri $url -Out $fileName

    Write-Host Extracting release files

    Expand-Archive $fileName -Force
}

function BuildDotnet ($repo, $fileName, $dotnet5)
{
    # create folder
    $outFolder = (New-Item -Name "out/utils/$repo" -ItemType Directory -Force).ToString();

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

## Setup nanoFirmwareFlasher
$project = "nanoframework"
$repo = "nanoFirmwareFlasher"
$fileName = "v1.29.1"

DownloadArtifact $project $repo "$fileName.zip"
BuildDotnet $repo $fileName $true

## Setup nanoFrameworkDeployer
$project = "nanoframework"
$repo = "nanoFrameworkDeployer"
$fileName = "v1.0.14"

DownloadArtifact $project $repo "$fileName.zip"
BuildDotnet $repo $fileName $false

## Setup nanoFrameworkSDK
$extName = "VS2019ext"
Invoke-WebRequest -Uri "https://github.com/nanoframework/nf-Visual-Studio-extension/releases/download/v2019.8.0.1/nanoFramework.Tools.VS2019.Extension.vsix" -Out "$extName.zip"
Expand-Archive "$extName.zip" -Force

Get-ChildItem '$MSBuild' -Directory -Recurse | ForEach-Object { 
    $SDKPath = Join-Path -Path $PSItem.FullName -ChildPath "nanoFramework"
    Copy-Item -Path $SDKPath -Destination "out/utils/" -Recurse -Force
}

# Clean nanoFramework SDK resources
Remove-Item "$extName.zip"
Remove-Item $extName -Recurse -Force

## Setup nuget
$nugetFolder = (New-Item -Name "out/utils/nuget" -ItemType Directory -Force).ToString();
Invoke-WebRequest -Uri "https://dist.nuget.org/win-x86-commandline/latest/nuget.exe" -Out "$nugetFolder/nuget.exe"

if ($IsMacOS -or $IsLinux) {
    Write-Output "Adding executable rights to utils folder on Unix"
    chmod -R +x ./out/utils/
}
