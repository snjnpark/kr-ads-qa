import { spawn } from "node:child_process";
import { createRequire } from "node:module";

const [command, ...args] = process.argv.slice(2);
if (!["dev", "build", "start"].includes(command)) throw new Error("Expected dev, build or start.");
// Public commands cannot select the ignored local fixture factory via inherited env.
process.env.LAYA_BUILD_TARGET = "production";
process.env.NEXT_PUBLIC_LAYA_TEST_MODE = "0";
process.env.NEXT_PUBLIC_LAYA_LOCAL_SWITCH = "0";
if (command !== "start") await import("./prepare-runtime.mjs");
const require = createRequire(import.meta.url);
const child = spawn(process.execPath, [require.resolve("next/dist/bin/next"), command, ...args], { stdio: "inherit", env: process.env });
for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => child.kill(signal));
const code = await new Promise((resolve, reject) => { child.once("error", reject); child.once("exit", code => resolve(code ?? 1)); });
if (code === 0 && command === "build") await import("./verify-build.mjs");
process.exitCode = code;
