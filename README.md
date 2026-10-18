# pi-kimi-cu

[English](./README.md) | [简体中文](./README.zh-CN.md)

Install and wire up [Kimi Computer Use](https://www.kimi.com/) (`KimiCU.app`) for [Pi](https://github.com/earendil-works/pi-mono) on macOS — so Pi can inspect and operate desktop apps (click, type, scroll, drag, and capture screenshots) without requiring Kimi Code.

- **Guided one-command setup** — `/kimi-cu` checks what is missing and walks you through installing `KimiCU.app`, starting the background service, granting macOS permissions, and writing MCP configuration.
- **Native Pi MCP integration** — uses Pi's built-in MCP client with zero third-party adapter dependencies.
- **Built-in Computer Use skill** — bundles a ready-to-use `kimi-cu` skill so Pi knows how to operate macOS GUI applications out of the box.
- **Verified & rollback-safe installer** — validates Bundle ID, `arm64` architecture, Apple Developer Team ID, and `codesign` signatures before replacing any existing app bundle.

---

## Requirements

- **Apple Silicon Mac** (`arm64`)
- **macOS 14 (Sonoma)** or later
- **[Pi](https://pi.dev) >= 0.99.0** with built-in MCP enabled (`>= 1.0.2` recommended)
- **Node.js >= 22.19.0**

> **Using an older Pi (`< 0.99.0`)?** Version `2.x` supports Pi's built-in MCP only. For legacy adapter-based support on older Pi releases, pin `1.0.0`:
> ```bash
> pi install npm:@specode/pi-kimi-cu@1.0.0
> ```

---

## Installation

Install from npm:

```bash
pi install npm:@specode/pi-kimi-cu
```

Or install from GitHub:

```bash
pi install git:github.com/specode/pi-kimi-cu
```

From a local checkout:

```bash
pi install ~/Code/pi-kimi-cu
```

---

## Quick Start

1. **Restart Pi** after installing, then launch the interactive assistant:

```text
/kimi-cu
```

2. **Follow the guided setup** (`/kimi-cu setup`):
   - **App missing** → downloads and verifies `KimiCU.app` from Moonshot AI's official CDN.
   - **Service stopped** → registers and starts the `launchd` background service.
   - **Permissions needed** → opens `KimiCU.app` so you can grant **Accessibility** and **Screen Recording** in macOS System Settings.
   - **MCP unconfigured** → writes the `kimi-cu` server entry to `~/.pi/agent/mcp.json` and prompts you to `/reload`.

3. **Verify live MCP connection**:

```text
/mcp
```

Once connected, simply ask Pi in natural language — for example: *"Take a screenshot of the Simulator window and click the Sign In button."*

---

## Commands & MCP Configuration

### Commands

| Command | Description |
| --- | --- |
| `/kimi-cu` | Interactive menu: check status or run guided setup |
| `/kimi-cu status` | Inspect platform, `KimiCU.app`, `launchd` service, macOS permissions, and local MCP config |
| `/kimi-cu setup` | Step-by-step guided installer for any missing components |
| `/kimi-cu mcp` | Configure MCP for global (`~/.pi/agent/mcp.json`), trusted project (`.pi/mcp.json`), or print the JSON snippet |

### Manual MCP Snippet

By default, guided setup writes to `~/.pi/agent/mcp.json` (respecting `PI_CODING_AGENT_DIR`):

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

- **Tool Exposure**: Under Pi's default `codemode` exposure, the agent discovers KimiCU tools via `searchTools()`. You can switch `kimi-cu` to `direct` exposure inside `/mcp` if you prefer directly declared tools.
- **Project Overrides**: On Pi `>= 1.0.1`, `.pi/mcp.json` in a trusted project can override `enabled`, `exposure`, or `toolExposure` alone; on Pi `0.99.x` / `1.0.0`, use a full server definition. To disable the server, set `"enabled": false`.

---

## Architecture & Design

### Non-Destructive Configuration Guardrails

`/kimi-cu mcp` is designed never to clobber existing user customizations:

- Refuses to overwrite broken/unreadable JSON files, legacy `mcp-servers` keys, legacy `disabled` fields, custom same-named servers, or namespace collisions (such as `kimi_cu`).
- Refuses to create a duplicate project definition when a global `kimi-cu` entry already exists, preventing accidental overrides of global `enabled: false` states or tool restrictions (use `/mcp` to adjust existing entries).
- Keeps diagnostic warnings separate from effective config resolution so a malformed file in one layer never masks a valid configuration in another.

### Security & Privacy Boundaries

- **Strict binary verification**: `KimiCU.app` is downloaded from Moonshot AI's official CDN into a temporary staging directory. Before installation, the package verifies the Bundle ID, `arm64` binary architecture, Apple Developer Team ID, and strict `codesign` validity. Any signature failure aborts installation by default.
- **Explicit macOS consent**: Accessibility and Screen Recording permissions are always granted by you through the official `KimiCU.app` window and macOS System Settings — this package never attempts to toggle TCC permissions behind your back.
- **Truthful status reporting**: `/kimi-cu status` checks local files and service state without falsely claiming a live MCP connection; use Pi's built-in `/mcp` command for authoritative runtime connection state.

---

## Migrating from v1.x (`pi-mcp-adapter`)

If you previously used `pi-kimi-cu@1.x` with `pi-mcp-adapter`:

1. Back up your old adapter configuration, then uninstall `pi-mcp-adapter` or disable it in `pi config` (an active adapter registering `/mcp` blocks Pi's built-in MCP).
2. Move your servers into `~/.pi/agent/mcp.json` under `"mcpServers"`. Replace any adapter-specific `"disabled": true` with `"enabled": false` and remove the old `disabled` key.
3. Run `/reload` and verify `kimi-cu` in Pi's built-in `/mcp` panel (if built-in MCP is off, enable it under **Built-in** in `pi config`).

---

## Development

```bash
npm run check
```

## License

[MIT](./LICENSE)
