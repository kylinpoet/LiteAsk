mod ai;
mod config;
mod selection;

use ai::{AiManager, ChatMessage, TranslateGatewayOptions};
use config::{load_settings, read_opencode_go_api_key, save_settings, AppSettings};
use parking_lot::Mutex;
use serde::Serialize;
use std::sync::atomic::{AtomicBool, Ordering};
use tauri::{
    menu::{Menu, MenuItem},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    AppHandle, Emitter, Manager, State, WindowEvent,
};
use tauri_plugin_autostart::ManagerExt as AutostartManagerExt;
use tauri_plugin_global_shortcut::{GlobalShortcutExt, ShortcutState};
use uuid::Uuid;

pub struct AppState {
    pub settings: Mutex<AppSettings>,
    pub ai: AiManager,
    pub action_pinned: AtomicBool,
    pub quick_ask_pinned: AtomicBool,
    pub current_shortcut: Mutex<String>,
    pub shortcut_recording: AtomicBool,
    pub action_session_id: Mutex<String>,
    pub quick_ask_session_id: Mutex<String>,
    pub tray_toggle_item: Mutex<Option<MenuItem<tauri::Wry>>>,
}

fn tray_selection_label(enabled: bool) -> &'static str {
    if enabled {
        "✓ 划词悬浮条：已开启（点击关闭）"
    } else {
        "○ 划词悬浮条：已关闭（点击开启）"
    }
}

fn sync_tray_selection_label(state: &AppState, enabled: bool) {
    if let Some(item) = state.tray_toggle_item.lock().as_ref() {
        let _ = item.set_text(tray_selection_label(enabled));
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct ActionOpenPayload {
    action: String,
    text: String,
    target_lang: String,
    reasoning_effort: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct QuickAskSeedPayload {
    text: String,
}

#[tauri::command]
fn get_platform() -> &'static str {
    std::env::consts::OS
}

#[tauri::command]
fn get_settings(state: State<'_, AppState>) -> AppSettings {
    state.settings.lock().clone()
}

#[tauri::command]
fn import_opencode_key() -> Result<String, String> {
    read_opencode_go_api_key().ok_or_else(|| {
        "未在本机找到 OpenCode Go 凭证（~/.local/share/opencode/auth.json），请手动粘贴 API Key。"
            .to_string()
    })
}

#[tauri::command]
fn save_app_settings(
    app: AppHandle,
    state: State<'_, AppState>,
    mut new_settings: AppSettings,
) -> Result<AppSettings, String> {
    new_settings.normalize_providers();
    let old_shortcut = state.current_shortcut.lock().clone();
    let was_paused = state.shortcut_recording.swap(false, Ordering::SeqCst);
    if new_settings.quick_ask_shortcut != old_shortcut || was_paused {
        reregister_shortcut(&app, &old_shortcut, &new_settings.quick_ask_shortcut)?;
        *state.current_shortcut.lock() = new_settings.quick_ask_shortcut.clone();
    }

    // Sync autostart preference (best effort; may fail in dev mode)
    let autostart = app.autolaunch();
    if new_settings.launch_at_login {
        let _ = autostart.enable();
    } else {
        let _ = autostart.disable();
    }

    selection::set_enabled(
        new_settings.selection_enabled,
        new_settings.auto_popup_on_select,
    );
    selection::update_blacklist(new_settings.blacklist.clone());
    sync_tray_selection_label(&state, new_settings.selection_enabled);

    save_settings(&new_settings)?;
    *state.settings.lock() = new_settings.clone();

    let _ = app.emit("settings:updated", &new_settings);
    Ok(new_settings)
}

#[tauri::command]
fn set_shortcut_recording(app: AppHandle, state: State<'_, AppState>, recording: bool) {
    let shortcut = state.current_shortcut.lock().clone();
    if recording {
        if !state.shortcut_recording.swap(true, Ordering::SeqCst) && !shortcut.trim().is_empty() {
            let _ = app.global_shortcut().unregister(shortcut.as_str());
        }
    } else if state.shortcut_recording.swap(false, Ordering::SeqCst) && !shortcut.trim().is_empty() {
        let _ = register_shortcut(&app, &shortcut);
    }
}

#[tauri::command]
fn update_quick_ask_shortcut(
    app: AppHandle,
    state: State<'_, AppState>,
    shortcut: String,
) -> Result<AppSettings, String> {
    let trimmed = shortcut.trim().to_string();
    if trimmed.is_empty() {
        return Err("快捷键不能为空".to_string());
    }

    let old_shortcut = state.current_shortcut.lock().clone();
    state.shortcut_recording.store(false, Ordering::SeqCst);

    if let Err(err) = reregister_shortcut(&app, &old_shortcut, &trimmed) {
        return Err(err);
    }

    *state.current_shortcut.lock() = trimmed.clone();
    let mut s = state.settings.lock().clone();
    s.quick_ask_shortcut = trimmed;
    save_settings(&s)?;
    *state.settings.lock() = s.clone();

    let _ = app.emit("settings:updated", &s);
    Ok(s)
}

#[tauri::command]
fn set_selection_enabled(
    app: AppHandle,
    state: State<'_, AppState>,
    enabled: bool,
) -> Result<AppSettings, String> {
    let mut s = state.settings.lock().clone();
    s.selection_enabled = enabled;
    s.auto_popup_on_select = enabled;
    selection::set_enabled(enabled, enabled);
    sync_tray_selection_label(&state, enabled);
    save_settings(&s)?;
    *state.settings.lock() = s.clone();
    let _ = app.emit("settings:updated", &s);
    Ok(s)
}

#[tauri::command]
async fn fetch_available_models(
    state: State<'_, AppState>,
    base_url: String,
    api_key: String,
) -> Result<Vec<String>, String> {
    state.ai.fetch_models(&base_url, &api_key).await
}

#[tauri::command]
async fn test_ai_connection(
    state: State<'_, AppState>,
    settings: AppSettings,
) -> Result<String, String> {
    state.ai.test_connection(&settings).await
}

#[tauri::command]
fn check_accessibility(prompt: bool) -> bool {
    let trusted = selection::check_accessibility(prompt);
    if trusted {
        let _ = selection::ensure_monitor_started();
    }
    trusted
}

#[cfg(target_os = "macos")]
static AX_POLLING: AtomicBool = AtomicBool::new(false);

#[cfg(target_os = "macos")]
fn spawn_accessibility_poller(app: AppHandle) {
    if AX_POLLING.swap(true, Ordering::SeqCst) {
        return;
    }
    tauri::async_runtime::spawn(async move {
        loop {
            tokio::time::sleep(std::time::Duration::from_secs(2)).await;
            if selection::check_accessibility(false) && selection::ensure_monitor_started() {
                AX_POLLING.store(false, Ordering::SeqCst);
                let _ = app.emit("accessibility:granted", true);
                break;
            }
        }
    });
}

#[tauri::command]
fn open_accessibility_settings(app: AppHandle) {
    selection::open_accessibility_settings();
    #[cfg(target_os = "macos")]
    if !selection::check_accessibility(false) {
        spawn_accessibility_poller(app);
    }
    #[cfg(not(target_os = "macos"))]
    let _ = app;
}

#[tauri::command]
fn reset_accessibility_permission(app: AppHandle) -> Result<(), String> {
    selection::reset_accessibility_permission()?;
    #[cfg(target_os = "macos")]
    spawn_accessibility_poller(app);
    #[cfg(not(target_os = "macos"))]
    let _ = app;
    Ok(())
}

#[tauri::command]
fn set_action_pinned(app: AppHandle, state: State<'_, AppState>, pinned: bool) {
    state.action_pinned.store(pinned, Ordering::SeqCst);
    if let Some(win) = app.get_webview_window("action") {
        let _ = win.set_always_on_top(pinned);
    }
}

#[tauri::command]
fn set_quick_ask_pinned(app: AppHandle, state: State<'_, AppState>, pinned: bool) {
    state.quick_ask_pinned.store(pinned, Ordering::SeqCst);
    if let Some(win) = app.get_webview_window("quick-ask") {
        let _ = win.set_always_on_top(pinned);
    }
}

#[tauri::command]
fn hide_window(app: AppHandle, label: String) {
    if label == "toolbar" {
        selection::hide_toolbar(&app);
        return;
    }
    if let Some(win) = app.get_webview_window(&label) {
        let _ = win.hide();
    }
}

#[tauri::command]
fn open_settings(app: AppHandle) {
    show_settings_window(&app);
}

#[tauri::command]
fn toggle_quick_ask_cmd(app: AppHandle) {
    toggle_quick_ask_window(&app, None);
}

/// Called from the floating selection toolbar when user clicks 翻译 / 解释 / 问 AI
#[tauri::command]
fn trigger_selection_action(
    app: AppHandle,
    state: State<'_, AppState>,
    action: String,
    text: String,
) -> Result<(), String> {
    selection::hide_toolbar(&app);

    if action == "ask" {
        toggle_quick_ask_window(&app, Some(text));
        return Ok(());
    }

    let settings = state.settings.lock().clone();
    let target_lang = settings.translate_target_lang.clone();
    let reasoning_effort = if action == "translate" {
        settings.translate_reasoning_effort.clone()
    } else {
        settings.explain_reasoning_effort.clone()
    };

    if let Some(action_win) = app.get_webview_window("action") {
        selection::position_action_window_near_last_selection(&action_win);
        selection::activate_and_focus_window(&action_win, true);
    }

    // ActionWindow receives `action:open`, initializes UI with its own request_id,
    // and then invokes `run_selection_ai` — avoiding any cross-window event race.
    let _ = app.emit_to(
        "action",
        "action:open",
        ActionOpenPayload {
            action,
            text,
            target_lang,
            reasoning_effort,
        },
    );

    Ok(())
}

/// LiteAsk 的目标语言 → 翻译网关的语言码。
/// 「智能中英」(zh-CN) 返回 None，交给网关按「中文→英文、非中文→中文」自动判断。
fn gateway_target_lang(target_lang: &str) -> Option<String> {
    match target_lang.trim().to_ascii_lowercase().as_str() {
        "" | "zh" | "zh-cn" | "auto" | "smart" => None,
        "en" | "en-us" | "en-gb" | "english" => Some("en".to_string()),
        "ja" | "jp" | "japanese" => Some("ja".to_string()),
        other => Some(other.to_string()),
    }
}

/// Run or re-run translate/explain or send follow-up question in the Action window
#[tauri::command]
fn run_selection_ai(
    app: AppHandle,
    state: State<'_, AppState>,
    request_id: String,
    action: String,
    text: String,
    target_lang: String,
    reasoning_effort: Option<String>,
    follow_ups: Vec<ChatMessage>,
) -> Result<String, String> {
    let settings = state.settings.lock().clone();
    let is_gateway = settings.active_provider_is_translate_gateway();

    if is_gateway {
        if action != "translate" {
            return Err(
                "当前供应商是「翻译网关」（只做翻译，无法解释或对话）。请在「设置 → 模型供应商」里切换到一个对话模型后再试。"
                    .to_string(),
            );
        }
        if !follow_ups.is_empty() {
            return Err(
                "翻译网关不支持继续追问，请在「设置 → 模型供应商」里切换到对话模型后再追问。"
                    .to_string(),
            );
        }
    }

    let req_id = if request_id.trim().is_empty() {
        Uuid::new_v4().to_string()
    } else {
        request_id
    };
    let effort = reasoning_effort.unwrap_or_else(|| {
        if action == "translate" {
            settings.translate_reasoning_effort.clone()
        } else {
            settings.explain_reasoning_effort.clone()
        }
    });

    // 翻译网关不认识 system 提示，也不该收到历史（它会把每条非 system 消息都当原文翻译）。
    let (messages, translate_gateway) = if is_gateway {
        (
            vec![ChatMessage {
                role: "user".to_string(),
                content: text.clone(),
            }],
            Some(TranslateGatewayOptions {
                target_lang: gateway_target_lang(&target_lang),
                scene: 3,
            }),
        )
    } else {
        (
            AiManager::build_selection_messages(&action, &text, &target_lang, &follow_ups),
            None,
        )
    };

    let session_id = {
        let mut guard = state.action_session_id.lock();
        if follow_ups.is_empty() || guard.is_empty() {
            *guard = format!("ses_liteask_act_{}", Uuid::new_v4());
        }
        guard.clone()
    };

    state.ai.start_stream(
        app,
        "action".to_string(),
        req_id.clone(),
        session_id,
        settings,
        messages,
        effort,
        translate_gateway,
    );
    Ok(req_id)
}

/// Stream a multi-turn chat in the Quick Ask popup
#[tauri::command]
fn run_quick_ask_ai(
    app: AppHandle,
    state: State<'_, AppState>,
    request_id: String,
    messages: Vec<ChatMessage>,
    reasoning_effort: Option<String>,
) -> Result<String, String> {
    let settings = state.settings.lock().clone();
    if settings.active_provider_is_translate_gateway() {
        return Err(
            "当前供应商是「翻译网关」（只做翻译），弹窗助手需要对话模型。请在「设置 → 模型供应商」里切换供应商。"
                .to_string(),
        );
    }
    let req_id = if request_id.trim().is_empty() {
        Uuid::new_v4().to_string()
    } else {
        request_id
    };
    let effort = reasoning_effort.unwrap_or_else(|| settings.quick_ask_reasoning_effort.clone());

    let session_id = {
        let mut guard = state.quick_ask_session_id.lock();
        if messages.len() <= 1 || guard.is_empty() {
            *guard = format!("ses_liteask_ask_{}", Uuid::new_v4());
        }
        guard.clone()
    };

    let mut full_messages = Vec::with_capacity(messages.len() + 1);
    full_messages.push(ChatMessage {
        role: "system".to_string(),
        content: "你是 LiteAsk 桌面弹窗助手。请用清晰、准确、高效的中文（或用户提问所用语言）直接回答问题，善用简洁的 Markdown 列表和代码块。".to_string(),
    });
    full_messages.extend(messages);

    state.ai.start_stream(
        app,
        "quick-ask".to_string(),
        req_id.clone(),
        session_id,
        settings,
        full_messages,
        effort,
        None,
    );

    Ok(req_id)
}

#[tauri::command]
fn cancel_ai(state: State<'_, AppState>, request_id: String) {
    state.ai.cancel(&request_id);
}

fn show_settings_window(app: &AppHandle) {
    if let Some(win) = app.get_webview_window("settings") {
        let _ = win.unminimize();
        selection::activate_and_focus_window(&win, false);
    }
}

fn toggle_quick_ask_window(app: &AppHandle, seed_text: Option<String>) {
    let Some(win) = app.get_webview_window("quick-ask") else {
        return;
    };

    let visible = win.is_visible().unwrap_or(false);
    let focused = win.is_focused().unwrap_or(false);

    if seed_text.is_none() && visible && focused {
        let _ = win.hide();
        return;
    }

    if !visible {
        let _ = win.center();
    }
    selection::activate_and_focus_window(&win, true);

    if let Some(text) = seed_text {
        let _ = app.emit_to("quick-ask", "quick-ask:seed", QuickAskSeedPayload { text });
    } else {
        let _ = app.emit_to("quick-ask", "quick-ask:focus", ());
    }
}

fn register_shortcut(app: &AppHandle, shortcut: &str) -> Result<(), String> {
    if shortcut.trim().is_empty() {
        return Ok(());
    }
    let handle = app.clone();
    app.global_shortcut()
        .on_shortcut(shortcut, move |_app, _shortcut, event| {
            if event.state == ShortcutState::Pressed {
                toggle_quick_ask_window(&handle, None);
            }
        })
        .map_err(|e| format!("注册全局快捷键「{shortcut}」失败: {e}"))
}

fn reregister_shortcut(app: &AppHandle, old: &str, new: &str) -> Result<(), String> {
    if !old.trim().is_empty() {
        let _ = app.global_shortcut().unregister(old);
    }
    if let Err(err) = register_shortcut(app, new) {
        // Attempt rollback to old shortcut
        if !old.trim().is_empty() {
            let _ = register_shortcut(app, old);
        }
        return Err(err);
    }
    Ok(())
}

fn setup_tray(app: &AppHandle, initial_selection_enabled: bool) -> tauri::Result<()> {
    let ask_item = MenuItem::with_id(app, "tray_quick_ask", "打开弹窗助手 (Quick Ask)", true, None::<&str>)?;
    let toggle_sel_item = MenuItem::with_id(
        app,
        "tray_toggle_selection",
        tray_selection_label(initial_selection_enabled),
        true,
        None::<&str>,
    )?;
    let settings_item = MenuItem::with_id(app, "tray_settings", "偏好设置...", true, None::<&str>)?;
    let update_item = MenuItem::with_id(app, "tray_check_update", "检查更新...", true, None::<&str>)?;
    let quit_item = MenuItem::with_id(app, "tray_quit", "退出 LiteAsk", true, None::<&str>)?;

    *app.state::<AppState>().tray_toggle_item.lock() = Some(toggle_sel_item.clone());

    let menu = Menu::with_items(
        app,
        &[&ask_item, &toggle_sel_item, &settings_item, &update_item, &quit_item],
    )?;

    let mut builder = TrayIconBuilder::with_id("main-tray")
        .menu(&menu)
        .tooltip("LiteAsk — 轻量划词与桌面 AI 助手")
        .show_menu_on_left_click(false)
        .on_menu_event(|app, event| match event.id.as_ref() {
            "tray_quick_ask" => toggle_quick_ask_window(app, None),
            "tray_toggle_selection" => {
                let state = app.state::<AppState>();
                let mut s = state.settings.lock().clone();
                s.selection_enabled = !s.selection_enabled;
                s.auto_popup_on_select = s.selection_enabled;
                selection::set_enabled(s.selection_enabled, s.auto_popup_on_select);
                sync_tray_selection_label(&state, s.selection_enabled);
                let _ = save_settings(&s);
                *state.settings.lock() = s.clone();
                let _ = app.emit("settings:updated", &s);
            }
            "tray_settings" => show_settings_window(app),
            "tray_check_update" => {
                show_settings_window(app);
                let _ = app.emit_to("settings", "updater:check", ());
            }
            "tray_quit" => app.exit(0),
            _ => {}
        })
        .on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::Click {
                button: MouseButton::Left,
                button_state: MouseButtonState::Up,
                ..
            } = event
            {
                toggle_quick_ask_window(tray.app_handle(), None);
            }
        });

    if let Some(icon) = app.default_window_icon().cloned() {
        builder = builder.icon(icon);
    }

    builder.build(app)?;
    Ok(())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let initial_settings = load_settings();
    let initial_shortcut = initial_settings.quick_ask_shortcut.clone();

    tauri::Builder::default()
        .plugin(tauri_plugin_global_shortcut::Builder::new().build())
        .plugin(tauri_plugin_autostart::init(
            tauri_plugin_autostart::MacosLauncher::LaunchAgent,
            None,
        ))
        .plugin(tauri_plugin_clipboard_manager::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .manage(AppState {
            settings: Mutex::new(initial_settings.clone()),
            ai: AiManager::new(),
            action_pinned: AtomicBool::new(false),
            quick_ask_pinned: AtomicBool::new(false),
            current_shortcut: Mutex::new(initial_shortcut.clone()),
            shortcut_recording: AtomicBool::new(false),
            action_session_id: Mutex::new(format!("ses_liteask_act_{}", Uuid::new_v4())),
            quick_ask_session_id: Mutex::new(format!("ses_liteask_ask_{}", Uuid::new_v4())),
            tray_toggle_item: Mutex::new(None),
        })
        .setup(move |app| {
            let handle = app.handle().clone();

            // Hide Dock icon on macOS so LiteAsk lives cleanly in the menu bar
            #[cfg(target_os = "macos")]
            {
                let _ = app.set_activation_policy(tauri::ActivationPolicy::Accessory);
            }

            // Configure native floating panel behaviors
            if let Some(toolbar) = app.get_webview_window("toolbar") {
                selection::configure_floating_window(&toolbar, true);
            }
            if let Some(action) = app.get_webview_window("action") {
                selection::configure_floating_window(&action, false);
                let h = handle.clone();
                action.on_window_event(move |event| match event {
                    WindowEvent::Focused(false) => {
                        let state = h.state::<AppState>();
                        if !state.action_pinned.load(Ordering::Relaxed) {
                            if let Some(w) = h.get_webview_window("action") {
                                let _ = w.hide();
                            }
                        }
                    }
                    WindowEvent::CloseRequested { api, .. } => {
                        api.prevent_close();
                        if let Some(w) = h.get_webview_window("action") {
                            let _ = w.hide();
                        }
                    }
                    _ => {}
                });
            }
            if let Some(quick_ask) = app.get_webview_window("quick-ask") {
                selection::configure_floating_window(&quick_ask, false);
                let h = handle.clone();
                quick_ask.on_window_event(move |event| match event {
                    WindowEvent::Focused(false) => {
                        let state = h.state::<AppState>();
                        if !state.quick_ask_pinned.load(Ordering::Relaxed) {
                            if let Some(w) = h.get_webview_window("quick-ask") {
                                let _ = w.hide();
                            }
                        }
                    }
                    WindowEvent::CloseRequested { api, .. } => {
                        api.prevent_close();
                        if let Some(w) = h.get_webview_window("quick-ask") {
                            let _ = w.hide();
                        }
                    }
                    _ => {}
                });
            }
            if let Some(settings_win) = app.get_webview_window("settings") {
                let h = handle.clone();
                settings_win.on_window_event(move |event| {
                    if let WindowEvent::CloseRequested { api, .. } = event {
                        api.prevent_close();
                        let state = h.state::<AppState>();
                        if state.shortcut_recording.swap(false, Ordering::SeqCst) {
                            let shortcut = state.current_shortcut.lock().clone();
                            if !shortcut.trim().is_empty() {
                                let _ = register_shortcut(&h, &shortcut);
                            }
                        }
                        if let Some(w) = h.get_webview_window("settings") {
                            let _ = w.hide();
                        }
                    }
                });
            }

            setup_tray(&handle, initial_settings.selection_enabled)?;

            // Register global shortcut for Quick Ask
            if let Err(err) = register_shortcut(&handle, &initial_shortcut) {
                eprintln!("[LiteAsk] {err}");
            }

            // Initialize cross-platform selection monitor
            let monitor_ok = selection::init(
                handle.clone(),
                initial_settings.selection_enabled,
                initial_settings.auto_popup_on_select,
                initial_settings.blacklist.clone(),
            );

            // Install native macOS AppleEvent reopen handler (`rapp`/`oapp`) so reopening
            // LiteAsk from Finder/Spotlight/Applications works even with LSUIElement=true.
            selection::install_reopen_handler(show_settings_window);

            // On macOS, if Accessibility isn't granted yet, open Settings to guide user
            // and poll in background so the hook activates immediately once granted.
            #[cfg(target_os = "macos")]
            if !monitor_ok {
                show_settings_window(&handle);
                spawn_accessibility_poller(handle.clone());
            }

            #[cfg(not(target_os = "macos"))]
            let _ = monitor_ok;

            // If API key is empty on first launch, open Settings so user can configure/import it
            if initial_settings.api_key.trim().is_empty() {
                show_settings_window(&handle);
            }

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            get_platform,
            get_settings,
            save_app_settings,
            set_shortcut_recording,
            update_quick_ask_shortcut,
            set_selection_enabled,
            fetch_available_models,
            import_opencode_key,
            test_ai_connection,
            check_accessibility,
            open_accessibility_settings,
            reset_accessibility_permission,
            set_action_pinned,
            set_quick_ask_pinned,
            hide_window,
            open_settings,
            toggle_quick_ask_cmd,
            trigger_selection_action,
            run_selection_ai,
            run_quick_ask_ai,
            cancel_ai,
        ])
        .build(tauri::generate_context!())
        .expect("error while building LiteAsk")
        .run(|app_handle, event| {
            #[cfg(target_os = "macos")]
            if let tauri::RunEvent::Reopen { .. } = event {
                show_settings_window(app_handle);
            }
            #[cfg(not(target_os = "macos"))]
            let _ = (app_handle, event);
        });
}
