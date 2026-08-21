// 持有托盘 mini 菜单项,切换模式后用于同步菜单文案
struct MiniMenuState(tauri::menu::MenuItem<tauri::Wry>);

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    use serde::{Deserialize, Serialize};
    use std::{
        fs,
        io::Read,
        os::windows::fs::OpenOptionsExt,
        path::{Path, PathBuf},
        process::Command,
        sync::{
            atomic::{AtomicBool, Ordering},
            Arc,
        },
        thread,
        time::Duration,
    };
    use tauri::{
        menu::{Menu, MenuItem},
        tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
        webview::PageLoadEvent,
        Emitter, Manager, PhysicalPosition, Position, WebviewWindow,
    };
    use windows::Win32::Foundation::HWND;
    use windows::Win32::UI::WindowsAndMessaging::{
        SetWindowPos, SWP_NOACTIVATE, SWP_NOMOVE, SWP_NOSIZE,
    };

    #[derive(Debug, Deserialize, Serialize)]
    #[serde(default)]
    struct StoredConfig {
        api_key: Option<String>,
        usage_token: Option<String>,
        refresh_interval_seconds: u64,
        auto_refresh_enabled: bool,
        autostart: bool,
        // 显示设置:老 config.json 缺失这些字段时走 Default,保证向后兼容
        window_opacity: f64,
        always_on_top: bool,
        show_balance_card: bool,
        // 模型显示:空列表 = 全部显示。由模型列表接口动态驱动,不写死 flash/pro。
        visible_models: Vec<String>,
        show_chart: bool,
        window_width: u32,
        window_height: u32,
        // 记忆上次窗口位置;None = 尚未定位,回退贴托盘
        window_x: Option<i32>,
        window_y: Option<i32>,
        // mini 模式:主面板仅显示余额/消费/模型用量文本
        mini_mode: bool,
        // mini 模式独立记忆位置/尺寸,与普通模式互不覆盖
        mini_width: u32,
        mini_height: u32,
        mini_x: Option<i32>,
        mini_y: Option<i32>,
    }

    impl Default for StoredConfig {
        fn default() -> Self {
            StoredConfig {
                api_key: None,
                usage_token: None,
                refresh_interval_seconds: 60,
                auto_refresh_enabled: false,
                autostart: false,
                window_opacity: 1.0,
                always_on_top: false,
                show_balance_card: true,
                visible_models: Vec::new(),
                show_chart: true,
                window_width: 356,
                window_height: 600,
                window_x: None,
                window_y: None,
                mini_mode: false,
                mini_width: 300,
                mini_height: 70,
                mini_x: None,
                mini_y: None,
            }
        }
    }

    #[derive(Debug, Serialize)]
    #[serde(rename_all = "camelCase")]
    struct AppConfig {
        api_key_configured: bool,
        api_key_preview: Option<String>,
        usage_token_configured: bool,
        refresh_interval_seconds: u64,
        auto_refresh_enabled: bool,
        autostart: bool,
        window_opacity: f64,
        always_on_top: bool,
        show_balance_card: bool,
        visible_models: Vec<String>,
        show_chart: bool,
        window_width: u32,
        window_height: u32,
        mini_mode: bool,
        config_path: String,
    }

    fn config_path() -> Result<PathBuf, String> {
        let appdata = std::env::var_os("APPDATA").ok_or("APPDATA is not available")?;
        Ok(PathBuf::from(appdata)
            .join("DeepSeekMonitorWindows")
            .join("config.json"))
    }

    fn read_stored_config() -> Result<StoredConfig, String> {
        let path = config_path()?;
        if !path.exists() {
            return Ok(StoredConfig::default());
        }

        let text = fs::read_to_string(&path).map_err(|error| error.to_string())?;
        let mut config: StoredConfig =
            serde_json::from_str(&text).map_err(|error| error.to_string())?;
        config.refresh_interval_seconds =
            normalize_refresh_interval_seconds(config.refresh_interval_seconds);
        Ok(config)
    }

    fn normalize_refresh_interval_seconds(value: u64) -> u64 {
        match value {
            60 | 300 | 1800 | 3600 => value,
            _ => 60,
        }
    }

    fn write_stored_config(config: &StoredConfig) -> Result<(), String> {
        let path = config_path()?;
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent).map_err(|error| error.to_string())?;
        }

        let text = serde_json::to_string_pretty(config).map_err(|error| error.to_string())?;
        fs::write(path, text).map_err(|error| error.to_string())
    }

    fn api_key_preview(api_key: &str) -> String {
        let chars: Vec<char> = api_key.chars().collect();
        if chars.len() <= 12 {
            return "已保存".to_string();
        }

        let start: String = chars.iter().take(7).collect();
        let end: String = chars
            .iter()
            .rev()
            .take(4)
            .collect::<Vec<_>>()
            .into_iter()
            .rev()
            .collect();
        format!("{start}...{end}")
    }

    fn to_app_config(config: StoredConfig) -> Result<AppConfig, String> {
        let path = config_path()?;
        let api_key_preview = config
            .api_key
            .as_ref()
            .filter(|value| !value.is_empty())
            .map(|value| api_key_preview(value));

        let usage_token_configured = config
            .usage_token
            .as_ref()
            .map(|value| !value.is_empty())
            .unwrap_or(false);

        Ok(AppConfig {
            api_key_configured: api_key_preview.is_some(),
            api_key_preview,
            usage_token_configured,
            refresh_interval_seconds: config.refresh_interval_seconds,
            auto_refresh_enabled: config.auto_refresh_enabled,
            autostart: config.autostart,
            window_opacity: config.window_opacity,
            always_on_top: config.always_on_top,
            show_balance_card: config.show_balance_card,
            visible_models: config.visible_models,
            show_chart: config.show_chart,
            window_width: config.window_width,
            window_height: config.window_height,
            mini_mode: config.mini_mode,
            config_path: path.to_string_lossy().to_string(),
        })
    }

    fn position_near_tray(window: &WebviewWindow) -> tauri::Result<()> {
        let cursor = window.cursor_position()?;
        let monitor = window
            .monitor_from_point(cursor.x, cursor.y)?
            .or(window.current_monitor()?)
            .or(window.primary_monitor()?)
            .ok_or_else(|| tauri::Error::WindowNotFound)?;

        let work_area = monitor.work_area();
        let scale_factor = monitor.scale_factor();
        let size = window.outer_size()?;
        let margin = (12.0 * scale_factor).round() as i32;
        let width = size.width as i32;
        let height = size.height as i32;
        let right = work_area.position.x + work_area.size.width as i32;
        let bottom = work_area.position.y + work_area.size.height as i32;
        let x = right - width - margin;
        let y = bottom - height - margin;

        window.set_position(Position::Physical(PhysicalPosition::new(
            x.max(work_area.position.x),
            y.max(work_area.position.y),
        )))
    }

    // 校验保存的位置是否仍在任一显示器工作区附近。
    // Windows 在显示器拔出、远程桌面切换或无效拖拽后可能返回 -32000 等离屏坐标。
    fn is_window_position_visible(window: &WebviewWindow, x: i32, y: i32) -> bool {
        let Ok(monitors) = window.available_monitors() else {
            return false;
        };
        let Ok(size) = window.outer_size() else {
            return false;
        };
        let width = size.width as i32;
        let height = size.height as i32;
        monitors.into_iter().any(|monitor| {
            let area = monitor.work_area();
            let left = area.position.x;
            let top = area.position.y;
            let right = left + area.size.width as i32;
            let bottom = top + area.size.height as i32;
            // 只要窗口与工作区有至少 24px 的交集，就视为可恢复位置。
            x < right - 24 && x + width > left + 24 && y < bottom - 24 && y + height > top + 24
        })
    }

    // 恢复保存位置;位置失效时回退到托盘附近,避免窗口落到 -32000 等屏幕外坐标。
    fn restore_window_position(window: &WebviewWindow, position: (Option<i32>, Option<i32>)) {
        if let (Some(x), Some(y)) = position {
            if is_window_position_visible(window, x, y) {
                let _ = window.set_position(Position::Physical(PhysicalPosition::new(x, y)));
                return;
            }
        }
        let _ = position_near_tray(window);
    }

    // 强制置顶:直接调 Win32 SetWindowPos(HWND_TOPMOST/NOTOPMOST)。
    // tao 的 set_always_on_top 依赖内部标志位 diff,重复设同值不会触发 SetWindowPos,
    // 导致启动时置顶不落位(表现为必须先关再开才生效)。
    fn force_always_on_top(window: &WebviewWindow, on_top: bool) {
        let Ok(hwnd) = window.hwnd() else { return };
        let insert_after = if on_top {
            HWND(-1isize as *mut core::ffi::c_void) // HWND_TOPMOST
        } else {
            HWND(-2isize as *mut core::ffi::c_void) // HWND_NOTOPMOST
        };
        unsafe {
            let _ = SetWindowPos(
                hwnd,
                Some(insert_after),
                0,
                0,
                0,
                0,
                SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE,
            );
        }
    }

    // 同步 tao 内部标志 + 强制 OS 落位,双保险
    fn apply_always_on_top(window: &WebviewWindow, on_top: bool) {
        let _ = window.set_always_on_top(on_top);
        force_always_on_top(window, on_top);
    }

    fn show_main_window(window: &WebviewWindow) {
        let config = read_stored_config().unwrap_or_default();
        // 恢复当前模式上次位置;无记录时首次贴托盘
        let (px, py) = if config.mini_mode {
            (config.mini_x, config.mini_y)
        } else {
            (config.window_x, config.window_y)
        };
        restore_window_position(window, (px, py));
        let _ = window.show();
        // Windows 在窗口隐藏/重新显示后可能丢失 WS_EX_TOPMOST,每次显示强制重新断言置顶
        apply_always_on_top(window, config.always_on_top);
        let _ = window.set_focus();
    }

    // 独立的设置窗口:透明无边框小窗,与主面板分离。
    // 前端按窗口 label 决定渲染设置页,设置改动通过事件实时同步到主窗口。
    fn open_settings_window(app: &tauri::AppHandle) -> Result<(), String> {
        if app.get_webview_window("settings").is_none() {
            let url = tauri::WebviewUrl::App("index.html".into());
            tauri::WebviewWindowBuilder::new(app, "settings", url)
                .title("DeepSeek Monitor 设置")
                .inner_size(480.0, 700.0)
                .min_inner_size(400.0, 520.0)
                .resizable(true)
                .decorations(false)
                .transparent(true)
                .shadow(false)
                .skip_taskbar(true)
                .center()
                .build()
                .map_err(|error| error.to_string())?;
        }
        if let Some(window) = app.get_webview_window("settings") {
            let _ = window.show();
            let _ = window.set_focus();
        }
        Ok(())
    }

    #[tauri::command]
    fn hide_main_window(window: WebviewWindow) -> Result<(), String> {
        window.hide().map_err(|error| error.to_string())
    }

    #[tauri::command]
    fn get_app_config() -> Result<AppConfig, String> {
        to_app_config(read_stored_config()?)
    }

    #[tauri::command]
    fn save_api_key(api_key: String) -> Result<AppConfig, String> {
        let value = api_key.trim().to_string();
        if value.is_empty() {
            return Err("API Key 不能为空".to_string());
        }

        let mut config = read_stored_config()?;
        config.api_key = Some(value);
        write_stored_config(&config)?;
        to_app_config(config)
    }

    #[tauri::command]
    fn clear_api_key() -> Result<AppConfig, String> {
        let mut config = read_stored_config()?;
        config.api_key = None;
        write_stored_config(&config)?;
        to_app_config(config)
    }

    #[tauri::command]
    fn save_refresh_interval(refresh_interval_seconds: u64) -> Result<AppConfig, String> {
        let mut config = read_stored_config()?;
        config.refresh_interval_seconds =
            normalize_refresh_interval_seconds(refresh_interval_seconds);
        write_stored_config(&config)?;
        to_app_config(config)
    }

    #[tauri::command]
    fn save_auto_refresh_enabled(auto_refresh_enabled: bool) -> Result<AppConfig, String> {
        let mut config = read_stored_config()?;
        config.auto_refresh_enabled = auto_refresh_enabled;
        write_stored_config(&config)?;
        to_app_config(config)
    }

    fn apply_autostart(enabled: bool) -> Result<(), String> {
        let run_key = r"HKCU\Software\Microsoft\Windows\CurrentVersion\Run";
        let value_name = "DeepSeekMonitorWindows";

        if enabled {
            let exe = std::env::current_exe().map_err(|error| error.to_string())?;
            let exe_arg = exe.to_string_lossy().to_string();
            let status = Command::new("reg")
                .args(["add", run_key, "/v", value_name, "/t", "REG_SZ", "/d"])
                .arg(exe_arg)
                .args(["/f"])
                .status()
                .map_err(|error| format!("写入开机自启失败：{error}"))?;
            if !status.success() {
                return Err("写入开机自启失败".to_string());
            }
            return Ok(());
        }

        let status = Command::new("reg")
            .args(["delete", run_key, "/v", value_name, "/f"])
            .status()
            .map_err(|error| format!("关闭开机自启失败：{error}"))?;
        if !status.success() {
            return Ok(());
        }
        Ok(())
    }

    #[tauri::command]
    fn save_autostart(autostart: bool) -> Result<AppConfig, String> {
        apply_autostart(autostart)?;
        let mut config = read_stored_config()?;
        config.autostart = autostart;
        write_stored_config(&config)?;
        to_app_config(config)
    }

    // 保存整窗透明度与置顶。透明度 clamp 到 0.3–1.0,避免滑到 0 时窗口完全不可见。
    // Tauri 2.11 无 set_opacity API,透明度由前端在 documentElement 上以 CSS opacity
    // 应用(窗口已 transparent,内容 alpha 降低后桌面自然透出);这里只负责持久化与置顶。
    // 该命令可能由设置窗口发起,故置顶必须显式作用于主窗口,并用事件通知主窗口实时刷新。
    #[tauri::command]
    fn save_display_settings(
        app: tauri::AppHandle,
        opacity: f64,
        always_on_top: bool,
    ) -> Result<AppConfig, String> {
        let opacity = opacity.clamp(0.3, 1.0);
        let mut config = read_stored_config()?;
        config.window_opacity = opacity;
        config.always_on_top = always_on_top;
        write_stored_config(&config)?;
        if let Some(main) = app.get_webview_window("main") {
            apply_always_on_top(&main, always_on_top);
        }
        let app_config = to_app_config(config)?;
        let _ = app.emit("display-config-changed", &app_config);
        Ok(app_config)
    }

    // 主面板区块显示开关:余额卡 / 可见模型列表 / 缓存图表。
    // visible_models 为空 = 显示全部模型。持久化后广播给主窗口实时增删。
    #[tauri::command]
    fn save_visibility(
        app: tauri::AppHandle,
        show_balance_card: bool,
        visible_models: Vec<String>,
        show_chart: bool,
    ) -> Result<AppConfig, String> {
        let mut config = read_stored_config()?;
        config.show_balance_card = show_balance_card;
        config.visible_models = visible_models;
        config.show_chart = show_chart;
        write_stored_config(&config)?;
        let app_config = to_app_config(config)?;
        let _ = app.emit("display-config-changed", &app_config);
        Ok(app_config)
    }

    // 记忆窗口几何:普通/mini 模式各自独立保存位置与尺寸。
    // x/y 为 Option,只更新传入的字段;mini=true 写入 mini_* 字段。
    #[tauri::command]
    fn save_window_geometry(
        mini: bool,
        x: Option<i32>,
        y: Option<i32>,
        width: Option<u32>,
        height: Option<u32>,
    ) -> Result<AppConfig, String> {
        let mut config = read_stored_config()?;
        if mini {
            if let Some(x) = x {
                config.mini_x = Some(x);
            }
            if let Some(y) = y {
                config.mini_y = Some(y);
            }
            if let Some(width) = width {
                config.mini_width = width;
            }
            if let Some(height) = height {
                config.mini_height = height;
            }
        } else {
            if let Some(x) = x {
                config.window_x = Some(x);
            }
            if let Some(y) = y {
                config.window_y = Some(y);
            }
            if let Some(width) = width {
                config.window_width = width;
            }
            if let Some(height) = height {
                config.window_height = height;
            }
        }
        write_stored_config(&config)?;
        to_app_config(config)
    }

    // 迷你模式窗口:紧凑小窗;完整模式恢复保存的尺寸
    // 按当前模式恢复主窗口位置与尺寸(普通/mini 各自独立记录)。
    // mini 模式下前端测量文字后会自动收紧,这里恢复上次记录的值。
    fn apply_mode_window_size(app: &tauri::AppHandle) {
        let config = read_stored_config().unwrap_or_default();
        if let Some(window) = app.get_webview_window("main") {
            let (w, h) = if config.mini_mode {
                (config.mini_width, config.mini_height)
            } else {
                (config.window_width, config.window_height)
            };
            let _ = window.set_size(tauri::Size::Physical(tauri::PhysicalSize::new(w, h)));
            let (px, py) = if config.mini_mode {
                (config.mini_x, config.mini_y)
            } else {
                (config.window_x, config.window_y)
            };
            restore_window_position(&window, (px, py));
        }
    }

    // 切换 mini 模式(主面板仅文本简洁显示),广播给所有窗口实时切换。
    #[tauri::command]
    fn save_mini_mode(app: tauri::AppHandle, mini_mode: bool) -> Result<AppConfig, String> {
        let mut config = read_stored_config()?;
        config.mini_mode = mini_mode;
        write_stored_config(&config)?;
        let _ = app.emit("mini-mode-changed", mini_mode);
        apply_mode_window_size(&app);
        to_app_config(config)
    }

    #[derive(Debug, Serialize)]
    #[serde(rename_all = "camelCase")]
    struct BalanceResult {
        is_available: bool,
        currency: String,
        total_balance: String,
        granted_balance: String,
        topped_up_balance: String,
    }

    // 实时查询 DeepSeek 账户余额。DeepSeek 官方仅提供余额接口，无用量接口。
    #[tauri::command]
    async fn fetch_balance() -> Result<BalanceResult, String> {
        let config = read_stored_config()?;
        let api_key = config
            .api_key
            .filter(|value| !value.is_empty())
            .ok_or_else(|| "未配置 API Key".to_string())?;

        let client = reqwest::Client::new();
        let response = client
            .get("https://api.deepseek.com/user/balance")
            .bearer_auth(&api_key)
            .timeout(std::time::Duration::from_secs(15))
            .send()
            .await
            .map_err(|error| format!("网络请求失败：{error}"))?;

        match response.status().as_u16() {
            200 => {}
            401 => return Err("API Key 无效或已过期".to_string()),
            429 => return Err("请求过于频繁，请稍后再试".to_string()),
            code if code >= 500 => return Err(format!("DeepSeek 服务器错误：{code}")),
            code => return Err(format!("请求失败：HTTP {code}")),
        }

        #[derive(Deserialize)]
        struct BalanceInfo {
            currency: String,
            total_balance: String,
            granted_balance: String,
            topped_up_balance: String,
        }
        #[derive(Deserialize)]
        struct BalanceResponse {
            is_available: bool,
            balance_infos: Vec<BalanceInfo>,
        }

        let data: BalanceResponse = response
            .json()
            .await
            .map_err(|error| format!("解析余额数据失败：{error}"))?;

        let info = data
            .balance_infos
            .into_iter()
            .next()
            .ok_or_else(|| "余额信息为空".to_string())?;

        Ok(BalanceResult {
            is_available: data.is_available,
            currency: info.currency,
            total_balance: info.total_balance,
            granted_balance: info.granted_balance,
            topped_up_balance: info.topped_up_balance,
        })
    }

    // 模型 ID 转友好显示名:"deepseek-v4-flash" -> "V4 Flash"。
    // 去掉 deepseek- 前缀,按 - 分段、首字母大写,不做硬编码映射。
    fn model_display_name(model_id: &str) -> String {
        let stripped = model_id.strip_prefix("deepseek-").unwrap_or(model_id);
        stripped
            .split('-')
            .filter(|part| !part.is_empty())
            .map(|part| {
                let mut chars = part.chars();
                match chars.next() {
                    Some(first) if first.is_ascii_alphabetic() => {
                        first.to_uppercase().collect::<String>() + chars.as_str()
                    }
                    _ => part.to_string(),
                }
            })
            .collect::<Vec<_>>()
            .join(" ")
    }

    // 拉取 DeepSeek 官方模型列表接口,供设置页动态列出用户可用模型,不写死模型。
    #[tauri::command]
    async fn fetch_models() -> Result<Vec<String>, String> {
        let config = read_stored_config()?;
        let api_key = config
            .api_key
            .filter(|value| !value.is_empty())
            .ok_or_else(|| "未配置 API Key".to_string())?;

        let client = reqwest::Client::new();
        let response = client
            .get("https://api.deepseek.com/models")
            .bearer_auth(&api_key)
            .timeout(std::time::Duration::from_secs(15))
            .send()
            .await
            .map_err(|error| format!("网络请求失败：{error}"))?;

        match response.status().as_u16() {
            200 => {}
            401 => return Err("API Key 无效或已过期".to_string()),
            code => return Err(format!("获取模型列表失败：HTTP {code}")),
        }

        #[derive(Deserialize)]
        struct ModelItem {
            id: String,
        }
        #[derive(Deserialize)]
        struct ModelsResponse {
            data: Vec<ModelItem>,
        }

        let data: ModelsResponse = response
            .json()
            .await
            .map_err(|error| format!("解析模型列表失败：{error}"))?;
        Ok(data.data.into_iter().map(|item| item.id).collect())
    }

    #[tauri::command]
    fn save_usage_token(usage_token: String) -> Result<AppConfig, String> {
        let value = usage_token.trim().to_string();
        if value.is_empty() {
            return Err("用量 Token 不能为空".to_string());
        }
        let mut config = read_stored_config()?;
        config.usage_token = Some(value);
        write_stored_config(&config)?;
        to_app_config(config)
    }

    #[tauri::command]
    fn clear_usage_token() -> Result<AppConfig, String> {
        let mut config = read_stored_config()?;
        config.usage_token = None;
        write_stored_config(&config)?;
        to_app_config(config)
    }

    const USAGE_TOKEN_TITLE_PREFIX: &str = "DSM_USAGE_TOKEN:";

    fn capture_usage_token(app: &tauri::AppHandle, token: String) -> Result<AppConfig, String> {
        let value = token.trim().to_string();
        if value.is_empty() {
            return Err("用量 Token 为空".to_string());
        }
        let mut config = read_stored_config()?;
        config.usage_token = Some(value);
        write_stored_config(&config)?;
        let app_config = to_app_config(config)?;

        // 标记本次同步已成功，避免 watcher 在窗口关闭后误发"结束等待"事件
        if let Some(flag) = app.try_state::<Arc<AtomicBool>>() {
            flag.store(true, Ordering::SeqCst);
        }

        if let Some(window) = app.get_webview_window("login-sync") {
            let _ = window.close();
        }

        let _ = app.emit("usage-token-captured", &app_config);

        Ok(app_config)
    }

    // 用 token 试调平台用量接口，验证它确实是有效的用量 token。
    async fn verify_usage_token(token: &str, month: u32, year: u32) -> Result<(), String> {
        let ua = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 \
                  (KHTML, like Gecko) Chrome/148.0.0.0 Safari/537.36";
        let url =
            format!("https://platform.deepseek.com/api/v0/usage/amount?month={month}&year={year}");
        let resp = reqwest::Client::new()
            .get(&url)
            .bearer_auth(token)
            .header("x-app-version", "1.0.0")
            .header("Accept", "*/*")
            .header("User-Agent", ua)
            .timeout(Duration::from_secs(15))
            .send()
            .await
            .map_err(|error| format!("验证 token 失败：{error}"))?;
        if resp.status().as_u16() == 200 {
            Ok(())
        } else {
            Err(format!("token 无效：HTTP {}", resp.status().as_u16()))
        }
    }

    fn read_shared_text(path: &Path) -> Option<String> {
        let mut file = fs::OpenOptions::new()
            .read(true)
            .share_mode(0x1 | 0x2 | 0x4)
            .open(path)
            .ok()?;
        let metadata = file.metadata().ok()?;
        if metadata.len() == 0 || metadata.len() > 20 * 1024 * 1024 {
            return None;
        }
        let mut bytes = Vec::with_capacity(metadata.len() as usize);
        file.read_to_end(&mut bytes).ok()?;
        Some(String::from_utf8_lossy(&bytes).replace('\0', ""))
    }

    fn extract_user_api_token(text: &str) -> Option<String> {
        let mut search_from = 0;
        let marker = "\"token\":\"";
        while let Some(relative_index) = text[search_from..].find(marker) {
            let token_start = search_from + relative_index + marker.len();
            let token_end = token_start + text[token_start..].find('"')?;
            let token = &text[token_start..token_end];
            let context_end = (token_end + 1800).min(text.len());
            let context = &text[token_end..context_end];
            if token.len() > 20
                && context.contains("\"id_profile\"")
                && context.contains("\"feature_gates\"")
            {
                return Some(token.to_string());
            }
            search_from = token_end + 1;
        }
        None
    }

    fn find_webview_cached_usage_token() -> Option<String> {
        let local_app_data = std::env::var_os("LOCALAPPDATA")?;
        let cache_dir = PathBuf::from(local_app_data)
            .join("com.deepseek.monitor.windows")
            .join("EBWebView")
            .join("Default")
            .join("Cache")
            .join("Cache_Data");
        let entries = fs::read_dir(cache_dir).ok()?;
        for entry in entries.flatten() {
            let path = entry.path();
            if !path.is_file() {
                continue;
            }
            if let Some(text) = read_shared_text(&path) {
                if let Some(token) = extract_user_api_token(&text) {
                    return Some(token);
                }
            }
        }
        None
    }

    fn start_usage_title_watcher(app: tauri::AppHandle) {
        thread::spawn(move || {
            // 登录页加载并触发平台 API 请求需要时间，等待后再开始扫缓存
            thread::sleep(Duration::from_secs(3));
            for _ in 0..1200 {
                if let Some(token) = find_webview_cached_usage_token() {
                    let _ = capture_usage_token(&app, token);
                    return;
                }

                let Some(window) = app.get_webview_window("login-sync") else {
                    // 窗口已关闭：若不是因成功捕获而关闭，才通知前端结束等待
                    let captured = app
                        .try_state::<Arc<AtomicBool>>()
                        .map(|flag| flag.load(Ordering::SeqCst))
                        .unwrap_or(false);
                    if !captured {
                        let _ = app.emit("usage-sync-ended", ());
                    }
                    return;
                };

                if let Ok(title) = window.title() {
                    if let Some(rest) = title.strip_prefix(USAGE_TOKEN_TITLE_PREFIX) {
                        // 注入脚本写入的格式：{year}:{month}:{token}
                        let mut parts = rest.splitn(3, ':');
                        if let (Some(y), Some(m), Some(tok)) =
                            (parts.next(), parts.next(), parts.next())
                        {
                            if let (Ok(year), Ok(month)) = (y.parse::<u32>(), m.parse::<u32>()) {
                                let token = tok.to_string();
                                // 验证 token 真能调用用量接口，过滤登录中途的临时 token
                                let verified = tauri::async_runtime::block_on(
                                    verify_usage_token(&token, month, year),
                                );
                                if verified.is_ok() {
                                    let _ = capture_usage_token(&app, token);
                                    return;
                                }
                            }
                        }
                    }
                }

                thread::sleep(Duration::from_millis(1500));
            }
            // 30 分钟超时，若仍未成功则通知前端结束等待
            let captured = app
                .try_state::<Arc<AtomicBool>>()
                .map(|flag| flag.load(Ordering::SeqCst))
                .unwrap_or(false);
            if !captured {
                let _ = app.emit("usage-sync-ended", ());
            }
        });
    }

    // 在登录窗口注入，hook fetch / XMLHttpRequest，主动从平台 API 请求的
    // Authorization 头里抓 Bearer token。登录后页面自动调 API 即可即时捕获，
    // 不再依赖 WebView2 磁盘缓存的延迟落盘。
    const USAGE_SYNC_POLL_JS: &str = r#"
    (function() {
      if (window.__dsm_token_hook__) return;
      window.__dsm_token_hook__ = true;
      var done = false;
      var pending = false;

      function deliver(token) {
        if (done) return;
        if (!token || typeof token !== 'string') return;
        token = token.trim();
        if (token.length < 20) return;
        var now = new Date();
        var y = now.getFullYear();
        var m = now.getMonth() + 1;
        // 主通道：写入 document.title，原生侧 window.title() 读取。
        // 外部网站窗口默认不注入 __TAURI__，此通道不依赖它，最可靠。
        try { document.title = 'DSM_USAGE_TOKEN:' + y + ':' + m + ':' + token; } catch (e) {}
        // 辅通道：若本窗口恰好可用 __TAURI__，直接上报更快
        try {
          if (!pending && window.__TAURI__ && window.__TAURI__.core) {
            pending = true;
            window.__TAURI__.core.invoke('usage_token_captured', {
              token: token, month: m, year: y
            }).then(function() { done = true; }).catch(function() { pending = false; });
          }
        } catch (e) {}
      }

      function fromAuth(value) {
        if (!value) return;
        var m = /Bearer\s+(\S+)/i.exec(String(value));
        if (m && m[1]) deliver(m[1]);
      }

      var origFetch = window.fetch;
      if (typeof origFetch === 'function') {
        window.fetch = function(input, init) {
          try {
            var headers = (init && init.headers) || (input && input.headers);
            if (headers) {
              if (typeof Headers !== 'undefined' && headers instanceof Headers) {
                fromAuth(headers.get('authorization'));
              } else if (Array.isArray(headers)) {
                for (var i = 0; i < headers.length; i++) {
                  if (headers[i] && String(headers[i][0]).toLowerCase() === 'authorization') {
                    fromAuth(headers[i][1]);
                  }
                }
              } else if (typeof headers === 'object') {
                for (var k in headers) {
                  if (k.toLowerCase() === 'authorization') fromAuth(headers[k]);
                }
              }
            }
          } catch (e) {}
          return origFetch.apply(this, arguments);
        };
      }

      var origSet = XMLHttpRequest.prototype.setRequestHeader;
      XMLHttpRequest.prototype.setRequestHeader = function(name, value) {
        try {
          if (name && String(name).toLowerCase() === 'authorization') fromAuth(value);
        } catch (e) {}
        return origSet.apply(this, arguments);
      };
    })();
    "#;

    #[tauri::command]
    async fn start_usage_sync(app: tauri::AppHandle) -> Result<bool, String> {
        // 重置本次同步的成功标志
        if let Some(flag) = app.try_state::<Arc<AtomicBool>>() {
            flag.store(false, Ordering::SeqCst);
        }

        // 先扫一次缓存：登录完成后重复点击本命令，缓存落盘后即可命中
        if let Some(token) = find_webview_cached_usage_token() {
            capture_usage_token(&app, token)?;
            return Ok(true);
        }

        // 登录窗口已存在：刷新它，促使用量页重新请求接口、把响应写入缓存，
        // 用户随后再点一次本按钮即可命中。不重复弹新窗口、不死等。
        if app.get_webview_window("login-sync").is_some() {
            if let Some(window) = app.get_webview_window("login-sync") {
                let _ = window.eval("location.reload();");
            }
            return Ok(false);
        }

        let url = tauri::WebviewUrl::External("https://platform.deepseek.com".parse().unwrap());
        tauri::WebviewWindowBuilder::new(
            &app,
            "login-sync",
            url,
        )
        .title("DeepSeek 账号登录")
        .inner_size(480.0, 720.0)
        .min_inner_size(360.0, 480.0)
        .resizable(true)
        .center()
        .visible(true)
        .initialization_script(USAGE_SYNC_POLL_JS)
        .on_page_load(|window, payload| {
            if matches!(payload.event(), PageLoadEvent::Finished)
                && payload
                    .url()
                    .host_str()
                    .is_some_and(|host| host == "platform.deepseek.com")
            {
                // 双保险：万一 initialization_script 未注入，页面加载完再装一次 hook
                let _ = window.eval(USAGE_SYNC_POLL_JS);
            }
        })
        .build()
        .map_err(|error| format!("打开登录窗口失败：{error}"))?;
        start_usage_title_watcher(app);
        Ok(false)
    }

    #[tauri::command]
    async fn usage_token_captured(
        app: tauri::AppHandle,
        token: String,
        month: u32,
        year: u32,
    ) -> Result<AppConfig, String> {
        let value = token.trim().to_string();
        if value.is_empty() {
            return Err("用量 Token 为空".to_string());
        }
        // 先验证再保存：拦截到的 token 可能是登录中途的临时 token，
        // 只有能真正调用用量接口的才接受
        verify_usage_token(&value, month, year).await?;
        capture_usage_token(&app, value)
    }

    #[derive(Debug, Serialize)]
    #[serde(rename_all = "camelCase")]
    struct UsageModelSummary {
        key: String,
        name: String,
        total_tokens: u64,
        request_count: u64,
        cache_hit_tokens: u64,
        cache_miss_tokens: u64,
        response_tokens: u64,
        cost: f64,
    }

    #[derive(Debug, Serialize)]
    #[serde(rename_all = "camelCase")]
    struct UsageModelDaily {
        key: String,
        cache_hit: u64,
        cache_miss: u64,
        response: u64,
    }

    #[derive(Debug, Serialize)]
    #[serde(rename_all = "camelCase")]
    struct UsageDaySummary {
        date: String,
        models: Vec<UsageModelDaily>,
        total_tokens: u64,
        total_cost: f64,
    }

    #[derive(Debug, Serialize)]
    #[serde(rename_all = "camelCase")]
    struct UsageResult {
        models: Vec<UsageModelSummary>,
        days: Vec<UsageDaySummary>,
        month_cost: f64,
    }

    // 通过 DeepSeek 平台内部接口拉取用量与费用（需网页登录 token，非官方 API Key）。
    #[tauri::command]
    async fn fetch_usage(month: u32, year: u32) -> Result<UsageResult, String> {
        let config = read_stored_config()?;
        let token = config
            .usage_token
            .filter(|value| !value.is_empty())
            .ok_or_else(|| "未配置用量 Token".to_string())?;

        #[derive(Deserialize)]
        struct Entry {
            #[serde(rename = "type")]
            kind: String,
            amount: String,
        }
        #[derive(Deserialize)]
        struct ModelUsage {
            model: String,
            usage: Vec<Entry>,
        }
        #[derive(Deserialize)]
        struct DayUsage {
            date: String,
            data: Vec<ModelUsage>,
        }
        #[derive(Deserialize)]
        struct AmountBiz {
            total: Vec<ModelUsage>,
            days: Vec<DayUsage>,
        }
        #[derive(Deserialize)]
        struct AmountData {
            biz_data: AmountBiz,
        }
        #[derive(Deserialize)]
        struct AmountResp {
            data: AmountData,
        }
        #[derive(Deserialize)]
        struct CostBiz {
            total: Vec<ModelUsage>,
            days: Vec<DayUsage>,
        }
        #[derive(Deserialize)]
        struct CostData {
            biz_data: Vec<CostBiz>,
        }
        #[derive(Deserialize)]
        struct CostResp {
            data: CostData,
        }

        async fn get_json<T: serde::de::DeserializeOwned>(
            client: &reqwest::Client,
            url: &str,
            token: &str,
        ) -> Result<T, String> {
            let ua = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 \
                      (KHTML, like Gecko) Chrome/148.0.0.0 Safari/537.36";
            let resp = client
                .get(url)
                .bearer_auth(token)
                .header("x-app-version", "1.0.0")
                .header("Accept", "*/*")
                .header("User-Agent", ua)
                .timeout(std::time::Duration::from_secs(15))
                .send()
                .await
                .map_err(|error| format!("用量请求失败：{error}"))?;
            match resp.status().as_u16() {
                200 => {}
                401 => return Err("用量 Token 无效或已过期，请重新获取".to_string()),
                429 => return Err("请求过于频繁，请稍后再试".to_string()),
                code => return Err(format!("用量接口错误：HTTP {code}")),
            }
            resp.json::<T>()
                .await
                .map_err(|error| format!("解析用量数据失败：{error}"))
        }

        fn token_breakdown(usage: &[Entry]) -> (u64, u64, u64, u64, u64) {
            // 返回 (总 token, 请求数, 缓存命中, 缓存未命中, 输出 token)
            let mut total = 0u64;
            let mut request = 0u64;
            let mut hit = 0u64;
            let mut miss = 0u64;
            let mut response = 0u64;
            for entry in usage {
                let value = entry.amount.parse::<f64>().unwrap_or(0.0).round() as u64;
                match entry.kind.as_str() {
                    "REQUEST" => request = value,
                    "PROMPT_CACHE_HIT_TOKEN" => {
                        hit = value;
                        total += value;
                    }
                    "PROMPT_CACHE_MISS_TOKEN" => {
                        miss = value;
                        total += value;
                    }
                    "RESPONSE_TOKEN" => {
                        response = value;
                        total += value;
                    }
                    "PROMPT_TOKEN" => total += value,
                    _ => {}
                }
            }
            (total, request, hit, miss, response)
        }

        fn cost_sum(usage: &[Entry]) -> f64 {
            usage
                .iter()
                .filter(|entry| entry.kind != "REQUEST")
                .map(|entry| entry.amount.parse::<f64>().unwrap_or(0.0))
                .sum()
        }

        let client = reqwest::Client::new();
        let amount_url =
            format!("https://platform.deepseek.com/api/v0/usage/amount?month={month}&year={year}");
        let cost_url =
            format!("https://platform.deepseek.com/api/v0/usage/cost?month={month}&year={year}");

        let amount: AmountResp = get_json(&client, &amount_url, &token).await?;
        let cost: CostResp = get_json(&client, &cost_url, &token).await?;

        let cost_total = cost.data.biz_data.first();
        let cost_for_model = |model: &str| -> f64 {
            cost_total
                .and_then(|item| item.total.iter().find(|m| m.model == model))
                .map(|m| cost_sum(&m.usage))
                .unwrap_or(0.0)
        };

        // 模型列表不写死:凡是平台用量接口返回的模型都展示,key=模型 ID
        let mut models = Vec::new();
        for model_usage in &amount.data.biz_data.total {
            let (total, request, hit, miss, response) = token_breakdown(&model_usage.usage);
            models.push(UsageModelSummary {
                key: model_usage.model.clone(),
                name: model_display_name(&model_usage.model),
                total_tokens: total,
                request_count: request,
                cache_hit_tokens: hit,
                cache_miss_tokens: miss,
                response_tokens: response,
                cost: cost_for_model(&model_usage.model),
            });
        }

        let mut cost_by_date: std::collections::HashMap<String, f64> =
            std::collections::HashMap::new();
        if let Some(item) = cost_total {
            for day in &item.days {
                let day_cost: f64 = day.data.iter().map(|m| cost_sum(&m.usage)).sum();
                cost_by_date.insert(day.date.clone(), day_cost);
            }
        }

        let mut days = Vec::new();
        for day in &amount.data.biz_data.days {
            let mut total = 0u64;
            let mut model_days = Vec::new();
            for model_usage in &day.data {
                let (tokens, _, hit, miss, response) = token_breakdown(&model_usage.usage);
                total += tokens;
                model_days.push(UsageModelDaily {
                    key: model_usage.model.clone(),
                    cache_hit: hit,
                    cache_miss: miss,
                    response,
                });
            }
            days.push(UsageDaySummary {
                date: day.date.clone(),
                models: model_days,
                total_tokens: total,
                total_cost: cost_by_date.get(&day.date).copied().unwrap_or(0.0),
            });
        }

        let month_cost: f64 = cost_total
            .map(|item| item.total.iter().map(|m| cost_sum(&m.usage)).sum())
            .unwrap_or(0.0);

        Ok(UsageResult {
            models,
            days,
            month_cost,
        })
    }

    tauri::Builder::default()
        // 单实例守卫：必须作为第一个注册的插件。
        // 程序已运行时再次启动 exe，第二个进程不会新开窗口，
        // 而是触发此回调把已有主窗口显示并聚焦，随后第二个进程自行退出。
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            if let Some(window) = app.get_webview_window("main") {
                show_main_window(&window);
            }
        }))
        .manage(Arc::new(AtomicBool::new(false)))
        .invoke_handler(tauri::generate_handler![
            hide_main_window,
            get_app_config,
            save_api_key,
            clear_api_key,
            save_refresh_interval,
            save_auto_refresh_enabled,
            save_autostart,
            save_display_settings,
            save_visibility,
            save_window_geometry,
            save_mini_mode,
            fetch_balance,
            fetch_models,
            save_usage_token,
            clear_usage_token,
            fetch_usage,
            start_usage_sync,
            usage_token_captured
        ])
        .setup(|app| {
            if cfg!(debug_assertions) {
                app.handle().plugin(
                    tauri_plugin_log::Builder::default()
                        .level(log::LevelFilter::Info)
                        .build(),
                )?;
            }

            // 托盘菜单项:mini 项文案按当前模式动态显示
            let in_mini = read_stored_config()
                .map(|c| c.mini_mode)
                .unwrap_or(false);
            let show_item = MenuItem::with_id(app, "show", "显示主面板", true, None::<&str>)?;
            let refresh_item = MenuItem::with_id(app, "refresh", "刷新数据", true, None::<&str>)?;
            let mini_item = MenuItem::with_id(
                app,
                "mini",
                if in_mini { "切换普通模式" } else { "切换迷你模式" },
                true,
                None::<&str>,
            )?;
            let settings_item = MenuItem::with_id(app, "settings", "设置", true, None::<&str>)?;
            let quit_item = MenuItem::with_id(app, "quit", "退出", true, None::<&str>)?;
            let tray_menu = Menu::with_items(
                app,
                &[&show_item, &refresh_item, &mini_item, &settings_item, &quit_item],
            )?;

            let mut tray_builder = TrayIconBuilder::new()
                .menu(&tray_menu)
                .show_menu_on_left_click(false)
                .on_menu_event(|app, event| match event.id().as_ref() {
                    "show" => {
                        if let Some(window) = app.get_webview_window("main") {
                            show_main_window(&window);
                        }
                    }
                    // 前端顶部按钮已移除,刷新/设置入口全部收敛到托盘右键菜单
                    "refresh" => {
                        if let Some(window) = app.get_webview_window("main") {
                            let _ = app.emit("refresh-data", ());
                            show_main_window(&window);
                        }
                    }
                    "mini" => {
                        // 翻转 mini 模式并持久化,广播给主窗口实时切换
                        if let Some(window) = app.get_webview_window("main") {
                            let mut config = read_stored_config().unwrap_or_default();
                            config.mini_mode = !config.mini_mode;
                            let _ = write_stored_config(&config);
                            let _ = app.emit("mini-mode-changed", config.mini_mode);
                            apply_mode_window_size(app);
                            show_main_window(&window);
                            // 同步托盘菜单文案:mini 中显示「切换普通模式」
                            if let Some(state) = app.try_state::<MiniMenuState>() {
                                let label = if config.mini_mode {
                                    "切换普通模式"
                                } else {
                                    "切换迷你模式"
                                };
                                let _ = state.0.set_text(label);
                            }
                        }
                    }
                    "settings" => {
                        let _ = open_settings_window(app);
                    }
                    "quit" => {
                        app.exit(0);
                    }
                    _ => {}
                })
                .on_tray_icon_event(|tray, event| {
                    // 仅在左键“抬起”时切换；否则按下+抬起各触发一次，窗口会闪现后立即隐藏
                    if let TrayIconEvent::Click {
                        button: MouseButton::Left,
                        button_state: MouseButtonState::Up,
                        ..
                    } = event
                    {
                        let app = tray.app_handle();
                        if let Some(window) = app.get_webview_window("main") {
                            let is_visible = window.is_visible().unwrap_or(false);
                            if is_visible {
                                let _ = window.hide();
                            } else {
                                show_main_window(&window);
                            }
                        }
                    }
                });

            if let Some(icon) = app.default_window_icon() {
                tray_builder = tray_builder.icon(icon.clone());
            }

            tray_builder.build(app)?;
            app.manage(MiniMenuState(mini_item.clone()));

            // 应用已保存的显示设置(置顶/窗口尺寸),避免启动时先闪默认值。
            // 透明度由前端在 documentElement 上以 CSS opacity 应用。
            if let Some(window) = app.get_webview_window("main") {
                match read_stored_config() {
                    Ok(config) => {
                        apply_always_on_top(&window, config.always_on_top);
                        // 按当前模式恢复位置与尺寸(普通/mini 各自独立)
                        apply_mode_window_size(app.handle());
                    }
                    Err(error) => log::warn!("读取显示设置失败: {error}"),
                }

                // 几何变更由 Rust 直接记录:以 config.mini_mode 为准写入对应字段,
                // 避免前端 mode 状态竞态(切换瞬间 onResized 用旧状态写错字段)。
                window.on_window_event(|event| match event {
                    tauri::WindowEvent::Resized(size) => {
                        let mut config = read_stored_config().unwrap_or_default();
                        if config.mini_mode {
                            config.mini_width = size.width;
                            config.mini_height = size.height;
                        } else {
                            config.window_width = size.width;
                            config.window_height = size.height;
                        }
                        let _ = write_stored_config(&config);
                    }
                    tauri::WindowEvent::Moved(position) => {
                        let mut config = read_stored_config().unwrap_or_default();
                        if config.mini_mode {
                            config.mini_x = Some(position.x);
                            config.mini_y = Some(position.y);
                        } else {
                            config.window_x = Some(position.x);
                            config.window_y = Some(position.y);
                        }
                        let _ = write_stored_config(&config);
                    }
                    _ => {}
                });
            }

            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
