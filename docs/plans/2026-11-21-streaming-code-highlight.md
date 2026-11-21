# 流式代码高亮实施计划

> 分步实施并验证；如转交独立会话，使用 `executing-plans`。

**目标：** 让 80ms 节流约束 Shiki 的计算，而不仅是 React 状态更新。

**架构：** 保留现有 Markdown 与 Shiki 接口。代码块在高亮器就绪后调度计算，输入变化时取消上一次等待；旧结果仅可用于追加场景中未变动的行。

**技术栈：** React、TypeScript、Shiki、Bun。

1. 在 `packages/ui/src/code-block/code-highlight-schedule.test.ts` 验证节流期内没有计算、取消后不提交旧输入、初始化前注销回调；用排队回调模拟时钟。
2. 在 `packages/ui/src/code-block/code-highlight-schedule.ts` 实现可取消的调度。`CodeBlock.tsx` 保留最新输入对应的高亮快照，无匹配 token 时直接渲染原文。
3. 递增 `packages/ui/package.json` 与 `apps/electron/package.json` 的 patch 版本。运行 `bun test packages/ui/src/code-block/code-highlight-schedule.test.ts` 和 `git diff --check`，不编译或打包。

本阶段不替换 Markdown 渲染器、不实现 Shiki 语法状态增量复用。实际 Renderer CPU 收益用同一段长代码流式输出做前后对照。
