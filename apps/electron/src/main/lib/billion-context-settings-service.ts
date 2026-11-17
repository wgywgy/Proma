import { existsSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import type { BillionContextSettings } from '@proma/shared'
import { getConfigDir } from './config-paths'
import { readJsonFileSafe, writeJsonFileAtomic } from './safe-file'

export const DEFAULT_BILLION_CONTEXT_SETTINGS: Readonly<BillionContextSettings> = {
  enabled: false,
  proxyUrl: 'http://127.0.0.1:8787',
}

export function normalizeBillionContextOrigin(value: string): string {
  let url: URL
  try {
    url = new URL(value.trim())
  } catch {
    throw new Error('billion-context 地址必须是本地 HTTP origin，例如 http://127.0.0.1:8787')
  }
  if (url.protocol !== 'http:' || !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)
    || url.username || url.password || url.pathname !== '/' || url.search || url.hash) {
    throw new Error('billion-context 只允许无凭据、无路径的本地 HTTP 地址')
  }
  return url.origin
}

export function validateBillionContextSettings(value: unknown): BillionContextSettings {
  if (!value || typeof value !== 'object' || !('enabled' in value) || typeof value.enabled !== 'boolean'
    || !('proxyUrl' in value) || typeof value.proxyUrl !== 'string') {
    throw new Error('billion-context 配置无效，请在设置中重新保存')
  }
  return { enabled: value.enabled, proxyUrl: normalizeBillionContextOrigin(value.proxyUrl) }
}

function settingsPath(): string {
  return join(getConfigDir(), 'billion-context-settings.json')
}

export function getBillionContextSettings(filePath = settingsPath()): BillionContextSettings {
  const value = readJsonFileSafe<unknown>(filePath)
  if (value !== null) return validateBillionContextSettings(value)
  // 损坏配置不能被当作“关闭”，否则已启用的会话会悄悄改走直连。
  if ([filePath, `${filePath}.bak`].some(existsSync)) {
    throw new Error('billion-context 配置无法读取，请在设置中重新保存')
  }
  return { ...DEFAULT_BILLION_CONTEXT_SETTINGS }
}

export function saveBillionContextSettings(value: unknown, filePath = settingsPath()): void {
  const settings = validateBillionContextSettings(value)
  mkdirSync(dirname(filePath), { recursive: true })
  writeJsonFileAtomic(filePath, settings)
}
