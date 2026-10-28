---
name: tauri-e2e
version: 0.1.0
description: "为 Tauri 桌面应用搭建并运行 AI Agent 可自主执行的端到端验证。当需要让 Agent 构建、启动、驱动、断言、截图取证、定位失败并迭代修复 Tauri 应用时使用，也适用于配置 embedded WebDriver、IPC mock、测试替身、xvfb CI 与 MCP 探索式调试。"
---

# Tauri Agent E2E

把「Agent 能自己跑通并判定」作为目标，而不是「Agent 能点按钮」。核心是同时提供
**可观测、可操作、可判定** 三条通道，再用固定流程收敛失败。

## 何时使用

- 需要为 Tauri 应用补端到端测试，且希望 Agent 能独立执行与修复。
- 已有测试但 flaky、断言靠截图、错误定位慢。
- 要接 CI、要 mock IPC、要处理原生对话框。

不适用于：性能基准、动画流畅度、真实硬件、系统托盘/菜单的像素级验证。

## 三层策略

| 层 | 用途 | 速度 | 入口 |
|---|---|---|---|
| Rust 进程内 | 命令、ACL、状态机 | 最快 | `tauri::test::{mock_builder, mock_context, get_ipc_response}` |
| 浏览器模式 | 纯前端逻辑、invoke 拦截 | 快 | WDIO Tauri service 的 browser mode |
| embedded E2E | 真实进程 + WebView + IPC | 慢但可信 | `tauri-plugin-wdio-webdriver` |

Agent 的内循环用前两层，只有跨进程链路才跑第三层。

## 接入清单

1. **结构化状态命令**：新增只读命令（默认名 `debug_state`），返回路由、关键 store、
   最后动作、错误码。参考 `../../assets/templates/rust-debug-state.rs`。
2. **稳定选择器与 ready 信号**：所有可交互元素加 `data-testid`；启动完成后显式标记
   `data-testid="app-ready"` 或 `document.documentElement.dataset.ready`。禁止用文案做选择器。
3. **测试模式**：固定随机种子、关闭动画、临时数据目录、网络指向本地 fake 服务。
4. **原生 UI 用替身，不碰 OS**：文件对话框/消息框通过 CLI 参数或环境变量注入确定性返回值，
   wdio 构建下走替身，release 才走真实实现（见模板中的 `pick_file`）。
5. **门控自动化面**：`wdio` feature 只控制插件注册；不要让它进入正常启动路径。
   若 capabilities 里声明了 `wdio:*` 权限，相关 crate 必须在所有构建模式下可解析。
6. **装配 harness 与配置**：
   - `../../assets/templates/agent-run.mjs` → `agent/run.mjs`
   - `../../assets/templates/wdio.conf.mjs` → `wdio.conf.js`
   - `../../assets/templates/capability-default.json` 追加 `wdio:default`、`wdio-webdriver:default`
7. **CI**：复制 `../../assets/templates/ci-e2e.yml` 到仓库根 `.github/workflows/`。

## 运行

```bash
npm run build          # 前端 + 带 wdio feature 的 app
node agent/run.mjs     # 构建 → 启动 → WDIO → 证据汇总
```

无显示器环境由 harness 自动套 `xvfb-run`。产物固定为：

- `artifacts/agent-summary.json`（ok、JUnit 计数、截图与状态文件清单、日志捕获情况）
- `artifacts/*.png`、`artifacts/*.state.json`、`artifacts/junit/*.xml`
- `logs/*.log`（前端 console 与后端日志）

Agent 先读 summary，再按需读具体断言与截图，不要整段解析 WDIO 日志。

## 失败分诊

| 现象 | 优先检查 |
|---|---|
| 元素找不到 | 是否 ready 信号之前操作；选择器是否稳定；窗口是否加载了旧资源 |
| 断言值不对但界面正常 | 断言是否直接读后端状态（`debug_state`），而不是猜 DOM |
| mock 不生效 | 应用是否调用 `window.__TAURI__.core.invoke`；`core` 是否被 `Object.freeze` |
| 点击后 UI 不更新 | 渲染是否依赖命令返回值；是否被后续 `debug_state` 覆盖 |
| 截图是旧界面 | 前端资源在编译期嵌入，改完前端必须重编 app |
| 日志没有应用输出 | 前端日志用了 `console.log`（映射为 trace 被过滤），改用 `console.info` |
| CI 启动失败 | WebKitGTK、`xvfb`、`LIBGL_ALWAYS_SOFTWARE`/`WEBKIT_DISABLE_COMPOSITING_MODE` |

已知坑（都已在真实项目验证）：

- **全局 API 被冻结**：`window.__TAURI__.core` 是 `Object.freeze` 的，WDIO 插件无法
  `defineProperty`，mock 会静默落回真实后端。在 import 插件前替换为可写副本：
  ```js
  const api = window.__TAURI__
  if (api?.core && Object.isFrozen(api.core)) api.core = { ...api.core }
  ```
  随后 `browser.tauri.mock()` 对应用自身发起的 invoke 也生效。
- **mock 的边界**：插件只能拦截 `window.__TAURI__.core.invoke` 或
  `browser.tauri.execute` 内的调用；绕开它们直接走 internals 的代码无法 mock。
- **前端产物编译期嵌入**：只 `vite build` 不重编 Rust 会跑旧页面。

## MCP 探索式调试

插件自带零依赖 MCP server（`mcp/server.mjs`），工具：

- `start_app` / `stop_app`
- `click` / `type` / `screenshot`
- `read_state`（通过 `execute/async` 调状态命令，读真实后端）
- `read_logs`（应用 stdout/stderr）
- `run_e2e`（执行 `agent/run.mjs` 并返回 summary）

配置：`TAURI_E2E_PROJECT`、`TAURI_E2E_BINARY`、`TAURI_E2E_PORT`、`TAURI_E2E_STATE_COMMAND`。
没有自动加载 MCP 时，直接 `node <plugin>/mcp/server.mjs` 接入客户端。

探索顺序建议：`start_app` → `screenshot` → `read_state` → 操作 → 再读状态 → `run_e2e` 固化断言。
探索阶段的发现必须回写成 spec，不要只停留在手工点击。

## 护栏

- 自动化插件只允许在测试构建注册；release 不得启动 WebDriver server。
- 测试端口绑定 `127.0.0.1`，避免暴露到网络。
- 不 mock 掉被测行为本身：mock 用于契约与异常路径，主流程必须走真实后端。
- 每个失败都要留下证据（状态快照 + 截图 + 日志），否则不可复现。
