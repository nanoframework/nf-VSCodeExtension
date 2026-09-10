const fs = require("fs");
const os = require("os");
const path = require("path");
const vsce = require("@vscode/vsce");

const platforms = [
    { target: "win32-x64", bridges: ["win32-x64", "linux-x64"] },
    { target: "win32-arm64", bridges: ["win32-arm64", "linux-arm64"] },
    { target: "linux-x64", bridges: ["linux-x64"] },
    { target: "linux-arm64", bridges: ["linux-arm64"] },
    { target: "darwin-x64", bridges: ["darwin-x64"] },
    { target: "darwin-arm64", bridges: ["darwin-arm64"] }
];

const bridgeFolders = platforms.map(platform => platform.target);
const baseIgnore = fs.readFileSync(path.resolve(".vscodeignore"), "utf8");

async function packagePlatforms() {
    const tempDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "nf-vscode-package-"));

    try {
        for (const platform of platforms) {
            const excludedBridges = bridgeFolders.filter(folder => !platform.bridges.includes(folder));
            const ignoreFile = path.join(tempDirectory, `${platform.target}.vscodeignore`);
            const exclusions = excludedBridges
                .map(folder => `bin/nanoDebugBridge/${folder}/**`)
                .join("\n");

            fs.writeFileSync(ignoreFile, `${baseIgnore}\n${exclusions}\n`);

            await vsce.createVSIX({
                target: platform.target,
                packagePath: path.resolve(`vscode-nanoframework-${platform.target}.vsix`),
                ignoreFile,
                githubBranch: "develop",
                allowStarActivation: true
            });
        }
    } finally {
        fs.rmSync(tempDirectory, { recursive: true, force: true });
    }
}

packagePlatforms().catch(error => {
    console.error(error);
    process.exitCode = 1;
});
