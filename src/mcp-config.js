import { constants } from "node:fs";
import {
  access,
  chmod,
  mkdir,
  readFile,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";

import {
  DEFAULT_APP_PATH,
  MCP_SERVER_NAME,
  appBinary,
  kimiCuServerDefinition,
  resolvePiAgentDir,
} from "./constants.js";

export function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function packageSource(entry) {
  if (typeof entry === "string") return entry;
  return isPlainObject(entry) && typeof entry.source === "string" ? entry.source : undefined;
}

function isPiMcpAdapterSource(source) {
  return typeof source === "string" && /^npm:pi-mcp-adapter(?:@|$)/.test(source);
}

async function readJsonIfPresent(filePath) {
  try {
    return JSON.parse(await readFile(filePath, "utf8"));
  } catch (error) {
    if (error && typeof error === "object" && error.code === "ENOENT") return undefined;
    return undefined;
  }
}

export async function detectPiMcpAdapter({
  cwd = process.cwd(),
  env = process.env,
  home = homedir(),
} = {}) {
  const agentDir = resolvePiAgentDir(env, home);
  const settingsPaths = [path.join(agentDir, "settings.json"), path.join(cwd, ".pi", "settings.json")];

  for (const settingsPath of settingsPaths) {
    const settings = await readJsonIfPresent(settingsPath);
    if (
      isPlainObject(settings) &&
      Array.isArray(settings.packages) &&
      settings.packages.some((entry) => isPiMcpAdapterSource(packageSource(entry)))
    ) {
      return { installed: true, source: settingsPath };
    }
  }

  const npmManifestPath = path.join(agentDir, "npm", "package.json");
  const npmManifest = await readJsonIfPresent(npmManifestPath);
  if (
    isPlainObject(npmManifest) &&
    isPlainObject(npmManifest.dependencies) &&
    typeof npmManifest.dependencies["pi-mcp-adapter"] === "string"
  ) {
    return { installed: true, source: npmManifestPath };
  }

  return { installed: false };
}

export function mcpConfigPaths({
  cwd = process.cwd(),
  env = process.env,
  home = homedir(),
  overridePath,
} = {}) {
  const agentDir = resolvePiAgentDir(env, home);
  return {
    sharedGlobal: path.join(home, ".config", "mcp", "mcp.json"),
    agentsGlobal: path.join(home, ".agents", "mcp.json"),
    agentsNestedGlobal: path.join(home, ".agents", "mcp", "mcp.json"),
    piGlobal: overridePath ? path.resolve(overridePath) : path.join(agentDir, "mcp.json"),
    projectShared: path.join(cwd, ".mcp.json"),
    projectPi: path.join(cwd, ".pi", "mcp.json"),
  };
}

export function isKnownKimiCuEntry(value, appPath = DEFAULT_APP_PATH) {
  return value?.disabled !== true && isManagedKimiCuEntry(value, appPath);
}

function isManagedKimiCuEntry(value, appPath = DEFAULT_APP_PATH) {
  if (!isPlainObject(value) || value.command !== appBinary(appPath)) return false;
  const args = value.args;
  if (!Array.isArray(args) || !args.every((arg) => typeof arg === "string")) return false;
  const knownArgs =
    (args.length === 1 && args[0] === "mcp") ||
    (args.length === 3 && args[0] === "mcp" && args[1] === "-s" && args[2] === "user");
  if (!knownArgs) return false;
  return Object.keys(value).every((key) => key === "command" || key === "args" || key === "disabled");
}

export function mergeMcpConfigValue(
  value,
  { serverName = MCP_SERVER_NAME, appPath = DEFAULT_APP_PATH } = {},
) {
  if (!isPlainObject(value)) throw new Error("MCP 配置根节点必须是 JSON 对象 / MCP config root must be a JSON object");
  const hasCanonicalServers = Object.hasOwn(value, "mcpServers");
  const hasLegacyServers = Object.hasOwn(value, "mcp-servers");
  const canonicalServers = hasCanonicalServers ? value.mcpServers : {};
  const legacyServers = hasLegacyServers ? value["mcp-servers"] : {};
  if (!isPlainObject(canonicalServers)) {
    throw new Error('MCP 配置中的 \"mcpServers\" 必须是对象 / mcpServers must be an object');
  }
  if (!isPlainObject(legacyServers)) {
    throw new Error('MCP 配置中的 \"mcp-servers\" 必须是对象 / mcp-servers must be an object');
  }
  const currentServers = { ...legacyServers, ...canonicalServers };

  const current = currentServers[serverName];
  if (current !== undefined && !isManagedKimiCuEntry(current, appPath)) {
    throw new Error(`MCP server "${serverName}" 已存在且不是本扩展管理的 KimiCU 配置 / already exists and is not managed by this extension`);
  }

  const nextEntry = kimiCuServerDefinition(appPath);
  const { ["mcp-servers"]: _legacyServers, ...canonicalValue } = value;
  const nextValue = {
    ...canonicalValue,
    mcpServers: {
      ...currentServers,
      [serverName]: nextEntry,
    },
  };
  return {
    changed: JSON.stringify(value) !== JSON.stringify(nextValue),
    value: nextValue,
  };
}

export async function writeMcpConfig(
  configPath,
  { serverName = MCP_SERVER_NAME, appPath = DEFAULT_APP_PATH } = {},
) {
  let value = {};
  let mode = 0o600;
  try {
    const raw = await readFile(configPath, "utf8");
    value = JSON.parse(raw);
    mode = (await stat(configPath)).mode & 0o777;
  } catch (error) {
    if (!error || typeof error !== "object" || error.code !== "ENOENT") {
      if (error instanceof SyntaxError) {
        throw new Error(`现有 MCP 配置不是有效 JSON / existing MCP config is not valid JSON：${configPath}`, { cause: error });
      }
      throw error;
    }
  }

  const merged = mergeMcpConfigValue(value, { serverName, appPath });
  if (!merged.changed) return { changed: false, configPath, serverName };

  const directory = path.dirname(configPath);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const tempPath = path.join(
    directory,
    `.${path.basename(configPath)}.pi-kimi-cu-${process.pid}-${Date.now()}`,
  );
  try {
    await writeFile(tempPath, `${JSON.stringify(merged.value, null, 2)}\n`, {
      encoding: "utf8",
      flag: "wx",
      mode,
    });
    await chmod(tempPath, mode);
    await rename(tempPath, configPath);
  } finally {
    await rm(tempPath, { force: true }).catch(() => undefined);
  }

  return { changed: true, configPath, serverName };
}

export async function detectKimiCuMcp({
  cwd = process.cwd(),
  env = process.env,
  home = homedir(),
  appPath = DEFAULT_APP_PATH,
  overridePath,
} = {}) {
  const paths = mcpConfigPaths({ cwd, env, home, overridePath });
  let effective;
  for (const configPath of Object.values(paths)) {
    try {
      await access(configPath, constants.R_OK);
      const value = JSON.parse(await readFile(configPath, "utf8"));
      if (!isPlainObject(value)) continue;
      const servers = value.mcpServers ?? value["mcp-servers"];
      if (!isPlainObject(servers)) continue;
      const entry = servers[MCP_SERVER_NAME];
      if (entry !== undefined) {
        effective = {
          configPath,
          entry: mergeMcpServerEntry(effective?.entry, entry),
        };
      }
    } catch {
      // A malformed or unreadable unrelated layer does not hide a valid later layer.
    }
  }
  if (effective && isKnownKimiCuEntry(effective.entry, appPath)) {
    return {
      configured: true,
      configPath: effective.configPath,
      legacy: effective.entry.args.length === 3,
    };
  }
  if (effective && isManagedKimiCuEntry(effective.entry, appPath)) {
    return { configured: false, configPath: effective.configPath, disabled: true };
  }
  if (effective) return { configured: false, configPath: effective.configPath, conflict: true };
  return { configured: false };
}

function mergeMcpServerEntry(base, next) {
  if (!isPlainObject(next)) return next;
  if (!isPlainObject(base)) return { ...next };

  let safeBase = base;
  if (typeof next.socket === "string") {
    safeBase = { ...base };
    for (const field of [
      "command",
      "args",
      "env",
      "cwd",
      "url",
      "headers",
      "auth",
      "bearerToken",
      "bearerTokenEnv",
      "oauth",
    ]) {
      delete safeBase[field];
    }
  } else if (base.socket && (typeof next.command === "string" || typeof next.url === "string")) {
    safeBase = { ...base };
    delete safeBase.socket;
  }

  if (typeof next.url === "string" && next.url !== base.url) {
    if (safeBase === base) safeBase = { ...base };
    for (const field of ["headers", "bearerToken", "bearerTokenEnv"]) {
      delete safeBase[field];
    }
    if (safeBase.oauth !== false) delete safeBase.oauth;
  }

  return { ...safeBase, ...next };
}

export function mcpConfigSnippet({
  serverName = MCP_SERVER_NAME,
  appPath = DEFAULT_APP_PATH,
} = {}) {
  return `${JSON.stringify(
    { mcpServers: { [serverName]: kimiCuServerDefinition(appPath) } },
    null,
    2,
  )}\n`;
}
