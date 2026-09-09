# 角色页回归

`npm test` 包含角色新建、切换、错误恢复、关系表单重置及草稿串行保存测试。
DOM 测试使用 jsdom，其余测试仍使用 Node 环境。

## 真实浏览器布局检查

1. 运行 `npm run dev -- --host 127.0.0.1`。
2. 提供 Playwright（已有环境无需再次安装；否则使用 `npm install --no-save --package-lock=false playwright` 和 `npx playwright install chromium`）。
3. 运行 `node scripts/check-characters.mjs`。

可选环境变量：

- `NOVELFORGE_PLAYWRIGHT_PATH`：已有 Playwright 的 `index.mjs` 绝对路径。
- `NOVELFORGE_BROWSER_CHANNEL`：使用已安装浏览器，例如 Windows 上的 `msedge`。

检查 1600×1000、1280×720、1024×640、800×600、640×480，覆盖三种主题。
使用 240 位模拟角色验证滚动、输入框高度、底部按钮可点击、关系创建、虚拟列表过滤和连续新建。
截图输出到 `test-results/characters/`（不提交）。

`tests/fixtures/characters.html` 只在开发服务器中使用，所有 IPC 都拦截到内存模拟数据，不读写真实项目数据库，不进入生产构建。

首页视觉回归使用同一套环境运行 `node scripts/check-dashboard.mjs`。它检查四种窗口尺寸、浅色/深色主题、操作入口、新建弹窗、书架和横向溢出；模拟数据同样不会访问真实项目。

项目主界面运行 `node scripts/check-workspace.mjs`，覆盖空项目、正文编辑、三种主题和 1024–1600px 窗口，验证顶栏、三栏、工具菜单、首章入口与底部状态栏。
