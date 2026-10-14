# FXDesk 验收记录（ACCEPTANCE.md）

> 对应 PRD：《后期特效合成工作台》PRD v1.0 — Agent 施工版
> 验收日期：2026-10-14（本机时区 UTC+8）
> 验收环境：Windows 10/11 x64，Node.js v24.11.1，npm 11.6.2，Chrome Headless（Playwright）
> 结论：**单元测试 38/38、端到端脚本验收 20/20、浏览器 UI 验收 14/14，全部通过。**

---

## 1. 如何复现验收

```bash
npm run setup        # 安装依赖 + 初始化 workspace/db + config + 下载 QC 模型(可选) + 演示素材(可选)
npm run dev          # 后端 http://127.0.0.1:3210 + 前端 http://localhost:5173

npm run test         # §12.2 单元测试（vitest，38 用例）
node scripts/acceptance.mjs   # §12.1 端到端验收（离线模拟模式跑通完整管线）
```

浏览器 UI 验收脚本（Playwright）本次在临时目录运行；关键截图见 `验收截图/`，明细见 `ui-acceptance-results.json`。

验收证据文件：

| 文件 | 内容 |
|---|---|
| `acceptance-results.json` | 端到端脚本 20 项检查的机器可读结果与证据描述 |
| `ui-acceptance-results.json` | 浏览器 UI 14 项检查结果 + 控制台错误清单（空） |
| `验收截图/` | 13 张关键步骤截图（建单/素材/框选/拼装/任务栏/审核/交付/素材库/设置） |

---

## 2. §12.2 单元测试（vitest）— 38/38 通过

| 文件 | 用例数 | 覆盖点（对应 PRD） |
|---|---|---|
| `server/test/prompt.test.ts` | 5 | 提示词拼装器：2 区域+全局全文快照断言（含方位描述、参考图编号）（§4.4.4） |
| `server/test/location.test.ts` | 13 | 方位描述算法：九宫格 9 用例 + 边界（0.33/0.66）+ 面积 3 档（附录 B.3） |
| `server/test/markers.test.ts` | 7 | 标记渲染器：1000² / 4000×3000 线宽与徽章规格、越界徽章移入、超限缩图 bbox 等比换算（§4.5/附录 B） |
| `server/test/qc.test.ts` | 8 | QC 阈值三档分流（pass/mid/fail，含中分自动面部重修触发）、mock 特征向量余弦相似度（§4.7.1） |
| `server/test/renumber.test.ts` | 3 | 素材删除/重排后参考图重编号与指令文本同步改写，含“参考图10 ≠ 参考图1”边界（§4.4.3） |
| `server/test/archive.test.ts` | 2 | 交付后 03_delivery / 历史成果 / recipe.json / 标签（客单名+名词+主色）DB 与文件系统断言；净版提取 candidate 黑底入库（§4.10.3/§4.10.6） |

---

## 3. §12.1 端到端验收 — 20/20 通过（`scripts/acceptance.mjs`）

> 说明：本机无可用真实墨墨 API Key，端到端在**离线模拟模式**（设置项 `mockApi`，经设置页/接口开启）
> 下跑通完整管线：模拟模式仅替换「调用墨墨 API 返回图像」这一步（返回未标记原图），
> 标记渲染、队列/SSE、QC（身份模型真实运行）、归档、净版、重修、重试、失败路径**全部真实执行**。
> 真实 Key 的对应条目见 §4「需真实 Key 的验收」。

| PRD 验收项 | 脚本检查 | 结果与证据 |
|---|---|---|
| 1 启动/设置/连接/余额 | 1.1 设置读写+模拟开关；1.2 测试连接（GET /v1/models）；1.3 余额（usage/token 代理） | 通过；连接测试返回模型列表 3 个 |
| 2 新建客单+两类素材 | 2.1 multipart 建单（ID=20261014-01，1200×1600）；2.2 客户素材→参考图1；2.3 库素材（引用）→参考图2 | 通过 |
| 3 标注/指令/全局 | 3.1 2 区域+全局→服务端拼装预览（红①/黄②、方位描述、收尾块）；3.2 空指令拦截 | 通过；错误码 `EMPTY_INSTRUCTION` |
| 4 生成/队列/SSE/费用 | 4.1 入队→生成→质检→待审核（Run done、费用 ¥0.30、耗时记录）；4.2 SSE snapshot/job_update×16（阶段 queued→uploading→generating→downloading→qc→review）/run_progress | 通过 |
| 5 结果与 QC/无标记残留 | 5.1 结果与标记图（01_markers）留档可访问；构图 QC `ok`（SSIM 1、pHash 0 → 无彩色框残留的量化证据）；身份 QC 真实模型运行 → 分流 `skipped(no_face)`（演示图无可检测人脸，属正确降级） | 通过 |
| 6 交付 | 6.1 `delivered` + `03_delivery/final_v1.png` 存在 | 通过 |
| 7 归档/搜索/⭐ | 7.1 历史成果自动标签含「剑、闪电、…紫色」；搜索「闪电」命中；⭐ 生效 | 通过 |
| 8 提取净版 | 8.1 candidate→黑底→⭐ 后 `active` 进收藏夹 | 通过 |
| 9 复用配方 | 9.1 新 draft 携带区域/指令/素材引用（库引用保持关联）；换图接口可用 | 通过 |
| 10 重修回路 | 10.1 定点重修 → 新 Run(type=repair) + QC 重新执行 | 通过 |
| 11 中断恢复 | 11.1 模拟生成中杀进程重启 → 队列显示 `interrupted` 可重试 → 重试成功 | 通过 |
| 12 失败路径 | 12.1 错 Key（本地 401 假服务器）→ 失败红标「API Key 无效或过期」→ 修 Key 后重试成功 | 通过 |
| 13（附加）软删除 | 13.1 删除客单 → 索引移除 + 文件进 `trash/` | 通过 |

---

## 4. 浏览器 UI 验收 — 14/14 通过（Playwright + 截图）

覆盖：首页/顶栏余额 → 新建客单上传原图 → 客户素材上传 → 素材库选择器 → Konva 框选（红①/黄②自动进总览）→ 指令+参考图气泡+全局+最终提示词预览 → 开始生成（任务栏 排队/生成/质检）→ 待审核 → 审核页（对比视图、QC 横幅、Run 历史条、滑块对比）→ 定点重修画框 → 通过交付（归档 toast）→ 素材库查询/提取净版 → 设置页（分组表单/模板编辑/测试连接）→ 控制台零 error。

关键截图：`验收截图/05-prompt.png`（编辑器三栏+提示词总览）、`08-review.png`（审核对比+QC 横幅）、`09-delivered.png`、`11-library-search.png`（历史成果+颜色点+净版卡片）、`13-settings.png`。

## 5. 需真实 Key 的验收（本次未执行，工具已就绪）

以下条目必须在配置真实墨墨 API Key（设置页 → 测试连接确认）后人工执行一次：

1. **真实连接与余额**：设置页 [测试连接] 通过并显示真实余额（本机已用模拟返回验证通路；接口实现见 §7.2/§7.3）。
2. **真实 4K 生成**：真实调用 `:generateContent` 生成 4K 成品，确认耗时（约 1~3 分钟）、元素呈现与背景更换（PRD §12.1.4/5 的素材级确认）。
3. **真实标记移除**：确认成品图中无彩色框/编号残留（存档的构图 QC 会给出量化结果辅助判断）。
4. **真实身份 QC 与面部重修**：使用含真实人脸的场照，验证相似度分流与中分自动面部重修（QC 模型已下载，管线真实运行）。
5. **备用接口兜底（P1）**：仅当主接口返回「接口不支持」时自动切换 `images/edits?async=true`，需真实 Key 触发验证。

## 6. 施工裁决记录（PRD 未覆盖/存在冲突处，按 §0.5 优先级裁定）

1. **全局块文案**：§4.4.4 伪代码写作 `【全局】`，附录 A.3 模板为 `【全局修改】{{globalInstruction}}`。裁定采用附录 A.3（§4.4.2 明确“全局块模板见附录 A.3”），并作为可在设置中编辑的模板。
2. **面部重修 Run 归属**：§4.7.4 表述“同 Run 标记 faceRepair”；但 DDL `runs.type` 含 `faceRepair` 且 §12.1 要求 Run 历史条展示 faceRepair 条目。裁定：登记为**新的 faceRepair Run**（`base_run_id` 指向原 Run），原 Run 的 `qc.faceRepair` 记录触发与结果。
3. **费用计入时机**：runs.cost 在“成功取回图像”后计入（401/网络失败不记账），更符合实际消耗；界面同步显示本 Run/累计/今日/本月。
4. **pHash 实现**：附录 C.2 提及 `imghash`；为避免第三方包 API 不确定性，采用同算法（32×32 灰度 → DCT-II → 左上 16×16 中值二值化 → 256bit）的内置实现，测试覆盖汉明距离判定。
5. **§6.1 端点表外的补充端点**（PRD 功能所需，均为最小增量）：
   - `POST /api/jobs/:id/original`（§4.10.5“换图后生成”）
   - `PATCH /api/jobs/:id/materials/:mid`（§4.2.3 双击改名）
   - `GET /api/jobs/:id/prompt-preview`（§4.4.5 总览预览一致性）
   - `POST /api/library/items`（§12.1.2“预先手动入库”）
   - `POST /api/runs/:id/elements`、`POST /api/runs/:id/review`（§4.7.3 元素勾选入档、§4.9.2 备注）
   - `POST /api/trash/empty`（§4.1.4 回收站手动清空）
6. **离线模拟模式**：新增设置项 `mockApi`（默认关），仅用于演示/离线验收；开启时 UI 顶栏显示「模拟模式」角标。交付默认关闭。
7. **QC 模型下载源**：InsightFace 官方 HF 仓库现返回 401（需授权），`setup-models` 回退 GitHub Releases `buffalo_l.zip` 解压取 `det_10g.onnx`/`w600k_r50.onnx`；下载失败不阻断，QC 自动降级人工目检（§C.1 条款）。
8. **原图规范化**：导入时另存 EXIF 旋转矫正后的 `input/original.png`（原始文件保留为 `original_original.<ext>`），保证画布显示、bbox 坐标与标记渲染三者在同一坐标系。
9. **删除兜底**：Windows 偶发文件占用导致 rename EPERM，删除客单时自动回退为“复制到 trash 后删除源目录”。

## 7. 已知限制

- 演示场照（Sharp 绘制的示意人像）不含真实人脸：身份 QC 正确输出 `skipped(no_face)` 转人工；真实人脸阈值表现需按 §5.4 复核。
- Windows toast 通知依赖 node-notifier（SnoreToast）；静默环境如拦截 toast，不影响任务状态与音效开关逻辑。
- `npm run dev` 为验收标准入口；生产模式可 `npm run build` 后由后端静态托管（http://127.0.0.1:3210）。
