const gulp = require("gulp");

const extract = require("extract-zip");
const fs = require("fs");
const path = require("path");
const { exec } = require("child_process");

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

gulp.task("build", async (done) => {
    // No additional build tasks needed - serialport is an npm dependency
    console.log("Build task completed. Serial port support provided by 'serialport' npm package.");
    done();
});
