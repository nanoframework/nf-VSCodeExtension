const gulp = require("gulp");

// The serial-monitor-cli task has been removed.
// Serial port enumeration now uses the 'serialport' npm package directly,
// which provides native cross-platform support for Windows, macOS (including Apple Silicon), and Linux.
// This eliminates the dependency on the archived microsoft/serial-monitor-cli project.

gulp.task("build", async (done) => {
    // No additional build tasks needed - serialport is an npm dependency
    console.log("Build task completed. Serial port support provided by 'serialport' npm package.");
    done();
});
