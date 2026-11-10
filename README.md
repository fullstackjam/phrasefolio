# Jam 的英语积累笔记本

单栏阅读页、Cloudflare Worker API 和 D1。浏览器输入访问令牌后解锁，令牌只保留在当前标签页的会话存储。条目和认识状态保存在 D1，换设备重新解锁后会读到同一份笔记。静态资源目录是 `public/`，CSV 和 SQL 迁移均在该目录之外。

[生产站点](https://notebook.fullstackjam.com)使用 Worker Secret `NOTEBOOK_API_TOKEN`。自定义域名由 `wrangler.jsonc` 的 Worker 路由管理。

## 本地运行

需要 Node.js 22 或更新版本。

GitHub 仓库只保存代码和数据库结构。本地需要原始条目时，把私人 CSV 放在项目根目录，命名为 `notebook.csv`，然后运行 `python3 scripts/seed.py` 生成 `migrations/0002_seed.sql`。这两个文件都由 Git 忽略。

```bash
npm ci
umask 077
printf 'NOTEBOOK_API_TOKEN=%s\n' "$(openssl rand -hex 32)" > .dev.vars
npm run dev
```

打开 [本地预览](http://localhost:8787)，输入 `.dev.vars` 里的令牌。启动脚本会将项目中的迁移应用到本地 D1。没有导入迁移时，本地笔记本从空库启动。

## Cloudflare 部署

首次部署前，在目标 Cloudflare 账号授权 Wrangler。若配置尚无真实 D1 ID，运行下列命令创建数据库，将输出的 `database_id` 填入 `wrangler.jsonc`，并核对 `account_id`。

要向新的 D1 导入原始条目，请在部署前生成私人导入迁移。部署到已有生产库时，可直接沿用已导入的数据。上线后的数据改动通过 API 或新增迁移完成。

```bash
npx wrangler login --use-keyring --scopes account:read user:read workers_scripts:write d1:write
npx wrangler d1 create jam-english-notebook
```

首次上线时，从密码管理器把生产访问令牌注入部署进程的 `NOTEBOOK_API_TOKEN`。推荐使用随机生成的 32 字节令牌。也可以在 zsh 中用隐藏输入临时提供令牌。

```zsh
read -rs "NOTEBOOK_API_TOKEN?Production notebook token: "
echo
NOTEBOOK_API_TOKEN="$NOTEBOOK_API_TOKEN" npm run deploy
unset NOTEBOOK_API_TOKEN
```

`npm run deploy` 会应用远程 D1 迁移并发布 Worker，命令输出包含 HTTPS 地址。后续部署直接运行 `npm run deploy` 即可沿用已配置的 Worker Secret。需要轮换时运行 `npx wrangler secret put NOTEBOOK_API_TOKEN` 并按提示输入新值。每台设备用同一个生产访问令牌解锁，API 调用也使用该值。 [Cloudflare Worker Secrets](https://developers.cloudflare.com/workers/configuration/secrets/)

## API

读写都需 `Authorization: Bearer <token>`，写请求另需 `Content-Type: application/json`。所有响应均为 JSON，错误格式为 `{"error":"说明"}`。

| 方法和路径 | 参数或请求体 |
|---|---|
| `GET /api/entries` | `q` 搜索表达、意思、场景、例句、原句。 `source` 为单个来源短码。 `known=true\|false`，省略时返回全部。 `sort=seen\|newest\|due`，默认 `seen`。 |
| `POST /api/entries/:id/known` | `{"known":true}` 标为已认识。 `{"known":false}` 撤销并清空 `known_at`。响应是更新后的条目。 |
| `POST /api/entries` | 创建或合并条目，响应是最终条目。 |

列表响应为 `{"entries":[…],"total":422,"count":80}`。 `total` 是数据库总数，`count` 是筛选后的总数。条目包含原有字段、`known`、`known_at` 和派生的 `source_codes`。 `known_at` 为带 `+08:00` 偏移的 ISO 时间，未标记时为 `null`。

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
