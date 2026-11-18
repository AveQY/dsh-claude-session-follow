# Claude Code 会话跟随 · dsh-claude-session-follow

在 **DeepSeek Harness (DSH)** 的普通聊天里使用原生 **Claude Code** 开发循环：选择模型、正常发消息，回复、思考与工具记录就显示在当前会话；追问继续沿用同一份 DSH 对话历史。底层决策模型由本机 [Magpie](https://127.0.0.1:3425) 提供，可切换成 DeepSeek、GPT 或其他可用模型，切换后下一次 API 请求即生效。

> DSH plugin that runs Claude Code as a selectable chat provider. Claude Code is the executor (its native tools), while the reasoning model is whatever Magpie model you pick in the DSH model picker. The plugin forwards each Claude request to your local Magpie gateway and rewrites the model per request, so switching models in the session switches Claude's model from the next request.

## 特性

- **普通聊天即用**：模型选择器出现 **Claude Code · Magpie** 分组；选中后正常发送任务，无需斜杠命令。
- **模型跟随**：每个 API 请求都读取当前会话模型并转发给 Magpie；长任务中途切换模型，后续工具回合也用新模型。
- **会话隔离**：各 DSH 会话独立运行，同一会话同时只允许一个回复；停止/超时/卸载都会回收 Claude 进程与临时端口。
- **工具折叠**：原生工具调用与结果各自显示为**可折叠记录**，正文只保留回复；工具已由 Claude 执行，绝不会作为 DSH 工具再次执行。
- **上下文可恢复**：工具输入/输出同时写入 DSH 原生 `replayState` 隐藏回放元数据，后续轮次可从 DSH 保存的对话历史恢复，不依赖隐藏的 Claude 会话。
- **超长输出**：单条工具输出超过 6000 字符时，聊天显示有界预览，全文另存到工作目录 `.dsh-claude-output/<uuid>/` 并以链接呈现。

## 依赖与前提

- Windows（当前版本）；Node.js ≥ 22。
- 已安装 DSH 及插件 `@deepseek-ai/dsh-subagent-claude-code`（插件借用其自带的原生 `claude.exe`，**不需要**在 PATH 里单独安装 `claude` 命令，也**不需要**登录 Anthropic 账号）。
- 本机 Magpie 网关 `http://127.0.0.1:3425` 可用，且能解析 `MAGPIE_GATEWAY_KEY`。
- DSH 会话需处于**完全访问（danger-full-access）**模式。

## 安装

这是本地目录形式的 DSH bundle，安装后请保留源码目录（Host 会以 linked 方式加载）。

1. 把本仓库放到任意目录。
2. 在 DSH 插件管理里以 `install_bundle` 安装该目录（或按其插件管理界面的「安装本地插件」流程选择该目录）。
3. 重新加载 Host 插件（升级宿主 JavaScript 后仅刷新页面不保证生效）。

### 定位 Claude 运行时

若 DSH Host 进程暴露 `DSH_PROFILE_DIR`，插件会自动从已安装的 `@deepseek-ai/dsh-subagent-claude-code` 解析出 `claude.exe`。如果 Host 未暴露该变量（部分桌面版如此），请在本目录 `cordis.patch.yml` 的 `config.executable` 里显式填写你的 `claude.exe` 路径，例如：

```yaml
- insert:
    - id: claude-session-follow
      name: '@local/dsh-claude-session-follow'
      config:
        executable: 'C:\path\to\@anthropic-ai\claude-agent-sdk-win32-x64\claude.exe'
```

### 卸载

在 DSH 插件管理里停用或卸载 **Claude Code 会话跟随** 即可移除模型分组、命令与工具。

## 使用

1. 打开 DSH 模型选择器，进入 **Claude Code · Magpie** 分组，选一个模型。
2. 正常发送任务，例如「检查当前项目，修复问题并运行相关测试」。
3. 回复逐段流式显示；工具记录折叠展示执行中 / 完成 / 失败。点 **停止** 取消本轮。
4. 直接继续追问；每轮都会传入本对话已保留的完整历史。

在该分组内切换模型：下一次 API 请求使用新模型（已发出的请求继续完成）。切回普通 Magpie 分组，新轮次回到原本的 DSH 开发循环。

## 兼容旧版的后台命令

`/claude`、`/claude-new`、`/claude-status`、`/claude-cancel` 以及 `claude_session` 工具保留为**独立后台模式**，其上下文与普通聊天入口互不相通；后台任务不受聊天停止按钮影响，需用 `/claude-cancel` 停止。

## 行为与限制

- 执行者是 Claude Code，决策模型由 Magpie 上游决定；选择 GPT/DeepSeek 时执行者仍是 Claude Code。
- 每轮把 DSH 保留的完整对话序列化后传给原生进程，因此输入 token 与费用可能高于依赖原生历史续接的方式；实际用量以返回 usage 为准。
- 不修改全局 Claude 设置、DSH 默认模型或 Magpie provider；原生进程使用独立凭据与本地桥接，屏蔽原生设置来源和交互式提问。
- 失败会显示在本轮结果中，DSH 不会自动重跑可能产生文件操作的开发轮次，也不会自动换模型。
- 默认单请求最多 3 分钟、单轮最多 30 分钟。

## 开发

```bash
node --test test/*.test.mjs
```

`test/live.mjs` 验证旧版后台路径；真实普通聊天验证使用独立会话、限时任务，并保留会话流与文件操作证据。所有验证都会回收子进程与临时端口。

## 目录结构

| 文件 | 作用 |
| --- | --- |
| `index.js` | 插件入口：注册 `claude-code` LLM 适配器、命令与 `claude_session` 工具 |
| `chat-adapter.mjs` | 普通聊天适配器：模型目录镜像、按会话取模型、每请求开本地桥转发 Magpie |
| `chat-stream.mjs` | 原生流映射：文本/思考/工具记录 → DSH 块，附 `replayState` 回放元数据 |
| `proxy.mjs` | 仅监听回环的 Anthropic 代理，逐请求重写模型并转发到 Magpie |
| `runner.mjs` | 定位并启动原生 `claude.exe`，解析 stream-json，管理生命周期 |
| `cordis.patch.yml` | DSH bundle patch |

## License

[MIT](LICENSE)
