# pi-kimi-cu

[English](./README.md) | [简体中文](./README.zh-CN.md)

A [Pi](https://github.com/earendil-works/pi-mono) extension and skill for macOS that installs [Kimi Computer Use](https://www.kimi.com/) (`KimiCU.app`) and connects it to Pi's built-in MCP client so Pi can inspect and control desktop apps.

`/kimi-cu status` output:

```text
KimiCU 本地环境 / Local setup: ready
平台 / Platform: darwin/arm64 · macOS 15.4
App: 已安装 / installed · v0.1.0
后台服务 / Service: 运行中 / running
权限 / Permissions: 辅助功能、屏幕录制均已授权 / Accessibility & Screen Recording granted
MCP 配置 / MCP config: ~/.pi/agent/mcp.json
MCP 连接与工具状态 / Connection and tool status: 请使用 Pi 内置 /mcp 检查 / check Pi's built-in /mcp
```

## Requirements

- Apple Silicon Mac (`arm64`) running macOS 14 (Sonoma) or later
- [Pi](https://pi.dev) >= 0.99.0 with built-in MCP enabled (1.0.2 or later recommended)
- Node.js >= 22.19.0

For Pi versions before 0.99.0 with `pi-mcp-adapter`, install `npm:@specode/pi-kimi-cu@1.0.0`.

## Installation

From npm:

```bash
pi install npm:@specode/pi-kimi-cu
```

From GitHub:

```bash
pi install git:github.com/specode/pi-kimi-cu
```

From a local directory for development:

```bash
pi install /path/to/pi-kimi-cu
```

Restart Pi after installing.

## Usage

1. Run `/kimi-cu` (or `/kimi-cu setup`) to start the guided setup.
2. The setup guide checks what is missing and asks before each step:
   - Downloads and verifies `KimiCU.app` from Moonshot AI's CDN if `/Applications/KimiCU.app` is not installed.
   - Registers and starts the `launchd` background service (`ai.kimi.cu.service`) if it is not running.
   - Opens `KimiCU.app` so you can grant Accessibility and Screen Recording permissions in macOS System Settings.
   - Writes the `kimi-cu` entry to `~/.pi/agent/mcp.json` and offers to run `/reload`.
3. Run `/mcp` to verify the live MCP connection. Once connected, ask Pi to operate macOS apps (click, type, scroll, drag, or capture window screenshots).

### Commands

| Command | Description |
| --- | --- |
| `/kimi-cu` | Open the menu to check status or run guided setup |
| `/kimi-cu status` | Check platform, `KimiCU.app`, `launchd` service, macOS permissions, and local MCP config |
| `/kimi-cu setup` | Walk through installing and configuring any missing parts |
| `/kimi-cu mcp` | Write MCP config to `~/.pi/agent/mcp.json` (global), `.pi/mcp.json` (trusted project), or view the JSON snippet |

## Configuration

`/kimi-cu mcp` writes the following server entry to `~/.pi/agent/mcp.json` (following `PI_CODING_AGENT_DIR`):

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

- With Pi's default `codemode` exposure, the agent discovers KimiCU tools through `searchTools()`. You can switch `kimi-cu` to `direct` exposure in `/mcp` if you want the tools declared directly.
- On Pi 1.0.1 or later, `.pi/mcp.json` in a trusted project can override `enabled`, `exposure`, or `toolExposure` on its own; on Pi 0.99.x and 1.0.0, use a full server entry. Set `"enabled": false` to disable the server.

### Migrating from v1.x (`pi-mcp-adapter`)

1. Back up your old adapter configuration, then uninstall `pi-mcp-adapter` or disable it in `pi config` (an active adapter registering `/mcp` blocks Pi's built-in MCP).
2. Move your servers into `~/.pi/agent/mcp.json` under `"mcpServers"`. Replace any `"disabled": true` with `"enabled": false` and remove `disabled`.
3. Run `/reload` and check `kimi-cu` in `/mcp` (if built-in MCP is off, enable it under **Built-in** in `pi config`).

## Privacy and Safety

- `KimiCU.app` is downloaded only from Moonshot AI's official CDN (`https://cdn.kimi.com/kimi-computer-use/latest/KimiCU.app.zip`) after you confirm the prompt.
- Before replacing `/Applications/KimiCU.app`, the installer checks the bundle ID (`ai.kimi.cu`), `arm64` binary architecture, Apple Developer Team ID (`2J9472RW75`), and `codesign` signature in a temporary staging directory, rolling back on failure.
- Accessibility and Screen Recording permissions are granted by you in the official `KimiCU.app` window and macOS System Settings; the extension never modifies TCC permission databases.
- `/kimi-cu mcp` refuses to overwrite malformed JSON files, legacy `mcp-servers` or `disabled` fields, custom same-named servers, or `kimi_cu` namespace conflicts, and does not write a duplicate project entry when a global `kimi-cu` entry already exists.
- `/kimi-cu status` reports local installation and config file state only; use `/mcp` for live MCP connection status.

## Development

```bash
# Syntax-check and run tests
npm run check

# Check package contents
npm run pack:check
```

## License

[MIT](./LICENSE).
