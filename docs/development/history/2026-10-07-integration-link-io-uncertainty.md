# 2026-10-07｜修复归档文件发布链的 linkat I/O 不确定结果

## 范围与来源

用户要求修复[问题52](https://github.com/ntygod/HEXU/issues/52)。从远端归档 `archive/2026-10-07/pr-55`、原head `e977fb241c59d3a8f82003b2c0de18d02a55aa3a` 建立独立修复工作副本；该副本使用自己的依赖目录，没有指向当前main的共享node_modules。

本次只修原归档实现中的文件发布错误分类，当前main `ee2434d128189c86916ee3bbd822cfd9523c0c8c` 的已交付范围保持。不把归档的全部功能重新带进main，也不重新评价完整文件/私有材料安全审阅。

## 根因与修正

原 [integration-add.c](../../../apps/runner/src/native/integration-add.c) 将所有 `linkat` 失败报告成exit20/`not_published`；[integration-change.c](../../../apps/runner/src/native/integration-change.c) 发布匿名替换inode到私有备份槽时也有同样分类。调用方把这类确定拒绝当成未写入，清掉持久意图；首个顶层新增没有其他材料证据时会进入failed并释放锁。

- 尝试命名发布后的错误，仅EEXIST仍作为确定拒绝。其他错误使用未知结果exit21，保留可能已发布的inode与原意图；没有自动重试、清理或回滚。
- 发布前输入、路径、父目录、字节与权限检查的确定拒绝保持原样。正常成功、EEXIST不覆盖语义以及同步失败的未知结果继续保留。
- 两种原生助手提升为v2；[新增包装器](../../../apps/runner/src/agent/integration-add-files.ts)与[替换包装器](../../../apps/runner/src/agent/integration-change-files.ts)拒绝旧v1，要求重新构建。避免新调用方继续信任旧助手错误的exit20保证。
- 原 [应用编排](../../../apps/runner/src/agent/integration-application.ts)与[文件恢复](../../../apps/runner/src/agent/integration-file-restoration.ts)已有未知结果保留意图/材料/锁的分支，不修改它们的阶段、权限、回执或日志schema。

## 确定性复现与回归

新增 [integration-link-io.test.ts](../../../tests/integration-link-io.test.ts) 的12项Linux检查。通过测试进程中精确限定到一个助手的spawn路由，为实际助手附加[测试专用linkat库](../../../tests/fixtures/integration-link-io.c)。生产助手文件和调用方执行原代码，返回值没有伪造；仅在独立临时目录控制实际syscall前后的故障边界，结束后恢复核心模块绑定。

测试包含：首个顶层新增before/after EIO（2），正常成功和实际竞争EEXIST（2），替换备份暂存before/after EIO（2），原文件恢复的新增及替换before/after EIO（4），旧v1协议助手拒绝（2）。after模式先执行真实linkat成功，再注入EIO；不是声称真实磁盘已经发生故障。最后2项使用明确声明的旧助手协议替身，不当作实际I/O测试。

真实Node、Git、回环HTTP、独立业务/认证/节点SQLite与文件系统证明：

- 新增或替换不确定时原应用/恢复的具体文件意图仍在；替换的existingChanges意图保持，原应用与恢复记录互相独立。
- 原工作区claim仍拒绝后来写入者，重复调用不再进入助手、要求写入确认或改变原日志；失败不借目标存在补报成功。
- 新增after EIO的真实文件存在，before EIO未出现命名文件；替换原目标保持，after EIO的备份槽材料保留。正常与EEXIST对照仍正常结算且不覆盖竞争文件。

## 实际验证

在独立Linux Docker环境运行，Node24.21.0、Debian自带cc12.2和Git，2CPU/3GiB限制，未修改宿主包、已有服务或公开端口。数据/账号/凭证均为既有明确夹具，没有模型调用；依赖只读挂载，HOME另行隔离。

- 原生产源码加本次12项检查：**2通过、10失败**，0取消/跳过，95.1秒；I/O错误实际被误归类为20，旧v1没有被拒绝。失败日志保留。
- 修复后同一组：**12/12通过**，0失败/取消/跳过，94.9秒；类型检查通过。
- 完整工程/浏览器CI及最终修复归档tag由本次PR正文补齐，父归档CI不能计为本次结果。较广文件审阅、跨平台/远程部署和真实provider联调未因本修正完成。

原13-05工作项保持部分实现。原归档标签不改写；修复后的归档提交与原始故障证据分别保留。
