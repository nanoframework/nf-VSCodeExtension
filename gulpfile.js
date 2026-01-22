const gulp = require("gulp");

const download = require("download");
const extract = require("extract-zip");
const fs = require("fs");
const path = require("path");
const { exec } = require("child_process");
// The serial-monitor-cli task has been removed.
// Serial port enumeration now uses the 'serialport' npm package directly,
// which provides native cross-platform support for Windows, macOS (including Apple Silicon), and Linux.
// This eliminates the dependency on the archived microsoft/serial-monitor-cli project.

gulp.task("build", async (done) => {
    // No additional build tasks needed - serialport is an npm dependency
    console.log("Build task completed. Serial port support provided by 'serialport' npm package.");
    done();
});

gulp.task("build-debug-bridge", async (done) => {
    const bridgeProjectDir = path.resolve("src", "debugger", "bridge", "dotnet", "nanoFramework.Tools.DebugBridge");
    const outputDir = path.resolve("bin", "nanoDebugBridge");
    
    // Build for the current platform (framework-dependent)
    const promiseExec = require("util").promisify(exec);
    
    try {
        const { stdout, stderr } = await promiseExec(`dotnet publish -c Release -o "${outputDir}"`, { cwd: bridgeProjectDir });
        if (stdout) console.log(stdout);
        console.log("Debug bridge built successfully to:", outputDir);
        done();
    } catch (err) {
        console.error("Error building debug bridge:", err.message);
        done(err);
    }
});

gulp.task("build", gulp.series("insert-serial-monitor-cli", "build-debug-bridge"));
