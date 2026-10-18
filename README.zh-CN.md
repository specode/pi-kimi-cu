# pi-kimi-cu

[English](./README.md) | [简体中文](./README.zh-CN.md)

在 macOS 上为 [Pi](https://github.com/earendil-works/pi-mono) 一键安装并接入 [Kimi Computer Use](https://www.kimi.com/)（`KimiCU.app`）——无需依赖 Kimi Code，即可让 Pi 查看并操作 macOS 桌面应用（点击、输入、滚动、拖拽与窗口截图）。

- **交互式引导配置**：执行 `/kimi-cu` 即可自动排查环境缺口，按需完成 `KimiCU.app` 下载安装、后台服务启动、系统权限引导与 MCP 配置写入。
- **原生接入 Pi MCP**：直接使用 Pi 内置的 MCP 客户端，无需安装任何第三方 adapter 插件。
- **自带桌面控制 Skill**：内置 `kimi-cu` 技能说明，连接成功后 AI 即可按规范操作 macOS 图形界面。
- **签名校验与安全回滚**：安装前严格校验 Bundle ID、`arm64` 架构、开发者 Team ID 与 `codesign` 签名，并在临时目录完成原子替换与故障回滚。

---

## 前置依赖

- **Apple Silicon Mac**（`arm64`）
- **macOS 14 (Sonoma)** 及以上版本
- **[Pi](https://pi.dev) >= 0.99.0**，并启用内置 MCP（推荐 `1.0.2` 及以上版本）
- **Node.js >= 22.19.0**

> **正在使用旧版 Pi（`< 0.99.0`）？** `2.x` 版本仅支持 Pi 内置 MCP。若使用旧版 Pi + `pi-mcp-adapter`，请固定安装 `1.0.0`：
> ```bash
> pi install npm:@specode/pi-kimi-cu@1.0.0
> ```

---

## 安装

从 npm 安装：

```bash
pi install npm:@specode/pi-kimi-cu
```

或从 GitHub 安装：

```bash
pi install git:github.com/specode/pi-kimi-cu
```

从本地目录安装：

```bash
pi install ~/Code/pi-kimi-cu
```

---

## 快速开始

1. **安装后重启 Pi**，执行命令打开交互式向导：

```text
/kimi-cu
```

2. **跟随向导补齐缺失项**（`/kimi-cu setup`）：
   - **未安装 App** → 自动从 Moonshot AI 官方 CDN 下载、验签并安装 `KimiCU.app`。
   - **后台服务未运行** → 注册并启动 `launchd` 后台服务。
   - **缺少系统权限** → 自动打开 `KimiCU.app`，引导你在官方界面中开启 **辅助功能 (Accessibility)** 与 **屏幕录制 (Screen Recording)** 权限。
   - **未配置 MCP** → 自动将 `kimi-cu` 写入 `~/.pi/agent/mcp.json` 并提示执行 `/reload`。

3. **确认 MCP 实时连接状态**：

```text
/mcp
```

连接就绪后，直接用自然语言向 Pi 下达桌面任务即可，例如：*“帮我截一下 iOS 模拟器的窗口，然后点击登录按钮。”*

---

## 命令与 MCP 配置

### 常用命令

| 命令 | 说明 |
| --- | --- |
| `/kimi-cu` | 打开交互菜单：选择检查状态或进入引导配置 |
| `/kimi-cu status` | 检查系统架构、`KimiCU.app`、后台服务、系统权限及本地 MCP 配置状态 |
| `/kimi-cu setup` | 针对未就绪的环节执行分步引导安装与配置 |
| `/kimi-cu mcp` | 选择将 MCP 配置写入全局（`~/.pi/agent/mcp.json`）、当前受信任项目（`.pi/mcp.json`）或仅展示 JSON 片段 |

### 手动配置片段

默认写入 `~/.pi/agent/mcp.json`（自动遵循 `PI_CODING_AGENT_DIR` 环境变量）：

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

- **工具暴露方式**：在默认的 `codemode` 模式下，Agent 会通过 `searchTools()` 按需发现桌面操作工具；若希望直接声明全部工具，可在 `/mcp` 面板中将其切换为 `direct`。
- **项目级覆盖**：Pi `>= 1.0.1` 支持在受信任项目的 `.pi/mcp.json` 中仅覆盖 `enabled`、`exposure` 或 `toolExposure`；`0.99.x` / `1.0.0` 则需编写完整的 server 定义。如需禁用服务，请设置 `"enabled": false`。

---

## 设计思路与安全边界

### 非破坏性配置保护

`/kimi-cu mcp` 在写入配置时遵循“绝不静默覆盖用户自定义配置”的原则：

- 遇到损坏的 JSON 文件、旧版 `mcp-servers` 字段、旧版 `disabled` 字段、同名自定义服务或命名空间冲突（如 `kimi_cu`）时会立即中止并给出提示，保留原文件不变。
- 当全局配置已存在 `kimi-cu` 条目时，不会在项目中新建完整同名定义，防止静默覆盖全局继承的禁用状态或工具权限限制（请直接使用 `/mcp` 调整）。
- 状态诊断与实际生效配置分离：单层配置文件的语法错误不会掩盖另一层的有效定义。

### 安全与隐私边界

- **安装前严格验签**：`KimiCU.app` 从 Moonshot AI 官方 CDN 下载至临时目录后，会依次校验 Bundle ID、`arm64` 架构、签名 Team ID 并执行严格的 `codesign` 验证；验签失败默认直接中止安装。
- **权限完全由用户掌控**：辅助功能与屏幕录制权限均交由官方 `KimiCU.app` 窗口引导授权，本扩展绝不在后台私自修改 macOS 系统权限开关。
- **真实状态反馈**：`/kimi-cu status` 仅反映本地安装与配置文件状态，不会将“配置文件存在”误报为“服务已连接”；实时连接状态以 Pi 内置 `/mcp` 为准。

---

## 从 v1.x（`pi-mcp-adapter`）迁移

如果你此前使用过基于 `pi-mcp-adapter` 的 `1.x` 版本：

1. 备份旧配置后卸载 `pi-mcp-adapter`，或在 `pi config` 中将其禁用（注册了 `/mcp` 的第三方 adapter 会阻止 Pi 内置 MCP 接管）。
2. 将需要保留的服务器手动迁移到 `~/.pi/agent/mcp.json` 的 `"mcpServers"` 下；注意将旧字段 `"disabled": true` 改为 `"enabled": false` 并移除 `disabled`。
3. 执行 `/reload`，通过内置 `/mcp` 检查 `kimi-cu` 连接状态（若内置 MCP 未开启，请先在 `pi config` 的 **Built-in** 中启用）。

---

## 本地开发

```bash
npm run check
```

## 许可证

[MIT](./LICENSE)
