import { createHash } from 'node:crypto'
import { join } from 'node:path'
import type { AgentMessage, AgentToolResult } from '@earendil-works/pi-agent-core'
import type { AgentSession } from '@earendil-works/pi-coding-agent'

type ToolContent = AgentToolResult<unknown>['content']
type BudgetAgent = Pick<AgentSession['agent'], 'afterToolCall' | 'transformContext'>

export interface ToolOutputBudget {
  limit(toolName: string, content: ToolContent): ToolContent
  limitMessage<T extends AgentMessage>(message: T): T
}

export function getToolOutputDirectory(sessionRoot: string, sessionId: string): string {
  const namespace = createHash('sha256').update(sessionId).digest('hex')
  return join(sessionRoot, 'tool-outputs', namespace)
}

/** 保留兼容入口；工具原文由调用方决定取量，不再裁剪或强制落盘。 */
export function createToolOutputBudget(_outputDirectory: string): ToolOutputBudget {
  return {
    limit(_toolName: string, content: ToolContent): ToolContent {
      return content
    },
    limitMessage<T extends AgentMessage>(message: T): T {
      return message
    },
  }
}

/** 不再安装裁剪 hook，保留运行时守卫及已有上下文转换的身份和行为。 */
export function installToolOutputBudgetHooks(_agent: BudgetAgent, _outputDirectory: string): void {}
