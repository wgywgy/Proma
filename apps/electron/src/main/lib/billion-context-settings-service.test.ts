import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { writeTextFileAtomic } from './safe-file'
import {
  DEFAULT_BILLION_CONTEXT_SETTINGS, getBillionContextSettings,
  normalizeBillionContextOrigin, saveBillionContextSettings,
} from './billion-context-settings-service'

const directories: string[] = []
function fixture(): string {
  const directory = mkdtempSync(join(tmpdir(), 'proma-bili-settings-'))
  directories.push(directory)
  return join(directory, 'billion-context-settings.json')
}
afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true })
})

describe('billion-context 独立配置', () => {
  test('Given 无配置 When 读取 Then 默认关闭且返回独立对象', () => {
    const file = fixture()
    const settings = getBillionContextSettings(file)
    expect(settings).toEqual(DEFAULT_BILLION_CONTEXT_SETTINGS)
    settings.enabled = true
    expect(getBillionContextSettings(file).enabled).toBe(false)
  })

  test('Given 有效配置 When 保存再读取 Then 原子持久化并规范化地址', () => {
    const file = fixture()
    saveBillionContextSettings({ enabled: true, proxyUrl: ' http://localhost:9000/ ' }, file)
    expect(getBillionContextSettings(file)).toEqual({ enabled: true, proxyUrl: 'http://localhost:9000' })
    saveBillionContextSettings({ enabled: false, proxyUrl: 'http://localhost:9000' }, file)
    expect(getBillionContextSettings(file).enabled).toBe(false)
  })

  test('Given 损坏主文件和有效备份 When 读取 Then 保留原启用状态', () => {
    const file = fixture()
    saveBillionContextSettings({ enabled: true, proxyUrl: 'http://localhost:9000' }, file)
    saveBillionContextSettings({ enabled: false, proxyUrl: 'http://localhost:9000' }, file)
    writeTextFileAtomic(file, '{broken')
    expect(getBillionContextSettings(file).enabled).toBe(true)
  })

  for (const value of ['{broken', '{"enabled":true}', '{"enabled":"false","proxyUrl":"http://localhost:8787"}']) {
    test(`Given 无法恢复的配置 ${value} When 读取 Then 明确失败而非静默直连`, () => {
      const file = fixture()
      writeTextFileAtomic(file, value)
      expect(() => getBillionContextSettings(file)).toThrow('billion-context')
    })
  }

  for (const url of [
    'https://localhost:8787', 'http://192.168.1.1:8787', 'http://example.com',
    'http://localhost.evil.test', 'http://user:password@localhost:8787',
    'http://localhost:8787/bili/', 'http://localhost:8787?key=secret',
    'http://localhost:8787/#fragment', 'file:///tmp/bili',
  ]) {
    test(`Given 非受信 origin ${url} When 校验 Then 拒绝且不修改已保存设置`, () => {
      const file = fixture()
      saveBillionContextSettings({ enabled: true, proxyUrl: 'http://127.0.0.1:8787' }, file)
      expect(() => saveBillionContextSettings({ enabled: false, proxyUrl: url }, file)).toThrow()
      expect(getBillionContextSettings(file).enabled).toBe(true)
    })
  }

  test('Given IPv6 loopback When 校验 Then 支持本地实例', () => {
    expect(normalizeBillionContextOrigin('http://[::1]:8787/')).toBe('http://[::1]:8787')
  })
})
