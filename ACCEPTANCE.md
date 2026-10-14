# FXDesk 验收记录（ACCEPTANCE.md）

> 对应 PRD：《后期特效合成工作台》PRD v1.0 — Agent 施工版
> 全流程模拟验收记录：2026-10-14 15:28～15:30（本机时区 UTC+8）；生成与文件定位增量复核：2026-10-14
> 验收环境：Windows 10/11 x64，Node.js v24.11.1，npm 11.6.2，Playwright 1.64（Chromium Headless）
> 最新结论：**自动测试 54/54、前后端类型检查、生产构建与生成状态/文件定位专项界面检查通过。** 下文端到端 20/20、全流程 UI 14/14 为 15:28～15:30 的模拟验收记录；界面改版后本次未重复运行会修改工作区的完整流程脚本。

---

## 1. 如何复现验收

```bash
npm run setup                  # 依赖 + workspace/db/config 初始化 + QC 模型(可选) + 演示素材(可选)
npm test                       # vitest，54 用例

node scripts/acceptance.mjs    # §12.1 端到端验收（模拟模式跑通完整管线；脚本自带起服，要求 3210 空闲）

npm run dev                    # 后端 http://127.0.0.1:3210 + 前端 http://localhost:5173
node scripts/ui-acceptance.mjs # §12.1 浏览器 UI 验收（需 dev 运行中；首次需 npx playwright install chromium）
node scripts/check-generation-ui.mjs # 生成与文件定位只读专项检查（需已有生成结果，默认客单 20261014-01）
```

要点：
- `acceptance.mjs` **自带启动后端**、跑完自动关闭；运行前确保没有其它进程占用 3210（脚本会预检并给出明确报错）。其中的"中断恢复"用例需要真正杀进程重启，脚本在 Windows 下用 `taskkill /T` 终止整棵进程树并等待端口释放。
- `ui-acceptance.mjs` 需要 `npm run dev` 已在运行，会在 Chromium 中完整走一遍 建单 → 素材 → 框选 → 拼装 → 生成 → 审核 → 交付 → 素材库 → 设置 流程，产物为 `验收截图/`（13 张）与 `ui-acceptance-results.json`。
- 两个脚本均在 `finally` 阶段把设置恢复为出厂配置（关闭模拟、清空 Key、通知恢复默认开），不污染下次验收。

验收证据文件：

| 文件 | 内容 |
|---|---|
| `acceptance-results.json` | 端到端脚本 20 项检查的机器可读结果与证据描述 |
| `ui-acceptance-results.json` | 浏览器 UI 14 项检查结果 + 控制台错误清单（空） |
| `验收截图/` | 13 张关键步骤截图（建单/素材/框选/拼装/任务栏/审核/交付/素材库/设置） |

### 1.1 本次实机复核修复记录（2026-10-14）

1. `scripts/acceptance.mjs`：新增 3210 端口占用预检（防止验收静默打到旧服务上）；Windows 下用 `taskkill /T /F` 终止整棵进程树并等待端口释放（修复 11.1 中断恢复用例在此前残留 dev 进程时的误判）；收尾同时恢复通知设置。
2. `scripts/ui-acceptance.mjs`：从临时目录整理入库（新增 `npm run ui-acceptance`）；每次运行使用唯一客单名（`UI验收-<随机>`)避免重复验收时历史成果重名导致选择器歧义。
3. 模拟模式生成增加约 2.2s 模拟耗时（环境变量 `FXDESK_MOCK_LATENCY_MS` 可调，0 关闭），任务栏"排队→生成→质检"阶段可稳定观察，UI 验收不再有时序竞态，模拟体验更接近真实接口。
4. `scripts/setup.mjs` 消除 Node.js DEP0190 警告；`setup-models.mjs` 失败时清理解压临时目录。
5. 补全 §4.3.8（P1）：区域数 > 5 时提示"区域较多可能降低指令准确率，建议拆分两次生成"。
6. 清理 `workspace/models` 约 600MB 历史残留（buffalo_l.zip 与 _unzip_tmp），仅保留 `det_10g.onnx` / `w600k_r50.onnx`。

---

## 2. 自动测试（vitest）— 54/54 通过

| 文件 | 用例数 | 覆盖点（对应 PRD） |
|---|---|---|
| `server/test/prompt.test.ts` | 5 | 提示词拼装器：2 区域+全局全文快照断言（含方位描述、参考图编号）（§4.4.4） |
| `server/test/location.test.ts` | 13 | 方位描述算法：九宫格 9 用例 + 边界（0.33/0.66）+ 面积 3 档（附录 B.3） |
| `server/test/markers.test.ts` | 7 | 标记渲染器：1000² / 4000×3000 线宽与徽章规格、越界徽章移入、超限缩图 bbox 等比换算（§4.5/附录 B） |
| `server/test/qc.test.ts` | 8 | QC 阈值三档分流（pass/mid/fail，含中分自动面部重修触发）、mock 特征向量余弦相似度（§4.7.1） |
| `server/test/renumber.test.ts` | 3 | 素材删除/重排后参考图重编号与指令文本同步改写，含"参考图10 ≠ 参考图1"边界（§4.4.3） |
| `server/test/archive.test.ts` | 2 | 交付后 03_delivery / 历史成果 / recipe.json / 标签（客单名+名词+主色）DB 与文件系统断言；净版提取 candidate 黑底入库（§4.10.3/§4.10.6） |
| `server/test/generation-network.test.ts` | 10 | 慢响应、连接中断、5xx、无效 JSON、响应头/正文超时、429 重试与预算、取消等待；仅访问本地假服务 |
| `server/test/queue-concurrency.test.ts` | 1 | 四笔同时生成、第五笔排队；已取消的排队任务不调用生成服务 |
| `server/test/result-location.test.ts` | 5 | 中文与空格路径、缺失文件与越界拒绝、资源管理器独立参数、接口与来源检查 |

---

## 3. §12.1 端到端验收 — 20/20 通过（`scripts/acceptance.mjs`）

> 说明：本机无可用真实墨墨 API Key，端到端在**离线模拟模式**（设置项 `mockApi`，经设置页/接口开启）
> 下跑通完整管线：模拟模式仅替换「调用墨墨 API 返回图像」这一步（返回未标记原图，含约 2.2s 模拟耗时），
> 标记渲染、队列/SSE、QC（身份模型真实运行）、归档、净版、重修、重试、失败路径**全部真实执行**。
> 真实 Key 的对应条目见 §5。

| PRD 验收项 | 脚本检查 | 结果与证据 |
|---|---|---|
| 1 启动/设置/连接/余额 | 1.1 设置读写+模拟开关；1.2 测试连接（GET /v1/models）；1.3 余额（usage/token 代理） | 通过；连接测试返回模型列表 3 个 |
| 2 新建客单+两类素材 | 2.1 multipart 建单（ID 格式 日期-序号，1200×1600）；2.2 客户素材→参考图1；2.3 库素材（引用）→参考图2 | 通过 |
| 3 标注/指令/全局 | 3.1 2 区域+全局→服务端拼装预览（红①/黄②、方位描述、收尾块）；3.2 空指令拦截 | 通过；错误码 `EMPTY_INSTRUCTION` |
| 4 生成/队列/SSE/费用 | 4.1 入队→生成→质检→待审核（Run done、费用 ¥0.30、耗时记录约 3.6s）；4.2 SSE snapshot/job_update×16（阶段 queued→uploading→generating→downloading→qc→review）/run_progress | 通过 |
| 5 结果与 QC/无标记残留 | 5.1 结果与标记图（01_markers）留档可访问；构图 QC `ok`（SSIM 1、pHash 0 → 无彩色框残留的量化证据）；身份 QC 真实模型运行 → 分流 `skipped(no_face)`（演示图无可检测人脸，属正确降级） | 通过 |
| 6 交付 | 6.1 `delivered` + `03_delivery/final_v1.png` 存在 | 通过 |
| 7 归档/搜索/⭐ | 7.1 历史成果自动标签含「剑、闪电、…紫色」；搜索「闪电」命中；⭐ 生效 | 通过 |
| 8 提取净版 | 8.1 candidate→黑底→⭐ 后 `active` 进收藏夹 | 通过 |
| 9 复用配方 | 9.1 新 draft 携带区域/指令/素材引用（库引用保持关联）；换图接口可用 | 通过 |
| 10 重修回路 | 10.1 定点重修 → 新 Run(type=repair) + QC 重新执行 | 通过 |
| 11 中断恢复 | 11.1 模拟生成中杀进程重启 → 队列显示 `interrupted` 可重试 → 重试成功 | 通过 |
| 12 失败路径 | 12.1 错 Key（本地 401 假服务器）→ 失败红标「API Key 无效或过期」→ 修 Key 后重试成功 | 通过 |
| 13（附加）软删除 | 13.1 删除客单 → 索引移除 + 文件进 `trash/` | 通过 |
| Z（附加）环境还原 | Z 恢复设置（关模拟 / 清 Key / 还原 Base URL / 通知恢复默认开） | 通过 |

---

## 4. 浏览器 UI 验收 — 14/14 通过（`scripts/ui-acceptance.mjs` + Playwright）

覆盖：首页/顶栏余额 → 新建客单上传原图 → 客户素材上传 → 素材库选择器 → Konva 框选（红①/黄②自动进总览）→ 指令+参考图气泡+全局+最终提示词预览 → 开始生成（任务栏 排队/生成/质检）→ 待审核 → 审核页（对比视图、QC 横幅、Run 历史条、滑块对比）→ 定点重修画框 → 通过交付（归档 toast）→ 素材库查询/提取净版 → 设置页（分组表单/模板编辑/测试连接）→ 控制台零 error。

关键截图：`验收截图/05-prompt.png`（编辑器三栏+提示词总览）、`08-review.png`（审核对比+QC 横幅）、`10-delivered.png`、`11-library-search.png`（历史成果+颜色点+净版卡片）、`13-settings.png`。

---

## 5. 需真实 Key 的验收（本次未执行，工具已就绪）

以下条目必须在配置真实墨墨 API Key（设置页 → 测试连接确认）后人工执行一次：

1. **真实连接与余额**：设置页 [测试连接] 通过并显示真实余额（本机已用模拟返回验证通路；接口实现见 §7.2/§7.3）。
2. **真实 4K 生成**：真实调用 `:generateContent` 生成 4K 成品，确认耗时（约 1~3 分钟）、元素呈现与背景更换（PRD §12.1.4/5 的素材级确认）。
3. **真实标记移除**：确认成品图中无彩色框/编号残留（存档的构图 QC 会给出量化结果辅助判断）。
4. **真实身份 QC 与面部重修**：使用含真实人脸的场照，验证相似度分流与中分自动面部重修（QC 模型已下载，管线真实运行）。
5. **备用接口兜底（P1）**：仅当主接口返回「接口不支持」时自动切换 `images/edits?async=true`，需真实 Key 触发验证。

## 6. 施工裁决记录（PRD 未覆盖/存在冲突处，按 §0.5 优先级裁定）

1. **全局块文案**：§4.4.4 伪代码写作 `【全局】`，附录 A.3 模板为 `【全局修改】{{globalInstruction}}`。裁定采用附录 A.3（§4.4.2 明确"全局块模板见附录 A.3"），并作为可在设置中编辑的模板。
2. **面部重修 Run 归属**：§4.7.4 表述"同 Run 标记 faceRepair"；但 DDL `runs.type` 含 `faceRepair` 且 §12.1 要求 Run 历史条展示 faceRepair 条目。裁定：登记为**新的 faceRepair Run**（`base_run_id` 指向原 Run），原 Run 的 `qc.faceRepair` 记录触发与结果。
3. **费用计入时机**：runs.cost 在"成功取回图像"后计入（401/网络失败不记账），更符合实际消耗；界面同步显示本 Run/累计/今日/本月。
4. **pHash 实现**：附录 C.2 提及 `imghash`；为避免第三方包 API 不确定性，采用同算法（32×32 灰度 → DCT-II → 左上 16×16 中值二值化 → 256bit）的内置实现，测试覆盖汉明距离判定。
5. **§6.1 端点表外的补充端点**（PRD 功能所需，均为最小增量）：
   - `POST /api/jobs/:id/original`（§4.10.5"换图后生成"）
   - `PATCH /api/jobs/:id/materials/:mid`（§4.2.3 双击改名）
   - `GET /api/jobs/:id/prompt-preview`（§4.4.5 总览预览一致性）
   - `POST /api/library/items`（§12.1.2"预先手动入库"）
   - `POST /api/runs/:id/elements`、`POST /api/runs/:id/review`（§4.7.3 元素勾选入档、§4.9.2 备注）
   - `POST /api/trash/empty`（§4.1.4 回收站手动清空）
6. **离线模拟模式**：新增设置项 `mockApi`（默认关），仅用于演示/离线验收；开启时 UI 顶栏显示「模拟模式」角标，模拟生成含约 2.2s 模拟耗时（`FXDESK_MOCK_LATENCY_MS` 可调）。交付默认关闭。
7. **QC 模型下载源**：InsightFace 官方 HF 仓库现返回 401（需授权），`setup-models` 回退 GitHub Releases `buffalo_l.zip` 解压取 `det_10g.onnx`/`w600k_r50.onnx`；下载失败不阻断，QC 自动降级人工目检（§C.1 条款）。
8. **原图规范化**：导入时另存 EXIF 旋转矫正后的 `input/original.png`（原始文件保留为 `original_original.<ext>`），保证画布显示、bbox 坐标与标记渲染三者在同一坐标系。
9. **删除兜底**：Windows 偶发文件占用导致 rename EPERM，删除客单时自动回退为"复制到 trash 后删除源目录"。
10. **验收脚本进程管理**：端到端脚本自带起服/杀服，Windows 下必须终止整棵进程树（tsx 会派生子 node 进程）并等待端口释放，否则"中断恢复"用例会误打到旧服务；脚本先做端口预检，占用时直接报错退出。
11. **UI 验收脚本入库**：Playwright 作为根 devDependency（浏览器需 `npx playwright install chromium` 一次）；脚本每次用唯一客单名，保证工作区有历史数据时重复验收仍可靠。
12. **§4.3.8 区域数提示（P1）补全**：区域 > 5 时在提示词总览显示黄色提示，不阻断生成。

## 7. 已知限制

- 演示场照（Sharp 绘制的示意人像）不含真实人脸：身份 QC 正确输出 `skipped(no_face)` 转人工；真实人脸阈值表现需按 §5.4 复核。
- Windows toast 通知依赖 node-notifier（SnoreToast）；静默环境如拦截 toast，不影响任务状态与音效开关逻辑。
- `npm run dev` 为验收标准入口；生产模式可 `npm run build` 后由后端静态托管（http://127.0.0.1:3210）。

## 8. 生成与文件定位增量复核

`npm test` 的 54 项检查、前后端 `tsc --noEmit` 与 `npm run build` 已通过。

`node scripts/check-generation-ui.mjs` 在 5173 开发页面和 3210 生产页面分别检查当前 Run 的完整结果路径、定位按钮请求、并发与等待设置、两分钟以上等待提示、限流重试提示、生成期间禁止再次提交及窄屏弹窗；未出现页面运行错误。限流、长时间生成与定位动作在检查浏览器中模拟，没有调用付费生成或改动真实客单。

专项截图：`验收截图/generation-location.png`、`generation-location-mobile.png`、`generation-settings.png`、`generation-slow.png`、`generation-retry.png`。处理策略与远端并发尚未确认的限制见《生成等待与并发处理方案.md》。
