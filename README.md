# @dsh-external/dsh-paper-checker

检查学术期刊投稿审稿状态并定时汇报的 DSH 插件。

- **Editorial Manager 期刊**：内置确定性 Playwright 抓取（`channel: msedge`，用系统 Edge，无需下载浏览器）。
- **自动识别稿件阶段**：主菜单上所有「活跃投稿分区」自动抓取（审稿 submission / 修改 revision / 生产 production），报告按分区分组 + 摘要统计三阶段篇数。
- **已决策稿件**：自动抓取 `Submissions with a Decision`（含拒绝/接受结果），但只在决策后 7 天内列进报告（避免历史决策刷屏），独立分组「📂 近期决策（7 天内）」。
- **其他投稿系统**（`system: 'other'`）：返回「回退信号」，由 AI 用浏览器工具交互式处理（方案 C 混合模式）。
- **守护定时**：每天到点自动检查 → 写报告 → 推微信（Server酱）。
- **按需工具**：`check_paper_status`，agent 可随时调用。
- **设置面板**：DSH「设置 → 投稿检查」里可视化配置时间/时区/期刊列表，并支持「自动识别」新期刊。

## 安装

本插件是标准 dsh bundle（package.json 声明 `dsh.bundle.patch`，自带 `cordis.patch.yml`），可被官方 CLI 直接识别安装。

### 前提

- DSH 客户端（任意 profile，示例用 `web`）。
- 命令行里有 `dsh` 与 `pnpm`（DSH 插件管理的标准工具链）。
- 电脑已装 Microsoft Edge（Windows 默认有，用于确定性抓取）。

### 方式一：官方 CLI（推荐）

```bash
cd <tgz 所在目录>
dsh plugin --profile web add ./dsh-external-dsh-paper-checker-0.0.1.tgz
```

（相对路径会被 CLI 锚定到你的调用目录；也可用绝对路径 `dsh plugin --profile web add E:/path/to/dsh-external-dsh-paper-checker-0.0.1.tgz`。）

`dsh plugin add` 会：
1. 把 tgz 装进 profile（依赖 `playwright-core` 一并安装）；
2. 检测到本包声明了 `dsh.bundle`，自动把 `@dsh-external/dsh-paper-checker` 写入 profile 的 `dsh.profile.bundles` 启用名单。

装完**重启 DSH** 即可在「设置」里看到「投稿检查」面板，按需配置期刊后生效。

> 没有 `pnpm` 时先 `corepack enable pnpm`（Node 18+ 自带 corepack）或 `npm i -g pnpm`。

### 方式二：插件市场（若客户端装了 plugin-market / zat-dsh-engine）

把本仓库发布到 GitHub 并打上 `dsh-plugin` topic 后，在市场的「安装」入口搜索即可一键安装（市场同样会写启用名单）。

### 方式三：手动（无 dsh CLI 时）

```bash
cd <DSH_HOME>/profiles/web
pnpm add file:/绝对路径/dsh-external-dsh-paper-checker-0.0.1.tgz
# 然后编辑 <DSH_HOME>/profiles/web/package.json，
# 确保 dsh.profile.bundles 数组里含 "@dsh-external/dsh-paper-checker"，重启 DSH。
```

## 配置

安装后推荐在「设置 → 投稿检查」面板里配置（可视化 + 可自动识别新期刊）。配置持久化到 `settings.yaml` 的 `paper-checker` 命名空间。

配置结构（也可直接编辑 settings.yaml）：

```yaml
journals:
  - name: '某期刊名'
    baseUrl: 'https://www.editorialmanager.com/xxxx'
    username: 'your-email@example.com'
    password: 'your-password'
    sections:
      - 'Submissions Being Processed'
      - 'Submissions Needing Revision'
    # sections 可选：面板「自动识别新期刊」会探测主菜单全部投稿分区并自动写入（含当前 0 篇的），
    # 之后每次检查按此抓取、出现新稿件即被抓到，无需手动维护；手动加分区也可以，优先抓取
    system: 'editorial-manager'   # 默认；'other' 则回退给 AI
  - name: '某非 EM 期刊'
    baseUrl: 'https://example.com/submit'
    username: 'xxx'
    password: 'xxx'
    sections: []
    system: 'other'               # 回退：AI 用浏览器工具处理

time: '08:00'                     # 每天触发时间 HH:mm
timezone: 'Asia/Shanghai'         # IANA 时区
scheduleEnabled: true             # 是否启用守护定时
serverchanKey: 'SCTxxxx'          # Server酱 SendKey；留空则不推微信
reportDir: ''                     # 报告目录；留空默认 ~/.dsh/paper-checker/reports
reportSessionId: ''               # 可选：检查结果同步汇报到某个对话会话
discoverProvider: ''              # 可选：自动识别新期刊用的模型 Provider（留空用全局默认）
discoverModel: ''                 # 可选：自动识别新期刊用的模型（留空用全局默认）
```

## 字段说明

| 字段 | 类型 | 说明 |
|---|---|---|
| `journals[].name` | string | 期刊显示名 |
| `journals[].baseUrl` | string | EM 站点根地址（如 `https://www.editorialmanager.com/xxx`） |
| `journals[].username/password` | string | 登录凭据 |
| `journals[].sections` | string[] | 要检查的分区名；面板自动识别新期刊时探测主菜单全部分区自动写入，之后检查按此抓取（可选，留空则靠自动发现补抓） |
| `journals[].system` | 'editorial-manager'\|'other' | 抓取方式；EM 确定性，other 回退 AI |
| `time` | 'HH:mm' | 每天触发时间 |
| `timezone` | IANA 时区 | 如 Asia/Shanghai |
| `scheduleEnabled` | bool | 是否开启守护定时 |
| `serverchanKey` | string | Server酱 key，推微信用；空则跳过 |
| `reportDir` | string | 报告输出目录 |
| `reportSessionId` | string | 检查结果同步汇报的会话 id（可选） |
| `discoverProvider` / `discoverModel` | string | 自动识别新期刊所用模型（可选，留空用全局默认） |

## 输出

- 报告写入 `{reportDir}/report-{date}.md` 和 `latest.md`，运行日志 `run.log`。
- 报告按分区分组列出每篇稿件（`- 📂 分区名（计数）` → `- [状态] 稿件号: 标题（投稿/更新/截止）`），末尾摘要统计三阶段：`审稿 N 篇 · 修改 N 篇 · 生产 N 篇`；若有 7 天内决策的稿件，追加独立分组「📂 近期决策（7 天内）」与摘要 `· 近期决策 N 篇`。
- 微信推送（若配置了 `serverchanKey`）标题 `📊 投稿状态报告 (日期)`。
- 工具 `check_paper_status` 返回中文报告文本。

## 依赖

- 本机需安装 Microsoft Edge（Windows 默认有）。
- `playwright-core`（声明为 dependency，安装时自动带入；确定性抓取只驱动本机 Edge，不下载浏览器）。

## 说明

- Editorial Manager 登录兼容两种形态：直接表单 / 折叠在「Alternatively, use your username and password」里。
- 新增期刊自动探测：面板「自动识别新期刊」登录后确定性探测主菜单上**全部**投稿分区（含当前 0 篇的分区，按菜单顺序，排除 Task Assignments 任务区与 with Production Completed 已完成历史）写入 `sections`，模型只识别期刊名/系统类型（期刊名可能识别不准，面板里可直接修改后加入）；保存后每次检查按探测结果抓取，count=0 分区自动跳过、一有稿件即被抓到。老配置未写 `sections` 时，检查时自动发现 count>0 的投稿分区补抓（排除 New Submissions 入口与 with Production Completed 已完成历史）。
- 已决策分区：`Submissions with a Decision` 也自动纳入抓取（跨分页遍历全部历史，最多 8 页），报告层只显示决策日期在最近 7 天内的稿件；决策日期取 Status Date / Final Decision Date / Decision Date 列。
- 表格兼容：`table#datatable` 与 `table#GridSubmissions`（表头在 tbody 首行 `<th>`）两种 EM 结构都能解析。
- 状态翻译：Under Review→审稿中、In Production→生产中、Needs Author Action→等待作者操作、Major/Minor Revision→大修/小修、Awaiting Author Approval→等待作者确认 等 40+ 状态，另有前缀/关键词模糊匹配（含 Reject 即→已拒稿、含 Accept 即→已接受、含 Revis 即→修改中，可覆盖 Completed - Reject / Completed - Accept 等组合状态）。
- 非 EM 期刊（`system: 'other'`）在守护定时中仅标记「需 AI 检查」，交互式调用 `check_paper_status` 时由 AI 用浏览器工具完成。

## 构建（开发者）

产物 `lib/index.js`（host，自包含，已内联 `@deepseek-ai/*` 依赖）与 `lib/client.js`（client 面板）已随包分发，使用者无需构建。如需改代码后重打：

```bash
npm install            # 安装 typescript / tsdown / @types/node
npm run build:client   # tsdown 打包 host + client 到 lib/
npm pack               # 产出 tgz
```
