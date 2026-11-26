use serde::{Deserialize, Serialize};
use std::fs;
use std::path::PathBuf;

pub const DEFAULT_BASE_URL: &str = "https://opencode.ai/inference/go/openai/v1";
pub const DEFAULT_MODEL: &str = "deepseek-v4.1-flash";
pub const DEFAULT_PROVIDER_ID: &str = "opencode-go";
pub const DEFAULT_QUICK_ASK_SHORTCUT: &str = "Alt+Space";

fn default_translate_effort() -> String {
    "none".to_string()
}

fn default_explain_effort() -> String {
    "low".to_string()
}

fn default_quick_ask_effort() -> String {
    "medium".to_string()
}

fn default_provider_id() -> String {
    DEFAULT_PROVIDER_ID.to_string()
}

fn default_provider_kind() -> String {
    "chat".to_string()
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProviderConfig {
    pub id: String,
    pub name: String,
    pub base_url: String,
    pub api_key: String,
    pub model: String,
    #[serde(default)]
    pub is_builtin: bool,
    /// `chat`（默认）：通用对话模型；`translate`：只做翻译的服务（如豆包翻译网关）。
    #[serde(default = "default_provider_kind")]
    pub kind: String,
}

impl ProviderConfig {
    pub fn is_translate_gateway(&self) -> bool {
        self.kind.eq_ignore_ascii_case("translate")
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AppSettings {
    pub api_key: String,
    pub base_url: String,
    pub model: String,
    #[serde(default)]
    pub providers: Vec<ProviderConfig>,
    #[serde(default = "default_provider_id")]
    pub active_provider_id: String,
    pub quick_ask_shortcut: String,
    pub selection_enabled: bool,
    pub auto_popup_on_select: bool,
    pub translate_target_lang: String,
    pub blacklist: Vec<String>,
    pub launch_at_login: bool,
    pub show_reasoning: bool,
    #[serde(default = "default_translate_effort")]
    pub translate_reasoning_effort: String,
    #[serde(default = "default_explain_effort")]
    pub explain_reasoning_effort: String,
    #[serde(default = "default_quick_ask_effort")]
    pub quick_ask_reasoning_effort: String,
}

impl AppSettings {
    /// 当前生效的供应商配置。
    pub fn active_provider(&self) -> Option<&ProviderConfig> {
        self.providers
            .iter()
            .find(|p| p.id == self.active_provider_id)
            .or_else(|| self.providers.first())
    }

    /// 当前供应商是否是「翻译网关」（只做翻译，不能解释/对话）。
    pub fn active_provider_is_translate_gateway(&self) -> bool {
        self.active_provider()
            .map(ProviderConfig::is_translate_gateway)
            .unwrap_or(false)
    }

    /// Ensures `providers` is populated and top-level `base_url` / `api_key` / `model`
    /// always mirror the currently active provider.
    pub fn normalize_providers(&mut self) {
        if self.providers.is_empty() {
            let api_key = if self.api_key.trim().is_empty() {
                read_opencode_go_api_key().unwrap_or_default()
            } else {
                self.api_key.clone()
            };
            let base_url = if self.base_url.trim().is_empty() {
                DEFAULT_BASE_URL.to_string()
            } else {
                self.base_url.clone()
            };
            let model = if self.model.trim().is_empty() {
                DEFAULT_MODEL.to_string()
            } else {
                self.model.clone()
            };
            let is_opencode = base_url.to_lowercase().contains("opencode.ai");
            self.providers.push(ProviderConfig {
                id: DEFAULT_PROVIDER_ID.to_string(),
                name: if is_opencode {
                    "OpenCode Go".to_string()
                } else {
                    "默认供应商".to_string()
                },
                base_url,
                api_key,
                model,
                is_builtin: is_opencode,
                kind: default_provider_kind(),
            });
            self.active_provider_id = DEFAULT_PROVIDER_ID.to_string();
        }

        if !self.providers.iter().any(|p| p.id == self.active_provider_id) {
            self.active_provider_id = self.providers[0].id.clone();
        }

        if let Some(active) = self.providers.iter().find(|p| p.id == self.active_provider_id) {
            self.base_url = active.base_url.trim().to_string();
            self.api_key = active.api_key.trim().to_string();
            self.model = active.model.trim().to_string();
        }
    }
}

impl Default for AppSettings {
    fn default() -> Self {
        let key = read_opencode_go_api_key().unwrap_or_default();
        let default_provider = ProviderConfig {
            id: DEFAULT_PROVIDER_ID.to_string(),
            name: "OpenCode Go".to_string(),
            base_url: DEFAULT_BASE_URL.to_string(),
            api_key: key.clone(),
            model: DEFAULT_MODEL.to_string(),
            is_builtin: true,
            kind: default_provider_kind(),
        };
        Self {
            api_key: key,
            base_url: DEFAULT_BASE_URL.to_string(),
            model: DEFAULT_MODEL.to_string(),
            providers: vec![default_provider],
            active_provider_id: DEFAULT_PROVIDER_ID.to_string(),
            quick_ask_shortcut: DEFAULT_QUICK_ASK_SHORTCUT.to_string(),
            selection_enabled: true,
            auto_popup_on_select: true,
            translate_target_lang: "zh-CN".to_string(),
            blacklist: default_blacklist(),
            launch_at_login: false,
            show_reasoning: false,
            translate_reasoning_effort: default_translate_effort(),
            explain_reasoning_effort: default_explain_effort(),
            quick_ask_reasoning_effort: default_quick_ask_effort(),
        }
    }
}

/// Predefined blacklist adapted from CherryStudio's selectionConfig.ts to avoid
/// triggering text selection in file managers, screenshot tools, CAD, and design apps.
pub fn default_blacklist() -> Vec<String> {
    #[cfg(target_os = "macos")]
    {
        vec![
            "com.apple.finder".to_string(),
            "com.adobe.photoshop".to_string(),
            "com.adobe.illustrator".to_string(),
            "com.figma.desktop".to_string(),
            "org.blenderfoundation.blender".to_string(),
        ]
    }
    #[cfg(target_os = "windows")]
    {
        vec![
            "explorer.exe".to_string(),
            "snipaste.exe".to_string(),
            "pixpin.exe".to_string(),
            "sharex.exe".to_string(),
            "snippingtool.exe".to_string(),
            "excel.exe".to_string(),
            "powerpnt.exe".to_string(),
            "photoshop.exe".to_string(),
            "illustrator.exe".to_string(),
            "blender.exe".to_string(),
            "mstsc.exe".to_string(),
        ]
    }
    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
    {
        vec![]
    }
}

pub fn settings_path() -> PathBuf {
    let base = dirs::config_dir().unwrap_or_else(|| PathBuf::from("."));
    base.join("LiteAsk").join("settings.json")
}

pub fn load_settings() -> AppSettings {
    let path = settings_path();
    if let Ok(raw) = fs::read_to_string(&path) {
        if let Ok(mut parsed) = serde_json::from_str::<AppSettings>(&raw) {
            parsed.normalize_providers();
            return parsed;
        }
    }
    let mut defaults = AppSettings::default();
    defaults.normalize_providers();
    let _ = save_settings(&defaults);
    defaults
}

pub fn save_settings(settings: &AppSettings) -> Result<(), String> {
    let path = settings_path();
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|e| format!("无法创建配置目录: {e}"))?;
    }
    let json = serde_json::to_string_pretty(settings).map_err(|e| format!("序列化配置失败: {e}"))?;
    fs::write(&path, json).map_err(|e| format!("写入配置文件失败: {e}"))
}

/// Reads the OpenCode Go API key from OpenCode's local auth.json if present.
/// Supports macOS/Linux (`~/.local/share/opencode/auth.json`) and Windows
/// (`%USERPROFILE%\.local\share\opencode\auth.json` or `%LOCALAPPDATA%\opencode\auth.json`).
pub fn read_opencode_go_api_key() -> Option<String> {
    let mut candidates: Vec<PathBuf> = Vec::new();

    if let Some(home) = dirs::home_dir() {
        candidates.push(home.join(".local").join("share").join("opencode").join("auth.json"));
    }
    if let Some(data_local) = dirs::data_local_dir() {
        candidates.push(data_local.join("opencode").join("auth.json"));
    }

    for path in candidates {
        if let Ok(content) = fs::read_to_string(&path) {
            if let Ok(val) = serde_json::from_str::<serde_json::Value>(&content) {
                for provider in ["opencode-go", "opencode"] {
                    if let Some(key) = val
                        .get(provider)
                        .and_then(|v| v.get("key"))
                        .and_then(|k| k.as_str())
                    {
                        let trimmed = key.trim();
                        if !trimmed.is_empty() {
                            return Some(trimmed.to_string());
                        }
                    }
                }
            }
        }
    }
    None
}
