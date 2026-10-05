import {
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

export const MCP_MIGRATION_GUIDANCE = "本包使用 Pi 内置 MCP，不自动迁移旧配置。可自行卸载 pi-mcp-adapter，将所需配置复制到 Pi 的 mcp.json / mcpServers，并把 disabled:true 改为 enabled:false；完成后 /reload，再用 /mcp 检查。 / This package uses built-in MCP and does not migrate legacy config. You can uninstall pi-mcp-adapter yourself, copy needed entries to Pi's mcp.json / mcpServers, replace disabled:true with enabled:false, then /reload and check /mcp.";

export function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function mcpConfigPaths({
  cwd = process.cwd(),
  env = process.env,
  home = homedir(),
} = {}) {
  return {
    piGlobal: path.join(resolvePiAgentDir(env, home), "mcp.json"),
    projectPi: path.join(cwd, ".pi", "mcp.json"),
  };
}

export function isKnownKimiCuEntry(value, appPath = DEFAULT_APP_PATH) {
  return value?.enabled !== false && value?.disabled !== true && isManagedKimiCuEntry(value, appPath);
}

const MANAGED_KEYS = new Set([
  "type", "command", "args", "env", "cwd", "timeout",
  "enabled", "exposure", "toolExposure", "description", "disabled",
]);
const EXPOSURES = new Set(["codemode", "codemode-deferred", "deferred", "direct", "hidden"]);

// Validate native fields separately from ownership: a valid custom server must
// still replace the global definition and be reported as a conflict.
function hasValidNativeFields(value) {
  if (!isPlainObject(value)) return false;
  if (value.enabled !== undefined && typeof value.enabled !== "boolean") return false;
  if (value.exposure !== undefined && !EXPOSURES.has(value.exposure)) return false;
  if (value.toolExposure !== undefined &&
      (!isPlainObject(value.toolExposure) || !Object.values(value.toolExposure).every((v) => EXPOSURES.has(v)))) return false;
  if (value.description !== undefined && typeof value.description !== "string") return false;
  if (value.timeout !== undefined &&
      (typeof value.timeout !== "number" || !(value.timeout > 0))) return false;
  return true;
}

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

// Match Pi's HTTP validation as well: malformed custom transports must not
// replace a valid KimiCU definition merely because they have a URL.
function isValidOAuth(value) {
  if (value === undefined) return true;
  if (!isPlainObject(value)) return false;
  for (const key of ["clientId", "clientSecret", "scope"]) {
    if (value[key] !== undefined && typeof value[key] !== "string") return false;
  }
  const port = value.callbackPort;
  if (port !== undefined && (!Number.isInteger(port) || port < 1 || port > 65535)) return false;
  let callback;
  if (value.callbackUrl !== undefined) {
    if (typeof value.callbackUrl !== "string" || !URL.canParse(value.callbackUrl)) return false;
    callback = new URL(value.callbackUrl);
    if (callback.protocol !== "http:" || !LOOPBACK_HOSTS.has(callback.hostname) || callback.search || callback.hash) return false;
    if (callback.port && port !== undefined && Number(callback.port) !== port) return false;
  }
  if (value.clientName !== undefined && (typeof value.clientName !== "string" || !value.clientName.trim())) return false;
  if (value.clientRegistration !== undefined && value.clientRegistration !== "dcr") {
    if (value.clientRegistration !== "cimd" || value.clientId !== undefined || value.clientName !== undefined) return false;
    if (callback && (callback.hostname === "[::1]" || callback.pathname !== "/callback")) return false;
  }
  if (value.authServerMetadataUrl !== undefined) {
    if (typeof value.authServerMetadataUrl !== "string" || !URL.canParse(value.authServerMetadataUrl)) return false;
    const url = new URL(value.authServerMetadataUrl);
    if (url.protocol !== "https:" && !(url.protocol === "http:" && LOOPBACK_HOSTS.has(url.hostname))) return false;
  }
  return true;
}

function isValidNativeDefinition(value) {
  if (!hasValidNativeFields(value)) return false;
  if (typeof value.url === "string" &&
      (value.type === undefined || value.type === "http" || value.type === "streamable-http")) {
    if (!URL.canParse(value.url)) return false;
    const url = new URL(value.url);
    if (!["http:", "https:"].includes(url.protocol) || !isValidOAuth(value.oauth)) return false;
    if (value.headers !== undefined &&
        (!isPlainObject(value.headers) || !Object.values(value.headers).every((v) => typeof v === "string"))) return false;
    if (value.auth !== undefined &&
        (!isPlainObject(value.auth) || typeof value.auth.provider !== "string" || !value.auth.provider ||
         (url.protocol !== "https:" && !LOOPBACK_HOSTS.has(url.hostname)))) return false;
    return true;
  }
  return typeof value.command === "string" &&
    (value.type === undefined || value.type === "stdio") &&
    (value.args === undefined || (Array.isArray(value.args) && value.args.every((arg) => typeof arg === "string"))) &&
    (value.env === undefined || (isPlainObject(value.env) && Object.values(value.env).every((v) => typeof v === "string"))) &&
    (value.cwd === undefined || typeof value.cwd === "string");
}

function isManagedKimiCuEntry(value, appPath = DEFAULT_APP_PATH) {
  if (!isValidNativeDefinition(value) || value.command !== appBinary(appPath)) return false;
  const args = value.args;
  if (!Array.isArray(args)) return false;
  const knownArgs =
    (args.length === 1 && args[0] === "mcp") ||
    (args.length === 3 && args[0] === "mcp" && args[1] === "-s" && args[2] === "user");
  if (!knownArgs) return false;
  if (value.type !== undefined && value.type !== "stdio") return false;
  if (value.disabled !== undefined && typeof value.disabled !== "boolean") return false;
  return Object.keys(value).every((key) => MANAGED_KEYS.has(key));
}

function namespaceConflict(servers, serverName) {
  if (!isPlainObject(servers)) return undefined;
  const namespace = serverName.replaceAll("-", "_");
  return Object.keys(servers).find((name) => name !== serverName && name.replaceAll("-", "_") === namespace);
}

function assertNoNamespaceConflict(value, serverName) {
  const conflict = namespaceConflict(value?.mcpServers, serverName);
  if (conflict) {
    throw new Error(`MCP 命名空间冲突 / MCP namespace conflict："${serverName}" / "${conflict}"`);
  }
}

export function mergeMcpConfigValue(
  value,
  { serverName = MCP_SERVER_NAME, appPath = DEFAULT_APP_PATH, allowProjectOverride = false } = {},
) {
  if (!isPlainObject(value)) throw new Error("MCP 配置根节点必须是 JSON 对象 / MCP config root must be a JSON object");
  if (Object.hasOwn(value, "mcp-servers")) throw new Error(MCP_MIGRATION_GUIDANCE);
  const currentServers = Object.hasOwn(value, "mcpServers") ? value.mcpServers : {};
  if (!isPlainObject(currentServers)) {
    throw new Error('MCP 配置中的 "mcpServers" 必须是对象 / mcpServers must be an object');
  }
  assertNoNamespaceConflict(value, serverName);

  const current = currentServers[serverName];
  if (isPlainObject(current) && Object.hasOwn(current, "disabled")) {
    throw new Error(MCP_MIGRATION_GUIDANCE);
  }
  if (allowProjectOverride && isPlainObject(current) &&
      Object.keys(current).every((key) => ["enabled", "exposure", "toolExposure"].includes(key)) &&
      isManagedKimiCuEntry({ ...kimiCuServerDefinition(appPath), ...current }, appPath)) {
    // Leave native project overrides intact; do not replace them with a full
    // server definition or silently enable a globally/project-disabled server.
    return { changed: false, value };
  }
  if (current !== undefined && !isManagedKimiCuEntry(current, appPath)) {
    throw new Error(`MCP server "${serverName}" 已存在且不是本扩展管理的 KimiCU 配置 / already exists and is not managed by this extension`);
  }

  // Existing definitions, including their arguments, are never migrated.
  const nextValue = {
    ...value,
    mcpServers: {
      ...currentServers,
      [serverName]: current ?? kimiCuServerDefinition(appPath),
    },
  };
  return {
    changed: JSON.stringify(value) !== JSON.stringify(nextValue),
    value: nextValue,
  };
}

export async function writeMcpConfig(
  configPath,
  { serverName = MCP_SERVER_NAME, appPath = DEFAULT_APP_PATH, allowProjectOverride = false, otherConfigPaths = [] } = {},
) {
  // Check only the caller's active/trusted layers. Never change those files.
  let inheritedServerPath;
  let invalidInheritedPath;
  for (const otherPath of otherConfigPaths) {
    if (path.resolve(otherPath) === path.resolve(configPath)) continue;
    let otherValue;
    try {
      otherValue = JSON.parse(await readFile(otherPath, "utf8"));
    } catch (error) {
      if (error?.code === "ENOENT") continue;
      if (error instanceof SyntaxError) {
        invalidInheritedPath = otherPath;
        continue;
      }
      throw error;
    }
    if (!isPlainObject(otherValue) || (otherValue.mcpServers !== undefined && !isPlainObject(otherValue.mcpServers))) {
      invalidInheritedPath = otherPath;
      continue;
    }
    assertNoNamespaceConflict(otherValue, serverName);
    if (isPlainObject(otherValue?.mcpServers) && Object.hasOwn(otherValue.mcpServers, serverName)) {
      inheritedServerPath = otherPath;
    }
  }
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

  const merged = mergeMcpConfigValue(value, { serverName, appPath, allowProjectOverride });
  if (!merged.changed) return { changed: false, configPath, serverName };
  // A new full project definition would replace all inherited settings,
  // including enabled/exposure restrictions. Existing project entries are no-ops.
  if (allowProjectOverride && invalidInheritedPath) {
    throw new Error(`无法确认全局 MCP 配置，请修复后重试 / Cannot verify global MCP config; repair it before adding a project definition：${invalidInheritedPath}`);
  }
  if (allowProjectOverride && inheritedServerPath) {
    throw new Error(`全局已有同名 MCP 配置，请在 /mcp 中明确调整，避免覆盖禁用状态或工具限制 / A global MCP entry already exists; use /mcp to change it explicitly without replacing disabled state or tool restrictions：${inheritedServerPath}`);
  }

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
  projectTrusted = false,
} = {}) {
  const paths = mcpConfigPaths({ cwd, env, home });
  const layers = [paths.piGlobal, ...(projectTrusted ? [paths.projectPi] : [])];
  let effective;
  let conflict;
  const diagnostics = [];
  for (const configPath of layers) {
    let value;
    try {
      value = JSON.parse(await readFile(configPath, "utf8"));
    } catch (error) {
      if (error?.code === "ENOENT") continue;
      diagnostics.push({ configPath, error: "无法读取有效 MCP JSON / Cannot read valid MCP JSON" });
      continue;
    }
    if (!isPlainObject(value) || (value.mcpServers !== undefined && !isPlainObject(value.mcpServers))) {
      diagnostics.push({ configPath, error: "mcpServers 必须是对象 / Expected an mcpServers object" });
      continue;
    }
    if (Object.hasOwn(value, "mcp-servers")) {
      diagnostics.push({ configPath, needsMigration: true });
    }
    const conflictingServer = namespaceConflict(value.mcpServers, MCP_SERVER_NAME);
    if (conflictingServer) {
      conflict = { configPath, conflict: true, conflictingServer };
    }
    const entry = value.mcpServers?.[MCP_SERVER_NAME];
    if (entry === undefined) continue;
    if (configPath === paths.projectPi && isPlainObject(entry) &&
        entry.command === undefined && entry.url === undefined && entry.type === undefined) {
      // Native per-project overrides (Pi >=1.0.1); never merge arbitrary
      // transport/credential fields into a global server definition.
      if (!effective || !Object.keys(entry).every((key) => ["enabled", "exposure", "toolExposure"].includes(key)) ||
          !isManagedKimiCuEntry({ ...kimiCuServerDefinition(appPath), ...entry }, appPath)) {
        diagnostics.push({ configPath, error: "无效的项目 MCP 覆盖配置 / Invalid project MCP override" });
        continue;
      }
      effective = { configPath, entry: { ...effective.entry, ...entry } };
    } else {
      if (!isValidNativeDefinition(entry) ||
          (configPath === paths.projectPi && "url" in entry && entry.auth)) {
        diagnostics.push({ configPath, error: "无效的 MCP 服务器配置 / Invalid MCP server definition" });
        continue;
      }
      effective = { configPath, entry };
    }
  }
  // File diagnostics must not hide a valid definition in another layer.
  const result = conflict
    ? { configured: false, ...conflict }
    : effective
      ? describeKimiCuEntry(effective, appPath)
      : { configured: false, ...diagnostics.at(-1) };
  return diagnostics.length ? { ...result, diagnostics } : result;
}

function describeKimiCuEntry({ configPath, entry }, appPath) {
  if (isPlainObject(entry) && Object.hasOwn(entry, "disabled")) {
    return { configured: false, configPath, needsMigration: true };
  }
  if (!isManagedKimiCuEntry(entry, appPath)) return { configured: false, configPath, conflict: true };
  if (entry.enabled === false) return { configured: false, configPath, disabled: true };
  return { configured: true, configPath, legacy: entry.args.length === 3 };
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
