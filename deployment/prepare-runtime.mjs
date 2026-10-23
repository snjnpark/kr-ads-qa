import { createRequire } from "node:module";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

const require = createRequire(import.meta.url);
const runtime = dirname(dirname(require.resolve("onnxruntime-web/wasm")));
const manifest = JSON.parse(readFileSync(join(runtime, "package.json"), "utf8"));
if (manifest.version !== "1.30.0") throw new Error("Unexpected ONNX runtime version.");
const target = resolve("public/onnxruntime");
mkdirSync(target, { recursive: true });
const digest = bytes => createHash("sha256").update(bytes).digest("hex");
for (const name of ["ort-wasm-simd-threaded.mjs", "ort-wasm-simd-threaded.wasm"]) {
  const bytes = readFileSync(join(runtime, "dist", name)), output = join(target, name);
  if (existsSync(output)) {
    if (digest(readFileSync(output)) !== digest(bytes)) throw new Error(`Existing runtime differs: ${output}. Preserve it and investigate before replacing it.`);
  } else writeFileSync(output, bytes, { flag: "wx" });
}
console.log("Prepared pinned browser ONNX runtime on this origin.");
