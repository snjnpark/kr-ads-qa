import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join, relative, resolve } from "node:path";

const root = resolve(".next");
const required = JSON.parse(readFileSync(join(root, "required-server-files.json"), "utf8"));
if (required.config.distDir !== ".next" || required.config.env?.NEXT_PUBLIC_LAYA_TEST_MODE !== "0" || required.config.env?.NEXT_PUBLIC_LAYA_LOCAL_SWITCH !== "0") throw new Error("Production flags are not frozen to production.");
function* files(directory) {
  for (const item of readdirSync(directory, { withFileTypes: true })) {
    const file = join(directory, item.name);
    if (item.isDirectory()) yield* files(file); else yield file;
  }
}
const forbiddenPath = /(?:^|\/)(?:testing|tests-ts|tests-integration|e2e|benchmarks|docs|data|output|config)(?:\/|$)|node_modules\/(?:@playwright|onnxruntime-node|@napi-rs|@receptron)(?:\/|$)|src\/server\/(?:api|application|ai|storage|credentials|rules|laya-bundle|model-release|condition-classifier)\.(?:ts|js)$/;
const forbiddenCode = /synthetic-local-test|deterministic-browser-test-v1|laya-ads-qa-browser-testing|mockDatasetIndex|class MockAI|node:sqlite|@napi-rs\/keyring|onnxruntime-node/;
let chunks = 0, traces = 0;
for (const file of files(root)) {
  if (file.endsWith(".nft.json")) {
    traces++;
    for (const dependency of JSON.parse(readFileSync(file, "utf8")).files) {
      const normalized = relative(process.cwd(), resolve(file, "..", dependency)).replaceAll("\\", "/");
      if (forbiddenPath.test(normalized)) throw new Error(`Development/server-state dependency in production trace: ${normalized}`);
    }
  }
  if (file.includes(join(root, "static")) && file.endsWith(".js")) {
    chunks++;
    if (forbiddenCode.test(readFileSync(file, "utf8"))) throw new Error(`Test/native code in browser bundle: ${file}`);
  }
}
if (!chunks || !traces) throw new Error("Missing production bundles or dependency traces.");
for (const file of ["ort-wasm-simd-threaded.mjs", "ort-wasm-simd-threaded.wasm"]) if (!existsSync(resolve("public/onnxruntime", file))) throw new Error("Missing same-origin browser runtime.");
console.log(`Production boundary verified: ${chunks} browser chunks, ${traces} dependency traces; no development data/native runtime.`);
