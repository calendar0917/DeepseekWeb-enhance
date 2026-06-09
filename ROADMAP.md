# DS Enhance 升级路线图

更新时间：2026-06-08

## 目标边界

本项目后续定位为 **DeepSeek Chat 专用浏览器增强套件**，不再规划 ChatGPT、Claude、Gemini、Kimi 等多站点适配。所有产品、代码、文档、发布流程都围绕 `chat.deepseek.com` 优化。

核心目标：

- 让插件能力更自然地嵌入 DeepSeek 网页 DOM，而不是只依赖悬浮面板。
- 将两个 userscript 产品化发布，方便普通用户一键安装和自动更新。
- 保留双脚本边界：普通增强脚本低权限，高级 MCP 脚本明确高权限与本地执行风险。
- 在不破坏现有可用功能的前提下，逐步工程化重构，降低后续维护成本。

非目标：

- 不做 ChatGPT 页面适配。
- 不接入 DeepSeek 内部 React store 或未公开运行时状态作为主方案。
- 不把 DS Enhance 和 DS MCP Bridge 强行合并成一个高权限大脚本。
- 不在第一阶段引入过重框架，除非构建和维护收益明确。

## 产品形态

项目保留两个独立油猴脚本：

| 脚本 | 目标用户 | 权限策略 | 核心能力 |
|------|----------|----------|----------|
| `ds-enhance.user.js` | 普通 DeepSeek 用户 | 尽量保持 `@grant none` | 会话管理、分类、搜索、导出、重命名、提示词注入 |
| `ds-mcp-bridge.user.js` | 高级用户 / 开发者 | 明确声明 GM 权限、本地服务和工具调用风险 | MCP 工具调用、TTS、工具结果注入、本地服务管理 |

发布说明中必须清楚区分：

- `DS Enhance` 可以作为普通增强插件安装。
- `DS MCP Bridge` 会连接本地 `localhost:8024` 服务，并可能执行本地命令、读写文件，应只在可信环境中使用。

## 阶段 1：油猴发布产品化

目标：先让用户能够低成本安装、更新、理解权限，并建立后续版本发布节奏。

### 任务

- 完善 userscript metadata。
  - `@homepageURL`
  - `@supportURL`
  - `@downloadURL`
  - `@updateURL`
  - `@license`
  - `@icon`
  - `@connect`，仅 MCP 脚本需要声明本地服务地址。
- README 增加一键安装链接。
  - GitHub Raw 安装链接。
  - GreasyFork / ScriptCat 发布后补充外部安装链接。
- 新增 `SECURITY.md`。
  - 说明 MCP 脚本的本地工具调用风险。
  - 说明 `execute_command`、`read_file`、`write_file` 的能力边界。
  - 建议用户只在本机可信环境使用。
- 新增 `RELEASE.md`。
  - 版本号更新步骤。
  - changelog 更新步骤。
  - 发布前测试命令。
  - GitHub Release 与油猴平台同步流程。
- 整理 README 安装章节。
  - 普通用户路径：安装 Tampermonkey → 安装 `DS Enhance`。
  - 高级用户路径：安装 `DS MCP Bridge` → 启动 server → 检查连接状态。
- 准备 GreasyFork 发布文案。
  - 简短介绍。
  - 权限说明。
  - 隐私说明。
  - 更新日志链接。

### 验收标准

- 用户可以通过 raw 链接安装两个脚本。
- Tampermonkey 能识别更新地址。
- README 中没有 ChatGPT 或多站点承诺。
- MCP 脚本权限说明清楚，不隐藏本地命令执行风险。
- 发布前命令全部通过：

```bash
node --check ds-enhance.user.js
node --check ds-mcp-bridge.user.js
node --test tests/userscript-regressions.test.js
```

## 阶段 2：DeepSeek DOM 嵌入能力

目标：把高频能力嵌入 DeepSeek 页面原生位置，减少悬浮面板割裂感。

### 嵌入层级

采用渐进式 DOM 嵌入，不追求侵入 DeepSeek 内部框架。

| 层级 | 说明 | 优先级 |
|------|------|--------|
| L1 轻量原生嵌入 | 在现有按钮栏、输入区、消息操作区插入插件按钮 | 高 |
| L2 半原生面板嵌入 | 在侧边栏或右侧区域挂载插件面板 | 中 |
| L3 框架级嵌入 | 操作内部 React 状态或未公开 store | 暂不做 |

### 任务

- 建立 `DeepSeekAdapter`。
  - 集中管理页面选择器。
  - 提供 `findComposerToolbar()`、`findSidebarHeader()`、`findConversationList()`、`findMessageActions()` 等定位函数。
  - 提供选择器降级策略，避免页面小改版直接失效。
- 建立 `mountManager`。
  - 控制挂载、去重、卸载、重挂载。
  - 对 `MutationObserver` 做 debounce。
  - 避免重复插入按钮和无限 DOM 扫描。
- 输入区嵌入。
  - 提示词快捷按钮挂到输入区附近。
  - MCP 工具入口挂到输入区附近。
  - 保留悬浮面板作为 fallback。
- 消息区嵌入。
  - TTS 按钮挂到助手消息操作栏。
  - MCP 代码块增加折叠、重发、复制参数入口。
  - 系统指令折叠保持默认开启。
- 侧边栏嵌入。
  - 搜索入口放到会话列表顶部。
  - 分类色点显示到会话条目内。
  - 批量操作入口放到侧边栏顶部或列表工具区。
- 降级策略。
  - 找不到原生挂载点时回退到悬浮按钮。
  - 页面结构变化时不阻断 DeepSeek 原生功能。

### 验收标准

- 输入区、消息区、侧边栏至少各有一个原生嵌入点可用。
- 页面切换会话、刷新、生成回答时不会重复挂载按钮。
- DeepSeek 页面结构变化时插件最多功能降级，不应导致页面无法输入或发送。
- 没有明显滚动卡顿、输入卡顿。

## 阶段 3：功能体验升级

目标：优先增强现有功能，不盲目扩展站点或做大而全功能。

### DS Enhance

- 会话搜索升级。
  - 支持日期范围过滤。
  - 支持分类过滤组合搜索。
  - 搜索结果支持跳转会话。
- 分类体验升级。
  - 会话列表显示分类色点。
  - 支持批量设置分类。
  - 支持分类数据导入、导出和覆盖确认。
- 导出升级。
  - Markdown 导出支持树形分支结构。
  - 支持导出单个会话、多个会话和当前消息片段。
  - 导出文件名包含标题和日期，避免覆盖。
- Fork 体验升级。
  - 选择起点时展示助手回复预览。
  - 明确标注 fork 范围。
- 提示词库升级。
  - 支持分组。
  - 支持变量模板，例如 `{date}`、`{selection}`、`{clipboard}`。
  - 支持启用顺序调整。

### DS MCP Bridge

- 工具调用安全控制。
  - 增加工具白名单/黑名单。
  - 对 `execute_command` 增加二次确认选项。
  - 对危险命令给出前端提醒。
- 工具结果体验。
  - 长结果默认文件化注入。
  - 支持结果折叠、复制、重新发送。
  - 标注结果来源工具和执行时间。
- MCP 服务器管理。
  - 优化外部 MCP 服务器状态显示。
  - 区分内置工具和外部工具。
  - 对启动失败展示错误摘要。
- TTS 体验。
  - 朗读按钮状态明确：播放中、暂停、失败。
  - 自动朗读增加当前会话开关。
  - 语音筛选和预览更稳定。

### 验收标准

- 新功能都有可见入口、空状态、错误状态。
- 批量操作失败时能看到失败项和错误原因。
- 高风险 MCP 操作有明确确认或配置开关。
- 用户不需要打开控制台才能理解错误。

## 阶段 4：工程化重构

目标：降低单文件维护成本，同时保持最终发布物仍是单文件 userscript。

### 推荐结构

```text
src/
  core/
    dom-mount.js
    storage.js
    toast.js
    modal.js
    panel.js
    events.js
  adapters/
    deepseek.js
  features/
    conversation-manager/
    prompt-library/
    export/
    tts/
    mcp/
    message-actions/
  entries/
    ds-enhance.entry.js
    ds-mcp-bridge.entry.js
scripts/
  build-userscripts.js
dist/
  ds-enhance.user.js
  ds-mcp-bridge.user.js
```

### 任务

- 引入轻量构建工具。
  - 首选 `esbuild`。
  - 输出仍为单文件 `.user.js`。
  - 自动注入 userscript header。
- 抽离共享基础设施。
  - toast、modal、panel、storage、DOM mount。
  - 两个脚本通过 entry 选择性打包。
- 分离功能模块。
  - 会话管理和 MCP 逻辑不互相依赖。
  - DeepSeek 选择器只存在于 adapter 中。
- 保留手工安装兼容。
  - `dist/*.user.js` 是发布文件。
  - 源码结构用于开发。
- 迁移测试。
  - 现有 userscript 回归测试继续覆盖打包产物。
  - 新增 adapter 和 mountManager 的单元测试。

### 验收标准

- 开发只改 `src/`，发布只用 `dist/*.user.js`。
- 构建产物通过 `node --check`。
- 旧用户配置不丢失，localStorage / GM storage key 有迁移策略。
- 打包前后功能行为一致。

## 阶段 5：测试与质量保障

目标：把“DeepSeek 页面经常改版”的风险控制在可维护范围内。

### 测试分层

- 语法检查。
  - `node --check ds-enhance.user.js`
  - `node --check ds-mcp-bridge.user.js`
- userscript 回归测试。
  - 分页去重。
  - 提示词按钮挂载选择器。
  - MCP 工具名解析。
  - 系统指令折叠。
  - TTS 按钮注入。
- DOM fixture 测试。
  - 用保存的 DeepSeek HTML 片段测试挂载点。
  - 每次 DeepSeek 改版后更新 fixture。
- 手工验收清单。
  - 登录 DeepSeek 后按钮出现。
  - 新建会话、切换会话、刷新页面后功能仍可用。
  - 生成回答时不重复注入按钮。
  - MCP server 未启动时错误提示清楚。
  - MCP server 启动后工具列表刷新正常。

### 可选增强

- Playwright 冒烟测试。
  - 仅验证脚本注入、按钮挂载、面板打开。
  - 不依赖真实账号的测试只覆盖静态 fixture。
- GitHub Actions。
  - PR 时跑 JS 检查和 userscript 测试。
  - Release 时检查 metadata 和版本号一致性。

## 阶段 6：发布节奏

建议采用小版本高频发布，避免一次性堆大量 DOM 改动。

### 版本策略

- Patch：修复选择器、修复小 bug、文档更新。
- Minor：新增功能、DOM 嵌入点、配置项。
- Major：存储结构迁移、构建体系重构、权限变化。

### 发布前清单

- 更新版本号。
- 更新 `CHANGELOG.md`。
- 运行 userscript 检查和测试。
- 在 DeepSeek 实页手工验证关键路径。
- 确认 README 安装链接可用。
- 确认 MCP 权限说明没有遗漏。

### 发布渠道

- GitHub Raw：作为基础安装和更新地址。
- GitHub Release：归档每次版本。
- GreasyFork：面向普通用户发现和安装。
- ScriptCat：作为国内用户备选渠道。

## 风险与应对

| 风险 | 影响 | 应对 |
|------|------|------|
| DeepSeek DOM 改版 | 按钮挂载失效 | adapter 集中选择器、fixture 回归、悬浮按钮 fallback |
| DeepSeek API 变化 | 会话管理失败 | API 层统一错误处理、失败项展示、保留手工导出路径 |
| MCP 本地工具风险 | 用户误执行危险操作 | 权限说明、白名单/黑名单、危险命令确认 |
| 单文件继续膨胀 | 后续维护困难 | 阶段 4 引入构建和模块化 |
| MutationObserver 过重 | 页面输入卡顿 | 限定监听容器、debounce、去重标记、requestIdleCallback |
| 用户配置迁移失败 | 分类/提示词丢失 | 增加导入导出、迁移前备份、保留 legacy key 读取 |

## 推荐近期执行顺序

1. 完成发布文档：`SECURITY.md`、`RELEASE.md`、README 一键安装链接。
2. 发布当前 DeepSeek-only 版本到 GitHub Raw，准备 GreasyFork 文案。
3. 实现 `DeepSeekAdapter` 和 `mountManager` 的最小版本。
4. 先落地输入区提示词按钮和消息区 TTS 按钮的原生嵌入。
5. 再做侧边栏搜索、分类色点和批量操作入口。
6. 最后推进 `src/` 模块化和构建流程。

## 决策记录

- 2026-06-08：项目方向收敛为 DeepSeek 专用，不再做 ChatGPT 页面适配。
- 2026-06-08：保留两个 userscript，避免普通用户被迫安装高权限 MCP 脚本。
- 2026-06-08：DOM 嵌入优先采用 L1/L2，不追求框架级内部状态接入。
