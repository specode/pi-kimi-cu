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
import { detectKimiCuMcp, MCP_MIGRATION_GUIDANCE } from "./mcp-config.js";

export function parsePermissionStatus(output) {
	const match =
		/(?:permissions|permissionStatus):\s*accessibility=(true|false)\s+screenRecording=(true|false)/.exec(
			output,
		);
	if (!match) return undefined;
	return {
		accessibility: match[1] === "true",
		screenRecording: match[2] === "true",
	};
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
	return new RegExp(
		`<key>${escapedKey}<\\/key>\\s*<string>([^<]+)<\\/string>`,
	).exec(xml)?.[1];
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
			invalidReason:
				bundleId === APP_BUNDLE_ID ? undefined : "bundle-id-mismatch",
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
			stderr:
				result.stderr ||
				"命令被终止（可能超时） / command terminated (possible timeout)",
		};
	} catch (error) {
		return {
			stdout: "",
			stderr: error instanceof Error ? error.message : String(error),
			code: -1,
		};
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
	projectTrusted = false,
} = {}) {
	if (typeof exec !== "function")
		throw new Error("detectKimiCu requires an exec function");

	let osVersion;
	let hostArm64 = platform === "darwin" && arch === "arm64";
	if (platform === "darwin") {
		const versionResult = await safeExec(exec, "sw_vers", ["-productVersion"]);
		if (versionResult.code === 0) osVersion = versionResult.stdout.trim();
		if (!hostArm64) {
			const arm64Result = await safeExec(exec, "sysctl", [
				"-n",
				"hw.optional.arm64",
			]);
			const translatedResult = await safeExec(exec, "sysctl", [
				"-n",
				"sysctl.proc_translated",
			]);
			hostArm64 =
				(arm64Result.code === 0 && arm64Result.stdout.trim() === "1") ||
				(translatedResult.code === 0 && translatedResult.stdout.trim() === "1");
		}
	}
	const supported =
		platform === "darwin" && hostArm64 && isSupportedMacVersion(osVersion);
	const app = await readAppMetadata(appPath);
	const binary = appBinary(appPath);

	let service = {
		running: false,
		detail: app.installed ? "not checked" : "app missing",
	};
	let permissions = {
		granted: false,
		detail: app.installed ? "not checked" : "app missing",
	};
	if (app.installed) {
		const serviceResult = await safeExec(exec, binary, ["service-status"]);
		service = {
			running:
				serviceResult.code === 0 && parseServiceRunning(serviceResult.stdout),
			detail: (serviceResult.stdout || serviceResult.stderr).trim(),
		};

		const permissionResult = await safeExec(exec, binary, ["xpc-ping"]);
		const parsed = parsePermissionStatus(
			`${permissionResult.stdout}\n${permissionResult.stderr}`,
		);
		permissions = {
			granted:
				parsed?.accessibility === true && parsed?.screenRecording === true,
			accessibility: parsed?.accessibility,
			screenRecording: parsed?.screenRecording,
			detail: (permissionResult.stdout || permissionResult.stderr).trim(),
		};
	}

	const mcp = await detectKimiCuMcp({ cwd, env, home, appPath, projectTrusted });

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
		ready:
			supported &&
			app.installed &&
			service.running &&
			permissions.granted &&
			mcp.configured,
	};
}

export function formatKimiCuStatus(status) {
	const yesNo = (value) => (value === true ? "是/yes" : "否/no");
	const lines = [
		`KimiCU 本地环境 / Local setup: ${status.ready ? "ready" : "not ready"}`,
		`平台 / Platform: ${status.platform}/${status.arch}${status.osVersion ? ` · macOS ${status.osVersion}` : ""}${status.supported ? "" : "（要求 / requires macOS 14+ arm64）"}`,
		`App: ${status.app.installed ? `已安装 / installed${status.app.version ? ` · v${status.app.version}` : ""}` : "缺失 / missing"}`,
		`后台服务 / Service: ${status.service.running ? "运行中 / running" : "未运行 / not running"}`,
	];

	if (status.permissions.granted) {
		lines.push(
			"权限 / Permissions: 辅助功能、屏幕录制均已授权 / Accessibility & Screen Recording granted",
		);
	} else if (
		status.permissions.accessibility !== undefined ||
		status.permissions.screenRecording !== undefined
	) {
		lines.push(
			`权限 / Permissions: 辅助功能/Accessibility=${yesNo(status.permissions.accessibility)}，屏幕录制/Screen Recording=${yesNo(status.permissions.screenRecording)}`,
		);
	} else {
		lines.push(
			"权限 / Permissions: 无法通过后台服务读取 / unavailable via background service",
		);
	}

	lines.push(
		`MCP 配置 / MCP config: ${status.mcp.configured ? status.mcp.configPath : status.mcp.disabled ? "已禁用 / disabled" : status.mcp.needsMigration ? "旧配置需要迁移 / legacy config needs migration" : status.mcp.error ? "配置读取或校验失败 / invalid or unreadable config" : status.mcp.conflict ? "存在同名冲突 / name conflict" : "未配置 / not configured"}`,
		"MCP 连接与工具状态 / Connection and tool status: 请使用 Pi 内置 /mcp 检查 / check Pi's built-in /mcp",
	);

	if (status.mcp.needsMigration) lines.push(MCP_MIGRATION_GUIDANCE);
	for (const diagnostic of status.mcp.diagnostics ?? []) {
		lines.push(
			`MCP 配置提示 / Config warning (${diagnostic.configPath}): ${diagnostic.needsMigration ? MCP_MIGRATION_GUIDANCE : diagnostic.error}`,
		);
	}

	return lines.join("\n");
}
