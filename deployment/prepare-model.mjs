import { createHash, randomUUID } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { link, lstat, mkdir, readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { pathToFileURL } from "node:url";

const candidate = "laya-lora-r4-colab-v1";
const downloadBase = "https://github.com/snjnpark/kr-ads-qa/releases/download/model-lora-colab-v1/";
const upstreamBase = "https://huggingface.co/convaiinnovations/laya/resolve/7b928d828b7b0e022f929d9bd2e44165aa270148/multilingual/";
const applicationFiles = ["lora.onnx", "adapter-heads.bin", "condition-head.onnx", "laya_config.json"];
const upstreamFiles = ["upstream.safetensors", "tokenizer/tokenizer.json", "tokenizer/tokenizer_config.json"];

function validateManifest(manifest) {
  const release = manifest?.release;
  if (manifest?.schema_version !== 2 || release?.kind !== "laya-lora-separated" || release.candidate_id !== candidate) throw new Error("Unexpected separated-model release.");
  const files = release.files;
  if (!files || Object.keys(files).sort().join("\n") !== [...applicationFiles, ...upstreamFiles].sort().join("\n")) throw new Error("Unexpected model file list.");
  for (const [name, spec] of Object.entries(files)) {
    if (!/^[a-f0-9]{64}$/.test(spec.sha256) || !Number.isSafeInteger(spec.size_bytes) || spec.size_bytes < 1) throw new Error(`Invalid model integrity metadata: ${name}`);
    if (applicationFiles.includes(name)) {
      if (spec.source !== "application" || spec.url !== `/models/${candidate}/${name}` || spec.download_url !== `${downloadBase}${name}` || spec.size_bytes > 100_000_000) throw new Error(`Unexpected application model asset: ${name}`);
    } else if (spec.source !== "upstream" || spec.url !== `${upstreamBase}${name === "upstream.safetensors" ? "model.safetensors" : name}`) throw new Error(`Unexpected upstream model asset: ${name}`);
  }
  return files;
}

async function verifyExisting(file, spec) {
  let info;
  try { info = await lstat(file); } catch (error) { if (error.code === "ENOENT") return false; throw error; }
  if (!info.isFile() || info.isSymbolicLink() || info.size !== spec.size_bytes) throw new Error(`Existing model asset differs: ${file}. Preserved; investigate before replacing it.`);
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  if (hash.digest("hex") !== spec.sha256) throw new Error(`Existing model asset differs: ${file}. Preserved; investigate before replacing it.`);
  return true;
}

async function downloadVerified(spec, temp, fetchImpl, timeoutMs) {
  const signal = AbortSignal.timeout(timeoutMs);
  const response = await fetchImpl(spec.download_url, { signal, redirect: "follow", credentials: "omit", cache: "no-store" });
  if (!response.ok || !response.body) {
    await response.body?.cancel();
    throw new Error(`Model asset download returned HTTP ${response.status}.`);
  }
  const final = new URL(response.url || spec.download_url);
  if (final.protocol !== "https:" || !(final.hostname === "github.com" || final.hostname.endsWith(".githubusercontent.com"))) {
    await response.body.cancel();
    throw new Error("Unexpected model asset redirect.");
  }
  const contentLength = response.headers.get("content-length");
  if (contentLength !== null && (!/^\d+$/.test(contentLength) || Number(contentLength) !== spec.size_bytes)) {
    await response.body.cancel();
    throw new Error("Model asset Content-Length differs from the release.");
  }
  let size = 0;
  const hash = createHash("sha256");
  const integrity = new Transform({
    transform(chunk, _encoding, callback) {
      size += chunk.length;
      if (size > spec.size_bytes) return callback(new Error("Model asset exceeds its pinned size."));
      hash.update(chunk);
      callback(null, chunk);
    },
  });
  await pipeline(Readable.fromWeb(response.body), integrity, createWriteStream(temp, { flags: "wx" }), { signal });
  if (size !== spec.size_bytes || hash.digest("hex") !== spec.sha256) throw new Error("Downloaded model asset size or SHA-256 differs from the release.");
}

// These are public model artifacts only. Upstream weights/tokenizers never pass
// through the build host; browsers fetch those directly from their pinned source.
export async function prepareModelAssets({ projectRoot = process.cwd(), releaseManifest, fetchImpl = globalThis.fetch, attemptLimit = 3, timeoutMs = 300_000, retryDelayMs = 500, logger = console.log } = {}) {
  if (!Number.isInteger(attemptLimit) || attemptLimit < 1 || attemptLimit > 3 || !Number.isFinite(timeoutMs) || timeoutMs < 1 || timeoutMs > 300_000 || !Number.isFinite(retryDelayMs) || retryDelayMs < 0 || retryDelayMs > 1000) throw new Error("Invalid model download limits.");
  const root = resolve(projectRoot);
  const manifest = releaseManifest ?? JSON.parse(await readFile(join(root, "src/browser/model/release.json"), "utf8"));
  const files = validateManifest(manifest);
  const destination = join(root, "public/models", candidate);
  const staging = join(root, ".laya-model-downloads");
  await mkdir(destination, { recursive: true });
  let downloaded = 0, reused = 0;
  for (const name of applicationFiles) {
    const spec = files[name], output = join(destination, name);
    if (await verifyExisting(output, spec)) { reused++; continue; }
    await mkdir(staging, { recursive: true });
    let lastError;
    for (let attempt = 1; attempt <= attemptLimit; attempt++) {
      const temp = join(staging, `${name}-${randomUUID()}.part`);
      try {
        await downloadVerified(spec, temp, fetchImpl, timeoutMs);
        // link publishes a complete verified file atomically and fails if a
        // concurrent process installed a target. It never replaces local files.
        try { await link(temp, output); }
        catch (error) { if (error.code !== "EEXIST" || !await verifyExisting(output, spec)) throw error; }
        downloaded++;
        lastError = undefined;
        break;
      } catch (error) {
        lastError = error;
        if (attempt < attemptLimit) await new Promise(resolveDelay => setTimeout(resolveDelay, retryDelayMs * attempt));
      }
    }
    if (lastError) throw new Error(`Could not prepare ${name} after ${attemptLimit} attempt(s); existing files and download attempts were preserved.`, { cause: lastError });
  }
  logger(`Prepared separated model assets: ${downloaded} downloaded, ${reused} verified/reused; upstream model stays browser-direct.`);
  return { downloaded, reused, files: applicationFiles.map(name => ({ name, ...files[name] })) };
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) await prepareModelAssets();
