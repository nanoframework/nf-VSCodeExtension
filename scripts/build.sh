#!/bin/bash
# Build script wrapper for macOS and Linux
# This script checks for PowerShell and runs the build.ps1 script

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# Check for PowerShell
if ! command -v pwsh &> /dev/null; then
    echo "Error: PowerShell (pwsh) is not installed."
    echo ""
    echo "Install PowerShell using one of the following methods:"
    echo ""
    echo "  macOS (Homebrew):"
    echo "    brew install --cask powershell"
    echo ""
    echo "  macOS (.NET Global Tool):"
    echo "    dotnet tool install --global PowerShell"
    echo ""
    echo "  Ubuntu/Debian:"
    echo "    wget -q https://packages.microsoft.com/config/ubuntu/\$(lsb_release -rs)/packages-microsoft-prod.deb"
    echo "    sudo dpkg -i packages-microsoft-prod.deb"
    echo "    sudo apt-get update && sudo apt-get install -y powershell"
    echo ""
    echo "  Snap (Universal Linux):"
    echo "    sudo snap install powershell --classic"
    echo ""
    echo "  For more options, visit: https://aka.ms/install-powershell"
    exit 1
fi

# Check PowerShell version
PWSH_VERSION=$(pwsh -Command '$PSVersionTable.PSVersion.Major')
if [ "$PWSH_VERSION" -lt 7 ]; then
    echo "Error: PowerShell 7 or higher is required. Current version: $PWSH_VERSION"
    echo "Please upgrade PowerShell: https://aka.ms/install-powershell"
    exit 1
fi

# Run the PowerShell build script
echo "Running build script with PowerShell..."
pwsh "$SCRIPT_DIR/build.ps1" "$@"
