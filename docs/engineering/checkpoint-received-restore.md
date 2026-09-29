# 接收副本恢复到新目录

适用：接收者自己的 Linux 节点已经确认收到完整固定副本，且原项目、任务、双方节点授权与材料期限仍有效。依赖 [受控传输](checkpoint-transfer.md)，不能复制发送者状态库或改写原保留票据来伪造接收身份。

## 预检、写入和发布

在接收节点本机执行；目标父目录必须存在，目标目录必须从未存在。根据终端分别确认 `PLAN`、`RESTORE` 和 `PUBLISH`：

```bash
npm run runner:restore-plan -- --transfer TRANSFER_ID --state /path/to/receiver-state --target /existing/parent/new-directory
npm run runner:restore -- --transfer TRANSFER_ID --state /path/to/receiver-state --target /existing/parent/new-directory
```

`--transfer` 与原发送方恢复使用的 `--request` 二选一。接收端只读取自己的原私有对象库，不初始化、重新下载、续期或修补；接收回执尚未确认时拒绝恢复。

每次及发布前重新核对当前双方权限、原绑定、材料期限、持久对象和实际暂存字节。复用 [本机恢复](checkpoint-restore.md) 的固定目录描述符、inode 校验、独立暂存与不覆盖发布；不执行 hooks/filter、脚本、安装或模型。Linux 构建需要 C 编译器与 libc 头文件，macOS/Windows 恢复未支持。

## 状态、清理和任务内报告

```bash
npm run runner:restore-status -- --state /path/to/receiver-state --target /existing/parent/new-directory
npm run runner:restore-report -- --state /path/to/receiver-state --target /existing/parent/new-directory
npm run runner:restore-cleanup -- --state /path/to/receiver-state --target /existing/parent/new-directory
```

`REPORT` 发布有界历史观察到对应传输卡，原材料与接收身份分开显示。状态不是实时文件扫描；缺失旧核验时间保持未知。报告丢失确认沿用原待发包和顺序回执，不重新恢复；详见 [恢复结果](checkpoint-restore-results.md)。

`CLEAN` 只清理本次有完整所有权清单的未发布暂存；用户编辑、未知发布或日志不完整时保留现场。已发布目标不会被此命令删除。

传输窗口过期不抹去已收到的副本，新的恢复仍受原材料期限和双方当前授权约束。源保留副本删除不等于接收副本删除。普通文件副本不是完整 Git 仓库；恢复不改变任务操作者、负责人、工作区执行授权或 Run。

HTTP 授权核对与本机发布不是分布式原子事务，历史成功报告也不证明当前文件仍可用。后续接受接手必须补充新的现场核对，不能只复用旧报告。
