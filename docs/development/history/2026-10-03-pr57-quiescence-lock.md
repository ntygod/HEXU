# 2026-10-03｜PR57 只读占用检查的 SQLite 锁竞争

用户明确要求接手PR #57的验收阻碍，并保留PR #56已验收基线。基于`ce4a202dde8cda0c3370b1fe8b58099f5979bb9d`修复；父PR56保持`a06998ab9035bb3164a271d77ec884204febfaad`，main保持`a3ae2e8`。这次只处理该故障，没有恢复#52或旧文件写入/恢复/清理链的整体独审。

## 失败现场与原因

原[CI184 / 37056978954](https://github.com/ntygod/HEXU/actions/runs/37056978954)的工程结果为617/618，Chromium为199/199。失败用例是`integration-runner`中的“缺对象不从工作树修补；未知占用、脏目录和确认期间变化阻止发布，保留本人修改”。断言期望已有工作区占用拒绝，实际得到`database is locked`。

在相同源码上重新编译定位，栈中`result-code.js:40`对应`assertCodeQuiescent`对共享`~/.hexu/workspace-leases/registry.sqlite`的`SELECT root,identity FROM claims`，不是控制服务业务库或材料副本。原日志没有记录具体持锁进程，不能补造CI当时的进程身份。

该函数打开只读SQLite连接时没有busy handler，默认遇锁立即失败；正常`WorkspaceLease`写入侧已有5000ms忙等待。多个进程共享同一OS用户的登记库，短写事务提交期间同样会阻塞读取。用独立读进程和测试专用HOME、父进程持有的`BEGIN EXCLUSIVE`稳定重现：未修复版本在0—1ms内返回`SQLITE_BUSY`（errcode5），在写事务尚未提交时就退出。节点本机journal的同类读取也存在相同缺口。

## 最小修复

仅为该函数的两条只读连接设置`PRAGMA busy_timeout=5000`，采用现有写入侧等待范围；短事务结束后再读取实际记录。仍以原规则拒绝重叠目录、相同目录身份及未确认执行；持续读不到状态继续抛错，不能推断为空闲。

没有改测试/CI超时、断言、并行度、数据库schema或journal mode，没有重试模型/文件操作、删除任何占用或改变用户HOME。测试只给独立子进程设置全新夹具HOME，不接触操作者的实际登记库。

## 实际验证

Linux独立容器使用与失败CI相同的Node24.21.0。新增四项回归在原生产代码上全部失败，均能看到立即返回的`SQLITE_BUSY`；修复后四项通过：

- registry短写事务提交后，读取到当前占用并按原错误拒绝。
- 本机journal短事务提交后，仍拒绝未知执行。
- 无关工作区的短事务不会误拒绝空闲目标，原占用记录不变。
- 持续独占锁达到等待上限仍报错，既不放行也不清除记录。

新回归4项、原`integration-runner`6项及`result-code-runner`2项合计**12/12通过**，包括原失败用例；服务构建通过。持续锁测试约5.1秒结束。使用实际Git、文件、HTTP和明确协议夹具，无真实模型调用。PR57的`state.tsx`及浏览器代码保持原Git内容，原199条页面/视觉证据不冒充修改后HEAD的完整CI。

最终完整验收以[PR57检查](https://github.com/ntygod/HEXU/pull/57/checks)和其精确HEAD为准。本修复新增4项工程测试，不能沿用旧618的总数。原CI失败记录保留；源码与回归入口为[只读占用核对](../../../apps/runner/src/agent/result-code.ts)、[并发回归](../../../tests/result-code-quiescence.test.ts)。
