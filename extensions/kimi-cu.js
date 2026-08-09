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
  requestKimiCuPermissions,
} from "../src/installer.js";
import { detectKimiCu, formatKimiCuStatus } from "../src/status.js";

const MCP_STATUS_EVENT = "pi-mcp-adapter/status/v1";
const MENU = {
  status: "查看状态",
  install: "安装",
  repair: "修复",
  update: "更新",
  mcp: "配置 MCP",
  permissions: "申请系统权限",
};

function extensionExec(pi) {
  return async (command, args, options) => {
    const result = await pi.exec(command, args, options);
    if (result?.killed !== true) return result;
    return {
      ...result,
      code: result.code === 0 ? -1 : result.code,
      stderr: result.stderr || "命令被终止（可能超时）",
    };
  };
}

function mcpConfigOverride(pi) {
  const value = pi.getFlag?.("mcp-config");
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function requireUi(ctx, action) {
  if (ctx.hasUI) return true;
  ctx.ui.notify(`${action} 需要交互式 Pi 会话`, "error");
  return false;
}

function operationLabel(step, percent) {
  if (step === "download") return `下载 KimiCU${typeof percent === "number" ? ` ${percent}%` : ""}`;
  if (step === "unpack") return "解压并验证 KimiCU";
  if (step === "replace") return "安装 KimiCU.app";
  return "处理 KimiCU";
}

async function showStatus(pi, ctx, adapterSnapshot) {
  const status = await detectKimiCu({
    exec: extensionExec(pi),
    cwd: ctx.cwd,
    mcpConfigPath: mcpConfigOverride(pi),
  });
  ctx.ui.notify(formatKimiCuStatus(status, adapterSnapshot), status.ready ? "info" : "warning");
  return status;
}

async function maybeReload(ctx, lifecycle) {
  if (!ctx.hasUI) return false;
  if (await ctx.ui.confirm("重新加载 Pi", "MCP 配置已更新。现在重新加载扩展和 MCP adapter？")) {
    ctx.ui.setStatus("kimi-cu", undefined);
    lifecycle.reloading = true;
    await ctx.reload();
    return true;
  } else {
    ctx.ui.notify("请稍后运行 /reload 使 MCP 配置生效", "info");
    return false;
  }
}

async function configureMcp(pi, ctx, lifecycle) {
  if (!requireUi(ctx, "配置 MCP")) return;

  const paths = mcpConfigPaths({ cwd: ctx.cwd, overridePath: mcpConfigOverride(pi) });
  const adapter = await detectPiMcpAdapter({ cwd: ctx.cwd });
  const adapterChoice = adapter.installed
    ? `Pi 专用配置（pi-mcp-adapter，已安装）`
    : `Pi 专用配置（安装 pi-mcp-adapter）`;
  const sharedChoice = `通用全局配置（${paths.sharedGlobal}）`;
  const customChoice = "其他 MCP JSON 路径";
  const manualChoice = "只显示配置片段";
  const choice = await ctx.ui.select("KimiCU MCP 接入方式", [
    adapterChoice,
    sharedChoice,
    customChoice,
    manualChoice,
  ]);
  if (!choice) return;

  if (choice === manualChoice) {
    await ctx.ui.editor("复制 KimiCU MCP 配置", mcpConfigSnippet());
    return { reloaded: false };
  }

  let configPath;
  if (choice === adapterChoice) {
    if (!adapter.installed) {
      const approved = await ctx.ui.confirm(
        "安装 pi-mcp-adapter",
        "将运行：pi install npm:pi-mcp-adapter。继续？",
      );
      if (!approved) return;
      ctx.ui.setStatus("kimi-cu", "安装 pi-mcp-adapter");
      const installed = await extensionExec(pi)("pi", ["install", "npm:pi-mcp-adapter"], {
        timeout: 180_000,
      });
      ctx.ui.setStatus("kimi-cu", undefined);
      if (installed.code !== 0) {
        throw new Error(`pi-mcp-adapter 安装失败：${installed.stderr || installed.stdout}`);
      }
    }
    configPath = paths.piGlobal;
  } else if (choice === sharedChoice) {
    configPath = paths.sharedGlobal;
  } else {
    const input = await ctx.ui.input("MCP JSON 路径", paths.piGlobal);
    if (!input?.trim()) return;
    configPath = input.trim().startsWith("~/")
      ? path.join(homedir(), input.trim().slice(2))
      : path.resolve(ctx.cwd, input.trim());
  }

  const result = await writeMcpConfig(configPath);
  ctx.ui.notify(
    result.changed ? `已更新 MCP 配置：${result.configPath}` : `MCP 配置已经是最新状态：${result.configPath}`,
    "info",
  );
  return { reloaded: await maybeReload(ctx, lifecycle) };
}

async function runSetup(pi, ctx, mode, lifecycle) {
  if (!requireUi(ctx, `${mode === "update" ? "更新" : mode === "repair" ? "修复" : "安装"} KimiCU`)) {
    return;
  }

  const before = await detectKimiCu({
    exec: extensionExec(pi),
    cwd: ctx.cwd,
    mcpConfigPath: mcpConfigOverride(pi),
  });
  if (!before.supported) {
    ctx.ui.notify("KimiCU 当前只支持 Apple Silicon Mac，且官方 App 要求 macOS 14 或更高版本", "error");
    return;
  }

  const forceAppInstall = mode === "update";
  const needAppInstall = forceAppInstall || !before.app.installed;
  const action = forceAppInstall ? "更新" : before.app.installed ? "修复" : "安装";
  const approved = await ctx.ui.confirm(
    `${action} Kimi Computer Use`,
    `${needAppInstall ? "将从 cdn.kimi.com 下载并安装到 /Applications/KimiCU.app；" : "将保留现有 App；"}随后会注册后台服务、检查权限并配置 MCP。继续？`,
  );
  if (!approved) return;

  try {
    if (needAppInstall) {
      await installKimiCuApp({
        exec: extensionExec(pi),
        onProgress: (step, percent) => ctx.ui.setStatus("kimi-cu", operationLabel(step, percent)),
        approveInvalidSignature: (detail) =>
          ctx.ui.confirm(
            "KimiCU 签名验证失败",
            `codesign 未通过：${detail || "无详细信息"}\n\n继续安装会绕过本扩展的完整性保护。是否仍然继续？`,
          ),
      });
    }

    if (needAppInstall || !before.service.running) {
      ctx.ui.setStatus("kimi-cu", "注册 KimiCU 后台服务");
      await ensureKimiCuService({ exec: extensionExec(pi) });
    }

    const afterService = await detectKimiCu({
      exec: extensionExec(pi),
      cwd: ctx.cwd,
      mcpConfigPath: mcpConfigOverride(pi),
    });
    if (!afterService.permissions.granted) {
      ctx.ui.setStatus("kimi-cu", "申请 KimiCU 系统权限");
      const permissionRequest = await requestKimiCuPermissions({ exec: extensionExec(pi) });
      ctx.ui.notify(
        `${permissionRequest.requested ? "已发起权限请求。" : `权限请求命令未成功：${permissionRequest.detail || "unknown error"}。`}请在 系统设置 → 隐私与安全性 中为 KimiCU 开启“辅助功能”和“屏幕录制”，完成后运行 /kimi-cu status 检查。`,
        "warning",
      );
    }

    if (!afterService.mcp.configured) {
      const configure = await ctx.ui.confirm("配置 MCP", "KimiCU App 已就绪。现在配置 Pi 的 MCP 接入？");
      if (configure) {
        const configured = await configureMcp(pi, ctx, lifecycle);
        if (configured?.reloaded) return;
      }
    }

    await showStatus(pi, ctx);
  } finally {
    if (!lifecycle.reloading) ctx.ui.setStatus("kimi-cu", undefined);
  }
}

async function requestPermissions(pi, ctx) {
  if (!requireUi(ctx, "申请权限")) return;
  const status = await detectKimiCu({
    exec: extensionExec(pi),
    cwd: ctx.cwd,
    mcpConfigPath: mcpConfigOverride(pi),
  });
  if (!status.app.installed) {
    ctx.ui.notify("KimiCU.app 尚未安装，请先运行 /kimi-cu install", "error");
    return;
  }
  const result = await requestKimiCuPermissions({ exec: extensionExec(pi) });
  ctx.ui.notify(
    `${result.requested ? "权限窗口已请求。" : `权限请求命令未成功：${result.detail || "unknown error"}。`}请在系统设置中手动开启 KimiCU 的辅助功能和屏幕录制权限。`,
    "warning",
  );
}

async function dispatch(pi, args, ctx, adapterSnapshot, lifecycle) {
  const command = args.trim().split(/\s+/)[0]?.toLowerCase() || "menu";
  if (command === "status") return showStatus(pi, ctx, adapterSnapshot);
  if (command === "install" || command === "repair" || command === "update") {
    return runSetup(pi, ctx, command, lifecycle);
  }
  if (command === "mcp") return configureMcp(pi, ctx, lifecycle);
  if (command === "permissions") return requestPermissions(pi, ctx);
  if (command !== "menu" && command !== "help") {
    ctx.ui.notify("用法：/kimi-cu [status|install|repair|update|mcp|permissions]", "warning");
    return;
  }
  if (!requireUi(ctx, "KimiCU 菜单")) return;

  const selected = await ctx.ui.select("Kimi Computer Use", Object.values(MENU));
  if (!selected) return;
  const selectedCommand = Object.entries(MENU).find(([, label]) => label === selected)?.[0];
  if (selectedCommand) return dispatch(pi, selectedCommand, ctx, adapterSnapshot, lifecycle);
}

export default function kimiCuExtension(pi) {
  let adapterSnapshot;
  const unsubscribe = pi.events.on(MCP_STATUS_EVENT, (snapshot) => {
    if (snapshot && typeof snapshot === "object") adapterSnapshot = snapshot;
  });
  pi.on("session_shutdown", () => unsubscribe());

  pi.registerCommand("kimi-cu", {
    description: "安装、检测、修复并配置 Kimi Computer Use",
    getArgumentCompletions: (prefix) => {
      const values = ["status", "install", "repair", "update", "mcp", "permissions"];
      const matches = values.filter((value) => value.startsWith(prefix));
      return matches.length > 0 ? matches.map((value) => ({ value, label: value })) : null;
    },
    handler: async (args, ctx) => {
      const lifecycle = { reloading: false };
      try {
        await dispatch(pi, args, ctx, adapterSnapshot, lifecycle);
      } catch (error) {
        if (lifecycle.reloading) return;
        ctx.ui.setStatus("kimi-cu", undefined);
        ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
      }
    },
  });
}
