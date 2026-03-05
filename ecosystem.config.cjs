module.exports = {
    apps: [
        {
            name: "nl",
            script: "bun",
            args: "run --dns-result-order=ipv4first src/index.ts",
            interpreter: "none",
            cwd: ".",
        },
    ],
};