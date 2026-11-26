import { useCallback, useEffect, useRef, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { getVersion } from "@tauri-apps/api/app";
import { check, type Update } from "@tauri-apps/plugin-updater";
import { relaunch } from "@tauri-apps/plugin-process";
import {
  AlertTriangle,
  ArrowUpCircle,
  CheckCircle2,
  Download,
  Eye,
  EyeOff,
  Keyboard,
  ListFilter,
  Loader2,
  MousePointerClick,
  Plus,
  RefreshCw,
  Save,
  ShieldCheck,
  Sparkles,
  Trash2,
} from "lucide-react";
import {
  api,
  isTranslateGateway,
  REASONING_EFFORT_OPTIONS,
  type AppSettings,
  type ProviderConfig,
  type ProviderKind,
  type ReasoningEffort,
} from "../lib/tauri";

const OPENCODE_PRESET_MODELS = [
  "deepseek-v4.1-flash",
  "deepseek-v4-pro",
  "glm-5.3-flash",
  "kimi-k3",
  "qwen3.7-plus",
];

const PROVIDER_TEMPLATES: { name: string; baseUrl: string; model: string }[] = [
  { name: "自定义供应商", baseUrl: "https://", model: "" },
  { name: "DeepSeek 官方", baseUrl: "https://api.deepseek.com/v1", model: "deepseek-chat" },
  { name: "OpenAI 官方", baseUrl: "https://api.openai.com/v1", model: "gpt-4o-mini" },
  { name: "OpenRouter", baseUrl: "https://openrouter.ai/api/v1", model: "deepseek/deepseek-chat" },
  { name: "硅基流动", baseUrl: "https://api.siliconflow.cn/v1", model: "deepseek-ai/DeepSeek-V3" },
  { name: "本地 Ollama", baseUrl: "http://localhost:11434/v1", model: "qwen2.5:7b" },
];

const MODIFIER_CODES = new Set([
  "MetaLeft",
  "MetaRight",
  "OSLeft",
  "OSRight",
  "ControlLeft",
  "ControlRight",
  "AltLeft",
  "AltRight",
  "ShiftLeft",
  "ShiftRight",
  "CapsLock",
]);

const MODIFIER_KEYS = new Set(["Meta", "Control", "Alt", "Shift", "CapsLock"]);

const SUPPORTED_NAMED_CODES = new Set([
  "Backquote",
  "Backslash",
  "BracketLeft",
  "BracketRight",
  "Comma",
  "Equal",
  "Minus",
  "Period",
  "Quote",
  "Semicolon",
  "Slash",
  "Backspace",
  "Enter",
  "Space",
  "Tab",
  "Delete",
  "End",
  "Home",
  "Insert",
  "PageDown",
  "PageUp",
  "ArrowUp",
  "ArrowDown",
  "ArrowLeft",
  "ArrowRight",
  "NumpadAdd",
  "NumpadDecimal",
  "NumpadDivide",
  "NumpadEnter",
  "NumpadEqual",
  "NumpadMultiply",
  "NumpadSubtract",
]);

const CODE_DISPLAY_SYMBOLS: Record<string, string> = {
  Backquote: "`",
  Backslash: "\\",
  BracketLeft: "[",
  BracketRight: "]",
  Comma: ",",
  Equal: "=",
  Minus: "-",
  Period: ".",
  Quote: "'",
  Semicolon: ";",
  Slash: "/",
  ArrowUp: "↑",
  ArrowDown: "↓",
  ArrowLeft: "←",
  ArrowRight: "→",
};

function formatKeyEventToShortcut(e: KeyboardEvent): string | null {
  const modifiers: string[] = [];
  if (e.metaKey) modifiers.push("Super");
  if (e.ctrlKey) modifiers.push("Ctrl");
  if (e.altKey) modifiers.push("Alt");
  if (e.shiftKey) modifiers.push("Shift");

  if (modifiers.length === 0) {
    return null;
  }

  // Only ignore actual modifier keys; do NOT ignore "Dead" / "Process" because
  // macOS Option+letter dead keys and CJK IME still provide the physical e.code.
  if (MODIFIER_CODES.has(e.code) || MODIFIER_KEYS.has(e.key)) {
    return null;
  }

  let mainKey: string | null = null;
  const code = e.code || "";
  if (code === "Space") {
    mainKey = "Space";
  } else if (/^Key[A-Z]$/.test(code)) {
    mainKey = code.slice(3);
  } else if (/^Digit[0-9]$/.test(code)) {
    mainKey = code.slice(5);
  } else if (/^F([1-9]|1[0-9]|2[0-4])$/.test(code)) {
    mainKey = code;
  } else if (/^Numpad[0-9]$/.test(code)) {
    mainKey = code;
  } else if (SUPPORTED_NAMED_CODES.has(code)) {
    mainKey = code;
  } else if (/^[a-zA-Z0-9]$/.test(e.key)) {
    mainKey = e.key.toUpperCase();
  }

  if (!mainKey) {
    return null;
  }

  return [...modifiers, mainKey].join("+");
}

function formatShortcutForDisplay(shortcut: string, platform: string): string {
  if (!shortcut) return "";
  const isMac = platform === "macos";
  return shortcut
    .split("+")
    .map((part) => {
      const token = part.trim();
      const upper = token.toUpperCase();
      if (isMac) {
        if (upper === "SUPER" || upper === "CMD" || upper === "COMMAND") return "⌘";
        if (upper === "ALT" || upper === "OPTION") return "⌥";
        if (upper === "CTRL" || upper === "CONTROL") return "⌃";
        if (upper === "SHIFT") return "⇧";
      } else {
        if (upper === "SUPER" || upper === "CMD" || upper === "COMMAND") return "Win";
      }
      return CODE_DISPLAY_SYMBOLS[token] ?? token;
    })
    .join(isMac ? " " : "+");
}

function formatModifiersPreview(e: KeyboardEvent, platform: string): string {
  const isMac = platform === "macos";
  const parts: string[] = [];
  if (e.metaKey) parts.push(isMac ? "⌘" : "Win");
  if (e.ctrlKey) parts.push(isMac ? "⌃" : "Ctrl");
  if (e.altKey) parts.push(isMac ? "⌥" : "Alt");
  if (e.shiftKey) parts.push(isMac ? "⇧" : "Shift");
  return parts.length > 0 ? `${parts.join(isMac ? " " : "+")} + ...` : "";
}

function syncActiveFields(s: AppSettings, activeId: string): AppSettings {
  const active = s.providers.find((p) => p.id === activeId) || s.providers[0];
  if (!active) return s;
  return {
    ...s,
    activeProviderId: active.id,
    baseUrl: active.baseUrl,
    apiKey: active.apiKey,
    model: active.model,
  };
}

export function SettingsWindow() {
  const [settings, setSettings] = useState<AppSettings | null>(null);
  const [platform, setPlatform] = useState("macos");
  const [appVersion, setAppVersion] = useState("0.2.3");
  const [axTrusted, setAxTrusted] = useState(true);
  const [resettingAx, setResettingAx] = useState(false);
  const [showKey, setShowKey] = useState(false);
  const [blacklistText, setBlacklistText] = useState("");
  const [recordingShortcut, setRecordingShortcut] = useState(false);
  const [recordingPreview, setRecordingPreview] = useState("");
  const [savingShortcut, setSavingShortcut] = useState(false);
  const shortcutButtonRef = useRef<HTMLButtonElement | null>(null);
  const [addMenuOpen, setAddMenuOpen] = useState(false);

  const [fetchedModels, setFetchedModels] = useState<string[]>([]);
  const [fetchingModels, setFetchingModels] = useState(false);

  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [statusBanner, setStatusBanner] = useState<{
    type: "ok" | "err";
    text: string;
  } | null>(null);

  // Auto-updater state
  const [checkingUpdate, setCheckingUpdate] = useState(false);
  const [installingUpdate, setInstallingUpdate] = useState(false);
  const [downloadProgress, setDownloadProgress] = useState<number | null>(null);
  const [updateStatusText, setUpdateStatusText] = useState<string | null>(null);
  const [availableUpdate, setAvailableUpdate] = useState<{
    version: string;
    body?: string;
  } | null>(null);
  const pendingUpdateRef = useRef<Update | null>(null);

  const runUpdateCheck = useCallback(async (silent = false) => {
    setCheckingUpdate(true);
    if (!silent) setUpdateStatusText(null);
    try {
      const update = await check();
      if (update) {
        pendingUpdateRef.current = update;
        setAvailableUpdate({
          version: update.version,
          body: update.body || undefined,
        });
        setUpdateStatusText(`发现新版本 v${update.version}，点击下方按钮即可自动下载并更新！`);
      } else {
        pendingUpdateRef.current = null;
        setAvailableUpdate(null);
        if (!silent) {
          setUpdateStatusText("当前已是最新版本。");
        }
      }
    } catch (err) {
      if (!silent) {
        setUpdateStatusText(`检查更新失败：${String(err)}`);
      }
    } finally {
      setCheckingUpdate(false);
    }
  }, []);

  const handleInstallUpdate = async () => {
    const update = pendingUpdateRef.current;
    if (!update) return;
    setInstallingUpdate(true);
    setDownloadProgress(0);
    setUpdateStatusText("正在下载更新包...");
    try {
      let downloaded = 0;
      let total = 0;
      await update.downloadAndInstall((event) => {
        if (event.event === "Started") {
          total = event.data.contentLength || 0;
          setDownloadProgress(0);
        } else if (event.event === "Progress") {
          downloaded += event.data.chunkLength;
          if (total > 0) {
            setDownloadProgress(Math.min(99, Math.round((downloaded / total) * 100)));
          }
        } else if (event.event === "Finished") {
          setDownloadProgress(100);
          setUpdateStatusText("下载完成，正在安装并重启 LiteAsk...");
        }
      });
      await relaunch();
    } catch (err) {
      setInstallingUpdate(false);
      setDownloadProgress(null);
      setUpdateStatusText(`安装更新失败：${String(err)}`);
    }
  };

  useEffect(() => {
    void (async () => {
      const [plat, s, ver] = await Promise.all([
        api.getPlatform(),
        api.getSettings(),
        getVersion().catch(() => "0.2.3"),
      ]);
      setPlatform(plat);
      setAppVersion(ver);
      setSettings(s);
      setBlacklistText(s.blacklist.join("\n"));
      if (plat === "macos") {
        const trusted = await api.checkAccessibility(false);
        setAxTrusted(trusted);
      }
      // Silent update check 3 seconds after startup
      setTimeout(() => {
        void runUpdateCheck(true);
      }, 3000);
    })();

    const unsubs = [
      listen<AppSettings>("settings:updated", (ev) => {
        setSettings(ev.payload);
        setBlacklistText(ev.payload.blacklist.join("\n"));
      }),
      listen("updater:check", () => {
        void runUpdateCheck(false);
      }),
      listen<boolean>("accessibility:granted", (ev) => {
        if (ev.payload) {
          setAxTrusted(true);
          setStatusBanner({ type: "ok", text: "已获得 macOS 辅助功能权限，划词助手已就绪！" });
        }
      }),
    ];
    return () => {
      unsubs.forEach((p) => void p.then((fn) => fn()));
    };
  }, [runUpdateCheck]);

  // Re-check macOS Accessibility automatically when user returns from System Settings
  useEffect(() => {
    if (platform !== "macos" || axTrusted) return;
    const onFocus = () => {
      void api.checkAccessibility(false).then((trusted) => {
        if (trusted) {
          setAxTrusted(true);
          setStatusBanner({ type: "ok", text: "已获得 macOS 辅助功能权限，划词助手已就绪！" });
        }
      });
    };
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, [platform, axTrusted]);

  // Global window-level capture for shortcut recording so macOS WKWebView
  // (where clicking a <button> does not grant keyboard focus) reliably captures keystrokes.
  useEffect(() => {
    if (!recordingShortcut) {
      setRecordingPreview("");
      return;
    }

    let committed = false;
    (document.activeElement as HTMLElement | null)?.blur?.();
    void api.setShortcutRecording(true);

    const onKeyDown = (e: KeyboardEvent) => {
      e.preventDefault();
      e.stopPropagation();

      if (
        (e.key === "Escape" || e.code === "Escape") &&
        !e.metaKey &&
        !e.ctrlKey &&
        !e.altKey &&
        !e.shiftKey
      ) {
        setRecordingShortcut(false);
        return;
      }

      const combo = formatKeyEventToShortcut(e);
      if (!combo) {
        setRecordingPreview(formatModifiersPreview(e, platform));
        return;
      }

      committed = true;
      setRecordingShortcut(false);
      setRecordingPreview("");
      setSavingShortcut(true);
      void api
        .updateQuickAskShortcut(combo)
        .then((saved) => {
          setSettings((prev) =>
            prev ? { ...prev, quickAskShortcut: saved.quickAskShortcut } : saved,
          );
          setStatusBanner({
            type: "ok",
            text: `弹窗助手全局快捷键已更新并立即生效：${formatShortcutForDisplay(
              saved.quickAskShortcut,
              platform,
            )}`,
          });
        })
        .catch((err) => {
          setStatusBanner({ type: "err", text: String(err) });
        })
        .finally(() => {
          setSavingShortcut(false);
        });
    };

    const onKeyUp = (e: KeyboardEvent) => {
      setRecordingPreview(formatModifiersPreview(e, platform));
    };

    const onMouseDown = (e: MouseEvent) => {
      if (shortcutButtonRef.current?.contains(e.target as Node)) {
        return;
      }
      setRecordingShortcut(false);
    };

    const onWindowBlur = () => {
      setRecordingShortcut(false);
    };

    window.addEventListener("keydown", onKeyDown, true);
    window.addEventListener("keyup", onKeyUp, true);
    window.addEventListener("mousedown", onMouseDown, true);
    window.addEventListener("blur", onWindowBlur);

    return () => {
      window.removeEventListener("keydown", onKeyDown, true);
      window.removeEventListener("keyup", onKeyUp, true);
      window.removeEventListener("mousedown", onMouseDown, true);
      window.removeEventListener("blur", onWindowBlur);
      if (!committed) {
        void api.setShortcutRecording(false);
      }
    };
  }, [recordingShortcut, platform]);

  const activeProvider: ProviderConfig | undefined = settings
    ? settings.providers.find((p) => p.id === settings.activeProviderId) || settings.providers[0]
    : undefined;

  const updateActiveProvider = (patch: Partial<ProviderConfig>) => {
    if (!settings || !activeProvider) return;
    const nextProviders = settings.providers.map((p) =>
      p.id === activeProvider.id ? { ...p, ...patch } : p,
    );
    setSettings(syncActiveFields({ ...settings, providers: nextProviders }, activeProvider.id));
  };

  const handleSelectProvider = (id: string) => {
    if (!settings) return;
    setFetchedModels([]);
    setSettings(syncActiveFields(settings, id));
  };

  const handleAddProvider = (tpl: { name: string; baseUrl: string; model: string }) => {
    if (!settings) return;
    const newId = `custom-${Date.now()}`;
    const nextProvider: ProviderConfig = {
      id: newId,
      name: tpl.name,
      baseUrl: tpl.baseUrl,
      apiKey: "",
      model: tpl.model,
      isBuiltin: false,
      kind: "chat",
    };
    const nextSettings = syncActiveFields(
      { ...settings, providers: [...settings.providers, nextProvider] },
      newId,
    );
    setSettings(nextSettings);
    setFetchedModels([]);
    setAddMenuOpen(false);
    setStatusBanner({
      type: "ok",
      text: `已新建供应商「${tpl.name}」，填入 Base URL、API Key 和模型 ID 后点击底部「保存设置」即可使用。`,
    });
  };

  const handleDeleteActiveProvider = () => {
    if (!settings || !activeProvider || settings.providers.length <= 1) return;
    const remaining = settings.providers.filter((p) => p.id !== activeProvider.id);
    setFetchedModels([]);
    setSettings(syncActiveFields({ ...settings, providers: remaining }, remaining[0].id));
  };

  const refreshAccessibility = async () => {
    const trusted = await api.checkAccessibility(false);
    setAxTrusted(trusted);
    if (trusted) {
      setStatusBanner({ type: "ok", text: "已获得 macOS 辅助功能权限，划词助手已就绪！" });
    } else {
      setStatusBanner({
        type: "err",
        text: "仍未检测到辅助功能权限。如刚升级过版本，请点击「重置旧记录」或在系统设置里先点「-」删除旧 LiteAsk 后再点「+」重新添加。",
      });
    }
  };

  const handleResetAccessibility = async () => {
    setResettingAx(true);
    try {
      await api.resetAccessibilityPermission();
      setAxTrusted(false);
      setStatusBanner({
        type: "ok",
        text: "已清除旧版本辅助功能记录并打开系统设置，请在列表中重新勾选或点击「+」添加 LiteAsk。",
      });
    } catch (err) {
      setStatusBanner({ type: "err", text: String(err) });
    } finally {
      setResettingAx(false);
    }
  };

  const handleInstantToggleSelection = async () => {
    if (!settings) return;
    const next = !settings.selectionEnabled;
    try {
      const updated = await api.setSelectionEnabled(next);
      setSettings(updated);
      setStatusBanner({
        type: "ok",
        text: next
          ? "已开启划词悬浮条显示（立即生效）。"
          : "已关闭划词悬浮条显示（立即生效，弹窗助手快捷键仍可正常使用）。",
      });
    } catch (err) {
      setStatusBanner({ type: "err", text: String(err) });
    }
  };

  const handleFetchModels = async () => {
    if (!settings) return;
    setFetchingModels(true);
    setStatusBanner(null);
    try {
      const ids = await api.fetchAvailableModels(settings.baseUrl, settings.apiKey);
      setFetchedModels(ids);
      setStatusBanner({
        type: "ok",
        text: `已从当前供应商拉取 ${ids.length} 个可用模型，点击下方标签即可填入。`,
      });
    } catch (err) {
      setStatusBanner({ type: "err", text: String(err) });
    } finally {
      setFetchingModels(false);
    }
  };

  const handleImportOpencode = async () => {
    if (!settings) return;
    try {
      const key = await api.importOpencodeKey();
      updateActiveProvider({
        apiKey: key,
        baseUrl: activeProvider?.baseUrl || "https://opencode.ai/inference/go/openai/v1",
        model: activeProvider?.model || "deepseek-v4.1-flash",
      });
      setStatusBanner({
        type: "ok",
        text: "已从本机 OpenCode Go 导入 API Key（点击底部「保存设置」生效）。",
      });
    } catch (err) {
      setStatusBanner({ type: "err", text: String(err) });
    }
  };

  const handleTest = async () => {
    if (!settings) return;
    setTesting(true);
    setStatusBanner(null);
    try {
      const msg = await api.testAiConnection(settings);
      setStatusBanner({ type: "ok", text: msg });
    } catch (err) {
      setStatusBanner({ type: "err", text: String(err) });
    } finally {
      setTesting(false);
    }
  };

  const handleSave = async () => {
    if (!settings) return;
    setSaving(true);
    setStatusBanner(null);
    try {
      const cleanedProviders = settings.providers.map((p) => ({
        ...p,
        name: p.name.trim() || "自定义供应商",
        baseUrl: p.baseUrl.trim(),
        apiKey: p.apiKey.trim(),
        model: p.model.trim(),
      }));
      const synced = syncActiveFields(
        {
          ...settings,
          providers: cleanedProviders,
          blacklist: blacklistText
            .split("\n")
            .map((l) => l.trim())
            .filter(Boolean),
        },
        settings.activeProviderId,
      );
      const saved = await api.saveSettings(synced);
      setSettings(saved);
      setStatusBanner({ type: "ok", text: "设置已保存并立即生效。" });
    } catch (err) {
      setStatusBanner({ type: "err", text: String(err) });
    } finally {
      setSaving(false);
    }
  };

  if (!settings || !activeProvider) {
    return (
      <div className="w-full h-full flex items-center justify-center bg-[var(--surface)] text-[var(--text-muted)]">
        加载中...
      </div>
    );
  }

  const isOpencodeProvider = activeProvider.baseUrl.toLowerCase().includes("opencode.ai");
  const displayedModels =
    fetchedModels.length > 0 ? fetchedModels : isOpencodeProvider ? OPENCODE_PRESET_MODELS : [];

  return (
    <div className="w-full h-full bg-[var(--surface)] text-[var(--text-primary)] flex flex-col overflow-hidden">
      <div className="flex-1 overflow-y-auto px-5 py-4 space-y-5">
        {/* Header */}
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2.5">
            <div className="w-8 h-8 rounded-xl bg-[var(--accent)] text-white flex items-center justify-center">
              <Sparkles className="w-4 h-4" />
            </div>
            <div>
              <h1 className="text-[15px] font-semibold leading-tight">LiteAsk 偏好设置</h1>
              <p className="text-[12px] text-[var(--text-muted)]">
                轻量跨平台划词翻译 / 解释 & 桌面弹窗助手
              </p>
            </div>
          </div>
          <button
            type="button"
            onClick={() => void api.toggleQuickAsk()}
            className="px-3 py-1.5 rounded-lg text-[12px] bg-[var(--surface-subtle)] border border-[var(--border-color)] hover:border-[var(--accent)] text-[var(--text-secondary)] cursor-pointer"
          >
            试一下弹窗助手
          </button>
        </div>

        {/* Update Available Alert Banner (if found) */}
        {availableUpdate && (
          <div className="p-3.5 rounded-xl bg-[var(--accent-soft)] border border-[var(--accent)]/35 flex items-center justify-between gap-3">
            <div className="flex items-start gap-2.5 min-w-0">
              <ArrowUpCircle className="w-5 h-5 text-[var(--accent)] shrink-0 mt-0.5" />
              <div className="min-w-0">
                <div className="text-[13px] font-semibold text-[var(--accent)]">
                  发现新版本 v{availableUpdate.version}（当前 v{appVersion}）
                </div>
                {availableUpdate.body && (
                  <p className="text-[12px] text-[var(--text-secondary)] mt-0.5 line-clamp-2 whitespace-pre-wrap">
                    {availableUpdate.body}
                  </p>
                )}
                {downloadProgress !== null && (
                  <div className="mt-2 w-full h-1.5 rounded-full bg-[var(--surface)] overflow-hidden">
                    <div
                      className="h-full bg-[var(--accent)] transition-all duration-150"
                      style={{ width: `${downloadProgress}%` }}
                    />
                  </div>
                )}
              </div>
            </div>
            <button
              type="button"
              onClick={() => void handleInstallUpdate()}
              disabled={installingUpdate}
              className="px-3 py-1.5 rounded-lg bg-[var(--accent)] text-white text-[12px] font-medium hover:opacity-90 disabled:opacity-50 flex items-center gap-1.5 shrink-0 cursor-pointer"
            >
              {installingUpdate && <Loader2 className="w-3.5 h-3.5 animate-spin" />}
              <span>
                {installingUpdate
                  ? downloadProgress !== null
                    ? `下载中 ${downloadProgress}%`
                    : "更新中..."
                  : "立即更新并重启"}
              </span>
            </button>
          </div>
        )}

        {/* Top Instant Master Switch: Selection Floating Toolbar */}
        <div className="p-3.5 rounded-xl bg-[var(--surface-subtle)] border border-[var(--border-color)] flex items-center justify-between gap-3">
          <div className="flex items-start gap-2.5">
            <div
              className={`w-8 h-8 rounded-lg flex items-center justify-center shrink-0 mt-0.5 ${
                settings.selectionEnabled
                  ? "bg-[var(--accent-soft)] text-[var(--accent)]"
                  : "bg-[var(--surface)] text-[var(--text-muted)] border border-[var(--border-color)]"
              }`}
            >
              <MousePointerClick className="w-4 h-4" />
            </div>
            <div>
              <div className="flex items-center gap-2">
                <span className="text-[13.5px] font-semibold">划词悬浮条显示</span>
                <span
                  className={`px-1.5 py-0.5 rounded text-[10.5px] font-medium ${
                    settings.selectionEnabled
                      ? "bg-emerald-500/15 text-emerald-600 dark:text-emerald-400"
                      : "bg-slate-500/15 text-[var(--text-muted)]"
                  }`}
                >
                  {settings.selectionEnabled ? "已开启" : "已关闭"}
                </span>
              </div>
              <p className="text-[12px] text-[var(--text-secondary)] mt-0.5">
                {settings.selectionEnabled
                  ? "鼠标划选文字松开后自动弹出「翻译 / 解释」悬浮条（点右侧开关可随时关闭，立即生效）"
                  : "已暂停划词弹出，划选文字时不会显示悬浮条；桌面弹窗助手快捷键不受影响"}
              </p>
            </div>
          </div>

          <button
            type="button"
            role="switch"
            aria-checked={settings.selectionEnabled}
            onClick={() => void handleInstantToggleSelection()}
            className={`relative inline-flex h-6 w-11 shrink-0 items-center rounded-full transition-colors cursor-pointer ${
              settings.selectionEnabled ? "bg-[var(--accent)]" : "bg-slate-400/50 dark:bg-zinc-600"
            }`}
            title={settings.selectionEnabled ? "点击关闭划词悬浮条" : "点击开启划词悬浮条"}
          >
            <span
              className={`inline-block h-4.5 w-4.5 transform rounded-full bg-white shadow transition-transform ${
                settings.selectionEnabled ? "translate-x-5.5" : "translate-x-1"
              }`}
            />
          </button>
        </div>

        {/* macOS Accessibility Card */}
        {platform === "macos" && (
          <div
            className={`p-3.5 rounded-xl border flex items-start justify-between gap-3 ${
              axTrusted
                ? "bg-emerald-500/8 border-emerald-500/25"
                : "bg-amber-500/10 border-amber-500/30"
            }`}
          >
            <div className="flex items-start gap-2.5">
              {axTrusted ? (
                <ShieldCheck className="w-5 h-5 text-emerald-500 shrink-0 mt-0.5" />
              ) : (
                <AlertTriangle className="w-5 h-5 text-amber-500 shrink-0 mt-0.5" />
              )}
              <div>
                <div className="text-[13px] font-medium">
                  {axTrusted ? "macOS 辅助功能权限已开启" : "需要开启 macOS 辅助功能权限"}
                </div>
                <p className="text-[12px] text-[var(--text-secondary)] mt-0.5">
                  {axTrusted
                    ? "系统级划词监听已授权。"
                    : "划词检测需要在「系统设置 → 隐私与安全性 → 辅助功能」中授权 LiteAsk。若更新版本后原开关失效，请点击右侧「重置旧记录」清除旧签名缓存后重新勾选（无需重启）。"}
                </p>
              </div>
            </div>
            {!axTrusted && (
              <div className="flex items-center gap-1.5 shrink-0">
                <button
                  type="button"
                  onClick={() => void handleResetAccessibility()}
                  disabled={resettingAx}
                  className="px-2.5 py-1.5 rounded-lg bg-[var(--surface-subtle)] border border-[var(--border-color)] hover:border-[var(--accent)] text-[12px] font-medium cursor-pointer disabled:opacity-50"
                  title="清除旧版本残留的辅助功能记录并重新打开系统设置"
                >
                  {resettingAx ? "重置中..." : "重置旧记录"}
                </button>
                <button
                  type="button"
                  onClick={() => void api.openAccessibilitySettings()}
                  className="px-2.5 py-1.5 rounded-lg bg-amber-500 text-white text-[12px] font-medium hover:opacity-90 cursor-pointer"
                >
                  去开启
                </button>
                <button
                  type="button"
                  onClick={() => void refreshAccessibility()}
                  className="p-1.5 rounded-lg bg-[var(--surface-subtle)] border border-[var(--border-color)] hover:border-[var(--accent)] cursor-pointer"
                  title="重新检测"
                >
                  <RefreshCw className="w-3.5 h-3.5" />
                </button>
              </div>
            )}
          </div>
        )}

        {/* Section 1: Multi-Provider & Custom Model ID */}
        <section className="space-y-3">
          <div className="flex items-center justify-between gap-2">
            <h2 className="text-[13px] font-semibold text-[var(--text-secondary)] uppercase tracking-wider">
              模型供应商配置（支持自定义）
            </h2>
            <div className="relative">
              <button
                type="button"
                onClick={() => setAddMenuOpen((v) => !v)}
                className="px-2.5 py-1 rounded-lg text-[12px] font-medium bg-[var(--accent-soft)] text-[var(--accent)] hover:opacity-90 flex items-center gap-1 cursor-pointer"
              >
                <Plus className="w-3.5 h-3.5" />
                <span>添加自定义供应商</span>
              </button>

              {addMenuOpen && (
                <div className="absolute right-0 mt-1.5 w-48 rounded-xl bg-[var(--surface-elevated)] border border-[var(--border-color)] shadow-lg py-1 z-20">
                  {PROVIDER_TEMPLATES.map((tpl) => (
                    <button
                      key={tpl.name}
                      type="button"
                      onClick={() => handleAddProvider(tpl)}
                      className="w-full px-3 py-1.5 text-left text-[12.5px] hover:bg-[var(--accent-soft)] hover:text-[var(--accent)] cursor-pointer"
                    >
                      {tpl.name}
                    </button>
                  ))}
                </div>
              )}
            </div>
          </div>

          {isTranslateGateway(settings) && (
            <div className="px-3 py-2 rounded-xl bg-amber-500/10 border border-amber-500/30 text-[12px] text-amber-700 dark:text-amber-400 flex items-start gap-2">
              <AlertTriangle className="w-4 h-4 shrink-0 mt-0.5" />
              <span>
                当前供应商是「翻译网关」，只能翻译。划词「解释」与「弹窗助手」需要对话模型，请切换到「对话模型」类型的供应商。
              </span>
            </div>
          )}

          {/* Provider Switcher Tabs */}
          <div className="flex flex-wrap items-center gap-1.5">
            {settings.providers.map((p) => {
              const active = p.id === activeProvider.id;
              return (
                <button
                  key={p.id}
                  type="button"
                  onClick={() => handleSelectProvider(p.id)}
                  className={`px-3 py-1.5 rounded-lg text-[12.5px] font-medium transition-colors cursor-pointer flex items-center gap-1.5 ${
                    active
                      ? "bg-[var(--accent)] text-white shadow-xs"
                      : "bg-[var(--surface-subtle)] border border-[var(--border-color)] text-[var(--text-secondary)] hover:border-[var(--accent)]"
                  }`}
                >
                  <span>{p.name || "未命名供应商"}</span>
                  {active && <span className="text-[10px] opacity-85">当前使用</span>}
                </button>
              );
            })}
          </div>

          <div className="p-3.5 rounded-xl bg-[var(--surface-subtle)] border border-[var(--border-color)] space-y-3">
            <div className="flex items-end justify-between gap-3">
              <div className="flex-1">
                <label className="block text-[12px] text-[var(--text-secondary)] mb-1">
                  供应商名称
                </label>
                <input
                  type="text"
                  value={activeProvider.name}
                  onChange={(e) => updateActiveProvider({ name: e.target.value })}
                  placeholder="例如：DeepSeek / OpenAI / 公司中转站"
                  className="w-full h-8.5 px-2.5 rounded-lg bg-[var(--surface)] border border-[var(--border-color)] focus:border-[var(--accent)] outline-none text-[12.5px] select-text"
                />
              </div>

              <div className="flex items-center gap-1.5 shrink-0">
                {isOpencodeProvider && (
                  <button
                    type="button"
                    onClick={() => void handleImportOpencode()}
                    className="h-8.5 px-2.5 rounded-lg bg-[var(--surface)] border border-[var(--border-color)] hover:border-[var(--accent)] text-[12px] text-[var(--accent)] flex items-center gap-1 cursor-pointer"
                  >
                    <Download className="w-3.5 h-3.5" />
                    <span>导入 OpenCode Key</span>
                  </button>
                )}
                {settings.providers.length > 1 && (
                  <button
                    type="button"
                    onClick={handleDeleteActiveProvider}
                    className="h-8.5 px-2.5 rounded-lg bg-[var(--surface)] border border-[var(--border-color)] hover:border-red-500/40 hover:text-red-500 text-[12px] text-[var(--text-secondary)] flex items-center gap-1 cursor-pointer"
                    title="删除当前供应商"
                  >
                    <Trash2 className="w-3.5 h-3.5" />
                    <span>删除</span>
                  </button>
                )}
              </div>
            </div>

            <div>
              <label className="block text-[12px] text-[var(--text-secondary)] mb-1">
                API Base URL（OpenAI 兼容接口，需包含 /v1）
              </label>
              <input
                type="text"
                value={activeProvider.baseUrl}
                onChange={(e) => updateActiveProvider({ baseUrl: e.target.value })}
                placeholder="https://api.openai.com/v1"
                className="w-full h-8.5 px-2.5 rounded-lg bg-[var(--surface)] border border-[var(--border-color)] focus:border-[var(--accent)] outline-none text-[12px] font-mono select-text"
              />
            </div>

            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="block text-[12px] text-[var(--text-secondary)] mb-1">
                  API Key（本地模型如 Ollama 可留空）
                </label>
                <div className="flex items-center gap-1.5">
                  <input
                    type={showKey ? "text" : "password"}
                    value={activeProvider.apiKey}
                    onChange={(e) => updateActiveProvider({ apiKey: e.target.value })}
                    placeholder="sk-..."
                    className="flex-1 h-8.5 px-2.5 rounded-lg bg-[var(--surface)] border border-[var(--border-color)] focus:border-[var(--accent)] outline-none text-[12px] font-mono select-text"
                  />
                  <button
                    type="button"
                    onClick={() => setShowKey((v) => !v)}
                    className="w-8.5 h-8.5 rounded-lg bg-[var(--surface)] border border-[var(--border-color)] flex items-center justify-center text-[var(--text-secondary)] cursor-pointer shrink-0"
                  >
                    {showKey ? <EyeOff className="w-3.5 h-3.5" /> : <Eye className="w-3.5 h-3.5" />}
                  </button>
                </div>
              </div>

              <div>
                <label className="block text-[12px] text-[var(--text-secondary)] mb-1">
                  模型 ID（可手动输入任意模型）
                </label>
                <input
                  type="text"
                  value={activeProvider.model}
                  onChange={(e) => updateActiveProvider({ model: e.target.value })}
                  placeholder="例如 deepseek-v4.1-flash / gpt-4o"
                  className="w-full h-8.5 px-2.5 rounded-lg bg-[var(--surface)] border border-[var(--border-color)] focus:border-[var(--accent)] outline-none text-[12px] font-mono select-text"
                />
              </div>
            </div>

            <div className="flex items-center justify-between gap-3">
              <div>
                <div className="text-[12px] text-[var(--text-secondary)]">接口类型</div>
                <div className="text-[11px] text-[var(--text-muted)] mt-0.5">
                  {activeProvider.kind === "translate"
                    ? "翻译网关：只做翻译（直连并对 target_lang 显式指定），解释与弹窗助手不可用"
                    : "对话模型：翻译 / 解释 / 弹窗助手都可用"}
                </div>
              </div>
              <select
                value={activeProvider.kind ?? "chat"}
                onChange={(e) => updateActiveProvider({ kind: e.target.value as ProviderKind })}
                className="h-8 px-2.5 rounded-lg bg-[var(--surface)] border border-[var(--border-color)] text-[12px] outline-none cursor-pointer shrink-0"
              >
                <option value="chat">对话模型</option>
                <option value="translate">翻译网关（只翻译）</option>
              </select>
            </div>

            <div className="space-y-2 pt-0.5">
              <div className="flex items-center justify-between gap-2">
                <span className="text-[11.5px] text-[var(--text-muted)]">
                  {fetchedModels.length > 0
                    ? `已拉取 ${fetchedModels.length} 个模型（点击填入）：`
                    : displayedModels.length > 0
                      ? "常用模型预设（也可在上方直接输入任意模型 ID）："
                      : "点击右侧拉取模型列表，或直接手动输入模型 ID："}
                </span>
                <div className="flex items-center gap-1.5 shrink-0">
                  <button
                    type="button"
                    onClick={() => void handleFetchModels()}
                    disabled={fetchingModels}
                    className="px-2.5 py-1 rounded-lg bg-[var(--surface)] border border-[var(--border-color)] hover:border-[var(--accent)] text-[11.5px] flex items-center gap-1 cursor-pointer disabled:opacity-50"
                    title="从接口实时拉取可用模型 ID 列表"
                  >
                    {fetchingModels ? (
                      <Loader2 className="w-3 h-3 animate-spin" />
                    ) : (
                      <ListFilter className="w-3 h-3" />
                    )}
                    <span>拉取模型列表</span>
                  </button>
                  <button
                    type="button"
                    onClick={() => void handleTest()}
                    disabled={testing}
                    className="px-2.5 py-1 rounded-lg bg-[var(--surface)] border border-[var(--border-color)] hover:border-[var(--accent)] text-[11.5px] flex items-center gap-1 cursor-pointer disabled:opacity-50"
                  >
                    {testing && <Loader2 className="w-3 h-3 animate-spin" />}
                    <span>测试连接</span>
                  </button>
                </div>
              </div>

              {displayedModels.length > 0 && (
                <div className="flex flex-wrap items-center gap-1 max-h-24 overflow-y-auto pr-1">
                  {displayedModels.map((m) => (
                    <button
                      key={m}
                      type="button"
                      onClick={() => updateActiveProvider({ model: m })}
                      className={`px-2 py-0.5 rounded-md text-[11px] font-mono cursor-pointer transition-colors ${
                        activeProvider.model === m
                          ? "bg-[var(--accent)] text-white"
                          : "bg-[var(--surface)] border border-[var(--border-color)] text-[var(--text-secondary)] hover:border-[var(--accent)]"
                      }`}
                    >
                      {m}
                    </button>
                  ))}
                </div>
              )}
            </div>
          </div>
        </section>

        {/* Section 1.5: Reasoning / Thinking Strength per Task */}
        <section className="space-y-3">
          <h2 className="text-[13px] font-semibold text-[var(--text-secondary)] uppercase tracking-wider">
            模型思考强度（按场景自定义）
          </h2>

          <div className="p-3.5 rounded-xl bg-[var(--surface-subtle)] border border-[var(--border-color)] space-y-3">
            <div className="flex items-center justify-between gap-3">
              <div>
                <div className="text-[13px] font-medium">划词翻译</div>
                <div className="text-[11.5px] text-[var(--text-muted)]">
                  建议关闭思考（none），直出译文、响应最快且节省额度
                </div>
              </div>
              <select
                value={settings.translateReasoningEffort || "none"}
                onChange={(e) =>
                  setSettings({
                    ...settings,
                    translateReasoningEffort: e.target.value as ReasoningEffort,
                  })
                }
                className="h-8 px-2.5 rounded-lg bg-[var(--surface)] border border-[var(--border-color)] text-[12.5px] outline-none cursor-pointer shrink-0"
              >
                {REASONING_EFFORT_OPTIONS.map((opt) => (
                  <option key={opt.value} value={opt.value}>
                    {opt.label}
                  </option>
                ))}
              </select>
            </div>

            <div className="h-px bg-[var(--border-color)]" />

            <div className="flex items-center justify-between gap-3">
              <div>
                <div className="text-[13px] font-medium">划词解释</div>
                <div className="text-[11.5px] text-[var(--text-muted)]">
                  解释词汇、长难句或代码时使用的默认思考强度（浮窗内也可临时切换）
                </div>
              </div>
              <select
                value={settings.explainReasoningEffort || "low"}
                onChange={(e) =>
                  setSettings({
                    ...settings,
                    explainReasoningEffort: e.target.value as ReasoningEffort,
                  })
                }
                className="h-8 px-2.5 rounded-lg bg-[var(--surface)] border border-[var(--border-color)] text-[12.5px] outline-none cursor-pointer shrink-0"
              >
                {REASONING_EFFORT_OPTIONS.map((opt) => (
                  <option key={opt.value} value={opt.value}>
                    {opt.label}
                  </option>
                ))}
              </select>
            </div>

            <div className="h-px bg-[var(--border-color)]" />

            <div className="flex items-center justify-between gap-3">
              <div>
                <div className="text-[13px] font-medium">桌面弹窗助手（Quick Ask）</div>
                <div className="text-[11.5px] text-[var(--text-muted)]">
                  全局快捷键唤起提问时的默认思考强度（弹窗顶部也可随时切换）
                </div>
              </div>
              <select
                value={settings.quickAskReasoningEffort || "medium"}
                onChange={(e) =>
                  setSettings({
                    ...settings,
                    quickAskReasoningEffort: e.target.value as ReasoningEffort,
                  })
                }
                className="h-8 px-2.5 rounded-lg bg-[var(--surface)] border border-[var(--border-color)] text-[12.5px] outline-none cursor-pointer shrink-0"
              >
                {REASONING_EFFORT_OPTIONS.map((opt) => (
                  <option key={opt.value} value={opt.value}>
                    {opt.label}
                  </option>
                ))}
              </select>
            </div>
          </div>
        </section>

        {/* Section 2: Quick Ask Shortcut & General */}
        <section className="space-y-3">
          <h2 className="text-[13px] font-semibold text-[var(--text-secondary)] uppercase tracking-wider">
            弹窗助手 & 其他行为
          </h2>

          <div className="p-3.5 rounded-xl bg-[var(--surface-subtle)] border border-[var(--border-color)] space-y-3">
            <div className="flex items-center justify-between gap-3">
              <div>
                <div className="text-[13px] font-medium">弹窗助手全局快捷键</div>
                <div className="text-[11.5px] text-[var(--text-muted)]">
                  点击右侧按钮后直接按下新组合键即可立即生效（默认 {platform === "macos" ? "⌥ Space" : "Alt+Space"}）
                </div>
              </div>
              <button
                ref={shortcutButtonRef}
                type="button"
                disabled={savingShortcut}
                onClick={() => setRecordingShortcut((prev) => !prev)}
                className={`h-8 px-3 rounded-lg border text-[12px] font-mono flex items-center gap-1.5 cursor-pointer shrink-0 disabled:opacity-50 ${
                  recordingShortcut
                    ? "bg-[var(--accent-soft)] border-[var(--accent)] text-[var(--accent)]"
                    : "bg-[var(--surface)] border-[var(--border-color)] hover:border-[var(--accent)] text-[var(--text-primary)]"
                }`}
              >
                {savingShortcut ? (
                  <Loader2 className="w-3.5 h-3.5 animate-spin" />
                ) : (
                  <Keyboard className="w-3.5 h-3.5" />
                )}
                <span>
                  {recordingShortcut
                    ? recordingPreview || "按下组合键（Esc 取消）"
                    : formatShortcutForDisplay(settings.quickAskShortcut, platform)}
                </span>
              </button>
            </div>

            <div className="h-px bg-[var(--border-color)]" />

            <div className="flex items-center justify-between">
              <div>
                <div className="text-[13px] font-medium">默认翻译目标语言</div>
                <div className="text-[11.5px] text-[var(--text-muted)]">
                  「智能中英」：外语自动译成中文，中文自动译成英文
                </div>
              </div>
              <select
                value={settings.translateTargetLang}
                onChange={(e) => setSettings({ ...settings, translateTargetLang: e.target.value })}
                className="h-8 px-2.5 rounded-lg bg-[var(--surface)] border border-[var(--border-color)] text-[12.5px] outline-none cursor-pointer"
              >
                <option value="zh-CN">智能中英（推荐）</option>
                <option value="en">英文</option>
                <option value="ja">日文</option>
              </select>
            </div>

            <label className="flex items-center justify-between cursor-pointer">
              <div>
                <div className="text-[13px] font-medium">显示模型思考过程（如模型返回）</div>
                <div className="text-[11.5px] text-[var(--text-muted)]">
                  关闭时界面更清爽，仅展示最终回答
                </div>
              </div>
              <input
                type="checkbox"
                checked={settings.showReasoning}
                onChange={(e) => setSettings({ ...settings, showReasoning: e.target.checked })}
                className="w-4 h-4 accent-[var(--accent)] cursor-pointer"
              />
            </label>

            <label className="flex items-center justify-between cursor-pointer">
              <div>
                <div className="text-[13px] font-medium">开机自动启动</div>
                <div className="text-[11.5px] text-[var(--text-muted)]">
                  静默常驻菜单栏/系统托盘，随手可用
                </div>
              </div>
              <input
                type="checkbox"
                checked={settings.launchAtLogin}
                onChange={(e) => setSettings({ ...settings, launchAtLogin: e.target.checked })}
                className="w-4 h-4 accent-[var(--accent)] cursor-pointer"
              />
            </label>

            <div>
              <label className="block text-[12px] text-[var(--text-secondary)] mb-1">
                划词忽略应用黑名单（每行一个：{platform === "macos" ? "Bundle ID，如 com.apple.finder" : "进程名，如 explorer.exe"}）
              </label>
              <textarea
                rows={3}
                value={blacklistText}
                onChange={(e) => setBlacklistText(e.target.value)}
                className="w-full p-2 rounded-lg bg-[var(--surface)] border border-[var(--border-color)] focus:border-[var(--accent)] outline-none text-[12px] font-mono select-text"
              />
            </div>
          </div>
        </section>

        {/* Section 3: Auto-Updater */}
        <section className="space-y-3">
          <h2 className="text-[13px] font-semibold text-[var(--text-secondary)] uppercase tracking-wider">
            版本与自动更新
          </h2>

          <div className="p-3.5 rounded-xl bg-[var(--surface-subtle)] border border-[var(--border-color)] space-y-2">
            <div className="flex items-center justify-between gap-3">
              <div>
                <div className="text-[13px] font-medium">
                  LiteAsk v{appVersion}
                </div>
                <div className="text-[11.5px] text-[var(--text-muted)]">
                  更新源：GitHub Releases（DancingLi/LiteAsk）· 支持启动静默检查与一键热更新
                </div>
              </div>
              <button
                type="button"
                onClick={() => void runUpdateCheck(false)}
                disabled={checkingUpdate || installingUpdate}
                className="h-8 px-3 rounded-lg bg-[var(--surface)] border border-[var(--border-color)] hover:border-[var(--accent)] text-[12px] flex items-center gap-1.5 cursor-pointer disabled:opacity-50 shrink-0"
              >
                {checkingUpdate ? (
                  <Loader2 className="w-3.5 h-3.5 animate-spin" />
                ) : (
                  <RefreshCw className="w-3.5 h-3.5" />
                )}
                <span>检查更新</span>
              </button>
            </div>
            {updateStatusText && (
              <p className="text-[12px] text-[var(--text-secondary)] pt-1">{updateStatusText}</p>
            )}
            {availableUpdate && (
              <div className="pt-2 mt-1 border-t border-[var(--border-color)] flex items-center justify-between gap-3">
                <div className="min-w-0 flex-1 space-y-1">
                  <div className="text-[12.5px] font-semibold text-[var(--accent)] flex items-center gap-1.5">
                    <ArrowUpCircle className="w-4 h-4 shrink-0" />
                    <span>
                      v{availableUpdate.version} 可用（当前 v{appVersion}）
                    </span>
                  </div>
                  {availableUpdate.body && (
                    <p className="text-[11.5px] text-[var(--text-secondary)] whitespace-pre-wrap line-clamp-3">
                      {availableUpdate.body}
                    </p>
                  )}
                  {downloadProgress !== null && (
                    <div className="pt-1">
                      <div className="w-full h-1.5 rounded-full bg-[var(--surface)] overflow-hidden">
                        <div
                          className="h-full bg-[var(--accent)] transition-all duration-150"
                          style={{ width: `${downloadProgress}%` }}
                        />
                      </div>
                    </div>
                  )}
                </div>
                <button
                  type="button"
                  onClick={() => void handleInstallUpdate()}
                  disabled={installingUpdate}
                  className="h-8 px-3 rounded-lg bg-[var(--accent)] text-white text-[12px] font-medium hover:opacity-90 disabled:opacity-50 flex items-center gap-1.5 shrink-0 cursor-pointer"
                >
                  {installingUpdate ? (
                    <Loader2 className="w-3.5 h-3.5 animate-spin" />
                  ) : (
                    <Download className="w-3.5 h-3.5" />
                  )}
                  <span>
                    {installingUpdate
                      ? downloadProgress !== null
                        ? `下载中 ${downloadProgress}%`
                        : "更新中..."
                      : "立即更新并重启"}
                  </span>
                </button>
              </div>
            )}
          </div>
        </section>

        {statusBanner && (
          <div
            className={`px-3 py-2 rounded-xl text-[12.5px] flex items-center gap-2 select-text ${
              statusBanner.type === "ok"
                ? "bg-emerald-500/10 border border-emerald-500/25 text-emerald-600 dark:text-emerald-400"
                : "bg-red-500/10 border border-red-500/25 text-red-500"
            }`}
          >
            {statusBanner.type === "ok" ? (
              <CheckCircle2 className="w-4 h-4 shrink-0" />
            ) : (
              <AlertTriangle className="w-4 h-4 shrink-0" />
            )}
            <span>{statusBanner.text}</span>
          </div>
        )}
      </div>

      {/* Footer Save Bar */}
      <div className="px-5 py-3 border-t border-[var(--border-color)] bg-[var(--surface-elevated)] flex items-center justify-between shrink-0">
        <span className="text-[11.5px] text-[var(--text-muted)]">
          LiteAsk v{appVersion} · {activeProvider.name} / {activeProvider.model || "未设模型"}
        </span>
        <button
          type="button"
          onClick={() => void handleSave()}
          disabled={saving}
          className="h-8.5 px-4 rounded-xl bg-[var(--accent)] text-white text-[12.5px] font-medium hover:opacity-90 disabled:opacity-50 flex items-center gap-1.5 cursor-pointer"
        >
          {saving ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Save className="w-3.5 h-3.5" />}
          <span>保存设置</span>
        </button>
      </div>
    </div>
  );
}
