import { constants } from "node:fs";
import {
	access,
	mkdir,
	mkdtemp,
	open,
	readFile,
	readdir,
	rm,
} from "node:fs/promises";
import path from "node:path";

import {
	APP_BUNDLE_ID,
	APP_DOWNLOAD_URL,
	APP_NAME,
	APP_TEAM_ID,
	COMMAND_TIMEOUT_MS,
	DEFAULT_APP_PATH,
	DOWNLOAD_TIMEOUT_MS,
	LAUNCHD_LABEL,
	MAX_ARCHIVE_BYTES,
	PROBE_TIMEOUT_MS,
	appBinary,
	appInfoPlist,
	defaultTempDir,
} from "./constants.js";
import { parsePermissionStatus, parseServiceRunning } from "./status.js";

function errorMessage(error) {
	return error instanceof Error ? error.message : String(error);
}

export function shellQuote(value) {
	return `'${String(value).replaceAll("'", "'\\''")}'`;
}

function appleScriptQuote(value) {
	return value.replaceAll("\\", "\\\\").replaceAll('"', '\\"');
}

function uniqueInstallPath(appPath, kind, nonce) {
	return path.join(
		path.dirname(appPath),
		`.${path.basename(appPath)}.${kind}-${nonce}`,
	);
}

export function buildReplacementScript(sourceApp, appPath, nonce) {
	const candidate = uniqueInstallPath(appPath, "new", nonce);
	const backup = uniqueInstallPath(appPath, "backup", nonce);
	return [
		`/bin/rm -rf ${shellQuote(candidate)} ${shellQuote(backup)}`,
		`/usr/bin/ditto ${shellQuote(sourceApp)} ${shellQuote(candidate)} || exit $?`,
		"had_old=0",
		`if [ -e ${shellQuote(appPath)} ]; then /bin/mv ${shellQuote(appPath)} ${shellQuote(backup)} || { /bin/rm -rf ${shellQuote(candidate)}; exit 1; }; had_old=1; fi`,
		`if /bin/mv ${shellQuote(candidate)} ${shellQuote(appPath)}; then [ "$had_old" -eq 0 ] || /bin/rm -rf ${shellQuote(backup)}; else code=$?; /bin/rm -rf ${shellQuote(candidate)}; [ "$had_old" -eq 0 ] || /bin/mv ${shellQuote(backup)} ${shellQuote(appPath)}; exit "$code"; fi`,
	].join("; ");
}

export async function downloadFile(
	url,
	destination,
	fetchImpl,
	onProgress,
	timeout = DOWNLOAD_TIMEOUT_MS,
) {
	const controller = new AbortController();
	const timeoutId = setTimeout(
		() =>
			controller.abort(
				new Error(`下载超时 / download timed out after ${timeout} ms`),
			),
		timeout,
	);
	let handle;
	try {
		const response = await fetchImpl(url, {
			redirect: "follow",
			signal: controller.signal,
		});
		if (!response.ok || response.body === null) {
			throw new Error(`下载失败 / download failed：HTTP ${response.status}`);
		}
		const announcedSize = Number(response.headers.get("content-length"));
		if (Number.isFinite(announcedSize) && announcedSize > MAX_ARCHIVE_BYTES) {
			throw new Error(
				`下载文件超过上限 / download exceeds ${MAX_ARCHIVE_BYTES} bytes`,
			);
		}

		handle = await open(destination, "wx", 0o600);
		let received = 0;
		for await (const chunk of response.body) {
			received += chunk.byteLength;
			if (received > MAX_ARCHIVE_BYTES)
				throw new Error(
					"下载文件超过安全大小上限 / download exceeds safe size limit",
				);
			await handle.write(chunk);
			if (Number.isFinite(announcedSize) && announcedSize > 0) {
				onProgress?.(
					Math.min(100, Math.round((received / announcedSize) * 100)),
				);
			}
		}
	} catch (error) {
		if (controller.signal.aborted) {
			throw new Error(
				`下载超时 / download timed out：${timeout} ms 内未完成 / not finished`,
				{ cause: error },
			);
		}
		throw error;
	} finally {
		clearTimeout(timeoutId);
		await handle?.close();
	}
}

function commandSucceeded(result) {
	return result?.code === 0 && result.killed !== true;
}

function plistString(xml, key) {
	const escapedKey = key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
	return new RegExp(
		`<key>${escapedKey}<\\/key>\\s*<string>([^<]+)<\\/string>`,
	).exec(xml)?.[1];
}

async function inspectStagedApp(exec, stagedApp) {
	const entries = (await readdir(path.dirname(stagedApp))).filter(
		(entry) =>
			entry !== APP_NAME && entry !== "__MACOSX" && entry !== ".DS_Store",
	);
	if (entries.length > 0)
		throw new Error(
			`安装包包含非预期顶层文件 / unexpected top-level files：${entries.join(", ")}`,
		);

	const binary = appBinary(stagedApp);
	await access(binary, constants.X_OK);
	const info = await readFile(appInfoPlist(stagedApp), "utf8");
	const bundleId = plistString(info, "CFBundleIdentifier");
	if (bundleId !== APP_BUNDLE_ID)
		throw new Error(`Bundle ID 不匹配 / mismatch：${bundleId ?? "missing"}`);

	const arch = await exec("lipo", ["-archs", binary], {
		timeout: PROBE_TIMEOUT_MS,
	});
	if (!commandSucceeded(arch) || !arch.stdout.split(/\s+/).includes("arm64")) {
		throw new Error(
			`KimiCU 二进制不包含 arm64 / binary missing arm64：${arch.stderr || arch.stdout}`,
		);
	}

	const signatureInfo = await exec(
		"codesign",
		["-dv", "--verbose=4", stagedApp],
		{
			timeout: PROBE_TIMEOUT_MS,
		},
	);
	const signatureOutput = `${signatureInfo.stdout}\n${signatureInfo.stderr}`;
	if (!commandSucceeded(signatureInfo)) {
		throw new Error(
			`无法读取 KimiCU 签名信息 / cannot read signature：${signatureInfo.stderr || signatureInfo.stdout}`,
		);
	}
	const teamId = /TeamIdentifier=([^\s]+)/.exec(signatureOutput)?.[1];
	if (teamId !== APP_TEAM_ID)
		throw new Error(
			`签名 Team ID 不匹配 / signing Team ID mismatch：${teamId ?? "missing"}`,
		);

	const signature = await exec(
		"codesign",
		["--verify", "--deep", "--strict", "--verbose=2", stagedApp],
		{ timeout: PROBE_TIMEOUT_MS },
	);

	return {
		binary,
		version: plistString(info, "CFBundleShortVersionString"),
		minimumSystemVersion: plistString(info, "LSMinimumSystemVersion"),
		signatureValid: commandSucceeded(signature),
		signatureDetail: signature.killed
			? `codesign 验证被终止（可能超时） / verification terminated (possible timeout)：${(signature.stderr || signature.stdout).trim() || "无输出 / no output"}`
			: (signature.stderr || signature.stdout).trim(),
	};
}

async function bestEffort(exec, command, args, timeout = COMMAND_TIMEOUT_MS) {
	try {
		await exec(command, args, { timeout });
	} catch {
		// Cleanup probes are deliberately best-effort.
	}
}

async function stopOldRuntime(exec, appPath, sleep) {
	const binary = appBinary(appPath);
	try {
		await access(binary, constants.X_OK);
		await bestEffort(exec, binary, ["uninstall"]);
	} catch {
		// No prior app.
	}
	const uid =
		typeof process.getuid === "function" ? String(process.getuid()) : "501";
	await bestEffort(exec, "launchctl", [
		"bootout",
		`gui/${uid}/${LAUNCHD_LABEL}`,
	]);
	for (const mode of ["service", "overlay"]) {
		await bestEffort(exec, "pkill", [
			"-f",
			`${APP_NAME}/Contents/MacOS/kimi-cu[[:space:]]+${mode}`,
		]);
	}
	await sleep(750);
}

async function replaceApp(exec, stagedApp, appPath) {
	const directNonce = `${process.pid}-${Date.now()}-direct`;
	const directScript = buildReplacementScript(stagedApp, appPath, directNonce);
	const direct = await exec("/bin/sh", ["-c", directScript], {
		timeout: 120_000,
	});
	if (commandSucceeded(direct)) return;

	const elevatedNonce = `${process.pid}-${Date.now()}-elevated`;
	const elevatedScript = buildReplacementScript(
		stagedApp,
		appPath,
		elevatedNonce,
	);
	const appleScript = `do shell script "${appleScriptQuote(elevatedScript)}" with administrator privileges`;
	const elevated = await exec("osascript", ["-e", appleScript], {
		timeout: 180_000,
	});
	if (!commandSucceeded(elevated)) {
		throw new Error(
			`无法安装到 ${appPath} / cannot install to ${appPath}（direct: ${(direct.stderr || direct.stdout).trim() || direct.code}; elevated: ${(elevated.stderr || elevated.stdout).trim() || elevated.code}）`,
		);
	}
}

export async function installKimiCuApp({
	exec,
	fetchImpl = globalThis.fetch,
	appPath = DEFAULT_APP_PATH,
	tempBase = defaultTempDir(),
	onProgress,
	approveInvalidSignature = async () => false,
	downloadTimeout = DOWNLOAD_TIMEOUT_MS,
	sleep = (milliseconds) =>
		new Promise((resolve) => setTimeout(resolve, milliseconds)),
} = {}) {
	if (typeof exec !== "function")
		throw new Error("installKimiCuApp requires an exec function");
	if (typeof fetchImpl !== "function")
		throw new Error(
			"当前 Node.js 环境不支持 fetch / fetch is not available in this Node.js runtime",
		);

	const workDir = await mkdtemp(path.join(tempBase, "kimi-cu-install-"));
	try {
		const archivePath = path.join(workDir, "KimiCU.app.zip");
		onProgress?.("download", 0);
		await downloadFile(
			APP_DOWNLOAD_URL,
			archivePath,
			fetchImpl,
			(percent) => onProgress?.("download", percent),
			downloadTimeout,
		);

		const unzipDir = path.join(workDir, "unzipped");
		await mkdir(unzipDir, { recursive: true });
		onProgress?.("unpack");
		const unpacked = await exec("ditto", ["-x", "-k", archivePath, unzipDir], {
			timeout: 120_000,
		});
		if (!commandSucceeded(unpacked)) {
			throw new Error(
				`解压失败 / unpack failed：${unpacked.stderr || unpacked.stdout}`,
			);
		}

		const stagedApp = path.join(unzipDir, APP_NAME);
		const inspection = await inspectStagedApp(exec, stagedApp);
		if (!inspection.signatureValid) {
			const approved = await approveInvalidSignature(
				inspection.signatureDetail,
			);
			if (!approved)
				throw new Error(
					`KimiCU 代码签名验证失败 / code signature verification failed：${inspection.signatureDetail}`,
				);
		}

		onProgress?.("replace");
		let hadPreviousApp = false;
		try {
			await access(appBinary(appPath), constants.X_OK);
			hadPreviousApp = true;
		} catch {
			// Fresh install.
		}
		await stopOldRuntime(exec, appPath, sleep);
		try {
			await replaceApp(exec, stagedApp, appPath);
		} catch (replaceError) {
			if (hadPreviousApp) {
				try {
					await ensureKimiCuService({ exec, appPath, sleep });
				} catch (restoreError) {
					throw new Error(
						`${errorMessage(replaceError)}；恢复原后台服务失败 / failed to restore previous background service：${errorMessage(restoreError)}`,
						{ cause: replaceError },
					);
				}
			}
			throw replaceError;
		}
		return inspection;
	} finally {
		await rm(workDir, { recursive: true, force: true }).catch(() => undefined);
	}
}

export async function ensureKimiCuService({
	exec,
	appPath = DEFAULT_APP_PATH,
	sleep = (milliseconds) =>
		new Promise((resolve) => setTimeout(resolve, milliseconds)),
} = {}) {
	const binary = appBinary(appPath);
	await bestEffort(exec, binary, ["uninstall"]);
	const uid =
		typeof process.getuid === "function" ? String(process.getuid()) : "501";
	await bestEffort(exec, "launchctl", [
		"bootout",
		`gui/${uid}/${LAUNCHD_LABEL}`,
	]);
	const installed = await exec(binary, ["install"], {
		timeout: COMMAND_TIMEOUT_MS,
	});
	if (!commandSucceeded(installed)) {
		throw new Error(
			`后台服务安装失败 / background service install failed：${installed.stderr || installed.stdout}`,
		);
	}
	await sleep(1_000);
	const status = await exec(binary, ["service-status"], {
		timeout: PROBE_TIMEOUT_MS,
	});
	if (!commandSucceeded(status) || !parseServiceRunning(status.stdout)) {
		throw new Error(
			`后台服务未运行 / background service not running：${status.stderr || status.stdout}`,
		);
	}
}

/** Open the official KimiCU.app UI (permissions are handled there). */
export async function openKimiCuApp({ exec, appPath = DEFAULT_APP_PATH } = {}) {
	if (typeof exec !== "function")
		throw new Error("openKimiCuApp requires an exec function");
	try {
		const result = await exec("open", ["-a", appPath], {
			timeout: PROBE_TIMEOUT_MS,
		});
		return {
			opened: commandSucceeded(result),
			detail: (result.stderr || result.stdout || "").trim() || undefined,
		};
	} catch (error) {
		return { opened: false, detail: errorMessage(error) };
	}
}

export async function probeKimiCuPermissions({
	exec,
	appPath = DEFAULT_APP_PATH,
} = {}) {
	try {
		const result = await exec(appBinary(appPath), ["xpc-ping"], {
			timeout: PROBE_TIMEOUT_MS,
		});
		return parsePermissionStatus(`${result.stdout}\n${result.stderr}`);
	} catch (error) {
		return { error: errorMessage(error) };
	}
}
