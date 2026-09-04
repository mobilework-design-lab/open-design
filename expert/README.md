# 网页设计与 HTML 交付专家

## 类型

单一 primary Agent 的 OpenWork/MobileWork Expert 包。

## 功能

通过需求发现、视觉方向确认、原生文件生成和确定性校验，交付可离线打开的单 HTML 页面或多文件静态网站。

## 专家能力

- 集中追问产品、受众、目标、内容、响应式、交互和输出模式。
- 给出 2–3 个与产品语境对应的视觉方向并等待确认。
- 生成语义化 HTML、CSS、无依赖 JavaScript 和本地资源。
- 校验入口、引用、资源体积并事务替换完整输出。

## 工作流程

默认先确认产品简报和视觉方向；用户明确要求直接生成时记录合理假设。源文件只进入 `.web-design/draft/`，finalizer 成功后才生成并登记正式输出。

## 引导问题与直接生成

需求不完整时，Expert 会在第一轮集中询问产品、受众、首要目标、必要页面或区块、已有文案与本地资源、响应式/交互要求和输出模式；随后给出 2–3 个具体视觉方向并等待选择。若用户明确说“直接生成”“不要追问”或授权合理默认值，Expert 不再反问，而是把假设写入 brief 后继续。

## 输出选择与登记

- 单 HTML 适合独立落地页、表单和易分享预览；登记 `output/index.html`。
- 多文件适合多页面或需要继续编辑 CSS/JS 的网站；可编辑源位于 `output/site/`，登记 `output/site.preview.html` 与 `output/site.zip`。
- 所有输出都必须离线可用；不接受远程字体、CDN、图片或脚本。

## 内置技能

只使用托管 Skill `web-design-html`。它包含对话状态机、输出契约、设计系统回退、Craft 规则和自包含 finalizer。

## 使用示例

- “为我的产品设计一个响应式落地页。”
- “生成一个含主页和方法页的多文件数据网站。”
- “直接生成一个移动端优先的单 HTML 报名表。”

## 包结构

Agent 位于 `.opencode/agents/`，共享 Skill 位于 `.opencode/skills/web-design-html/`，本地头像位于 `avatars/`。单 HTML 输出为 `output/index.html`；多文件输出为可编辑的 `output/site/`、预览 `output/site.preview.html` 和下载包 `output/site.zip`。

## 运行时扩展

### Agent 运行参数

Agent id 为 `web-design-html-expert`，模式为 `primary`，`steps: 100`，不创建或委派其他 Agent。

### Agent 权限基线

允许本地生成所需的原生读取和编辑；shell 默认询问，只精确放行 finalizer；只允许加载 `web-design-html`；拒绝 task 委派和 web fetch。

权限来源：`no-workflow-bounded-default`；有效自主级别：`bounded`；权限理由：需要运行包内置的 finalize.mjs，对本地草稿执行确定性校验和事务提交。

## 配置与环境变量

无需环境变量。运行时需要 Node.js 24，并由宿主提供 `question`、文件、shell、Skill 和 `result_file` 能力。

## 注意事项

交付物必须离线可用，不允许远程资源。不要直接修改正式 `output/`；需要改稿时编辑 `.web-design/draft/` 并重新运行 finalizer。退出码 1 表示可修复的草稿问题，按 JSON 中的 `code`、`files`、`details` 修复并最多重试两次；退出码 2 表示路径、锁或事务类终止问题，应停止自动处理并保留上一份输出。
