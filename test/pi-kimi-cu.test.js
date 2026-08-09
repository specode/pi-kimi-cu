import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmod, mkdtemp, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import kimiCuExtension from "../extensions/kimi-cu.js";
import { DEFAULT_APP_PATH, appBinary } from "../src/constants.js";
import {
  detectPiMcpAdapter,
  detectKimiCuMcp,
  isKnownKimiCuEntry,
  mergeMcpConfigValue,
  writeMcpConfig,
} from "../src/mcp-config.js";
import {
  buildReplacementScript,
  downloadFile,
  installKimiCuApp,
  shellQuote,
} from "../src/installer.js";
import {
  detectKimiCu,
  isSupportedMacVersion,
  parsePermissionStatus,
  parseServiceRunning,
} from "../src/status.js";

function execResult({ stdout = "", stderr = "", code = 0, killed = false } = {}) {
  return { stdout, stderr, code, killed };
}

function downloadResponse(bytes = Buffer.from("zip")) {
  return {
    ok: true,
    status: 200,
    headers: { get: (name) => (name === "content-length" ? String(bytes.byteLength) : null) },
    body: {
      async *[Symbol.asyncIterator]() {
        yield bytes;
      },
    },
  };
}

async function createStagedApp(unzipDir) {
  const stagedApp = path.join(unzipDir, "KimiCU.app");
  const binary = appBinary(stagedApp);
  await mkdir(path.dirname(binary), { recursive: true });
  await writeFile(binary, "binary");
  await chmod(binary, 0o755);
  await writeFile(
    path.join(stagedApp, "Contents", "Info.plist"),
    [
      "<plist><dict>",
      "<key>CFBundleIdentifier</key><string>ai.kimi.cu</string>",
      "<key>CFBundleShortVersionString</key><string>1.0</string>",
      "<key>LSMinimumSystemVersion</key><string>14.0</string>",
      "</dict></plist>",
    ].join(""),
  );
}

test("parses KimiCU service and permission probes", () => {
  assert.equal(parseServiceRunning("SMAppService status=1 (enabled)"), true);
  assert.equal(parseServiceRunning("SMAppService status=3 (notFound)"), false);
  assert.deepEqual(
    parsePermissionStatus("permissionStatus: accessibility=true screenRecording=false"),
    { accessibility: true, screenRecording: false },
  );
  assert.equal(isSupportedMacVersion("14.0"), true);
  assert.equal(isSupportedMacVersion("13.6.9"), false);
});

test("merges KimiCU without changing unrelated MCP servers", () => {
  const original = {
    settings: { hostConfigDiscovery: "off" },
    mcpServers: { docs: { command: "docs-mcp", args: [] } },
  };
  const merged = mergeMcpConfigValue(original);
  assert.equal(merged.changed, true);
  assert.deepEqual(merged.value.mcpServers.docs, original.mcpServers.docs);
  assert.deepEqual(merged.value.mcpServers["kimi-cu"], {
    command: appBinary(),
    args: ["mcp"],
  });
});

test("migrates legacy mcp-servers and preserves every existing server", () => {
  const merged = mergeMcpConfigValue({
    "mcp-servers": {
      docs: { command: "docs-mcp", args: [] },
      legacy: { command: "legacy-mcp", args: [] },
    },
    mcpServers: {
      docs: { command: "new-docs-mcp", args: [] },
      search: { command: "search-mcp", args: [] },
    },
  });

  assert.equal(merged.changed, true);
  assert.equal(Object.hasOwn(merged.value, "mcp-servers"), false);
  assert.equal(merged.value.mcpServers.docs.command, "new-docs-mcp");
  assert.equal(merged.value.mcpServers.legacy.command, "legacy-mcp");
  assert.equal(merged.value.mcpServers.search.command, "search-mcp");
  assert.deepEqual(merged.value.mcpServers["kimi-cu"], {
    command: appBinary(),
    args: ["mcp"],
  });
});

test("migrates only a recognized legacy KimiCU entry", () => {
  const legacy = {
    command: appBinary(),
    args: ["mcp", "-s", "user"],
  };
  assert.equal(isKnownKimiCuEntry(legacy), true);
  const merged = mergeMcpConfigValue({ mcpServers: { "kimi-cu": legacy } });
  assert.deepEqual(merged.value.mcpServers["kimi-cu"].args, ["mcp"]);

  assert.throws(
    () =>
      mergeMcpConfigValue({
        mcpServers: { "kimi-cu": { command: "/custom/server", args: ["serve"] } },
      }),
    /已存在/,
  );
});

test("writes MCP configuration atomically and preserves existing mode", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "pi-kimi-cu-test-"));
  try {
    const configPath = path.join(root, "nested", "mcp.json");
    await mkdir(path.dirname(configPath), { recursive: true });
    await writeFile(configPath, '{"mcpServers":{"docs":{"command":"docs"}}}\n', { mode: 0o640 });
    const result = await writeMcpConfig(configPath);
    assert.equal(result.changed, true);
    const value = JSON.parse(await readFile(configPath, "utf8"));
    assert.equal(value.mcpServers.docs.command, "docs");
    assert.deepEqual(value.mcpServers["kimi-cu"].args, ["mcp"]);
    assert.equal((await stat(configPath)).mode & 0o777, 0o640);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("refuses malformed MCP JSON without replacing it", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "pi-kimi-cu-invalid-"));
  try {
    const configPath = path.join(root, "mcp.json");
    await writeFile(configPath, "{ invalid json\n");
    await assert.rejects(writeMcpConfig(configPath), /不是有效 JSON/);
    assert.equal(await readFile(configPath, "utf8"), "{ invalid json\n");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("uses the highest-precedence KimiCU MCP definition", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "pi-kimi-cu-precedence-"));
  try {
    const home = path.join(root, "home");
    const cwd = path.join(root, "project");
    const agentDir = path.join(home, ".pi", "agent");
    await mkdir(agentDir, { recursive: true });
    await mkdir(path.join(cwd, ".pi"), { recursive: true });
    await writeFile(
      path.join(agentDir, "mcp.json"),
      JSON.stringify({ mcpServers: { "kimi-cu": { command: appBinary(), args: ["mcp"] } } }),
    );
    await writeFile(
      path.join(cwd, ".pi", "mcp.json"),
      JSON.stringify({ mcpServers: { "kimi-cu": { command: "/custom/kimi-cu", args: [] } } }),
    );
    const result = await detectKimiCuMcp({ cwd, home, env: {} });
    assert.equal(result.configured, false);
    assert.equal(result.conflict, true);
    assert.equal(result.configPath, path.join(cwd, ".pi", "mcp.json"));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("merges field-level MCP overrides with adapter precedence", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "pi-kimi-cu-layer-merge-"));
  try {
    const home = path.join(root, "home");
    const cwd = path.join(root, "project");
    const agentDir = path.join(home, ".pi", "agent");
    await mkdir(agentDir, { recursive: true });
    await mkdir(path.join(cwd, ".pi"), { recursive: true });
    await writeFile(
      path.join(agentDir, "mcp.json"),
      JSON.stringify({ mcpServers: { "kimi-cu": { command: appBinary(), args: ["mcp"] } } }),
    );
    await writeFile(
      path.join(cwd, ".pi", "mcp.json"),
      JSON.stringify({ mcpServers: { "kimi-cu": { disabled: false } } }),
    );

    const result = await detectKimiCuMcp({ cwd, home, env: {} });
    assert.equal(result.configured, true);
    assert.equal(result.conflict, undefined);
    assert.equal(result.configPath, path.join(cwd, ".pi", "mcp.json"));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("does not report a disabled KimiCU MCP server as configured", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "pi-kimi-cu-disabled-"));
  try {
    const home = path.join(root, "home");
    const cwd = path.join(root, "project");
    const agentDir = path.join(home, ".pi", "agent");
    await mkdir(agentDir, { recursive: true });
    await writeFile(
      path.join(agentDir, "mcp.json"),
      JSON.stringify({
        mcpServers: {
          "kimi-cu": { command: appBinary(), args: ["mcp"], disabled: true },
        },
      }),
    );

    assert.equal(
      isKnownKimiCuEntry({ command: appBinary(), args: ["mcp"], disabled: true }),
      false,
    );
    const result = await detectKimiCuMcp({ cwd, home, env: {} });
    assert.deepEqual(result, {
      configured: false,
      configPath: path.join(agentDir, "mcp.json"),
      disabled: true,
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("uses an explicit adapter config path instead of the default Pi global file", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "pi-kimi-cu-override-"));
  try {
    const home = path.join(root, "home");
    const cwd = path.join(root, "project");
    const overridePath = path.join(root, "custom", "mcp.json");
    await mkdir(path.dirname(overridePath), { recursive: true });
    await writeFile(
      overridePath,
      JSON.stringify({ mcpServers: { "kimi-cu": { command: appBinary(), args: ["mcp"] } } }),
    );

    const result = await detectKimiCuMcp({ cwd, home, env: {}, overridePath });
    assert.equal(result.configured, true);
    assert.equal(result.configPath, overridePath);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("detects pi-mcp-adapter from Pi settings", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "pi-kimi-cu-adapter-"));
  try {
    const agentDir = path.join(root, "agent");
    await mkdir(agentDir, { recursive: true });
    await writeFile(
      path.join(agentDir, "settings.json"),
      JSON.stringify({ packages: ["npm:other", { source: "npm:pi-mcp-adapter@2.21.1" }] }),
    );
    const result = await detectPiMcpAdapter({
      cwd: root,
      home: root,
      env: { PI_CODING_AGENT_DIR: agentDir },
    });
    assert.equal(result.installed, true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("aborts a download whose response body stops transferring", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "pi-kimi-cu-download-timeout-"));
  try {
    const destination = path.join(root, "archive.zip");
    const fetchImpl = async (_url, { signal }) => ({
      ok: true,
      status: 200,
      headers: { get: () => null },
      body: {
        async *[Symbol.asyncIterator]() {
          yield Buffer.from("partial");
          await new Promise((resolve, reject) => {
            signal.addEventListener("abort", () => reject(signal.reason), { once: true });
          });
        },
      },
    });

    await assert.rejects(
      downloadFile("https://example.invalid/archive.zip", destination, fetchImpl, undefined, 20),
      /下载超时/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("treats a killed strict codesign verification as invalid", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "pi-kimi-cu-codesign-timeout-"));
  try {
    let approvalDetail;
    const exec = async (command, args) => {
      if (command === "ditto") {
        await createStagedApp(args[3]);
        return execResult();
      }
      if (command === "lipo") return execResult({ stdout: "arm64" });
      if (command === "codesign" && args[0] === "-dv") {
        return execResult({ stderr: "TeamIdentifier=2J9472RW75" });
      }
      if (command === "codesign") {
        return execResult({ code: 0, killed: true });
      }
      throw new Error(`unexpected command: ${command} ${args.join(" ")}`);
    };

    await assert.rejects(
      installKimiCuApp({
        exec,
        fetchImpl: async () => downloadResponse(),
        appPath: path.join(root, "Applications", "KimiCU.app"),
        tempBase: root,
        approveInvalidSignature: async (detail) => {
          approvalDetail = detail;
          return false;
        },
      }),
      /代码签名验证失败/,
    );
    assert.match(approvalDetail, /被终止/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("restores the old background service when app replacement fails", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "pi-kimi-cu-service-rollback-"));
  try {
    const appPath = path.join(root, "Applications", "KimiCU.app");
    await createStagedApp(path.dirname(appPath));
    let restored = 0;
    const exec = async (command, args) => {
      if (command === "ditto") {
        await createStagedApp(args[3]);
        return execResult();
      }
      if (command === "lipo") return execResult({ stdout: "arm64" });
      if (command === "codesign" && args[0] === "-dv") {
        return execResult({ stderr: "TeamIdentifier=2J9472RW75" });
      }
      if (command === "codesign") return execResult();
      if (command === "/bin/sh") return execResult({ code: 1, stderr: "permission denied" });
      if (command === "osascript") return execResult({ code: 1, stderr: "User canceled" });
      if (command === appBinary(appPath) && args[0] === "install") {
        restored += 1;
        return execResult();
      }
      if (command === appBinary(appPath) && args[0] === "service-status") {
        return execResult({ stdout: "status=1" });
      }
      return execResult();
    };

    await assert.rejects(
      installKimiCuApp({
        exec,
        fetchImpl: async () => downloadResponse(),
        appPath,
        tempBase: root,
        sleep: async () => undefined,
      }),
      /无法安装/,
    );
    assert.equal(restored, 1);
    assert.equal(await readFile(appBinary(appPath), "utf8"), "binary");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("replacement script quotes generated paths and includes rollback", () => {
  assert.equal(shellQuote("/tmp/a'b"), "'/tmp/a'\\''b'");
  const script = buildReplacementScript("/tmp/kimi cu/KimiCU.app", DEFAULT_APP_PATH, "test");
  assert.match(script, /\/usr\/bin\/ditto '\/tmp\/kimi cu\/KimiCU\.app'/);
  assert.match(script, /backup-test/);
  assert.match(script, /\/bin\/mv/);
  assert.doesNotMatch(script, /\n/);
  const syntax = spawnSync("/bin/sh", ["-n", "-c", script], { encoding: "utf8" });
  assert.equal(syntax.status, 0, syntax.stderr);
});

test("replacement script installs the staged app and removes its backup", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "pi-kimi-cu-replace-"));
  try {
    const source = path.join(root, "source", "KimiCU.app");
    const target = path.join(root, "Applications", "KimiCU.app");
    await mkdir(source, { recursive: true });
    await mkdir(target, { recursive: true });
    await writeFile(path.join(source, "version"), "new");
    await writeFile(path.join(target, "version"), "old");
    const script = buildReplacementScript(source, target, "integration");
    const result = spawnSync("/bin/sh", ["-c", script], { encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(await readFile(path.join(target, "version"), "utf8"), "new");
    await assert.rejects(
      readFile(path.join(root, "Applications", ".KimiCU.app.backup-integration", "version")),
      /ENOENT/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("accepts an Apple Silicon host when Pi runs as x64 under Rosetta", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "pi-kimi-cu-rosetta-"));
  try {
    const exec = async (command, args) => {
      if (command === "sw_vers") return execResult({ stdout: "14.6\n" });
      if (command === "sysctl" && args[1] === "hw.optional.arm64") {
        return execResult({ stdout: "1\n" });
      }
      if (command === "sysctl") return execResult({ code: 1 });
      throw new Error(`unexpected command: ${command}`);
    };

    const result = await detectKimiCu({
      exec,
      cwd: path.join(root, "project"),
      home: path.join(root, "home"),
      env: {},
      appPath: path.join(root, "Applications", "KimiCU.app"),
      platform: "darwin",
      arch: "x64",
    });
    assert.equal(result.hostArm64, true);
    assert.equal(result.supported, true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("writes --mcp-config and never touches a stale context after reload", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "pi-kimi-cu-reload-"));
  try {
    const cwd = path.join(root, "project");
    const configPath = path.join(root, "custom", "mcp.json");
    await mkdir(path.join(cwd, ".pi"), { recursive: true });
    await writeFile(
      path.join(cwd, ".pi", "settings.json"),
      JSON.stringify({ packages: ["npm:pi-mcp-adapter"] }),
    );

    let command;
    let stale = false;
    const assertActive = () => {
      if (stale) throw new Error("stale-context extension error");
    };
    const pi = {
      events: { on: () => () => undefined },
      on: () => undefined,
      getFlag: (name) => (name === "mcp-config" ? configPath : undefined),
      registerCommand: (_name, definition) => {
        command = definition;
      },
      exec: async () => execResult(),
    };
    kimiCuExtension(pi);

    const ctx = {
      cwd,
      hasUI: true,
      ui: {
        select: async (_title, choices) => {
          assertActive();
          return choices[0];
        },
        confirm: async () => {
          assertActive();
          return true;
        },
        notify: () => assertActive(),
        setStatus: () => assertActive(),
        editor: async () => assertActive(),
        input: async () => {
          assertActive();
          return undefined;
        },
      },
      reload: async () => {
        assertActive();
        stale = true;
      },
    };

    await command.handler("mcp", ctx);
    const value = JSON.parse(await readFile(configPath, "utf8"));
    assert.deepEqual(value.mcpServers["kimi-cu"], {
      command: appBinary(),
      args: ["mcp"],
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
