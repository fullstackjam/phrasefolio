import { sourceCodes, sourceOptions } from '../public/sources.js';

const textFields = [
  'original_sentence', 'meaning_zh', 'usage_note', 'example', 'scene_zh',
];
const searchFields = ['expression', 'meaning_zh', 'scene_zh', 'example', 'original_sentence'];
const numberFields = { interval_days: 1, ease: 2.5, review_count: 0, seen_count: 1 };

export class RequestError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function shanghaiTimestamp() {
  const time = new Intl.DateTimeFormat('sv-SE', {
    timeZone: 'Asia/Shanghai', dateStyle: 'short', timeStyle: 'medium',
  }).format(new Date());
  return time.replace(' ', 'T') + '+08:00';
}

function readDate(value, key, fallback) {
  if (value === undefined) return fallback;
  if (key === 'next_review' && value === '') return value;
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    throw new RequestError(400, key + ' 必须为 YYYY-MM-DD');
  }
  const date = new Date(value);
  if (!Number.isFinite(+date) || date.toISOString().slice(0, 10) !== value) {
    throw new RequestError(400, key + ' 日期无效');
  }
  return value;
}

export async function readJSON(request) {
  if (request.headers.get('Content-Type')?.split(';')[0].trim() !== 'application/json') {
    throw new RequestError(415, '需要 application/json');
  }

  const chunks = [];
  let size = 0;
  for await (const chunk of request.body ?? []) {
    size += chunk.byteLength;
    if (size > 64 * 1024) throw new RequestError(413, '请求内容过长');
    chunks.push(chunk);
  }
  let data;
  try {
    data = JSON.parse(await new Blob(chunks).text());
  } catch {
    throw new RequestError(400, 'JSON 格式有误');
  }
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    throw new RequestError(400, '需要 JSON 对象');
  }
  return data;
}

function serialize(row) {
  const { expression_key, ...entry } = row;
  return { ...entry, known: Boolean(entry.known), source_codes: sourceCodes(entry.source) };
}

const orders = {
  seen: 'seen_count DESC, added_date DESC, id DESC',
  newest: 'added_date DESC, id DESC',
  due: "(next_review = '') ASC, next_review ASC, id ASC",
};

export async function listEntries(db, params) {
  const query = (params.get('q') ?? '').trim().toLowerCase();
  const source = (params.get('source') ?? '').trim().toUpperCase();
  const known = params.get('known');
  const sort = params.get('sort') ?? 'seen';
  if (!Object.hasOwn(orders, sort)) throw new RequestError(400, '排序方式无效');
  if (known !== null && !['true', 'false'].includes(known)) {
    throw new RequestError(400, 'known 必须为 true 或 false');
  }
  if (source && !sourceOptions.some(({ code }) => code === source)) {
    throw new RequestError(400, '来源短码无效');
  }

  const { results } = await db.prepare('SELECT * FROM entries ORDER BY ' + orders[sort]).all();
  const entries = results.map(serialize).filter((entry) =>
    (known === null || entry.known === (known === 'true')) &&
    (!source || entry.source_codes.includes(source)) &&
    (!query || searchFields.some((field) => entry[field].toLowerCase().includes(query)))
  );
  return { entries, total: results.length, count: entries.length };
}

export async function setKnown(db, id, known) {
  if (!Number.isSafeInteger(id) || id < 1 || typeof known !== 'boolean') {
    throw new RequestError(400, '需要有效 ID 和布尔值 known');
  }
  const entry = await db.prepare(
    'UPDATE entries SET known = ?, known_at = CASE WHEN ? = 1 THEN coalesce(known_at, ?) ELSE NULL END WHERE id = ? RETURNING *'
  ).bind(Number(known), Number(known), shanghaiTimestamp(), id).first();
  if (!entry) throw new RequestError(404, '未找到该条目');
  return serialize(entry);
}

export async function saveEntry(db, data) {
  const { id = null, expression } = data;
  if (typeof expression !== 'string' || !expression.trim()) {
    throw new RequestError(400, 'expression 不能为空');
  }
  if (id !== null && (!Number.isSafeInteger(id) || id < 1)) {
    throw new RequestError(400, 'id 必须为正整数');
  }
  const record = { id, expression, expression_key: expression.trim().toLowerCase() };
  for (const key of [...textFields, 'source']) {
    if (data[key] !== undefined && typeof data[key] !== 'string') {
      throw new RequestError(400, key + ' 必须为文本');
    }
    record[key] = data[key] ?? '';
  }
  record.added_date = readDate(data.added_date, 'added_date', shanghaiTimestamp().slice(0, 10));
  record.next_review = readDate(data.next_review, 'next_review', '');
  for (const [key, fallback] of Object.entries(numberFields)) {
    const value = data[key] ?? fallback;
    const valid = key === 'ease'
      ? Number.isFinite(value) && value > 0
      : Number.isSafeInteger(value) && value >= (key === 'seen_count' ? 1 : 0);
    if (!valid) throw new RequestError(400, key + ' 数值无效');
    record[key] = value;
  }

  const columns = Object.keys(record);
  const fillBlanks = textFields.map((key) =>
    key + " = coalesce(nullif(entries." + key + ", ''), excluded." + key + ')'
  ).join(', ');
  const sourceParts = [...new Set(record.source.split(' | ').filter(Boolean))];
  // Append only new source fragments and keep the original source text intact.
  const upsert = `
    INSERT INTO entries (${columns.join(', ')})
    VALUES (${columns.map(() => '?').join(', ')})
    ON CONFLICT(expression_key) DO UPDATE SET
      seen_count = entries.seen_count + 1,
      ${fillBlanks},
      source = coalesce((
        SELECT coalesce(nullif(entries.source, '') || ' | ', '') || group_concat(value, ' | ')
        FROM json_each(?)
        WHERE instr(' | ' || entries.source || ' | ', ' | ' || value || ' | ') = 0
      ), entries.source)
    RETURNING *
  `;
  const entry = await db.prepare(upsert).bind(...Object.values(record), JSON.stringify(sourceParts)).first()
    .catch((error) => {
      if (String(error).includes('UNIQUE constraint failed: entries.id')) {
        throw new RequestError(409, '此 ID 已用于另一个表达');
      }
      throw error;
    });
  return serialize(entry);
}
