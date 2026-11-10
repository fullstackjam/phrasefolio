import { sourceOptions } from './sources.js';
import { speakExpression } from './speech.js';

const $ = (id) => document.getElementById(id);
const search = $('search');
const source = $('source');
const sort = $('sort');
const hideKnown = $('hide-known');
const list = $('entries');
const template = $('entry-template');
const loginForm = $('login-form');
const loginInput = $('token');
const PAGE_SIZE = 24;
const TOKEN_KEY = 'jam-notebook-access';
const markRequests = new Map();
let token = sessionStorage.getItem(TOKEN_KEY) ?? '';
let loaded;
let listRequest;
let searchTimer;
let noticeTimer;
let undoEntry;
let limit = PAGE_SIZE;

for (const { code, title } of sourceOptions) {
  source.add(new Option(code + ' · ' + title, code));
}

async function api(path, { data, signal } = {}) {
  const headers = { Authorization: 'Bearer ' + token };
  if (data !== undefined) headers['Content-Type'] = 'application/json';
  const response = await fetch('/api' + path, {
    headers,
    signal,
    method: data === undefined ? 'GET' : 'POST',
    body: data === undefined ? undefined : JSON.stringify(data),
  });
  const result = await response.json();
  if (!response.ok) {
    const error = new Error(result.error);
    error.status = response.status;
    throw error;
  }
  return result;
}

function lock(message = '') {
  token = '';
  sessionStorage.removeItem(TOKEN_KEY);
  listRequest?.abort();
  clearTimeout(searchTimer);
  clearTimeout(noticeTimer);
  markRequests.clear();
  undoEntry = undefined;
  loaded = undefined;
  list.replaceChildren();
  $('notebook').hidden = true;
  $('lock').hidden = true;
  $('notice').hidden = true;
  $('login').hidden = false;
  $('login-error').textContent = message;
  $('login-error').hidden = !message;
  loginInput.focus();
}

function addLinks(element, text) {
  let cursor = 0;
  for (const match of text.matchAll(/https?:\/\/[^\s<>"“”]+/gu)) {
    const url = match[0].replace(/[),.;!?\]，。；！？]+$/u, '');
    element.append(text.slice(cursor, match.index));
    const link = document.createElement('a');
    link.href = url;
    link.textContent = url;
    link.target = '_blank';
    link.rel = 'noopener noreferrer';
    element.append(link);
    cursor = match.index + url.length;
  }
  element.append(text.slice(cursor));
}

function renderEntry(entry) {
  const card = template.content.firstElementChild.cloneNode(true);
  card.querySelector('h2').textContent = entry.expression;
  card.querySelector('.speech').addEventListener('click', () => speakExpression(entry.expression));
  const badge = card.querySelector('.frequency');
  if (entry.seen_count > 1) {
    badge.hidden = false;
    badge.textContent = '出现 ' + entry.seen_count + ' 次';
  }
  const scene = card.querySelector('.scene');
  scene.hidden = !entry.scene_zh;
  scene.querySelector('p').textContent = entry.scene_zh;
  for (const field of card.querySelectorAll('[data-field]')) {
    const text = entry[field.dataset.field];
    field.textContent = text;
    field.parentElement.hidden = !text;
  }
  const codes = card.querySelector('.source-codes');
  codes.hidden = entry.source_codes.length === 0;
  for (const code of entry.source_codes) {
    const badge = document.createElement('span');
    badge.textContent = code;
    badge.title = sourceOptions.find((source) => source.code === code).title;
    codes.append(badge);
  }
  addLinks(card.querySelector('.source-text'), entry.source);
  const mark = card.querySelector('.mark');
  mark.textContent = entry.known ? '✓ 已认识 · 撤销' : '已认识';
  mark.setAttribute('aria-pressed', String(entry.known));
  mark.disabled = markRequests.has(entry.id);
  mark.addEventListener('click', () => changeKnown(entry, !entry.known));
  return card;
}

function renderList() {
  if (!loaded) return;
  const entries = loaded.entries
    .map((entry) => ({ ...entry, known: markRequests.get(entry.id)?.known ?? entry.known }))
    .filter((entry) => !hideKnown.checked || !entry.known);
  $('summary').textContent = '显示 ' + entries.length + ' / ' + loaded.total + ' 条';
  $('empty').hidden = entries.length > 0;
  $('more').hidden = entries.length <= limit;
  $('more').textContent = '再看 ' + Math.min(PAGE_SIZE, entries.length - limit) + ' 条';
  $('reset').hidden = !search.value && !source.value && sort.value === 'seen' && hideKnown.checked;
  list.replaceChildren(...entries.slice(0, limit).map(renderEntry));
}

async function refresh() {
  if (!token) return;
  listRequest?.abort();
  const controller = new AbortController();
  listRequest = controller;
  const params = new URLSearchParams({ sort: sort.value });
  if (search.value.trim()) params.set('q', search.value.trim());
  if (source.value) params.set('source', source.value);
  if (hideKnown.checked) params.set('known', 'false');

  try {
    const result = await api('/entries?' + params, { signal: controller.signal });
    if (controller.signal.aborted) return;
    loaded = result;
    $('list-error').hidden = true;
    $('login').hidden = true;
    $('notebook').hidden = false;
    $('lock').hidden = false;
    sessionStorage.setItem(TOKEN_KEY, token);
    renderList();
  } catch (error) {
    if (controller.signal.aborted) return;
    if (error.status === 401 || $('notebook').hidden) {
      lock(error.status === 401 || error.status === 503 ? error.message : '笔记暂时不可用，请稍后重试。');
      return;
    }
    loaded = undefined;
    list.replaceChildren();
    $('summary').textContent = '';
    $('empty').hidden = true;
    $('more').hidden = true;
    $('list-error').textContent = '读取失败，请更改筛选或刷新重试。';
    $('list-error').hidden = false;
  }
}

function notify(message, undo) {
  clearTimeout(noticeTimer);
  undoEntry = undo;
  $('notice-text').textContent = message;
  $('undo').hidden = !undo;
  $('notice').hidden = false;
  noticeTimer = setTimeout(() => {
    $('notice').hidden = true;
    undoEntry = undefined;
  }, 8000);
}

async function changeKnown(entry, known) {
  if (markRequests.has(entry.id)) return;
  const change = { known };
  markRequests.set(entry.id, change);
  renderList();
  try {
    const saved = await api('/entries/' + entry.id + '/known', { data: { known } });
    if (markRequests.get(entry.id) !== change) return;
    if (loaded) loaded.entries = loaded.entries.map((item) => item.id === saved.id ? saved : item);
    notify(known ? '已标为认识' : '已撤销认识标记', known ? saved : undefined);
  } catch (error) {
    if (markRequests.get(entry.id) !== change) return;
    if (error.status === 401) lock(error.message);
    else notify('标记保存失败，请重试。');
  } finally {
    if (markRequests.get(entry.id) === change) {
      markRequests.delete(entry.id);
      renderList();
      await refresh();
    }
  }
}

function filterChanged() {
  clearTimeout(searchTimer);
  limit = PAGE_SIZE;
  refresh();
}

search.addEventListener('input', () => {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(filterChanged, 180);
});
for (const element of [source, sort, hideKnown]) element.addEventListener('change', filterChanged);
$('reset').addEventListener('click', () => {
  search.value = '';
  source.value = '';
  sort.value = 'seen';
  hideKnown.checked = true;
  filterChanged();
});
$('more').addEventListener('click', () => {
  const previousLimit = limit;
  limit += PAGE_SIZE;
  renderList();
  const firstNew = list.children[previousLimit];
  firstNew?.querySelector('.speech').focus();
});
$('lock').addEventListener('click', () => lock());
$('undo').addEventListener('click', () => {
  if (undoEntry) changeKnown(undoEntry, false);
});
loginForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  token = loginInput.value.trim();
  loginInput.value = '';
  if (!token) return;
  const button = loginForm.querySelector('button');
  button.disabled = true;
  $('login-error').hidden = true;
  try {
    await refresh();
    if (!$('notebook').hidden) search.focus();
  } finally {
    button.disabled = false;
  }
});

if (token) refresh();
else lock();
