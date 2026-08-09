# pi-kimi-cu

面向 Pi 的轻量级 Kimi Computer Use 安装与接入包，不依赖 Kimi Code。

它提供：

- `/kimi-cu` 安装、更新、修复和分层状态检测；
- `KimiCU.app` 临时下载、验证、带回滚替换及临时目录清理；
- launchd 后台服务注册和 macOS 权限引导；
- 可选安装 `pi-mcp-adapter`；
- Pi 专用、通用全局、自定义路径和手动片段四种 MCP 配置方式；
- 一份为 Pi 编写的 KimiCU 使用 skill。

## 要求

- Apple Silicon Mac；
- macOS 14 或更高版本；
- Pi；
- Node.js 20 或更高版本。

## 安装

从本地目录安装：

```bash
pi install ~/Code/pi-kimi-cu
```

然后重启 Pi，运行：

```text
/kimi-cu
```

也可以直接使用：

```text
/kimi-cu status
/kimi-cu install
/kimi-cu repair
/kimi-cu update
/kimi-cu mcp
/kimi-cu permissions
```

## MCP

推荐使用 `pi-mcp-adapter`。如果尚未安装，`/kimi-cu mcp` 会先询问，再运行：

```bash
pi install npm:pi-mcp-adapter
```

使用其他 MCP adapter 时，可以选择写入 `~/.config/mcp/mcp.json`、指定其他 JSON 文件，或只显示以下标准配置片段：

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

扩展只会迁移自己能够明确识别的旧版 KimiCU 配置。遇到同名自定义 server、损坏的 JSON 或无法读取的文件时会停止，不会覆盖原内容。

## 安全说明

App 下载自 Moonshot AI 的官方 CDN。安装前会检查 Bundle ID、arm64 架构、签名 Team ID，并运行严格的 `codesign` 校验。签名校验失败时默认中止；只有用户在交互提示中明确确认后才会继续。

系统的辅助功能和屏幕录制权限必须由用户在 macOS 系统设置中手动授予。

## 开发检查

```bash
npm run check
```
