# DeepSeek Monitor Windows

面向 Windows 的 DeepSeek API 用量监控桌面应用,用于查看账户余额、当月消费、模型 Token 用量和最近用量趋势。

本项目 fork 自 [Joyi-code/DeepSeekMonitorWindows](https://github.com/Joyi-code/DeepSeekMonitorWindows),实现思路源自 [JayHome137/deepseek-monitor](https://github.com/JayHome137/DeepSeekMonitor),并按 Windows 平台重构,感谢两位作者的开源工作。**本项目不是 DeepSeek 官方产品。**

## 功能特性

- **余额查询**:调用 DeepSeek 官方余额接口,实时查看账户余额。
- **用量统计**:当月消费、各模型 Token 总量、请求数、缓存命中 / 未命中 / 输出 Token。
- **趋势分析**:最近 7 天消费趋势图和模型详情页。
- **Mini 模式**:纯文字紧凑展示余额 / 消费 / 模型用量,两行小字号不遮挡;普通 / Mini 模式各自独立记忆窗口位置与尺寸。
- **自动刷新**:按设定周期自动拉取最新数据,刷新失败时保留旧数据不闪烁。
- **开机自启**:登录 Windows 后自动启动。
- **Windows 托盘**:主窗口默认不占用任务栏,左键切换显示 / 隐藏,刷新、设置、模式切换入口收敛到右键菜单。
- **凭据管理**:API Key 保存、清除与余额验证;用量 Token 支持网页登录自动同步与手动粘贴兜底。
- **显示设置**:整窗透明度(含文字可透视桌面)、始终置顶、多套皮肤一键切换;主面板内容按需显隐(余额卡 / 各模型 / 缓存图表),窗口大小可自由拖拽并记住。
- **动态模型列表**:模型与用量展示由平台接口动态驱动,不写死 flash / pro。
- **单实例守卫**:防止重复多开,重复启动时唤起已有主面板。

## 页面截图

![页面总览](screenshots/overview.png)

![新版本 UI](screenshots/new-ui.png)

## 系统要求

- Windows 10 或 Windows 11。
- Microsoft Edge WebView2 Runtime(Windows 11 通常已内置,Windows 10 如缺失需单独安装)。
- Node.js 18+ 和 npm。
- Rust 1.77.2+(MSVC 工具链)。
- Visual Studio Build Tools 2022,需包含 `Desktop development with C++` 组件。项目脚本会自动探测 VS Build Tools 安装位置,无需手动配置固定路径。

## 安装与开发

```powershell
git clone <your-repo-url>
cd DeepSeekMonitorWindows
npm install
npm run tauri:dev
```

常用命令:

| 命令 | 说明 |
| --- | --- |
| `npm run tauri:dev` | 启动开发环境(前端 + Rust 后端) |
| `npm run tauri:check` | Rust 编译检查 |
| `npm run build` | 前端类型检查并构建(tsc + vite) |
| `npm run tauri:build` | 打包安装程序,产物为 NSIS 安装包,位于 `src-tauri/target/release/bundle/nsis/` |

如出现 `Visual Studio Build Tools not found`,请安装 Visual Studio Build Tools 2022,并确认已勾选 `Desktop development with C++` 组件。

## 使用方式

打开应用后进入设置页,先配置 DeepSeek API Key。API Key 用于查询账户余额,来自 DeepSeek 开放平台的 API Keys 页面。

DeepSeek 官方未提供用量统计 API,因此用量数据需要网页登录 Token(与 API Key 不同,用于访问 DeepSeek 平台的用量接口)。

**方式一,网页登录自动同步**:点击「方式一:网页登录自动同步」,在弹出的登录窗口完成登录后,应用会自动从登录会话中提取平台用量 Token 并刷新本月消费与 Token 统计。

**方式二,手动粘贴 Token**:点击「方式二:手动粘贴 Token」,按页面提示从浏览器控制台获取 `JSON.parse(localStorage.userToken).value`,粘贴后保存,作为自动同步失败时的兜底方案。

> Token 可能过期。用量查询失败时,重新执行网页登录同步或手动粘贴即可。

## 数据存储

应用配置默认存储在:

```text
%APPDATA%\DeepSeekMonitorWindows\config.json
```

其中包含 API Key 和用量 Token。**请不要提交该文件,也不要把截图、日志或配置文件中的密钥内容公开。**

WebView2 登录缓存通常位于:

```text
%LOCALAPPDATA%\com.deepseek.monitor.windows\EBWebView
```

该目录属于本机运行数据,不应提交到仓库。

## 项目结构

```text
DeepSeekMonitorWindows/
├── src/                         # React + TypeScript 前端
│   ├── main.tsx                 # 主界面、设置页、详情页、Mini 面板与 Tauri 调用
│   └── styles.css               # Windows 桌面 UI 样式
├── src-tauri/                   # Tauri + Rust 后端
│   ├── src/lib.rs               # API 调用、配置存储、托盘、窗口管理与用量 Token 同步
│   ├── tauri.conf.json          # Tauri 窗口、打包和安全配置
│   ├── capabilities/            # Tauri 权限配置
│   └── Cargo.toml               # Rust 依赖与包信息
├── scripts/                     # Windows 开发脚本(自动探测 VS Build Tools)
├── public/assets/               # DeepSeek 图标与静态资源
├── package.json                 # 前端依赖与脚本
└── README.md                    # 项目说明
```

## 依赖

前端运行依赖:

- React 18
- React DOM 18
- Tauri JavaScript API 2
- lucide-react

前端开发依赖:

- Vite 5
- TypeScript 5
- Tauri CLI 2

Rust 后端依赖:

- tauri 2.11,启用 tray-icon
- tauri-plugin-log
- tauri-plugin-single-instance(单实例守卫,防止应用重复多开)
- reqwest 0.12,启用 json
- serde / serde_json
- log
- windows 0.61(直接调用 Win32 `SetWindowPos` 实现置顶)

## 致谢

本项目 fork 自 [Joyi-code/DeepSeekMonitorWindows](https://github.com/Joyi-code/DeepSeekMonitorWindows),其实现思路源自 [JayHome137/deepseek-monitor](https://github.com/JayHome137/DeepSeekMonitor),UI 视觉方向沿用原项目并按 Windows Tauri 适配,感谢上游与原作者的开源贡献。

## 免责声明

本项目仅用于学习和研究目的。请遵守 DeepSeek 的使用条款,合理使用相关接口,避免频繁请求。

DeepSeek 平台页面结构、登录状态、WebView2 缓存和内部用量接口都可能变化,本项目不保证长期可用。**API Key 和用量 Token 属于敏感凭据,使用者需自行承担本机存储、账号安全、网络请求和数据展示带来的风险。**

## 许可证

本项目使用 MIT License。详见 [LICENSE](LICENSE)。
