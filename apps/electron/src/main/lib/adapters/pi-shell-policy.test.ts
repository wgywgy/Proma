import { describe, expect, test } from 'bun:test'
import { spawn } from 'node:child_process'
import { tmpdir } from 'node:os'
import { createBashToolDefinition, createLocalBashOperations } from '@earendil-works/pi-coding-agent'
import type { BashOperations } from '@earendil-works/pi-coding-agent'
import { createWslBashOperations } from './pi-agent-adapter'
import { DEFAULT_SHELL_TIMEOUT_SECONDS, withDefaultShellTimeout } from './pi-shell-policy'

describe('Shell 超时与进程退出', () => {
  test('Given 未传超时 When 执行 Shell Then 默认 300 秒且保留显式超时', async () => {
    const timeouts: Array<number | undefined> = []
    const operations: BashOperations = {
      async exec(_command, _cwd, options) {
        timeouts.push(options.timeout)
        return { exitCode: 0 }
      },
    }
    const wrapped = withDefaultShellTimeout(operations)
    await wrapped.exec('pwd', tmpdir(), { onData() {} })
    await wrapped.exec('pwd', tmpdir(), { onData() {}, timeout: 600 })
    expect(DEFAULT_SHELL_TIMEOUT_SECONDS).toBe(300)
    expect(timeouts).toEqual([300, 600])
  })

  test('Given Shell 超时 When 返回工具结果 Then 报告失败且保留已输出的诊断', async () => {
    const tool = createBashToolDefinition(tmpdir(), {
      operations: withDefaultShellTimeout(createLocalBashOperations()),
      exposeSessionEnvironment: false,
    })
    const result = tool.execute('timeout-test', {
      command: 'printf "diagnostic-before-timeout\\n"; sleep 10',
      timeout: 0.1,
    }, undefined, undefined, { cwd: tmpdir() } as Parameters<typeof tool.execute>[4])
    await expect(result).rejects.toThrow('diagnostic-before-timeout')
    await expect(result).rejects.toThrow('timed out')
  })

  test('Given Shell 异常退出 When 返回结果 Then 不将非零退出码当成功', async () => {
    const operations = withDefaultShellTimeout(createLocalBashOperations())
    expect(await operations.exec('exit 7', tmpdir(), { onData() {} })).toEqual({ exitCode: 7 })
  })

  test('Given WSL Shell 已退出但后代持有管道 When 等待结束 Then 有界结算而不是永久等待 close', async () => {
    let descendantPid: number | undefined
    const launch = () => spawn(process.execPath, ['-e', `
      const { spawn } = require('node:child_process');
      const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
        detached: true, stdio: ['ignore', 1, 2]
      });
      console.log(child.pid);
      child.unref();
    `], { stdio: ['ignore', 'pipe', 'pipe'] })
    const operations = createWslBashOperations({ shellKind: 'wsl', env: {} }, launch)
    const started = performance.now()
    try {
      const result = await operations.exec('ignored', tmpdir(), {
        timeout: 0.5,
        onData(data) { descendantPid = Number(data.toString().trim()) },
      })
      expect(result.exitCode).toBe(0)
      expect(performance.now() - started).toBeLessThan(1_500)
    } finally {
      if (descendantPid) process.kill(descendantPid, 'SIGKILL')
    }
  }, 3_000)

  test('Given WSL 子进程拒绝 SIGTERM When 超时 Then 结算失败并最终终止进程', async () => {
    const child = spawn(process.execPath, ['-e', `
      process.on('SIGTERM', () => {});
      console.log('ready');
      setInterval(() => {}, 1000);
    `], { stdio: ['ignore', 'pipe', 'pipe'] })
    const launch = () => child
    const operations = createWslBashOperations({ shellKind: 'wsl', env: {} }, launch)
    let diagnostic = ''
    try {
      await expect(operations.exec('ignored', tmpdir(), {
        timeout: 0.2,
        onData(data) { diagnostic += data.toString() },
      })).rejects.toThrow('timeout:0.2')
      expect(diagnostic).toContain('ready')
      if (child.exitCode === null && child.signalCode === null) {
        await new Promise<void>((resolve) => child.once('exit', () => resolve()))
      }
      expect(child.signalCode).not.toBeNull()
    } finally {
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
    }
  }, 3_000)

  test('Given 执行前已取消 When 调用 WSL Then 不启动进程', async () => {
    let spawned = false
    const launch = () => { spawned = true; throw new Error('不应启动') }
    const controller = new AbortController()
    controller.abort()
    await expect(createWslBashOperations({ shellKind: 'wsl', env: {} }, launch).exec('ignored', tmpdir(), {
      signal: controller.signal, onData() {},
    })).rejects.toThrow('aborted')
    expect(spawned).toBe(false)
  })
})
