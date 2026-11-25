use futures_util::StreamExt;
use parking_lot::Mutex;
use reqwest::Client;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::sync::Arc;
use std::time::Duration;
use tauri::{AppHandle, Emitter};
use tokio::sync::oneshot;

use crate::config::AppSettings;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ChatMessage {
    pub role: String,
    pub content: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AiChunkPayload {
    pub request_id: String,
    pub delta: String,
    pub reasoning_delta: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AiDonePayload {
    pub request_id: String,
    pub aborted: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AiErrorPayload {
    pub request_id: String,
    pub error: String,
}

pub struct AiManager {
    client: Client,
    active_cancels: Arc<Mutex<HashMap<String, oneshot::Sender<()>>>>,
}

impl AiManager {
    pub fn new() -> Self {
        let client = Client::builder()
            .user_agent("LiteAsk/0.2.0")
            .http2_adaptive_window(true)
            .tcp_keepalive(Some(Duration::from_secs(30)))
            .connect_timeout(Duration::from_secs(12))
            .build()
            .expect("failed to build reqwest client");
        Self {
            client,
            active_cancels: Arc::new(Mutex::new(HashMap::new())),
        }
    }

    pub fn cancel(&self, request_id: &str) {
        if let Some(tx) = self.active_cancels.lock().remove(request_id) {
            let _ = tx.send(());
        }
    }

    pub fn build_selection_messages(
        action: &str,
        text: &str,
        target_lang: &str,
        follow_ups: &[ChatMessage],
    ) -> Vec<ChatMessage> {
        let system_prompt = match action {
            "translate" => build_translate_system_prompt(target_lang),
            "explain" => build_explain_system_prompt(),
            _ => "你是 LiteAsk 桌面智能助手。请用清晰、简洁、准确的中文回答用户的问题。".to_string(),
        };

        let mut msgs = vec![ChatMessage {
            role: "system".to_string(),
            content: system_prompt,
        }];

        // 只把原文放进 user 消息：若把「请翻译以下内容：」这类指令和原文拼在一起，
        // 部分模型（尤其是自定义中转/小模型）会直接复述整段指令而不再翻译。
        msgs.push(ChatMessage {
            role: "user".to_string(),
            content: text.to_string(),
        });

        for m in follow_ups {
            msgs.push(m.clone());
        }

        msgs
    }

    pub fn start_stream(
        &self,
        app: AppHandle,
        target_window: String,
        request_id: String,
        session_id: String,
        settings: AppSettings,
        messages: Vec<ChatMessage>,
        reasoning_effort: String,
    ) {
        self.cancel(&request_id);
        let (cancel_tx, mut cancel_rx) = oneshot::channel::<()>();
        self.active_cancels
            .lock()
            .insert(request_id.clone(), cancel_tx);

        let client = self.client.clone();
        let active_cancels = self.active_cancels.clone();

        tauri::async_runtime::spawn(async move {
            let result = stream_chat_completion(
                &client,
                &app,
                &target_window,
                &request_id,
                &session_id,
                &settings,
                messages,
                &reasoning_effort,
                &mut cancel_rx,
            )
            .await;

            active_cancels.lock().remove(&request_id);

            match result {
                Ok(aborted) => {
                    let _ = app.emit_to(
                        &target_window,
                        "ai:done",
                        AiDonePayload {
                            request_id,
                            aborted,
                        },
                    );
                }
                Err(err) => {
                    let _ = app.emit_to(
                        &target_window,
                        "ai:error",
                        AiErrorPayload {
                            request_id,
                            error: err,
                        },
                    );
                }
            }
        });
    }

    pub async fn test_connection(&self, settings: &AppSettings) -> Result<String, String> {
        if settings.base_url.trim().is_empty() {
            return Err("请先填写供应商的 API Base URL。".to_string());
        }
        if settings.api_key.trim().is_empty() && !is_local_url(&settings.base_url) {
            return Err("请先填写 API Key（本地模型如 Ollama 可留空）。".to_string());
        }
        if settings.model.trim().is_empty() {
            return Err("请先填写要调用的模型 ID。".to_string());
        }

        let endpoint = format!(
            "{}/chat/completions",
            settings.base_url.trim().trim_end_matches('/')
        );

        let mut body = serde_json::json!({
            "model": settings.model.trim(),
            "messages": [
                { "role": "user", "content": "Reply with OK only." }
            ],
            "max_tokens": 32,
            "stream": false
        });
        if is_opencode_url(&settings.base_url) {
            body["reasoning_effort"] = serde_json::Value::String("none".to_string());
        }

        let session_id = format!("ses_liteask_test_{}", uuid::Uuid::new_v4());
        let started = std::time::Instant::now();
        let mut req = self.client.post(&endpoint).json(&body);
        if !settings.api_key.trim().is_empty() {
            req = req.bearer_auth(settings.api_key.trim());
        }
        if is_opencode_url(&settings.base_url) {
            req = req.header("x-opencode-session", &session_id);
        }

        let resp = tokio::time::timeout(Duration::from_secs(20), req.send())
            .await
            .map_err(|_| "连接超时（20s），请检查 Base URL、网络或代理设置。".to_string())?
            .map_err(|e| format!("网络请求失败: {e}"))?;

        let status = resp.status();
        let text = tokio::time::timeout(Duration::from_secs(15), resp.text())
            .await
            .map_err(|_| "读取响应超时。".to_string())?
            .map_err(|e| format!("读取响应失败: {e}"))?;

        if !status.is_success() {
            return Err(format!("接口返回 HTTP {status}: {}", truncate(&text, 240)));
        }

        let parsed: serde_json::Value =
            serde_json::from_str(&text).map_err(|e| format!("解析响应 JSON 失败: {e}"))?;
        let msg = &parsed["choices"][0]["message"];
        let reply = msg["content"]
            .as_str()
            .filter(|s| !s.trim().is_empty())
            .or_else(|| msg["reasoning_content"].as_str())
            .unwrap_or("OK")
            .trim()
            .to_string();

        let elapsed_ms = started.elapsed().as_millis();
        Ok(format!(
            "连接成功（{}ms）！模型 {} 响应：{}",
            elapsed_ms,
            settings.model,
            truncate(&reply, 60)
        ))
    }

    pub async fn fetch_models(&self, base_url: &str, api_key: &str) -> Result<Vec<String>, String> {
        let base = base_url.trim().trim_end_matches('/');
        let mut urls = vec![format!("{base}/models")];
        if base.ends_with("/inference/go/openai/v1") {
            urls.push("https://opencode.ai/inference/go/v1/models".to_string());
        }

        let mut last_err = String::from("未能获取模型列表");
        for url in urls {
            let mut req = self.client.get(&url);
            if !api_key.trim().is_empty() {
                req = req.bearer_auth(api_key.trim());
            }
            match tokio::time::timeout(Duration::from_secs(12), req.send()).await {
                Ok(Ok(resp)) if resp.status().is_success() => {
                    if let Ok(json) = resp.json::<serde_json::Value>().await {
                        if let Some(arr) = json.get("data").and_then(|d| d.as_array()) {
                            let mut ids: Vec<String> = arr
                                .iter()
                                .filter_map(|item| item.get("id").and_then(|v| v.as_str()))
                                .map(|s| s.to_string())
                                .collect();
                            ids.sort();
                            ids.dedup();
                            if !ids.is_empty() {
                                return Ok(ids);
                            }
                        }
                    }
                }
                Ok(Ok(resp)) => {
                    last_err = format!("获取模型列表失败 (HTTP {})", resp.status());
                }
                Ok(Err(e)) => {
                    last_err = format!("获取模型列表网络失败: {e}");
                }
                Err(_) => {
                    last_err = "获取模型列表超时".to_string();
                }
            }
        }
        Err(last_err)
    }
}

fn is_opencode_url(url: &str) -> bool {
    url.to_lowercase().contains("opencode.ai")
}

fn is_local_url(url: &str) -> bool {
    let lower = url.to_lowercase();
    lower.contains("://localhost") || lower.contains("://127.0.0.1") || lower.contains("://[::1]")
}

fn build_request_payload(
    settings: &AppSettings,
    messages: &[ChatMessage],
    reasoning_effort: &str,
) -> serde_json::Value {
    let mut obj = serde_json::json!({
        "model": settings.model.trim(),
        "messages": messages,
        "stream": true,
        "temperature": 0.3
    });

    let normalized = reasoning_effort.trim().to_lowercase();
    if !normalized.is_empty() && normalized != "default" {
        obj["reasoning_effort"] = serde_json::Value::String(normalized);
    }

    obj
}

async fn send_with_retry(
    client: &Client,
    endpoint: &str,
    api_key: &str,
    session_id: &str,
    payload: &serde_json::Value,
    cancel_rx: &mut oneshot::Receiver<()>,
) -> Result<Option<reqwest::Response>, String> {
    let mut last_err = String::new();
    let opencode = is_opencode_url(endpoint);

    for attempt in 0..2 {
        let mut req = client
            .post(endpoint)
            .header("Accept", "text/event-stream")
            .json(payload);
        if !api_key.is_empty() {
            req = req.bearer_auth(api_key);
        }
        if opencode {
            req = req.header("x-opencode-session", session_id);
        }

        let send_fut = tokio::time::timeout(Duration::from_secs(22), req.send());

        let res = tokio::select! {
            _ = &mut *cancel_rx => return Ok(None),
            r = send_fut => r,
        };

        match res {
            Ok(Ok(resp)) => return Ok(Some(resp)),
            Ok(Err(e)) => {
                last_err = format!("请求 AI 服务失败: {e}");
            }
            Err(_) => {
                last_err = "连接模型超时（22s 无响应），请检查网络或稍后重试。".to_string();
            }
        }

        if attempt == 0 {
            tokio::select! {
                _ = &mut *cancel_rx => return Ok(None),
                _ = tokio::time::sleep(Duration::from_millis(350)) => {}
            }
        }
    }

    Err(last_err)
}

#[allow(clippy::too_many_arguments)]
async fn stream_chat_completion(
    client: &Client,
    app: &AppHandle,
    target_window: &str,
    request_id: &str,
    session_id: &str,
    settings: &AppSettings,
    messages: Vec<ChatMessage>,
    reasoning_effort: &str,
    cancel_rx: &mut oneshot::Receiver<()>,
) -> Result<bool, String> {
    if settings.base_url.trim().is_empty() {
        return Err("未配置模型供应商 Base URL，请点击托盘图标打开「设置」配置。".to_string());
    }
    if settings.api_key.trim().is_empty() && !is_local_url(&settings.base_url) {
        return Err(
            "未配置 API Key。请点击托盘图标打开「设置」，填写供应商 API Key 或导入 OpenCode Go Key。"
                .to_string(),
        );
    }

    let endpoint = format!(
        "{}/chat/completions",
        settings.base_url.trim().trim_end_matches('/')
    );

    let payload = build_request_payload(settings, &messages, reasoning_effort);

    let Some(response) = send_with_retry(
        client,
        &endpoint,
        settings.api_key.trim(),
        session_id,
        &payload,
        cancel_rx,
    )
    .await?
    else {
        return Ok(true);
    };

    if !response.status().is_success() {
        let status = response.status();
        let err_body = response.text().await.unwrap_or_default();
        return Err(format!(
            "AI 接口报错 (HTTP {status}): {}",
            truncate(&err_body, 300)
        ));
    }

    let mut stream = response.bytes_stream();
    let mut buffer = String::new();

    loop {
        let next_chunk = tokio::select! {
            _ = &mut *cancel_rx => return Ok(true),
            chunk = tokio::time::timeout(Duration::from_secs(45), stream.next()) => {
                match chunk {
                    Ok(item) => item,
                    Err(_) => return Err("模型流式输出超时（45s 未收到新数据）。".to_string()),
                }
            }
        };

        let Some(chunk_res) = next_chunk else {
            break;
        };

        let bytes = chunk_res.map_err(|e| format!("流式传输中断: {e}"))?;
        buffer.push_str(&String::from_utf8_lossy(&bytes));

        while let Some(newline_pos) = buffer.find('\n') {
            let line = buffer[..newline_pos].trim().to_string();
            buffer.drain(..=newline_pos);

            if line.is_empty() || line.starts_with(':') {
                continue;
            }
            if let Some(data) = line.strip_prefix("data:") {
                let data = data.trim();
                if data == "[DONE]" {
                    return Ok(false);
                }
                if let Ok(json) = serde_json::from_str::<serde_json::Value>(data) {
                    if let Some(err_msg) = json
                        .get("error")
                        .and_then(|e| e.get("message"))
                        .and_then(|m| m.as_str())
                    {
                        return Err(err_msg.to_string());
                    }

                    let delta_obj = &json["choices"][0]["delta"];
                    let content = delta_obj["content"].as_str().unwrap_or("");
                    let reasoning = delta_obj["reasoning_content"]
                        .as_str()
                        .or_else(|| delta_obj["reasoning"].as_str())
                        .unwrap_or("");

                    if !content.is_empty() || !reasoning.is_empty() {
                        let _ = app.emit_to(
                            target_window,
                            "ai:chunk",
                            AiChunkPayload {
                                request_id: request_id.to_string(),
                                delta: content.to_string(),
                                reasoning_delta: reasoning.to_string(),
                            },
                        );
                    }
                }
            }
        }
    }

    Ok(false)
}

fn build_translate_system_prompt(target_lang: &str) -> String {
    const OUTPUT_RULES: &str = "\n输出要求：\n\
1. 只输出译文本身，禁止复述原文，禁止重复或引用用户的指令，禁止输出「请翻译以下内容」「以下是译文」「译文：」之类的提示语，也不要加任何解释、引号或寒暄。\n\
2. 保留原有段落、换行、Markdown 结构、代码标识符与专有名词。\n\
3. 待翻译的内容就是用户消息里的全部文本本身。\n\
4. 若对话中最后一条消息是对译文的追问（例如询问某个词的用法、要求换一种译法），直接回答该追问，不要重新翻译整段内容。";

    match target_lang {
        "en" => format!(
            "你是专业翻译引擎。用户消息就是待翻译的原文，请把它精准、自然、地道地翻译成英文。{}",
            OUTPUT_RULES
        ),
        "ja" => format!(
            "你是专业翻译引擎。用户消息就是待翻译的原文，请把它精准、自然地翻译成日文。{}",
            OUTPUT_RULES
        ),
        _ => format!(
            "你是专业翻译引擎。用户消息就是待翻译的原文，请先自动判断翻译方向：\n\
- 若原文主要是外语（英文、日文、韩文等），翻译成简体中文；\n\
- 若原文本身已经是中文，翻译成自然地道的英文。{}",
            OUTPUT_RULES
        ),
    }
}

fn build_explain_system_prompt() -> String {
    "你是高效的划词解释助手。用户消息就是用户划选出来的原文，请用清晰、易懂的简体中文解释它，并直接给出解释内容：\n\
    - 如果是**单词或短语/专业术语**：简明给出读音/词性（若适用）、核心含义、常见语境和一个简短例句。\n\
    - 如果是**句子或代码片段**：先一句话说清核心意思，再拆解其中的关键表达、隐含逻辑或技术细节。\n\
    - 如果是**段落**：先提炼核心观点，再用 2-4 条要点拆解结构与重点。\n\
    禁止复述原文或重复用户指令（不要输出「请解释以下内容」之类的句子），保持排版清爽、直奔主题，避免空话。\n\
    若对话中最后一条消息是对解释的追问，直接回答该追问即可。"
        .to_string()
}

fn truncate(s: &str, max_chars: usize) -> String {
    if s.chars().count() <= max_chars {
        s.to_string()
    } else {
        let out: String = s.chars().take(max_chars).collect();
        format!("{out}...")
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::config::load_settings;

    #[test]
    fn payload_includes_or_omits_reasoning_effort() {
        let settings = AppSettings::default();
        let msgs = vec![ChatMessage {
            role: "user".into(),
            content: "hi".into(),
        }];

        let p_none = build_request_payload(&settings, &msgs, "none");
        assert_eq!(p_none["reasoning_effort"], "none");

        let p_high = build_request_payload(&settings, &msgs, "high");
        assert_eq!(p_high["reasoning_effort"], "high");

        let p_def = build_request_payload(&settings, &msgs, "default");
        assert!(p_def.get("reasoning_effort").is_none());
    }

    #[tokio::test]
    #[ignore]
    async fn live_opencode_go_http2_and_sse_test() {
        let settings = load_settings();
        assert!(!settings.api_key.is_empty(), "api_key must be configured");
        let mgr = AiManager::new();

        // 1. Test non-streaming connection check
        let msg = mgr.test_connection(&settings).await.expect("test_connection failed");
        println!("[test_connection] {msg}");

        // 2. Test live SSE stream with reasoning_effort = "none" (translate mode)
        let endpoint = format!("{}/chat/completions", settings.base_url.trim_end_matches('/'));
        let msgs = AiManager::build_selection_messages(
            "translate",
            "Lightweight cross-platform AI assistant",
            "zh-CN",
            &[],
        );
        let payload = build_request_payload(&settings, &msgs, "none");
        let resp = mgr
            .client
            .post(&endpoint)
            .bearer_auth(settings.api_key.trim())
            .header("Accept", "text/event-stream")
            .header("x-opencode-session", format!("ses_liteask_rust_test_{}", uuid::Uuid::new_v4()))
            .json(&payload)
            .send()
            .await
            .expect("SSE send failed");

        println!("[SSE] version={:?} status={}", resp.version(), resp.status());
        assert!(resp.status().is_success());

        let mut stream = resp.bytes_stream();
        let mut buf = String::new();
        let mut content = String::new();
        let mut reasoning = String::new();
        while let Some(chunk) = stream.next().await {
            buf.push_str(&String::from_utf8_lossy(&chunk.expect("chunk err")));
            while let Some(pos) = buf.find('\n') {
                let line = buf[..pos].trim().to_string();
                buf.drain(..=pos);
                if let Some(data) = line.strip_prefix("data:") {
                    let data = data.trim();
                    if data == "[DONE]" {
                        break;
                    }
                    if let Ok(json) = serde_json::from_str::<serde_json::Value>(data) {
                        let d = &json["choices"][0]["delta"];
                        if let Some(c) = d["content"].as_str() {
                            content.push_str(c);
                        }
                        if let Some(r) = d["reasoning_content"].as_str() {
                            reasoning.push_str(r);
                        }
                    }
                }
            }
        }
        println!("[SSE translate] reasoning_len={} content={:?}", reasoning.len(), content);
        assert_eq!(reasoning.len(), 0, "Translate should not emit reasoning when effort=none");
        assert!(!content.trim().is_empty(), "Translate should return non-empty Chinese text");
    }
}
