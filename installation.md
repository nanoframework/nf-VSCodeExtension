## Prerequisites 

- node (> v12)
- npm 
- mono-complete* (Linux/macOS only)
- powershell core

>* if you're running into a langversion:9 error, try installing the latest mono-nightly

## Install steps

Install VS Code extension and gulp globally:
- Clone repository and `cd` into it
- Run `npm install`
- Run `pwsh scripts/build.ps1`
- Open in Visual Studio Code (`code .`)
- Press <kbd>F5</kbd> to debug.
