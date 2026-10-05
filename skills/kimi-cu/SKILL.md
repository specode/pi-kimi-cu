---
name: kimi-cu
description: Use Kimi Computer Use when the user asks Pi to inspect or operate a macOS graphical application, including clicking, typing, scrolling, dragging, reading visible UI state, or capturing an application screenshot.
---

# Kimi Computer Use

Use the KimiCU MCP server for macOS application interaction. It works through a background service and should not require moving the user's physical pointer.

## Before operating an app

1. If KimiCU tools are missing or fail to connect, ask the user to run `/kimi-cu status` and then `/kimi-cu setup` if needed.
2. This package requires Pi >=0.99.0 and its built-in MCP support. Use `/mcp` to check the `kimi-cu` connection. With the default `codemode` exposure, discover tools using `searchTools("kimi")` and inspect their schemas with `describeTool(name)`. Use the returned tool names instead of hard-coding them (Pi’s name normalization changed in 0.99.2). Call them from codemode; forward image blocks with `image(block)`, not `text()`. With `direct` exposure, call the declared tools directly. Do not look for the old adapter’s `mcp` proxy.
3. Start with `list_apps`, then call `get_app_state` for the target application.

## Interaction loop

1. Read fresh state with `get_app_state`.
2. Choose an element index or screenshot coordinate from that state.
3. Perform one focused action such as `click`, `type_text`, `press_key`, `scroll`, `set_value`, `perform_secondary_action`, `select_text`, or `drag`.
4. Read state again and verify the visible result.

Never reuse an index or coordinate after the interface changes. If an element is outside the visible area, scroll and obtain fresh state before acting.

Prefer `set_value` for ordinary form fields and `type_text` for chat boxes, rich text editors, or web-based inputs. Prefer an element's supported secondary action over coordinate dragging when both are available.

## Safety

Before sending, submitting, deleting, purchasing, publishing, or performing another difficult-to-reverse action, state exactly what will happen and obtain the user's confirmation. Do not inspect or repeat unrelated sensitive content visible in screenshots.
