import { splitSources } from './sources.js';
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
const ACCESS_ISSUER = 'https://fullstackjam.cloudflareaccess.com';
const markRequests = new Map();
let token = '';
let accessMode = false;
let logoutUrl = '';
let loaded;
let listRequest;
let searchTimer;
let noticeTimer;
let undoEntry;
let limit = PAGE_SIZE;

function allowedAccessUrl(value) {
  let url;
  try {
    url = new URL(value, location.origin);
  } catch {
    return '';
  }
  if (url.username || url.password) return '';
  const appLogout = url.origin === location.origin && url.pathname === '/cdn-cgi/access/logout';
  const teamLogout = url.origin === ACCESS_ISSUER && url.pathname === '/cdn-cgi/access/logout';
  const teamLogin = url.origin === ACCESS_ISSUER
    && url.pathname === '/cdn-cgi/access/login/phrasefolio.fullstackjam.com';
  return appLogout || teamLogout || teamLogin ? url.toString() : '';
}

function navigate(value) {
  const target = allowedAccessUrl(value);
  if (target) location.assign(target);
}

async function api(path, { data, signal } = {}) {
  const headers = { Accept: 'application/json' };
  if (!accessMode && token) headers.Authorization = 'Bearer ' + token;
  if (data !== undefined) headers['Content-Type'] = 'application/json';
  const response = await fetch('/api' + path, {
    cache: 'no-store',
    credentials: 'same-origin',
    redirect: 'manual',
    headers,
    signal,
    method: data === undefined ? 'GET' : 'POST',
    body: data === undefined ? undefined : JSON.stringify(data),
  });
  if (response.type === 'opaqueredirect') {
    const error = new Error('需要通过 Cloudflare Access 登录');
    error.status = 401;
    error.redirected = true;
    throw error;
  }
  const result = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(typeof result.error === 'string' ? result.error : '笔记暂时不可用，请稍后重试');
    error.status = response.status;
    error.login = result.login;
    throw error;
  }
  return result;
}

function showOutage(message) {
  $('login').querySelector('h2').textContent = '暂时打不开';
  loginForm.hidden = true;
  listRequest?.abort();
  $('notebook').hidden = true;
  $('lock').hidden = true;
  $('notice').hidden = true;
  $('login').hidden = false;
  $('login-error').textContent = message;
  $('login-error').hidden = false;
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
  while (source.options.length > 1) source.remove(1);
  list.replaceChildren();
  $('notebook').hidden = true;
  $('lock').hidden = true;
  $('notice').hidden = true;
  $('login').querySelector('h2').textContent = '打开笔记本';
  loginForm.hidden = false;
  $('login').hidden = false;
  $('login-error').textContent = message;
  $('login-error').hidden = !message;
  loginInput.focus();
}

function leaveForAccess(error) {
  const target = allowedAccessUrl(error.login);
  if (target) navigate(target);
  else if (error.redirected || accessMode) location.assign(location.href);
}

function addLinks(element, text) {
  let cursor = 0;
  for (const match of text.matchAll(/https?:\/\/[^\s<>"“”]+/gu)) {
    const url = match[0].replace(/[),.;!?\]，。；！？]+$/u, '');
    const prefix = text.slice(cursor, match.index);
    const useTitle = cursor === 0 && match.index + url.length === text.length;
    if (!useTitle) element.append(prefix);
    const link = document.createElement('a');
    link.href = url;
    link.textContent = useTitle ? prefix.trimEnd() || url : url;
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
  const sources = card.querySelector('.entry-source');
  for (const text of splitSources(entry.source)) {
    const item = document.createElement('li');
    addLinks(item, text);
    sources.append(item);
  }
  sources.hidden = !sources.childElementCount;
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
  if (!accessMode && !token) return;
  listRequest?.abort();
  const controller = new AbortController();
  listRequest = controller;
  const params = new URLSearchParams({ sort: sort.value });
  if (search.value.trim()) params.set('q', search.value.trim());
  if (source.value) params.set('source_text', source.value);
  if (hideKnown.checked) params.set('known', 'false');

  try {
    const result = await api('/entries?' + params, { signal: controller.signal });
    if (controller.signal.aborted) return;
    loaded = result;
    const selectedSource = source.value;
    while (source.options.length > 1) source.remove(1);
    for (const { value, title } of result.sources) {
      source.add(new Option(title, value));
    }
    source.value = result.sources.some(({ value }) => value === selectedSource) ? selectedSource : '';
    $('list-error').hidden = true;
    $('login').hidden = true;
    $('notebook').hidden = false;
    $('lock').hidden = false;
    if (!accessMode) sessionStorage.setItem(TOKEN_KEY, token);
    renderList();
  } catch (error) {
    if (controller.signal.aborted) return;
    if (error.status === 401) {
      if (accessMode || error.redirected) leaveForAccess(error);
      else lock(error.message);
      return;
    }
    if ($('notebook').hidden) {
      showOutage('笔记暂时不可用，请稍后重试。');
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
    if (error.status === 401) {
      if (accessMode || error.redirected) leaveForAccess(error);
      else lock(error.message);
    } else notify('标记保存失败，请重试。');
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
$('lock').addEventListener('click', () => {
  if (!accessMode) {
    lock();
    return;
  }
  const target = allowedAccessUrl(logoutUrl) || new URL('/cdn-cgi/access/logout', location.origin).toString();
  location.assign(target);
});
$('undo').addEventListener('click', () => {
  if (undoEntry) changeKnown(undoEntry, false);
});
loginForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  if (accessMode) return;
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

async function start() {
  token = sessionStorage.getItem(TOKEN_KEY) ?? '';
  let response;
  try {
    response = await fetch('/api/session', {
      cache: 'no-store',
      credentials: 'same-origin',
      redirect: 'manual',
      headers: { Accept: 'application/json' },
    });
  } catch {
    showOutage('笔记暂时不可用，请稍后重试。');
    return;
  }
  if (response.type === 'opaqueredirect') {
    location.assign(location.href);
    return;
  }
  const body = await response.json().catch(() => ({}));
  if (response.status === 401) {
    sessionStorage.removeItem(TOKEN_KEY);
    token = '';
    loginForm.hidden = true;
    const target = allowedAccessUrl(body.login);
    if (target) navigate(target);
    else showOutage(typeof body.error === 'string' ? body.error : '需要通过 Cloudflare Access 登录');
    return;
  }
  if (!response.ok) {
    showOutage('笔记暂时不可用，请稍后重试。');
    return;
  }
  if (body.access === true) {
    accessMode = true;
    logoutUrl = typeof body.logout === 'string' ? body.logout : '';
    token = '';
    sessionStorage.removeItem(TOKEN_KEY);
    loginForm.hidden = true;
    $('lock').textContent = '退出';
    await refresh();
    if (!$('notebook').hidden) search.focus();
    return;
  }
  accessMode = false;
  if (token) await refresh();
  else lock();
}

export const ready = start();
