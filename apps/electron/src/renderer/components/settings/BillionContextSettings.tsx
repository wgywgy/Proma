import * as React from 'react'
import { useAtomValue, useSetAtom } from 'jotai'
import { Loader2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import {
  billionContextSettingsAtom, loadBillionContextSettingsAtom, saveBillionContextSettingsAtom,
} from '@/atoms/billion-context-atoms'
import { SettingsSection, SettingsCard, SettingsToggle, SettingsInput } from './primitives'

export function BillionContextSettings(): React.ReactElement {
  const settings = useAtomValue(billionContextSettingsAtom)
  const loadSettings = useSetAtom(loadBillionContextSettingsAtom)
  const saveSettings = useSetAtom(saveBillionContextSettingsAtom)
  const [proxyUrl, setProxyUrl] = React.useState('http://127.0.0.1:8787')
  const [loading, setLoading] = React.useState(true)
  const [busy, setBusy] = React.useState(false)
  const [error, setError] = React.useState<string | null>(null)
  const [notice, setNotice] = React.useState<string | null>(null)

  React.useEffect(() => {
    let mounted = true
    loadSettings().catch(() => {
      if (mounted) setError('配置无法读取，尚未更改原设置。请明确保存下方配置以修复。')
    }).finally(() => {
      if (mounted) setLoading(false)
    })
    return () => { mounted = false }
  }, [loadSettings])

  React.useEffect(() => {
    if (settings) setProxyUrl(settings.proxyUrl)
  }, [settings])

  const save = async (enabled: boolean): Promise<void> => {
    setBusy(true)
    setError(null)
    setNotice(null)
    try {
      await saveSettings({ enabled, proxyUrl })
      setNotice('已保存，下次 Agent 请求开始时生效；正在运行的任务保持原接入方式。')
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : '保存失败，未确认设置变更')
    } finally {
      setBusy(false)
    }
  }

  const testConnection = async (): Promise<void> => {
    setBusy(true)
    setError(null)
    setNotice(null)
    try {
      const result = await window.electronAPI.testBillionContextConnection(proxyUrl)
      if (result.success) setNotice(result.message)
      else setError(result.message)
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : '连通性检测失败')
    } finally {
      setBusy(false)
    }
  }

  return (
    <SettingsSection
      title="billion-context"
      description="仅压缩 Agent 模型请求，不影响 Chat、Bash、MCP 或其他工具的网络连接。默认关闭。"
    >
      <SettingsCard>
        <SettingsToggle
          label="接入本地 billion-context"
          description="首批支持 Anthropic Messages 和 OpenAI Chat/Responses 的 API Key 渠道，不支持订阅 OAuth。"
          checked={settings?.enabled ?? false}
          disabled={loading || busy}
          onCheckedChange={(enabled) => { void save(enabled) }}
        />
        <SettingsInput
          label="本地代理地址"
          value={proxyUrl}
          onChange={(value) => { setProxyUrl(value); setNotice(null) }}
          disabled={loading || busy}
          placeholder="http://127.0.0.1:8787"
          description="只填本地 HTTP origin，不要修改渠道 Base URL，也不要添加 /bili/ 路径。"
        />
        <div className="px-4 py-3 space-y-3">
          <div className="flex flex-wrap gap-2">
            <Button size="sm" disabled={loading || busy} onClick={() => { void save(settings?.enabled ?? false) }}>
              {busy && <Loader2 className="animate-spin" />}
              保存地址
            </Button>
            <Button size="sm" variant="outline" disabled={loading || busy} onClick={() => { void testConnection() }}>
              检测连通性
            </Button>
          </div>
          {error && <p role="alert" className="text-xs text-destructive">{error}</p>}
          {notice && <p role="status" className="text-xs text-muted-foreground">{notice}</p>}
          <p className="text-xs text-muted-foreground">
            请先自行安装并运行 <code>bili start</code>。Proma 不会自动安装、启动代理或修改全局 Pi 配置。
            启用后关闭 Pi 自动压缩和 CompactContext；代理不可用时会报错，不会静默直连。
          </p>
          <p className="text-xs text-muted-foreground">
            本接入使用{' '}
            <button
              type="button"
              className="text-primary underline underline-offset-2"
              onClick={() => {
                void window.electronAPI.openExternal('https://github.com/ranxianglei/billion-context')
                  .catch(() => setError('无法打开 billion-context 项目链接'))
              }}
            >
              billion-context
            </button>
            。代理在本机处理请求中的 API Key 和对话，并独立持久化压缩状态；仅连接你信任的本地实例。
          </p>
        </div>
      </SettingsCard>
    </SettingsSection>
  )
}
