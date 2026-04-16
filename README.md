# Next Up

**浏览器里的视觉行动看板。**

Next Up 把你的新标签页变成一个个人行动面板。从任意网页截取区域截图，写下要做的事，按意图分类管理。像一个住在浏览器里的视觉 todo list。

没有服务器，没有账号，没有任何外部 API 调用。100% 本地 Chrome 扩展。

> Fork 自 [zarazhangrui/tab-out](https://github.com/zarazhangrui/tab-out)，重构为视觉行动系统。

---

<img width="2900" height="1820" alt="Clipboard_Screenshot_1776342796" src="https://github.com/user-attachments/assets/ab3af51b-6c3e-4aac-826e-dda776a5452f" />


---

## 它做什么

1. **浏览任意网页** → 点击工具栏的 Next Up 图标
2. **框选截图** → 在页面上拖拽选区，类似 CleanShot
3. **写下行动步骤** → 这个页面你要拿来做什么
4. **选择意图分类** → Read Later、To Practice、Deep Dive，或者你自定义的分类
5. **打开新标签页** → 看到你的视觉看板，按意图筛选
6. **点击卡片** → 打开 WYSIWYG 编辑器，用 markdown、checkbox、内嵌图片追踪进度

---

## 功能

### 视觉行动卡片
- **区域截图捕获** — 在任意网页上拖拽框选截图
- **Cmd+V 快速创建** — 从剪贴板粘贴图片，直接在新标签页创建卡片
- **丰富的卡片网格** — 截图、行动步骤、意图标签、域名信息

### 意图系统
- **自定义分类** — 创建你自己的意图（如 "Coding Project"、"GEO"、"Spanish"）
- **筛选看板** — 点击意图标签筛选卡片
- **随处新建** — 在 popup、看板、粘贴弹窗中都能新建意图

### WYSIWYG 编辑器
- **点击卡片** 打开全屏编辑器，背景模糊
- **Markdown 快捷输入** — 输入 `- ` 变列表、`[] ` 变 checkbox、`## ` 变标题
- **键盘快捷键** — Cmd+B 加粗、Cmd+I 斜体、Cmd+K 插入链接
- **粘贴图片** — 在编辑器内 Cmd+V 直接嵌入截图
- **自动保存** — 输入即保存，无需手动操作

<img width="2880" height="1560" alt="Clipboard_Screenshot_1776342824" src="https://github.com/user-attachments/assets/a08012c2-e030-4368-a2c4-3f7a8614a7f6" />


### 其他
- **打开的标签页** — 可折叠区域，展示所有浏览器标签按域名分组
- **Confetti + 音效** — 关闭标签时的愉悦动效
- **重复检测** — 标记重复打开的标签
- **100% 本地** — 所有数据存在 `chrome.storage.local`，不会离开你的电脑

---

## 安装

**1. 克隆仓库**

```bash
git clone https://github.com/AOMJ2PMP/tab-out.git
```

**2. 加载扩展**

1. 打开 Chrome → `chrome://extensions`
2. 开启右上角 **开发者模式**
3. 点击 **加载已解压的扩展程序**
4. 选择 `extension/` 文件夹

**3. 打开新标签页**

你会看到 Next Up。

---

## 工作流程

```
浏览网页
  → 点击 Next Up 图标 → 框选截图
  → 写下行动步骤 → 选择意图 → 保存
  → 打开新标签页 → 看到视觉看板
  → 点击卡片 → WYSIWYG 编辑器 → 追踪进度
  → 完成了？打勾，放烟花 🎉
```

---

## 技术栈

| 模块 | 技术 |
|------|------|
| 扩展 | Chrome Manifest V3 |
| 存储 | chrome.storage.local |
| Markdown | marked.js |
| 编辑器 | contenteditable WYSIWYG |
| 截图 | chrome.tabs.captureVisibleTab + OffscreenCanvas 裁剪 |
| 区域选取 | Content script + 拖拽 overlay |
| 音效 | Web Audio API（合成，无文件） |
| 字体 | Fraunces (serif) + SN Pro (sans) + LXGW WenKai (中文) |

---

## License

MIT

---

Fork 自 [tab-out](https://github.com/zarazhangrui/tab-out) by [Zara](https://x.com/zarazhangrui)。由 Lux 重构。
