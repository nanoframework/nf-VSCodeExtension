const gulp = require("gulp");

const download = require("download");
const extract = require("extract-zip");
const fs = require("fs");
const path = require("path");

gulp.task("insert-serial-monitor-cli", async (done) => {
    const platforms = [
        "linux",
        "darwin",
        "win32",
    ];
    // This is the last know working version of serial-monitor-cli
    // The repository is archived and no longer maintained
    const release = "v0.0.7";
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

gulp.task("build", gulp.series("insert-serial-monitor-cli"));

