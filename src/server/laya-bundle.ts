import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import {
  copyFile,
  mkdir,
  readFile,
  writeFile,
  link,
  realpath,
  stat,
} from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";

export const MODEL_ID = "convaiinnovations/laya";
export const MODEL_REVISION = "7b928d828b7b0e022f929d9bd2e44165aa270148";
export const SOURCE_GRAPH_SHA =
  "0b921a2e13bfd26c3e5951925f1f71ab2cf69abb13d119de4fdc86e7335553e4";
export const SOURCE_WEIGHTS_SHA =
  "92fe711b480d8a6ac8a9bcdc07599ecc6382ff4615961d9857cc4b367ef965fd";
export const DEFAULT_MODEL_DIRECTORY = "data/models/laya-node";
export const REVIEWED_BUNDLE_HASHES: Readonly<Record<string, string>> =
  Object.freeze({
    "laya.onnx":
      "ad7981df10c47720f29975f0421534bc8c852278968a4bc3ed912b93ff2e5d8d",
    "model.onnx.data": SOURCE_WEIGHTS_SHA,
    "laya_config.json":
      "79e44f88782def40a120b80170184bae9caa89be6abacfcccf8a295708530046",
    "tokenizer/tokenizer.json":
      "bcdb37f36380b253cd7f5162c1f8d8e7b1363681afb052be4b42ae279e8c50c6",
    "tokenizer/tokenizer.original.json":
      "609d8f4c067cd3950f88594c5a802616cea245823836ef5848ee4fc40aab5b6f",
    "tokenizer/tokenizer_config.json":
      "6c6b2d8e3c84ce0e671c129cd6b374b235d6f9863042a5836358d00a89bbb5a1",
  });

export async function fileHash(filename: string) {
  const hash = createHash("sha256");
  for await (const block of createReadStream(
    /* turbopackIgnore: true */ filename,
  ))
    hash.update(block);
  return hash.digest("hex");
}

// Keep unknown protobuf fields byte-for-byte; only add the public SDK's action Softmax.
type WireField = { id: number; wire: number; raw: Buffer; value: Buffer };
function fields(buffer: Buffer): WireField[] {
  const result: WireField[] = [];
  let offset = 0;
  function integer() {
    let value = 0,
      shift = 0;
    for (let i = 0; i < 10; ++i) {
      if (offset >= buffer.length) throw new Error("Truncated ONNX protobuf");
      const byte = buffer[offset++]!;
      value += (byte & 127) * 2 ** shift;
      if (!(byte & 128)) return value;
      shift += 7;
    }
    throw new Error("Invalid ONNX protobuf integer");
  }
  while (offset < buffer.length) {
    const start = offset,
      tag = integer(),
      wire = tag % 8,
      id = Math.floor(tag / 8);
    let value: Buffer;
    if (!id) throw new Error("Invalid ONNX protobuf field");
    if (wire === 2) {
      const length = integer(),
        begin = offset;
      offset += length;
      value = buffer.subarray(begin, offset);
    } else {
      const begin = offset;
      if (wire === 0) integer();
      else if (wire === 1) offset += 8;
      else if (wire === 5) offset += 4;
      else throw new Error("Unsupported ONNX protobuf wire type");
      value = buffer.subarray(begin, offset);
    }
    if (!Number.isSafeInteger(offset) || offset > buffer.length)
      throw new Error("Truncated ONNX protobuf field");
    result.push({ id, wire, raw: buffer.subarray(start, offset), value });
  }
  return result;
}
function varint(value: number) {
  const bytes: number[] = [];
  do {
    const byte = value % 128;
    value = Math.floor(value / 128);
    bytes.push(byte | (value ? 128 : 0));
  } while (value);
  return Buffer.from(bytes);
}
function bytes(id: number, value: Buffer | string) {
  const body = typeof value === "string" ? Buffer.from(value) : value;
  return Buffer.concat([varint(id * 8 + 2), varint(body.length), body]);
}
function number(id: number, value: number) {
  return Buffer.concat([varint(id * 8), varint(value)]);
}
function name(value: Buffer) {
  return fields(value)
    .find((field) => field.id === 1)
    ?.value.toString();
}

export function addActionSoftmax(source: Buffer) {
  const model = fields(source),
    graph = model.filter((field) => field.id === 7);
  if (graph.length !== 1) throw new Error("Expected exactly one ONNX graph");
  const original = fields(graph[0]!.value);
  const outputs = original
    .filter((field) => field.id === 12)
    .map((field) => name(field.value));
  const inputs = original
    .filter((field) => field.id === 11)
    .map((field) => name(field.value));
  if (
    JSON.stringify(outputs) !== JSON.stringify(["logits", "act_logits"]) ||
    JSON.stringify(inputs) !==
      JSON.stringify([
        "input_ids",
        "attention_mask",
        "marker_pos",
        "marker_mask",
        "qtype",
      ])
  ) {
    throw new Error(
      "ONNX graph does not match the reviewed multilingual export",
    );
  }
  const axis = Buffer.concat([bytes(1, "axis"), number(3, 1), number(20, 2)]);
  const softmax = Buffer.concat([
    bytes(1, "act_logits"),
    bytes(2, "act_probs"),
    bytes(3, "receptron_action_probabilities"),
    bytes(4, "Softmax"),
    bytes(5, axis),
  ]);
  const changed = original.map((field) => {
    if (field.id !== 12 || name(field.value) !== "act_logits") return field.raw;
    return bytes(
      12,
      Buffer.concat(
        fields(field.value).map((part) =>
          part.id === 1 ? bytes(1, "act_probs") : part.raw,
        ),
      ),
    );
  });
  changed.push(bytes(1, softmax));
  return Buffer.concat(
    model.map((field) =>
      field.id === 7 ? bytes(7, Buffer.concat(changed)) : field.raw,
    ),
  );
}

type BundleManifest = {
  model_id: string;
  revision: string;
  subfolder: string;
  source_graph_sha256: string;
  source_weights_sha256: string;
  artifacts: Record<string, string>;
  transformation: string;
  tokenizer_aliases: Record<string, number>;
};
export async function verifyBundle(directory = DEFAULT_MODEL_DIRECTORY) {
  const root = path.resolve(/* turbopackIgnore: true */ directory);
  const manifest = JSON.parse(
    await readFile(
      /* turbopackIgnore: true */ path.join(root, "node-manifest.json"),
      "utf8",
    ),
  ) as BundleManifest;
  if (
    manifest.model_id !== MODEL_ID ||
    manifest.revision !== MODEL_REVISION ||
    manifest.subfolder !== "multilingual" ||
    manifest.source_graph_sha256 !== SOURCE_GRAPH_SHA ||
    manifest.source_weights_sha256 !== SOURCE_WEIGHTS_SHA ||
    manifest.transformation !==
      "append Softmax(act_logits, axis=1) -> act_probs; weights unchanged" ||
    JSON.stringify(manifest.tokenizer_aliases) !==
      JSON.stringify({ "[CLS]": 2, "[SEP]": 1, "[MASK]": 4, "[PAD]": 0 })
  ) {
    throw new Error(
      "검증된 Laya 다국어 ONNX 번들이 필요합니다. 영어 모델로 대체하지 않습니다.",
    );
  }
  if (
    !manifest.artifacts ||
    Object.keys(manifest.artifacts).length !==
      Object.keys(REVIEWED_BUNDLE_HASHES).length ||
    Object.entries(REVIEWED_BUNDLE_HASHES).some(
      ([filename, expected]) => manifest.artifacts[filename] !== expected,
    )
  )
    throw new Error("번들 매니페스트가 코드에 고정된 검증 해시와 다릅니다.");
  for (const [filename, expected] of Object.entries(REVIEWED_BUNDLE_HASHES))
    if ((await fileHash(path.join(root, filename))) !== expected)
      throw new Error("Laya 번들 파일 검증에 실패했습니다.");
  const config = JSON.parse(
    await readFile(
      /* turbopackIgnore: true */ path.join(root, "laya_config.json"),
      "utf8",
    ),
  );
  if (
    config.max_len !== 1024 ||
    config.head_max_len !== 256 ||
    JSON.stringify(config.temperature) !== "[1,1,1]"
  )
    throw new Error("Laya 다국어 모델 설정이 일치하지 않습니다.");
  return manifest;
}

export type CandidateManifest = {
  schema_version: 1;
  kind: "laya-finetuned-candidate";
  candidate_id: string;
  base_model: { model_id: string; revision: string; subfolder: "multilingual" };
  training_run: string;
  dataset_sha256: string;
  registered_at: string;
  quality_approved: false;
  artifacts: Record<string, string>;
};
const CANDIDATE_FILES = [
  "laya.onnx",
  "laya_config.json",
  "tokenizer/tokenizer.json",
  "tokenizer/tokenizer_config.json",
] as const;
const SHA256 = /^[a-f0-9]{64}$/;
const CANDIDATE_ID = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,79}$/;

async function containedFile(directory: string, filename: string) {
  const root = await realpath(/* turbopackIgnore: true */ directory);
  const resolved = await realpath(
    /* turbopackIgnore: true */ path.join(root, filename),
  );
  const relative = path.relative(root, resolved);
  if (
    relative.startsWith("..") ||
    path.isAbsolute(relative) ||
    !(await stat(resolved)).isFile()
  )
    throw new Error(
      "Candidate artifact must be a file inside its bundle directory",
    );
  return resolved;
}

function candidateConfig(config: Record<string, unknown>) {
  if (
    config.max_len !== 1024 ||
    config.head_max_len !== 256 ||
    !Array.isArray(config.temperature) ||
    config.temperature.length !== 3 ||
    config.temperature.some(
      (value) =>
        typeof value !== "number" ||
        !Number.isFinite(value) ||
        value < 0.5 ||
        value > 5,
    ) ||
    (config.condition_classifier !== undefined && !["ads-conditions-v1", "ads-conditions-v2"].includes(config.condition_classifier as string)) ||
    (config.temperature_by_options !== undefined &&
      (!config.temperature_by_options ||
        typeof config.temperature_by_options !== "object" ||
        Array.isArray(config.temperature_by_options) ||
        Object.entries(config.temperature_by_options).some(
          ([key, value]) =>
            !/^(choice|score|noul):(2|3-5|6-10|11\+)$/.test(key) ||
            typeof value !== "number" ||
            !Number.isFinite(value) ||
            value < 0.5 ||
            value > 5,
        )))
  )
    throw new Error(
      "Candidate config does not match the multilingual SDK contract",
    );
  return {
    ...Object.fromEntries(
      ["max_len", "head_max_len", "temperature", "temperature_by_options"].map(
        (key) => [key, config[key] ?? {}],
      ),
    ),
    ...(config.condition_classifier ? { condition_classifier: config.condition_classifier } : {}),
  };
}

// The importer accepts the existing multilingual export contract, not arbitrary ONNX models.
function candidateGraph(graph: Buffer) {
  const graphs = fields(graph).filter((field) => field.id === 7);
  if (graphs.length !== 1) throw new Error("Expected exactly one ONNX graph");
  const parts = fields(graphs[0]!.value);
  const inputs = parts
    .filter((field) => field.id === 11)
    .map((field) => name(field.value));
  const outputs = parts
    .filter((field) => field.id === 12)
    .map((field) => name(field.value));
  if (
    JSON.stringify(inputs) !==
      JSON.stringify([
        "input_ids",
        "attention_mask",
        "marker_pos",
        "marker_mask",
        "qtype",
      ]) ||
    JSON.stringify(outputs) !== JSON.stringify(["logits", "act_probs"])
  )
    throw new Error(
      "Candidate ONNX graph does not match the multilingual SDK contract",
    );
  const locations = new Set<string>();
  function inspectTensor(tensor: Buffer) {
    for (const external of fields(tensor).filter((field) => field.id === 13)) {
      const entry = fields(external.value);
      if (
        entry.find((field) => field.id === 1)?.value.toString() !== "location"
      )
        continue;
      const location = entry.find((field) => field.id === 2)?.value.toString();
      if (location !== "model.onnx.data" && location !== "laya.onnx.data")
        throw new Error(
          "Candidate ONNX external weights must use model.onnx.data or laya.onnx.data",
        );
      locations.add(location);
    }
  }
  for (const tensor of parts.filter((field) => field.id === 5))
    inspectTensor(tensor.value);
  if (parts.some((field) => field.id === 15))
    throw new Error("Candidate sparse initializers are unsupported");
  for (const node of parts.filter((field) => field.id === 1))
    for (const attribute of fields(node.value).filter(
      (field) => field.id === 5,
    )) {
      const attributes = fields(attribute.value);
      if (attributes.some((field) => [6, 11, 22, 23].includes(field.id)))
        throw new Error(
          "Candidate nested graphs and sparse tensors are unsupported",
        );
      for (const tensor of attributes.filter(
        (field) => field.id === 5 || field.id === 10,
      ))
        inspectTensor(tensor.value);
    }
  if (locations.size !== 1)
    throw new Error(
      "Candidate ONNX must reference exactly one external weights file",
    );
  return [...locations][0]!;
}

function conditionHeadGraph(graph: Buffer) {
  if (graph.length > 64 * 1024 * 1024) throw new Error("Condition head exceeds its size limit");
  const graphs = fields(graph).filter(field => field.id === 7);
  if (graphs.length !== 1) throw new Error("Expected one condition head graph");
  const parts = fields(graphs[0].value);
  const names = (id: number) => parts.filter(field => field.id === id).map(field => name(field.value));
  if (JSON.stringify(names(11)) !== '["features"]' || JSON.stringify(names(12)) !== '["logits"]')
    throw new Error("Condition head graph contract differs");
  const checkTensor = (tensor: Buffer) => {
    if (fields(tensor).some(field => field.id === 13)) throw new Error("Condition head must embed its weights");
  };
  for (const tensor of parts.filter(field => field.id === 5)) checkTensor(tensor.value);
  if (parts.some(field => field.id === 15)) throw new Error("Condition head sparse tensors unsupported");
  for (const node of parts.filter(field => field.id === 1)) for (const attr of fields(node.value).filter(field => field.id === 5)) {
    const attributes = fields(attr.value);
    if (attributes.some(field => [6, 11, 22, 23].includes(field.id))) throw new Error("Condition head nested graphs unsupported");
    for (const tensor of attributes.filter(field => field.id === 5 || field.id === 10)) checkTensor(tensor.value);
  }
}

export function candidateModelVersion(manifest: CandidateManifest) {
  const digest = createHash("sha256")
    .update(
      JSON.stringify(
        Object.entries(manifest.artifacts).sort(([a], [b]) =>
          a.localeCompare(b),
        ),
      ),
    )
    .digest("hex");
  return `candidate:${manifest.candidate_id}@${digest}`;
}

export async function verifyCandidateBundle(
  directory: string,
  candidateId?: string,
) {
  const manifest = JSON.parse(
    await readFile(
      /* turbopackIgnore: true */ await containedFile(
        directory,
        "candidate-manifest.json",
      ),
      "utf8",
    ),
  ) as CandidateManifest;
  if (
    manifest.schema_version !== 1 ||
    manifest.kind !== "laya-finetuned-candidate" ||
    typeof manifest.candidate_id !== "string" ||
    !CANDIDATE_ID.test(manifest.candidate_id) ||
    (candidateId !== undefined && manifest.candidate_id !== candidateId) ||
    manifest.base_model?.model_id !== MODEL_ID ||
    manifest.base_model?.revision !== MODEL_REVISION ||
    manifest.base_model?.subfolder !== "multilingual" ||
    typeof manifest.training_run !== "string" ||
    !manifest.training_run.trim() ||
    manifest.training_run.length > 256 ||
    typeof manifest.dataset_sha256 !== "string" ||
    !SHA256.test(manifest.dataset_sha256) ||
    typeof manifest.registered_at !== "string" ||
    !Number.isFinite(Date.parse(manifest.registered_at)) ||
    manifest.quality_approved !== false ||
    !manifest.artifacts ||
    typeof manifest.artifacts !== "object"
  )
    throw new Error(
      "Candidate registration provenance is invalid or the candidate ID differs",
    );
  const graph = await readFile(
    /* turbopackIgnore: true */ await containedFile(directory, "laya.onnx"),
  );
  const weights = candidateGraph(graph);
  const optional = Object.hasOwn(manifest.artifacts, "condition-head.onnx") ? ["condition-head.onnx"] : [];
  const expected = [...CANDIDATE_FILES, weights, ...optional];
  if (
    Object.keys(manifest.artifacts).length !== expected.length ||
    expected.some(
      (filename) => !SHA256.test(manifest.artifacts[filename] ?? ""),
    )
  )
    throw new Error("Candidate artifact inventory is invalid");
  for (const filename of expected)
    if (
      (await fileHash(await containedFile(directory, filename))) !==
      manifest.artifacts[filename]
    )
      throw new Error(`Candidate artifact hash differs: ${filename}`);
  if (
    manifest.artifacts["tokenizer/tokenizer.json"] !==
      REVIEWED_BUNDLE_HASHES["tokenizer/tokenizer.json"] ||
    manifest.artifacts["tokenizer/tokenizer_config.json"] !==
      REVIEWED_BUNDLE_HASHES["tokenizer/tokenizer_config.json"]
  )
    throw new Error(
      "Candidate tokenizer differs from the pinned multilingual tokenizer",
    );
  const config = candidateConfig(JSON.parse(await readFile(
    /* turbopackIgnore: true */ await containedFile(directory, "laya_config.json"), "utf8",
  )));
  if ((config.condition_classifier === "ads-conditions-v2") !== (optional.length === 1))
    throw new Error("Condition head artifact inventory differs from config");
  if (optional.length) conditionHeadGraph(await readFile(
    /* turbopackIgnore: true */ await containedFile(directory, "condition-head.onnx"),
  ));
  return manifest;
}

// Canonicalize existing ancestors too: Windows short names and junctions can alias the source.
async function canonicalLocation(filename: string): Promise<string> {
  try {
    return await realpath(filename);
  } catch (error) {
    const parent = path.dirname(filename);
    if ((error as NodeJS.ErrnoException).code !== "ENOENT" || parent === filename) throw error;
    return path.join(await canonicalLocation(parent), path.basename(filename));
  }
}

export async function registerCandidateBundle(options: {
  sourceDirectory: string;
  directory: string;
  candidateId: string;
  trainingRun: string;
  datasetSha256: string;
}) {
  if (
    !CANDIDATE_ID.test(options.candidateId) ||
    !options.trainingRun.trim() ||
    options.trainingRun.length > 256 ||
    !SHA256.test(options.datasetSha256)
  )
    throw new Error(
      "Candidate ID, training run and dataset SHA-256 are required",
    );
  const source = await realpath(
    /* turbopackIgnore: true */ options.sourceDirectory,
  );
  const destination = await canonicalLocation(path.resolve(
    /* turbopackIgnore: true */ options.directory,
  ));
  const relative = path.relative(source, destination);
  if (
    destination === await canonicalLocation(path.resolve(DEFAULT_MODEL_DIRECTORY)) ||
    !relative ||
    (!relative.startsWith("..") && !path.isAbsolute(relative))
  )
    throw new Error(
      "Candidate destination must be separate from its source and baseline",
    );
  // Validate before writing and never replace an existing candidate directory.
  const graphFile = await containedFile(source, "laya.onnx").catch(() =>
    containedFile(source, "model.onnx"),
  );
  let graph = await readFile(/* turbopackIgnore: true */ graphFile);
  const outputNames = fields(
    fields(graph).find((field) => field.id === 7)?.value ?? Buffer.alloc(0),
  )
    .filter((field) => field.id === 12)
    .map((field) => name(field.value));
  if (outputNames.includes("act_logits")) graph = addActionSoftmax(graph);
  const weights = candidateGraph(graph);
  const weightsFile = await containedFile(source, weights);
  const configFile = await containedFile(source, "laya_config.json").catch(() =>
    containedFile(source, "rl_agent_config.json"),
  );
  const config = candidateConfig(
    JSON.parse(await readFile(/* turbopackIgnore: true */ configFile, "utf8")),
  );
  const optional = config.condition_classifier === "ads-conditions-v2" ? ["condition-head.onnx"] : [];
  for (const filename of optional) conditionHeadGraph(await readFile(
    /* turbopackIgnore: true */ await containedFile(source, filename),
  ));
  const tokenizerFile = await containedFile(source, "tokenizer/tokenizer.json");
  const tokenizerConfig = await containedFile(
    source,
    "tokenizer/tokenizer_config.json",
  );
  const tokenizerHash = await fileHash(tokenizerFile);
  if (
    ![
      REVIEWED_BUNDLE_HASHES["tokenizer/tokenizer.json"],
      REVIEWED_BUNDLE_HASHES["tokenizer/tokenizer.original.json"],
    ].includes(tokenizerHash) ||
    (await fileHash(tokenizerConfig)) !==
      REVIEWED_BUNDLE_HASHES["tokenizer/tokenizer_config.json"]
  )
    throw new Error(
      "Candidate tokenizer differs from the pinned multilingual tokenizer",
    );
  const tokenizer = JSON.parse(
    await readFile(/* turbopackIgnore: true */ tokenizerFile, "utf8"),
  );
  if (
    tokenizerHash ===
    REVIEWED_BUNDLE_HASHES["tokenizer/tokenizer.original.json"]
  )
    for (const [content, id] of Object.entries({
      "[CLS]": 2,
      "[SEP]": 1,
      "[MASK]": 4,
      "[PAD]": 0,
    }))
      tokenizer.added_tokens.push({
        id,
        content,
        special: true,
        single_word: false,
        lstrip: false,
        rstrip: false,
        normalized: false,
      });
  await mkdir(path.dirname(destination), { recursive: true });
  await mkdir(destination);
  await mkdir(path.join(destination, "tokenizer"));
  await writeFile(path.join(destination, "laya.onnx"), graph);
  await copyFile(weightsFile, path.join(destination, weights));
  for (const filename of optional) await copyFile(await containedFile(source, filename), path.join(destination, filename));
  await writeFile(
    path.join(destination, "laya_config.json"),
    JSON.stringify(config, null, 2),
  );
  // Preserve the reviewed serialized tokenizer hash when it is already normalized.
  if (tokenizerHash === REVIEWED_BUNDLE_HASHES["tokenizer/tokenizer.json"])
    await copyFile(
      tokenizerFile,
      path.join(destination, "tokenizer/tokenizer.json"),
    );
  else
    await writeFile(
      path.join(destination, "tokenizer/tokenizer.json"),
      JSON.stringify(tokenizer),
    );
  await copyFile(
    tokenizerConfig,
    path.join(destination, "tokenizer/tokenizer_config.json"),
  );
  const artifacts: Record<string, string> = {};
  for (const filename of [...CANDIDATE_FILES, weights, ...optional])
    artifacts[filename] = await fileHash(path.join(destination, filename));
  const manifest: CandidateManifest = {
    schema_version: 1,
    kind: "laya-finetuned-candidate",
    candidate_id: options.candidateId,
    base_model: {
      model_id: MODEL_ID,
      revision: MODEL_REVISION,
      subfolder: "multilingual",
    },
    training_run: options.trainingRun,
    dataset_sha256: options.datasetSha256,
    registered_at: new Date().toISOString(),
    quality_approved: false,
    artifacts,
  };
  await writeFile(
    path.join(destination, "candidate-manifest.json"),
    JSON.stringify(manifest, null, 2),
  );
  return verifyCandidateBundle(destination, options.candidateId);
}

export async function prepareBundle(
  options: {
    directory?: string;
    sourceDirectory?: string;
    checkpointDirectory?: string;
  } = {},
) {
  const destination = path.resolve(
    /* turbopackIgnore: true */ options.directory ?? DEFAULT_MODEL_DIRECTORY,
  );
  const source = path.resolve(
    /* turbopackIgnore: true */ options.sourceDirectory ??
      "data/models/laya-multilingual-fp32",
  );
  const checkpoint =
    options.checkpointDirectory ??
    path.join(
      homedir(),
      ".cache/huggingface/hub/models--convaiinnovations--laya/snapshots",
      MODEL_REVISION,
      "multilingual",
    );
  const sourceManifest = JSON.parse(
    await readFile(
      /* turbopackIgnore: true */ path.join(source, "manifest.json"),
      "utf8",
    ),
  );
  if (
    sourceManifest.model_id !== MODEL_ID ||
    sourceManifest.revision !== MODEL_REVISION ||
    sourceManifest.subfolder !== "multilingual" ||
    sourceManifest.verification?.sdk_parity_passed !== true ||
    sourceManifest.verification?.graph_parity_passed !== true ||
    (await fileHash(path.join(source, "model.onnx"))) !== SOURCE_GRAPH_SHA ||
    (await fileHash(path.join(source, "model.onnx.data"))) !==
      SOURCE_WEIGHTS_SHA
  ) {
    throw new Error(
      "기존 다국어 ONNX 산출물의 출처와 해시를 확인할 수 없습니다.",
    );
  }
  await mkdir(path.join(destination, "tokenizer"), { recursive: true });
  await writeFile(
    path.join(destination, "laya.onnx"),
    addActionSoftmax(
      await readFile(
        /* turbopackIgnore: true */ path.join(source, "model.onnx"),
      ),
    ),
  );
  const weights = path.join(destination, "model.onnx.data");
  if (!(await stat(weights).catch(() => null)))
    await link(path.join(source, "model.onnx.data"), weights).catch(() =>
      copyFile(path.join(source, "model.onnx.data"), weights),
    );
  const original = JSON.parse(
    await readFile(
      /* turbopackIgnore: true */ path.join(checkpoint, "rl_agent_config.json"),
      "utf8",
    ),
  );
  const config = Object.fromEntries(
    ["max_len", "head_max_len", "temperature", "temperature_by_options"].map(
      (key) => [key, original[key] ?? {}],
    ),
  );
  await writeFile(
    path.join(destination, "laya_config.json"),
    JSON.stringify(config, null, 2),
  );
  await copyFile(
    path.join(checkpoint, "tokenizer/tokenizer_config.json"),
    path.join(destination, "tokenizer/tokenizer_config.json"),
  );
  const tokenizerSource = await readFile(
    /* turbopackIgnore: true */
    path.join(checkpoint, "tokenizer/tokenizer.json"),
  );
  const tokenizer = JSON.parse(tokenizerSource.toString());
  const aliases = { "[CLS]": 2, "[SEP]": 1, "[MASK]": 4, "[PAD]": 0 };
  const originalNames = {
    "[CLS]": "<bos>",
    "[SEP]": "<eos>",
    "[MASK]": "<mask>",
    "[PAD]": "<pad>",
  };
  for (const [content, id] of Object.entries(aliases)) {
    if (
      !tokenizer.added_tokens.some(
        (token: { content: string; id: number }) =>
          token.content ===
            originalNames[content as keyof typeof originalNames] &&
          token.id === id,
      )
    )
      throw new Error("다국어 토크나이저의 원본 특수 토큰이 다릅니다.");
    tokenizer.added_tokens.push({
      id,
      content,
      special: true,
      single_word: false,
      lstrip: false,
      rstrip: false,
      normalized: false,
    });
  }
  await writeFile(
    path.join(destination, "tokenizer/tokenizer.original.json"),
    tokenizerSource,
  );
  await writeFile(
    path.join(destination, "tokenizer/tokenizer.json"),
    JSON.stringify(tokenizer),
  );
  const artifacts: Record<string, string> = {};
  for (const file of [
    "laya.onnx",
    "model.onnx.data",
    "laya_config.json",
    "tokenizer/tokenizer.json",
    "tokenizer/tokenizer.original.json",
    "tokenizer/tokenizer_config.json",
  ])
    artifacts[file] = await fileHash(
      path.join(/* turbopackIgnore: true */ destination, file),
    );
  const manifest: BundleManifest = {
    model_id: MODEL_ID,
    revision: MODEL_REVISION,
    subfolder: "multilingual",
    source_graph_sha256: SOURCE_GRAPH_SHA,
    source_weights_sha256: SOURCE_WEIGHTS_SHA,
    artifacts,
    transformation:
      "append Softmax(act_logits, axis=1) -> act_probs; weights unchanged",
    tokenizer_aliases: aliases,
  };
  await writeFile(
    path.join(destination, "node-manifest.json"),
    JSON.stringify(manifest, null, 2),
  );
  await verifyBundle(destination);
  return manifest;
}
