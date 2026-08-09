import { homedir, tmpdir } from "node:os";
import path from "node:path";

export const APP_DOWNLOAD_URL =
  "https://cdn.kimi.com/kimi-computer-use/latest/KimiCU.app.zip";
export const APP_BUNDLE_ID = "ai.kimi.cu";
export const APP_TEAM_ID = "2J9472RW75";
export const APP_NAME = "KimiCU.app";
export const DEFAULT_APP_PATH = "/Applications/KimiCU.app";
export const LAUNCHD_LABEL = "ai.kimi.cu.service";
export const MCP_SERVER_NAME = "kimi-cu";
export const MAX_ARCHIVE_BYTES = 100 * 1024 * 1024;
export const DOWNLOAD_TIMEOUT_MS = 5 * 60_000;
export const COMMAND_TIMEOUT_MS = 30_000;
export const PROBE_TIMEOUT_MS = 4_000;
export const PERMISSION_REQUEST_TIMEOUT_MS = 15_000;

export function appBinary(appPath = DEFAULT_APP_PATH) {
  return path.join(appPath, "Contents", "MacOS", "kimi-cu");
}

export function appInfoPlist(appPath = DEFAULT_APP_PATH) {
  return path.join(appPath, "Contents", "Info.plist");
}

export function resolvePiAgentDir(env = process.env, home = homedir()) {
  const configured = env.PI_CODING_AGENT_DIR?.trim();
  return configured ? path.resolve(configured) : path.join(home, ".pi", "agent");
}

export function defaultTempDir() {
  return tmpdir();
}

export function kimiCuServerDefinition(appPath = DEFAULT_APP_PATH) {
  return {
    command: appBinary(appPath),
    args: ["mcp"],
  };
}
