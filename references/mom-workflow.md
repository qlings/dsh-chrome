# MOM 审批流（wf）取证配方

适用：智慧安全生产管理系统（`<mom-host>:<port>`）的流程模块 `/wf/*`，以及任何用「流程模板 + 步骤 + 待办任务」模型的 Hollsys 系工作流。
本文件来自 2026-11-27 实测：排查「异常分析审批 → 管理人员审批」配了「所有人必须同意」却一人同意就结束。

**这套系统的坑不在页面，而在「页面显示的配置」与「引擎实际读取的字段」不是同一个。** 先按本文把三层数据取出来对齐，再谈结论。

## 1. 三层数据，缺一层就会误判

| 层 | 取什么 | 接口 |
|---|---|---|
| 模板配置 | 节点策略（`handler_model`）、处理者类型（`handler_type`）、会签相关（`counter_signature`/`SignConfig`）、版本号 | `POST /api/v1/wf/query_template` |
| 运行实例 | 任务用了哪个 `flow_version`、当前步骤、待办人、已办记录 | `POST /api/v1/wf/wf_task/Query`、`POST /api/v1/wf/get_approve_detail` |
| 引擎表 | 会签配置表到底有没有数据（只部分表对外开放） | `POST /api/v1/wf/wf_cosignconfig/Query` |

**必查第一条：实例的 `flow_version` 与模板版本是否一致。** 不一致就先怀疑「改完没生效」，而不是引擎有 bug。

## 2. 模板：`query_template`

```json
{"action":"fetch","url":"/api/v1/wf/query_template","method":"POST",
 "authFrom":{"key":"m5_token","typeKey":"m5_tokenType"},
 "headers":{"moduleCode":"process-design","X-Function-Code":"process-design","platform":"pc","language":"zh-cn"},
 "body":{"wftmpCode":"F20261001111114225","flowVersion":24},"saveTo":"wf/tpl_v24.json"}
```

返回 `data.templateInfo / nodes[] / nodeInfo{} / lines[] / lineInfo{} / templateGraph{}`。

- **`nodes[]` 和 `nodeInfo{}` 是同一批节点**（数组 / 按 step_code 索引）。引擎用的是这份。
- 同一模板的历史版本都能按 `flowVersion` 查回；对比版本即可看出「哪一版开始改的策略」。
- 模板列表：`POST /api/v1/wf/wf_template/query`，`conditions` 里可加 `wftmp_code`；**最新版的 `wftmp_sts` 是 20，历史版本是 30**，别把 20 当成「草稿/未发布」。
- 流程设计器页面：`/wf/html/process-design.html?ModuleCode=process-design&OperType=Modify&data={...}`，`data` 是模板行 JSON（URL 编码）。

### 2.1 节点字段含义（前端映射，实测）

| 字段 | 含义 | 取值 |
|---|---|---|
| `handler_model` | 处理策略 | `0` 所有人必须同意 / `1` 一人同意即可 / `2` 依据人数比例（`3` 是旧版「会签」，界面上已选不到） |
| `handler_type` | 处理者类型 | `0` 部门 / `1` 人员 / `8` 角色 / `10` 业务角色 / `9` 数据角色 / `3` 发起者 / `12` 同级部门 … |
| `counter_signature` | 会签策略 | 设计器里**写死 3**，没有输入框绑定它；全库节点都是 3 |
| `SignConfig` | 会签配置（后端据此重建 `wf_cosignconfig`） | 只有「处理策略=会签(3) + 处理者类型=部门」那条老分支才会生成；新界面选不到 3 → **永远是 `[]`** |
| `policy_percentage` | 策略百分比（配 `handler_model=2` 用） | 数字 |
| `continuous_approve` | 连续审批 | `0` 跳过 / `1` 继续 |

## 3. 任务：`wf_task/Query`（任务监控列表）

```json
{"action":"fetch","url":"/api/v1/wf/wf_task/Query","method":"POST",
 "authFrom":{"key":"m5_token","typeKey":"m5_tokenType"},
 "headers":{"moduleCode":"workmonitor","platform":"pc","language":"zh-cn"},
 "body":{"pageIndex":1,"pageSize":50,"orderSort":"[]",
         "conditions":"[{\"name\":\"wftmp_code\",\"value\":\"F20261001111114225\",\"compare\":0,\"character\":0}]"}}
```

- `conditions` 必须是 **JSON 字符串**（传数组会 400）；`orderSort` 乱写会回 `42601: syntax error at or near "asc"`，先传 `"[]"`。
- `task_sts`：`0` 运行中 / `3` 作废 / `4` 冻结 / `6` 已完成。
- 行里有 `flow_version`、`business_data_code`、`common_business_code`——**下一步查详情要用后两个**。

## 4. 审批详情：`get_approve_detail`（任务详情 / 监控详情页用的就是它）

```json
{"action":"fetch","url":"/api/v1/wf/get_approve_detail","method":"POST",
 "authFrom":{"key":"m5_token","typeKey":"m5_tokenType"},
 "headers":{"moduleCode":"approve-work","platform":"pc","language":"zh-cn"},
 "body":{"businessCode":"/lowcode/display/pc/ycsp.html","businessDataCode":"DM_Risk_202611270063"}}
```

只返回 `datas[0]`，里面分三块：

- `TaskDetail[]`：任务级（`task_code` / `task_sts` / `flow_version` / 起止时间）。
- `ApprovedInfo[]`：**每条审批动作一行**。`step_sts` 语义见下表；同一人同一秒常有两行（`通过` + `传阅/未读`），别当成两次审批。
- `UnApproveData[]`：当前还没办的步骤与待办人（`UnApprovePerson` 逗号分隔，`UnApprovePCode` 对应工号）。**空数组 = 当前没有待办步骤。**

`step_sts`：`0` 转办 / `1` 会签（上会处理）/ `2` 通过 / `3` 驳回 / `4` 上传 / `6` 传阅未读 / `7` 传阅已读 / `8` 反馈。

## 5. 待办任务：`query_task_detail`

```json
{"action":"fetch","url":"/api/v1/wf/query_task_detail","method":"POST",
 "authFrom":{"key":"m5_token","typeKey":"m5_tokenType"},
 "headers":{"moduleCode":"approve-work","platform":"pc","language":"zh-cn"},
 "body":["T20261127134920G24"]}
```

body 是**任务号数组**。返回当前用户的这条待办：`step_code`、`role_code`、`flow_version`、`oper_power`、`can_reject`、`is_last_step` 等——审批页 `approve-handle.html?TaskCode=...` 就是靠它渲染按钮。

## 6. 引擎表：哪些能直接查

平台有「通用表查询」通道：`POST /api/v1/<模块>/<表名>/Query`，body 同样是 `{pageIndex,pageSize,orderSort,conditions}`，返回 `{total,datas}`。

| 表 | 实测 | 用途 |
|---|---|---|
| `wf_task` | ✅ | 任务实例 |
| `wf_cosignconfig` | ✅（本环境 **total=0**） | 步骤会签配置 |
| `wf_approve` / `wf_step` / `wf_step_config` / `v_wf_step` | ❌ `code:1 未找到对应服务` | 未对外开放 |

表名不可枚举，猜不到就回 `未找到对应服务`（这跟「表是空的」是两回事，别混）。只读排查可用，**别拿它试写**。

## 7. 判定「多人必须同意」有没有生效：三步

1. **配置侧**：`query_template` 里该节点 `handler_model=0`，且实例 `flow_version` 就是这个版本 → 配置确实传到了引擎。
2. **现场侧**：审批前 `get_approve_detail` 的 `UnApproveData.UnApprovePerson` 列出全部 N 人。
3. **行为侧**：让其中 1 人同意后立刻再查一次：
   - 该人 `step_sts=1（会签）`、`UnApproveData` 还剩 N-1 人 → **会签生效**；
   - 该人 `step_sts=2（通过）`、`UnApproveData` 变空 → **按或签收尾了，配置没生效**。

第 3 步是唯一可信的判据，别只看页面上的单选框。

### 7.1 已知现场（2026-11-27，异常分析审批 v24）

- 节点 `管理人员审批`：`handler_model=0`、`handler_type=8`（3 个角色 → 7 人）、`counter_signature=3`、`SignConfig=[]`。
- 李民一人同意 → 该行 `step_sts=2`、`UnApproveData=[]`，其余 6 人待办消失，实例停在「运行中 + 当前活动暂无数据」（结束节点没执行）。
- 全库 `wf_cosignconfig` 为空；22 个模板约 250 个节点 `counter_signature` 全为 3；历史任务里从未出现过 `step_sts=1` 的会签行。
- 结论口径：**「所有人必须同意」只写进了 `handler_model`，引擎判定会签所需的会签策略/会签配置从未被写入，于是该步骤按「角色候选人 = 一人同意即可」收尾。** 这是设计器（`node-config-form.js` 不绑定 `counter_signature`、不生成 `SignConfig`）与引擎取值口径不一致，不是用户配错。

## 8. 审批页与操作副作用（动手前必读）

- 审批页：`/wf/html/approve-handle.html?ModuleCode=approve-work&TaskCode=<任务号>&IsWFCall=true`；同意/驳回各打一个接口：`task_approve` / `task_reject`，body 是**整条 taskInfo 数组**（含 `operation_type:1|0`、`approve_comment`）。
- 提交成功返回 `{"code":0,"msg":"","data":0}`；**回执说明不了引擎怎么判**，必须回查 `get_approve_detail`。
- 提交后前端会 `location.href` 跳到 `approve-work.html`：**这个 iframe 的 frameId 立刻作废**，而且 MOM 门户里可能连带动其它业务页（本次 9 个帧关到只剩 2 个，回到首页）。动手前先记下要复用的 URL/接口，提交后重新 `frames`。
- 审批页常是 `display:none` 的 iframe：`outline`/`click` 点不到，用 `eval` 在帧内 `el.click()`，见 `tables-dialogs.md`。
- 真提交前想先看请求体：`netBlock{"patterns":["task_approve"],"op":"set"}` → 点提交 → `netBlock{"op":"hits"}` → 看完 `op:"off"` 再真提交。
- 门户是「壳页 + iframe」：`tabs` 只有一两个标签而用户说「三个界面都开着」时，`frames` 才是入口。
