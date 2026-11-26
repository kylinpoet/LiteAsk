import { useEffect, useRef, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import {
  AlertTriangle,
  Brain,
  Check,
  ChevronDown,
  ChevronUp,
  Copy,
  Pin,
  PinOff,
  Plus,
  Send,
  Settings,
  Sparkles,
  Square,
  X,
} from "lucide-react";
import {
  api,
  createRequestId,
  isTranslateGateway,
  REASONING_EFFORT_OPTIONS,
  type AiChunkPayload,
  type AiDonePayload,
  type AiErrorPayload,
  type AppSettings,
  type ChatMessage,
  type ReasoningEffort,
} from "../lib/tauri";
import { MarkdownView } from "../components/MarkdownView";

interface MessageItem {
  id: string;
  role: "user" | "assistant";
  content: string;
  reasoning?: string;
}

const QUICK_PROMPTS = [
  { label: "翻译成中文", prefix: "请把下面内容翻译成自然地道的中文：\n" },
  { label: "通俗解释", prefix: "请用通俗易懂的方式解释：" },
  { label: "润色文字", prefix: "请帮我润色以下文字，让表达更专业简洁：\n" },
  { label: "提炼要点", prefix: "请提炼以下内容的核心要点：\n" },
];

export function QuickAskWindow() {
  const [messages, setMessages] = useState<MessageItem[]>([]);
  const [input, setInput] = useState("");
  const [streaming, setStreaming] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [pinned, setPinned] = useState(false);
  const [modelName, setModelName] = useState("deepseek-v4.1-flash");
  const [effort, setEffort] = useState<ReasoningEffort>("medium");
  const [showReasoning, setShowReasoning] = useState(false);
  const [gatewayMode, setGatewayMode] = useState(false);
  const [expandedReasoning, setExpandedReasoning] = useState<Record<string, boolean>>({});
  const [copiedId, setCopiedId] = useState<string | null>(null);

  const activeRequestIdRef = useRef<string>("");
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    void api.getSettings().then((s) => {
      setModelName(s.model);
      setShowReasoning(s.showReasoning);
      setEffort(s.quickAskReasoningEffort || "medium");
      setGatewayMode(isTranslateGateway(s));
    });
  }, []);

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        void api.hideWindow("quick-ask");
      } else if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "n") {
        e.preventDefault();
        void handleNewChat();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  useEffect(() => {
    const unsubs = [
      listen<AppSettings>("settings:updated", (ev) => {
        setModelName(ev.payload.model);
        setShowReasoning(ev.payload.showReasoning);
        setEffort(ev.payload.quickAskReasoningEffort || "medium");
        setGatewayMode(isTranslateGateway(ev.payload));
      }),
      listen("quick-ask:focus", () => {
        setTimeout(() => textareaRef.current?.focus(), 20);
      }),
      listen<{ text: string }>("quick-ask:seed", (ev) => {
        const quoted = `关于这段内容：\n> ${ev.payload.text.replace(/\n/g, "\n> ")}\n\n`;
        setInput(quoted);
        setTimeout(() => {
          const el = textareaRef.current;
          if (el) {
            el.focus();
            el.setSelectionRange(quoted.length, quoted.length);
          }
        }, 30);
      }),
      listen<AiChunkPayload>("ai:chunk", (ev) => {
        const { requestId, delta, reasoningDelta } = ev.payload;
        if (requestId !== activeRequestIdRef.current) return;
        setMessages((prev) => {
          const idx = prev.findIndex((m) => m.id === requestId);
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
  }, []);

  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [messages, errorMsg]);

  const handleSend = async () => {
    const prompt = input.trim();
    if (!prompt || streaming || gatewayMode) return;

    const history: ChatMessage[] = messages
      .filter((m) => m.content.trim().length > 0)
      .map((m) => ({ role: m.role, content: m.content }));
    history.push({ role: "user", content: prompt });

    const reqId = createRequestId();
    activeRequestIdRef.current = reqId;

    const userMsg: MessageItem = { id: `u-${Date.now()}`, role: "user", content: prompt };
    setInput("");
    setErrorMsg(null);
    setStreaming(true);
    setMessages((prev) => [
      ...prev,
      userMsg,
      { id: reqId, role: "assistant", content: "", reasoning: "" },
    ]);

    try {
      await api.runQuickAskAi(reqId, history, effort);
    } catch (err) {
      if (activeRequestIdRef.current === reqId) {
        setStreaming(false);
        setErrorMsg(String(err));
      }
    }
  };

  const handleNewChat = async () => {
    if (activeRequestIdRef.current) {
      await api.cancelAi(activeRequestIdRef.current);
    }
    activeRequestIdRef.current = "";
    setMessages([]);
    setErrorMsg(null);
    setStreaming(false);
    setTimeout(() => textareaRef.current?.focus(), 20);
  };

  const handleStop = async () => {
    if (activeRequestIdRef.current) {
      await api.cancelAi(activeRequestIdRef.current);
      setStreaming(false);
    }
  };

  const togglePin = async () => {
    const next = !pinned;
    setPinned(next);
    await api.setQuickAskPinned(next);
  };

  const handleCopy = async (id: string, text: string) => {
    await api.copyText(text);
    setCopiedId(id);
    setTimeout(() => setCopiedId((cur) => (cur === id ? null : cur)), 1400);
  };

  return (
    <div className="w-full h-full p-2">
      <div className="glass-panel w-full h-full rounded-2xl flex flex-col overflow-hidden">
        {/* Draggable Top Bar */}
        <div
          data-tauri-drag-region
          className="h-11 px-3.5 border-b border-[var(--border-color)] flex items-center justify-between shrink-0 cursor-move"
        >
          <div className="flex items-center gap-2">
            <div className="flex items-center gap-2 pointer-events-none">
              <div className="w-6 h-6 rounded-lg bg-[var(--accent)] text-white flex items-center justify-center shadow-xs">
                <Sparkles className="w-3.5 h-3.5" />
              </div>
              <span className="font-semibold text-[13.5px] tracking-tight">LiteAsk</span>
              <span className="px-2 py-0.5 rounded-md bg-[var(--surface-subtle)] text-[11px] text-[var(--text-secondary)] font-mono">
                {modelName}
              </span>
            </div>

            <div
              className="h-6 px-1.5 rounded-md bg-[var(--surface-subtle)] border border-transparent hover:border-[var(--border-color)] flex items-center gap-1"
              title="弹窗助手思考强度"
            >
              <Brain className="w-3 h-3 text-[var(--text-muted)] shrink-0" />
              <select
                value={effort}
                onChange={(e) => setEffort(e.target.value as ReasoningEffort)}
                className="bg-transparent text-[11px] text-[var(--text-secondary)] outline-none cursor-pointer"
              >
                {REASONING_EFFORT_OPTIONS.map((opt) => (
                  <option key={opt.value} value={opt.value}>
                    {opt.short}
                  </option>
                ))}
              </select>
            </div>
          </div>

          <div className="flex items-center gap-0.5">
            {messages.length > 0 && (
              <button
                type="button"
                onClick={() => void handleNewChat()}
                className="h-7 px-2 rounded-lg text-[12px] text-[var(--text-secondary)] hover:bg-[var(--surface-subtle)] hover:text-[var(--text-primary)] flex items-center gap-1 cursor-pointer"
                title="新对话 (Cmd/Ctrl+N)"
              >
                <Plus className="w-3.5 h-3.5" />
                <span>新对话</span>
              </button>
            )}
            <button
              type="button"
              onClick={() => void togglePin()}
              className={`w-7 h-7 rounded-lg flex items-center justify-center transition-colors cursor-pointer ${
                pinned
                  ? "text-[var(--accent)] bg-[var(--accent-soft)]"
                  : "text-[var(--text-secondary)] hover:bg-[var(--surface-subtle)]"
              }`}
              title={pinned ? "取消置顶" : "置顶弹窗（点击外部不隐藏）"}
            >
              {pinned ? <Pin className="w-3.5 h-3.5" /> : <PinOff className="w-3.5 h-3.5" />}
            </button>
            <button
              type="button"
              onClick={() => void api.openSettings()}
              className="w-7 h-7 rounded-lg flex items-center justify-center text-[var(--text-secondary)] hover:bg-[var(--surface-subtle)] hover:text-[var(--text-primary)] cursor-pointer"
              title="偏好设置"
            >
              <Settings className="w-3.5 h-3.5" />
            </button>
            <button
              type="button"
              onClick={() => void api.hideWindow("quick-ask")}
              className="w-7 h-7 rounded-lg flex items-center justify-center text-[var(--text-secondary)] hover:bg-red-500/10 hover:text-red-500 cursor-pointer"
              title="收起 (Esc)"
            >
              <X className="w-3.5 h-3.5" />
            </button>
          </div>
        </div>

        {/* Messages / Empty Spotlight Welcome */}
        <div ref={scrollRef} className="flex-1 overflow-y-auto px-4 py-3.5 space-y-3.5">
          {gatewayMode && (
            <div className="p-3 rounded-xl bg-amber-500/10 border border-amber-500/30 text-[12px] text-amber-700 dark:text-amber-400 flex items-start gap-2 select-text">
              <AlertTriangle className="w-4 h-4 shrink-0 mt-0.5" />
              <span>
                当前供应商是「翻译网关」，只能翻译。弹窗助手需要对话模型，请到「设置 →
                模型供应商」新增或切换一个「对话模型」类型的供应商。
              </span>
            </div>
          )}

          {messages.length === 0 ? (
            <div className="h-full flex flex-col items-center justify-center text-center py-6">
              <div className="w-11 h-11 rounded-2xl bg-[var(--accent-soft)] text-[var(--accent)] flex items-center justify-center mb-3">
                <Sparkles className="w-5 h-5" />
              </div>
              <p className="text-[14.5px] font-medium text-[var(--text-primary)]">
                随时向 AI 提问
              </p>
              <p className="text-[12px] text-[var(--text-muted)] mt-1">
                Enter 发送 · Shift+Enter 换行 · Esc 快速收起
              </p>
              <div className="mt-5 flex flex-wrap items-center justify-center gap-2 max-w-md">
                {QUICK_PROMPTS.map((item) => (
                  <button
                    key={item.label}
                    type="button"
                    onClick={() => {
                      setInput(item.prefix);
                      textareaRef.current?.focus();
                    }}
                    className="px-3 py-1.5 rounded-full text-[12px] bg-[var(--surface-subtle)] hover:bg-[var(--accent-soft)] hover:text-[var(--accent)] text-[var(--text-secondary)] border border-[var(--border-color)] transition-colors cursor-pointer"
                  >
                    {item.label}
                  </button>
                ))}
              </div>
            </div>
          ) : (
            messages.map((msg, idx) => {
              const isLast = idx === messages.length - 1;
              const isCurrentStream = streaming && isLast && msg.role === "assistant";
              if (msg.role === "user") {
                return (
                  <div key={msg.id} className="flex justify-end">
                    <div className="max-w-[82%] px-3.5 py-2 rounded-2xl rounded-br-sm bg-[var(--accent)] text-white text-[13.5px] whitespace-pre-wrap select-text">
                      {msg.content}
                    </div>
                  </div>
                );
              }
              return (
                <div key={msg.id} className="group space-y-1.5">
                  {showReasoning && msg.reasoning && (
                    <div className="rounded-lg bg-[var(--surface-subtle)] border border-[var(--border-color)] px-2.5 py-1.5">
                      <button
                        type="button"
                        onClick={() =>
                          setExpandedReasoning((prev) => ({
                            ...prev,
                            [msg.id]: !prev[msg.id],
                          }))
                        }
                        className="text-[11px] text-[var(--text-muted)] flex items-center gap-1 cursor-pointer"
                      >
                        <span>思考过程</span>
                        {expandedReasoning[msg.id] ? (
                          <ChevronUp className="w-3 h-3" />
                        ) : (
                          <ChevronDown className="w-3 h-3" />
                        )}
                      </button>
                      {expandedReasoning[msg.id] && (
                        <p className="mt-1 text-[11.5px] text-[var(--text-secondary)] whitespace-pre-wrap select-text">
                          {msg.reasoning}
                        </p>
                      )}
                    </div>
                  )}

                  <div className="rounded-2xl bg-[var(--surface-subtle)] border border-[var(--border-color)] px-3.5 py-2.5">
                    {msg.content ? (
                      <MarkdownView content={msg.content} streaming={isCurrentStream} />
                    ) : isCurrentStream ? (
                      <div className="flex items-center gap-2 text-[12.5px] text-[var(--text-muted)]">
                        <span className="inline-block w-2 h-2 rounded-full bg-[var(--accent)] animate-pulse" />
                        <span>{msg.reasoning ? "深度思考中..." : "正在连接模型..."}</span>
                      </div>
                    ) : null}

                    {!isCurrentStream && msg.content && (
                      <div className="mt-2 pt-1.5 border-t border-[var(--border-color)] flex justify-end">
                        <button
                          type="button"
                          onClick={() => void handleCopy(msg.id, msg.content)}
                          className="text-[11.5px] text-[var(--text-muted)] hover:text-[var(--text-primary)] flex items-center gap-1 cursor-pointer"
                        >
                          {copiedId === msg.id ? (
                            <>
                              <Check className="w-3 h-3 text-emerald-500" />
                              <span>已复制</span>
                            </>
                          ) : (
                            <>
                              <Copy className="w-3 h-3" />
                              <span>复制</span>
                            </>
                          )}
                        </button>
                      </div>
                    )}
                  </div>
                </div>
              );
            })
          )}

          {errorMsg && (
            <div className="p-3 rounded-xl bg-red-500/10 border border-red-500/25 text-red-500 text-[12.5px] select-text">
              <div>{errorMsg}</div>
              <button
                type="button"
                onClick={() => void api.openSettings()}
                className="mt-1 text-[12px] underline cursor-pointer"
              >
                打开设置检查 API 配置
              </button>
            </div>
          )}
        </div>

        {/* Prompt Input Dock */}
        <div className="p-3 border-t border-[var(--border-color)] shrink-0">
          <div className="flex items-end gap-2 bg-[var(--surface-subtle)] rounded-xl border border-[var(--border-color)] focus-within:border-[var(--accent)] px-3 py-2 transition-colors">
            <textarea
              ref={textareaRef}
              rows={2}
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
                  e.preventDefault();
                  void handleSend();
                }
              }}
              placeholder="输入你的问题，按 Enter 发送..."
              className="flex-1 bg-transparent outline-none resize-none text-[13.5px] leading-relaxed max-h-32 select-text"
            />
            {streaming ? (
              <button
                type="button"
                onClick={() => void handleStop()}
                className="h-8 px-3 rounded-lg bg-red-500/15 text-red-500 hover:bg-red-500/25 flex items-center gap-1 text-[12px] font-medium shrink-0 cursor-pointer"
                title="停止生成"
              >
                <Square className="w-3 h-3 fill-current" />
                <span>停止</span>
              </button>
            ) : (
              <button
                type="button"
                onClick={() => void handleSend()}
                disabled={!input.trim() || gatewayMode}
                className="h-8 px-3 rounded-lg bg-[var(--accent)] text-white hover:opacity-90 disabled:opacity-35 flex items-center gap-1.5 text-[12.5px] font-medium shrink-0 cursor-pointer"
              >
                <Send className="w-3.5 h-3.5" />
                <span>发送</span>
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
