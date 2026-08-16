/**
 * @dsh-external/dsh-paper-checker
 * 检查学术期刊投稿审稿状态并定时汇报。
 * - Editorial Manager 期刊：内置确定性 Playwright 抓取（channel msedge）
 * - 其他投稿系统（system='other'）：回退信号，交由 AI 用浏览器工具处理
 * - 守护定时：每天到点自动检查 → 写报告 → 推微信（Server酱）
 */
import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { installSettingsSection } from '@deepseek-ai/dsh-settings'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import z from '@deepseek-ai/schemastery'
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { homedir } from 'node:os'
import https from 'node:https'

type AppContext = Context & {
  setInterval(fn: () => void, ms: number): any
  tools: { register(def: any): () => void }
  webServer: { register(def: any): () => void }
  agents: { get(id: string): any; list(): any[] }
  sessions: { list(): any[]; get(id: string): any }
  llm: { stream(options: any): AsyncIterable<any> }
}

export const name = '@dsh-external/dsh-paper-checker'
export const inject = ['tools', 'timer', 'webServer', 'agents', 'sessions', 'llm']

// ============ 配置 ============
export interface JournalConfig {
  name: string
  baseUrl: string
  username: string
  password: string
  sections: string[]
  system?: 'editorial-manager' | 'other'
}

export interface Config {
  journals: JournalConfig[]
  time: string
  timezone: string
  scheduleEnabled: boolean
  serverchanKey: string
  reportDir: string
  reportSessionId: string
  discoverProvider: string
  discoverModel: string
}

export const Config = z.object({
  journals: z.array(z.object({
    name: z.string(),
    baseUrl: z.string(),
    username: z.string(),
    password: z.string(),
    sections: z.array(z.string()).default([]),
    system: z.union([z.const('editorial-manager'), z.const('other')]).default('editorial-manager'),
  })).default([]),
  time: z.string().default('08:00'),
  timezone: z.string().default('Asia/Shanghai'),
  scheduleEnabled: z.boolean().default(true),
  serverchanKey: z.string().default(''),
  reportDir: z.string().default(''),
  reportSessionId: z.string().default(''),
  discoverProvider: z.string().default(''),
  discoverModel: z.string().default(''),
})

// ============ 数据结构 ============
interface Submission {
  number: string
  title: string
  submitted?: string
  statusDate?: string
  revBegan?: string
  revDue?: string
  status: string
}
interface SectionResult {
  name: string
  count: number
  submissions: Submission[]
}
interface JournalResult {
  journal: string
  system: string
  sections?: SectionResult[]
  error?: string
}

// ============ 状态翻译 ============
const STATUS_ZH: Record<string, string> = {
  'Under Review': '审稿中',
  'In Production': '生产中',
  'Needs Author Action': '等待作者操作',
  'With Editor': '编辑处理中',
  'Required Reviews Completed': '审稿完成',
  'Decision in Process': '决策中',
  'Submissions Needing Revision': '需要修改',
  'Major Revision': '大修',
  'Minor Revision': '小修',
  'Revisions Being Processed': '修改处理中',
  'Completed': '已完成',
  'Accepted': '已接受',
  'Rejected': '已拒稿',
}
const zh = (s: string): string => STATUS_ZH[s.trim()] ?? s.trim()

// ============ 工具函数 ============
function defaultReportDir(): string {
  return join(homedir(), '.dsh', 'paper-checker', 'reports')
}

function log(reportDir: string, msg: string): void {
  try {
    const dir = reportDir || defaultReportDir()
    mkdirSync(dir, { recursive: true })
    appendFileSync(join(dir, 'run.log'), '[' + new Date().toISOString() + '] ' + msg + '\n')
  } catch { /* 静默 */ }
}

async function readBody(req: any): Promise<string> {
  const chunks: Buffer[] = []
  for await (const c of req) chunks.push(Buffer.from(c as any))
  return Buffer.concat(chunks).toString('utf8')
}

function nowInTz(timezone: string): { date: string; time: string } {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone, hour12: false,
    year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit',
  }).formatToParts(new Date())
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? ''
  return { date: `${get('year')}-${get('month')}-${get('day')}`, time: `${get('hour')}:${get('minute')}` }
}

// ============ Editorial Manager 确定性抓取 ============
async function waitForFrame(page: any): Promise<any | null> {
  for (let i = 0; i < 30; i++) {
    const f = page.frame({ name: 'content' })
    // 必须等 iframe 真正加载出登录页（避免拿到 about:blank 空 frame）
    if (f && f.url() && !f.url().includes('about:blank')) return f
    await page.waitForTimeout(1000)
  }
  return page.frame({ name: 'content' })
}

async function waitForMainMenu(page: any): Promise<any | null> {
  for (let i = 0; i < 40; i++) {
    await page.waitForTimeout(1000)
    const f = page.frame({ name: 'content' })
    if (f && (f.url().includes('AuthorMainMenu') || f.url().includes('MainMenu'))) {
      const txt = await f.evaluate(() => (document.body ? document.body.innerText : '')).catch(() => '')
      if (txt.includes('Submissions')) return f
    }
  }
  return null
}

async function scrapeMenu(frame: any): Promise<{ counts: Record<string, number>; links: Record<string, string> }> {
  const text = await frame.evaluate(() => (document.body ? document.body.innerText : '')).catch(() => '')
  const counts: Record<string, number> = {}
  for (const m of text.matchAll(/([^\n()]{2,60}?)\s*\((\d+)\)/g)) counts[m[1].trim()] = parseInt(m[2], 10)
  const links: Record<string, string> = await frame.evaluate(() => {
    const out: Record<string, string> = {}
    for (const a of document.querySelectorAll('a')) {
      const t = (a.innerText || '').trim()
      if (t && a.href) out[t] = a.href
    }
    return out
  }).catch(() => ({}))
  return { counts, links }
}

async function parseTable(frame: any): Promise<{ headers: string[]; rows: string[][] } | null> {
  for (let i = 0; i < 40; i++) {
    const n = await frame.locator('table#datatable').count().catch(() => 0)
    if (n > 0) {
      return frame.evaluate(() => {
        const table = document.querySelector('table#datatable')
        if (!table) return null
        const ths = Array.from(table.querySelectorAll('thead th')).map((th: any) => (th.innerText || '').replace(/\s+/g, ' ').trim() || 'action')
        const rows = Array.from(table.querySelectorAll('tbody tr')).map((tr: any) =>
          Array.from(tr.querySelectorAll('td')).map((td: any) => (td.innerText || '').replace(/\s+/g, ' ').trim()),
        )
        return { headers: ths, rows }
      }).catch(() => null)
    }
    await frame.waitForTimeout(500)
  }
  return null
}

function normalizeRows(parsed: { headers: string[]; rows: string[][] } | null): Submission[] {
  if (!parsed) return []
  return parsed.rows.map((cells) => {
    const rec: Record<string, string> = {}
    parsed.headers.forEach((h, i) => { rec[h.toLowerCase()] = cells[i] ?? '' })
    return {
      number: rec['manuscript number'] ?? '',
      title: rec['title'] ?? rec['article title'] ?? '',
      submitted: rec['initial date submitted'] ?? '',
      statusDate: rec['status date'] ?? rec['final decision date'] ?? '',
      revBegan: rec['date revision began'] ?? '',
      revDue: rec['date revision due'] ?? '',
      status: rec['current status'] ?? rec['production status'] ?? '',
    }
  }).filter((s) => s.number || s.title)
}

/** 登录 EM 期刊并返回作者主菜单信息（用于「新增期刊」自动识别 name/sections）。 */
async function loginAndGetMenu(baseUrl: string, username: string, password: string): Promise<{
  title: string; bodyText: string; counts: Record<string, number>; links: Record<string, string>; error?: string
}> {
  const dbg: string[] = []
  const { chromium } = await import('playwright-core')
  const browser = await chromium.launch({ channel: 'msedge', headless: true })
  try {
    const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, locale: 'en-US' })
    const page = await ctx.newPage()
    await page.goto(`${baseUrl}/Default.aspx?pg=login.asp&username=`, { waitUntil: 'domcontentloaded', timeout: 60000 })
    let frame = await waitForFrame(page)
    if (!frame) return { title: '', bodyText: '', counts: {}, links: {}, error: '未找到登录 iframe' }
    dbg.push('frameUrl=' + frame.url())

    await frame.waitForSelector("input[name='username']", { state: 'attached', timeout: 20000 }).catch(() => {})
    await frame.evaluate(() => {
      const details = document.querySelector('#traditionalLoginCollapsible')
      if (details) (details as any).open = true
      const ud = document.querySelector('#userNamePasswordDiv')
      if (ud) ud.classList.remove('hideElement')
      const eb = document.querySelector('#emLoginButtonsDiv')
      if (eb) eb.classList.remove('hideElement')
    }).catch(() => {})
    await frame.waitForSelector("input[name='username']", { state: 'visible', timeout: 10000 }).catch(() => {})
    const uVisible = await frame.locator("input[name='username']").isVisible().catch(() => false)
    dbg.push('usernameVisible=' + uVisible)
    if (uVisible) {
      await frame.fill("input[name='username']", username).catch((e) => dbg.push('fillU=' + String(e).split('\n')[0]))
      await frame.fill("input[name='password']", password).catch((e) => dbg.push('fillP=' + String(e).split('\n')[0]))
      const ab = frame.locator("input[name='authorLogin']")
      await ab.click().catch((e) => dbg.push('clickA=' + String(e).split('\n')[0]))
    }
    frame = await waitForMainMenu(page)
    if (!frame) return { title: '', bodyText: '', counts: {}, links: {}, error: '登录失败或未等到主菜单 [' + dbg.join(' | ') + ']' }

    const title = await frame.evaluate(() => {
      const t = document.querySelector('h1, h2, .pageTitle, #pageTitle')
      return (t as any)?.innerText?.trim() || document.title || ''
    }).catch(() => '')
    const { counts, links } = await scrapeMenu(frame)
    const bodyText = await frame.evaluate(() => (document.body ? document.body.innerText : '')).catch(() => '')
    return { title, bodyText, counts, links }
  } catch (e) {
    return { title: '', bodyText: '', counts: {}, links: {}, error: String(e) }
  } finally {
    await browser.close().catch(() => {})
  }
}

async function scrapeEmJournal(j: JournalConfig): Promise<JournalResult> {
  const dbg: string[] = []
  const { chromium } = await import('playwright-core')
  const browser = await chromium.launch({ channel: 'msedge', headless: true })
  try {
    const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, locale: 'en-US' })
    const page = await ctx.newPage()
    await page.goto(`${j.baseUrl}/Default.aspx?pg=login.asp&username=`, { waitUntil: 'domcontentloaded', timeout: 60000 })
    let frame = await waitForFrame(page)
    if (!frame) return { journal: j.name, system: 'editorial-manager', error: '未找到登录 iframe' }
    dbg.push('frameUrl=' + frame.url())

    // 等 username 元素出现在 DOM（login.asp 异步渲染，先等 attached 不要求可见）
    await frame.waitForSelector("input[name='username']", { state: 'attached', timeout: 20000 }).catch(() => {})
    // 主动展开传统登录折叠面板 + 移除 hideElement（CBM 的折叠/显示由 JS 动态控制）
    await frame.evaluate(() => {
      const details = document.querySelector('#traditionalLoginCollapsible')
      if (details) (details as any).open = true
      const ud = document.querySelector('#userNamePasswordDiv')
      if (ud) ud.classList.remove('hideElement')
      const eb = document.querySelector('#emLoginButtonsDiv')
      if (eb) eb.classList.remove('hideElement')
    }).catch(() => {})
    await frame.waitForSelector("input[name='username']", { state: 'visible', timeout: 10000 }).catch(() => {})
    const uVisible = await frame.locator("input[name='username']").isVisible().catch(() => false)
    dbg.push('usernameVisible=' + uVisible)
    if (uVisible) {
      await frame.fill("input[name='username']", j.username).catch((e) => dbg.push('fillU=' + String(e).split('\n')[0]))
      await frame.fill("input[name='password']", j.password).catch((e) => dbg.push('fillP=' + String(e).split('\n')[0]))
      const ab = frame.locator("input[name='authorLogin']")
      const abVisible = await ab.isVisible().catch(() => false)
      dbg.push('authorVisible=' + abVisible)
      await ab.click().catch((e) => dbg.push('clickA=' + String(e).split('\n')[0]))
    }
    frame = await waitForMainMenu(page)
    if (!frame) return { journal: j.name, system: 'editorial-manager', error: '登录失败或未等到主菜单 [' + dbg.join(' | ') + ']' }

    const { counts, links } = await scrapeMenu(frame)
    const sections: SectionResult[] = []
    for (const secName of j.sections) {
      const count = counts[secName] ?? 0
      const href = links[secName]
      const submissions: Submission[] = []
      if (count > 0 && href) {
        await frame.goto(href, { waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => {})
        submissions.push(...normalizeRows(await parseTable(frame)))
      }
      sections.push({ name: secName, count, submissions })
    }
    return { journal: j.name, system: 'editorial-manager', sections }
  } catch (e) {
    return { journal: j.name, system: 'editorial-manager', error: String(e) }
  } finally {
    await browser.close().catch(() => {})
  }
}

// ============ 报告与通知 ============
function formatReport(results: JournalResult[], dateStr: string): string {
  const lines: string[] = [`📊 每日投稿状态报告 (${dateStr})`, '']
  let total = 0
  for (const r of results) {
    lines.push(`**${r.journal}:**`)
    if (r.error) {
      lines.push(`- ⚠️ ${r.error}`)
      continue
    }
    if (r.system === 'other') {
      lines.push('- 需 AI 手动检查（非 Editorial Manager，请用浏览器工具或 check_paper_status 交互式处理）')
      continue
    }
    const subs = (r.sections ?? []).flatMap((s) => s.submissions)
    total += subs.length
    if (subs.length === 0) {
      lines.push('- 无活跃投稿（关注分区计数均为 0）。')
    } else {
      for (const s of subs) {
        const parts: string[] = []
        if (s.submitted) parts.push(`投稿 ${s.submitted}`)
        if (s.statusDate) parts.push(`更新 ${s.statusDate}`)
        if (s.revDue) parts.push(`截止 ${s.revDue}`)
        lines.push(`- [${zh(s.status)}] ${s.number}: ${s.title}${parts.length ? '（' + parts.join('，') + '）' : ''}`)
      }
    }
    lines.push('')
  }
  lines.push(`**摘要:** 共 ${total} 篇活跃投稿。`)
  return lines.join('\n')
}

function pushServerChan(key: string, title: string, desp: string): Promise<boolean> {
  return new Promise((resolve) => {
    if (!key) return resolve(false)
    const body = JSON.stringify({ title, desp })
    const req = https.request({
      hostname: 'sctapi.ftqq.com', path: `/${key}.send`, method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
      timeout: 20000,
    }, (res) => {
      res.resume()
      res.on('end', () => resolve(res.statusCode === 200))
    })
    req.on('error', () => resolve(false))
    req.on('timeout', () => { req.destroy(); resolve(false) })
    req.write(body)
    req.end()
  })
}

// ============ 主检查流程 ============
async function runCheck(config: Config): Promise<JournalResult[]> {
  const results: JournalResult[] = []
  for (const j of config.journals) {
    if (j.system === 'other') {
      results.push({ journal: j.name, system: 'other' })
    } else {
      results.push(await scrapeEmJournal(j))
    }
  }
  return results
}

// ============ 对话内汇报 ============
/** 从会话事件里取第一条用户文本作为回退标题。 */
function fallbackSessionTitle(session: any): string {
  try {
    for (const e of session.events ?? []) {
      if (e.type === 'user/message' && e.data?.message?.kind === 'user') {
        for (const block of e.data.message.content ?? []) {
          if (block.type === 'text' && block.text) {
            const t = String(block.text).replace(/\s+/g, ' ').trim()
            return t.length > 32 ? t.slice(0, 32) + '…' : t
          }
        }
      }
    }
  } catch { /* 静默 */ }
  return '(未命名)'
}

/** 列出当前 live 会话（sessionId + cwd + 标题），供设置面板选择汇报目标。 */
function listLiveSessions(agents: any, sessions: any, sessionTitle: any): any[] {
  const out: any[] = []
  try {
    for (const s of sessions.list() ?? []) {
      const title = sessionTitle?.get?.(s)?.title ?? fallbackSessionTitle(s)
      out.push({
        sessionId: s.id,
        cwd: s.header?.cwd ?? '',
        title,
        running: agents?.get?.(s.id)?.status === 'running',
      })
    }
  } catch { /* 静默 */ }
  out.sort((a, b) => String(a.title).localeCompare(String(b.title), 'zh'))
  return out
}

/** 往指定 live 会话注入一条用户消息（报告），触发 agent 简短确认。返回 'ok' 或失败原因。 */
function reportToSession(agents: any, sessionId: string, report: string): string {
  if (!sessionId) return '未配置汇报会话'
  const agent = agents?.get?.(sessionId)
  if (!agent || typeof agent.followup !== 'function') {
    return `会话 ${sessionId} 未打开（非 live），无法汇报到对话`
  }
  const message = createUserMessage({
    content: [{
      type: 'text',
      text: '⏰ 每日投稿状态自动汇报（插件 dsh-paper-checker）：\n\n' + report +
        '\n\n——请一句话确认收到即可，不要重新检查、不要调用工具。',
    }],
    source: { kind: 'user' },
  })
  agent.followup(message)
  return 'ok'
}

// ============ 新增期刊自动识别 ============
/** 用 LLM 生成一段文本（provider/model 可覆盖；为空则读 agent-default-model）。 */
async function callLlmText(llmService: any, settingsService: any, prompt: string, providerOverride?: string, modelOverride?: string): Promise<string> {
  let provider = 'deepseek-official'
  let model = 'deepseek-v4-pro'
  try {
    const dm = settingsService?.get?.('agent-default-model')
    if (dm?.provider) provider = dm.provider
    if (dm?.model) model = dm.model
  } catch { /* 用默认 */ }
  if (providerOverride) {
    provider = providerOverride
    if (modelOverride) {
      model = modelOverride
    } else {
      // 只指定 provider：取该 provider 目录里的第一个模型，避免错配全局默认的 model
      try {
        const models = await llmService.listModels(providerOverride)
        if (Array.isArray(models) && models.length > 0) model = models[0].id
      } catch { /* 保持 agent-default-model 的 model */ }
    }
  } else if (modelOverride) {
    model = modelOverride
  }

  const messages = [createUserMessage({
    content: [{ type: 'text', text: prompt }],
    source: { kind: 'user' },
  })]
  // 先尝试 reasoningEffort 'off'（省 token、关闭思考）；空输出（不支持 off / reasoning 占满）则回退到不传（adapter 默认）。
  for (const effort of ['off', undefined] as const) {
    const out: string[] = []
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), 180000)
    try {
      const stream = llmService.stream({
        provider, model,
        ...effort === undefined ? {} : { reasoningEffort: effort },
        messages,
        maxTokens: 8000,
        signal: controller.signal,
      })
      for await (const chunk of stream) {
        if (chunk?.type === 'text-delta' && chunk.text) out.push(chunk.text)
      }
    } finally {
      clearTimeout(timer)
    }
    if (out.length > 0) return out.join('')
  }
  return ''
}

/** 分析 EM 主菜单文本，识别期刊名 + 需跟踪分区。 */
async function analyzeJournalMenu(llmService: any, settingsService: any, baseUrl: string, bodyText: string, providerOverride?: string, modelOverride?: string): Promise<{ name?: string; sections?: string[]; system?: string; error?: string }> {
  const prompt = [
    '你是学术期刊投稿系统配置助手。下面是某个 Editorial Manager 投稿网站登录后的作者主菜单文本。',
    '请从中识别：',
    '1) 期刊名（英文全名，去掉页面里无关的品牌文案）；',
    '2) 需要跟踪审稿/修改/生产状态的分区名（例如 Submissions Being Processed、Submissions Needing Revision、Submissions in Production、Revisions Being Processed、Revisions Under Review 等；忽略 Incomplete Submissions 等无关项）。',
    '系统类型固定为 editorial-manager。',
    '',
    '站点地址：' + baseUrl,
    '',
    '菜单文本：',
    bodyText.slice(0, 6000),
    '',
    '只输出一个 JSON 对象（不要 markdown 代码块、不要多余说明），格式：',
    '{"name":"期刊名","sections":["分区名1","分区名2"],"system":"editorial-manager"}',
  ].join('\n')
  const text = await callLlmText(llmService, settingsService, prompt, providerOverride, modelOverride)
  const m = text.match(/\{[\s\S]*\}/)
  if (!m) return { error: '模型未返回有效 JSON: ' + text.slice(0, 200) }
  try {
    const obj = JSON.parse(m[0])
    return {
      name: typeof obj.name === 'string' ? obj.name : undefined,
      sections: Array.isArray(obj.sections) ? obj.sections.filter((s: any) => typeof s === 'string') : [],
      system: obj.system === 'other' ? 'other' : 'editorial-manager',
    }
  } catch (e) {
    return { error: 'JSON 解析失败: ' + String(e) + ' | ' + text.slice(0, 200) }
  }
}

// ============ 插件入口 ============
export function apply(ctx: AppContext, config: Config): void {
  // settings 化：配置可运行时读写 + 持久化到 settings.yaml（UI 可编辑）
  let getConfig: () => Config = () => config
  installSettingsSection(ctx, 'paper-checker', Config, config, {
    setSource: (fn: any) => { getConfig = fn as () => Config },
    onChange: () => {},
  })

  const reportDir = () => getConfig().reportDir || defaultReportDir()
  mkdirSync(reportDir(), { recursive: true })

  // 自定义配置 API：绕过 apiproxy 的 settings 白名单（paper-checker 不在 WEB_SETTINGS_NAMESPACES，
  // 走 describe/mutate 会被 notExposed 拦截），改由 webServer 直连 host 内部 settings 服务。
  let settingsService: any = null
  ctx.inject(['settings'], (sctx: any) => { settingsService = sctx.settings })
  let sessionTitleService: any = null
  ctx.inject(['sessionTitle'], (sctx: any) => { sessionTitleService = sctx.sessionTitle })

  ctx.effect(() => ctx.webServer.register({
    kind: 'prefix',
    path: '/paper-checker/api',
    handler: async (req: any, res: any) => {
      const send = (code: number, obj: any) => {
        res.writeHead(code, { 'content-type': 'application/json; charset=utf-8' })
        res.end(JSON.stringify(obj))
      }
      try {
        const url = new URL(req.url ?? '/', 'http://localhost')
        const p = url.pathname.replace(/^\/paper-checker\/api/, '') || '/'
        if (req.method === 'GET' && p === '/config') {
          if (!settingsService?.describe) return send(500, { ok: false, error: 'settings 服务不可用' })
          const desc = settingsService.describe().find((d: any) => d.ns === 'paper-checker')
          return send(200, { ok: true, config: desc?.value ?? getConfig(), revision: desc?.revision ?? 0 })
        }
        if (req.method === 'GET' && p === '/sessions') {
          return send(200, { ok: true, sessions: listLiveSessions(ctx.agents, ctx.sessions, sessionTitleService) })
        }
        if (req.method === 'POST' && p === '/config') {
          const body = JSON.parse(await readBody(req))
          const value = body?.config
          const expectedRevision = body?.expectedRevision
          if (!settingsService?.mutate) return send(500, { ok: false, error: 'settings 服务不可用' })
          await settingsService.mutate('paper-checker', [{ op: 'set', path: [], value }], expectedRevision)
          const desc = settingsService.describe().find((d: any) => d.ns === 'paper-checker')
          return send(200, { ok: true, revision: desc?.revision ?? 0 })
        }
        if (req.method === 'POST' && p === '/run') {
          const results = await runCheck(getConfig())
          const dateStr = new Date().toISOString().slice(0, 10)
          return send(200, { ok: true, report: formatReport(results, dateStr) })
        }
        if (req.method === 'POST' && p === '/report') {
          const cfg = getConfig()
          const dir = cfg.reportDir || defaultReportDir()
          let report = ''
          try { report = readFileSync(join(dir, 'latest.md'), 'utf8') } catch { /* 无最近报告 */ }
          if (!report) {
            const results = await runCheck(cfg)
            report = formatReport(results, new Date().toISOString().slice(0, 10))
          }
          const r = reportToSession(ctx.agents, cfg.reportSessionId, report)
          return send(200, { ok: true, result: r })
        }
        if (req.method === 'POST' && p === '/discover') {
          const body = JSON.parse(await readBody(req))
          const baseUrl = String(body?.baseUrl ?? '').trim().replace(/\/+$/, '')
          const username = String(body?.username ?? '').trim()
          const password = String(body?.password ?? '')
          if (!baseUrl || !username || !password) return send(400, { ok: false, error: '网址/账号/密码不能为空' })
          const menu = await loginAndGetMenu(baseUrl, username, password)
          if (menu.error) return send(200, { ok: false, error: menu.error })
          // 模型识别优先；失败则确定性回退（页面标题 + 带计数分区）
          let name = menu.title?.trim() || ''
          let sections = Object.keys(menu.counts).filter((k) => (menu.counts[k] ?? 0) > 0)
          let system = 'editorial-manager'
          const cfgNow = getConfig()
          const parsed = await analyzeJournalMenu(ctx.llm, settingsService, baseUrl, menu.bodyText || menu.title, cfgNow.discoverProvider, cfgNow.discoverModel)
          if (!parsed.error) {
            if (parsed.name?.trim()) name = parsed.name.trim()
            if (parsed.sections?.length) sections = parsed.sections
            if (parsed.system) system = parsed.system
          }
          if (!name) name = new URL(baseUrl).hostname.replace(/^www\./, '').replace(/\.editorialmanager\.com$/, '')
          return send(200, { ok: true, config: { name, baseUrl, username, password, sections, system }, llmError: parsed.error })
        }
        return send(404, { ok: false, error: 'not found: ' + p })
      } catch (e: any) {
        return send(500, { ok: false, error: String(e?.message ?? e) })
      }
    },
  }), 'paper-checker: config api')

  // 工具：按需检查
  const disposeTool = ctx.tools.register(defineTool({
    name: 'check_paper_status',
    description: '检查配置的学术期刊投稿审稿状态（Editorial Manager 期刊确定性抓取；其他系统返回回退信号，请改用浏览器工具手动检查）。',
    parameters: {
      journal_name: { type: 'string', description: '可选：只检查指定期刊名；缺省检查全部配置期刊。' },
    },
    output: {
      schema: { type: 'string' },
      render: (_args: any, value: string) => [{ type: 'text', text: value }],
    },
    async execute(args: any) {
      const cfg = getConfig()
      const journals = args.journal_name
        ? cfg.journals.filter((j) => j.name === args.journal_name)
        : cfg.journals
      if (journals.length === 0) return '没有匹配的期刊配置。'
      const results = await runCheck({ ...cfg, journals })
      const dateStr = new Date().toISOString().slice(0, 10)
      const report = formatReport(results, dateStr)
      return report
    },
    presentCall: (args: any) => ({ card: 'generic', title: '检查投稿状态', kind: 'read', rawInput: args.journal_name ?? '' }),
  }))
  ctx.effect(() => disposeTool, 'paper-checker: tool')

  // 守护定时：每天到点自动检查（配置变化后下次 tick 自动用新值）
  let lastRunDate = ''
  ctx.setInterval(() => {
    void (async () => {
      const cfg = getConfig()
      if (!cfg.scheduleEnabled || cfg.journals.length === 0) return
      const { date, time } = nowInTz(cfg.timezone)
      if (time === cfg.time && lastRunDate !== date) {
        lastRunDate = date
        const dir = cfg.reportDir || defaultReportDir()
        log(dir, '定时检查开始 date=' + date + ' time=' + time)
        const results = await runCheck(cfg)
        const report = formatReport(results, date)
        writeFileSync(join(dir, `report-${date}.md`), report, 'utf8')
        writeFileSync(join(dir, 'latest.md'), report, 'utf8')
        if (cfg.serverchanKey) {
          const ok = await pushServerChan(cfg.serverchanKey, `📊 投稿状态报告 (${date})`, report)
          log(dir, '微信推送: ' + (ok ? '成功' : '失败'))
        }
        if (cfg.reportSessionId) {
          const r = reportToSession(ctx.agents, cfg.reportSessionId, report)
          log(dir, '对话汇报: ' + r)
        }
        log(dir, '定时检查完成')
      }
    })().catch((e) => log(reportDir(), '定时检查异常: ' + String(e)))
  }, 30000)
  ctx.logger?.info?.('[@dsh-external/dsh-paper-checker] 守护定时启动（每天 ' + getConfig().time + ' ' + getConfig().timezone + '）')
}
