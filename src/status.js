import { constants } from "node:fs";
import { access, readFile } from "node:fs/promises";
import { homedir } from "node:os";

import {
  APP_BUNDLE_ID,
  DEFAULT_APP_PATH,
  PROBE_TIMEOUT_MS,
  appBinary,
  appInfoPlist,
} from "./constants.js";
import { detectKimiCuMcp, detectPiMcpAdapter } from "./mcp-config.js";

export function parsePermissionStatus(output) {
  const match =
    /(?:permissions|permissionStatus):\s*accessibility=(true|false)\s+screenRecording=(true|false)/.exec(
      output,
    );
  if (!match) return undefined;
  return { accessibility: match[1] === "true", screenRecording: match[2] === "true" };
}

export function parseServiceRunning(output) {
  return /(?:^|\s)status=1\b/.test(output);
}

export function isSupportedMacVersion(version) {
  const major = Number.parseInt(String(version).split(".")[0] ?? "", 10);
  return Number.isInteger(major) && major >= 14;
}

function plistString(xml, key) {
  const escapedKey = key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`<key>${escapedKey}<\\/key>\\s*<string>([^<]+)<\\/string>`).exec(xml)?.[1];
}

export async function readAppMetadata(appPath = DEFAULT_APP_PATH) {
  const binary = appBinary(appPath);
  try {
    await access(binary, constants.X_OK);
    const xml = await readFile(appInfoPlist(appPath), "utf8");
    const bundleId = plistString(xml, "CFBundleIdentifier");
    return {
      installed: bundleId === APP_BUNDLE_ID,
      executable: true,
      bundleId,
      version: plistString(xml, "CFBundleShortVersionString"),
      minimumSystemVersion: plistString(xml, "LSMinimumSystemVersion"),
      invalidReason: bundleId === APP_BUNDLE_ID ? undefined : "bundle-id-mismatch",
    };
  } catch {
    return { installed: false, executable: false };
  }
}

async function safeExec(exec, command, args, timeout = PROBE_TIMEOUT_MS) {
  try {
    const result = await exec(command, args, { timeout });
    if (result?.killed !== true) return result;
    return {
      ...result,
      code: result.code === 0 ? -1 : result.code,
      stderr: result.stderr || "命令被终止（可能超时）",
    };
  } catch (error) {
    return { stdout: "", stderr: error instanceof Error ? error.message : String(error), code: -1 };
  }
}

export async function detectKimiCu({
  exec,
  cwd = process.cwd(),
  env = process.env,
  home = homedir(),
  appPath = DEFAULT_APP_PATH,
  platform = process.platform,
  arch = process.arch,
  mcpConfigPath,
} = {}) {
  if (typeof exec !== "function") throw new Error("detectKimiCu requires an exec function");

  let osVersion;
  let hostArm64 = platform === "darwin" && arch === "arm64";
  if (platform === "darwin") {
    const versionResult = await safeExec(exec, "sw_vers", ["-productVersion"]);
    if (versionResult.code === 0) osVersion = versionResult.stdout.trim();
    if (!hostArm64) {
      const arm64Result = await safeExec(exec, "sysctl", ["-n", "hw.optional.arm64"]);
      const translatedResult = await safeExec(exec, "sysctl", ["-n", "sysctl.proc_translated"]);
      hostArm64 =
        (arm64Result.code === 0 && arm64Result.stdout.trim() === "1") ||
        (translatedResult.code === 0 && translatedResult.stdout.trim() === "1");
    }
  }
  const supported = platform === "darwin" && hostArm64 && isSupportedMacVersion(osVersion);
  const app = await readAppMetadata(appPath);
  const binary = appBinary(appPath);

  let service = { running: false, detail: app.installed ? "not checked" : "app missing" };
  let permissions = { granted: false, detail: app.installed ? "not checked" : "app missing" };
  if (app.installed) {
    const serviceResult = await safeExec(exec, binary, ["service-status"]);
    service = {
      running: serviceResult.code === 0 && parseServiceRunning(serviceResult.stdout),
      detail: (serviceResult.stdout || serviceResult.stderr).trim(),
    };

    const permissionResult = await safeExec(exec, binary, ["xpc-ping"]);
    const parsed = parsePermissionStatus(`${permissionResult.stdout}\n${permissionResult.stderr}`);
    permissions = {
      granted: parsed?.accessibility === true && parsed?.screenRecording === true,
      accessibility: parsed?.accessibility,
      screenRecording: parsed?.screenRecording,
      detail: (permissionResult.stdout || permissionResult.stderr).trim(),
    };
  }

  const [mcp, adapter] = await Promise.all([
    detectKimiCuMcp({ cwd, env, home, appPath, overridePath: mcpConfigPath }),
    detectPiMcpAdapter({ cwd, env, home }),
  ]);

  return {
    supported,
    platform,
    arch,
    hostArm64,
    osVersion,
    app,
    service,
    permissions,
    mcp,
    adapter,
    ready: supported && app.installed && service.running && permissions.granted && mcp.configured,
  };
}

export function formatKimiCuStatus(status, adapterSnapshot) {
  const lines = [
    `KimiCU: ${status.ready ? "ready" : "not ready"}`,
    `平台: ${status.platform}/${status.arch}${status.osVersion ? ` · macOS ${status.osVersion}` : ""}${status.supported ? "" : "（要求 macOS 14+ arm64）"}`,
    `App: ${status.app.installed ? `已安装${status.app.version ? ` · v${status.app.version}` : ""}` : "缺失"}`,
    `后台服务: ${status.service.running ? "运行中" : "未运行"}`,
  ];

  if (status.permissions.granted) {
    lines.push("权限: 辅助功能、屏幕录制均已授权");
  } else if (
    status.permissions.accessibility !== undefined ||
    status.permissions.screenRecording !== undefined
  ) {
    lines.push(
      `权限: 辅助功能=${status.permissions.accessibility === true ? "是" : "否"}，屏幕录制=${status.permissions.screenRecording === true ? "是" : "否"}`,
    );
  } else {
    lines.push("权限: 无法通过后台服务读取");
  }

  lines.push(
    `MCP 配置: ${status.mcp.configured ? status.mcp.configPath : status.mcp.conflict ? "存在同名冲突" : "未配置"}`,
    `pi-mcp-adapter: ${status.adapter.installed ? "已安装" : "未检测到（可使用其他 MCP adapter）"}`,
  );

  if (adapterSnapshot && Array.isArray(adapterSnapshot.servers)) {
    const runtime = adapterSnapshot.servers.find((server) => server?.name === "kimi-cu");
    if (runtime) lines.push(`MCP 运行状态: ${runtime.status}`);
  }

  return lines.join("\n");
}
