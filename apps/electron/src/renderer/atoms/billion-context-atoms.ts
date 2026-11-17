import { atom } from 'jotai'
import type { BillionContextSettings } from '@proma/shared'

export const billionContextSettingsAtom = atom<BillionContextSettings | null>(null)

export const loadBillionContextSettingsAtom = atom(null, async (_get, set) => {
  const settings = await window.electronAPI.getBillionContextSettings()
  set(billionContextSettingsAtom, settings)
})

export const saveBillionContextSettingsAtom = atom(
  null,
  async (_get, set, settings: BillionContextSettings) => {
    await window.electronAPI.updateBillionContextSettings(settings)
    // 主进程校验通过且写盘成功后再发布状态，不把失败保存当成成功。
    set(billionContextSettingsAtom, await window.electronAPI.getBillionContextSettings())
  },
)
