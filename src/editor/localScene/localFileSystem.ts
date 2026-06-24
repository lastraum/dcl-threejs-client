export async function readFileBytes(
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

export async function readFileText(
  root: FileSystemDirectoryHandle,
  relativePath: string
): Promise<string | null> {
  const bytes = await readFileBytes(root, relativePath)
  if (!bytes) return null
  return new TextDecoder().decode(bytes)
}

export async function writeFileBytes(
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

export async function walkProjectFiles(
  root: FileSystemDirectoryHandle,
  prefix = ''
): Promise<string[]> {
  const out: string[] = []
  for await (const [name, handle] of root.entries()) {
    const path = prefix ? `${prefix}/${name}` : name
    if (handle.kind === 'directory') {
      if (name === 'node_modules' || name === '.git') continue
      out.push(...(await walkProjectFiles(handle as FileSystemDirectoryHandle, path)))
    } else {
      out.push(path)
    }
  }
  return out
}