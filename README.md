# pi-kimi-cu

[中文](./README.zh-CN.md)

A lightweight Pi package for installing and wiring up [Kimi Computer Use](https://www.kimi.com/) on macOS. It does not depend on Kimi Code.

## What you get

- `/kimi-cu` — two actions: check status, guided setup
- Safe install of `KimiCU.app` — download to a temp dir, verify, replace with rollback, then clean up
- launchd background service setup; permissions are handled in the official KimiCU app UI
- Optional install of [`pi-mcp-adapter`](https://www.npmjs.com/package/pi-mcp-adapter)
- MCP wiring: guided setup uses the default Pi path; `/kimi-cu mcp` keeps the advanced chooser
- A Pi skill for driving KimiCU once it is connected

## Requirements

- Apple Silicon Mac
- macOS 14 or later
- [Pi](https://pi.dev)
- Node.js 20+

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
   - MCP not connected → offer `/reload`

## MCP

`pi-mcp-adapter` is recommended. Guided setup asks before installing it when missing:

```bash
pi install npm:pi-mcp-adapter
```

For a custom path or a copy-paste snippet:

```text
/kimi-cu mcp
```

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

The extension only migrates old KimiCU config it can positively identify. If it hits a same-named custom server, broken JSON, or an unreadable file, it stops instead of overwriting anything.

## Security

The app is downloaded from Moonshot AI’s official CDN. Before install it checks Bundle ID, arm64 architecture, signing Team ID, and runs a strict `codesign` verification. Failed signature checks abort by default; install continues only if you explicitly confirm in the interactive prompt.

Accessibility and Screen Recording are granted through the official KimiCU app UI. This package does not flip those system toggles for you.

## Development

```bash
npm run check
```

## License

MIT
