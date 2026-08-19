window.__ModuleLoader__.load({
	id: "@dsh-external/dsh-paper-checker",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
		//#region \0rolldown/runtime.js
		var __create = Object.create;
		var __defProp = Object.defineProperty;
		var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
		var __getOwnPropNames = Object.getOwnPropertyNames;
		var __getProtoOf = Object.getPrototypeOf;
		var __hasOwnProp = Object.prototype.hasOwnProperty;
		var __copyProps = (to, from, except, desc) => {
			if (from && typeof from === "object" || typeof from === "function") for (var keys = __getOwnPropNames(from), i = 0, n = keys.length, key; i < n; i++) {
				key = keys[i];
				if (!__hasOwnProp.call(to, key) && key !== except) __defProp(to, key, {
					get: ((k) => from[k]).bind(null, key),
					enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable
				});
			}
			return to;
		};
		var __toESM = (mod, isNodeMode, target) => (target = mod != null ? __create(__getProtoOf(mod)) : {}, __copyProps(isNodeMode || !mod || !mod.__esModule || !__hasOwnProp.call(mod, "default") ? __defProp(target, "default", {
			value: mod,
			enumerable: true
		}) : target, mod));
		//#endregion
		let react = require("react");
		react = __toESM(react, 1);
		//#region src/client/index.ts
		/**
		* @dsh-external/dsh-paper-checker — client 设置面板（settings.section）。
		* 在 DSH「设置」里注册「投稿检查」区块，可视化编辑定时配置 + 期刊列表。
		* 配置读写走插件自建 HTTP API（/paper-checker/api），绕过 apiproxy 的 settings 白名单。
		*/
		const inject = ["slots", "connection"];
		const API = "/paper-checker/api";
		function fetchJson(path, init) {
			return fetch(API + path, {
				headers: { "content-type": "application/json" },
				...init
			}).then((r) => r.json());
		}
		function PaperCheckerPanel(props) {
			const api = props.api;
			const [cfg, setCfg] = react.useState(null);
			const [revision, setRevision] = react.useState(0);
			const [journalsText, setJournalsText] = react.useState("");
			const [msg, setMsg] = react.useState("");
			const [saving, setSaving] = react.useState(false);
			const [running, setRunning] = react.useState(false);
			const [report, setReport] = react.useState("");
			const [sessions, setSessions] = react.useState([]);
			const [dUrl, setDUrl] = react.useState("");
			const [dUser, setDUser] = react.useState("");
			const [dPass, setDPass] = react.useState("");
			const [discovering, setDiscovering] = react.useState(false);
			const [discovered, setDiscovered] = react.useState(null);
			const [discoveredName, setDiscoveredName] = react.useState("");
			const [discoverMsg, setDiscoverMsg] = react.useState("");
			const [modelGroups, setModelGroups] = react.useState([]);
			const loadSessions = react.useCallback(() => {
				fetchJson("/sessions").then((res) => {
					if (res.ok) setSessions(res.sessions || []);
				}).catch(() => {});
			}, []);
			const loadProviders = react.useCallback(() => {
				if (!api?.llm?.models) return;
				api.llm.models({}).then((res) => {
					const groups = res?.result?.value?.groups || [];
					setModelGroups(groups.map((g) => ({
						id: g.id,
						name: g.name,
						models: (g.models || []).map((m) => ({
							id: m.id,
							name: m.name
						}))
					})));
				}).catch(() => {});
			}, [api]);
			react.useEffect(() => {
				let alive = true;
				fetchJson("/config").then((res) => {
					if (!alive) return;
					if (res.ok) {
						setCfg(res.config || {});
						setRevision(res.revision ?? 0);
						setJournalsText(JSON.stringify(res.config?.journals || [], null, 2));
					} else setMsg("加载失败: " + (res.error ?? ""));
				}).catch((e) => {
					if (alive) setMsg("加载异常: " + String(e));
				});
				loadSessions();
				loadProviders();
				return () => {
					alive = false;
				};
			}, [loadSessions, loadProviders]);
			const save = async () => {
				if (!cfg) return;
				let journals;
				try {
					journals = JSON.parse(journalsText);
				} catch {
					setMsg("期刊列表 JSON 格式错误，未保存");
					return;
				}
				if (!Array.isArray(journals)) {
					setMsg("期刊列表必须是数组");
					return;
				}
				setSaving(true);
				try {
					const res = await fetchJson("/config", {
						method: "POST",
						body: JSON.stringify({
							config: {
								...cfg,
								journals
							},
							expectedRevision: revision
						})
					});
					if (res.ok) {
						setMsg("已保存 ✓");
						setRevision(res.revision ?? revision + 1);
					} else setMsg("保存失败: " + (res.error ?? "未知错误"));
				} catch (e) {
					setMsg("保存异常: " + String(e));
				} finally {
					setSaving(false);
				}
			};
			const runNow = async () => {
				setRunning(true);
				setReport("");
				setMsg("");
				try {
					const res = await fetchJson("/run", { method: "POST" });
					if (res.ok) setReport(res.report ?? "(无报告)");
					else setMsg("检查失败: " + (res.error ?? ""));
				} catch (e) {
					setMsg("检查异常: " + String(e));
				} finally {
					setRunning(false);
				}
			};
			const discover = async () => {
				if (!dUrl.trim() || !dUser.trim() || !dPass) {
					setDiscoverMsg("请填写网址、账号、密码");
					return;
				}
				setDiscovering(true);
				setDiscovered(null);
				setDiscoverMsg("");
				try {
					const res = await fetchJson("/discover", {
						method: "POST",
						body: JSON.stringify({
							baseUrl: dUrl.trim(),
							username: dUser.trim(),
							password: dPass
						})
					});
					if (res.ok) {
						setDiscovered(res.config);
						setDiscoveredName(res.config?.name || "");
						setDiscoverMsg(res.llmError ? "（模型识别失败，已用页面信息回退）确认无误后点「加入列表」" : "识别成功，确认无误后点「加入列表」");
					} else setDiscoverMsg("识别失败: " + (res.error ?? ""));
				} catch (e) {
					setDiscoverMsg("识别异常: " + String(e));
				} finally {
					setDiscovering(false);
				}
			};
			const addDiscovered = () => {
				if (!discovered) return;
				let journals;
				try {
					journals = JSON.parse(journalsText);
				} catch {
					journals = [];
				}
				if (!Array.isArray(journals)) journals = [];
				const name = discoveredName.trim() || discovered.name || "";
				if (!name) {
					setDiscoverMsg("期刊名不能为空");
					return;
				}
				journals.push({
					...discovered,
					name
				});
				setJournalsText(JSON.stringify(journals, null, 2));
				setDiscovered(null);
				setDiscoveredName("");
				setDiscoverMsg("已加入列表，记得点「保存」");
			};
			const s = {
				label: {
					display: "block",
					marginBottom: 4,
					fontSize: 12,
					color: "var(--dsw-alias-label-secondary, #888)"
				},
				input: {
					width: "100%",
					boxSizing: "border-box",
					padding: "6px 8px",
					borderRadius: 8,
					border: "1px solid var(--dsw-alias-border-l1, #ccc)",
					background: "transparent",
					color: "inherit"
				},
				row: { marginBottom: 12 },
				textarea: {
					width: "100%",
					boxSizing: "border-box",
					padding: "8px",
					borderRadius: 8,
					border: "1px solid var(--dsw-alias-border-l1, #ccc)",
					background: "transparent",
					color: "inherit",
					fontFamily: "monospace",
					fontSize: 12,
					minHeight: 180
				},
				btn: {
					padding: "6px 14px",
					borderRadius: 8,
					border: "1px solid var(--dsw-alias-border-l1, #ccc)",
					background: "transparent",
					color: "inherit",
					cursor: "pointer"
				},
				title: {
					fontSize: 14,
					fontWeight: 600,
					marginBottom: 12
				},
				hint: {
					fontSize: 11,
					color: "var(--dsw-alias-label-tertiary, #999)",
					marginTop: 4,
					lineHeight: 1.5
				},
				report: {
					width: "100%",
					boxSizing: "border-box",
					padding: 10,
					borderRadius: 8,
					border: "1px solid var(--dsw-alias-border-l1, #ccc)",
					background: "transparent",
					color: "inherit",
					fontFamily: "monospace",
					fontSize: 12,
					whiteSpace: "pre-wrap",
					maxHeight: 320,
					overflow: "auto",
					marginTop: 12
				}
			};
			if (!cfg) return react.createElement("div", { style: { padding: 16 } }, msg || "加载中…");
			const field = (label, key, placeholder) => react.createElement("div", {
				style: s.row,
				key
			}, react.createElement("label", { style: s.label }, label), react.createElement("input", {
				style: s.input,
				value: cfg[key] || "",
				placeholder,
				onChange: (e) => setCfg({
					...cfg,
					[key]: e.target.value
				})
			}));
			return react.createElement("div", { style: {
				padding: 16,
				maxWidth: 560
			} }, react.createElement("div", { style: s.title }, "投稿状态检查 · 定时任务"), field("触发时间（HH:mm）", "time", "08:00"), field("时区（IANA）", "timezone", "Asia/Shanghai"), react.createElement("div", { style: s.row }, react.createElement("label", { style: {
				...s.label,
				display: "flex",
				alignItems: "center",
				gap: 8
			} }, react.createElement("input", {
				type: "checkbox",
				checked: !!cfg.scheduleEnabled,
				onChange: (e) => setCfg({
					...cfg,
					scheduleEnabled: e.target.checked
				})
			}), "启用每天定时检查")), field("Server酱 SendKey（微信推送，可留空）", "serverchanKey", "SCT..."), react.createElement("div", { style: s.row }, react.createElement("label", { style: s.label }, "汇报目标会话（定时检查完成后在对话内汇报）"), react.createElement("div", { style: {
				display: "flex",
				gap: 8
			} }, react.createElement("select", {
				style: {
					...s.input,
					flex: 1
				},
				value: cfg.reportSessionId || "",
				onChange: (e) => setCfg({
					...cfg,
					reportSessionId: e.target.value
				})
			}, react.createElement("option", { value: "" }, "（不汇报到对话，仅微信）"), ...sessions.map((sess) => react.createElement("option", {
				key: sess.sessionId,
				value: sess.sessionId
			}, sess.title + (sess.cwd ? " · " + sess.cwd : "")))), react.createElement("button", {
				style: s.btn,
				type: "button",
				onClick: loadSessions
			}, "刷新")), react.createElement("div", { style: s.hint }, "只列出当前已打开的会话；若目标会话未打开，定时汇报会跳过对话（微信照常推送）。")), react.createElement("div", { style: {
				...s.row,
				border: "1px dashed var(--dsw-alias-border-l1, #ccc)",
				borderRadius: 8,
				padding: 10
			} }, react.createElement("label", { style: s.label }, "➕ 新增期刊（输入网址 + 账号密码，自动登录并识别）"), react.createElement("div", { style: {
				display: "flex",
				gap: 6,
				marginBottom: 6
			} }, react.createElement("select", {
				style: {
					...s.input,
					flex: 1
				},
				value: cfg.discoverProvider || "",
				onChange: (e) => setCfg({
					...cfg,
					discoverProvider: e.target.value,
					discoverModel: ""
				})
			}, react.createElement("option", { value: "" }, "模型 Provider（默认）"), ...modelGroups.map((g) => react.createElement("option", {
				key: g.id,
				value: g.id
			}, g.name || g.id))), react.createElement("select", {
				style: {
					...s.input,
					flex: 1
				},
				value: cfg.discoverModel || "",
				onChange: (e) => setCfg({
					...cfg,
					discoverModel: e.target.value
				})
			}, react.createElement("option", { value: "" }, "模型（默认）"), ...(modelGroups.find((g) => g.id === cfg.discoverProvider)?.models || []).map((m) => react.createElement("option", {
				key: m.id,
				value: m.id
			}, m.name || m.id))), react.createElement("button", {
				style: s.btn,
				type: "button",
				onClick: loadProviders,
				title: "刷新模型列表"
			}, "刷新")), react.createElement("input", {
				style: {
					...s.input,
					marginBottom: 6
				},
				placeholder: "站点网址，如 https://www.editorialmanager.com/conbuildmat",
				value: dUrl,
				onChange: (e) => setDUrl(e.target.value)
			}), react.createElement("div", { style: {
				display: "flex",
				gap: 6,
				marginBottom: 6
			} }, react.createElement("input", {
				style: {
					...s.input,
					flex: 1
				},
				placeholder: "账号",
				value: dUser,
				onChange: (e) => setDUser(e.target.value)
			}), react.createElement("input", {
				style: {
					...s.input,
					flex: 1
				},
				placeholder: "密码",
				type: "password",
				value: dPass,
				onChange: (e) => setDPass(e.target.value)
			})), react.createElement("div", { style: {
				display: "flex",
				gap: 8,
				alignItems: "center",
				flexWrap: "wrap"
			} }, react.createElement("button", {
				style: s.btn,
				type: "button",
				onClick: discover,
				disabled: discovering
			}, discovering ? "登录识别中…" : "自动识别"), discoverMsg ? react.createElement("span", { style: {
				fontSize: 11,
				color: "var(--dsw-alias-label-tertiary, #999)"
			} }, discoverMsg) : null), discovered ? react.createElement("div", { style: {
				marginTop: 8,
				padding: 8,
				borderRadius: 6,
				border: "1px solid var(--dsw-alias-border-l1, #ccc)",
				fontSize: 12
			} }, react.createElement("label", { style: {
				...s.label,
				marginBottom: 2
			} }, "期刊名（可修改，自动识别可能不准）"), react.createElement("input", {
				style: {
					...s.input,
					marginBottom: 6
				},
				value: discoveredName,
				onChange: (e) => setDiscoveredName(e.target.value)
			}), react.createElement("div", null, "分区（" + (Array.isArray(discovered.sections) ? discovered.sections.length : 0) + " 个）：" + (Array.isArray(discovered.sections) ? discovered.sections.slice(0, 8).join("、") + (discovered.sections.length > 8 ? " 等" : "") : "")), react.createElement("div", { style: { marginTop: 6 } }, react.createElement("button", {
				style: s.btn,
				type: "button",
				onClick: addDiscovered
			}, "加入列表"))) : null, react.createElement("div", { style: s.hint }, "自动打开期刊网站登录，探测主菜单上的全部投稿分区（含当前 0 篇的分区）并识别期刊名，生成后加入下方期刊列表；保存后每次检查会按探测结果自动抓取各分区（出现新稿件即被抓到），无需手动维护分区。")), react.createElement("div", { style: s.row }, react.createElement("label", { style: s.label }, "期刊列表（JSON 数组）"), react.createElement("textarea", {
				style: s.textarea,
				value: journalsText,
				onChange: (e) => setJournalsText(e.target.value),
				spellCheck: false
			}), react.createElement("div", { style: s.hint }, "每项字段：name 期刊名、baseUrl 站点根地址、username/password 登录凭据、sections 要检查的分区名数组、system 为 editorial-manager（确定性）或 other（AI 回退）。")), react.createElement("div", { style: {
				display: "flex",
				alignItems: "center",
				gap: 12
			} }, react.createElement("button", {
				style: s.btn,
				onClick: save,
				disabled: saving
			}, saving ? "保存中…" : "保存"), react.createElement("button", {
				style: s.btn,
				onClick: runNow,
				disabled: running
			}, running ? "检查中…" : "立即检查"), msg ? react.createElement("span", { style: {
				fontSize: 12,
				color: "var(--dsw-alias-label-tertiary, #999)"
			} }, msg) : null), report ? react.createElement("pre", { style: s.report }, report) : null);
		}
		function apply(ctx) {
			const api = ctx.get("connection")?.api;
			ctx.effect(() => ctx.slots.inject("settings.section", () => ctx.slots.register({
				name: "settings.section",
				id: "paper-checker",
				order: 50,
				label: () => "投稿检查"
			}, (props) => react.createElement(PaperCheckerPanel, {
				...props,
				api
			}))), "paper-checker: settings section");
		}
		//#endregion
		exports.apply = apply;
		exports.inject = inject;
		return module.exports;
	}
});

//# sourceMappingURL=client.js.map