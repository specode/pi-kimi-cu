import { homedir } from "node:os";
import path from "node:path";

import {
	detectPiMcpAdapter,
	mcpConfigPaths,
	mcpConfigSnippet,
	writeMcpConfig,
} from "../src/mcp-config.js";
import {
	ensureKimiCuService,
	installKimiCuApp,
	openKimiCuApp,
} from "../src/installer.js";
import { detectKimiCu, formatKimiCuStatus } from "../src/status.js";

const MCP_STATUS_EVENT = "pi-mcp-adapter/status/v1";
const MENU = {
	status: "检查状态 / Check status",
	setup: "引导配置 / Guided setup",
};

function extensionExec(pi) {
	return async (command, args, options) => {
		const result = await pi.exec(command, args, options);
		if (result?.killed !== true) return result;
		return {
			...result,
			code: result.code === 0 ? -1 : result.code,
			stderr:
				result.stderr ||
				"命令被终止（可能超时） / Command terminated (possible timeout)",
		};
	};
}

function mcpConfigOverride(pi) {
	const value = pi.getFlag?.("mcp-config");
	return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function requireUi(ctx, action) {
	if (ctx.hasUI) return true;
	ctx.ui.notify(
		`${action} 需要交互式 Pi 会话 / requires an interactive Pi session`,
		"error",
	);
	return false;
}

function operationLabel(step, percent) {
	if (step === "download") {
		return `下载 KimiCU / Downloading KimiCU${typeof percent === "number" ? ` ${percent}%` : ""}`;
	}
	if (step === "unpack")
		return "解压并验证 KimiCU / Unpacking and verifying KimiCU";
	if (step === "replace") return "安装 KimiCU.app / Installing KimiCU.app";
	return "处理 KimiCU / Working on KimiCU";
}

function mcpRuntime(adapterSnapshot) {
	if (!adapterSnapshot || !Array.isArray(adapterSnapshot.servers))
		return undefined;
	return adapterSnapshot.servers.find((server) => server?.name === "kimi-cu");
}

function isMcpConnected(adapterSnapshot) {
	const runtime = mcpRuntime(adapterSnapshot);
	if (!runtime) return false;
	const status = String(runtime.status ?? "").toLowerCase();
	return status === "connected" || status === "ready" || status === "ok";
}

async function detect(pi, ctx) {
	return detectKimiCu({
		exec: extensionExec(pi),
		cwd: ctx.cwd,
		mcpConfigPath: mcpConfigOverride(pi),
	});
}

async function showStatus(pi, ctx, adapterSnapshot) {
	const status = await detect(pi, ctx);
	ctx.ui.notify(
		formatKimiCuStatus(status, adapterSnapshot),
		status.ready ? "info" : "warning",
	);
	return status;
}

async function maybeReload(ctx, lifecycle) {
	if (!ctx.hasUI) return false;
	if (
		await ctx.ui.confirm(
			"重新加载 Pi / Reload Pi",
			"MCP 配置已更新。现在重新加载扩展和 MCP adapter？ / MCP config updated. Reload extensions and the MCP adapter now?",
		)
	) {
		ctx.ui.setStatus("kimi-cu", undefined);
		lifecycle.reloading = true;
		await ctx.reload();
		return true;
	}
	ctx.ui.notify(
		"请稍后运行 /reload 使 MCP 配置生效 / Run /reload later for the MCP config to take effect",
		"info",
	);
	return false;
}

async function installAdapter(pi, ctx, message) {
	const approved = await ctx.ui.confirm(
		"安装 pi-mcp-adapter / Install pi-mcp-adapter",
		message,
	);
	if (!approved) return false;
	ctx.ui.setStatus(
		"kimi-cu",
		"安装 pi-mcp-adapter / Installing pi-mcp-adapter",
	);
	const installed = await extensionExec(pi)(
		"pi",
		["install", "npm:pi-mcp-adapter"],
		{
			timeout: 180_000,
		},
	);
	ctx.ui.setStatus("kimi-cu", undefined);
	if (installed.code !== 0) {
		throw new Error(
			`pi-mcp-adapter 安装失败 / install failed：${installed.stderr || installed.stdout}`,
		);
	}
	return true;
}

async function configureMcp(pi, ctx, lifecycle, { interactive = true } = {}) {
	if (!requireUi(ctx, "配置 MCP / Configure MCP")) return;

	const paths = mcpConfigPaths({
		cwd: ctx.cwd,
		overridePath: mcpConfigOverride(pi),
	});
	const override = mcpConfigOverride(pi);

	// Guided setup uses a simple default path; /kimi-cu mcp keeps the full chooser.
	if (!interactive) {
		const adapter = await detectPiMcpAdapter({ cwd: ctx.cwd });
		if (!adapter.installed) {
			await installAdapter(
				pi,
				ctx,
				"推荐安装 pi-mcp-adapter 以便 Pi 连接 KimiCU。将运行：pi install npm:pi-mcp-adapter。继续？ / Recommended so Pi can connect to KimiCU. Will run: pi install npm:pi-mcp-adapter. Continue?",
			);
		}
		const configPath = override || paths.piGlobal;
		const result = await writeMcpConfig(configPath);
		ctx.ui.notify(
			result.changed
				? `已更新 MCP 配置 / Updated MCP config：${result.configPath}`
				: `MCP 配置已经是最新状态 / MCP config already up to date：${result.configPath}`,
			"info",
		);
		return { reloaded: await maybeReload(ctx, lifecycle) };
	}

	const adapter = await detectPiMcpAdapter({ cwd: ctx.cwd });
	const adapterChoice = adapter.installed
		? "Pi 专用配置（pi-mcp-adapter，已安装） / Pi-native config (pi-mcp-adapter installed)"
		: "Pi 专用配置（安装 pi-mcp-adapter） / Pi-native config (install pi-mcp-adapter)";
	const sharedChoice = `通用全局配置 / Shared global config（${paths.sharedGlobal}）`;
	const customChoice = "其他 MCP JSON 路径 / Custom MCP JSON path";
	const manualChoice = "只显示配置片段 / Show config snippet only";
	const choice = await ctx.ui.select("KimiCU MCP 接入方式 / MCP wiring", [
		adapterChoice,
		sharedChoice,
		customChoice,
		manualChoice,
	]);
	if (!choice) return;

	if (choice === manualChoice) {
		await ctx.ui.editor(
			"复制 KimiCU MCP 配置 / Copy KimiCU MCP config",
			mcpConfigSnippet(),
		);
		return { reloaded: false };
	}

	let configPath;
	if (choice === adapterChoice) {
		if (!adapter.installed) {
			const installed = await installAdapter(
				pi,
				ctx,
				"将运行：pi install npm:pi-mcp-adapter。继续？ / Will run: pi install npm:pi-mcp-adapter. Continue?",
			);
			if (!installed) return;
		}
		configPath = paths.piGlobal;
	} else if (choice === sharedChoice) {
		configPath = paths.sharedGlobal;
	} else {
		const input = await ctx.ui.input(
			"MCP JSON 路径 / MCP JSON path",
			paths.piGlobal,
		);
		if (!input?.trim()) return;
		configPath = input.trim().startsWith("~/")
			? path.join(homedir(), input.trim().slice(2))
			: path.resolve(ctx.cwd, input.trim());
	}

	const result = await writeMcpConfig(configPath);
	ctx.ui.notify(
		result.changed
			? `已更新 MCP 配置 / Updated MCP config：${result.configPath}`
			: `MCP 配置已经是最新状态 / MCP config already up to date：${result.configPath}`,
		"info",
	);
	return { reloaded: await maybeReload(ctx, lifecycle) };
}

async function runSetupGuide(pi, ctx, adapterSnapshot, lifecycle) {
	if (!requireUi(ctx, "引导配置 / Guided setup")) return;

	const exec = extensionExec(pi);
	let status = await detect(pi, ctx);

	if (!status.supported) {
		ctx.ui.notify(
			"KimiCU 当前只支持 Apple Silicon Mac，且官方 App 要求 macOS 14 或更高版本 / KimiCU currently requires Apple Silicon Mac and macOS 14+",
			"error",
		);
		return;
	}

	try {
		// 1) App
		if (!status.app.installed) {
			const approved = await ctx.ui.confirm(
				"安装 KimiCU / Install KimiCU",
				"未检测到 /Applications/KimiCU.app。从官方 CDN 下载并安装？ / KimiCU.app not found. Download from the official CDN and install?",
			);
			if (!approved) {
				ctx.ui.notify(
					"已跳过安装。装好 App 后可再运行 /kimi-cu setup / Install skipped. Run /kimi-cu setup again after installing the app",
					"info",
				);
				return;
			}
			await installKimiCuApp({
				exec,
				onProgress: (step, percent) =>
					ctx.ui.setStatus("kimi-cu", operationLabel(step, percent)),
				approveInvalidSignature: (detail) =>
					ctx.ui.confirm(
						"KimiCU 签名验证失败 / Signature verification failed",
						`codesign 未通过 / codesign failed：${detail || "无详细信息 / no details"}\n\n继续安装会绕过本扩展的完整性保护。是否仍然继续？ / Continuing bypasses this extension's integrity checks. Continue anyway?`,
					),
			});
			status = await detect(pi, ctx);
		}

		// 2) Background service / app runtime
		if (!status.service.running) {
			const approved = await ctx.ui.confirm(
				"启动 KimiCU 后台服务 / Start KimiCU background service",
				"KimiCU 已安装，但后台服务未运行。现在注册并启动？ / KimiCU is installed but the background service is not running. Register and start it now?",
			);
			if (!approved) {
				ctx.ui.notify(
					"后台服务未启动，后续权限与 MCP 可能不可用 / Background service not started; permissions and MCP may be unavailable",
					"warning",
				);
			} else {
				ctx.ui.setStatus(
					"kimi-cu",
					"注册 KimiCU 后台服务 / Registering KimiCU background service",
				);
				await ensureKimiCuService({ exec });
				status = await detect(pi, ctx);
			}
		}

		// 3) Permissions — hand off to the official app UI
		if (status.app.installed && !status.permissions.granted) {
			ctx.ui.setStatus("kimi-cu", "打开 KimiCU / Opening KimiCU");
			const opened = await openKimiCuApp({ exec });
			ctx.ui.setStatus("kimi-cu", undefined);
			await ctx.ui.confirm(
				"在 KimiCU 中确认权限 / Confirm permissions in KimiCU",
				`${opened.opened ? "已打开 KimiCU。/ Opened KimiCU. " : "请手动打开 KimiCU。/ Please open KimiCU manually. "}在 App 窗口里把 Accessibility 和 Screen Recording 都设为 Allowed，完成后点继续。/ In the app window, set Accessibility and Screen Recording to Allowed, then continue.`,
			);
			status = await detect(pi, ctx);
			if (!status.permissions.granted) {
				ctx.ui.notify(
					"权限仍未就绪。请在 KimiCU App 中处理，然后可再运行 /kimi-cu setup 或 /kimi-cu status / Permissions still missing. Fix them in the KimiCU app, then run /kimi-cu setup or /kimi-cu status again",
					"warning",
				);
			}
		}

		// 4) MCP config
		if (!status.mcp.configured) {
			if (status.mcp.conflict) {
				ctx.ui.notify(
					`MCP 配置存在同名冲突 / MCP config name conflict（${status.mcp.configPath || "未知路径 / unknown path"}），请手动检查后重试 / please inspect manually and retry`,
					"error",
				);
			} else {
				const approved = await ctx.ui.confirm(
					"配置 MCP / Configure MCP",
					"尚未配置 kimi-cu MCP。现在写入默认 Pi MCP 配置？ / kimi-cu MCP is not configured. Write the default Pi MCP config now?",
				);
				if (approved) {
					const configured = await configureMcp(pi, ctx, lifecycle, {
						interactive: false,
					});
					if (configured?.reloaded) return;
					status = await detect(pi, ctx);
				} else {
					ctx.ui.notify(
						"已跳过 MCP 配置。需要时可再运行 /kimi-cu setup / MCP config skipped. Run /kimi-cu setup again when needed",
						"info",
					);
				}
			}
		}

		// 5) MCP connection
		if (status.mcp.configured && !isMcpConnected(adapterSnapshot)) {
			const runtime = mcpRuntime(adapterSnapshot);
			const detail = runtime?.status
				? `当前运行状态 / Current runtime status：${runtime.status}。`
				: "当前会话尚未看到 kimi-cu 已连接。/ This session has not seen kimi-cu connected yet. ";
			const reload = await ctx.ui.confirm(
				"MCP 尚未连接 / MCP not connected",
				`${detail}重新加载 Pi 以连接 KimiCU MCP？ / Reload Pi to connect KimiCU MCP?`,
			);
			if (reload) {
				ctx.ui.setStatus("kimi-cu", undefined);
				lifecycle.reloading = true;
				await ctx.reload();
				return;
			}
			ctx.ui.notify(
				"可稍后运行 /reload，再用 /kimi-cu status 确认连接 / Run /reload later, then /kimi-cu status to verify",
				"info",
			);
		}

		if (
			status.app.installed &&
			status.service.running &&
			status.permissions.granted &&
			status.mcp.configured &&
			isMcpConnected(adapterSnapshot)
		) {
			ctx.ui.notify(
				"环境已就绪，无需额外配置 / Environment is ready; no further setup needed",
				"info",
			);
		}

		await showStatus(pi, ctx, adapterSnapshot);
	} finally {
		if (!lifecycle.reloading) ctx.ui.setStatus("kimi-cu", undefined);
	}
}

async function dispatch(pi, args, ctx, adapterSnapshot, lifecycle) {
	const command = args.trim().split(/\s+/)[0]?.toLowerCase() || "menu";
	if (command === "status") return showStatus(pi, ctx, adapterSnapshot);
	if (
		command === "setup" ||
		command === "install" ||
		command === "repair" ||
		command === "update"
	) {
		return runSetupGuide(pi, ctx, adapterSnapshot, lifecycle);
	}
	if (command === "mcp")
		return configureMcp(pi, ctx, lifecycle, { interactive: true });
	if (command !== "menu" && command !== "help") {
		ctx.ui.notify("用法 / Usage：/kimi-cu [status|setup]", "warning");
		return;
	}
	if (!requireUi(ctx, "KimiCU 菜单 / menu")) return;

	const selected = await ctx.ui.select(
		"Kimi Computer Use",
		Object.values(MENU),
	);
	if (!selected) return;
	const selectedCommand = Object.entries(MENU).find(
		([, label]) => label === selected,
	)?.[0];
	if (selectedCommand)
		return dispatch(pi, selectedCommand, ctx, adapterSnapshot, lifecycle);
}

export default function kimiCuExtension(pi) {
	let adapterSnapshot;
	const unsubscribe = pi.events.on(MCP_STATUS_EVENT, (snapshot) => {
		if (snapshot && typeof snapshot === "object") adapterSnapshot = snapshot;
	});
	pi.on("session_shutdown", () => unsubscribe());

	pi.registerCommand("kimi-cu", {
		description:
			"检查状态或引导配置 Kimi Computer Use / Check status or guided setup for Kimi Computer Use",
		getArgumentCompletions: (prefix) => {
			const values = ["status", "setup"];
			const matches = values.filter((value) => value.startsWith(prefix));
			return matches.length > 0
				? matches.map((value) => ({ value, label: value }))
				: null;
		},
		handler: async (args, ctx) => {
			const lifecycle = { reloading: false };
			try {
				await dispatch(pi, args, ctx, adapterSnapshot, lifecycle);
			} catch (error) {
				if (lifecycle.reloading) return;
				ctx.ui.setStatus("kimi-cu", undefined);
				ctx.ui.notify(
					error instanceof Error ? error.message : String(error),
					"error",
				);
			}
		},
	});
}
