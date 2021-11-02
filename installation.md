## Prerequisites 

- node (> v12)
- npm 
- .NET 5.0
- .NET 4.7.2 on Windows, mono-complete on Linux/macOS
- Powershell core (`pwsh`) for Linux/macOS

>* if you're running into a langversion:9 error, try installing the latest mono-nightly

## Install steps

- Clone repository and `cd` into it
- Run `npm install`
- Run `pwsh scripts/build.ps1` or `./scripts/build.ps1` in Powershell on Windows
- Open in Visual Studio Code (`code .`)
- Press <kbd>F5</kbd> to debug.
