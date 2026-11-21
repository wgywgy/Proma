import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, readdirSync, rmSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { readPreviousMemory, savePreviousMemory } from './workspace-memory-previous'

let temp: string | undefined
function setup(): string {
  temp = mkdtempSync(join(tmpdir(), 'proma-memory-previous-'))
  return join(temp, 'previous')
}

afterEach(() => {
  if (temp) rmSync(temp, { recursive: true, force: true })
  temp = undefined
})

describe('工作区记忆上一版', () => {
  test('按工作区和文件隔离，只保留最近一份，空文本仍可恢复', () => {
    const root = setup()
    expect(readPreviousMemory(root, 'team', 'MEMORY.md', 100)).toBeUndefined()
    savePreviousMemory(root, 'team', 'MEMORY.md', '第一版')
    savePreviousMemory(root, 'team', 'MEMORY.md', '')
    savePreviousMemory(root, 'other', 'MEMORY.md', '另一个工作区')
    expect(readdirSync(root)).toHaveLength(2)
    expect(readPreviousMemory(root, 'team', 'MEMORY.md', 100)).toBe('')
    expect(readPreviousMemory(root, 'other', 'MEMORY.md', 100)).toBe('另一个工作区')
    expect(readPreviousMemory(root, 'team', 'other.md', 100)).toBeUndefined()
  })

  test('不返回超限或符号链接快照', () => {
    const root = setup()
    savePreviousMemory(root, 'team', 'MEMORY.md', '1234')
    expect(readPreviousMemory(root, 'team', 'MEMORY.md', 3)).toBeUndefined()
    const alias = join(root, '..', 'alias')
    symlinkSync(root, alias, 'dir')
    expect(readPreviousMemory(alias, 'team', 'MEMORY.md', 100)).toBeUndefined()
    expect(() => savePreviousMemory(alias, 'team', 'MEMORY.md', 'other')).toThrow()
    expect(readPreviousMemory(root, 'team', 'MEMORY.md', 100)).toBe('1234')
  })
})
