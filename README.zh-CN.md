# pi-kimi-cu

[English](./README.md) | [简体中文](./README.zh-CN.md)

一个 macOS 上的 [Pi](https://github.com/earendil-works/pi-mono) 扩展与技能包：安装 [Kimi Computer Use](https://www.kimi.com/)（`KimiCU.app`）并接入 Pi 内置的 MCP 客户端，让 Pi 查看和操作桌面应用。

`/kimi-cu status` 输出示例：

```text
KimiCU 本地环境 / Local setup: ready
平台 / Platform: darwin/arm64 · macOS 15.4
App: 已安装 / installed · v0.1.0
后台服务 / Service: 运行中 / running
权限 / Permissions: 辅助功能、屏幕录制均已授权 / Accessibility & Screen Recording granted
MCP 配置 / MCP config: ~/.pi/agent/mcp.json
MCP 连接与工具状态 / Connection and tool status: 请使用 Pi 内置 /mcp 检查 / check Pi's built-in /mcp
```

## 环境要求

- Apple Silicon Mac（`arm64`），系统版本 macOS 14 (Sonoma) 及以上
- [Pi](https://pi.dev) >= 0.99.0，并开启内置 MCP（推荐 1.0.2 及以上版本）
- Node.js >= 22.19.0

如果使用的是 Pi 0.99.0 以前的版本并搭配 `pi-mcp-adapter`，请安装 `npm:@specode/pi-kimi-cu@1.0.0`。

## 安装

从 npm 安装：

```bash
pi install npm:@specode/pi-kimi-cu
```

从 GitHub 安装：

```bash
pi install git:github.com/specode/pi-kimi-cu
```

从本地目录安装（开发调试）：

```bash
pi install /path/to/pi-kimi-cu
```

安装后重启 Pi 生效。

## 使用说明

1. 执行 `/kimi-cu`（或 `/kimi-cu setup`）进入引导配置。
2. 向导会依次检查以下环节，并在每一步操作前先询问确认：
   - 若未安装 `/Applications/KimiCU.app`，从 Moonshot AI 官方 CDN 下载并验签安装。
   - 若 `launchd` 后台服务（`ai.kimi.cu.service`）未运行，注册并启动该服务。
   - 若未授予系统权限，打开 `KimiCU.app`，由你在官方窗口和系统设置中开启辅助功能（Accessibility）与屏幕录制（Screen Recording）权限。
   - 将 `kimi-cu` 写入 `~/.pi/agent/mcp.json`，并询问是否立即执行 `/reload`。
3. 执行 `/mcp` 查看 MCP 实时连接状态。连接就绪后，即可直接让 Pi 操作桌面应用（点击、输入、滚动、拖拽或截取窗口画面）。

### 命令

| 命令 | 说明 |
| --- | --- |
| `/kimi-cu` | 打开菜单，选择检查状态或运行引导配置 |
| `/kimi-cu status` | 检查系统架构、`KimiCU.app`、后台服务、系统权限及本地 MCP 配置文件状态 |
| `/kimi-cu setup` | 按步骤引导安装和配置缺失的组件 |
| `/kimi-cu mcp` | 将 MCP 配置写入 `~/.pi/agent/mcp.json`（全局）、`.pi/mcp.json`（受信任项目）或仅查看 JSON 片段 |

## 配置

`/kimi-cu mcp` 默认向 `~/.pi/agent/mcp.json`（跟随 `PI_CODING_AGENT_DIR`）写入以下配置：

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

- 在默认的 `codemode` 暴露方式下，Agent 通过 `searchTools()` 按需查找 KimiCU 工具；如果希望直接声明所有工具，可在 `/mcp` 中将其改为 `direct`。
- 在 Pi 1.0.1 及以上版本中，受信任项目的 `.pi/mcp.json` 可以只覆盖 `enabled`、`exposure` 或 `toolExposure`；Pi 0.99.x 和 1.0.0 需写入完整服务定义。如需禁用服务，可设置 `"enabled": false`。

### 从 v1.x（`pi-mcp-adapter`）迁移

1. 备份旧配置后卸载 `pi-mcp-adapter`，或在 `pi config` 中将其禁用（注册了 `/mcp` 的第三方 adapter 会阻止 Pi 内置 MCP 接管）。
2. 将需要保留的服务迁移到 `~/.pi/agent/mcp.json` 的 `"mcpServers"` 下，把旧字段 `"disabled": true` 改为 `"enabled": false` 并删掉 `disabled`。
3. 执行 `/reload`，在内置 `/mcp` 中检查 `kimi-cu` 连接状态（如未开启内置 MCP，先在 `pi config` 的 **Built-in** 中启用）。

## 隐私与安全

- 仅在你确认后从 Moonshot AI 官方 CDN（`https://cdn.kimi.com/kimi-computer-use/latest/KimiCU.app.zip`）下载 `KimiCU.app`。
- 替换 `/Applications/KimiCU.app` 前，安装器会在临时目录中依次校验 Bundle ID（`ai.kimi.cu`）、`arm64` 架构、开发者 Team ID（`2J9472RW75`）和 `codesign` 签名，失败时自动回滚。
- 辅助功能与屏幕录制权限均由你在官方 `KimiCU.app` 窗口和 macOS 系统设置中手动授权，本扩展不会私自修改系统 TCC 权限库。
- `/kimi-cu mcp` 遇到损坏的 JSON、旧版 `mcp-servers` 或 `disabled` 字段、同名自定义服务或 `kimi_cu` 命名空间冲突时会直接中止，保留原文件不变；全局已存在 `kimi-cu` 时也不会在项目中重复写入完整定义。
- `/kimi-cu status` 只报告本地安装与配置文件状态，实时连接状态以 Pi 内置 `/mcp` 为准。

## 本地开发

```bash
# 语法检查并运行测试
npm run check

# 检查打包文件列表
npm run pack:check
```

## 许可证

[MIT](./LICENSE)。
