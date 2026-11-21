import { createHash } from 'node:crypto'
import { lstatSync, mkdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { writeTextFileAtomic } from './safe-file'

function snapshotPath(root: string, workspaceSlug: string, relativePath: string): string {
  const key = createHash('sha256').update(JSON.stringify([workspaceSlug, relativePath])).digest('hex')
  return join(root, `${key}.txt`)
}

export function readPreviousMemory(root: string, workspaceSlug: string, relativePath: string, maxBytes: number): string | undefined {
  const dir = lstatSync(root, { throwIfNoEntry: false })
  if (!dir?.isDirectory()) return undefined
  const path = snapshotPath(root, workspaceSlug, relativePath)
  const stat = lstatSync(path, { throwIfNoEntry: false })
  if (!stat?.isFile() || stat.size > maxBytes) return undefined
  return readFileSync(path, 'utf8')
}

export function savePreviousMemory(root: string, workspaceSlug: string, relativePath: string, content: string): void {
  mkdirSync(root, { recursive: true, mode: 0o700 })
  if (!lstatSync(root).isDirectory()) throw new Error('记忆历史路径不是普通目录')
  writeTextFileAtomic(snapshotPath(root, workspaceSlug, relativePath), content)
}
