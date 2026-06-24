import { fetchDevBridgeHealth, readDevBridgeFile, walkDevBridgeFiles, writeDevBridgeFile } from './devBridgeClient'

export type ProjectRoot =
  | { kind: 'fsa'; handle: FileSystemDirectoryHandle; label: string }
  | { kind: 'dev-bridge'; absolutePath: string; projectId: string; label: string }

export function projectRootLabel(root: ProjectRoot): string {
  return root.label
}

export async function readProjectFileBytes(root: ProjectRoot, relativePath: string): Promise<Uint8Array | null> {
  if (root.kind === 'fsa') {
    return readFsaFileBytes(root.handle, relativePath)
  }
  return readDevBridgeFile(root.absolutePath, relativePath)
}

export async function readProjectFileText(root: ProjectRoot, relativePath: string): Promise<string | null> {
  const bytes = await readProjectFileBytes(root, relativePath)
  if (!bytes) return null
  return new TextDecoder().decode(bytes)
}

export async function writeProjectFileBytes(
  root: ProjectRoot,
  relativePath: string,
  bytes: Uint8Array | ArrayBuffer
): Promise<void> {
  if (root.kind === 'fsa') {
    await writeFsaFileBytes(root.handle, relativePath, bytes)
    return
  }
  const copy =
    bytes instanceof ArrayBuffer
      ? new Uint8Array(bytes)
      : new Uint8Array(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength))
  await writeDevBridgeFile(root.absolutePath, relativePath, copy)
}

export async function walkProjectRootFiles(root: ProjectRoot, prefix = ''): Promise<string[]> {
  if (root.kind === 'fsa') {
    return walkFsaFiles(root.handle, prefix)
  }
  const files = await walkDevBridgeFiles(root.absolutePath)
  if (!prefix) return files
  const p = prefix.endsWith('/') ? prefix : `${prefix}/`
  return files.filter((f) => f.startsWith(p))
}

export async function isDevBridgeAvailable(): Promise<boolean> {
  const health = await fetchDevBridgeHealth()
  return Boolean(health?.ok)
}

async function readFsaFileBytes(
  root: FileSystemDirectoryHandle,
  relativePath: string
): Promise<Uint8Array | null> {
  try {
    const parts = relativePath.split('/').filter(Boolean)
    let dir = root
    for (let i = 0; i < parts.length - 1; i++) {
      dir = await dir.getDirectoryHandle(parts[i]!)
    }
    const fileHandle = await dir.getFileHandle(parts[parts.length - 1]!)
    const file = await fileHandle.getFile()
    return new Uint8Array(await file.arrayBuffer())
  } catch {
    return null
  }
}

async function writeFsaFileBytes(
  root: FileSystemDirectoryHandle,
  relativePath: string,
  bytes: Uint8Array | ArrayBuffer
): Promise<void> {
  const parts = relativePath.split('/').filter(Boolean)
  let dir = root
  for (let i = 0; i < parts.length - 1; i++) {
    dir = await dir.getDirectoryHandle(parts[i]!, { create: true })
  }
  const fileHandle = await dir.getFileHandle(parts[parts.length - 1]!, { create: true })
  const writable = await fileHandle.createWritable()
  const copy =
    bytes instanceof ArrayBuffer
      ? bytes
      : bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength)
  await writable.write(new Blob([copy as ArrayBuffer]))
  await writable.close()
}

async function walkFsaFiles(root: FileSystemDirectoryHandle, prefix = ''): Promise<string[]> {
  const out: string[] = []
  for await (const [name, handle] of root.entries()) {
    const rel = prefix ? `${prefix}/${name}` : name
    if (handle.kind === 'directory') {
      if (name === 'node_modules' || name === '.git') continue
      out.push(...(await walkFsaFiles(handle as FileSystemDirectoryHandle, rel)))
    } else {
      out.push(rel)
    }
  }
  return out
}