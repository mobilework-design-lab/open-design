# 可访问性基线

- 文档必须有有效 `lang`、具体 `title`、charset 和 viewport；使用 header/nav/main/aside/footer 及一条清晰的 h1→h2→h3 层级。
- 优先原生元素：导航用链接，动作使用 button，字段有可见 label。禁止用不可聚焦的 div 模拟控件或使用正 `tabindex` 修复错误 DOM。
- 所有功能可仅用键盘完成；焦点顺序符合阅读顺序，`:focus-visible` 清晰且不被 fixed 元素遮挡，弹层可 Escape 关闭并正确归还焦点。
- 内容图片写有意义 alt，装饰图片 `alt=""`；图表提供文字摘要，图标按钮提供可访问名称。
- 正文对比至少 4.5:1，大文字、边界与焦点至少 3:1；颜色不是唯一状态线索。
- 错误通过 `aria-describedby` 关联字段并保留输入；动态状态用预先存在的 live region，避免滥用 ARIA。
- 支持 `prefers-reduced-motion`，无频闪和自动播放干扰；自动更新、轮播或超时交互提供暂停或延长方式。
