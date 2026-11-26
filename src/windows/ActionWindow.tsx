import { useCallback, useEffect, useRef, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import {
  BookOpen,
  Brain,
  Check,
  ChevronDown,
  ChevronUp,
  Copy,
  Languages,
  Pin,
  PinOff,
  RotateCw,
  Send,
  Square,
  X,
} from "lucide-react";
import {
  api,
  createRequestId,
  isTranslateGateway,
  REASONING_EFFORT_OPTIONS,
  type ActionOpenPayload,
  type AiChunkPayload,
  type AiDonePayload,
  type AiErrorPayload,
  type AppSettings,
  type ChatMessage,
  type ReasoningEffort,
} from "../lib/tauri";
import { MarkdownView } from "../components/MarkdownView";

interface TurnItem {
  id: string;
  role: "user" | "assistant";
  content: string;
  reasoning?: string;
}

export function ActionWindow() {
  const [action, setAction] = useState<"translate" | "explain">("translate");
  const [sourceText, setSourceText] = useState("");
  const [sourceExpanded, setSourceExpanded] = useState(false);
  const [targetLang, setTargetLang] = useState("zh-CN");
  const [pinned, setPinned] = useState(false);
  const [showReasoning, setShowReasoning] = useState(false);
  const [reasoningOpen, setReasoningOpen] = useState(false);

  const [translateEffort, setTranslateEffort] = useState<ReasoningEffort>("none");
  const [explainEffort, setExplainEffort] = useState<ReasoningEffort>("low");

  const [gatewayMode, setGatewayMode] = useState(false);
  const [turns, setTurns] = useState<TurnItem[]>([]);
  const [streaming, setStreaming] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const [followUpInput, setFollowUpInput] = useState("");

  const activeRequestIdRef = useRef<string>("");
  const scrollRef = useRef<HTMLDivElement>(null);

  const startFreshRun = useCallback(
    async (
      nextAction: "translate" | "explain",
      text: string,
      nextLang: string,
      effort: ReasoningEffort,
    ) => {
      if (!text) return;
      if (activeRequestIdRef.current) {
        void api.cancelAi(activeRequestIdRef.current);
      }

      const reqId = createRequestId();
      activeRequestIdRef.current = reqId;
      setAction(nextAction);
      setSourceText(text);
      setTargetLang(nextLang);
      setErrorMsg(null);
      setStreaming(true);
      setTurns([{ id: reqId, role: "assistant", content: "", reasoning: "" }]);

      try {
        await api.runSelectionAi(reqId, nextAction, text, nextLang, effort, []);
      } catch (err) {
        if (activeRequestIdRef.current === reqId) {
          setStreaming(false);
          setErrorMsg(String(err));
        }
      }
    },
    [],
  );

  useEffect(() => {
    void api.getSettings().then((s) => {
      setTargetLang(s.translateTargetLang || "zh-CN");
      setShowReasoning(s.showReasoning);
      setTranslateEffort(s.translateReasoningEffort || "none");
      setExplainEffort(s.explainReasoningEffort || "low");
      setGatewayMode(isTranslateGateway(s));
    });
  }, []);

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        if (activeRequestIdRef.current && streaming) {
          void api.cancelAi(activeRequestIdRef.current);
        }
        void api.hideWindow("action");
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [streaming]);

  useEffect(() => {
    const unsubs = [
      listen<AppSettings>("settings:updated", (ev) => {
        setShowReasoning(ev.payload.showReasoning);
        setTranslateEffort(ev.payload.translateReasoningEffort || "none");
        setExplainEffort(ev.payload.explainReasoningEffort || "low");
        setGatewayMode(isTranslateGateway(ev.payload));
      }),
      listen<ActionOpenPayload>("action:open", (ev) => {
        const { action: nextAction, text, targetLang: lang, reasoningEffort } = ev.payload;
        setSourceExpanded(false);
        setFollowUpInput("");
        const effort: ReasoningEffort =
          reasoningEffort || (nextAction === "translate" ? "none" : "low");
        if (nextAction === "explain") {
          setExplainEffort(effort);
        } else {
          setTranslateEffort(effort);
        }
        void startFreshRun(nextAction, text, lang || "zh-CN", effort);
      }),
      listen<AiChunkPayload>("ai:chunk", (ev) => {
        const { requestId, delta, reasoningDelta } = ev.payload;
        if (requestId !== activeRequestIdRef.current) return;
        setTurns((prev) => {
          const idx = prev.findIndex((t) => t.id === requestId);
          if (idx === -1) return prev;
          const next = [...prev];
          next[idx] = {
            ...next[idx],
            content: next[idx].content + delta,
            reasoning: (next[idx].reasoning || "") + reasoningDelta,
          };
          return next;
        });
      }),
      listen<AiDonePayload>("ai:done", (ev) => {
        if (ev.payload.requestId !== activeRequestIdRef.current) return;
        setStreaming(false);
      }),
      listen<AiErrorPayload>("ai:error", (ev) => {
        if (ev.payload.requestId !== activeRequestIdRef.current) return;
        setStreaming(false);
        setErrorMsg(ev.payload.error);
      }),
    ];

    return () => {
      unsubs.forEach((p) => void p.then((fn) => fn()));
    };
  }, [startFreshRun]);

  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [turns, errorMsg]);

  const currentEffort = action === "translate" ? translateEffort : explainEffort;

  const handleSwitchMode = (nextAction: "translate" | "explain") => {
    if (gatewayMode && nextAction === "explain") return;
    const effort = nextAction === "translate" ? translateEffort : explainEffort;
    void startFreshRun(nextAction, sourceText, targetLang, effort);
  };

  const handleChangeExplainEffort = (effort: ReasoningEffort) => {
    setExplainEffort(effort);
    if (action === "explain" && sourceText) {
      void startFreshRun("explain", sourceText, targetLang, effort);
    }
  };

  const handleFollowUp = async () => {
    const q = followUpInput.trim();
    if (!q || !sourceText || streaming) return;

    const history: ChatMessage[] = turns
      .filter((t) => t.content.trim().length > 0)
      .map((t) => ({ role: t.role, content: t.content }));
    history.push({ role: "user", content: q });

    const reqId = createRequestId();
    activeRequestIdRef.current = reqId;
    setFollowUpInput("");
    setErrorMsg(null);
    setStreaming(true);

    const userItem: TurnItem = { id: `u-${Date.now()}`, role: "user", content: q };
    setTurns((prev) => [
      ...prev,
      userItem,
      { id: reqId, role: "assistant", content: "", reasoning: "" },
    ]);

    try {
      await api.runSelectionAi(reqId, action, sourceText, targetLang, currentEffort, history);
    } catch (err) {
      if (activeRequestIdRef.current === reqId) {
        setStreaming(false);
        setErrorMsg(String(err));
      }
    }
  };

  const togglePin = async () => {
    const next = !pinned;
    setPinned(next);
    await api.setActionPinned(next);
  };

  const handleCopy = async (id: string, text: string) => {
    if (!text) return;
    await api.copyText(text);
    setCopiedId(id);
    setTimeout(() => setCopiedId((cur) => (cur === id ? null : cur)), 1400);
  };

  const handleStop = async () => {
    if (activeRequestIdRef.current) {
      await api.cancelAi(activeRequestIdRef.current);
      setStreaming(false);
    }
  };

  const latestAssistant = [...turns].reverse().find((t) => t.role === "assistant");

  return (
    <div className="w-full h-full p-1.5">
      <div className="glass-panel w-full h-full rounded-2xl flex flex-col overflow-hidden">
        {/* Draggable Header */}
        <div
          data-tauri-drag-region
          className="h-10 px-2.5 border-b border-[var(--border-color)] flex items-center justify-between gap-2 shrink-0 cursor-move"
        >
          <div className="flex items-center gap-1" data-tauri-drag-region="false">
            <button
              type="button"
              onClick={() => handleSwitchMode("translate")}
              className={`h-6.5 px-2.5 rounded-lg text-[12px] font-medium flex items-center gap-1 transition-colors cursor-pointer ${
                action === "translate"
                  ? "bg-[var(--accent)] text-white"
                  : "text-[var(--text-secondary)] hover:bg-[var(--surface-subtle)]"
              }`}
            >
              <Languages className="w-3.5 h-3.5" />
              翻译
            </button>
            <button
              type="button"
              onClick={() => handleSwitchMode("explain")}
              disabled={gatewayMode}
              title={gatewayMode ? "当前供应商是翻译网关，仅支持翻译" : undefined}
              className={`h-6.5 px-2.5 rounded-lg text-[12px] font-medium flex items-center gap-1 transition-colors ${
                gatewayMode
                  ? "opacity-40 cursor-not-allowed text-[var(--text-muted)]"
                  : "cursor-pointer"
              } ${
                action === "explain"
                  ? "bg-[var(--accent)] text-white"
                  : "text-[var(--text-secondary)] hover:bg-[var(--surface-subtle)]"
              }`}
            >
              <BookOpen className="w-3.5 h-3.5" />
              解释
            </button>

            {gatewayMode && (
              <span
                className="h-6 px-1.5 rounded-md bg-[var(--surface-subtle)] text-[10.5px] text-[var(--text-muted)] flex items-center shrink-0"
                title="当前供应商只做翻译（如豆包翻译网关）：解释与追问需切换对话模型"
              >
                翻译网关
              </span>
            )}

            {action === "translate" ? (
              <select
                value={targetLang}
                onChange={(e) =>
                  void startFreshRun("translate", sourceText, e.target.value, translateEffort)
                }
                className="ml-1 h-6.5 px-1.5 rounded-lg text-[11.5px] bg-[var(--surface-subtle)] text-[var(--text-secondary)] border border-transparent hover:border-[var(--border-color)] outline-none cursor-pointer"
                title="目标语言"
              >
                <option value="zh-CN">智能中英</option>
                <option value="en">译为英文</option>
                <option value="ja">译为日文</option>
              </select>
            ) : (
              <div
                className="ml-1 h-6.5 px-1.5 rounded-lg bg-[var(--surface-subtle)] border border-transparent hover:border-[var(--border-color)] flex items-center gap-1"
                title="解释任务思考强度"
              >
                <Brain className="w-3 h-3 text-[var(--text-muted)] shrink-0" />
                <select
                  value={explainEffort}
                  onChange={(e) => handleChangeExplainEffort(e.target.value as ReasoningEffort)}
                  className="bg-transparent text-[11.5px] text-[var(--text-secondary)] outline-none cursor-pointer"
                >
                  {REASONING_EFFORT_OPTIONS.map((opt) => (
                    <option key={opt.value} value={opt.value}>
                      {opt.short}
                    </option>
                  ))}
                </select>
              </div>
            )}
          </div>

          <div className="flex items-center gap-0.5">
            {latestAssistant?.content && (
              <button
                type="button"
                onClick={() => void handleCopy("header", latestAssistant.content)}
                className="w-7 h-7 rounded-lg flex items-center justify-center text-[var(--text-secondary)] hover:bg-[var(--surface-subtle)] hover:text-[var(--text-primary)] cursor-pointer"
                title="复制结果"
              >
                {copiedId === "header" ? (
                  <Check className="w-3.5 h-3.5 text-emerald-500" />
                ) : (
                  <Copy className="w-3.5 h-3.5" />
                )}
              </button>
            )}
            <button
              type="button"
              onClick={() => void startFreshRun(action, sourceText, targetLang, currentEffort)}
              disabled={streaming}
              className="w-7 h-7 rounded-lg flex items-center justify-center text-[var(--text-secondary)] hover:bg-[var(--surface-subtle)] hover:text-[var(--text-primary)] disabled:opacity-40 cursor-pointer"
              title="重新生成"
            >
              <RotateCw className={`w-3.5 h-3.5 ${streaming ? "animate-spin" : ""}`} />
            </button>
            <button
              type="button"
              onClick={() => void togglePin()}
              className={`w-7 h-7 rounded-lg flex items-center justify-center transition-colors cursor-pointer ${
                pinned
                  ? "text-[var(--accent)] bg-[var(--accent-soft)]"
                  : "text-[var(--text-secondary)] hover:bg-[var(--surface-subtle)]"
              }`}
              title={pinned ? "取消置顶" : "图钉置顶（失焦不自动隐藏）"}
            >
              {pinned ? <Pin className="w-3.5 h-3.5" /> : <PinOff className="w-3.5 h-3.5" />}
            </button>
            <button
              type="button"
              onClick={() => void api.hideWindow("action")}
              className="w-7 h-7 rounded-lg flex items-center justify-center text-[var(--text-secondary)] hover:bg-red-500/10 hover:text-red-500 cursor-pointer"
              title="关闭 (Esc)"
            >
              <X className="w-3.5 h-3.5" />
            </button>
          </div>
        </div>

        {/* Selected Source Quote */}
        {sourceText && (
          <div
            onClick={() => setSourceExpanded((v) => !v)}
            className="px-3 py-2 bg-[var(--surface-subtle)] border-b border-[var(--border-color)] flex items-start justify-between gap-2 cursor-pointer shrink-0"
          >
            <p
              className={`text-[12px] text-[var(--text-secondary)] select-text ${
                sourceExpanded ? "whitespace-pre-wrap max-h-28 overflow-y-auto" : "line-clamp-2"
              }`}
            >
              {sourceText}
            </p>
            <span className="text-[var(--text-muted)] shrink-0 mt-0.5">
              {sourceExpanded ? (
                <ChevronUp className="w-3.5 h-3.5" />
              ) : (
                <ChevronDown className="w-3.5 h-3.5" />
              )}
            </span>
          </div>
        )}

        {/* Result Stream Body */}
        <div ref={scrollRef} className="flex-1 overflow-y-auto px-3.5 py-3 space-y-3">
          {turns.map((turn, idx) => {
            const isLast = idx === turns.length - 1;
            const isCurrentStream = streaming && isLast && turn.role === "assistant";
            if (turn.role === "user") {
              return (
                <div key={turn.id} className="flex justify-end">
                  <div className="max-w-[85%] px-3 py-1.5 rounded-2xl rounded-br-sm bg-[var(--accent)] text-white text-[12.5px] select-text whitespace-pre-wrap">
                    {turn.content}
                  </div>
                </div>
              );
            }
            return (
              <div key={turn.id} className="space-y-1.5">
                {showReasoning && turn.reasoning && (
                  <div className="rounded-lg bg-[var(--surface-subtle)] border border-[var(--border-color)] px-2.5 py-1.5">
                    <button
                      type="button"
                      onClick={() => setReasoningOpen((v) => !v)}
                      className="text-[11px] text-[var(--text-muted)] flex items-center gap-1 cursor-pointer"
                    >
                      <span>思考过程</span>
                      {reasoningOpen ? (
                        <ChevronUp className="w-3 h-3" />
                      ) : (
                        <ChevronDown className="w-3 h-3" />
                      )}
                    </button>
                    {reasoningOpen && (
                      <p className="mt-1 text-[11.5px] text-[var(--text-secondary)] whitespace-pre-wrap select-text">
                        {turn.reasoning}
                      </p>
                    )}
                  </div>
                )}

                {turn.content ? (
                  <MarkdownView content={turn.content} streaming={isCurrentStream} />
                ) : isCurrentStream ? (
                  <div className="flex items-center gap-2 text-[12.5px] text-[var(--text-muted)] py-1">
                    <span className="inline-block w-2 h-2 rounded-full bg-[var(--accent)] animate-pulse" />
                    <span>{turn.reasoning ? "深度思考中..." : "正在连接模型..."}</span>
                  </div>
                ) : null}
              </div>
            );
          })}

          {errorMsg && (
            <div className="p-2.5 rounded-xl bg-red-500/10 border border-red-500/25 text-red-500 text-[12.5px] select-text">
              <div>{errorMsg}</div>
              <div className="mt-1.5 flex items-center gap-3">
                <button
                  type="button"
                  onClick={() => void startFreshRun(action, sourceText, targetLang, currentEffort)}
                  className="text-[12px] underline cursor-pointer"
                >
                  重试
                </button>
                <button
                  type="button"
                  onClick={() => void api.openSettings()}
                  className="text-[12px] underline cursor-pointer"
                >
                  打开设置
                </button>
              </div>
            </div>
          )}
        </div>

        {/* Follow-up Input */}
        <div className="px-2.5 py-2 border-t border-[var(--border-color)] flex items-center gap-1.5 shrink-0">
          <input
            type="text"
            value={followUpInput}
            onChange={(e) => setFollowUpInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
                e.preventDefault();
                void handleFollowUp();
              }
            }}
            disabled={gatewayMode}
            placeholder={gatewayMode ? "当前供应商是翻译网关，仅支持翻译" : "继续追问这段内容..."}
            className="flex-1 h-8 px-2.5 rounded-xl bg-[var(--surface-subtle)] border border-transparent focus:border-[var(--accent)] outline-none text-[12.5px] select-text disabled:opacity-60 disabled:cursor-not-allowed"
          />
          {streaming ? (
            <button
              type="button"
              onClick={() => void handleStop()}
              className="h-8 px-2.5 rounded-xl bg-red-500/15 text-red-500 hover:bg-red-500/25 flex items-center gap-1 text-[12px] font-medium cursor-pointer"
              title="停止生成"
            >
              <Square className="w-3 h-3 fill-current" />
            </button>
          ) : (
            <button
              type="button"
              onClick={() => void handleFollowUp()}
              disabled={!followUpInput.trim() || gatewayMode}
              className="h-8 w-8 rounded-xl bg-[var(--accent)] text-white flex items-center justify-center disabled:opacity-35 hover:opacity-90 cursor-pointer"
              title="发送追问"
            >
              <Send className="w-3.5 h-3.5" />
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
