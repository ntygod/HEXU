# 项目资料与修订

这是 `HX-DEV-05-02` 的本机文本/链接切片。资料属于当前项目，供有访问权的成员查阅；保存资料不表示已发送给模型，也不会自动成为团队约定。

## 使用

进入项目 → **项目资料** → **新建资料**，选择文本资料或链接引用。标题最多 120 字符，正文/链接说明最多 8000 字符；文本保存原始缩进与换行，作为纯文本显示，不执行 HTML。链接只允许完整的 HTTP/HTTPS 地址（最多 2048 字符），拒绝用户名/密码字段和可执行协议；服务器与页面都不自动抓取、嵌入或预览链接内容。用户主动点击才在新页打开，带 `noopener noreferrer`。

资料列表按创建顺序倒序分页，可搜索标题、正文和链接。打开资料可查看创建者、更新者、修订、ID 和内容指纹。项目 URL 的 `tab=sources&source=<id>` 是直接入口，刷新和返回保留位置；分享这个链接不会授予项目访问权。

编辑时固定打开时的修订；其他人修改或删除会显示新内容与冲突，本页草稿不被替换。选择载入最新资料或保留草稿后，仍需明确保存。暂时的读取失败保留已加载内容和未保存草稿，提供重读入口；确认无权访问则清空。关闭、刷新、切换身份/空间和撤销编辑权限会丢弃编辑草稿，草稿不写浏览器存储。

删除需要在当前资料中确认影响：移入“已删除资料”，保留修订历史，不删除外部链接、代码或已经确认的执行材料。恢复沿用同一资料 ID，但产生新修订；不会重新发送任何内容。删除期间不能直接修改，必须明确恢复。已删除资料及历史继续遵守父项目权限。

资料创建、修改、删除/恢复的回执未确认时，“确认上次资料操作”只重放原 payload/key。旧回执不会重复创建、覆盖后来的修改或反转删除/恢复。修订历史需要用户显式刷新，阅读位置不会被 SSE 更新重置。

## 接口与持久化

所有接口使用 `/api/v1` 前缀，沿用现有 Cookie、空间、来源校验及写入幂等键。项目 view 可读；edit/manage 可创建、修改、删除和恢复。空间所有者不越过项目权限。项目已归档仍允许人工资料协作。

| 接口 | 输入/行为 |
| --- | --- |
| `GET /projects/:projectId/sources` | `state` 为 active 或 deleted，另有 `q`、`cursor`、`limit`；默认 20，最多 50；只返回当前项目，正文摘要最多 160 字符 |
| `POST /projects/:projectId/sources` | `{kind, title, content, url}`，kind 为 text 或 link，201；文本 url 为空，链接说明可省略 |
| `GET /projects/:projectId/sources/:sourceId` | 当前资料，包括明确标记的已删除记录；错误项目或空间返回不可访问 |
| `PATCH /projects/:projectId/sources/:sourceId` | `{expectedRevision, title, content, url}` 完整替换内容；不允许改变类型、归属或作者 |
| `POST /projects/:projectId/sources/:sourceId/lifecycle` | `{expectedRevision, action}`，action 为 delete 或 restore，无变化不增加修订 |
| `GET /projects/:projectId/sources/:sourceId/revisions` | `before=<revision>`、`limit`；默认 10，最多 50，降序返回不可变快照 |

SQLite 迁移 13 增加 `project_sources` 和 `project_source_revisions`。旧项目说明、讨论与演示文件不会自动变成用户创建的资料。当前记录、不可变修订、项目范围 outbox 和幂等回执在同一事务；重放前及新事务内都检查当前项目权限。分页游标失效时明确要求重新加载。

`contentHash` 是类型、标题、原文和规范化 URL 的 SHA-256；它描述内容版本，不是授权凭据。删除/恢复只改变状态和修订，保留内容指纹。资料不进入当前模型上下文，因此不修改 Project/Task 修订、Run、dispatch、Operation、成员或目录锁。

## 后续边界

附件上传/存储、仓库连接、从讨论生成约定、任务选材、模型发送、全局资料搜索和正式远程部署仍未接入。不能将链接引用叫作文件上传、已读取网页或已同步模型；将来选材需要按权限检查稳定 ID、修订、哈希和当前删除状态。实际检查见 [21](../development/21-implementation-status.md)，下一项见 [22](../development/22-next-delivery.md)。
