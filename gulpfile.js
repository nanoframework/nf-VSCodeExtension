const gulp = require("gulp");

const download = require("download");
const extract = require("extract-zip");
const fs = require("fs");
const path = require("path");
const { exec } = require("child_process");

gulp.task("insert-serial-monitor-cli", async (done) => {
    const platforms = [
        "linux",
        "darwin",
        "win32",
    ];
    const release = "latest";
    const destDir = path.resolve("dist", "utils", "serial-monitor-cli");

    async function downloadAndUnzip(platform) {
        const fileName = `${platform}.zip`;
        const zipPath = path.join(destDir, fileName);
        await download(`https://github.com/microsoft/serial-monitor-cli/releases/${release}/download/${fileName}`,
                       destDir,
                       );
        await extract(zipPath, { dir: path.join(destDir, platform) });
        fs.rmSync(zipPath);
    }

    Promise.all(platforms.map(downloadAndUnzip)).then(done);
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
