import { MODEL_RELEASE } from "./cache";
import { SEMANTIC_POLICY_VERSION } from "./identity";

// Every inference input asset participates in persisted decision/cache identity.
export const MODEL_VERSION = `candidate:${MODEL_RELEASE.candidate_id}@${Object.entries(MODEL_RELEASE.files).sort(([left], [right]) => left.localeCompare(right)).map(([name, file]) => `${name}=${file.sha256}`).join(",")};onnxruntime-web=1.30.0;wasm;lora=r4;heads=separate;axes;policy=${SEMANTIC_POLICY_VERSION}`;
