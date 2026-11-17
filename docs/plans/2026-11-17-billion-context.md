# billion-context 分批接入 Implementation Plan

> 本轮在当前已确认的开发分支直接实施；不编译、不安装、不提交、不推送。不依赖未安装的 superpowers 执行技能。

**Goal:** 为 Proma 的 Pi Agent 提供默认关闭、可撤销的 billion-context 本地代理接入。

**Architecture:** 使用 Pi 1.5.2 的请求级 `fetch`，而不是全局 fetch、MITM 或用户 Pi 插件。仅重路由模型 HTTP 请求；保留渠道配置、认证、原始 JSONL、权限和工具输出预算。独立 JSON 配置经原子写入保存，IPC 四层契约完整接通。

**Tech Stack:** Bun、TypeScript、Pi 1.5.2、undici、Electron IPC、React、Jotai。

## 第一批：显式接入已有本地代理

### 1. 配置与代理契约
- 新增 `packages/shared/src/types/billion-context.ts` 并从 `types/index.ts` 导出。
- 新增 `apps/electron/src/main/lib/billion-context-settings-service.ts`。
- 配置：`{ enabled: false, proxyUrl: "http://127.0.0.1:8787" }`。
- 仅允许 HTTP loopback origin；拒绝凭据、远端地址、路径、query 和 fragment。
- 缺失配置使用默认值；损坏配置明确报错，不静默绕过用户启用状态。
- 测试使用临时目录，不读取或改写真实配置。

### 2. 请求级 Pi 接入
- 新增 `apps/electron/src/main/lib/adapters/pi-billion-context.ts`。
- 修改 `apps/electron/src/main/lib/adapters/pi-agent-adapter.ts`。
- 每个已保存 Pi session 使用稳定的 `proma:<Pi session UUID>`。
- HTTP 请求重路由到 `<proxy>/bili/<完整原请求 URL>`。
- 使用 `x-acp-session`，不发送会切换原生插件模式的 `x-bili-plugin`。
- 请求开始前检查 `/__bili/health`，上报 `/__bili/plugin/runtime-info` 中的真实模型窗口和输出上限。
- 管理端响应有超时和体积预算；API 请求不截断 SSE，原样传递认证、body、signal。
- 使用独立直连 dispatcher，避免本地代理再进入用户的网络代理；关闭时释放连接。
- 启用时禁用 Pi 自动压缩及 CompactContext 工具，手动 Pi 压缩给出明确提示。
- 支持 `anthropic-messages`、`openai-completions`、`openai-responses`；订阅 OAuth 和其他协议暂时拒绝，不能假装接入。

### 3. 设置界面
- 修改 `apps/electron/src/main/ipc.ts` 与 `apps/electron/src/preload/index.ts`。
- 新增 Jotai atoms 与 `BillionContextSettings.tsx`，挂到现有代理设置页。
- 提供开关、地址、显式保存和连通性测试；保存失败不能乐观保持成功状态。
- 提醒先自行启动 `bili start`；不自动启动、不修改全局环境或 Pi 配置。
- 署名：本接入使用 [billion-context](https://github.com/ranxianglei/billion-context)；设置页保留同一链接。

### 4. 离线验证
- 新增配置与请求契约测试，覆盖缺失/损坏配置、持久化、URL 校验、模式互斥、身份隔离、头/body 保留、取消、错误和响应预算。
- 使用本地模拟服务及真实 Pi HTTP provider 验证请求实际经过注入的 fetch；不调用真实模型、不产生费用。
- 执行 `bun test` 仅限相关测试文件，然后 `bun run typecheck`；记录已有类型错误，不扩大修复范围。
- 检查 `git diff --check`。
- 应用 patch 版本 `0.19.62 -> 0.19.63`；共享类型 patch `0.1.73 -> 0.1.74`。

## 后续批次
- 安装真实 billion-context 发布包后，验证实际 compress/decompress、跨重启恢复、长对话窗口和缓存命中。
- 再决定受管代理启动与退出、状态与缓存统计 UI、订阅 OAuth/WSL 接入。
- 不导入 Pi 原生插件及其默认 delegate 工具，不叠加两个压缩器。
- 不承诺固定 Token 节省比例；以真实请求、压缩记录和缓存命中统计为准。

## 第一批验证记录

- 已完成独立配置、请求适配器、Pi 生命周期、IPC 和设置页源码接入。
- 定向离线回归：7 个文件、85 个测试通过，覆盖本轮配置/请求和已有中断、运行时、Bash、输出预算、浏览器策略。
- Node 22.22.0 源码冒烟通过：真实 Pi AgentSession 请求经过独立 undici fetch，保留认证和会话标识，解析本地模拟 OpenAI SSE。测试将全局 fetch 设为抛错，未调用真实模型。
- 核对 Pi 1.5.2 原生实现：自动阈值和溢出压缩均在 `settings.enabled === false` 时提前返回。Proma 手动压缩入口在启用接入时拒绝，CompactContext 工具和本地压缩 hooks 不注册。
- `git diff --check` 通过。类型检查仍失败于既存的三个 ProviderType 问题：`pi-provider-compat.ts`、`channel-manager.ts`、`model-logo.ts`；本轮新增源码没有类型诊断。
- 尚未进行设置页运行时界面验证，也未安装真实 billion-context 或验证实际压缩、解压、跨重启恢复和缓存命中。
- 未编译、打包、提交或推送。现有 `0.19.62` 的 Proma.app 不包含本轮 `0.19.63` 源码改动。
