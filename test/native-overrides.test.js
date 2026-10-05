import assert from "node:assert/strict";
import test from "node:test";
import { mergeMcpConfigValue } from "../src/mcp-config.js";

test("keeps native project-only overrides unchanged and refuses them as global definitions", () => {
  const value = { mcpServers: { "kimi-cu": { enabled: false, exposure: "direct" } } };
  assert.deepEqual(mergeMcpConfigValue(value, { allowProjectOverride: true }), { changed: false, value });
  assert.throws(() => mergeMcpConfigValue(value), /已存在/);
});

test("does not accept arbitrary credential fields as project overrides", () => {
  const value = { mcpServers: { "kimi-cu": { enabled: true, env: { KEY: "value" } } } };
  assert.throws(() => mergeMcpConfigValue(value, { allowProjectOverride: true }), /已存在/);
});
