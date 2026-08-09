# pi-kimi-cu

[English](./README.md)

面向 Pi 的轻量级 [Kimi Computer Use](https://www.kimi.com/) 安装与接入包，跑在 macOS 上，不依赖 Kimi Code。

## 能做什么

- `/kimi-cu`：两个入口——检查状态、引导配置
- 安全安装 `KimiCU.app`：下到临时目录、校验、带回滚替换，再清理现场
- 注册 launchd 后台服务；权限交给官方 KimiCU App 窗口处理
- 可选安装 [`pi-mcp-adapter`](https://www.npmjs.com/package/pi-mcp-adapter)
- MCP 接入：引导配置走默认 Pi 路径；需要时可用 `/kimi-cu mcp` 选其他方式
- 一份接好后给 Pi 用的 KimiCU skill

## 环境要求

- Apple Silicon Mac
- macOS 14 及以上
- [Pi](https://pi.dev)
- Node.js 20+

## 安装

从 npm：

```bash
pi install npm:@specode/pi-kimi-cu
```

从 git：

```bash
pi install git:github.com/specode/pi-kimi-cu
```

本地目录：

```bash
pi install ~/Code/pi-kimi-cu
```

重启 Pi，然后执行：

```text
/kimi-cu
```

可用命令：

```text
/kimi-cu status   # 检查状态
/kimi-cu setup    # 引导配置
```

## 交互说明

1. **检查状态**：平台、App、后台服务、权限、MCP 配置与运行状态。
2. **引导配置**：按缺口逐步处理——
   - App 未安装 → 询问是否下载安装
   - 后台服务未运行 → 询问是否注册启动
   - 权限未齐 → 打开 KimiCU App，请你在官方窗口里确认 Accessibility / Screen Recording
   - MCP 未配置 → 询问是否写入默认 Pi MCP 配置
   - MCP 未连接 → 询问是否 `/reload`

## MCP

推荐走 `pi-mcp-adapter`。引导配置时若缺失会先询问是否安装：

```bash
pi install npm:pi-mcp-adapter
```

需要自定义路径或只看配置片段时：

```text
/kimi-cu mcp
```

通用片段：

```json
{
  "mcpServers": {
    "kimi-cu": {
      "command": "/Applications/KimiCU.app/Contents/MacOS/kimi-cu",
      "args": ["mcp"]
    }
  }
}
```

扩展只会迁移它能明确认出的旧版 KimiCU 配置。碰到同名自定义 server、损坏的 JSON，或读不了的文件时会停下来，不会覆盖原内容。

## 安全说明

App 从 Moonshot AI 官方 CDN 下载。安装前会检查 Bundle ID、arm64 架构、签名 Team ID，并做严格 `codesign` 校验。签名校验失败时默认中止；只有你在交互提示里明确确认后才会继续。

辅助功能和屏幕录制由官方 KimiCU App 引导授权，本包不会代你拨动系统开关。

## 开发检查

```bash
npm run check
```

## 许可证

MIT
