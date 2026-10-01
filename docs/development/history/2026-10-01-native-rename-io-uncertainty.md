# 2026-10-01｜原生命名空间I/O结果与安全审阅

基于已验收PR42的faf7c036独立修正，不移动冻结PR29/30/42，不合并或部署。PR42 CI161通过1109/1109工程、252/252 Chromium及汇总；174–176原图已下载、核SHA256并逐张查看，旧CI160未读取的大trace不补造结论。

## 审查范围

历史独审明确覆盖的只是最初新增文件应用与明确停止后的保留锁结算；当时已修凭证删除、回退取消、registry路径重定向与原收据等问题。私有试应用独审发现最终权限等待期间目标被编辑/材料过期两项问题后中止，后续普通替换/移出、文件恢复、冲突/重算/暂存处置和PR30整目录保留尚无完整跨阶段独审。全绿工程/页面不能替代这项缺口。

本轮独立静态复读四个Linux原语、对应add/change/add-directories/preserve包装和部分应用/保留调用链，核fd固定/路径、叶名、no-follow、owner/模式/单链接/xattr、字节、排他发布、fsync、意图与不回滚。恢复/结算编排和更广DB/UI/跨操作审阅继续进行。除以下结果分类问题，已读原语范围暂未发现其他具体阻断，不将有限覆盖写成整个PR或14条相依分支已审完。Linux rename不是内容CAS，停止其他写入者的前提保持。

## 发现与修正

integration-change的delete分支与restore-publish原先把所有renameat2错误都返回为20/明确未改名。独立临时故障模型先执行真实rename、再返回EIO时，原inode已在目的地而助手仍报告not_changed/not_published。原字节保留，未复现自然发生的内核/硬件错误，也没有操作或丢失真实用户数据。

影响需区分：普通应用/文件恢复会清掉该文件意图，但已有backupIdentity仍使状态needs_attention并保留claim，不能称自动解锁。新目录恢复/私有候选会把publicationAttempted清除并记为failed/staging，错误缩小不确定性；已有stage身份和目标核验仍阻止删除已发布目录。新父目录及备份调用者本来就保留目录意图。

本修正仅把这两处rename的EIO返回视作unknown，不重试、不回滚、不扫描目标猜成功。明确拒绝继续走原处理，linkat不机械改动。依据[POSIX rename](https://pubs.opengroup.org/onlinepubs/9799919799/functions/rename.html)的DESCRIPTION对EIO单独排除目的地不变保证；同页RETURN VALUE还有一般无变化表述，所以这里选择保守证据，不声称标准替代实际文件系统故障证明。[POSIX link](https://pubs.opengroup.org/onlinepubs/9699919799/functions/link.html)明确失败不新增链接，不能套用rename结论。

## 验证

7项[回归](../../../tests/namespace-io-uncertainty.test.ts)通过，22.56秒、无失败/取消/跳过：真实Git/HTTP/独立CLI覆盖移出文件EIO前/后、候选发布EIO前/后、两条EEXIST拒绝对照，以及原应用文件恢复遇移出后EIO。检查持久意图/材料状态、原inode/字节、独立写锁、清理拒绝与第二次独立CLI不重放，保留后来用户修改及原备份。

故障C替身只链接到每项测试自己的完整runtime副本；共享dist二进制与产品启动环境不改，无产品测试hook。最初替身编译漏了声明RENAME_NOREPLACE的stdio头，7项在进入产品故障路径前失败；补头后上述7项完整通过，未放宽断言。旧代码反证只在独立临时编译目录取回冻结faf7c036的两份C源，原7项中5项EIO分别在意图为空/状态误为failed处失败，2项EEXIST通过；同断言在修正源全部通过。完整本地npm run check通过1116/1116工程（157962.052347ms），零失败/取消/跳过，覆盖关联原语/恢复用例；类型、UI tokens、服务端/Web构建通过，原bundle警告保留。全仓格式/差异和238个文档相对链接目标核对通过。独立静态复核两C差异与完整故障替身/runtime/7项测试无阻断，复核者未独立执行测试。自身远端精确CI仍待完成。没有UI变化，不新增截图验收宣称。
