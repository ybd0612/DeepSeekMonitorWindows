import React from "react";
import ReactDOM from "react-dom/client";
import { invoke } from "@tauri-apps/api/core";
import { emit, listen } from "@tauri-apps/api/event";
import { getVersion } from "@tauri-apps/api/app";
import { getCurrentWindow } from "@tauri-apps/api/window";
import {
  BarChart3,
  CalendarDays,
  CheckCircle2,
  Clipboard,
  CreditCard,
  Info,
  KeyRound,
  Power,
  RefreshCw,
  SlidersHorizontal,
  SunMedium,
  X,
  Zap,
} from "lucide-react";
import "./styles.css";

type ViewName = "dashboard" | "settings" | "detail";
type AppConfig = {
  apiKeyConfigured: boolean;
  apiKeyPreview: string | null;
  usageTokenConfigured: boolean;
  refreshIntervalSeconds: number;
  autoRefreshEnabled: boolean;
  autostart: boolean;
  windowOpacity: number;
  alwaysOnTop: boolean;
  showBalanceCard: boolean;
  visibleModels: string[];
  showChart: boolean;
  windowWidth: number;
  windowHeight: number;
  configPath: string;
};
type BalanceData = {
  isAvailable: boolean;
  currency: string;
  totalBalance: string;
  grantedBalance: string;
  toppedUpBalance: string;
};
type BalanceState = "loading" | "ok" | "error" | "nokey";

type UsageModel = {
  key: string;
  name: string;
  totalTokens: number;
  requestCount: number;
  cacheHitTokens: number;
  cacheMissTokens: number;
  responseTokens: number;
  cost: number;
};
type UsageModelDaily = {
  key: string;
  cacheHit: number;
  cacheMiss: number;
  response: number;
};
type UsageDay = {
  date: string;
  models: UsageModelDaily[];
  totalTokens: number;
  totalCost: number;
};
type UsageResult = {
  models: UsageModel[];
  days: UsageDay[];
  monthCost: number;
};

const fmtInt = (n: number) => Math.round(n).toLocaleString("en-US");
const fmtTokensShort = (n: number) => {
  if (n >= 1e8) return (n / 1e6).toFixed(0) + "M";
  if (n >= 1e6) return (n / 1e6).toFixed(1) + "M";
  if (n >= 1e3) return (n / 1e3).toFixed(1) + "K";
  return String(Math.round(n));
};
const fmtMoney = (n: number) => "¥" + n.toFixed(2);
const mmdd = (date: string) => {
  const parts = date.split("-");
  return parts.length === 3 ? `${Number(parts[1])}/${Number(parts[2])}` : date;
};
const todayStr = () => {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
};
const dateKey = (date: Date) =>
  `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
const addDays = (date: Date, offset: number) => {
  const next = new Date(date);
  next.setDate(next.getDate() + offset);
  return next;
};
const recentUsageDays = (days: UsageDay[], count = 7): UsageDay[] => {
  const source = new Map(days.filter((day) => day.date <= todayStr()).map((day) => [day.date, day]));
  const today = new Date();
  return Array.from({ length: count }, (_, index) => {
    const date = dateKey(addDays(today, index - count + 1));
    return (
      source.get(date) ?? {
        date,
        models: [],
        totalTokens: 0,
        totalCost: 0,
      }
    );
  });
};
const previousMonth = (date: Date) => {
  const previous = new Date(date.getFullYear(), date.getMonth() - 1, 1);
  return { month: previous.getMonth() + 1, year: previous.getFullYear() };
};
const fetchMonthUsage = (month: number, year: number) => {
  return invoke<UsageResult>("fetch_usage", { month, year });
};
const fetchCurrentUsage = async () => {
  const now = new Date();
  const current = await fetchMonthUsage(now.getMonth() + 1, now.getFullYear());
  const needsPreviousMonth = addDays(now, -6).getMonth() !== now.getMonth();
  if (!needsPreviousMonth) {
    return current;
  }
  try {
    const previous = previousMonth(now);
    const previousUsage = await fetchMonthUsage(previous.month, previous.year);
    return {
      ...current,
      days: [...previousUsage.days, ...current.days],
    };
  } catch {
    return current;
  }
};

const refreshOptions = [
  { label: "1 分钟", value: 60 },
  { label: "5 分钟", value: 300 },
  { label: "30 分钟", value: 1800 },
  { label: "1 小时", value: 3600 },
];

// 预设皮肤:value 即 documentElement 的 data-theme 值;colors 仅用于色块预览
const skinPresets = [
  { value: "dark", label: "暗金", colors: ["#4d6bfe", "#da38f0"] },
  { value: "light", label: "亮蓝", colors: ["#2d6cf6", "#7fd1f0"] },
  { value: "emerald", label: "翡翠", colors: ["#10b981", "#a3e635"] },
  { value: "violet", label: "罗兰", colors: ["#8b5cf6", "#f472b6"] },
  { value: "sunset", label: "晚霞", colors: ["#f97316", "#ef4444"] },
  { value: "graphite", label: "石墨", colors: ["#64748b", "#94a3b8"] },
];

// 整窗透明度:窗口已 transparent,对 documentElement 施加 CSS opacity 后,
// 内容整体 alpha 降低,桌面自然透出(含文字)。clamp 到 30–100,防止完全不可见。
const applyWindowOpacity = (percent: number) => {
  const clamped = Math.min(100, Math.max(30, percent));
  document.documentElement.style.opacity = String(clamped / 100);
};

// 模型行强调色:按模型 ID 哈希到一组色相,不写死 flash/pro 配色
const modelAccent = (key: string) => {
  let hash = 0;
  for (const ch of key) {
    hash = (hash * 31 + ch.charCodeAt(0)) | 0;
  }
  const hues = [205, 275, 145, 25, 330, 210, 190, 45];
  return `hsl(${hues[Math.abs(hash) % hues.length]} 72% 60%)`;
};

function App() {
  // 独立设置窗口(label="settings")只渲染设置页;主窗口渲染仪表盘/详情。
  // 浏览器预览无 Tauri,回退为主窗口视图。
  const [isSettingsWindow] = React.useState(() => {
    try {
      return getCurrentWindow().label === "settings";
    } catch {
      return false;
    }
  });
  const [view, setView] = React.useState<ViewName>(isSettingsWindow ? "settings" : "dashboard");
  const [model, setModel] = React.useState<string>("");

  const [balance, setBalance] = React.useState<BalanceData | null>(null);
  const [balanceState, setBalanceState] = React.useState<BalanceState>("loading");
  const [balanceError, setBalanceError] = React.useState("");

  const [usage, setUsage] = React.useState<UsageResult | null>(null);
  const [usageState, setUsageState] = React.useState<BalanceState>("loading");
  const [usageError, setUsageError] = React.useState("");
  const [refreshIntervalSeconds, setRefreshIntervalSeconds] = React.useState(60);
  const [autoRefreshEnabled, setAutoRefreshEnabled] = React.useState(false);
  const [showBalanceCard, setShowBalanceCard] = React.useState(true);
  const [visibleModels, setVisibleModels] = React.useState<string[]>([]);
  const [showChart, setShowChart] = React.useState(true);
  // 模型列表(来自官方 models 接口),供设置页列出每个模型;空 = 尚未取到
  const [availableModels, setAvailableModels] = React.useState<string[]>([]);

  const loadBalance = React.useCallback(() => {
    setBalanceState("loading");
    void invoke<BalanceData>("fetch_balance")
      .then((data) => {
        setBalance(data);
        setBalanceState("ok");
      })
      .catch((error) => {
        const message = typeof error === "string" ? error : "查询失败";
        setBalanceError(message);
        setBalanceState(message.includes("未配置") ? "nokey" : "error");
      });
  }, []);

  const loadUsage = React.useCallback(() => {
    setUsageState("loading");
    void fetchCurrentUsage()
      .then((data) => {
        setUsage(data);
        setUsageState("ok");
        setUsageError("");
      })
      .catch((error) => {
        const message = typeof error === "string" ? error : "查询失败";
        setUsageError(message);
        setUsage(null);
        setUsageState(message.includes("未配置") ? "nokey" : "error");
      });
  }, []);

  const refreshAll = React.useCallback(() => {
    loadBalance();
    loadUsage();
  }, [loadBalance, loadUsage]);

  React.useEffect(() => {
    if (isSettingsWindow) {
      // 设置窗口只拉用量,用于动态模型列表(不拉余额)
      loadUsage();
      return;
    }
    refreshAll();
  }, [refreshAll, loadUsage, isSettingsWindow]);

  React.useEffect(() => {
    void invoke<AppConfig>("get_app_config")
      .then((config) => {
        setRefreshIntervalSeconds(config.refreshIntervalSeconds || 60);
        setAutoRefreshEnabled(config.autoRefreshEnabled);
        setShowBalanceCard(config.showBalanceCard);
        setVisibleModels(config.visibleModels ?? []);
        setShowChart(config.showChart);
        // 整窗透明度只作用于主面板,设置窗口保持实心
        if (!isSettingsWindow) {
          applyWindowOpacity(Math.round((config.windowOpacity ?? 1) * 100));
          // 窗口完全显示后由前端重新应用置顶:规避启动时 Rust setup 的
          // set_always_on_top 在窗口未完全显示前调用导致未真正落位的竞态
          try {
            void getCurrentWindow().setAlwaysOnTop(config.alwaysOnTop).catch(() => {});
          } catch {
            // 浏览器预览无 Tauri
          }
        }
      })
      .catch(() => {
        setRefreshIntervalSeconds(60);
        setAutoRefreshEnabled(false);
        if (!isSettingsWindow) {
          applyWindowOpacity(100);
        }
      });
  }, [isSettingsWindow]);

  // 拉取官方模型列表,供设置页选择要显示的模型;失败(如未配置 Key)留空,
  // 设置页会回退到用量数据中实际出现的模型。
  React.useEffect(() => {
    void invoke<string[]>("fetch_models")
      .then((models) => {
        setAvailableModels(Array.isArray(models) ? models : []);
      })
      .catch(() => {});
  }, []);

  // 记住用户拖拽后的窗口尺寸与位置,写入配置供 Rust 显示/重启时恢复。
  // 浏览器预览模式下没有 Tauri 窗口,静默跳过。
  React.useEffect(() => {
    let unlistenResize: (() => void) | undefined;
    let unlistenMove: (() => void) | undefined;
    let saveTimer: number | undefined;
    let moveTimer: number | undefined;
    try {
      const win = getCurrentWindow();
      win
        .onResized(({ payload }) => {
          window.clearTimeout(saveTimer);
          saveTimer = window.setTimeout(() => {
            void invoke("save_window_size", { width: payload.width, height: payload.height }).catch(
              () => {
                // no-op: 非 Tauri 环境
              },
            );
          }, 400);
        })
        .then((fn) => {
          unlistenResize = fn;
        })
        .catch(() => {});
      win
        .onMoved(({ payload }) => {
          window.clearTimeout(moveTimer);
          moveTimer = window.setTimeout(() => {
            void invoke("save_window_position", { x: payload.x, y: payload.y }).catch(() => {});
          }, 400);
        })
        .then((fn) => {
          unlistenMove = fn;
        })
        .catch(() => {});
    } catch {
      // 浏览器预览无 Tauri 窗口,静默跳过
    }
    return () => {
      window.clearTimeout(saveTimer);
      window.clearTimeout(moveTimer);
      unlistenResize?.();
      unlistenMove?.();
    };
  }, []);

  React.useEffect(() => {
    if (isSettingsWindow || !autoRefreshEnabled) {
      return;
    }
    const timer = window.setInterval(refreshAll, refreshIntervalSeconds * 1000);
    return () => window.clearInterval(timer);
  }, [autoRefreshEnabled, isSettingsWindow, refreshAll, refreshIntervalSeconds]);

  // 跨窗口实时同步:设置窗口改动后,主窗口跟随更新。
  // - display-config-changed: 透明度 / 区块显示开关
  // - theme-changed: 换肤
  // - refresh-data: 托盘菜单「刷新数据」
  // 浏览器预览无 Tauri,静默跳过。
  React.useEffect(() => {
    let unlistenConfig: (() => void) | undefined;
    let unlistenTheme: (() => void) | undefined;
    let unlistenRefresh: (() => void) | undefined;
    void listen<AppConfig>("display-config-changed", (event) => {
      if (isSettingsWindow) {
        return; // 设置窗口自己已从命令返回值更新状态
      }
      setShowBalanceCard(event.payload.showBalanceCard);
      setVisibleModels(event.payload.visibleModels ?? []);
      setShowChart(event.payload.showChart);
      applyWindowOpacity(Math.round((event.payload.windowOpacity ?? 1) * 100));
      // 置顶由前端窗口 API 直接再断言,双保险确保生效
      try {
        void getCurrentWindow().setAlwaysOnTop(event.payload.alwaysOnTop).catch(() => {});
      } catch {
        // 浏览器预览无 Tauri
      }
    })
      .then((fn) => {
        unlistenConfig = fn;
      })
      .catch(() => {});
    void listen<string>("theme-changed", (event) => {
      document.documentElement.setAttribute("data-theme", event.payload);
    })
      .then((fn) => {
        unlistenTheme = fn;
      })
      .catch(() => {});
    void listen("refresh-data", () => refreshAll())
      .then((fn) => {
        unlistenRefresh = fn;
      })
      .catch(() => {});
    return () => {
      unlistenConfig?.();
      unlistenTheme?.();
      unlistenRefresh?.();
    };
  }, [isSettingsWindow, refreshAll]);

  return (
    <div className="stage">
      {view === "dashboard" && (
        <DashboardPanel
          balance={balance}
          balanceState={balanceState}
          balanceError={balanceError}
          usage={usage}
          usageState={usageState}
          usageError={usageError}
          onDetail={(nextModel) => {
            setModel(nextModel);
            setView("detail");
          }}
          showBalanceCard={showBalanceCard}
          visibleModels={visibleModels}
          showChart={showChart}
        />
      )}
      {view === "settings" && (
        <SettingsPanel
          onUsageLoaded={(nextUsage) => {
            setUsage(nextUsage);
            setUsageState("ok");
            setUsageError("");
          }}
          onUsageCleared={() => {
            setUsage(null);
            setUsageState("nokey");
            setUsageError("未配置用量 Token");
          }}
          onRefreshIntervalChanged={setRefreshIntervalSeconds}
          onAutoRefreshChanged={setAutoRefreshEnabled}
          availableModels={availableModels}
          usageModelKeys={(usage?.models ?? [])
            .filter((item) => item.requestCount > 0 || item.totalTokens > 0)
            .map((item) => item.key)}
          onVisibilityChanged={({ showBalanceCard: b, visibleModels: v, showChart: c }) => {
            setShowBalanceCard(b);
            setVisibleModels(v);
            setShowChart(c);
          }}
          onBack={() => {
            if (isSettingsWindow) {
              // 独立设置窗口:返回即关闭本窗口,主面板保持显示
              try {
                void getCurrentWindow().close().catch(() => {});
              } catch {
                // 浏览器预览无 Tauri
              }
            } else {
              setView("dashboard");
            }
          }}
        />
      )}
      {view === "detail" && (
        <ModelDetailPanel model={model} usage={usage} usageState={usageState} onBack={() => setView("dashboard")} />
      )}
    </div>
  );
}

function BrandIcon({ size = 32 }: { size?: number }) {
  return (
    <div className="brand-icon" style={{ width: size, height: size }}>
      <img src="/assets/deepseek-color.png" alt="DeepSeek" />
    </div>
  );
}

function DashboardPanel({
  balance,
  balanceState,
  balanceError,
  usage,
  usageState,
  usageError,
  onDetail,
  showBalanceCard,
  visibleModels,
  showChart,
}: {
  balance: BalanceData | null;
  balanceState: BalanceState;
  balanceError: string;
  usage: UsageResult | null;
  usageState: BalanceState;
  usageError: string;
  onDetail: (model: string) => void;
  showBalanceCard: boolean;
  visibleModels: string[];
  showChart: boolean;
}) {
  // 模型行由用量数据驱动:只显示本月有实际使用记录的模型(排除 legacy 空壳),
  // 空 visibleModels = 全部显示
  const visibleKeys = visibleModels.length > 0 ? new Set(visibleModels) : null;
  const modelRows = (usage?.models ?? [])
    .filter((item) => item.requestCount > 0 || item.totalTokens > 0)
    .filter((item) => (visibleKeys ? visibleKeys.has(item.key) : true));
  const maxTokens = Math.max(...modelRows.map((item) => item.totalTokens), 1);
  const today = usage?.days.find((day) => day.date === todayStr()) ?? null;
  const todayCost = usageState === "ok" && today ? today.totalCost : null;
  const monthCost = usageState === "ok" && usage ? usage.monthCost : null;

  return (
    <section className="panel dashboard-panel" data-testid="dashboard-panel">
      {/* 顶部仅保留拖拽区,标题与图标已移除 */}
      <header className="panel-header" data-tauri-drag-region />

      {showBalanceCard && (
        <BalanceCard
          balance={balance}
          state={balanceState}
          error={balanceError}
          todayCost={todayCost}
          monthCost={monthCost}
        />
      )}

      {modelRows.length > 0 && (
        <div className="usage-stack">
          {modelRows.map((item) => (
            <UsageRow
              key={item.key}
              data={item}
              accent={modelAccent(item.key)}
              maxTokens={maxTokens}
              state={usageState}
              onClick={() => onDetail(item.key)}
            />
          ))}
        </div>
      )}
      {modelRows.length === 0 && usageState === "loading" && (
        <div className="chart-placeholder">模型用量查询中…</div>
      )}

      {showChart && <UsageChart usage={usage} state={usageState} error={usageError} />}

      {!showBalanceCard && modelRows.length === 0 && !showChart && (
        <div className="chart-placeholder">已隐藏全部区块,可在设置中恢复显示</div>
      )}
    </section>
  );
}

function BalanceCard({
  balance,
  state,
  error,
  todayCost,
  monthCost,
}: {
  balance: BalanceData | null;
  state: BalanceState;
  error: string;
  todayCost: number | null;
  monthCost: number | null;
}) {
  const symbol = balance?.currency === "USD" ? "$" : "¥";
  const amount =
    state === "loading"
      ? "查询中…"
      : state === "nokey"
        ? "未配置"
        : state === "error"
          ? "查询失败"
          : `${symbol}${balance?.totalBalance ?? "0.00"}`;
  const statusText = state === "ok" ? (balance?.isAvailable ? "可用" : "余额不足") : "—";
  const statusOff = state === "ok" && balance != null && !balance.isAvailable;

  return (
    <article className="card balance-card">
      <div className="card-title-row">
        <div className="caption-with-icon">
          <CreditCard size={15} />
          <span>账户余额</span>
        </div>
        <div className={`status-pill ${statusOff ? "off" : ""}`}>
          <span />
          {statusText}
        </div>
      </div>
      <div className={`balance-amount ${state !== "ok" ? "balance-dim" : ""}`}>{amount}</div>
      {state === "error" && <div className="balance-error">{error}</div>}
      <div className="metric-grid">
        <div className="mini-card">
          <div className="caption-with-icon orange">
            <SunMedium size={15} />
            <span>当日消耗</span>
          </div>
          <strong>{todayCost != null ? fmtMoney(todayCost) : "—"}</strong>
        </div>
        <div className="mini-card">
          <div className="caption-with-icon orange">
            <CalendarDays size={15} />
            <span>本月消费</span>
          </div>
          <strong>{monthCost != null ? fmtMoney(monthCost) : "—"}</strong>
        </div>
      </div>
    </article>
  );
}

function UsageRow({
  data,
  accent,
  maxTokens,
  state,
  onClick,
}: {
  data: UsageModel | null;
  accent: string;
  maxTokens: number;
  state: BalanceState;
  onClick: () => void;
}) {
  const tokensText = data
    ? `${fmtInt(data.totalTokens)} Tokens`
    : state === "loading"
      ? "查询中…"
      : state === "nokey"
        ? "未配置 Token"
        : state === "error"
          ? "用量不可用"
          : "—";
  const cost = data ? fmtMoney(data.cost) : "—";
  const ratio = data && data.cost > 0 ? `${fmtTokensShort(data.totalTokens / data.cost)} T/¥` : "—";
  const width = data ? `${Math.max(2, (data.totalTokens / maxTokens) * 100)}%` : "0%";

  return (
    <button className="card usage-row" onClick={onClick}>
      <div className="model-badge" style={{ color: accent, background: `${accent}22` }}>
        <Zap size={27} fill="currentColor" />
      </div>
      <div className="usage-main">
        <h2>{data?.name ?? "模型"}</h2>
        <div className="token-line">
          <span>{tokensText}</span>
          <div className="progress-track">
            <i style={{ width, background: accent }} />
          </div>
        </div>
        {data && data.cacheHitTokens + data.cacheMissTokens > 0 && (
          <span className="cache-hit-rate" style={{ color: accent }}>
            缓存命中{" "}
            {((data.cacheHitTokens / (data.cacheHitTokens + data.cacheMissTokens)) * 100).toFixed(0)}%
          </span>
        )}
      </div>
      <div className="usage-price">
        <strong>{cost}</strong>
        <span>{ratio}</span>
      </div>
    </button>
  );
}

function UsageChart({
  usage,
  state,
  error,
}: {
  usage: UsageResult | null;
  state: BalanceState;
  error: string;
}) {
  const [hoveredIdx, setHoveredIdx] = React.useState<number | null>(null);
  const MIN_BAR = 3;
  const days = recentUsageDays(usage?.days ?? []);
  const points = days.map((day) => {
    // 全模型聚合,不分模型
    const hit = day.models.reduce((sum, item) => sum + item.cacheHit, 0);
    const miss = day.models.reduce((sum, item) => sum + item.cacheMiss, 0);
    const response = day.models.reduce((sum, item) => sum + item.response, 0);
    return { date: day.date, hit, miss, response, total: hit + miss + response };
  });
  const maxVal = Math.max(...points.map((point) => point.total), 1);
  const sumHit = points.reduce((sum, point) => sum + point.hit, 0);
  const sumMiss = points.reduce((sum, point) => sum + point.miss, 0);
  const sumTotal = points.reduce((sum, point) => sum + point.total, 0);
  const hitRate = sumHit + sumMiss > 0 ? ((sumHit / (sumHit + sumMiss)) * 100).toFixed(0) : "0";
  const placeholder =
    state === "loading"
      ? "查询中…"
      : state === "nokey"
        ? "未配置用量 Token"
        : state === "error"
          ? error
          : "暂无数据";

  return (
    <article className="card chart-card">
      <div className="card-title-row">
        <div className="caption-with-icon">
          <BarChart3 size={16} className="brand-blue" />
          <span>缓存命中明细</span>
        </div>
        <span className="chart-total">
          {state === "ok" ? `命中率 ${hitRate}% · 合计 ${fmtTokensShort(sumTotal)}` : "—"}
        </span>
      </div>
      {state === "ok" && points.length > 0 ? (
        <>
          <div className="bars" onMouseLeave={() => setHoveredIdx(null)}>
            {points.map((point, idx) => (
              <div className="bar-column" key={point.date}>
                {hoveredIdx === idx && point.total > 0 && (
                  <div
                    className={`bar-tooltip${
                      idx <= 1 ? " align-left" : idx >= points.length - 2 ? " align-right" : ""
                    }`}
                  >
                    <div className="bar-tooltip-head">
                      <span className="bar-tooltip-date">{point.date}</span>
                      <strong>{fmtInt(point.total)} tokens</strong>
                    </div>
                    <span className="bar-tooltip-row">
                      <i className="dot hit" />输入（命中缓存）
                      <strong>{fmtInt(point.hit)} tokens</strong>
                    </span>
                    <span className="bar-tooltip-row">
                      <i className="dot miss" />输入（未命中缓存）
                      <strong>{fmtInt(point.miss)} tokens</strong>
                    </span>
                    <span className="bar-tooltip-row">
                      <i className="dot response" />输出
                      <strong>{fmtInt(point.response)} tokens</strong>
                    </span>
                  </div>
                )}
                <span className="bar-value">
                  {point.total > 0 ? fmtTokensShort(point.total) : "0"}
                </span>
                <div className="bar-slot">
                  <div
                    className="cache-bar"
                    style={{
                      height: `${point.total > 0 ? Math.max(MIN_BAR, (point.total / maxVal) * 100) : MIN_BAR}%`,
                    }}
                    onMouseEnter={() => setHoveredIdx(idx)}
                    onMouseLeave={() => setHoveredIdx(null)}
                  >
                    {point.total > 0 ? (
                      <>
                        {point.hit > 0 && <i className="seg hit" style={{ flexGrow: point.hit }} />}
                        {point.miss > 0 && <i className="seg miss" style={{ flexGrow: point.miss }} />}
                        {point.response > 0 && (
                          <i className="seg response" style={{ flexGrow: point.response }} />
                        )}
                      </>
                    ) : (
                      <i className="seg empty" />
                    )}
                  </div>
                </div>
                <span className="bar-day">{mmdd(point.date)}</span>
              </div>
            ))}
          </div>
          <div className="chart-legend-bottom">
            <span className="chart-legend-item">
              <i className="dot hit" />命中
            </span>
            <span className="chart-legend-item">
              <i className="dot miss" />未命中
            </span>
            <span className="chart-legend-item">
              <i className="dot response" />输出
            </span>
          </div>
        </>
      ) : (
        <div className="chart-placeholder">{placeholder}</div>
      )}
    </article>
  );
}

function SettingsPanel({
  onBack,
  onUsageLoaded,
  onUsageCleared,
  onRefreshIntervalChanged,
  onAutoRefreshChanged,
  onVisibilityChanged,
  availableModels,
  usageModelKeys,
}: {
  onBack: () => void;
  onUsageLoaded: (usage: UsageResult) => void;
  onUsageCleared: () => void;
  onRefreshIntervalChanged: (seconds: number) => void;
  onAutoRefreshChanged: (enabled: boolean) => void;
  onVisibilityChanged: (visibility: {
    showBalanceCard: boolean;
    visibleModels: string[];
    showChart: boolean;
  }) => void;
  availableModels: string[];
  usageModelKeys: string[];
}) {
  const [apiKey, setApiKey] = React.useState("");
  const [config, setConfig] = React.useState<AppConfig | null>(null);
  const [status, setStatus] = React.useState("正在读取本地配置");
  const [busy, setBusy] = React.useState(false);
  const [refresh, setRefresh] = React.useState(60);
  const [autoRefresh, setAutoRefresh] = React.useState(false);
  const [autostart, setAutostart] = React.useState(false);
  const [usageToken, setUsageToken] = React.useState("");
  const [usageStatus, setUsageStatus] = React.useState("");
  const [usageSyncing, setUsageSyncing] = React.useState(false);
  const [showManualPaste, setShowManualPaste] = React.useState(false);
  const [appVersion, setAppVersion] = React.useState("1.1.0");
  const [opacity, setOpacity] = React.useState(100);
  const [alwaysOnTop, setAlwaysOnTop] = React.useState(false);
  const [showBalanceCard, setShowBalanceCard] = React.useState(true);
  const [visibleModels, setVisibleModels] = React.useState<string[]>([]);
  const [showChart, setShowChart] = React.useState(true);
  const [theme, setTheme] = React.useState<string>(
    () => localStorage.getItem("ui-theme") || "dark",
  );
  // 配置加载完成前禁止持久化透明度,避免用默认值覆盖用户已保存的显示设置
  const displayLoadedRef = React.useRef(false);

  // 换肤:预设皮肤写 localStorage 与 documentElement data-theme,
  // 并广播 theme-changed 让主窗口实时跟随(设置窗口与主窗口各自独立 DOM)。
  const selectSkin = React.useCallback((value: string) => {
    setTheme(value);
    localStorage.setItem("ui-theme", value);
    document.documentElement.setAttribute("data-theme", value);
    void emit("theme-changed", value).catch(() => {});
  }, []);
  const configPath = config?.configPath ?? "%APPDATA%\\DeepSeekMonitorWindows\\config.json";

  React.useEffect(() => {
    void invoke<AppConfig>("get_app_config")
      .then((nextConfig) => {
        setConfig(nextConfig);
        setRefresh(nextConfig.refreshIntervalSeconds || 60);
        setAutoRefresh(nextConfig.autoRefreshEnabled);
        setAutostart(nextConfig.autostart);
        setOpacity(Math.round((nextConfig.windowOpacity ?? 1) * 100));
        setAlwaysOnTop(nextConfig.alwaysOnTop);
        setShowBalanceCard(nextConfig.showBalanceCard);
        setVisibleModels(nextConfig.visibleModels ?? []);
        setShowChart(nextConfig.showChart);
        setStatus(nextConfig.apiKeyConfigured ? `已配置 ${nextConfig.apiKeyPreview}` : "未配置 API Key");
        setUsageStatus(nextConfig.usageTokenConfigured ? "用量 Token 已配置" : "未配置用量 Token");
        displayLoadedRef.current = true;
      })
      .catch(() => {
        setStatus("浏览器预览模式，未连接本地配置");
      });
  }, []);

  React.useEffect(() => {
    void getVersion()
      .then(setAppVersion)
      .catch(() => setAppVersion("1.1.0"));
  }, []);

  const refreshUsageAfterToken = React.useCallback(
    (prefix: string) => {
      setUsageStatus(`${prefix}，正在刷新用量数据…`);
      return fetchCurrentUsage()
        .then((usage) => {
          onUsageLoaded(usage);
          setUsageStatus(`${prefix}，本月消费 ${fmtMoney(usage.monthCost)}`);
          return usage;
        })
        .catch((error) => {
          const message = typeof error === "string" ? error : "用量刷新失败";
          setUsageStatus(`${prefix}，但用量刷新失败：${message}`);
          throw error;
        });
    },
    [onUsageLoaded],
  );

  React.useEffect(() => {
    const unlistenPromise = listen<AppConfig>("usage-token-captured", (event) => {
      setConfig(event.payload);
      setUsageSyncing(false);
      void refreshUsageAfterToken("已通过网页登录自动同步用量 Token");
    });
    return () => {
      void unlistenPromise.then((unlisten) => unlisten());
    };
  }, [refreshUsageAfterToken]);

  React.useEffect(() => {
    const unlistenPromise = listen("usage-sync-ended", () => {
      setUsageSyncing(false);
      setUsageStatus("登录窗口已关闭，Token 未获取到。可重新点击同步或使用方式二手动粘贴。");
    });
    return () => {
      void unlistenPromise.then((unlisten) => unlisten());
    };
  }, []);

  const pasteApiKey = React.useCallback(async () => {
    try {
      const text = await navigator.clipboard.readText();
      setApiKey(text.trim());
      setStatus("已从剪贴板读取");
    } catch {
      setStatus("剪贴板读取失败");
    }
  }, []);

  const saveApiKey = React.useCallback(() => {
    setBusy(true);
    void invoke<AppConfig>("save_api_key", { apiKey })
      .then((nextConfig) => {
        setConfig(nextConfig);
        setApiKey("");
        setStatus("已保存，正在验证 Key…");
        return invoke<BalanceData>("fetch_balance");
      })
      .then((balance) => {
        const symbol = balance.currency === "USD" ? "$" : "¥";
        const tip = balance.isAvailable ? "" : "（余额不足）";
        setStatus(`验证通过，当前余额 ${symbol}${balance.totalBalance}${tip}`);
      })
      .catch((error) => {
        setStatus(typeof error === "string" ? error : "保存或验证失败");
      })
      .finally(() => setBusy(false));
  }, [apiKey]);

  const clearApiKey = React.useCallback(() => {
    setBusy(true);
    void invoke<AppConfig>("clear_api_key")
      .then((nextConfig) => {
        setConfig(nextConfig);
        setApiKey("");
        setStatus("已清除 API Key");
      })
      .catch((error) => {
        setStatus(typeof error === "string" ? error : "清除失败");
      })
      .finally(() => setBusy(false));
  }, []);

  const pasteUsageToken = React.useCallback(async () => {
    try {
      const text = await navigator.clipboard.readText();
      setUsageToken(text.trim());
      setUsageStatus("已从剪贴板读取");
    } catch {
      setUsageStatus("剪贴板读取失败");
    }
  }, []);

  const startUsageSync = React.useCallback(() => {
    setUsageSyncing(true);
    setUsageStatus("正在打开登录窗口…");
    void invoke<boolean>("start_usage_sync")
      .then((synced) => {
        if (!synced) {
          setUsageStatus("登录完成后，再次点击本按钮即可同步用量（可多点几次）");
        }
        // synced=true 时由 usage-token-captured 事件刷新数据并更新状态
      })
      .catch((error) => {
        setUsageStatus(typeof error === "string" ? error : "打开登录窗口失败");
      })
      .finally(() => {
        // 短暂忙碌后自动恢复可点击，允许用户登录后反复点击触发同步
        window.setTimeout(() => setUsageSyncing(false), 2500);
      });
  }, []);

  const saveUsageToken = React.useCallback(() => {
    setBusy(true);
    void invoke<AppConfig>("save_usage_token", { usageToken })
      .then((nextConfig) => {
        setConfig(nextConfig);
        setUsageToken("");
        setUsageStatus("已保存，正在验证用量 Token…");
        return refreshUsageAfterToken("手动 Token 已保存");
      })
      .catch((error) => {
        setUsageStatus(typeof error === "string" ? error : "保存或验证失败");
      })
      .finally(() => setBusy(false));
  }, [refreshUsageAfterToken, usageToken]);

  const clearUsageToken = React.useCallback(() => {
    setBusy(true);
    void invoke<AppConfig>("clear_usage_token")
      .then((nextConfig) => {
        setConfig(nextConfig);
        setUsageToken("");
        setUsageStatus("已清除用量 Token");
        onUsageCleared();
      })
      .catch((error) => {
        setUsageStatus(typeof error === "string" ? error : "清除失败");
      })
      .finally(() => setBusy(false));
  }, [onUsageCleared]);

  const saveRefreshInterval = React.useCallback(
    (seconds: number) => {
      const previous = refresh;
      setRefresh(seconds);
      onRefreshIntervalChanged(seconds);
      void invoke<AppConfig>("save_refresh_interval", { refreshIntervalSeconds: seconds })
        .then((nextConfig) => {
          setConfig(nextConfig);
          setRefresh(nextConfig.refreshIntervalSeconds || 60);
          onRefreshIntervalChanged(nextConfig.refreshIntervalSeconds || 60);
        })
        .catch(() => {
          setRefresh(previous);
          onRefreshIntervalChanged(previous);
        });
    },
    [onRefreshIntervalChanged, refresh],
  );

  const saveAutoRefreshEnabled = React.useCallback(
    (enabled: boolean) => {
      const previous = autoRefresh;
      setAutoRefresh(enabled);
      onAutoRefreshChanged(enabled);
      void invoke<AppConfig>("save_auto_refresh_enabled", { autoRefreshEnabled: enabled })
        .then((nextConfig) => {
          setConfig(nextConfig);
          setAutoRefresh(nextConfig.autoRefreshEnabled);
          onAutoRefreshChanged(nextConfig.autoRefreshEnabled);
        })
        .catch(() => {
          setAutoRefresh(previous);
          onAutoRefreshChanged(previous);
        });
    },
    [autoRefresh, onAutoRefreshChanged],
  );

  const saveAutostart = React.useCallback((enabled: boolean) => {
    const previous = autostart;
    setAutostart(enabled);
    void invoke<AppConfig>("save_autostart", { autostart: enabled })
      .then((nextConfig) => {
        setConfig(nextConfig);
        setAutostart(nextConfig.autostart);
      })
      .catch(() => setAutostart(previous));
  }, [autostart]);

  const opacitySaveTimer = React.useRef<number | undefined>(undefined);

  // 透明度滑杆:拖动时本地即时反馈,400ms 防抖后统一持久化并实时应用到窗口。
  // 配置加载完成前不持久化,避免用默认值覆盖用户已保存的设置。
  const persistDisplay = React.useCallback((nextOpacity: number, nextOnTop: boolean) => {
    if (!displayLoadedRef.current) {
      return;
    }
    window.clearTimeout(opacitySaveTimer.current);
    opacitySaveTimer.current = window.setTimeout(() => {
      void invoke<AppConfig>("save_display_settings", {
        opacity: nextOpacity / 100,
        alwaysOnTop: nextOnTop,
      })
        .then((nextConfig) => {
          setConfig(nextConfig);
          setOpacity(Math.round((nextConfig.windowOpacity ?? 1) * 100));
          setAlwaysOnTop(nextConfig.alwaysOnTop);
        })
        .catch(() => {
          // 保存失败保持当前 UI,不强制回滚,避免滑杆跳动
        });
    }, 400);
  }, []);

  const saveOnTop = React.useCallback(
    (enabled: boolean) => {
      setAlwaysOnTop(enabled);
      persistDisplay(opacity, enabled);
    },
    [opacity, persistDisplay],
  );

  // 统一持久化可见性配置(余额卡 / 可见模型列表 / 图表),成功后同步回本地与父级
  const persistVisibility = React.useCallback(
    (next: { showBalanceCard: boolean; visibleModels: string[]; showChart: boolean }) => {
      void invoke<AppConfig>("save_visibility", next)
        .then((nextConfig) => {
          setConfig(nextConfig);
          setShowBalanceCard(nextConfig.showBalanceCard);
          setVisibleModels(nextConfig.visibleModels ?? []);
          setShowChart(nextConfig.showChart);
          onVisibilityChanged({
            showBalanceCard: nextConfig.showBalanceCard,
            visibleModels: nextConfig.visibleModels ?? [],
            showChart: nextConfig.showChart,
          });
        })
        .catch(() => {
          setShowBalanceCard(showBalanceCard);
          setVisibleModels(visibleModels);
          setShowChart(showChart);
        });
    },
    [showBalanceCard, visibleModels, showChart, onVisibilityChanged],
  );

  const toggleBalanceCard = React.useCallback(
    (value: boolean) => persistVisibility({ showBalanceCard: value, visibleModels, showChart }),
    [persistVisibility, visibleModels, showChart],
  );
  const toggleChart = React.useCallback(
    (value: boolean) => persistVisibility({ showBalanceCard, visibleModels, showChart: value }),
    [persistVisibility, showBalanceCard, visibleModels],
  );

  // 模型开关列表:优先用户实际用过的模型(usageModelKeys,已过滤零使用);
  // 无用量数据时回退到官方 models 接口的完整列表
  const allModels = React.useMemo(() => {
    if (usageModelKeys.length > 0) {
      return usageModelKeys;
    }
    return availableModels;
  }, [availableModels, usageModelKeys]);
  const visibleSet = React.useMemo(
    () => (visibleModels.length > 0 ? new Set(visibleModels) : null),
    [visibleModels],
  );

  const toggleModel = React.useCallback(
    (key: string, on: boolean) => {
      const base = new Set(visibleModels.length > 0 ? visibleModels : allModels);
      if (on) {
        base.add(key);
      } else {
        base.delete(key);
      }
      // 全部开启时回落为空列表(= 全部显示),保持配置最小化
      const allOn = allModels.length > 0 && allModels.every((item) => base.has(item));
      persistVisibility({
        showBalanceCard,
        visibleModels: allOn ? [] : Array.from(base),
        showChart,
      });
    },
    [allModels, persistVisibility, showBalanceCard, showChart, visibleModels],
  );

  return (
    <section className="settings-panel" data-testid="settings-panel">
      <button className="floating-close settings-close" onClick={onBack} aria-label="返回主面板">
        <X size={20} />
      </button>
      <header className="settings-header" data-tauri-drag-region>
        <BrandIcon size={42} />
        <div>
          <h1>DeepSeek Monitor</h1>
          <p>设置</p>
        </div>
      </header>

      <div className="settings-inner">
        <SettingsSection icon={<KeyRound size={15} />} title="API Key">
          <p>用于调用 DeepSeek API 获取余额和用量数据。当前 Windows 版本会保存在应用本地设置中。</p>
          <p className="muted">API Key 只在当前这台 Windows 电脑本地保留。</p>
          <p className="muted config-path">
            <span>本地位置：</span>
            <span>{configPath}</span>
          </p>
          <div className="key-row">
            <input
              aria-label="API Key"
              type="password"
              value={apiKey}
              placeholder={config?.apiKeyConfigured ? "••••••••••••••••••••••••••••••••••••••••••••••••••" : "sk-..."}
              onChange={(event) => setApiKey(event.target.value)}
            />
          </div>
          <div className="settings-actions">
            <button className="primary" onClick={saveApiKey} disabled={busy || !apiKey.trim()}>
              验证并保存
            </button>
            <span className={config?.apiKeyConfigured ? "configured" : "configured muted-status"}>
              <CheckCircle2 size={17} />
              {config?.apiKeyConfigured ? "已配置" : "未配置"}
            </span>
            <button className="secondary" onClick={clearApiKey} disabled={busy || !config?.apiKeyConfigured}>
              清除 Key
            </button>
          </div>
        </SettingsSection>

        <SettingsSection icon={<BarChart3 size={15} />} title="用量同步 Token">
          <p>用于同步 Token 用量、消费和趋势图。DeepSeek 无官方用量 API，需网页登录 token（与上面的 API Key 不同）。</p>
          <p className="muted">方式一网页登录自动同步</p>
          <div className="settings-actions usage-sync-actions">
            <button className="primary" onClick={startUsageSync} disabled={usageSyncing}>
              {usageSyncing ? "等待登录" : "网页登录自动同步"}
            </button>
            <span className={config?.usageTokenConfigured ? "configured" : "configured muted-status"}>
              <CheckCircle2 size={17} />
              {config?.usageTokenConfigured ? "已配置" : "未配置"}
            </span>
            <button className="secondary" onClick={clearUsageToken} disabled={busy || !config?.usageTokenConfigured}>
              清除 Token
            </button>
          </div>
          <p className="muted">{usageStatus}</p>
          <button
            className="link-button"
            onClick={() => setShowManualPaste((value) => !value)}
          >
            {showManualPaste ? "收起手动粘贴" : "方式二：手动粘贴 token"}
          </button>
          {showManualPaste && (
            <>
              <p className="muted">
                获取：浏览器登录 platform.deepseek.com，按 F12 打开控制台，输入
                JSON.parse(localStorage.userToken).value 回车，复制返回的字符串。
              </p>
              <p className="muted">token 会过期，用量查询失败时重新获取一次即可。</p>
              <div className="key-row">
                <input
                  aria-label="用量 Token"
                  type="password"
                  value={usageToken}
                  placeholder={config?.usageTokenConfigured ? "••••••••••••••••••••••••••••••••••••••••••••••••••" : ""}
                  onChange={(event) => setUsageToken(event.target.value)}
                />
              </div>
              <div className="settings-actions">
                <button className="primary" onClick={saveUsageToken} disabled={busy || !usageToken.trim()}>
                  保存 Token
                </button>
              </div>
            </>
          )}
        </SettingsSection>

        <SettingsSection icon={<Power size={15} />} title="开机自启">
          <p>开启后，每次登录 Windows 时自动启动 DeepSeek Monitor。</p>
          <Toggle label="登录时自动启动" checked={autostart} onChange={saveAutostart} />
        </SettingsSection>

        <SettingsSection icon={<RefreshCw size={15} />} title="自动刷新">
          <p>开启后，按设定周期自动从 DeepSeek API 拉取最新数据。</p>
          <Toggle label="启用自动刷新" checked={autoRefresh} onChange={saveAutoRefreshEnabled} />
          {autoRefresh && (
            <div className="segmented">
              {refreshOptions.map((option) => (
                <button
                  key={option.value}
                  className={refresh === option.value ? "selected" : ""}
                  onClick={() => saveRefreshInterval(option.value)}
                >
                  {option.label}
                </button>
              ))}
            </div>
          )}
        </SettingsSection>

        <SettingsSection icon={<SlidersHorizontal size={15} />} title="显示设置">
          <p>调节窗口显示方式与主面板内容。</p>
          <div className="settings-block">
            <p className="muted">外观(选择皮肤)</p>
            <div className="skin-grid">
              {skinPresets.map((skin) => (
                <button
                  key={skin.value}
                  className={`skin-option${theme === skin.value ? " selected" : ""}`}
                  onClick={() => selectSkin(skin.value)}
                  title={skin.label}
                >
                  <i
                    className="skin-swatch"
                    style={{ background: `linear-gradient(135deg, ${skin.colors[0]}, ${skin.colors[1]})` }}
                  />
                  <span>{skin.label}</span>
                </button>
              ))}
            </div>
          </div>
          <div className="settings-block">
            <p className="muted">窗口透明度(含文字,可透视桌面)</p>
            <div className="opacity-row">
              <input
                aria-label="窗口透明度"
                type="range"
                min={30}
                max={100}
                step={5}
                value={opacity}
                onChange={(event) => {
                  const nextOpacity = Number(event.target.value);
                  setOpacity(nextOpacity);
                  // 不作用于本窗口;主窗口经 save_display_settings → 事件实时跟随
                  persistDisplay(nextOpacity, alwaysOnTop);
                }}
              />
              <strong>{opacity}%</strong>
            </div>
            <Toggle label="窗口始终置顶" checked={alwaysOnTop} onChange={saveOnTop} />
          </div>
          <div className="settings-block">
            <p className="muted">主面板内容显示</p>
            <Toggle label="显示账户余额卡" checked={showBalanceCard} onChange={toggleBalanceCard} />
            {allModels.length > 0 ? (
              allModels.map((key) => (
                <Toggle
                  key={key}
                  label={`显示 ${key}`}
                  checked={visibleSet ? visibleSet.has(key) : true}
                  onChange={(value) => toggleModel(key, value)}
                />
              ))
            ) : (
              <p className="muted">未获取到模型列表(需配置 API Key 后自动加载)</p>
            )}
            <Toggle label="显示缓存命中图表" checked={showChart} onChange={toggleChart} />
          </div>
          <p className="muted">窗口大小:拖动窗口边缘自由调整,重启后保持。</p>
        </SettingsSection>

        <SettingsSection icon={<Info size={15} />} title="关于">
          <div className="version-row">
            <span>当前版本</span>
            <strong>v{appVersion}</strong>
          </div>
        </SettingsSection>

      </div>
    </section>
  );
}

function SettingsSection({
  icon,
  title,
  children,
}: {
  icon: React.ReactNode;
  title: string;
  children: React.ReactNode;
}) {
  return (
    <section className="settings-section">
      <h2>
        {icon}
        {title}
      </h2>
      {children}
    </section>
  );
}

function Toggle({
  label,
  checked,
  onChange,
}: {
  label: string;
  checked: boolean;
  onChange: (checked: boolean) => void;
}) {
  return (
    <label className="toggle-row">
      <span>{label}</span>
      <input type="checkbox" checked={checked} onChange={(event) => onChange(event.target.checked)} />
      <i />
    </label>
  );
}

function ModelDetailPanel({
  model,
  usage,
  usageState,
  onBack,
}: {
  model: string;
  usage: UsageResult | null;
  usageState: BalanceState;
  onBack: () => void;
}) {
  const data = usage?.models.find((item) => item.key === model) ?? null;
  const title = data?.name ?? model;
  const accent = modelAccent(model);
  const cost = data ? fmtMoney(data.cost) : "—";
  const totalText = data ? fmtTokensShort(data.totalTokens) : "—";

  const days = recentUsageDays(usage?.days ?? []);
  const points = days.map((day) => {
    const item = day.models.find((entry) => entry.key === model);
    const hit = item?.cacheHit ?? 0;
    const miss = item?.cacheMiss ?? 0;
    const response = item?.response ?? 0;
    return { date: day.date, hit, miss, response, total: hit + miss + response };
  });
  const maxVal = Math.max(...points.map((point) => point.total), 1);
  const rangeText =
    points.length > 0 ? `${mmdd(points[0].date)} - ${mmdd(points[points.length - 1].date)}` : "";

  const [hoveredIdx, setHoveredIdx] = React.useState<number | null>(null);
  const MIN_BAR = 3; // 整根柱子的最小可见高度百分比（含空数据占位）

  return (
    <section className="panel detail-panel" data-testid="detail-panel">
      <button className="floating-close" onClick={onBack} aria-label="返回主面板">
        <X size={20} />
      </button>
      <article className="card detail-hero" data-tauri-drag-region>
        <div className="model-badge large" style={{ color: accent, background: `${accent}22` }}>
          <Zap size={34} fill="currentColor" />
        </div>
        <div>
          <h1>{title}</h1>
          <p>{cost}</p>
        </div>
      </article>

      <div className="detail-metrics">
        <article className="card metric-card">
          <span>API 请求次数</span>
          <strong style={{ color: accent }}>{data ? fmtInt(data.requestCount) : "—"}</strong>
        </article>
        <article className="card metric-card">
          <span>Tokens</span>
          <strong style={{ color: accent }}>{totalText}</strong>
        </article>
      </div>

      <article className="card detail-chart">
        <div className="detail-chart-head">
          <div>
            <h2>按日 Token 消耗</h2>
            <span>{rangeText}</span>
          </div>
        </div>
        {usageState === "ok" && points.length > 0 ? (
          <>
            <div className="detail-bars" onMouseLeave={() => setHoveredIdx(null)}>
              {points.map((point, idx) => (
                <div className="detail-bar-column" key={point.date}>
                  {hoveredIdx === idx && point.total > 0 && (
                    <div
                      className={`bar-tooltip${
                        idx <= 1 ? " align-left" : idx >= points.length - 2 ? " align-right" : ""
                      }`}
                    >
                      <div className="bar-tooltip-head">
                        <span className="bar-tooltip-date">{point.date}</span>
                        <strong>{fmtInt(point.total)} tokens</strong>
                      </div>
                      <span className="bar-tooltip-row">
                        <i className="dot hit" />输入（命中缓存）
                        <strong>{fmtInt(point.hit)} tokens</strong>
                      </span>
                      <span className="bar-tooltip-row">
                        <i className="dot miss" />输入（未命中缓存）
                        <strong>{fmtInt(point.miss)} tokens</strong>
                      </span>
                      <span className="bar-tooltip-row">
                        <i className="dot response" />输出
                        <strong>{fmtInt(point.response)} tokens</strong>
                      </span>
                    </div>
                  )}
                  <span>{point.total > 0 ? fmtTokensShort(point.total) : ""}</span>
                  <div className="detail-bar-slot">
                    {/* 柱高按当天合计占最大值的比例；内部三段用 flex-grow 按真实 token 数分配，比例精确且永不溢出裁剪 */}
                    <div
                      className="detail-bar-stacked"
                      style={{
                        height: `${point.total > 0 ? Math.max(MIN_BAR, (point.total / maxVal) * 100) : MIN_BAR}%`,
                      }}
                      onMouseEnter={() => setHoveredIdx(idx)}
                      onMouseLeave={() => setHoveredIdx(null)}
                    >
                      {point.total > 0 ? (
                        <>
                          {point.hit > 0 && <i className="seg hit" style={{ flexGrow: point.hit }} />}
                          {point.miss > 0 && <i className="seg miss" style={{ flexGrow: point.miss }} />}
                          {point.response > 0 && <i className="seg response" style={{ flexGrow: point.response }} />}
                        </>
                      ) : (
                        <i className="seg empty" />
                      )}
                    </div>
                  </div>
                  <em>{mmdd(point.date)}</em>
                </div>
              ))}
            </div>
            <div className="chart-legend-bottom">
              <span className="chart-legend-item"><i className="dot hit" />命中</span>
              <span className="chart-legend-item"><i className="dot miss" />未命中</span>
              <span className="chart-legend-item"><i className="dot response" />输出</span>
            </div>
          </>
        ) : (
          <div className="chart-placeholder">
            {usageState === "nokey" ? "未配置用量 Token" : usageState === "loading" ? "查询中…" : "暂无数据"}
          </div>
        )}
      </article>
    </section>
  );
}

// Apply the saved theme before first render to avoid a flash of the wrong skin.
document.documentElement.setAttribute("data-theme", localStorage.getItem("ui-theme") || "dark");

// 独立设置窗口标记:用于 CSS 让设置面板不透明(整窗透明度只作用于主面板)。
try {
  if (getCurrentWindow().label === "settings") {
    document.documentElement.setAttribute("data-window", "settings");
  }
} catch {
  // 浏览器预览无 Tauri
}

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
