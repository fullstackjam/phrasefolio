# Jam 的英语积累笔记本

单栏阅读页、Cloudflare Worker API 和 D1。未登录的访问会转到 Cloudflare Access 登录页。浏览器不保存访问令牌，也不再提供令牌表单。条目和认识状态保存在 D1，换设备重新登录后会读到同一份笔记。静态资源目录是 `public/`，CSV 和 SQL 迁移均在该目录之外。

[生产站点](https://phrasefolio.fullstackjam.com)由 Worker `phrasefolio` 提供，自定义域名写在 `wrangler.jsonc`。

## 本地运行

需要 Node.js 22 或更新版本。

GitHub 仓库只保存代码和数据库结构。本地需要原始条目时，把私人 CSV 放在项目根目录，命名为 `notebook.csv`，然后运行 `python3 scripts/seed.py` 生成 `migrations/0002_seed.sql`。这两个文件都由 Git 忽略。

```bash
npm ci
npm test
npm run dev
```

`npm test` 不需要生产凭据。本地预览没有 Cloudflare Access 在前面，页面会要求 Access 登录，不能再用访问令牌打开。启动脚本会将项目中的迁移应用到本地 D1。没有导入迁移时，本地笔记本从空库启动。

## Cloudflare 部署

生产 Worker 名称为 `phrasefolio`，站点为 [phrasefolio.fullstackjam.com](https://phrasefolio.fullstackjam.com)。生产 D1 已经存在，库内有 422 条笔记。`wrangler.jsonc` 里的 `database_name` 是 `phrasefolio`，`database_id` 必须保持 `57449379-e549-4d5f-ae36-07f0707c0a27`。生产账号上禁止再次执行 `wrangler d1 create`，禁止新建数据库，也禁止把绑定改到其他或空的 `database_id`。配置中的名称只是标签；下次部署仍必须绑定这个已有库。

下面的创建命令只给一个还没有该库的新 Cloudflare 账号使用。生产账号已经创建过，跳过 `wrangler d1 create`。新账号需要先授权 Wrangler，再创建名为 `phrasefolio` 的数据库，把输出的 `database_id` 填入 `wrangler.jsonc`，并核对 `account_id`。

要向新的 D1 导入原始条目，请在部署前生成私人导入迁移。部署到已有生产库时，可直接沿用已导入的数据。上线后的数据改动通过 API 或新增迁移完成。

```bash
npx wrangler login --use-keyring --scopes account:read user:read workers_scripts:write d1:write
# 生产 D1 已存在（database_id 57449379-e549-4d5f-ae36-07f0707c0a27）。禁止在生产账号执行下一行。
npx wrangler d1 create phrasefolio
```

`npm run deploy` 会先检查 `ACCESS_AUD` 和 `ACCESS_SERVICE_CLIENT_ID`。两者缺一就会直接退出，不会改远程 D1，也不会发布 Worker。配置齐全后，它应用远程 D1 迁移并发布 Worker。不要把旧访问令牌注入这个命令。

## Cloudflare Access

人和机器都只使用 Cloudflare Access JWT。代码里没有访问令牌表单，没有 `sessionStorage` 令牌，也没有 `ACCESS_ENABLED=false` 的旧认证路径。`Authorization: Bearer` 和 `CF-Access-Client-Id` 头本身都不能通过认证。

JWT 必须是团队 `https://fullstackjam.cloudflareaccess.com` 用 RS256 签的，公钥只从 `https://fullstackjam.cloudflareaccess.com/cdn-cgi/access/certs` 读取。请求头、Cookie 和 Worker 变量都不能改签发方或 JWKS 地址。校验 `iss`、`aud`、`exp`、存在时的 `nbf`，以及 `type=app`。`Cf-Access-Authenticated-User-Email` 不作为身份。静态资源 Worker 拿不到 `ctx.access`，所以这里用 `jose` 自行校验。

只有 `https://phrasefolio.fullstackjam.com` 会返回笔记或页面。`phrasefolio.mazhenting44.workers.dev` 和预览主机名一律 401。人的 JWT 可以读笔记和标记认识。`POST /api/entries` 只接受服务令牌 JWT：`common_name` 必须等于 `ACCESS_SERVICE_CLIENT_ID`，`sub` 为空，且没有邮箱。收集机器向该主机名发送 `CF-Access-Client-Id` 和 `CF-Access-Client-Secret`，由 Access 换成短时 JWT；Worker 不读取 Client Secret，也不再要求旧 Bearer。

非秘密配置：

| 变量 | 含义 |
|---|---|
| `ACCESS_AUD` | 应用的 Application Audience，64 个十六进制字符 |
| `ACCESS_SERVICE_CLIENT_ID` | 专用服务令牌的 Client ID，形如 `<32 个十六进制字符>.access` |

人的 Allow 策略已经存在且尚未挂到应用：`a61aaba5-dfc9-4521-9b5c-05a31efed1fb`，决策 allow，包含一个邮箱，会话 `720h`。不要改成 Everyone，也不要动 Health 应用。

### 切到生产之前

当前线上仍是合并 #4 之前的旧 Worker，继续用旧 Bearer。这份代码还不能部署，因为 `vars` 仍是空的，部署脚本会拒绝。等专用服务令牌和 Access 应用都准备好后：

1. 创建只包含 `phrasefolio.fullstackjam.com` 的 Self-hosted 应用。挂上上面的 Allow 策略。另建一条 Service Auth 策略，只包含这枚服务令牌。打开 Strict service token authentication。不要设置 `read_service_tokens_from_header`。不要使用 Protect all Workers。
2. 应用会话也设为 `720h`。人的策略已经是 `720h`。若仍要减少一次性密码，再把团队全局会话调到 One month；那会影响团队上的其他 Access 应用。
3. 收集机器改为只发送两个 Access 头，目标是 `https://phrasefolio.fullstackjam.com`。确认 Access 已放行之后，再把 AUD 和 Client ID 写入 `wrangler.jsonc` 并运行 `npm run deploy`。
4. 确认没有令牌表单，退出走到 `/cdn-cgi/access/logout`，`workers.dev` 为 401，服务身份可以收录，人的身份收录返回 403。然后由主流程删除 1Password 里的旧登录项，并可以删除不再使用的 Worker Secret。

在第 3 步之前部署会让笔记和收录一起失败。回滚是继续保留当前线上的旧 Worker 版本，不是把某个开关拨回 Bearer。不要改 D1。

## API

浏览器请求靠 Access 注入并经 Worker 校验的 JWT。收集请求靠 Access 为服务令牌签发的 JWT。写请求另需 `Content-Type: application/json`。所有响应均为 JSON，错误格式为 `{"error":"说明"}`。已登录时 `GET /api/session` 返回 `{ "access": true, "principal": "human"|"service", "logout": "..." }`，不返回笔记、邮箱或令牌。

| 方法和路径 | 参数或请求体 |
|---|---|
| `GET /api/entries` | `q` 搜索表达、意思、场景、例句、原句。 `source_text` 按 `sources` 中的 `value` 匹配单个来源。 `source` 支持原有来源短码。 `known=true\|false`，省略时返回全部。 `sort=seen\|newest\|due`，默认 `seen`。 |
| `POST /api/entries/:id/known` | `{"known":true}` 标为已认识。 `{"known":false}` 撤销并清空 `known_at`。响应是更新后的条目。 |
| `POST /api/entries` | 创建或合并条目，响应是最终条目。 |

列表响应包含 `entries`、`total`、`count` 和 `sources`。 `total` 是数据库总数，`count` 是筛选后的总数。 `sources` 包含全库去重后的非空来源，每项提供筛选值 `value` 和显示标题 `title`。条目包含原有字段、`known`、`known_at` 和派生的 `source_codes`。 `known_at` 为带 `+08:00` 偏移的 ISO 时间，未标记时为 `null`。

新增条目 JSON 示例。

```json
{
  "expression": "follow through",
  "original_sentence": "We need to follow through on the plan.",
  "meaning_zh": "把事情做到底",
  "usage_note": "常接 on，后面可跟计划或承诺。",
  "example": "I'll follow through on the migration plan.",
  "source": "",
  "added_date": "2026-11-10",
  "interval_days": 1,
  "next_review": "2026-11-11",
  "ease": 2.5,
  "review_count": 0,
  "seen_count": 1,
  "scene_zh": "跟进工作中的迁移计划。"
}
```

仅 `expression` 必填，`id` 省略时自动分配。 `added_date` 默认取上海当天，未提供复习日期的条目在到期排序中排在末尾。表达按去掉首尾空白并忽略大小写匹配。重复表达保留原 ID、原有非空文本、复习字段及认识状态，补齐空白文本，追加未出现过的来源片段，并将原 `seen_count` 加 1。不同表达复用已有 ID 会返回 409。
