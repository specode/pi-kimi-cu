# pi-kimi-cu

[English](./README.md)

面向 Pi 的轻量级 [Kimi Computer Use](https://www.kimi.com/) 安装与接入包，跑在 macOS 上，不依赖 Kimi Code。

## 能做什么

- `/kimi-cu`：两个入口——检查状态、引导配置
- 安全安装 `KimiCU.app`：下到临时目录、校验、带回滚替换，再清理现场
- 注册 launchd 后台服务；权限交给官方 KimiCU App 窗口处理
- 使用 Pi 内置 MCP，不安装或依赖第三方 adapter
- 引导配置写入 Pi 全局配置；`/kimi-cu mcp` 可选择全局、当前可信项目或只显示片段
- 一份接好后给 Pi 用的 KimiCU skill

## 环境要求

- Apple Silicon Mac
- macOS 14 及以上
- [Pi](https://pi.dev) **>=0.99.0**，并启用内置 MCP（推荐 1.0.2 或更新版本）
- Node.js >=22.19.0

本包 **2.x** 仅支持内置 MCP。旧版 Pi（<0.99.0）请固定使用旧插件，不要升级到 2.x：

```bash
pi install npm:@specode/pi-kimi-cu@1.0.0
```

旧插件的 adapter 接入方式保持不变；本包不会自动降级或安装旧 adapter。

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
   - 配置写入后 → 询问是否 `/reload`；连接状态以 Pi 内置 `/mcp` 为准

## MCP

默认使用 `~/.pi/agent/mcp.json`（遵从 `PI_CODING_AGENT_DIR`），可信项目可使用 `.pi/mcp.json`。不再读取 adapter 的共享路径、项目 `.mcp.json` 或 `--mcp-config`。

从旧版迁移：

1. 先备份旧 adapter 配置。现在可以自行卸载 `pi-mcp-adapter`，或在 `pi config` 中禁用它，改用 Pi 内置 MCP；注册了 `/mcp` 的 adapter 会阻止内置 MCP 接管。
2. 自行把需要保留的服务器复制到 Pi 的 `mcp.json`，放在 `mcpServers` 下，并调整 adapter 专用字段：尤其要把 `disabled: true` 改为 `enabled: false`，删除旧 `disabled` 字段，不要原样复制 `mcp-servers`。
3. 本包不自动迁移、卸载或删除任何旧配置。`/kimi-cu mcp` 只添加缺失的 KimiCU 条目或展示片段；遇到旧配置会保留原文件并提示手动处理。
4. 完成上述操作后再 `/reload`，在内置 `/mcp` 中确认 `kimi-cu` 的启用状态、连接和工具暴露方式；内置 MCP 被禁用时，先在 `pi config` 的 Built-in 中启用。

`/kimi-cu status` 只检查本地环境和配置，不把配置存在或工具已注册误报为“已连接”。默认 `codemode` 暴露方式下通过 `searchTools()` 发现工具；也可在 `/mcp` 中改为 `direct`。

Pi >=1.0.1 支持项目仅覆盖 `enabled`、`exposure`、`toolExposure`；0.99.x/1.0.0 请使用完整项目定义。禁用请用 `enabled: false`。已有原生设置和命令参数保持不变，旧字段不会被自动转换。

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

写入配置时，遇到旧 `mcp-servers`、KimiCU 的 `disabled` 字段、同名自定义 server、`kimi_cu` 等命名空间冲突，或损坏、不可读的目标文件都会停止，不覆盖原内容；冲突检查也覆盖生效的全局配置和可信项目配置。如果全局已有同名条目，也不会新建完整项目定义，以免静默覆盖继承的禁用状态、工具限制或其他设置；请在 `/mcp` 中明确调整，全局 JSON 或根节点、服务器映射结构无效时，也会先停止创建项目定义，要求修复；已有项目条目保持不变。状态检测会把诊断与有效配置分开：损坏的文件或非法服务器字段不会遮蔽另一层的有效定义；合法的自定义项目服务器仍优先于全局配置，并报告冲突。

## 安全说明

App 从 Moonshot AI 官方 CDN 下载。安装前会检查 Bundle ID、arm64 架构、签名 Team ID，并做严格 `codesign` 校验。签名校验失败时默认中止；只有你在交互提示里明确确认后才会继续。

辅助功能和屏幕录制由官方 KimiCU App 引导授权，本包不会代你拨动系统开关。

## 开发检查

```bash
npm run check
```

## 许可证

MIT
