import pinned from "./release.json";
import type { ModelFile } from "./cache";
const MODEL_RELEASE = pinned.release;
export const MODEL_DIRECTORY = "laya-public-model-v1";
export const MODEL_WRITE_CHUNK_BYTES = 16 * 1024 * 1024;
export function modelStorageName(name: ModelFile) { return `${MODEL_RELEASE.files[name].sha256}-${name.replaceAll("/", "--")}`; }
/** This is the browser's origin-private model directory, never an operating-system user folder. */
export async function openModelDirectory(): Promise<FileSystemDirectoryHandle | undefined> {
  try {
    if (typeof navigator === "undefined" || !navigator.storage?.getDirectory) return;
    const root = await navigator.storage.getDirectory();
    return await root.getDirectoryHandle(MODEL_DIRECTORY, { create: true });
  } catch { return; }
}
export async function readModelFile(directory: FileSystemDirectoryHandle, name: ModelFile): Promise<File | undefined> {
  try { return await (await directory.getFileHandle(modelStorageName(name))).getFile(); }
  catch { return; }
}
/** close() commits the complete new file; a failed/cancelled write never replaces an existing file. */
export async function writeModelFile(directory: FileSystemDirectoryHandle, name: ModelFile, bytes: Uint8Array<ArrayBuffer>, signal?: AbortSignal): Promise<void> {
  signal?.throwIfAborted();
  const handle = await directory.getFileHandle(modelStorageName(name), { create: true });
  const writable = await handle.createWritable({ keepExistingData: false });
  try {
    for (let offset = 0; offset < bytes.byteLength; offset += MODEL_WRITE_CHUNK_BYTES) {
      signal?.throwIfAborted();
      await writable.write(bytes.subarray(offset, Math.min(bytes.byteLength, offset + MODEL_WRITE_CHUNK_BYTES)));
    }
    signal?.throwIfAborted();
    await writable.close();
  } catch (error) { await writable.abort().catch(() => undefined); throw error; }
}
