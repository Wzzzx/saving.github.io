# Savin 数据库与同步

项目：`wvigvjmsjmyomizltahd`。所有业务表位于 `savin` schema。

## 云端结构

| 表 | 存放内容 |
| --- | --- |
| `book_state` | 用户版本、上次付款方式、升级状态、更新时间 |
| `entries` | 每笔账目一行：整数分金额、业务时间、付款方式、标签数组、备注、补记来源 |
| `tags` | 每个标签一行，包含名称和启用状态 |
| `payments` | 每个付款方式一行，包含名称和启用状态 |
| `rules` | 每条固定支出一行，版本历史保存在该行的 `versions` JSONB 中 |
| `processed` | 每个已补记标记一行，删除账目不删除该标记 |
| `ledgers` | 升级前的完整账本，兼容来源和迁移备份 |

业务表以 `(user_id, id)` 为主键，`book_state` 以 `user_id` 为主键。用户外键引用 Auth，删除用户会级联清理。身份序列 `position` 保持原数组顺序；编辑不改变顺序，删除一笔不更新其他行。账目有 `(user_id, time desc)` 索引。历史付款方式、标签引用不设级联删除关系，避免配置删除影响历史。

本地业务结构和导出格式保持 `version: 1`，包括 `tags/payments/entries/rules/processed/lastPayment`。时间仍是本地时间字符串，不转换时区；金额为整数分。

付款方式通过 `payments_user_name_key UNIQUE (user_id, name)` 保证同一账号名称唯一，包含停用项；不同账号允许同名。现有重名已合并后执行 [payments-unique-name.sql](payments-unique-name.sql)，远端迁移名 `payments_unique_name_per_user`。名称按数据库原始文本精确比较。

## 同步协议

- `read_book()` 在一个 SQL 查询快照中组装完整本地 JSON 与版本，返回单个 JSON 对象，避免 REST 列表默认行数限制导致截断。下载目前仍是完整账本。
- `apply_changes(p_base, p_revision, p_changes)` 仅接收变化集合：`upsert` 为新增/修改行，`remove` 为删除 ID，付款偏好变化单独传递。未变记录不上传、不重写。
- 更新先锁定该用户的版本行，校验基础版本，在同一事务中提交全部变化。补记账目和处理标记一起成功或一起回滚。
- 已提交版本重试直接返回确认；基础版本过旧返回 409，不覆盖云端。仍按单人单设备设计，**不自动合并多设备冲突**。
- 首次升级没有同步基线时，先读取云端作为基线，再同步本地账本的差异。首次升级应在原来记账的设备上完成。

## 本地缓存与断网恢复

- 未登录沿用 `saving.v1`；登录后沿用 `saving.cache:<project URL>:<user ID>`，`saving.active` 指向当前账号。原始 `saving.v1` 留作备份。
- 每次修改把完整业务 JSON 和 `_sync: {dirty, revision}` 一次写入 LocalStorage，再后台同步。失败仍可继续本地记账；只有确认成功才清除匹配版本的标记。
- `saving.sync.v2:<project URL>:<user ID>` 额外保存最近确认的基线，以及发送前持久化的待确认请求和快照。按项目和用户隔离，不进入导出。这会额外占用本地空间，写满时不冒充上传成功。
- 请求提交但响应丢失时，刷新仍会先重放原请求，确认后再提交后续修改，不丢弃待确认请求。
- 重试时机：打开页面、网络恢复、下一次修改、重新登录，以及手动“重试同步”。不会无限循环。
- 无本地修改时启动读取云端；下载期间出现本地修改，以本地修改为准。无缓存且云端读取失败时禁止用空数据覆盖云端。
- 退出登录保留缓存和待上传请求。冲突时先导出本地备份，再人工核对；普通重试不会跳过版本校验。目前没有自动冲突处理界面。
- 无 Service Worker：已打开的页面可离线记账，断网后重新打开网页不保证能加载。

## 权限

### 个人 API Key

[personal-api-keys.sql](personal-api-keys.sql) 增加了个人密钥访问。密钥由密码学安全随机源生成（256 位随机数），前缀为 `savin_key_`，不是 Supabase 公开 Publishable key。

`savin_private.api_keys` 只保存 SHA-256 摘要、所属用户、标识、有效期和撤销时间，私有 schema 不暴露到 Data API。默认有效期一年。明文只交付给用户，不写入版本库；浏览器使用时保存在该项目的本地会话中，不进入账本导出。

请求 `POST /rest/v1/rpc/key_access`，使用公开 `apikey` 和 `Content-Profile: savin`，个人密钥放入 `X-Savin-Key` 请求头。请求体为 `{ "p_action": "profile|read_book|apply_changes", "p_args": {} }`。写入参数与原增量接口一致，仍有版本校验和原子事务。密钥不能指定其他账号、操作其他 schema 或修改账号密码。

公开入口是 SECURITY INVOKER；私有鉴权函数由无登录、无 BYPASSRLS 的 `savin_key_gateway` 角色持有，校验密钥后才临时设置该账号身份，调用完恢复身份。该角色继承标准 authenticated 权限，以访问 Supabase 管理的 auth schema，业务表继续使用 RLS。普通用户不能读取摘要表或切换成此角色。无密钥、已过期或已撤销均返回 401。

管理员撤销指定密钥：`update savin_private.api_keys set revoked_at = now() where id = '<key-id>';`。退出网页只清除本浏览器凭据，不撤销其他设备正在使用的同一密钥。

[verify-personal-api-keys.sql](verify-personal-api-keys.sql) 在回滚事务内验证读写、身份伪造防护、无密钥拒绝及撤销。前端测试：`node --test tests/api-key.test.js`。该 SQL 使用当前测试账号和 23 笔账目断言，账目变化后需调整断言。

### 邮箱密码登录

所有新表启用 RLS，SELECT/INSERT/UPDATE/DELETE 限定 `(select auth.uid()) = user_id`，UPDATE 同时校验新旧归属。匿名没有访问权。RPC 使用 SECURITY INVOKER 和空 search_path，通过调用者权限及 RLS 执行，不能指定其他用户。

前端仅使用公开 Publishable key 和用户令牌。密码不落盘，令牌不进入导出。本次不修改其他 schema 或全局 Data API 暴露配置。原项目通过 authenticator 的 pgrst.db_schemas 配置暴露 savin，该配置覆盖控制台的 Exposed schemas，后续修改应保留 public、graphql_public、savin。

## 迁移与兼容

初始定义：[savin.sql](savin.sql)。增量升级：[incremental.sql](incremental.sql)，远端迁移名 `normalize_savin_incremental_storage`。脚本按顺序各运行一次，不重复执行。

升级在一个事务中创建表、迁移所有账号并安装兼容触发器，不删除旧 ledgers。完整 JSON 比对一致：23 笔、78,022 分，8 个标签、12 个付款方式、2 条固定支出（含停用配置）。

新前端发布前，旧前端仍可写入 ledgers，触发器同步至新表。该账号首次通过新 RPC 写入后，v2_started 变为 true，旧接口写入会提示刷新，避免全量覆盖。ledgers 此后是历史备份，不代表最新数据；查询最新数据应使用新表或 read_book()。

前端发布至 GitHub Pages 后，在原设备刷新使用。不能只回退前端至旧版而继续写入已升级账号。迁移不自动删除备份。

## 验证

```text
node --test tests/core.test.js tests/storage.test.js tests/incremental.test.js tests/browser.test.js
node --check core.js
node --check app.js
node --check storage.js
node --check supabase.js
```

[verify-incremental.sql](verify-incremental.sql) 使用管理员连接，检查迁移相等、原子更新、幂等重试、版本冲突、旧接口保护和 RLS，最后回滚所有账本变化。适用于尚未通过 v2 写入且至少有一笔账目的迁移验证账号。

tests/cloud-smoke.js 会写入数据，仅限专门创建的可丢弃账号；凭据通过环境变量 SAVIN_TEST_EMAIL/SAVIN_TEST_PASSWORD 提供，不得对真实账本运行。

迁移后安全检查未报告新增表的 RLS 问题；项目另有“密码泄露检测未开启”告警，本次未调整 Auth 设置，参见 [密码保护配置](https://supabase.com/docs/guides/auth/password-security#password-strength-and-leaked-password-protection)。

参考：[数据库函数](https://supabase.com/docs/guides/database/functions)、[RLS](https://supabase.com/docs/guides/database/postgres/row-level-security)。
