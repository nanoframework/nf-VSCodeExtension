const gulp = require("gulp");

const extract = require("extract-zip");
const fs = require("fs");
const path = require("path");
const { exec } = require("child_process");

gulp.task("build-debug-bridge", async (done) => {
    const bridgeProjectDir = path.resolve("src", "debugger", "bridge", "dotnet", "nanoFramework.Tools.DebugBridge");
    const baseOutputDir = path.resolve("bin", "nanoDebugBridge");
    const promiseExec = require("util").promisify(exec);
    
    // Target platforms: Windows x64/arm64, macOS x64/arm64, Linux x64/arm64
    const platforms = [
        { rid: "win-x64", folder: "win32-x64" },
        { rid: "win-arm64", folder: "win32-arm64" },
        { rid: "linux-x64", folder: "linux-x64" },
        { rid: "linux-arm64", folder: "linux-arm64" },
        { rid: "osx-x64", folder: "darwin-x64" },
        { rid: "osx-arm64", folder: "darwin-arm64" }
    ];
    
    for (const platform of platforms) {
        const outputDir = path.join(baseOutputDir, platform.folder);
        console.log(`Building debug bridge for ${platform.rid}...`);
        
        try {
            const { stdout, stderr } = await promiseExec(
                `dotnet publish -c Release -r ${platform.rid} --self-contained true -o "${outputDir}"`,
                { cwd: bridgeProjectDir }
            );
            if (stdout) console.log(stdout);
            console.log(`Debug bridge built successfully for ${platform.rid}`);
        } catch (err) {
            console.error(`Error building debug bridge for ${platform.rid}:`, err.message);
            done(err);
            return;
        }
    }
    
    // Set executable permissions on Unix binaries
    // Use both chmod (when on Unix) and git update-index (for CI/CD on Windows)
    const unixPlatforms = ['linux-x64', 'darwin-x64', 'darwin-arm64'];
    
    for (const folder of unixPlatforms) {
        const execPath = path.join(baseOutputDir, folder, 'nanoFramework.Tools.DebugBridge');
        const relativePath = path.relative(process.cwd(), execPath).replace(/\\/g, '/');
        
        // Try chmod first (works on Unix systems)
        if (process.platform !== 'win32') {
            const { chmod } = require('fs').promises;
            try {
                await chmod(execPath, 0o755);
                console.log(`Set executable permission on ${execPath}`);
            } catch (e) {
                console.log(`Note: Could not chmod ${execPath}: ${e.message}`);
            }
        }
        
        // Use git update-index to mark as executable (works on any platform, persists in git)
        try {
            await promiseExec(`git update-index --chmod=+x "${relativePath}"`);
            console.log(`Marked ${relativePath} as executable in git`);
        } catch (e) {
            // Not a git repo or git not available - that's fine
            console.log(`Note: Could not update git index for ${relativePath} (${e.message})`);
        }
    }
    
    console.log("Debug bridge built for all platforms");
    done();
});

gulp.task("build", gulp.series("build-debug-bridge", async (done) => {
    console.log("Build task completed. Debug bridge and serial port support ready.");
    done();
}));
