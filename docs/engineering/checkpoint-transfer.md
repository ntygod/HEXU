# 同机双节点的受控对象传输

适用：同一个 team-local 控制服务、同一项目、同机回环的两个 Linux 节点。双方使用自己的身份与私有状态目录，且当前均可编辑原任务。已接入范围与验证见 [21](../development/21-implementation-status.md)。

## 从任务发起

在任务的「代码检查点 → 核验与本机保留 → 查看对象传输」中，原节点本人选择接收节点、核对固定提交及排除项后创建请求。摘要配对、项目阅读权、恢复报告都不授予代码发送权限。

每次最多 16 MiB / 2048 个对象，使用 64 KiB 密文块；传输窗口最长 30 分钟且不超过原材料期限。普通 API 限制未放宽。已提交的敏感内容可能在材料里，不保证自动排除了所有秘密。

## 双方本机同意

先由接收节点执行，并按终端提示输入 `RECEIVE` 和传输 ID：

```bash
npm run runner:transfer -- accept --transfer TRANSFER_ID --state /path/to/receiver-state
```

源节点另行输入 `SEND` 和同一个 ID，再由接收端取回核验：

```bash
npm run runner:transfer -- send --transfer TRANSFER_ID --state /path/to/source-state
npm run runner:transfer -- receive --transfer TRANSFER_ID --state /path/to/receiver-state
```

发送方先持久保存固定包。回复丢失时重复相同命令，对账原密钥、密文与序号，不重新采集或加密。接收端解密并核对对象类型、Git 哈希、数量及完整闭包，从自己的持久副本复核后才报告收到。

传输使用 X25519 / HKDF-SHA256 / AES-256-GCM，绑定材料、接收公钥和块序号。控制服务暂存有界密文，浏览器只读取元数据；公钥身份仍信任控制服务，不宣称能抵抗恶意控制服务或同 OS 用户。

## 中断、撤销与清理

```bash
npm run runner:transfer -- status --transfer TRANSFER_ID --state /path/to/private-state
npm run runner:transfer -- forget --transfer TRANSFER_ID --state /path/to/private-state
```

网页取消、到期与当前授权失效关闭后续收发；只清理服务暂存密文。`FORGET` 需本机明确同意，只处置本次材料。取消不撤回对方已经收到的字节，也不删除源保留副本或恢复目录。

对象收到后，可以由接收者单独执行 [接收副本恢复](checkpoint-received-restore.md)。收到对象、文件恢复、接手邀请与真正接受接手分别记录；传输不改变任务负责人、操作者或 Run，不授予模型执行。
