# pi-kimi-cu

[English](./README.md)

面向 Pi 的轻量级 [Kimi Computer Use](https://www.kimi.com/) 安装与接入包，跑在 macOS 上，不依赖 Kimi Code。

## 能做什么

- `/kimi-cu`：安装、更新、修复，以及分层状态检测
- 安全安装 `KimiCU.app`：下到临时目录、校验、带回滚替换，再清理现场
- 注册 launchd 后台服务，并引导 macOS 权限
- 可选安装 [`pi-mcp-adapter`](https://www.npmjs.com/package/pi-mcp-adapter)
- 四种 MCP 接入方式：Pi 专用、全局配置、自定义路径，或只给可复制片段
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
/kimi-cu status
/kimi-cu install
/kimi-cu repair
/kimi-cu update
/kimi-cu mcp
/kimi-cu permissions
```

## MCP

推荐走 `pi-mcp-adapter`。如果还没装，`/kimi-cu mcp` 会先问你，再执行：

```bash
pi install npm:pi-mcp-adapter
```

用别的 MCP adapter 时，可以写入 `~/.config/mcp/mcp.json`、指定其他 JSON 文件，或直接复制下面这段：

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

辅助功能和屏幕录制必须你在「系统设置」里手动授权，这个包没法替你打开。

## 开发检查

```bash
npm run check
```

## 许可证

MIT
