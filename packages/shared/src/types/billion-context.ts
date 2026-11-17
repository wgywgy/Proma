/** billion-context 仅处理 Agent 模型请求，与全局网络代理相互独立。 */
export interface BillionContextSettings {
  enabled: boolean
  proxyUrl: string
}

export interface BillionContextConnectionResult {
  success: boolean
  message: string
}

export const BILLION_CONTEXT_IPC_CHANNELS = {
  GET_SETTINGS: 'billion-context:get-settings',
  UPDATE_SETTINGS: 'billion-context:update-settings',
  TEST_CONNECTION: 'billion-context:test-connection',
} as const
