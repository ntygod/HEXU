from pathlib import Path
marker = Path('.staging/applied-03')
if marker.exists():
    raise SystemExit(0)
def replace(path, old, new):
    p=Path(path);s=p.read_text();assert s.count(old)==1,(path,old);p.write_text(s.replace(old,new))
replace('README.md', '当前只同步目录别名和变更数量，不读取/上传代码，不调用模型；Windows 尚不支持。', '当前只同步目录别名和变更数量。Git 会在获授权的本机目录读取文件以计算状态，但代码、文件名和路径不会上传，也不调用模型；Windows 尚不支持。')
replace('docs/development/19-work-items.md', '建立首个账号后直接进入个人空间，可建团队、邀请和加入，真实界面已有；独立节点连接与完整渐进入门偏好未实现。', '账号建立、团队创建/加入与节点配对入口已有；完整渐进入门偏好和节点任务执行授权尚未实现。')
p=Path('docs/development/21-implementation-status.md');s=p.read_text()
old='本地 Chromium 无法访问 localhost（ERR_BLOCKED_BY_ADMINISTRATOR），不计为本地浏览器通过。新增 3 条浏览器流程的 CI 结果待具体 Actions 记录登记，不能由测试定义推断通过。'
assert old in s
s=s.replace(old, '''[E2b1 完整检查 36216036404](https://github.com/ntygod/HEXU/actions/runs/36216036404) 已在 GitHub-hosted Ubuntu / Node 24 通过；工作流应用并格式化后实际检查源码为 `7c969c83204e8b4a1454b0cdc246c95c7daac514`，不是触发检查的临时传输提交。

| 检查 | 实际结果 |
| --- | --- |
| 锁文件安装、格式检查 | 通过 |
| 双端 TypeScript、前后端构建 | 通过 |
| 领域、存储、API、认证、原生协议替身与节点工程测试 | 119 条通过，无跳过 |
| Chromium 浏览器流程 | 23 条通过，0 失败、0 不稳定、0 跳过 |
| 浏览器产物 | 已下载并读取报告，抽查节点在线与手机深色截图 |

新增 3 条浏览器流程实际启动独立 CLI，完成配对、授权目录变更、真实数量同步、刷新、停止/重启、网页撤销与只读成员访问撤销。配对被取消和本机不同意时不会注册。既有 20 条流程保留，未通过跳过或重试掩盖失败。

检查中修正了空间切换返回工作台后的测试导航，并发现 Git clean/process 过滤器可能被普通 status 调用。已改为隔离配置与复制有界索引的状态采集；过滤型仓库显示不可用，包含配置在预检后才变化的回归用例，不执行仓库脚本来换取摘要。用例同时检查原索引未被改写。

本地 Chromium 无法访问 localhost（ERR_BLOCKED_BY_ADMINISTRATOR），不计为本地浏览器通过；上述浏览器结果来自仓库 CI。主分支最终结果以其具体提交的只读 CI 为准。''')
p.write_text(s)
p=Path('docs/engineering/adr-0006-node-metadata.md');p.write_text(p.read_text()+'\n过滤器和 Git 管理目录的官方语义参见 [gitattributes](https://git-scm.com/docs/gitattributes) 与 [git --git-dir](https://git-scm.com/docs/git)。实际隔离保证按本轮代码和回归测试记录，不将其描述为操作系统沙箱。\n')
marker.write_text('Verified delivery evidence and accurate local file-reading boundary recorded.\n')
