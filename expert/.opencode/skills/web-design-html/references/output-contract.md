# 静态网站输出契约

## 写入边界

- 生成源只写 `.web-design/draft/`；禁止直接写入 output/。
- `output/` 是 finalizer 管理的完整事务目录。不要在成功后手工修补其中任何文件。
- delivered 文件不得引用 `.web-design/`、工作区外路径或远程 URL。

## 模式

`single-html` 最终只有 `output/index.html`。finalizer 会递归内联本地样式、脚本、图片与字体；草稿中的多个 HTML 必须指定入口，其他页面不会被交付。单 HTML 禁止 module import 与嵌套 HTML iframe/object。

`multi-file` 最终包含可编辑的 `output/site/`、自包含预览 `output/site.preview.html` 和下载包 `output/site.zip`。ZIP 解压后入口直接是 `index.html`；预览与 ZIP 不会混入 `site/`。

## 命令

脚本路径必须来自已加载 Skill 的真实安装目录：

```bash
node "实际Skill目录/scripts/finalize.mjs" --workspace "." --source ".web-design/draft" --output "output" --mode "single-html"
node "实际Skill目录/scripts/finalize.mjs" --workspace "." --source ".web-design/draft" --output "output" --mode "multi-file" --entry "home.html"
```

## 离线与资源

仅允许草稿根内的相对或站点根相对引用。禁止 HTTP(S)、协议相对、file URI、其他协议和反斜杠路径。允许 `data:`、页内 fragment、`mailto:`、`tel:`；`javascript:` 仅可作为普通 href，但优先使用语义化按钮。

硬限制：最多 1000 个文件；单文件最多 20 MiB；完整输出最多 100 MiB。未知二进制可打包，但应主动压缩大图并删除未引用资产。

## 退出码与修复

| 退出码 | 含义 | 行为 |
|---|---|---|
| 0 | 成功且已整体提交 | 读取 JSON，登记交付物 |
| 1 | 可修复的入口、引用、解析或体积问题 | 按 `code/files/details` 修 draft；最多两次 |
| 2 | 参数、路径、锁、提交或回滚安全问题 | 立即停止并说明，不覆盖正式输出 |

stdout 恰好一个 JSON。不要从人类日志猜测成功，也不要隐藏 warning。

## 登记结果

- 单 HTML：`result_file` 登记 `output/index.html`。
- 多文件：分别登记 `output/site.preview.html` 与 `output/site.zip`；不要登记目录。

多文件的可编辑入口是 `output/site/index.html`，但下一轮修改仍应回到 `.web-design/draft/` 后重新 finalizer，以保持收据和交付物一致。
