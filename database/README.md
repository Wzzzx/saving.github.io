# Savin 数据库与同步

## 当前部署

- 项目：`wvigvjmsjmyomizltahd`，URL：`https://wvigvjmsjmyomizltahd.supabase.co`。
- 独立 schema：`savin`。建表定义见 [savin.sql](savin.sql)，已通过远端迁移 `create_savin_ledger` 部署。
- 原有公开 schema `public, graphql_public` 保留。为当前 MCP 可用的部署方式，使用 `ALTER ROLE authenticator SET pgrst.db_schemas = 'public, graphql_public, savin'` 暴露 API。
- **此角色配置会覆盖控制台的 Exposed schemas 配置。** 后续新增 schema 需保留完整列表后修改此设置并通知 PostgREST 重载；若要恢复控制台管理，先在控制台加入 `savin`，再执行 `ALTER ROLE authenticator RESET pgrst.db_schemas; NOTIFY pgrst, 'reload config';`。
- SQL 为首次建表脚本，不重复执行。迁往其他项目时先核实该项目的 Exposed schemas，调整最后的列表，不覆盖其原有配置。

## 表结构与权限

`savin.ledgers` 每个 Auth 用户一行：

| 字段 | 类型 | 用途 |
| --- | --- | --- |
| user_id | UUID 主键、Auth 用户外键 | 账本归属；删除 Auth 用户会级联删除账本 |
| payload | JSONB，非空 | 完整 v1 账本 |
| revision | UUID，非空 | 本次本地修改的标识，确认上传的是哪个版本 |
| updated_at | timestamptz | 数据库触发器生成的写入时间 |

`payload` 包含 `version`、`tags`、`payments`、`entries`、`rules`、`processed`、`lastPayment`，保留记录的备注、规则历史、停用标记等字段。金额仍为整数分，业务日期时间格式不变。数据库约束校验版本和主要数组类型，前端继续执行原有业务校验。

仅 `authenticated` 获得 schema 使用权和表 SELECT / INSERT / UPDATE 权限。三条 RLS 策略均检查 `auth.uid() = user_id`，UPDATE 同时检查更新前后归属。匿名不能访问，无客户端删除整本账本权限；业务删除通过更新 payload 实现。触发器采用 SECURITY INVOKER、空 search_path，不提供公开可调用的特权函数。

## 首次使用

1. 在当前项目控制台 Authentication → Users → Add user 创建自己的邮箱密码用户并确认邮箱；网页只提供登录，不发送注册邮件。
2. 在**存有旧账本的同一浏览器和网站地址**打开网页，进入设置 → 云端保存。已预填项目 URL 和公开 Publishable key，通常无需修改。
3. 登录后自动将旧账本上传。页头和设置页显示“已同步”后，云端已有完整副本。

公开 key 可以出现在页面源码中，权限由登录令牌和 RLS 控制。不要在页面填写 secret、service_role 或数据库密码。登录密码不落盘；会话令牌与连接配置保存在本机，不进入账本导出。

## 本地数据和同步规则

- 未登录时沿用 `saving.v1`，额外 `_sync` 字段与账本一次写入，记录 `dirty` 和 `revision`；导出时去除该内部字段。
- 首次登录将旧账本复制至 `saving.cache:<project URL>:<user ID>`，设置 `saving.active` 指向该账号缓存。原始 `saving.v1` 留作迁移备份，不再作为活动账本或反复上传。
- 每次修改先成功写入本地，再异步上传整个 payload。失败保留待上传状态；成功只清除匹配版本的标记，缓存仍保留。
- 一个上传请求进行中时，新修改写入本地；请求结束后继续上传最新版本。相同用户的 upsert 更新同一行，重试不会追加重复账目。
- 启动时优先上传待上传账本；本地无修改时读取云端。下载期间产生本地修改，不以下载结果覆盖它。有缓存时可立即继续记账。
- 本地和云端均无账本时才创建默认数据。云端读取失败且没有缓存时禁止保存，避免空账本覆盖云端。
- 自动重试触发点：打开网页、恢复网络、下一次修改、重新登录；设置中也可手动重试。不会无限循环请求。
- 退出登录保留所属账号缓存，仍可在本机记账；重新登录该账号后同步。切换项目或账号会使用各自缓存，不上传原账号数据到新账号。
- 单设备约定：本地待上传账本优先，完整覆盖该账号云端版本。不支持并行多设备合并；不要在多台设备离线修改同一账号账本。
- 无 Service Worker，已打开的网页可断网记账，断网后重新打开网页不保证可用。

## 失败恢复与验证

看到“待上传”或“同步未完成”时不要清理网站数据。可先复制全部数据备份，再检查网络或重新登录并重试。LocalStorage 写入失败会保留表单输入；数据格式异常保留原始内容用于复制备份。

测试命令：

```text
node --test tests/core.test.js tests/storage.test.js tests/browser.test.js
node --check core.js
node --check app.js
node --check storage.js
node --check supabase.js
```

`tests/cloud-smoke.js` 是显式执行的真实云端测试，需用可丢弃测试用户，通过环境变量 `SAVIN_TEST_EMAIL` 和 `SAVIN_TEST_PASSWORD` 提供凭据。脚本会写测试账本并退出登录，不自动删除 Auth 用户；测试后在控制台删除测试用户以级联清理账本。不要使用个人真实账号运行。

本次部署已验证真实 Auth 登录及刷新、REST 读写和重复上传、匿名拒绝、跨账号拒绝、数据库 RLS 读写隔离。临时测试用户和账本已删除。安全检查无告警。

参考：[自定义 schema](https://supabase.com/docs/guides/api/using-custom-schemas)、[RLS](https://supabase.com/docs/guides/database/postgres/row-level-security)。
