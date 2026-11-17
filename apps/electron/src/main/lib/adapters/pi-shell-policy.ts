import type { BashOperations } from '@earendil-works/pi-coding-agent'

export const DEFAULT_SHELL_TIMEOUT_SECONDS = 300

/** 在执行后端设默认值，模型和程序化工具调用均生效；显式参数仍由 Pi 校验。 */
export function withDefaultShellTimeout(operations: BashOperations): BashOperations {
  return {
    exec(command, cwd, options) {
      return operations.exec(command, cwd, {
        ...options,
        timeout: options.timeout ?? DEFAULT_SHELL_TIMEOUT_SECONDS,
      })
    },
  }
}
