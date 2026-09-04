# 交互与状态覆盖

- brief 中出现数据加载、筛选、提交或异步动作时，覆盖 populated、loading、empty、error 和 edge；只做静态展示时不要虚构无关状态。
- 所有控件具备 hover、`:focus-visible`、active 和 disabled；键盘行为与原生语义一致，禁用不能只改变颜色。
- 表单还需 untouched、dirty-valid、invalid、submitting、success、failure。验证优先在 blur 或提交后触发，失败保留用户输入并把焦点引向首个错误。
- loading 给出具体对象且不能无限旋转；empty 解释原因并提供下一步；error 说明发生了什么、可知原因和恢复动作。
- 状态切换使用已有 live region：非紧急反馈 `role="status"`，需要立即处理的错误 `role="alert"`。不要为普通成功弹窗抢焦点。
- 动效只解释层级或反馈，进入约 200 ms、退出更短；减少动态偏好下关闭位移和循环装饰。
