const gulp = require("gulp");

const extract = require("extract-zip");
const fs = require("fs");
const path = require("path");
const { exec } = require("child_process");

gulp.task("build-debug-bridge", async (done) => {
    const bridgeRoot = path.resolve("src", "debugger", "bridge", "dotnet");
    const baseOutputDir = path.resolve("bin", "nanoDebugBridge");
    const promiseExec = require("util").promisify(exec);
    const bridges = [
        { family: "v1", project: "nanoFramework.Tools.DebugBridge.V1" },
        { family: "v2", project: "nanoFramework.Tools.DebugBridge" }
    ];

    fs.rmSync(baseOutputDir, { recursive: true, force: true });

    try {
        for (const bridge of bridges) {
            const projectDir = path.join(bridgeRoot, bridge.project);
            const outputDir = path.join(baseOutputDir, bridge.family);
            const { stdout } = await promiseExec(
                `dotnet publish -c Release --self-contained false -o "${outputDir}"`,
                { cwd: projectDir }
            );
            if (stdout) console.log(stdout);
        }
    } catch (err) {
        console.error("Error building debug bridges:", err.message);
        done(err);
        return;
    }

    console.log("Portable v1 and v2 debug bridges built successfully");
    done();
});

gulp.task("build", gulp.series("build-debug-bridge", async (done) => {
    console.log("Build task completed. Debug bridge and serial port support ready.");
    done();
}));
