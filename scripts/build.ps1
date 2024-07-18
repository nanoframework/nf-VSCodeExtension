# only need these modules if not running on Azure Pipeline
if (-Not $env:TF_BUILD) {
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

## Setup nanoFrameworkSDK
$extName = "VS2022ext"
$vsExtensionVersion = "v2022.3.0.86"

"Downloading VS2022 Extension..." | Write-Host

Invoke-WebRequest -Uri "https://github.com/nanoframework/nf-Visual-Studio-extension/releases/download/$vsExtensionVersion/nanoFramework.Tools.VS2022.Extension.vsix" -Out "$extName.zip"
Expand-Archive "$extName.zip" -Force

Get-ChildItem '$MSBuild' -Directory -Recurse | ForEach-Object { 
    $SDKPath = Join-Path -Path $PSItem.FullName -ChildPath "nanoFramework"
    $DestinationPath = Join-Path -Path "$outputDirectory/utils" -ChildPath "nanoframework"
    Copy-Item -Path $SDKPath -Destination $DestinationPath -Recurse -Force
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

# Copy the packages.config file
Copy-Item (Join-Path $PSScriptRoot packages.config) (Join-Path $outputDirectory utils) -Force
