# ST-Archive (ST-档案馆)

一个专为SillyTavern定制首页聊天记录归档扩展。

## 档案馆
- **按角色智能折叠**：同一角色的世界线自动归档，默认收起，点击展开。
- **首页深度重构**：去掉原生的“欢迎使用”提示，将首页重绘为中英双语的「CONFIDENTIAL ARCHIVE」档案馆。
- **原生文本清洗**：首页展示剥离历史记录中的HTML标签，仅保留纯文本摘要，不影响真实聊天记录。
- **全主题自适应**：兼容亮色与暗色主题，采用极简等宽英文字体与半透明模糊背景。
- **高级检索与排序**：支持模糊搜索（角色名/标签）、按最近时间/名称正倒序排列。
- **独立置顶系统**：支持角色级置顶，以及单条聊天的置顶高亮（脱离原生状态，独立记录）。
- **分页系统**：每页展示10个角色，底部带极简分页器。
- **收藏跨设备同步**：拾遗收藏、角色置顶、聊天置顶统一保存到酒馆服务器端设置（`extension_settings`），手机和电脑连接同一台酒馆即可共用同一份数据；页面（重新）加载后自动生效。
- **本地备份**：拾遗面板右上角提供「导出 / 导入」按钮，可把全部收藏保存为 JSON 文件，或从备份文件恢复/合并收藏。
- **长文本适配**：详情弹窗限定在屏幕内滚动，超长句子、无空格长串不会再被顶出屏幕。
- **手机视口自适应**：详情弹层按当前“可见视口”定位与限高，手机本地部署、内置浏览器、地址栏伸缩等情况下也不会超出屏幕或看不到顶部。
- **详情弹层置顶**：详情卡片使用浏览器顶层（原生 `<dialog>`），不会被拾遗面板、毛玻璃或任何页面层级盖住。

## 数据存储说明

- 以前版本把收藏存在浏览器 `localStorage` 里，只对当前设备有效。v1.1.0 起改为写入服务器端设置，并在首次加载时自动把本机旧数据合并进去，不会丢收藏。
- 手机和电脑各有一份旧数据时，两端都会在升级后的第一次加载时并入服务器数据（只合并一次）。
- 悬浮按钮的拖拽位置属于设备本地习惯，仍然只保存在各自设备的 `localStorage`，不参与跨设备同步。
- 建议定期用面板右上角的「导出」保存一份 JSON 到本地，作为额外保险。

## 拾遗
- **快捷收藏**：每条 AI 回复下方自动注入书签按钮，一键收录。
- **双 Tab 分类**：内置【当前聊天】与【全部聊天】切换，全部聊天自动按 `角色名 - 存档名` 折叠分组。
- **暗红呼吸特效**：在【当前聊天】点击语录，页面平滑跳转，并附带 2 秒的左侧档案条暗红呼吸高亮。
- **古籍风详情弹窗**：在【全部聊天】点击，弹出极简排版的无纸化详情卡片。
- **空状态**：当没有语录时，界面会展示中英双语现代诗（已适配手机端排版）。
- **拖拽**：悬浮球支持全端拖拽。

## 界面预览
测试主题：Dark Lite
<p align="center">
  <img width="2549" height="1403" alt="image" src="https://github.com/user-attachments/assets/11260f80-ed59-40cf-98c6-5df07fe42d4d" width="90%" style="border-radius: 8px; box-shadow: 0 4px 12px rgba(0,0,0,0.1);" />
  <img width="2549" height="1403" alt="image" src="https://github.com/user-attachments/assets/b1cd11e6-44db-44d2-bc2a-5fffaf693b9a" width="90%" style="border-radius: 8px; box-shadow: 0 4px 12px rgba(0,0,0,0.1);" />
  <br>
  <em>PC端</em>
</p>


<p align="center">
  <img src="https://github.com/user-attachments/assets/006f68ca-64a1-4b7f-8090-9fb79a5cc773" width="45%" style="border-radius: 8px; box-shadow: 0 4px 12px rgba(0,0,0,0.1); margin-right: 10px;">
  <img src="https://github.com/user-attachments/assets/17c293e1-73b1-4fa5-86af-18b4041ed1aa" width="45%" style="border-radius: 8px; box-shadow: 0 4px 12px rgba(0,0,0,0.1);">
  <br>
  <em>手机端</em>
</p>

## 安装方法

### 方法一：酒馆一键安装（推荐）
1. 打开SillyTavern，点击顶部菜单的**“扩展”**。
2. 点击 **Install Extension**（安装扩展）。
3. 粘贴本仓库的链接，点击确认即可。

### 方法二：手动安装
将本仓库的 `manifest.json`、`index.js`、`style.css` 放入酒馆的 `public/scripts/extensions/third-party/ST-Archive` 目录下，重启酒馆。

## 开发者
- UI/交互设计/前端重构/测试：lliysp
- 底层逻辑/架构支持：DeepSeek

## 叠甲
本扩展为作者根据个人喜好深度定制的 UI 扩展，仅作个人备份，代码撰写和测试均在pc端进行。不保证与所有酒馆版本/主题完美兼容，不提供任何技术支持与 BUG 修复，不定期更新。如果你觉得好看并且信任作者和deepseek，欢迎fork使用。

## 📄 License
MIT License
