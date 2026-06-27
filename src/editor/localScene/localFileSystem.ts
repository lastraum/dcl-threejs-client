import type { ProjectRoot } from './projectRoot'
import {
  readProjectFileBytes,
  readProjectFileText,
  walkProjectRootFiles,
  writeProjectFileBytes
} from './projectRoot'

export async function readFileBytes(root: ProjectRoot, relativePath: string): Promise<Uint8Array | null> {
  return readProjectFileBytes(root, relativePath)
}

export async function readFileText(root: ProjectRoot, relativePath: string): Promise<string | null> {
  return readProjectFileText(root, relativePath)
}

export async function writeFileBytes(
  root: ProjectRoot,
  relativePath: string,
  bytes: Uint8Array | ArrayBuffer
): Promise<void> {
  return writeProjectFileBytes(root, relativePath, bytes)
}

export async function walkProjectFiles(root: ProjectRoot, prefix = ''): Promise<string[]> {
  return walkProjectRootFiles(root, prefix)
}