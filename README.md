# Jam 的英语积累笔记本

单栏阅读页、Cloudflare Worker API 和 D1。默认仍由浏览器输入访问令牌后解锁，令牌只保留在当前标签页的会话存储。启用 Cloudflare Access 后，未登录的访问会转到 Cloudflare 登录页，浏览器不再询问访问令牌。条目和认识状态保存在 D1，换设备重新登录后会读到同一份笔记。静态资源目录是 `public/`，CSV 和 SQL 迁移均在该目录之外。

[生产站点](https://phrasefolio.fullstackjam.com)使用 Worker Secret `PHRASEFOLIO_API_TOKEN`。自定义域名由 `wrangler.jsonc` 的 Worker 路由管理，Worker 名称为 `phrasefolio`。

## 本地运行

需要 Node.js 22 或更新版本。

GitHub 仓库只保存代码和数据库结构。本地需要原始条目时，把私人 CSV 放在项目根目录，命名为 `notebook.csv`，然后运行 `python3 scripts/seed.py` 生成 `migrations/0002_seed.sql`。这两个文件都由 Git 忽略。

```bash
npm ci
umask 077
printf 'PHRASEFOLIO_API_TOKEN=%s\n' "$(openssl rand -hex 32)" > .dev.vars
npm run dev
```

打开 [本地预览](http://localhost:8787)，输入 `.dev.vars` 里的令牌。启动脚本会将项目中的迁移应用到本地 D1。没有导入迁移时，本地笔记本从空库启动。

## Cloudflare 部署

生产 Worker 名称为 `phrasefolio`，站点为 [phrasefolio.fullstackjam.com](https://phrasefolio.fullstackjam.com)。生产 D1 已经存在，库内有 422 条笔记。`wrangler.jsonc` 里的 `database_name` 是 `phrasefolio`，`database_id` 必须保持 `57449379-e549-4d5f-ae36-07f0707c0a27`。生产账号上禁止再次执行 `wrangler d1 create`，禁止新建数据库，也禁止把绑定改到其他或空的 `database_id`。配置中的名称只是标签；下次部署仍必须绑定这个已有库。

下面的创建命令只给一个还没有该库的新 Cloudflare 账号使用。生产账号已经创建过，跳过 `wrangler d1 create`。新账号需要先授权 Wrangler，再创建名为 `phrasefolio` 的数据库，把输出的 `database_id` 填入 `wrangler.jsonc`，并核对 `account_id`。

要向新的 D1 导入原始条目，请在部署前生成私人导入迁移。部署到已有生产库时，可直接沿用已导入的数据。上线后的数据改动通过 API 或新增迁移完成。

```bash
npx wrangler login --use-keyring --scopes account:read user:read workers_scripts:write d1:write
# 生产 D1 已存在（database_id 57449379-e549-4d5f-ae36-07f0707c0a27）。禁止在生产账号执行下一行。
npx wrangler d1 create phrasefolio
```

首次上线时，从密码管理器把生产访问令牌注入部署进程的 `PHRASEFOLIO_API_TOKEN`。推荐使用随机生成的 32 字节令牌。也可以在 zsh 中用隐藏输入临时提供令牌。

```zsh
read -rs "PHRASEFOLIO_API_TOKEN?Production notebook token: "
echo
PHRASEFOLIO_API_TOKEN="$PHRASEFOLIO_API_TOKEN" npm run deploy
unset PHRASEFOLIO_API_TOKEN
```

`npm run deploy` 会应用远程 D1 迁移并发布 Worker，命令输出包含 HTTPS 地址。后续部署直接运行 `npm run deploy` 即可沿用已配置的 Worker Secret。需要轮换时运行 `npx wrangler secret put PHRASEFOLIO_API_TOKEN` 并按提示输入新值。Access 尚未启用时，每台设备用同一个生产访问令牌解锁，API 调用也使用该值。 [Cloudflare Worker Secrets](https://developers.cloudflare.com/workers/configuration/secrets/)

## Cloudflare Access

仓库里的 `ACCESS_ENABLED` 默认为 `false`。这个状态下行为与现在的线上一致：API 仍要求 `Authorization: Bearer`，静态页面仍可打开，浏览器仍显示访问令牌表单。不要在 Access 应用生效之前把 `ACCESS_ENABLED` 改成 `true`，否则 Worker 会拒绝所有没有有效 Access JWT 的请求，站点会锁住。这是关闭失败，不是临时放开。

JWT 只接受团队 `https://fullstackjam.cloudflareaccess.com` 的 RS256 签名，公钥只从 `https://fullstackjam.cloudflareaccess.com/cdn-cgi/access/certs` 读取。请求头、Cookie 和 Worker 变量都不能改签发方或 JWKS 地址。`Cf-Access-Authenticated-User-Email` 不作为身份。应用是否放行某人，由协调人创建的 Access 策略决定；Worker 再用应用 AUD 确认这枚 JWT 是发给 Phrasefolio 的。静态资源 Worker 拿不到 `ctx.access`，所以这里用 `jose` 自行校验 JWT。

启用后只有 `https://phrasefolio.fullstackjam.com` 会返回笔记或页面。`phrasefolio.mazhenting44.workers.dev` 和预览主机名即使带上原来的 Bearer，或带上一枚签名正确的 JWT，也返回 401。浏览器登录后不再发送 Bearer。收集接口 `POST /api/entries` 只接受机器身份：Access 服务令牌 JWT 的 `common_name` 必须等于 `ACCESS_SERVICE_CLIENT_ID`，并且请求仍带原来的 Bearer。人的 Access 身份可以读笔记和标记认识，不能调用收集接口。服务令牌不要改成从 `Authorization` 头读取，那个头继续给现有的 `PHRASEFOLIO_API_TOKEN` / 机器人的 `NOTEBOOK_API_TOKEN`。

非秘密配置写在 `wrangler.jsonc` 的 `vars`。`npm run deploy` 会用文件里的值覆盖线上同名变量，所以启用和回滚都以提交里的这三个值为准，不要只在控制台里改：

| 变量 | 启用前 | 启用后 |
|---|---|---|
| `ACCESS_ENABLED` | `false` | `true` |
| `ACCESS_AUD` | 空 | 应用的 Application Audience (AUD)，64 个十六进制字符 |
| `ACCESS_SERVICE_CLIENT_ID` | 空 | 服务令牌的 Client ID，形如 `<32 个十六进制字符>.access` |

`PHRASEFOLIO_API_TOKEN` 继续只作为 Worker Secret。不要把它写进变量、仓库、浏览器脚本或响应。

### 启用顺序

1. 合并并部署本变更，且三个变量保持默认。确认网站仍是令牌登录，D1 绑定仍是 `57449379-e549-4d5f-ae36-07f0707c0a27`。不要新建数据库。
2. 协调人创建服务令牌，把 Client Secret 放进密码管理器。给收集机器增加 `CF_ACCESS_CLIENT_ID` 和 `CF_ACCESS_CLIENT_SECRET`，保留现有 `NOTEBOOK_API_TOKEN`。机器每次请求 `https://phrasefolio.fullstackjam.com` 时同时发送 `CF-Access-Client-Id`、`CF-Access-Client-Secret` 和 `Authorization: Bearer`。此时 Access 应用还不存在，多出来的头会被忽略，收集应照常成功。
3. 在 Zero Trust 创建 **Self-hosted** Access 应用，公共主机名只填 `phrasefolio.fullstackjam.com`。不要使用 Protect all Workers，也不要把账户里的其他主机名加进这个应用。身份提供商用现有的一次性密码。人的策略用 Allow，并且只包含明确的邮箱；不要用 Everyone。机器另建一条 Service Auth 策略（API 里的 `non_identity`），Include 这一枚服务令牌。打开 Strict service token authentication。不要设置 `read_service_tokens_from_header`，尤其不要设成 `Authorization`。
4. 把下面三处会话时长都设成 **One month**。只改应用会话不够：全局会话的文档默认值是 24 小时，过期后才会再次要求一次性密码。全局会话作用于整个 Zero Trust 团队，这个账户上的其他 Access 应用也会一起变长。应用会话和这条 Allow 策略的会话时长也设成 One month。用 API 时，`session_duration` 使用 `720h`；若接口拒绝，再改用控制台里的 One month，并记下实际接受的值。
5. 用浏览器完成一次登录，确认令牌表单仍在，而且收集机器带着新头和原来的 Bearer 仍能写入。然后把 AUD 和 Client ID 写入 `vars`，把 `ACCESS_ENABLED` 设为 `true`，再部署这一份配置。
6. 确认浏览器不再出现令牌表单，退出会打开 `/cdn-cgi/access/logout`，`workers.dev` 返回 401，收集机器仍然成功，人的身份调用 `POST /api/entries` 得到 403。

### 回滚

1. 先把 `ACCESS_ENABLED` 改回 `false` 并部署。Bearer 立即重新生效。Access 应用可以暂时留着，人需要先过 Access 再输入令牌，机器继续发送服务令牌头和 Bearer。
2. 确认笔记和收集都恢复后，再按需要删除 Phrasefolio 的 Access 应用。不要在 `ACCESS_ENABLED=true` 时删除应用或清空 `ACCESS_AUD`，那样 Worker 会拒绝请求。
3. 不需要改 D1、绑定或令牌 Secret。回滚不是删除数据。

本地 `npm test` 不读取生产 Secret。本地预览保持 `ACCESS_ENABLED=false`，继续使用 `.dev.vars` 里的令牌。

## API

Access 未启用时，读写都需 `Authorization: Bearer <token>`。Access 启用后，浏览器只靠已校验的 Access JWT，不再发送 Bearer；`POST /api/entries` 仍要机器服务令牌 JWT 加上原来的 Bearer。写请求另需 `Content-Type: application/json`。所有响应均为 JSON，错误格式为 `{"error":"说明"}`。`GET /api/session` 只返回 `{ "access": true|false }` 以及启用后的 `principal` 和 `logout`，不返回笔记、邮箱或令牌。

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
