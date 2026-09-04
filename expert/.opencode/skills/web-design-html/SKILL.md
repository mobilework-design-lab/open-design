---
name: web-design-html
description: 设计并交付单 HTML 或多文件静态网站；在需求不完整时先澄清产品定位和视觉方向，再生成、校验和事务提交。
---

# Web Design HTML

本 Skill 是网页设计流程与交付契约，不是页面模板。使用宿主的原生 `question`、文件和 shell 能力完成对话、生成与校验。

## 不可变边界

- 只生成静态 HTML、CSS、JavaScript 和本地资源；禁止远程 URL、服务端依赖和运行前构建步骤。
- 只把生成源写到 `.web-design/draft/`；禁止直接写入 `output/`。正式输出只能由 finalizer 整体提交。
- 不创建团队，不委派任务，不调用外部设计服务。
- 用户已有内容优先。未知事实使用明确的示例或占位说明，不编造业绩、客户或指标。

## 状态机与持久化

合法主链为：

```text
missing/collecting -> style-proposed -> confirmed -> generated -> finalized -> delivered
confirmed -> collecting       产品、受众、页面或输出模式发生重大变化
generated -> confirmed        设计方向或信息结构发生变化
finalized -> generated        用户要求修改源文件
```

每次状态变化都原子写入 `.web-design/brief.json`：先在同目录写临时文件，再同卷重命名。使用 schema 版本 1，顶层字段必须完整：

```json
{
  "schemaVersion": 1,
  "status": "confirmed",
  "product": {},
  "audience": {},
  "goals": [],
  "pages": [],
  "content": {},
  "brand": {},
  "visualDirection": {},
  "responsive": {},
  "interactions": [],
  "outputMode": "single-html"
}
```

`status: confirmed` 是生成门槛。记录用户原话、已确认决策和必要假设，不把推测写成用户事实。

## 三条对话路径

### Guided path：需求不完整

1. 读取现有 brief，仅识别会实质改变方案的缺口。
2. 使用一次阻塞式 `question` 集中询问产品或服务、核心受众、页面目标、必要页面或区块、已有文案或本地资源、响应式与交互要求、输出模式。不要逐字段连环提问。
3. 写入 `collecting`，信息足够后按 `references/discovery.md` 提出 2–3 个具体且明显不同的视觉方向。
4. 再使用 `question` 让用户选择、组合或修订；选择前停在 `style-proposed`，不得生成站点。

### Complete path：简报完整

跳过产品信息追问，但仍需给出 2–3 个视觉方向并通过 `question` 阻塞确认。只有用户已经明确给出并确认了完整视觉方向时，才可直接写为 `confirmed`。

### Direct path：明确要求立即生成

当用户明确说“直接生成”“不要追问”或授权缺失细节采用合理默认值时，不调用产品或视觉确认问题。推断安全默认值，在 brief 中显式记录 assumptions，将状态设为 `confirmed`，再开始生成。输出模式不明确时优先 `single-html`；明确要求多页面或可编辑资源树时使用 `multi-file`。

## 确认后的引用加载顺序

严格按以下顺序读取，按需而非一次性吞入全部内容：

1. 已确认 brief。
2. 已确认 visualDirection。
3. 若工作区 `.web-design/design-system/DESIGN.md` 与 `tokens.css` 同时存在且语义完整，使用它们；否则读取 `references/design-system.md` 和 `assets/tokens.css`。
4. 依次读取 `references/craft/typography.md`、`color.md`、`layout-and-hierarchy.md`、`responsive.md`、`accessibility.md`。
5. 仅当 brief 包含交互或数据状态时读取 `interaction-states.md`。
6. 最后始终读取 `anti-ai-slop.md` 做视觉复核。
7. 按选定模式读取 `references/output-contract.md`。

## 生成站点

1. 清理或重建 `.web-design/draft/`，避免上次模式的文件残留；不得触碰现有正式输出。
2. 用原生文件工具写入完整 HTML、CSS、JavaScript 和本地资源。单文件意图也可先拆分草稿，finalizer 会内联；多文件必须给出明确入口。
3. 使用语义化结构、真实或明确标注的示例内容、CSS 变量、可见焦点、键盘操作和内容驱动的响应式重排。
4. JavaScript 必须是浏览器原生、依赖为零。`single-html` 禁止静态或动态 module import；所有资源使用草稿内相对路径。
5. 在运行 finalizer 前按 anti-ai-slop 和输出契约自检；不要用手工复制替代最终化。

## Finalizer 与修复循环

从宿主加载 Skill 后取得其真实安装目录，用该目录中的脚本运行：

```bash
node "<loaded-skill-directory>/scripts/finalize.mjs" --workspace "." --source ".web-design/draft" --output "output" --mode "single-html"
```

必须把 `<loaded-skill-directory>` 替换为 Skill 加载结果返回的实际目录，不能原样执行尖括号示例。多文件把 mode 改为 `multi-file`；有多个 HTML 且入口不能自动判断时追加 `--entry "相对入口.html"`。

只解析 stdout 中唯一的 JSON 对象：

- 退出码 0 且 `ok: true`：写 brief 为 `finalized`，保存 entry、deliverables、stats、warnings。
- 退出码 1：依据 `code`、`files` 和 `details` 只修复 draft，最多修复并重试 2 次；不得为通过校验而删除必要功能。
- 退出码 2：停止。向用户说明参数、路径、锁或事务问题；不得绕过 finalizer、静默重试或手工覆盖 output。

## 登记与交付

只有 finalizer 返回 `ok: true` 后才能调用 `result_file`：

- `single-html`：登记 `output/index.html`。
- `multi-file`：登记 `output/site.preview.html` 与 `output/site.zip`；`output/site/` 是可编辑源树，不作为目录型结果登记。

登记成功后把 brief 状态原子更新为 `delivered`。最终回复概括确认的视觉方向、输出模式、可编辑入口、已登记文件、文件数与字节数以及所有 warning。
