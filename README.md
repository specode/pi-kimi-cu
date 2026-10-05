# pi-kimi-cu

[中文](./README.zh-CN.md)

A lightweight Pi package for installing and wiring up [Kimi Computer Use](https://www.kimi.com/) on macOS. It does not depend on Kimi Code.

## What you get

- `/kimi-cu` — two actions: check status, guided setup
- Safe install of `KimiCU.app` — download to a temp dir, verify, replace with rollback, then clean up
- launchd background service setup; permissions are handled in the official KimiCU app UI
- Uses Pi’s built-in MCP; no third-party adapter installation or dependency
- Guided setup writes Pi’s global config; `/kimi-cu mcp` offers global, trusted-project, or snippet-only setup
- A Pi skill for driving KimiCU once it is connected

## Requirements

- Apple Silicon Mac
- macOS 14 or later
- [Pi](https://pi.dev) **>=0.99.0**, with built-in MCP enabled (1.0.2 or newer recommended)
- Node.js >=22.19.0

Package **2.x** supports built-in MCP only. On older Pi (<0.99.0), pin the legacy plugin instead of upgrading to 2.x:

```bash
pi install npm:@specode/pi-kimi-cu@1.0.0
```

The legacy version keeps its adapter-based integration. This package does not automatically downgrade or install a legacy adapter.

## Install

From npm:

```bash
pi install npm:@specode/pi-kimi-cu
```

From git:

```bash
pi install git:github.com/specode/pi-kimi-cu
```

From a local checkout:

```bash
pi install ~/Code/pi-kimi-cu
```

Restart Pi, then run:

```text
/kimi-cu
```

Commands:

```text
/kimi-cu status   # check status
/kimi-cu setup    # guided setup
```

## Interaction

1. **Check status** — platform, app, background service, permissions, MCP config and runtime.
2. **Guided setup** — walk missing pieces only:
   - App missing → offer official CDN install
   - Service not running → offer register/start
   - Permissions missing → open KimiCU.app and ask you to set Accessibility / Screen Recording to Allowed
   - MCP not configured → offer default Pi MCP config
   - After writing config → offer `/reload`; use Pi’s built-in `/mcp` for authoritative connection status

## MCP

The default is `~/.pi/agent/mcp.json` (respecting `PI_CODING_AGENT_DIR`); trusted projects can use `.pi/mcp.json`. Adapter-only shared paths, project `.mcp.json`, and `--mcp-config` are no longer read.

Migrating from the legacy version:

1. Back up your old adapter configuration. You can now uninstall `pi-mcp-adapter` yourself, or disable it in `pi config`; built-in MCP replaces it. An adapter registering `/mcp` prevents built-in MCP from taking over.
2. Manually copy the servers you need into Pi’s `mcp.json`, under `mcpServers`. Convert adapter-only options yourself: in particular, replace `disabled: true` with `enabled: false` and remove the old `disabled` field. Do not copy `mcp-servers` unchanged.
3. This package does not migrate, uninstall, or delete anything for you. `/kimi-cu mcp` only adds a missing KimiCU entry or shows a snippet; legacy configuration is left untouched with manual instructions.
4. After completing the above, run `/reload` and verify `kimi-cu` enabled state, connection, and exposure in built-in `/mcp`. If built-in MCP is disabled, enable it under Built-in in `pi config`.

`/kimi-cu status` checks local setup and configuration only; neither an existing config nor registered tools proves a live connection. Default `codemode` exposure uses `searchTools()` to discover tools; choose `direct` in `/mcp` for directly declared tools.

Pi >=1.0.1 supports project-only overrides of `enabled`, `exposure`, and `toolExposure`; use full project definitions on 0.99.x/1.0.0. Disable a server with `enabled: false`. Existing native settings and command arguments are preserved; legacy fields are not automatically converted.

Snippet:

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

Config writes refuse legacy `mcp-servers` or a KimiCU `disabled` field, custom same-named servers, namespace collisions such as `kimi_cu`, and broken or unreadable target files. Conflicts are also checked across active global and trusted-project files. A new project definition is also refused when a global entry with the same name already exists: use `/mcp` to change it explicitly, rather than silently replacing inherited disabled state, tool restrictions, or other settings. If the global JSON or its root/server-map structure is invalid, creating a project definition is refused until it is repaired. Existing project entries remain unchanged. Status detection keeps diagnostics separate from the effective config: malformed files or invalid server fields do not hide a valid definition in another layer; valid custom project servers still take precedence and are reported as conflicts.

## Security

The app is downloaded from Moonshot AI’s official CDN. Before install it checks Bundle ID, arm64 architecture, signing Team ID, and runs a strict `codesign` verification. Failed signature checks abort by default; install continues only if you explicitly confirm in the interactive prompt.

Accessibility and Screen Recording are granted through the official KimiCU app UI. This package does not flip those system toggles for you.

## Development

```bash
npm run check
```

## License

MIT
