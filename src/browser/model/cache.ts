import { createSHA256 } from "hash-wasm";
import pinned from "./release.json";
import { openModelDirectory, readModelFile, writeModelFile } from "./opfs";
import type { ModelProgress } from "./types";

export const MODEL_RELEASE = pinned.release;
export const MODEL_CACHE = "laya-public-model-v1";
export const MODEL_TOTAL_BYTES = Object.values(MODEL_RELEASE.files).reduce((sum, file) => sum + file.size_bytes, 0);
export type ModelFile = keyof typeof MODEL_RELEASE.files;
export type ModelFiles = Map<ModelFile, Uint8Array<ArrayBuffer>> & { cacheComplete: boolean; cacheWarning?: string; cacheFailure?: string };
export type ModelLoadOptions = {
  baseUrl?: string;
  signal?: AbortSignal;
  progress?: (value: ModelProgress) => void;
  files?: File[];
};
const abort = (signal?: AbortSignal) => { if (signal?.aborted) throw new DOMException("모델 준비를 취소했습니다.", "AbortError"); };
const cacheKey = (name: ModelFile) => new URL(`/__laya_public_model__/${MODEL_RELEASE.files[name].sha256}/${encodeURIComponent(name)}`, globalThis.location?.origin ?? "https://laya.invalid").href;
export function modelFileUrl(name: ModelFile, baseUrl?: string) {
  if (!baseUrl) return MODEL_RELEASE.files[name].url;
  const base = new URL(baseUrl, globalThis.location?.href ?? "https://laya.invalid/");
  if (base.protocol !== "https:" && !(base.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(base.hostname))) throw new Error("모델 주소는 HTTPS 또는 localhost여야 합니다.");
  if (base.username || base.password || base.search || base.hash) throw new Error("모델 주소에 인증 정보나 조회 조건을 넣을 수 없습니다.");
  return new URL(MODEL_RELEASE.files[name].url.split("/").at(-1)!, base.href.replace(/\/?$/, "/")).href;
}

/** Public files only. Credentials, questions and advertisement records never enter this cache. */
export async function verifyModelStream(source: ReadableStream<Uint8Array>, name: ModelFile, options: ModelLoadOptions, cached: boolean, completed: number) {
  const expected = MODEL_RELEASE.files[name], bytes = new Uint8Array(expected.size_bytes);
  const hash = await createSHA256(); hash.init();
  const reader = source.getReader(); let offset = 0;
  const cancel = () => { void reader.cancel().catch(() => undefined); };
  options.signal?.addEventListener("abort", cancel, { once: true });
  try {
    for (;;) {
      abort(options.signal);
      const next = await reader.read();
      if (next.done) break;
      if (offset + next.value.byteLength > bytes.byteLength) throw new Error("모델 파일 크기가 고정된 배포 명세와 다릅니다.");
      bytes.set(next.value, offset); hash.update(next.value); offset += next.value.byteLength;
      options.progress?.({ stage: "download", file: name, loaded: completed + offset, total: MODEL_TOTAL_BYTES, cached });
    }
    abort(options.signal);
    options.progress?.({ stage: "verify", file: name, loaded: completed + offset, total: MODEL_TOTAL_BYTES, cached });
    if (offset !== expected.size_bytes || hash.digest("hex") !== expected.sha256) throw new Error("모델 파일 SHA-256 또는 크기 검증에 실패했습니다.");
    return bytes;
  } catch (error) {
    await reader.cancel().catch(() => undefined);
    throw error;
  } finally { reader.releaseLock(); options.signal?.removeEventListener("abort", cancel); }
}
export function selectModelFile(files: File[], name: ModelFile) {
  const flat = name.replaceAll("/", "--");
  const matches = files.filter(file => file.name === flat || file.webkitRelativePath?.endsWith(`/${name}`) || file.webkitRelativePath === name || (!name.includes("/") && file.name === name));
  if (matches.length !== 1) throw new Error(`모델 폴더에 ${name} 파일이 정확히 하나 필요합니다.`);
  return matches[0];
}
export async function loadModelFiles(options: ModelLoadOptions = {}): Promise<ModelFiles> {
  let cache: Cache | undefined;
  try { if (typeof caches !== "undefined") cache = await caches.open(MODEL_CACHE); } catch { /* Storage can be disabled; verification still applies. */ }
  const directory = await openModelDirectory();
  const result: ModelFiles = Object.assign(new Map<ModelFile, Uint8Array<ArrayBuffer>>(), { cacheComplete: !!cache || !!directory });
  if (!cache && !directory) result.cacheWarning = "브라우저가 모델 저장을 허용하지 않아 다음 실행 때 모델을 다시 준비해야 합니다.";
  let completed = 0;
  for (const name of Object.keys(MODEL_RELEASE.files) as ModelFile[]) {
    abort(options.signal); let bytes: Uint8Array<ArrayBuffer> | undefined;
    if (!options.files && directory) {
      const file = await readModelFile(directory, name);
      if (file) {
        try { bytes = await verifyModelStream(file.stream(), name, options, true, completed); }
        catch { abort(options.signal); }
      }
    }
    if (!bytes && !options.files && cache) {
      const response = await cache.match(cacheKey(name));
      if (response?.body) {
        try { bytes = await verifyModelStream(response.body, name, options, true, completed); }
        catch (error) { abort(options.signal); if (error instanceof DOMException && error.name === "AbortError") throw error; }
      }
    }
    if (!bytes) {
      let stream: ReadableStream<Uint8Array>;
      if (options.files) {
        const file = selectModelFile(options.files, name);
        if (file.size !== MODEL_RELEASE.files[name].size_bytes) throw new Error(`모델 파일 크기가 다릅니다: ${name}`);
        stream = file.stream();
      } else {
        let response: Response;
        try {
          response = await fetch(modelFileUrl(name, options.baseUrl), { credentials: "omit", referrerPolicy: "no-referrer", signal: options.signal, cache: "no-store" });
        } catch (error) {
          abort(options.signal);
          throw new Error(`공개 모델 다운로드가 차단되었습니다. CORS를 허용한 모델 호스트를 설정하거나 검증된 모델 폴더를 가져와 주세요. (${error instanceof Error ? error.name : "NETWORK"})`);
        }
        if (!response.ok || !response.body) throw new Error(`공개 모델 다운로드 실패 (HTTP ${response.status}).`);
        stream = response.body;
      }
      bytes = await verifyModelStream(stream, name, options, false, completed);
      let stored = false;
      let cacheError: unknown;
      // Large CacheStorage responses can fail independently of origin quota. OPFS streams them.
      if (directory && (bytes.byteLength >= 64 * 1024 * 1024 || !cache)) {
        try { await writeModelFile(directory, name, bytes, options.signal); stored = true; }
        catch (error) { abort(options.signal); cacheError = error; }
      }
      if (!stored && cache) {
        try { await cache.put(cacheKey(name), new Response(bytes, { headers: { "Content-Type": "application/octet-stream", "X-Laya-Sha256": MODEL_RELEASE.files[name].sha256 } })); stored = true; }
        catch (error) { cacheError = error; }
      }
      if (!stored && directory && bytes.byteLength < 64 * 1024 * 1024) {
        try { await writeModelFile(directory, name, bytes, options.signal); stored = true; }
        catch (error) { abort(options.signal); cacheError = error; }
      }
      if (!stored) {
        result.cacheComplete = false;
        result.cacheWarning = "모델은 실행할 수 있지만 일부 파일을 브라우저에 보관하지 못했습니다. 새로고침 후 모델 파일을 다시 선택해야 할 수 있습니다.";
        result.cacheFailure = cacheError instanceof Error ? cacheError.name : "CACHE_WRITE_FAILED";
        options.progress?.({ stage: "verify", file: name, loaded: completed + bytes.length, total: MODEL_TOTAL_BYTES, message: result.cacheWarning, cacheComplete: false, cacheWarning: result.cacheWarning, cacheFailure: result.cacheFailure });
      }
    }
    result.set(name, bytes); completed += bytes.byteLength;
  }
  const manifest = JSON.parse(new TextDecoder().decode(result.get("candidate-manifest.json")));
  if (manifest.candidate_id !== MODEL_RELEASE.candidate_id || manifest.kind !== "laya-finetuned-candidate" || manifest.schema_version !== 1) throw new Error("모델 배포 식별자가 다릅니다.");
  for (const [name, spec] of Object.entries(MODEL_RELEASE.files)) {
    if (name !== "candidate-manifest.json" && manifest.artifacts?.[name] !== spec.sha256) throw new Error("모델 배포 파일 목록이 다릅니다.");
  }
  return result;
}
