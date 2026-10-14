# 《后期特效合成工作台》产品需求文档（PRD）v1.0 — Agent 施工版

> 代号：FXDesk（可改）
> 文档性质：**实现级 PRD**。施工方（人类开发者或 AI Agent）应能在不追加需求沟通的情况下完成 v1 开发、自测、验收。
> 生成依据：本产品需求来自与产品负责人的逐条确认（见正文引用），并借鉴了「TT AI v1.8.8 Photoshop 插件」逆向分析中的可用设计（见附录 D）。
> 修订记录：v1.0 初稿。

---

## 0. 给施工 Agent 的执行约定（先读这一节）

1. **技术栈锁定，不得更换**（除标注"可替换"处）：
   - 语言：TypeScript（全栈）
   - 运行时：Node.js ≥ 22（Windows 10/11 x64 为第一目标平台）
   - 后端：Fastify + better-sqlite3 + sharp + onnxruntime-node
   - 前端：React 18 + Vite + TypeScript + react-konva（标注画布）
   - 队列：进程内队列（p-queue），任务状态持久化到 SQLite
   - 实时进度：SSE（Server-Sent Events）
   - 通知：node-notifier（Windows toast）+ 本地音效文件
2. **外部依赖只有一家的接口**：墨墨中转站（`https://api.momoapi.icu`），全部参数以 §7 为准，不得自行发明字段。
3. **优先级标记**：`[P0]` 必须完成；`[P1]` 应完成（时间不足可降级但需保留接口）；`[P2]` 明确不做进 backlog（§14）。
4. **验收**：完成后必须跑通 §12 的全部验收项，并在仓库内保留验收记录文件 `ACCEPTANCE.md`。
5. **禁止事项**：不做多用户/云部署；不做移动端；不改动本 PRD 已锁定的提示词模板结构（模板文案允许在设置中编辑，但结构变量占位符不得改动）。

---

## 1. 产品概述

### 1.1 一句话
面向 cos 场照后期工作室的**人机协作特效合成工作台**：客户发来场照与需求 → 操作员在图上框选区域并填写结构化指令（引用客户素材或素材库）→ 系统拼装提示词、渲染标记、一次生成 4K 成品 → 自动质检 → 人工审核交付 → 成果自动归档入素材库。

### 1.2 目标用户
- 主用户：后期操作员（1~3 人小团队），负责接单、标注、审核、交付
- 使用环境：Windows 桌面，本地运行（单机部署，数据不出本机，仅调用墨墨 API）

### 1.3 v1 范围
- 单张场照的**多区域添加元素 + 全局换背景**一次生成
- 4K 直接输出；单张生成（不做变体）；无参考图预处理（见 backlog）
- 自动质检（身份/构图自动，元素人工确认）
- 任务队列、费用记录、失败重试
- 素材库（素材/收藏夹/历史成果三区）、自动归档、复用配方、惰性净版提取
- Session 全量留档与"回去重做"

### 1.4 非目标（v1 不做）
- 视频/动图、批量套图、多人合成（CP 同框）、风格化滤镜线、印刷交付物、客户自助下单、云同步

---

## 2. 术语表

| 术语 | 含义 |
|---|---|
| 客单 / Job / Session | 一次客户订单的完整工作单元（三词同义） |
| Run | 一次生成执行（一个 Job 可含多个 Run：首跑/重跑/重修） |
| 区域 / Region | 标注画布上的一个矩形框，含 bbox 与一条指令 |
| 标记图 / Marker Image | 把区域框与编号渲染到原图副本上、发给模型的输入图 |
| 参考图 / Reference | 随请求发送给模型的图片，按附件顺序编号"参考图1..N" |
| 系统块 / 锁定块 | 自动注入的固定提示词段落（身份/构图/光影锁定等） |
| QC | 自动质检（身份相似度、构图偏移、元素确认） |
| 净版 / Plate | 黑底、无人物的纯特效图（可复用合成素材） |
| 配方 / Recipe | 一次成功 Job 的全套可复现参数（提示词+素材引用+框+模型参数） |

---

## 3. 用户故事与主流程

### 3.1 已确认的核心用户故事（原文）
> 我们拿到用户的客单：一张 cos 场照原图。用户说想在手中加把剑、想更换背景、想身体周围加特效。用户发来了场照、他想加的剑（图）、描述了一个背景、描述了一个特效。
> 我们导入图片，侧边是一个完整的提示词总览。用快捷标注工具框住手部，提示词总览出现对应红框条目，填写"加上 image1 这把剑"。继续框住身体周围，出现黄框条目，填写"加上闪电"（素材库文件）。最后整体改提示词：背景换成……（模型生成，加约束：契合人物）。模型生成并自动处理后返回图片。期间可推入任务栏处理其他图，任务栏显示进度。

### 3.2 完整流程图

```
[新建客单] → [导入原图] → [添加素材: 客户文件 / 素材库] 
    → [框选区域① → 填指令+引用参考图] → [框选区域② → 填指令+引用参考图]
    → [填全局指令: 换背景XX] → [提示词总览自动拼装(只读预览)]
    → [点击"开始生成"] → 入队
        └─ 队列执行: 渲染标记图 → 调墨墨API(4K) → 下载结果
            → 自动质检(身份/构图) → [不达标→直接转人工; 中分→自动面部重修1次]
        → [进入待审核] → 人工审核
            ├─ [通过交付] → 自动归档(recipe+成片+自动打标) → 完成
            ├─ [定点重修] → 画问题区+描述 → 新增 Run → 回到质检
            └─ [重跑] → 以当前配置新增 Run → 回到质检
```

### 3.3 Job 状态机（持久化字段 `jobs.status`）

```
draft → queued → generating → qc → review → repairing ─┐
                    │                  │                │
                    └── failed ←───────┘                │
                                                        └→ (回到 qc)
review → delivered（终态，触发归档）
任意非终态 → canceled（人工取消）
```

状态说明：
- `draft` 编辑中；`queued` 已入队；`generating` 生成中（含上传/请求/下载）；`qc` 质检中；`review` 待人工审核；`repairing` 重修执行中；`failed` 失败（可重试）；`delivered` 已交付；`canceled` 已取消。

---

## 4. 功能需求（详设）

### 4.1 客单管理 [P0]

- 4.1.1 新建客单：首页/工具栏"新建客单"按钮 → 输入客单名（默认：日期+序号，如 `2026-1014-01`）→ 选原图（本地文件，jpg/png/webp，≤50MB）→ 建立 Job 记录与作业目录。
- 4.1.2 客单列表：按状态分组（进行中 / 待审核 / 已交付 / 失败）；卡片显示：名称、缩略图、状态徽章、创建时间、最近一次 Run 耗时与费用。
- 4.1.3 打开客单：恢复全部编辑态（原图、素材、区域、指令、历史 Run）；页面布局见 4.4.1。
- 4.1.4 删除客单：二次确认；默认仅移除索引，文件移入 `workspace/trash/`（软删除），30 天可手动清空。
- 4.1.5 重做/Clone：任意客单（含已交付）可"另存为新客单"（复制输入与配方，用于回头改单或复用）。

### 4.2 素材导入 [P0]

- 4.2.1 素材来源两类：
  - **客户素材**：客户随单发来的文件（如"想加的剑.jpg"）。上传即存 `jobs/<id>/materials/client/`，**不入素材库**。
  - **库素材**：从素材库选择（弹出选择器，支持搜索，见 4.10）。以**引用**方式关联（只存 `library_item_id`，不复制文件）。
- 4.2.2 素材列表 UI：编辑区左侧面板"素材"区，每项显示缩略图 + 自定名 + 来源徽章（客户/库）；支持拖拽排序；排序即"参考图编号顺序"（见 4.4.3）。
- 4.2.3 命名规则：默认取文件名；可双击改名（改名只影响显示与提示词引用，不改物理文件）。
- 4.2.4 限制：单 Job 素材数 ≤ 4（超出时提示"v1 建议不超过 4 张参考"；软限制可配置）。
- 4.2.5 剪贴板：支持粘贴图片直接成为客户素材。
- 4.2.6 不做预处理：v1 不自动抠图/去背/压缩（负责人确认：先裸跑，出问题再加）。仅对 >4096 长边的素材做等比缩小以控制请求体积（配置项 `sendMaxDimension` 默认 4096）。

### 4.3 快捷标注工具 [P0]

- 4.3.1 画布：中央大画布显示原图（可缩放/平移：滚轮缩放 10%~800%，空格拖拽平移）。
- 4.3.2 画框：工具栏"框选"按钮（快捷键 `R`）→ 在图上拖出矩形 → 松开后创建区域。矩形坐标存**原图像素坐标系**（显示缩放只影响交互，不影响存储）。
- 4.3.3 区域列表：右侧"提示词总览"顶部自动出现新条目，格式：
  ```
  [红] ① 区域1  bbox(x1,y1,x2,y2)   [输入指令...]  [引用: 参考图1 ▾]  [🗑]
  ```
- 4.3.4 颜色与编号：按创建顺序自动分配 5 色循环（红 #E53935 → 黄 #FDD835 → 蓝 #1E88E5 → 绿 #43A047 → 紫 #8E24AA），编号 ①②③… 无限累加（编号与颜色独立：超过 5 个后颜色循环但编号继续）。
- 4.3.5 区域操作：拖动移动、拉角缩放、点选高亮、Delete 删除、右键菜单（复制/删除）。框的边框在画布上以对应颜色渲染（与发给模型的标记图**同一套视觉**，见附录 B）。
- 4.3.6 指令编辑：每个区域一条指令输入框（单行 + 可扩展多行）；支持"插入参考图"下拉（列出当前素材自定名，选中后插入一个"气泡 token"`⟦参考图1:剑⟧`，序列化时转换为文本"参考图1"）。
- 4.3.7 空指令检查：指令为空的区域在"开始生成"时高亮报错。
- 4.3.8 数量提示 [P1]：区域数 > 5 时显示黄色提示"区域较多可能降低指令准确率，建议拆分两次"（不阻断）。

### 4.4 提示词总览与拼装引擎 [P0]

- 4.4.1 页面布局（桌面端，左右两栏）：
  ```
  ┌────────────┬──────────────────────────────┬─────────────┐
  │ 素材面板    │         标注画布              │ 提示词总览   │
  │ (素材列表)  │  (原图 + 彩色框)              │ (系统块      │
  │            │                              │  区域块×N    │
  │            │                              │  全局块      │
  │            │                              │  收尾块)     │
  │            │                              │ [开始生成]   │
  └────────────┴──────────────────────────────┴─────────────┘
  ```
- 4.4.2 总览右侧面板包含四段，**除区域指令与全局指令外全部自动生成、只读展示**：
  1. 系统块（锁定区）——模板见附录 A.1，模板文案可在设置中编辑
  2. 区域块 ×N——由区域列表自动合成，模板见附录 A.2
  3. 全局块——一个文本域：`全局指令（背景等）`，模板见附录 A.3；留空则自动省略整段
  4. 收尾块——融合要求与标记移除，模板见附录 A.4，自动生成
- 4.4.3 参考图编号规则（**必须严格遵守，否则模型会串味**）：
  - 编号 = 素材列表中**附件顺序**（第 1 个素材 = 参考图1）
  - 区域指令中的"参考图N"必须与实际附件顺序一致；UI 通过"插入参考图"气泡保证一致性
  - 若素材被删除/重排，所有指令中的引用 token 自动重编号，并向用户提示"参考图编号已更新"
- 4.4.4 拼装算法（伪代码，生成 Run 时执行）：
  ```
  parts = [系统块]
  for r in regions (按编号顺序):
      parts.push(f"【{r.颜色名}框 第{r.编号}区】位置：{r.方位描述}。要求：{r.指令文本}")
  if globalInstruction 非空:
      parts.push(f"【全局】{globalInstruction}")
  parts.push(收尾块)
  finalPrompt = parts.join("\n")
  ```
  - 方位描述自动生成：根据 bbox 中心相对九宫格（左上/上/右上/左/中/右/左下/下/右下）+ 覆盖面积档位（局部/较大/全图）拼出中文描述，如"画面右侧中部，面积较小"。算法见附录 B.3。
- 4.4.5 预览：面板底部"查看最终提示词"可展开只读全文（含实际参考图编号），供操作员复核。
- 4.4.6 提示词留档：每个 Run 的 `finalPrompt` 全文存入 DB 与 `request.json`（见 6.2 recipe）。

### 4.5 标记渲染器 [P0]

- 4.5.1 触发：生成时对原图副本渲染（**改的是发给模型的图，不改原文件**）。
- 4.5.2 渲染规格：见附录 B（颜色/线宽/标签/不透明度按图像尺寸等比）。
- 4.5.3 输出：PNG，命名 `markers_v{run序号}.png`，存 `jobs/<id>/01_markers/`；留档并在审核界面可查看。
- 4.5.4 若原图长边缘 > `sendMaxDimension`（4096）：先等比缩图，bbox 按同比例换算后再渲染（保证框贴合）。

### 4.6 生成管线 [P0]

- 4.6.1 触发"开始生成"条件：原图存在 + 至少 0 个区域（允许纯全局指令）+ 所有区域指令非空 + API Key 已配置。
- 4.6.2 Run 执行步骤（每步进度通过 SSE 推送）：
  1. `uploading`：准备 base64（标记图 + 各参考图按顺序）
  2. `generating`：调用墨墨 API（§7）
  3. `downloading`：解析响应 base64，保存 `result_v{n}.png/jpg`
  4. `qc`：执行质检（§4.7）
  5. 结束：进入 `review` 或由质检决定自动重修
- 4.6.3 模型与参数：模型 ID 来自设置（默认 `[Mo]nano-banana-pro`）；`imageSize` 默认 `4K`（设置可改 1K/2K/4K）；`aspectRatio` 默认不传（跟随输入图）；不传其他未定义字段。
- 4.6.4 单次生成，无变体（负责人决策：控制成本）。
- 4.6.5 超时：单 Run 300 秒；网络错误自动重试 3 次（指数退避 2s/8s/20s）；仍失败 → `failed` + 任务栏红标 + 通知。
- 4.6.6 费用记录：每次 Run 按设置中的"单张价格"（默认 ¥0.30，可改）记入 `runs.cost`，任务栏与客单页显示累计费用与本月合计。
- 4.6.7 请求存档：`request.json` 记录模型、参数、最终提示词、参考图文件清单、标记图路径、时间、耗时、费用（**不含 API Key**）。

### 4.7 自动质检（QC）[P0]

- 4.7.1 身份检测（自动，核心）：
  - 本地人脸检测 + 特征比对（onnxruntime-node，模型文件由 `scripts/setup-models.mjs` 下载，见附录 C）
  - 取原图最大人脸特征 vs 结果图中位置最接近的人脸特征，计算余弦相似度 `sim`
  - 判定：`sim ≥ 0.62` 通过；`0.50 ≤ sim < 0.62` 中分 → **自动触发面部重修**（4.7.4）；`sim < 0.50` 不达标 → 直接转人工（负责人决策：不自动重跑）
  - 未检测到人脸（侧脸/遮挡）：标记 `identity: skipped`，转人工目检
  - 模型文件缺失时：QC 显示"身份检测未启用（模型未安装）"，转人工目检（不阻断流程）
- 4.7.2 构图检测（自动）：
  - 原图与结果图做 SSIM（缩放到 512 长边）+ pHash 汉明距离
  - `SSIM ≥ 0.55 且 pHash距离 ≤ 16`：通过；否则标记 `composition: shifted` 并**在审核界面高亮提示**"构图可能偏移，请目检"（不阻断、不自动重跑）
- 4.7.3 元素确认（v1 人工）：结果图与区域指令并排展示，审核员逐条勾选"剑✓ 闪电✓"（勾选结果入档；为 P2 自动检测留接口 `qc.elements`）
- 4.7.4 面部重修（第二防线，自动 1 次）：
  1. 从结果图中裁出人脸区域（按检测框外扩 2 倍）
  2. 从原图裁出同人脸区域
  3. 调用墨墨 API：输入 = 结果图脸区裁片 + 原图脸区裁片（**参考图1**），指令模板见附录 A.5
  4. 将修复裁片按羽化 30px 的椭圆蒙版合成回结果图 → 存为新的 Run 结果（同 Run 标记 `faceRepair: true`）
  5. 重跑身份检测；仍不达标 → 转人工（第三防线"盖脸"由人工在外部编辑器处理，工具不提供）
- 4.7.5 QC 结果展示：审核界面顶部横幅显示三项分数与结论（通过/中分已修复/转人工）。

### 4.8 任务队列与任务栏 [P0]

- 4.8.1 并发：默认最多 2 个 Job 并行生成（设置可调 1~4）；超出排队（FIFO）。
- 4.8.2 任务栏（页面底部或独立抽屉）卡片显示：
  - 客单名 + 缩略图
  - 状态徽章与阶段进度：`排队中(位置N)` / `生成中·已耗时` / `质检中` / `待审核` / `失败`
  - 费用（本 Run / 累计）
  - 操作：[取消]（排队/生成中可用）、[重试]（失败时）、[打开]
- 4.8.3 进度推送：SSE 事件 `job_update` {jobId, status, stage, elapsed, cost, error?}；断线重连自动补全量状态。
- 4.8.4 通知：
  - 完成（进入 review）：Windows toast "客单 X 已生成待审核" + 本地提示音（可关）
  - 失败：toast + 警告音
- 4.8.5 关闭页面/重启应用：队列状态持久化，重启后未完成 Run 标记为 `failed(interrupted)` 可手动重试。

### 4.9 审核界面 [P0]

- 4.9.1 布局：左右对比（原图 | 结果图，可同步缩放/平移）+ 顶部 QC 横幅 + 右侧操作栏。
- 4.9.2 操作：
  - **[通过交付]**：Job → `delivered`；写 `03_delivery/final_vN.png`；触发归档（4.10.3）
  - **[定点重修]**：在结果图上画问题区（复用标注工具，颜色循环同 4.3.4）→ 每区填修复指令 → 新增 Run 类型 `repair`（输入 = 当前结果图 + 问题区标记图；提示词模板见附录 A.6）
  - **[重跑]**：以当前全部配置新增 Run 类型 `rerun`
  - **[备注]**：自由文本，存 `reviews.note`
- 4.9.3 Run 历史条：底部横向排列该 Job 所有 Run 缩略图（v1/v2/faceRepair/repair…），点击任意一张"设为当前基准"（后续重修/重跑从该基准出发）。
- 4.9.4 对比工具 [P1]：滑动分屏（滑块对比）、像素级 1:1 放大检查。

### 4.10 素材库 [P0]

- 4.10.1 三区结构（顶部 Tab）：
  1. **素材库**：正式资产（净版 plates + 参考 refs），带标签，可搜索
  2. **收藏夹 ⭐**：人工策展的条目
  3. **历史成果**：所有已交付 Job 的自动归档（recipe + 成片），自动打标，可搜索
- 4.10.2 素材条目数据：`{id, type: plate|ref, file, 标签[], 颜色[], 来源, 关联角色?, resolution, background: 黑底|透明, createdAt}`。入库时自动项：主色提取（k-means 3 色）、分辨率、底色检测。
- 4.10.3 自动归档（交付时零操作触发）：
  - 存 recipe（提示词/素材引用/区域/模型参数，从 Job 导出）
  - 存成片到 `library/history/<jobId>/`
  - **自动打标**：标签 = 客单名 + 各区域指令中的名词（"剑/闪电"）+ 全局指令名词 + 主色。若设置中启用了"视觉模型打标"（P2），在此基础上追加视觉标签
  - 完成后 toast 3 秒："已归档（标签：剑、闪电、紫色）"
- 4.10.4 搜索：输入关键词/颜色族 → 结果分两栏：`可用素材`（直接拖入新客单）+ `历史成果`（每条带 [复用配方] [提取净版] [⭐] 按钮）。搜索匹配：标签全字段模糊 + 颜色名（红/橙/黄/绿/青/蓝/紫/黑/白）映射到色值邻近匹配。
- 4.10.5 **复用配方**：点 [复用配方] → 以该历史 Job 为模板创建新 draft Job（复制系统块以外的区域结构、指令、素材引用若仍存在），操作员替换原图后即可生成。
- 4.10.6 **惰性净版提取**：点 [提取净版] → 后台执行：输入 = 该 Job 成片，指令模板见附录 A.7（"移除所有人物与背景，仅保留【特效描述】，纯黑背景"）→ 结果图存 `library/plates/<itemId>.png`，type=plate，status=candidate（进"素材库"Tab 的"待整理"筛选项）→ 操作员 ⭐ 后进入收藏夹并升为正式素材；可编辑标签。
- 4.10.7 收藏 ⭐：任何素材条目与历史成果条目上均有一键 ⭐；收藏是策展的唯一动作（发生在搜索/使用时刻）。
- 4.10.8 删除：素材软删除；被 Job 引用中的素材禁止删除（提示引用处）。

### 4.11 设置 [P0]

| 分组 | 项 | 默认值 | 说明 |
|---|---|---|---|
| API | 墨墨 API Key | （空） | 必填才可生成；本地存储（config 文件，简单混淆 `obf:` 前缀 + base64，非强加密，界面注明） |
| API | Base URL | `https://api.momoapi.icu` | 可改 |
| API | 模型 ID | `[Mo]nano-banana-pro` | 可改（下拉预置：`[Mo]nano-banana-pro`、`[yu]gemini-nano-banana-2.1`、`gpt-image-2.5-sunburst`…） |
| API | 输出尺寸 | `4K` | 1K/2K/4K |
| API | 单张价格 | `0.30` 元 | 仅用于费用统计 |
| API | [测试连接] | — | 调 `GET /v1/models` 验证 Key（借鉴插件的"测试连接"） |
| API | 余额显示 | — | 调 `GET /api/usage/token/`（见 §7.3）显示在顶栏，每 10 分钟刷新、可手动刷新 |
| 队列 | 并发数 | 2 | 1~4 |
| 队列 | 单 Run 超时 | 300 秒 | |
| 通知 | 提示音/系统通知 | 开 | |
| 质检 | 身份通过阈值 | 0.62 | |
| 质检 | 身份中分下限 | 0.50 | |
| 质检 | 自动面部重修 | 开 | |
| 提示词 | 系统块/收尾块/各模板 | 附录 A 全文 | 可视化编辑，占位符 `{{}}` 不可删改 |
| 素材 | 发送长边上限 | 4096 | |
| 存储 | 工作区路径 | `./workspace` | 可改（需重启） |

### 4.12 文件与目录结构 [P0]

```
workspace/
  db.sqlite
  config.json                # 应用设置（含 obf: 混淆的 Key）
  jobs/<jobId>/
    job.json                 # 冗余快照（便于人肉查看）
    input/original.<ext>
    materials/client/01_剑.jpg      # 客户素材（副本）
    01_markers/markers_v1.png       # 每 Run 一份（若区域变化）
    02_runs/run_0001/
      request.json           # 完整请求档案（无 Key）
      result.png             # 原始返回
      result_final.png       # 后处理(如面部重修合成)后的最终版
      qc.json
    03_delivery/final_v2.png
    recipe.json
  library/
    history/<jobId>/         # 归档成片 + recipe 副本
    plates/<itemId>.png
    refs/<itemId>.<ext>
  trash/
  logs/app.log               # 滚动日志（滚动 7 天）
```

---

## 5. 数据模型（SQLite DDL，直接执行）

```sql
PRAGMA journal_mode=WAL;

CREATE TABLE IF NOT EXISTS jobs (
  id TEXT PRIMARY KEY,                -- 如 20261014-01 或 uuid
  name TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'draft',   -- draft|queued|generating|qc|review|repairing|failed|delivered|canceled
  original_path TEXT NOT NULL,
  global_instruction TEXT DEFAULT '',
  character TEXT DEFAULT '',          -- 角色名（选填，用于标签）
  final_run_id TEXT,
  cost_total REAL DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS job_materials (
  id TEXT PRIMARY KEY,
  job_id TEXT NOT NULL REFERENCES jobs(id),
  source TEXT NOT NULL,               -- client|library
  library_item_id TEXT,               -- source=library 时
  display_name TEXT NOT NULL,
  file_path TEXT,                     -- client 时的落盘路径
  order_index INTEGER NOT NULL        -- 01 起，即"参考图N"
);

CREATE TABLE IF NOT EXISTS job_regions (
  id TEXT PRIMARY KEY,
  job_id TEXT NOT NULL REFERENCES jobs(id),
  idx INTEGER NOT NULL,               -- 编号 1..N
  color TEXT NOT NULL,                -- hex
  bbox_json TEXT NOT NULL,            -- {x1,y1,x2,y2} 原图像素
  instruction TEXT NOT NULL,
  ref_tokens TEXT DEFAULT '[]',       -- [{materialId, refNo, name}] 指令中引用的参考图
  is_repair INTEGER DEFAULT 0         -- 重修区域标记
);

CREATE TABLE IF NOT EXISTS runs (
  id TEXT PRIMARY KEY,
  job_id TEXT NOT NULL REFERENCES jobs(id),
  seq INTEGER NOT NULL,               -- 1,2,3...
  type TEXT NOT NULL DEFAULT 'initial', -- initial|rerun|repair|faceRepair
  status TEXT NOT NULL,               -- queued|generating|qc|done|failed|canceled
  base_run_id TEXT,                   -- 重跑/重修基于哪个 Run
  marker_path TEXT,
  final_prompt TEXT,
  request_json TEXT,                  -- request.json 内容
  result_path TEXT,
  result_final_path TEXT,
  qc_json TEXT,
  cost REAL DEFAULT 0,
  elapsed_ms INTEGER,
  error TEXT,
  created_at INTEGER NOT NULL,
  finished_at INTEGER
);

CREATE TABLE IF NOT EXISTS reviews (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES runs(id),
  action TEXT NOT NULL,               -- approve|repair|rerun|note
  note TEXT DEFAULT '',
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS library_items (
  id TEXT PRIMARY KEY,
  type TEXT NOT NULL,                 -- plate|ref|history
  file_path TEXT NOT NULL,
  job_id TEXT,                        -- history 类型关联
  title TEXT NOT NULL DEFAULT '',
  tags_json TEXT DEFAULT '[]',
  colors_json TEXT DEFAULT '[]',
  source TEXT DEFAULT 'internal',     -- ai|client_reflow|manual
  favorite INTEGER DEFAULT 0,
  status TEXT DEFAULT 'active',       -- candidate|active
  width INTEGER, height INTEGER,
  background TEXT,                    -- black|transparent|photo
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT
);

CREATE TABLE IF NOT EXISTS events_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts INTEGER NOT NULL,
  job_id TEXT,
  run_id TEXT,
  level TEXT,                         -- info|warn|error
  message TEXT
);
```

---

## 6. 后端 API 契约（REST + SSE）

统一前缀 `/api`；响应 JSON；错误格式 `{ "error": { "code": "STRING_CODE", "message": "人类可读" } }`。

### 6.1 端点清单

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/jobs` | 列表（?status= 过滤） |
| POST | `/api/jobs` | 新建（multipart：name, original 文件）→ `{id}` |
| GET | `/api/jobs/:id` | 详情（含 materials/regions/runs 摘要） |
| PATCH | `/api/jobs/:id` | 改 name/character/global_instruction |
| POST | `/api/jobs/:id/materials` | 上传客户素材（multipart）或 `{libraryItemId}` 添加库素材 |
| DELETE | `/api/jobs/:id/materials/:mid` | 删除素材（触发参考图重编号并回写区域 token） |
| PUT | `/api/jobs/:id/materials/order` | `{ids:[...]}` 重排（重编号） |
| PUT | `/api/jobs/:id/regions` | 全量覆盖区域列表（含 bbox/instruction/ref_tokens） |
| POST | `/api/jobs/:id/generate` | 入队生成；可选 `{type:'rerun', baseRunId}` |
| POST | `/api/jobs/:id/repair` | 定点重修；`{baseRunId, regions:[...]}` |
| POST | `/api/jobs/:id/deliver` | `{runId}` → delivered + 归档 |
| POST | `/api/jobs/:id/clone` | 复用为新 Job → `{id}` |
| GET | `/api/queue` | 队列与运行中任务 |
| POST | `/api/runs/:id/retry` / `/cancel` | 重试 / 取消 |
| GET | `/api/library/items` | `?q=&type=&favorite=&status=` 搜索 |
| POST | `/api/library/items/:id/favorite` | `{favorite: true/false}` |
| PATCH | `/api/library/items/:id` | 改 title/tags |
| POST | `/api/library/extract-plate` | `{jobId}` 惰性净版提取 → `{itemId}` |
| GET | `/api/settings` / PUT | 读写设置（Key 写入时混淆，读取返回 `"obf:***"`，不返回明文） |
| POST | `/api/settings/test-connection` | 测试墨墨连接 |
| GET | `/api/balance` | 代理 `GET {base}/api/usage/token/` → `{balance, remainQuota}` |
| GET | `/api/events` | SSE：`job_update` / `run_progress` / `lib_update` |
| GET | `/api/files/*` | 本地媒体服务（受限于 workspace 内） |

### 6.2 recipe.json 结构（导出/归档用）

```json
{
  "version": 1,
  "job": { "name": "", "character": "" },
  "materials": [ { "refNo": 1, "displayName": "剑", "source": "client", "libraryItemId": null } ],
  "regions": [ { "idx": 1, "color": "#E53935", "bbox": {"x1":0,"y1":0,"x2":0,"y2":0}, "instruction": "添加参考图1的剑", "refTokens": [1] } ],
  "globalInstruction": "背景更换为……",
  "model": { "id": "[Mo]nano-banana-pro", "imageSize": "4K" },
  "finalPrompt": "……全文……",
  "createdAt": 0
}
```

---

## 7. 外部接口规格（墨墨中转站）

> 以下全部为逆向 TT AI 插件后验证过的真实调用方式（已用真实 Key 验证 `/v1/models` 可达），施工时严格照做。

### 7.1 生图（主接口，nano-banana 系）

```
POST {base}/v1beta/models/{model}:generateContent
Headers: Authorization: Bearer {key}
         Content-Type: application/json
Body:
{
  "contents": [{
    "role": "user",
    "parts": [
      { "inlineData": { "mimeType": "image/png",  "data": "<标记图 base64>" } },
      { "inlineData": { "mimeType": "image/jpeg", "data": "<参考图1 base64>" } },
      { "inlineData": { "mimeType": "image/jpeg", "data": "<参考图2 base64>" } },
      { "text": "<拼装后的最终提示词>" }
    ]
  }],
  "generationConfig": {
    "responseModalities": ["IMAGE"],
    "imageConfig": { "imageSize": "4K" }
  }
}
```
- `{model}` 需 URL 编码（如 `[Mo]nano-banana-pro` → `%5BMo%5Dnano-banana-pro`），路径后缀 `:generateContent`。
- 参考图顺序 = parts 中 inlineData 顺序 = 素材列表顺序（参考图1..N）。
- 响应解析：
  ```
  data = resp.candidates[0].content.parts 中第一个含 inlineData 的元素
  图片 base64 = data.inlineData.data
  mimeType 决定保存后缀（image/png → .png，image/jpeg → .jpg）
  ```
- 错误处理：
  - HTTP 401/403 → 立即失败，提示"API Key 无效或过期"
  - HTTP 429 → 退避重试（见 4.6.5）
  - HTTP 5xx / 网络错误 → 重试 3 次
  - 200 但无 inlineData → 失败，错误"模型未返回图像"；若响应含 `promptFeedback.blockReason` → 错误"请求被安全策略拦截"
- 单请求体积限制：所有 inlineData 合计建议 < 20MB；超出时对素材按 `sendMaxDimension` 等比缩小。

### 7.2 模型列表（设置页下拉 + 测试连接）

```
GET {base}/v1/models        Header: Authorization: Bearer {key}
响应: { "data": [ {"id": "..."} ... ] }
```

### 7.3 余额查询（顶栏显示）

```
GET {base}/api/usage/token/    Header: Authorization: Bearer {key}
响应示例（已实测）:
{ "code": true, "data": { "balance_cny": 9.76, "remain_quota": 4880000, "total_granted": 5000000, "total_used": 120000, ... } }
```
展示规则：显示 `balance_cny`（元）与剩余百分比 `remain_quota/total_granted`。

### 7.4 备用接口（P1，失败自动切换）

若 `:generateContent` 连续失败且响应错误类为"接口不支持"，尝试 OpenAI 兼容路径：
```
POST {base}/v1/images/edits?async=true     (multipart: model, prompt, image×N)
→ 返回异步 task_id → 轮询 GET {base}/v1/images/tasks/{id}
```
（此路径来自插件对 gpt-image 系的实现；作为 banana 降级兜底，非默认。）

---

## 8. 提示词模板全文（附录 A）

> 模板占位符：`{{...}}` 不允许改名；模板可在设置中编辑文案但结构须保留。
> 文案风格与约束原则来自逆向解密的插件内置角色提示词（"锁定构图/人物/光影、自然语言、禁止改变身份特征"）。

### A.1 系统块（锁定区，自动注入，只读）

```
你是顶级商业修图与特效合成师。请对提供的图片进行精确修改，并严格遵守以下锁定要求：
【身份锁定】不得改变人物的身份识别特征（五官结构、妆容特征、发型轮廓）。
【构图锁定】不得改变画面构图、人物位置、人物动作姿态、比例与透视关系。
【光影锁定】所有新增元素的受光方向、色温、阴影投射必须与画面现有光照逻辑一致。
【材质保真】人物服装、道具、发型的材质与花纹细节保持原有特征不变。
除明确要求修改的区域外，画面其他部分不得发生变化。
```

### A.2 区域块（每个区域一条，按编号顺序）

```
【{{color}}框 第{{n}}区】位置：{{location}}。要求：{{instruction}}
```
- `{{location}}` 自动生成（附录 B.3），例："画面右侧中部，覆盖范围较小"
- `{{instruction}}` 为操作员填写，例："在手中添加参考图1的剑，握持关系自然，剑身受光与环境光一致"

### A.3 全局块（有内容时注入）

```
【全局修改】{{globalInstruction}}
```
- 示例（操作员填写）："将背景整体替换为雨夜赛博朋克街道，霓虹反光与人物轮廓光方向一致，地面湿润反射人物身影"

### A.4 收尾块（自动注入）

```
【融合要求】所有新增元素需与画面在光影、透视、景深、颗粒感上自然融合；新增元素与人物发生遮挡关系时，遮挡边缘自然。
【输出要求】输出与输入同构图的成品图；移除画面上所有彩色框标记、编号、辅助线与文字，不得将标记残留于成品。
```

### A.5 面部重修指令（自动触发，输入=结果图脸区裁片 + 参考图1=原图脸区裁片）

```
以参考图1中的人物面部为准，修正本图面部为参考图1的同一人物（五官结构、妆容、肤色一致），保持本图现有的光线方向、角度、表情与质感，不改变发型与画面其他内容。
```

### A.6 定点重修指令（操作员触发，输入=当前结果图+问题区标记图）

```
【{{color}}框 第{{n}}区】位置：{{location}}。修复要求：{{repairInstruction}}
```
末尾追加 A.4 收尾块。修复示例："该区域手部结构错误，参考原图手型修正手指结构，保持光影一致"

### A.7 净版提取指令（惰性提取，输入=成片）

```
移除画面中的全部人物、场景与环境，仅保留【{{effectDescription}}】特效本身，输出为纯黑背景图，特效以原有颜色、形态、透明度呈现，不添加任何其他内容。
```
- `{{effectDescription}}` 取该 Job 区域指令中的特效名词（操作员提取时可修正）

---

## 9. 标记渲染规格（附录 B）

### B.1 颜色与编号
- 调色板（按区域顺序循环）：`#E53935 红 / #FDD835 黄 / #1E88E5 蓝 / #43A047 绿 / #8E24AA 紫`
- 编号：实心圆底（区域颜色）+ 白色数字（①②③…），直径 = `max(40, 图像短边×0.035)`，置于框左上角外侧（若超出画布则移入框内角）。

### B.2 线条
- 描边宽度 = `max(4, round(图像长边×0.004))`
- 填充 = 同色 12% 不透明度（让模型看到框内内容）
- 框角可加 2 倍线宽的角标（可选，提升可见性）

### B.3 方位描述生成算法
```
cx = (x1+x2)/2 / W;  cy = (y1+y2)/2 / H
水平: cx <0.33 左 / <0.66 中 / 其余 右
垂直: cy <0.33 上 / <0.66 中 / 其余 下
组合: "画面{垂直}{水平}部"（中中→"画面中央"）
面积比 area = (x2-x1)*(y2-y1)/(W*H)
档位: <0.08 "覆盖范围较小" / <0.35 "覆盖范围适中" / 其余 "覆盖范围较大"
```

---

## 10. QC 算法规格（附录 C）

### C.1 身份检测（onnxruntime-node）
- 模型：InsightFace `buffalo_l`（`det_10g.onnx` 人脸检测 + `w600k_r50.onnx` 特征提取）
- 安装：`scripts/setup-models.mjs` 从配置镜像下载到 `models/`，支持环境变量 `MODEL_MIRROR`（默认 hf-mirror.com 镜像，失败回退官方源）；下载失败不阻断，QC 降级为人工
- 流程：检测人脸（置信度 ≥0.5）→ 选面积最大 → 对齐（模型内置）→ 512 维特征 → 余弦相似度
- 结果图取脸：与原图脸中心距离最小者
- 阈值：通过 ≥0.62；中分 [0.50, 0.62)；不达标 <0.50

### C.2 构图检测
- SSIM：两图缩至长边 512，灰度，用 `ssim.js`；pHash：`imghash`（256bit）汉明距离
- 通过：SSIM ≥ 0.55 且 汉明距离 ≤ 16

### C.3 面部重修合成
- 裁片回贴：椭圆蒙版（长轴=裁片宽/高较大者 ×1.1），羽化 30px（高斯），中心对齐原检测框中心

---

## 11. 逆向插件对应关系（附录 D：我们抄了什么）

| 本产品设计 | 来自插件的什么 | 备注 |
|---|---|---|
| 系统块锁定提示词 | 解密的内置角色（"锁定构图/人物比例/透视"+人像优化模块） | 结构原则照抄，文案为本产品重写 |
| 区域框→整图编辑 | 标注面板的"标记→整图发送→指令要求删除标记"机制 | 已验证可行 |
| 参考图编号↔附件顺序 | 插件多图输入（Qwen 6图 app 的 image 节点顺序映射） | 防串味关键 |
| 4K 档位 | `imageConfig.imageSize: 1K/2K/4K` 用法 | 直接沿用 |
| 任务卡状态/进度/重试 | 插件任务队列（pending/生成中/超时"点击重新读取"） | UX 照抄 |
| 费用显示 | 插件余额显示（￥-.-）与 RunningHub 币/秒计费展示 | 改成本地统计 |
| 完成提示音 | 插件 `ENABLE_SOUND` | 照抄 |
| 配方/历史 sidecar | 插件历史 sidecar（prompt/platform/model/meta 全留档） | 扩展为 recipe |
| "测试连接"按钮 | 插件设置页"测试连接" | 照抄 |
| 断点重做/历史复用 | 插件历史任务拖回重导 | 扩展为 Session 全量恢复 |
| Key 本地保护 | 插件 `ttai.enc.v1` 思维 | v1 用 obf 混淆（非强加密，够用） |

---

## 12. 验收标准与测试清单

### 12.1 端到端验收（必须全过）
1. 启动：`npm run setup && npm run dev` → 打开 `http://localhost:5173` 无报错；设置页填写 Key 后 [测试连接] 成功，顶栏显示余额
2. 新建客单：导入一张测试场照；添加客户素材（一张剑图）；从库添加一张素材（预先手动入库一张"闪电"）
3. 标注：画 2 个框；区域条目自动出现（红①/黄②）；分别填"手里加参考图1的剑…""身体周围加参考图2的闪电…"；全局填"背景换成雨夜街道…"
4. 生成：点开始生成 → 任务栏出现卡片（排队→生成中→质检）；SSE 进度变化正常；约 1~3 分钟出结果；费用入账（0.30）
5. 结果检查：成品图中两处元素存在、背景已换；**图中无任何彩色框与编号残留**；QC 横幅显示身份分与构图结论
6. 审核：[通过交付] → 状态 delivered；`03_delivery/final_v1.png` 存在
7. 归档：素材库"历史成果"出现该 Job（自动标签含"剑、闪电"与颜色）；搜索"闪电"能找到；⭐ 收藏生效
8. 提取净版：对历史 Job 点 [提取净版] → 素材库出现 candidate 净版（黑底、无人物）；⭐ 后进入收藏夹
9. 复用配方：历史 Job 点 [复用配方] → 新 draft 客单带原有区域与指令结构；换图后可再次生成
10. 重修回路：对某 Run 点 [定点重修] → 画一个框填修复指令 → 产生新 Run 且 QC 重新执行
11. 中断恢复：生成中杀进程重启 → 队列显示 interrupted 可重试
12. 失败路径：填错 Key → 生成失败红标 + 通知；[重试] 改 Key 后成功

### 12.2 单元测试（vitest）
- 提示词拼装器：给定 2 区域+全局 → 快照断言全文（含方位描述、参考图编号）
- 参考图重编号：删除中间素材后，区域 token 与附件顺序一致
- 标记渲染器：给定 1000×1000 与 4000×3000 图，验证线宽/字号/位置在规格范围
- 方位描述算法：九宫格 9 个用例 + 面积 3 档
- QC 阈值：mock 特征向量，验证 3 档分流（含面部重修触发）
- 净版/recipe 归档：交付后 DB 与文件系统断言

---

## 13. 施工顺序（给 Agent 的里程碑）

- **M1 地基**：项目脚手架（前后端）→ SQLite + 设置页 + SSE → 墨墨连接测试/余额
- **M2 编辑态**：客单 CRUD → 素材导入 → 标注画布（react-konva）→ 提示词总览 + 拼装器（含单测）
- **M3 生成链**：标记渲染器（含单测）→ 队列 + 任务栏 → 生成管线（含重试）→ 下载落盘
- **M4 质检与审核**：身份/构图 QC（含模型安装脚本）→ 面部重修自动触发 → 审核界面（对比/重修/重跑）
- **M5 素材库与归档**：三区 UI → 自动归档+标签 → 搜索 → 复用配方 → 惰性净版 → 验收（§12）→ ACCEPTANCE.md

---

## 14. 风险与 Backlog（P2）

| 项 | 说明 |
|---|---|
| 参考图预处理（抠背/降噪） | 负责人决策 v1 不做；出问题（模型引入参考图背景/串味）再作为开关加入 |
| 区域数 >5 拆分引导 | 已做软提示；硬拆分向导后置 |
| 元素自动质检（视觉模型） | 需视觉模型端点；预留 `qc.elements` 接口 |
| 变体生成（n>1） | 成本原因后置 |
| 文件夹监听批处理 | 拖文件夹自动建单批跑 |
| 团队多用户/审核协作 | 单机 v1 |
| 视频特效线 | 独立产品线 |
| 净版自动标签/去重（pHash） | 入库标准化二期 |
| macOS/Linux 支持 | 非目标 |
| Key 强加密（DPAPI） | 现为 obf 混淆，待升级 |

---

*文档结束。施工中如遇本 PRD 未覆盖的冲突，以 §4 功能需求 > §12 验收标准 > 其他章节 的优先顺序裁决，并将裁决记录写入 ACCEPTANCE.md。*
