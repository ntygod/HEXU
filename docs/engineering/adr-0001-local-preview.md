# ADR-0001｜E0 本地开发预览的实现边界

日期：2026-09-25。状态：本轮工程采用。关联：HX-DEV-01、02、04、07、10、14、15 的初始切片。不是最终生产架构决议。

## 采用

采用 React + Vite、TypeScript、Fastify、npm workspaces；公共 DTO、输入解析、领域规则、存储、UI 和模拟器分别组织。npm 是当前唯一包管理器，不同时维护 pnpm 锁文件。

E0 使用 Node 内置 SQLite 保持真实持久化，但不要求先安装数据库服务。业务写入、完成记录、幂等记录和 outbox 在同一事务里。SQLite 当前仅面向单进程、单示例身份的开发预览；正式服务仍需 PostgreSQL、成熟身份组件及完整授权。

这个取舍是先让“任务—讨论—成果”的代码流程可运行，而不是永久改成个人工具。Task/Run/Result 边界可保留；JSON 数据列与全量工作台查询不能按正式高并发实现使用。迁移到 PostgreSQL 需要真正的 schema、异步 repository 和数据转换，不能宣称换一条连接串即可。

## 当前刻意不做

不伪造登录、邀请、执行器配对或原生模型成功。只暴露 loopback，本地 Host/Origin 和写请求标识检查降低浏览器误访问风险，但它们不是多人身份系统。不提供通过配置切换到不安全公网模式的便捷开关。

Claude Code/Codex 名称仅出现在明确标记的模拟配置中。mock 不执行 shell、不读取项目目录、不调用外部服务、不填写费用。模拟状态用于开发执行生命周期；不能据此把 08/09 原生适配计划标记完成。

## 版本与依据

主要包版本写入 package.json，传递依赖由 package-lock.json 锁定。Node 推荐 24，当前最低代码运行条件为 22.16。Node 22 的 sqlite 可能打印实验性提示，不意味着报错。

- [Vite Getting Started](https://vite.dev/guide/)：Node 和构建使用要求。
- [Fastify v5.12.5](https://github.com/fastify/fastify/releases/tag/v5.12.5)：选用已发布的 5.x 安全修复版本。
- [Vite v8.3.1](https://github.com/vitejs/vite/releases/tag/v8.3.1)：本次锁定版本来源。
- [Node SQLite API](https://nodejs.org/api/sqlite.html)：本地存储 API。

依赖版本不等于未来永远安全，后续升级仍需维护。没有因为当前环境无法访问 npm 就改变正式产品需求；完整依赖安装和浏览器流程交由仓库 CI 执行，本地已经实际执行独立的领域与存储测试。
