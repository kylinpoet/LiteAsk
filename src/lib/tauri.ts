import { invoke } from "@tauri-apps/api/core";
import { writeText } from "@tauri-apps/plugin-clipboard-manager";

export type ReasoningEffort = "none" | "minimal" | "low" | "medium" | "high" | "max" | "default";

export const REASONING_EFFORT_OPTIONS: { value: ReasoningEffort; label: string; short: string }[] = [
  { value: "none", label: "关闭思考（最快）", short: "关闭思考" },
  { value: "minimal", label: "极简思考 (minimal)", short: "极简思考" },
  { value: "low", label: "低强度 (low)", short: "低思考" },
  { value: "medium", label: "中强度 (medium)", short: "中思考" },
  { value: "high", label: "高强度 (high)", short: "高思考" },
  { value: "max", label: "最高强度 (max)", short: "最高思考" },
  { value: "default", label: "跟随模型默认", short: "默认" },
];

export type ProviderKind = "chat" | "translate";

export interface ProviderConfig {
  id: string;
  name: string;
  baseUrl: string;
  apiKey: string;
  model: string;
  isBuiltin?: boolean;
  /** chat：通用对话模型；translate：只做翻译的网关（如豆包翻译网关） */
  kind?: ProviderKind;
}

export interface AppSettings {
  apiKey: string;
  baseUrl: string;
  model: string;
  providers: ProviderConfig[];
  activeProviderId: string;
  quickAskShortcut: string;
  selectionEnabled: boolean;
  autoPopupOnSelect: boolean;
  translateTargetLang: string;
  blacklist: string[];
  launchAtLogin: boolean;
  showReasoning: boolean;
  translateReasoningEffort: ReasoningEffort;
  explainReasoningEffort: ReasoningEffort;
  quickAskReasoningEffort: ReasoningEffort;
}

export interface ChatMessage {
  role: "user" | "assistant" | "system";
  content: string;
}

export interface SelectionPayload {
  text: string;
  x: number;
  y: number;
  appId: string;
}

export interface ActionOpenPayload {
  action: "translate" | "explain";
  text: string;
  targetLang: string;
  reasoningEffort: ReasoningEffort;
}

export interface AiChunkPayload {
  requestId: string;
  delta: string;
  reasoningDelta: string;
}

export interface AiDonePayload {
  requestId: string;
  aborted: boolean;
}

export interface AiErrorPayload {
  requestId: string;
  error: string;
}

export function activeProvider(settings: AppSettings): ProviderConfig | undefined {
  return (
    settings.providers?.find((p) => p.id === settings.activeProviderId) ?? settings.providers?.[0]
  );
}

/** 当前供应商是否是「翻译网关」：只翻译，不能解释 / 对话。 */
export function isTranslateGateway(settings: AppSettings): boolean {
  return activeProvider(settings)?.kind === "translate";
}

export function createRequestId(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  return `req-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

export const api = {
  getPlatform: () => invoke<string>("get_platform"),
  getSettings: () => invoke<AppSettings>("get_settings"),
  saveSettings: (newSettings: AppSettings) =>
    invoke<AppSettings>("save_app_settings", { newSettings }),
  setShortcutRecording: (recording: boolean) =>
    invoke<void>("set_shortcut_recording", { recording }),
  updateQuickAskShortcut: (shortcut: string) =>
    invoke<AppSettings>("update_quick_ask_shortcut", { shortcut }),
  setSelectionEnabled: (enabled: boolean) =>
    invoke<AppSettings>("set_selection_enabled", { enabled }),
  fetchAvailableModels: (baseUrl: string, apiKey: string) =>
    invoke<string[]>("fetch_available_models", { baseUrl, apiKey }),
  importOpencodeKey: () => invoke<string>("import_opencode_key"),
  testAiConnection: (settings: AppSettings) =>
    invoke<string>("test_ai_connection", { settings }),
  checkAccessibility: (prompt: boolean) =>
    invoke<boolean>("check_accessibility", { prompt }),
  openAccessibilitySettings: () => invoke<void>("open_accessibility_settings"),
  resetAccessibilityPermission: () => invoke<void>("reset_accessibility_permission"),
  setActionPinned: (pinned: boolean) => invoke<void>("set_action_pinned", { pinned }),
  setQuickAskPinned: (pinned: boolean) => invoke<void>("set_quick_ask_pinned", { pinned }),
  hideWindow: (label: string) => invoke<void>("hide_window", { label }),
  openSettings: () => invoke<void>("open_settings"),
  toggleQuickAsk: () => invoke<void>("toggle_quick_ask_cmd"),
  triggerSelectionAction: (action: "translate" | "explain" | "ask", text: string) =>
    invoke<void>("trigger_selection_action", { action, text }),
  runSelectionAi: (
    requestId: string,
    action: "translate" | "explain",
    text: string,
    targetLang: string,
    reasoningEffort: ReasoningEffort,
    followUps: ChatMessage[],
  ) =>
    invoke<string>("run_selection_ai", {
      requestId,
      action,
      text,
      targetLang,
      reasoningEffort,
      followUps,
    }),
  runQuickAskAi: (
    requestId: string,
    messages: ChatMessage[],
    reasoningEffort: ReasoningEffort,
  ) => invoke<string>("run_quick_ask_ai", { requestId, messages, reasoningEffort }),
  cancelAi: (requestId: string) => invoke<void>("cancel_ai", { requestId }),
  copyText: async (text: string) => {
    try {
      await writeText(text);
    } catch {
      await navigator.clipboard.writeText(text);
    }
  },
};
