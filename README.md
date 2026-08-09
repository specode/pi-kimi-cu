# pi-kimi-cu

[中文](./README.zh-CN.md)

A lightweight Pi package for installing and wiring up [Kimi Computer Use](https://www.kimi.com/) on macOS. It does not depend on Kimi Code.

## What you get

- `/kimi-cu` — install, update, repair, and layered status checks
- Safe install of `KimiCU.app` — download to a temp dir, verify, replace with rollback, then clean up
- launchd background service setup and macOS permission guidance
- Optional install of [`pi-mcp-adapter`](https://www.npmjs.com/package/pi-mcp-adapter)
- Four MCP wiring options: Pi-native, global config, custom path, or a copy-paste snippet
- A Pi skill for driving KimiCU once it is connected

## Requirements

- Apple Silicon Mac
- macOS 14 or later
- [Pi](https://pi.dev)
- Node.js 20+

## Install

From a local checkout:

```bash
pi install ~/Code/pi-kimi-cu
```

Or from git:

```bash
pi install git:github.com/specode/pi-kimi-cu
```

Restart Pi, then run:

```text
/kimi-cu
```

Commands:

```text
/kimi-cu status
/kimi-cu install
/kimi-cu repair
/kimi-cu update
/kimi-cu mcp
/kimi-cu permissions
```

## MCP

`pi-mcp-adapter` is the recommended path. If it is missing, `/kimi-cu mcp` will ask before running:

```bash
pi install npm:pi-mcp-adapter
```

With another MCP adapter, you can write `~/.config/mcp/mcp.json`, point at a custom JSON file, or just copy this snippet:

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

Accessibility and Screen Recording must be granted by you in System Settings. The package cannot flip those switches for you.

## Development

```bash
npm run check
```

## License

MIT
