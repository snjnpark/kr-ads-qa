import { createHash, randomUUID } from "node:crypto";
import { createWriteStream } from "node:fs";
import {
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import path from "node:path";
import defaultModel from "./default-model.json";
import { fileHash, verifyCandidateBundle } from "./laya-bundle";

export type ModelRelease = {
  candidate_id: string;
  files: Record<string, { url: string; sha256: string; size_bytes: number }>;
};
export class ModelReleaseError extends Error {}
const allowedFiles = [
  "candidate-manifest.json",
  "laya.onnx",
  "laya_config.json",
  "tokenizer/tokenizer.json",
  "tokenizer/tokenizer_config.json",
];
const optionalFiles = ["condition-head.onnx"];
const weights = ["model.onnx.data", "laya.onnx.data"];
const sha256 = /^[a-f0-9]{64}$/;
function httpsUrl(value: string) {
  const url = new URL(value);
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.hash ||
    url.search
  )
    throw new Error(
      "Model assets require public HTTPS URLs without credentials/query strings.",
    );
  return url;
}
export function validateRelease(value: unknown): ModelRelease {
  if (!value || typeof value !== "object")
    throw new Error("Invalid model release.");
  const release = value as ModelRelease;
  if (
    typeof release.candidate_id !== "string" ||
    !/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,79}$/.test(release.candidate_id) ||
    !release.files ||
    typeof release.files !== "object" ||
    Array.isArray(release.files)
  )
    throw new Error("Invalid release identity or files.");
  const names = Object.keys(release.files);
  if (
    names.length !== allowedFiles.length + 1 + names.filter(name => optionalFiles.includes(name)).length ||
    allowedFiles.some((name) => !names.includes(name)) ||
    names.filter((name) => weights.includes(name)).length !== 1
  )
    throw new Error("Unexpected model release artifact inventory.");
  for (const [name, file] of Object.entries(release.files)) {
    if (
      ![...allowedFiles, ...weights, ...optionalFiles].includes(name) ||
      !file ||
      typeof file.url !== "string" ||
      !sha256.test(file.sha256) ||
      !Number.isSafeInteger(file.size_bytes) ||
      file.size_bytes <= 0
    )
      throw new Error("Invalid model release artifact.");
    httpsUrl(file.url);
  }
  return release;
}
export function configuredRelease(): ModelRelease | null {
  if (defaultModel.schema_version !== 1)
    throw new ModelReleaseError("배포 모델 설정 버전을 확인해 주세요.");
  return defaultModel.release === null
    ? null
    : validateRelease(defaultModel.release);
}
export function releaseDirectory(
  release: ModelRelease,
  cacheRoot = "data/models/releases",
) {
  return path.resolve(
    cacheRoot,
    `${release.candidate_id}-${release.files["candidate-manifest.json"]!.sha256.slice(0, 16)}`,
  );
}
export function defaultReleaseSelection(
  options: {
    mock?: boolean;
    agent?: unknown;
    modelKind?: string;
    candidateId?: string;
  },
  release?: ModelRelease | null,
) {
  if (options.mock || options.agent || options.modelKind || options.candidateId)
    return null;
  return release === undefined
    ? configuredRelease()
    : release && validateRelease(release);
}

export async function verifyModelRelease(
  release: ModelRelease,
  directory = releaseDirectory(release),
) {
  validateRelease(release);
  for (const [name, file] of Object.entries(release.files)) {
    const filename = path.join(directory, name);
    if (
      (await stat(filename)).size !== file.size_bytes ||
      (await fileHash(filename)) !== file.sha256
    )
      throw new ModelReleaseError(
        "배포 모델 파일 검증에 실패했습니다. 모델 폴더를 확인해 주세요.",
      );
  }
  return verifyCandidateBundle(directory, release.candidate_id);
}
const downloads = new Map<string, Promise<string>>();
async function fetchAsset(url: string, fetcher: typeof fetch) {
  let current = new URL(url);
  for (let redirects = 0; redirects <= 5; redirects++) {
    if (current.protocol !== "https:" || current.username || current.password)
      throw new Error(
        "Model download redirects must use HTTPS without credentials.",
      );
    const response = await fetcher(current.href, {
      redirect: "manual",
      signal: AbortSignal.timeout(30 * 60_000),
      credentials: "omit",
      headers: { "Accept-Encoding": "identity" },
    });
    if (![301, 302, 303, 307, 308].includes(response.status)) return response;
    const location = response.headers.get("location");
    await response.body?.cancel();
    if (!location) throw new Error("Model redirect location is missing.");
    current = new URL(location, current);
  }
  throw new Error("Too many model download redirects.");
}
export async function ensureModelRelease(
  release: ModelRelease,
  options: { cacheRoot?: string; fetch?: typeof fetch } = {},
): Promise<string> {
  validateRelease(release);
  const destination = releaseDirectory(release, options.cacheRoot);
  if (downloads.has(destination)) return downloads.get(destination)!;
  const operation = (async () => {
    if (
      await stat(destination).catch((error: NodeJS.ErrnoException) => {
        if (error.code !== "ENOENT") throw error;
        return null;
      })
    ) {
      await verifyModelRelease(release, destination);
      return destination;
    }
    const cacheRoot = path.dirname(destination);
    await mkdir(cacheRoot, { recursive: true });
    const stage = await mkdtemp(path.join(cacheRoot, ".download-"));
    if (
      path.dirname(path.resolve(stage)) !== path.resolve(cacheRoot) ||
      !path.basename(stage).startsWith(".download-")
    )
      throw new Error("Unsafe model staging path.");
    try {
      for (const [name, file] of Object.entries(release.files)) {
        const response = await fetchAsset(file.url, options.fetch ?? fetch);
        if (response.status !== 200 || !response.body) {
          await response.body?.cancel();
          throw new Error(`Download failed: ${name}`);
        }
        const length = response.headers.get("content-length");
        if (length !== null && Number(length) !== file.size_bytes) {
          await response.body.cancel();
          throw new Error(`Download size differs: ${name}`);
        }
        const filename = path.join(stage, name);
        await mkdir(path.dirname(filename), { recursive: true });
        const hash = createHash("sha256");
        let size = 0;
        await pipeline(
          Readable.fromWeb(
            response.body as import("node:stream/web").ReadableStream,
          ),
          new Transform({
            transform(chunk: Buffer, _encoding, callback) {
              size += chunk.length;
              if (size > file.size_bytes) {
                callback(new Error(`Download exceeds declared size: ${name}`));
                return;
              }
              hash.update(chunk);
              callback(null, chunk);
            },
          }),
          createWriteStream(filename, { flags: "wx" }),
        );
        if (size !== file.size_bytes || hash.digest("hex") !== file.sha256)
          throw new Error(`Download integrity differs: ${name}`);
      }
      await verifyModelRelease(release, stage);
      try {
        await rename(stage, destination);
      } catch (error) {
        if (!(await stat(destination).catch(() => null))) throw error;
        await verifyModelRelease(release, destination);
      }
      return destination;
    } catch (error) {
      throw new ModelReleaseError(
        `파인튜닝 모델을 준비하지 못했습니다. 네트워크와 배포 파일을 확인해 주세요. (${error instanceof Error ? error.message : "download failed"})`,
      );
    } finally {
      await rm(stage, { recursive: true, force: true });
    }
  })();
  downloads.set(destination, operation);
  try {
    return await operation;
  } finally {
    downloads.delete(destination);
  }
}

export async function prepareModelRelease(options: {
  sourceDirectory: string;
  outputDirectory: string;
  baseUrl: string;
}) {
  const base = httpsUrl(
    options.baseUrl.endsWith("/") ? options.baseUrl : options.baseUrl + "/",
  );
  const manifest = await verifyCandidateBundle(options.sourceDirectory);
  const files: ModelRelease["files"] = {};
  const assets = [
    ...Object.keys(manifest.artifacts),
    "candidate-manifest.json",
  ];
  for (const name of assets) {
    const filename = path.join(options.sourceDirectory, name);
    files[name] = {
      url: new URL(name.replaceAll("/", "--"), base).href,
      sha256: await fileHash(filename),
      size_bytes: (await stat(filename)).size,
    };
  }
  const release = validateRelease({
    candidate_id: manifest.candidate_id,
    files,
  });
  await mkdir(path.dirname(path.resolve(options.outputDirectory)), {
    recursive: true,
  });
  await mkdir(options.outputDirectory);
  for (const name of assets) {
    const destination = path.join(
      options.outputDirectory,
      name.replaceAll("/", "--"),
    );
    await copyFile(path.join(options.sourceDirectory, name), destination);
    if ((await fileHash(destination)) !== files[name]!.sha256)
      throw new Error(`Release source changed during preparation: ${name}`);
  }
  await writeFile(
    path.join(options.outputDirectory, "release.json"),
    JSON.stringify({ schema_version: 1, release }, null, 2) + "\n",
    { flag: "wx" },
  );
  return release;
}
export async function readReleaseFile(filename: string) {
  const config = JSON.parse(await readFile(filename, "utf8"));
  if (config.schema_version !== 1)
    throw new Error("Invalid model release config version.");
  return validateRelease(config.release);
}
export async function setDefaultRelease(
  filename: string,
  release: ModelRelease,
) {
  validateRelease(release);
  // The selected release is bundled at build time; runtime never follows a mutable latest URL.
  const temporary = path.join(
    path.dirname(filename),
    `.model-release-${randomUUID()}.json`,
  );
  try {
    await writeFile(
      temporary,
      JSON.stringify({ schema_version: 1, release }, null, 2) + "\n",
      { flag: "wx" },
    );
    await rename(temporary, filename);
  } finally {
    await rm(temporary, { force: true });
  }
}

// Publication accepts only the committed default, never an arbitrary candidate directory.
export async function finalReleaseAssets(directory: string, selected: ModelRelease) {
  const release = await readReleaseFile(path.join(directory, "release.json"));
  if (JSON.stringify(release) !== JSON.stringify(validateRelease(selected)))
    throw new Error("Only the selected final model can be published.");
  const first = new URL(Object.values(release.files)[0]!.url);
  const match = first.pathname.match(/^\/([^/]+\/[^/]+)\/releases\/download\/([^/]+)\/[^/]+$/);
  if (first.hostname !== "github.com" || !match)
    throw new Error("Publication requires GitHub Release asset URLs.");
  const [, repository, tag] = match;
  const files = Object.keys(release.files).map(name => name.replaceAll("/", "--"));
  const inventory = [...files, "release.json"].sort();
  if (JSON.stringify((await readdir(directory)).sort()) !== JSON.stringify(inventory))
    throw new Error("Release directory contains missing or unexpected files.");
  for (const [name, file] of Object.entries(release.files)) {
    const asset = name.replaceAll("/", "--");
    if (file.url !== `https://github.com/${repository}/releases/download/${tag}/${asset}`)
      throw new Error("Release asset URLs must use one repository and tag.");
    const filename = path.join(directory, asset);
    if ((await stat(filename)).size !== file.size_bytes || await fileHash(filename) !== file.sha256)
      throw new Error(`Release integrity differs: ${name}`);
  }
  return { repository: repository!, tag: tag!, assets: inventory.map(name => path.resolve(directory, name)) };
}
