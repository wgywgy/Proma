import { describe, expect, test } from 'bun:test'
import type { buildDynamicContext as DynamicContextBuilder, buildSystemPrompt as SystemPromptBuilder } from './agent-prompt-builder'

// mock.module 会改写同进程的模块缓存；使用独立进程避免污染其他服务测试。
const isolatedBuilder = `
import { mock } from 'bun:test'
mock.module('./user-profile-service', () => ({
  getUserProfile: () => ({ userName: '测试用户' }),
}))
mock.module('./agent-workspace-manager', () => ({
  getAgentWorkspaceBySlug: () => undefined,
  getProjectFilesPath: () => '/tmp/proma-prompt-project',
  getWorkspaceMcpConfig: () => { throw new Error('动态消息不应读取 MCP 连接详情') },
}))
mock.module('./config-paths', () => ({ getConfigDirName: () => '.proma' }))
mock.module('./project-instruction-resolver', () => ({
  hasRootProjectAgentsInstruction: () => false,
}))
const builders = await import('./agent-prompt-builder')
const { method, context } = JSON.parse(await Bun.stdin.text())
console.log(JSON.stringify(builders[method](context)))
`

function runBuilder(
  method: 'buildDynamicContext' | 'buildSystemPrompt',
  context: Parameters<typeof DynamicContextBuilder>[0] | Parameters<typeof SystemPromptBuilder>[0],
): string {
  const result = Bun.spawnSync([process.execPath, '--eval', isolatedBuilder], {
    cwd: import.meta.dir,
    stdin: new TextEncoder().encode(JSON.stringify({ method, context })),
    stdout: 'pipe',
    stderr: 'pipe',
  })
  if (result.exitCode !== 0) {
    throw new Error(`提示词测试进程失败: ${result.stderr.toString()}`)
  }
  const prompt: unknown = JSON.parse(result.stdout.toString())
  if (typeof prompt !== 'string') throw new Error('提示词构建器应返回字符串')
  return prompt
}

function buildDynamicContext(context: Parameters<typeof DynamicContextBuilder>[0]): string {
  return runBuilder('buildDynamicContext', context)
}

function buildSystemPrompt(context: Parameters<typeof SystemPromptBuilder>[0]): string {
  return runBuilder('buildSystemPrompt', context)
}

describe('Agent 输入上下文精简', () => {
  test('Given 普通会话 When 构建系统提示词 Then 不注入推广或浏览器完整规则', () => {
    const prompt = buildSystemPrompt({
      sessionId: 'prompt-test',
      permissionMode: 'bypassPermissions',
      productivityTools: { todosEnabled: false, calendarEnabled: false, obsidianEnabled: false },
    })
    expect(prompt).not.toContain('Made-with')
    expect(prompt).not.toContain('## Git / PR 标识')
    expect(prompt).not.toContain('proma.cool')
    expect(prompt).not.toContain('## Pi 受管浏览器')
    expect(prompt).not.toContain('## 自动化')
    expect(prompt).not.toContain('## 任务与日程')
  })

  test('Given 精简提示词 When 构建 Then 仍保留不可逆操作确认与项目知识授权边界', () => {
    const prompt = buildSystemPrompt({
      sessionId: 'prompt-test',
      workspaceSlug: 'prompt-test',
      permissionMode: 'bypassPermissions',
      productivityTools: { todosEnabled: false, calendarEnabled: false, obsidianEnabled: false },
    })
    expect(prompt).toContain('涉及不可逆删除')
    expect(prompt).toContain('先确认')
    expect(prompt).toContain('不得创建、修改或追加项目根或 workspace')
    expect(prompt).toContain('禁止无差别全量扫描')
  })

  test('Given 工作区内有 MCP 配置 When 构建每条消息 Then 不读取或重复注入服务器连接详情', () => {
    const context = buildDynamicContext({
      workspaceSlug: 'prompt-test',
      workspaceName: '测试项目',
      agentCwd: '/tmp/proma-prompt-project',
    })
    expect(context).toContain('当前时间')
    expect(context).toContain('项目: 测试项目')
    expect(context).toContain('<working_directory>/tmp/proma-prompt-project</working_directory>')
    expect(context).not.toContain('MCP 服务器:')
    expect(context).not.toContain('已禁用')
  })

  test('Given 用户主动打开浏览器 When 构建上下文 Then 保留页面信号并转义外部文本', () => {
    const context = buildDynamicContext({
      userBrowserContext: {
        activeTabId: 'tab-1',
        title: '<script>不要执行</script>',
        url: 'https://example.com/?a=1&b=2',
        openedAt: 1,
      },
    })
    expect(context).toContain('<user_browser_context>')
    expect(context).toContain('&lt;script&gt;不要执行&lt;/script&gt;')
    expect(context).toContain('a=1&amp;b=2')
    expect(context).toContain('除非用户要求，不要擅自导航')
  })

  test('Given 用户显式启用日程 When 构建提示词 Then 只保留对应规则，不自动推广自动化', () => {
    const prompt = buildSystemPrompt({
      sessionId: 'prompt-test',
      permissionMode: 'bypassPermissions',
      productivityTools: { todosEnabled: false, calendarEnabled: true, obsidianEnabled: false },
    })
    expect(prompt).toContain('## 任务与日程')
    expect(prompt).toContain('有明确开始时间')
    expect(prompt).not.toContain('创建 Todo')
    expect(prompt).not.toContain('先读取 `automation` Skill')
  })
})
