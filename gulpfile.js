const gulp = require("gulp");

const extract = require("extract-zip");
const fs = require("fs");
const path = require("path");
const { exec } = require("child_process");

gulp.task("build-debug-bridge", async (done) => {
    const bridgeProjectDir = path.resolve("src", "debugger", "bridge", "dotnet", "nanoFramework.Tools.DebugBridge");
    const baseOutputDir = path.resolve("bin", "nanoDebugBridge");
    const promiseExec = require("util").promisify(exec);

    fs.rmSync(baseOutputDir, { recursive: true, force: true });

    try {
        const { stdout } = await promiseExec(
            `dotnet publish -c Release --self-contained false -o "${baseOutputDir}"`,
            { cwd: bridgeProjectDir }
        );
        if (stdout) console.log(stdout);
    } catch (err) {
        console.error("Error building debug bridge:", err.message);
        done(err);
        return;
    }

    console.log("Portable debug bridge built successfully");
    done();
});

gulp.task("build", gulp.series("build-debug-bridge", async (done) => {
    console.log("Build task completed. Debug bridge and serial port support ready.");
    done();
}));
