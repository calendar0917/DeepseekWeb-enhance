# Changelog

## [4.3.0] - 2026-07-06

### Added
- DS Enhance: Fork（选择起点）新增「保留此节点之后」模式，可只保留选中节点及之后的对话，删除之前的消息（#9）。

## [4.2.0] - 2026-06-07

### Added
- DS MCP Bridge: 设置页新增“工具结果自动发送”开关，关闭后工具结果只填入输入框。
- DS MCP Bridge: MCP 代码块默认折叠，并在代码块工具栏增加“展开/折叠”和“重发”按钮。
- DS MCP Bridge: 注入的系统指令增加结束标记，并在聊天消息中自动折叠显示。

### Fixed
- DS Enhance: 修复 DeepSeek 页面移除 `[role=button]` 后提示词选择按钮无法挂载的问题。
- DS Enhance: 修复对话列表分页在后端重复返回同一页时膨胀到 5000 条的问题，增加会话去重与游标停滞保护。

### Tests
- 新增 userscript 回归测试，覆盖分页去重、提示词按钮挂载选择器和 MCP 工具名解析。

## [4.1.0] - 2026-04-28

### Fixed
- **性能修复**: 解决 Chrome + 搜狗输入法严重卡顿问题
  - MutationObserver 缩小监听范围（body → 聊天容器），debounce 300ms→1000ms，改用 requestIdleCallback 延迟执行
  - XHR SSE 解析从全量重解析改为增量解析，避免流式输出时 CPU 开销
  - _watchTextStable 轮询间隔 500ms→1000ms，预计算 selector，减少强制回流
  - 修复 SSE 增量解析跨事件截断导致 token 丢失的边界 bug

## [4.0.0] - 2026-04-26

### Added
- **TTS 语音朗读**：AI 回复旁显示 🔊 按钮，支持手动朗读
  - Edge TTS（免费，内置 21 个常用语音）
  - OpenAI 兼容 TTS（支持任意 OpenAI-compatible API，可配置 API Key / Base URL / 模型）
  - 自定义 HTTP TTS（接入任意 TTS API，支持请求模板）
  - 语音筛选：按语言（中文/英语/日语/韩语）和性别过滤，连通 server 后加载完整 322 个语音
- **自动朗读**：AI 回复完成后自动播放 TTS，等待文本稳定（连续 1.5 秒无变化）后触发
- **多站点适配器架构**：自动检测当前站点并加载对应适配器
  - DeepSeek Chat — 完整支持
  - ChatGPT — 基础适配样板（开发中）
- **模块开关**：MCP / TTS / 自动朗读 可独立开启/关闭（设置页）
- **工具结果文件化**：`read_file` / `list_directory` 结果不再填满聊天窗口，而是作为文件上下文自动注入下次对话
- **文件处理器** (`server/tools/file_processor.py`)：支持 TXT/MD/JSON/CSV/PDF/图片
- **TTS API 端点**：`POST /api/tts`（合成语音）+ `GET /api/tts/voices`（语音列表）
- **文件上传 API**：`POST /api/upload` + `GET /api/upload/status`（并发队列管理）

### Changed
- `ds-mcp-bridge.user.js` 版本升级至 4.0.0，行数从 ~1251 增至 ~1680
- XHR/fetch hook 现在受模块开关控制（MCP 关闭时不拦截请求）
- `@match` 新增 `chat.openai.com` 和 `chatgpt.com`

### Dependencies
- 新增 `edge-tts>=6.0`（TTS 引擎）
- 新增 `pymupdf>=1.23`（PDF 文本提取）
- 新增 `python-multipart>=0.0.6`（文件上传支持）

## [3.2.0] - 2026-04-26

### Added
- 外部 MCP 服务器支持：在 `mcp.json` 的 `mcpServers` 中配置第三方 MCP 服务器
  - stdio 传输：启动子进程（如 `npx @modelcontextprotocol/server-github`）
  - HTTP 传输：连接远程 MCP 服务器（支持 SSE）
  - 工具自动合并，DeepSeek 可直接调用外部工具
  - 服务器生命周期管理（启动、关闭、健康检查）
- `/health` 端点新增 `builtin_tools`、`external_tools`、`external_servers` 字段

## [3.1.0] - 2025-04-25

### Added
- 自定义系统提示词注入：新增"提示词" Tab，填写后每次对话自动注入
- XHR + fetch hook，`@run-at document-start` 确保注入在页面脚本加载前生效

## [3.0.1-mcp] - 2025-04-25

### Changed
- 移除自定义提示词功能（已迁移到 ds-enhance v3.1.0）

## [3.0.0-mcp] - 2025-04-25

### Added
- 控制面板：绿色悬浮球（可拖动），点击或 Ctrl+Shift+M 打开
- 状态 Tab：连接状态、已注册工具列表
- 测试 Tab：选择工具 → 动态生成参数表单 → 执行 → 查看结果
- 设置 Tab：MCP 服务器地址配置
- 未连接时悬浮球变红，连接成功变绿

## [2.0.0-mcp] - 2025-04-25

### Added
- DeepSeek 原生 SSE 格式解析（`p`/`v` 字段），兼容 OpenAI 格式
- Flex match 工具调用检测：支持 SSE token 边界截断情况下的模糊匹配
- 工具结果自动注入：执行结果通过聊天输入框发回给 DeepSeek
- `<tool_result>` 标签系统提示，引导 AI 理解工具结果并继续回答
- 发送按钮 fallback：Enter 键模拟失败时自动点击发送按钮
- 面板显示版本号

### Changed
- XHR hook + fetch hook 双重拦截，覆盖 DeepSeek 全部请求方式
- 合并「连接服务器」和「刷新工具列表」为单一按钮
- 清理 debug 日志，console 只保留关键信息

## [1.0.0-mcp] - 2025-04-25

### Added
- **DS MCP Bridge** — 全新油猴脚本，让 DeepSeek Chat 调用本地 MCP 工具
- SSE 拦截器：hook `window.fetch`，实时解析 DeepSeek 流式响应
- MCP 客户端：通过 `GM_xmlhttpRequest` 绕 CORS 调用本地服务器
- 工具调用检测：解析 AI 输出中的 `` ```mcp:tool_name`` `` 格式
- MCP 服务器端 (Python/FastAPI)：JSON-RPC 2.0 协议，支持 7 个内置工具
  - `execute_command`, `get_cwd`, `list_directory`, `read_file`, `write_file`
  - `bing_search`, `crawl_webpage`
- 控制面板：MCP 状态、调用历史、设置（服务器地址、自动执行开关）
- 共享基础设施提取至 `shared/shared-header.js`

## [3.0.0] - 2025-04-25

### Added
- 会话分类：创建自定义标签，给对话打分类，按分类筛选，支持导入/导出分类数据
- 搜索：按标题实时搜索对话，支持高亮匹配关键词
- 导出：导出对话为 JSON 或 Markdown 文件
- 批量重命名：直接重命名、添加前缀/后缀、查找替换、序号命名
- 悬浮球支持拖动定位
- Tab 栏横向可滚动

### Fixed
- URL 匹配：适配 DeepSeek 实际路由 `/a/chat/s/{uuid}`

## [2.0.0] - 2025-04-25

### Added
- 悬浮控制面板（不依赖页面 DOM 结构）
- 批量删除对话（勾选删除、清空全部，带进度条）
- Fork 对话（完整复制、从指定节点分支）
- 右键菜单 Fork / 删除
- 快捷键 Ctrl+Shift+D

## [1.0.0] - 2025-04-25

### Added
- 初始版本
- 尝试注入侧边栏按钮（因 DOM class 动态哈希，v2 中放弃此方案）
