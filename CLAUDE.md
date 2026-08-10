# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Windows-only Tauri 2 desktop app that monitors a DeepSeek API account: balance, current-month spend, per-model token usage, and a 7-day trend. Frameless, transparent, always-in-taskbar-tray floating panel. UI is Chinese. All source comments are Chinese — keep new comments in Chinese for non-trivial logic.

## Commands

```powershell
npm run tauri:dev      # full dev app (Vite + Rust) — main workflow
npm run tauri:check    # Rust compile check (cargo check) — verification gate #2
npm run build          # frontend: tsc (strict) && vite build — verification gate #1
npm run dev            # Vite dev server only, port 5180
npx tauri build        # NSIS installer -> src-tauri/target/release/bundle/nsis/
```

- **No test framework exists.** Do not install one. Verification is `npm run build` (TypeScript strict) + `npm run tauri:check` (Rust compile), then `npm run tauri:dev` for runtime checks.
- `tauri:dev`/`tauri:check` route through `scripts/tauri-*.ps1`, which source `scripts/env.ps1`. That script resolves VS Build Tools 2022 via vswhere (`Desktop development with C++` required) and redirects `RUSTUP_HOME`/`CARGO_HOME`/`npm_config_cache` into the project's **parent** directory (`.rustup`, `.cargo`, `.npm-cache`). Rust must be the MSVC toolchain.
- The README's "`npm run build` produces the installer" is inaccurate: that command only builds the frontend. The NSIS installer comes from `npx tauri build`.

## Architecture

Both halves are **deliberately monolithic single files**; do not split them without a strong reason.

- `src-tauri/src/lib.rs` (≈1360 lines) — one giant `run()` function with nested fns. Everything Rust lives here: config persistence, all HTTP calls, window/tray management, token sync, Win32 hacks.
- `src/main.tsx` (≈1650 lines) — all React: `App()` holds every state + cross-window event listeners; panel components (`DashboardPanel`, `SettingsPanel`, `ModelDetailPanel`, `MiniPanel`) are in the same file. `src/styles.css` is the single stylesheet.
- `src-tauri/tauri.conf.json` — main window is 356×600, frameless (`decorations:false`), transparent, `skipTaskbar`, `withGlobalTauri:true`. CSP is null.

### Two credentials, two credential providers (critical)

- **API Key** → official endpoint `https://api.deepseek.com/user/balance` (`fetch_balance`). Stored in config.
- **Usage Token** → DeepSeek's *internal, unofficial* platform API `https://platform.deepseek.com/api/v0/usage/{amount,cost}` (`fetch_usage`). There is **no official usage API** — the token is a web-login session token captured at runtime, NOT an API Key.

### Usage-token capture pipeline (most intricate code in the project)

`start_usage_sync` (frontend button "方式一：网页登录自动同步"):
1. Scan WebView2 disk cache for an existing token (`find_webview_cached_usage_token`); if hit, save and return.
2. Else open a `login-sync` window (label `"login-sync"`) at `https://platform.deepseek.com` with `USAGE_SYNC_POLL_JS` injected as initialization script.
3. The injected JS hooks `window.fetch` + `XMLHttpRequest.setRequestHeader` and captures the Bearer token from the Authorization header. It delivers via two channels:
   - **Primary:** writes `document.title = 'DSM_USAGE_TOKEN:{year}:{month}:{token}'` — the external site has no `__TAURI__`, so title is the reliable channel.
   - **Secondary:** if `__TAURI__` happens to exist, invoke `usage_token_captured` directly.
4. `start_usage_title_watcher` polls `window.title()` every 1.5s (up to 30 min), plus re-scans the disk cache each loop. If the `login-sync` window closes without capture, emits `usage-sync-ended` to the frontend.
5. **Every token is verified** against the usage API (`verify_usage_token`) before it's accepted — filters out transient mid-login tokens. Success flag is an `Arc<AtomicBool>` in managed state.

`platform.deepseek.com` is allowlisted in `src-tauri/capabilities/default.json` (remote URLs). The login-sync window is an external URL, so it can't call Tauri commands except via the `__TAURI__`-optional path — always route token delivery through the title channel or `window.eval`.

### Windows & geometry ownership

- Three windows, all created from `index.html` and routed by label in `App()`: `main` (dashboard/detail/mini), `settings` (separate frameless panel, only fetches usage — never balance — for the model list), `login-sync` (external URL).
- **Geometry is owned by Rust, not the frontend.** `on_window_event` on the main window writes `Resized`/`Moved` straight into config — the recent fix moved this out of React because frontend mode state races the switch moment. Never move geometry persistence back to JS.
- **mini mode** toggles normal↔mini display; each mode has its **own** remembered geometry (`window_width/height/x/y` vs `mini_width/height/x/y`). `apply_mode_window_size` restores the current mode's size/position. Tray "mini" menu item flips the mode, persists, emits `mini-mode-changed`, and re-labels itself.
- First launch positions the main window near the tray; afterwards it restores the last position per mode (`show_main_window`).

### Tray & window quirks

- Tray left-click toggles visibility **only on button Up** (Down+Up would flicker). Menu: 显示主面板 / 刷新数据 (emits `refresh-data`) / 切换迷你模式 / 设置 / 退出. Frontend refresh/settings buttons were removed — all entry points are the tray menu.
- **Always-on-top hack:** Tauri/tao caches repeated `set_always_on_top` with the same value (won't re-apply), and Windows drops `WS_EX_TOPMOST` after hide/show. So Rust calls `SetWindowPos` (Win32, via the `windows` crate) directly via `force_always_on_top`, re-asserted on every `show_main_window`. Don't "simplify" this back to `set_always_on_top`.
- Opacity is applied as CSS `opacity` on `documentElement` from the frontend — Tauri 2.11 has **no** `set_opacity` API (verified at compile time). Only the main panel gets opacity; the settings window stays opaque.

### Config persistence

- `%APPDATA%\DeepSeekMonitorWindows\config.json`. `StoredConfig` has `#[serde(default)]` + manual `Default` for backward compatibility (old configs missing new fields load fine). `AppConfig` (camelCase via `#[serde(rename_all = "camelCase")]`) is the command-facing shape.
- All `save_*` commands read-modify-write the whole config and return the new `AppConfig`. API Key and usage Token are stored **in plaintext** here — never log, screenshot, or commit them.
- Settings changes propagate to the main window via Tauri events (`display-config-changed`, `theme-changed`, `mini-mode-changed`, `refresh-data`), not by re-polling config.

### Cross-cutting invariants

- `tauri-plugin-single-instance` is registered as the **first plugin**; the second process triggers `show_main_window` on the existing instance and exits. Don't reorder plugins before it.
- Refresh keeps stale data instead of flashing loading (frontend keeps previous balance/usage on refresh errors; only first-load failure enters `error` state, missing-credential enters `nokey`).
- Model list is driven dynamically from the platform API (`fetch_models` + usage response), never hardcoded. `model_display_name` strips the `deepseek-` prefix and title-cases segments.
- Numbers are formatted 2 decimals for money / grouped for tokens in `src/main.tsx` (`fmtMoney`, `fmtTokensShort`, `fmtInt`).

## Environment Notes

- Windows only; targets NSIS installer. No CI pipeline configured.
- `docs/superpowers/specs/` holds dated design specs (e.g. display-settings design) — read these before changing behaviors they documented.
