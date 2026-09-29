'use strict';

const APP_VERSION = '1.3.0';
const MQTT_URL = 'wss://broker.hivemq.com:8884/mqtt';
const STORAGE = {
  state: 'liveStats.state.v1',
  team: 'liveStats.team.v1',
  session: 'liveStats.session.v1',
  dirty: 'liveStats.dirty.v1'
};
const DEFAULT_ROOMS = [
  { id: 1, name: '一号直播间', channel: '视频号' },
  { id: 2, name: '二号直播间', channel: '视频号' },
  { id: 3, name: '三号直播间', channel: '视频号' }
];
const ADMIN_PHONE = '13957116161';
const AVATARS = ['😀','😄','😊','🥰','😎','🤩','🥳','😇','🙂','🤗','💪','👍','🌟','🔥','🎤','📺','🏆','📈'];
const TIME_RANGES = [
  { key: 'today', label: '今日' },
  { key: 'yesterday', label: '昨日' },
  { key: 'month', label: '本月' },
  { key: 'year', label: '今年' }
];
const DEFAULT_VIOLATION_REASONS = ['低俗内容','违规广告','虚假宣传','诱导分享','其他'];
const DEFAULT_FIELDS = [
  { id: 'fld_date', key: 'date', name: '日期', type: 'date', required: true, fixed: true, options: [] },
  { id: 'fld_start', key: 'start', name: '开播时间', type: 'time', required: true, fixed: true, options: [] },
  { id: 'fld_duration', key: 'duration', name: '直播时长', type: 'duration', required: true, fixed: true, options: [] },
  { id: 'fld_peak', key: 'peak', name: '在线高峰人数', type: 'number', required: true, fixed: true, options: [] },
  { id: 'fld_violation', key: 'violation', name: '有无违规', type: 'violation', required: false, fixed: true, options: [] },
  { id: 'fld_note', key: 'note', name: '备注', type: 'text', required: false, fixed: true, options: [] }
];
const METRICS = {
  peak: { label: '高峰人数', unit: '人' },
  count: { label: '主持次数', unit: '次' },
  duration: { label: '直播时长', unit: '小时' }
};

const app = {
  data: null,
  session: null,
  teamCode: null,
  tab: 'home',
  range: 'month',
  year: new Date().getFullYear(),
  metric: 'peak',
  month: monthKey(new Date()),
  recordRoom: 'all',
  recordHost: 'all',
  syncStatus: navigator.onLine ? 'connecting' : 'offline',
  syncMessage: navigator.onLine ? '正在连接云同步…' : '离线使用',
  remoteSeen: false,
  dirty: false,
  initialized: false,
  deferredPrompt: null,
  joinCode: '',
  authMode: 'create',
  mqttClient: null,
  syncTopic: '',
  stateKey: null,
  lastRenderKey: '',
  fieldDraft: null,
  editingFieldId: '',
  editingRoomId: '',
  profileAvatar: ''
};

const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => Array.from(root.querySelectorAll(selector));

function uid(prefix = 'id') {
  if (crypto.randomUUID) return prefix + '_' + crypto.randomUUID().replace(/-/g, '').slice(0, 20);
  const bytes = crypto.getRandomValues(new Uint8Array(10));
  return prefix + '_' + Array.from(bytes).map((b) => b.toString(16).padStart(2, '0')).join('');
}

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (char) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  })[char]);
}

function localDate(date = new Date()) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return y + '-' + m + '-' + d;
}

function parseLocalDate(value) {
  const parts = String(value || localDate()).split('-').map(Number);
  return new Date(parts[0], (parts[1] || 1) - 1, parts[2] || 1, 12, 0, 0, 0);
}

function monthKey(dateOrValue = new Date()) {
  const d = dateOrValue instanceof Date ? dateOrValue : parseLocalDate(String(dateOrValue).slice(0, 7) + '-01');
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0');
}

function monthLabel(key) {
  const [year, month] = String(key || monthKey()).split('-').map(Number);
  return year + '年' + month + '月';
}

function dateLabel(value) {
  const d = parseLocalDate(value);
  const weekdays = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];
  return d.getMonth() + 1 + '月' + d.getDate() + '日 ' + weekdays[d.getDay()];
}

function shortDate(value) {
  const d = parseLocalDate(value);
  return (d.getMonth() + 1) + '/' + d.getDate();
}

function addDays(value, count) {
  const d = parseLocalDate(value);
  d.setDate(d.getDate() + count);
  return localDate(d);
}

function addMonths(key, delta) {
  const [year, month] = String(key).split('-').map(Number);
  return monthKey(new Date(year, month - 1 + delta, 1, 12));
}

function daysInMonth(key) {
  const [year, month] = String(key).split('-').map(Number);
  return new Date(year, month, 0).getDate();
}

function minutesToTime(minutes) {
  const value = Math.max(0, Math.min(1439, Number(minutes) || 0));
  return String(Math.floor(value / 60)).padStart(2, '0') + ':' + String(value % 60).padStart(2, '0');
}

function durationText(minutes) {
  const value = Number(minutes) || 0;
  const h = Math.floor(value / 60);
  const m = value % 60;
  if (!h) return m + '分钟';
  if (!m) return h + '小时';
  return h + '小时' + m + '分钟';
}

function formatNumber(value, digits = 0) {
  const num = Number(value) || 0;
  return num.toLocaleString('zh-CN', { maximumFractionDigits: digits, minimumFractionDigits: 0 });
}

function visibleText(value, fallback = '未命名') {
  const text = String(value ?? '').trim();
  return text || fallback;
}

function jsonClone(value) {
  return JSON.parse(JSON.stringify(value));
}

function readJson(key, fallback = null) {
  try {
    const raw = localStorage.getItem(key);
    return raw ? JSON.parse(raw) : fallback;
  } catch (error) {
    console.warn('读取本地数据失败', key, error);
    return fallback;
  }
}

function writeJson(key, value) {
  localStorage.setItem(key, JSON.stringify(value));
}

function toast(message, type = '') {
  const el = $('#toast');
  if (!el) return;
  el.textContent = message;
  el.className = 'toast show ' + type;
  clearTimeout(toast._timer);
  toast._timer = setTimeout(() => { el.className = 'toast ' + type; }, 2800);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function bytesToBase64(bytes) {
  let binary = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

function base64ToBytes(value) {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

async function sha256Base64(value) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return bytesToBase64(new Uint8Array(digest));
}

async function passwordRecord(password, existingSalt) {
  const salt = existingSalt || bytesToBase64(crypto.getRandomValues(new Uint8Array(16)));
  const passwordKey = await crypto.subtle.importKey('raw', new TextEncoder().encode(password), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits({
    name: 'PBKDF2', salt: base64ToBytes(salt), iterations: 120000, hash: 'SHA-256'
  }, passwordKey, 256);
  return { salt, hash: bytesToBase64(new Uint8Array(bits)), iterations: 120000, algorithm: 'PBKDF2-SHA256' };
}

async function verifyPassword(password, record) {
  if (!record?.hash || !record?.salt) return false;
  const passwordKey = await crypto.subtle.importKey('raw', new TextEncoder().encode(password), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits({
    name: 'PBKDF2', salt: base64ToBytes(record.salt), iterations: Number(record.iterations) || 120000, hash: 'SHA-256'
  }, passwordKey, 256);
  const actual = new Uint8Array(bits);
  const expected = base64ToBytes(record.hash);
  if (actual.length !== expected.length) return false;
  let diff = 0;
  for (let i = 0; i < actual.length; i++) diff |= actual[i] ^ expected[i];
  return diff === 0;
}

function generateTeamCode() {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  const chars = Array.from(bytes).map((byte) => alphabet[byte % alphabet.length]);
  return 'LSP-' + [chars.slice(0, 4), chars.slice(4, 8), chars.slice(8, 12), chars.slice(12, 16)].map((group) => group.join('')).join('-');
}

async function syncTopicFor(teamCode) {
  const hash = await sha256Base64('live-stats-topic|' + teamCode.trim().toUpperCase());
  return 'live-stats/v1/' + hash.replace(/[+/=]/g, '').slice(0, 36) + '/state';
}

async function stateKeyFor(teamCode, topic) {
  const material = await crypto.subtle.importKey('raw', new TextEncoder().encode('live-stats-key|' + teamCode.trim().toUpperCase()), 'PBKDF2', false, ['deriveKey']);
  return crypto.subtle.deriveKey({
    name: 'PBKDF2', salt: new TextEncoder().encode(topic), iterations: 150000, hash: 'SHA-256'
  }, material, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
}

async function encryptState(data, key) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const encoded = new TextEncoder().encode(JSON.stringify(data));
  const encrypted = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, encoded);
  return { iv: bytesToBase64(iv), ciphertext: bytesToBase64(new Uint8Array(encrypted)) };
}

async function decryptState(envelope, key) {
  const decrypted = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: base64ToBytes(envelope.iv) },
    key,
    base64ToBytes(envelope.ciphertext)
  );
  return JSON.parse(new TextDecoder().decode(decrypted));
}

function createInitialState(teamName, admin) {
  const now = new Date().toISOString();
  return {
    schemaVersion: 1,
    meta: {
      teamName,
      revision: 1,
      createdAt: now,
      updatedAt: now,
      updatedBy: admin.id,
      appVersion: APP_VERSION
    },
    rooms: jsonClone(DEFAULT_ROOMS),
    fields: jsonClone(DEFAULT_FIELDS),
    violationReasons: jsonClone(DEFAULT_VIOLATION_REASONS),
    users: [admin],
    records: []
  };
}

function normalizeState(value) {
  if (!value || typeof value !== 'object') return null;
  const now = new Date().toISOString();
  const data = jsonClone(value);
  data.schemaVersion = Number(data.schemaVersion) || 1;
  data.meta = data.meta || {};
  data.meta.teamName = visibleText(data.meta.teamName, '直播数据团队');
  data.meta.revision = Number(data.meta.revision) || 1;
  data.meta.createdAt = data.meta.createdAt || now;
  data.meta.updatedAt = data.meta.updatedAt || now;
  data.fields = normalizeFields(data.fields);
  data.violationReasons = Array.isArray(data.violationReasons) && data.violationReasons.length ? data.violationReasons.map(String).filter(Boolean) : jsonClone(DEFAULT_VIOLATION_REASONS);
  data.rooms = Array.isArray(data.rooms) && data.rooms.length ? data.rooms : jsonClone(DEFAULT_ROOMS);
  data.users = Array.isArray(data.users) ? data.users : [];
  data.records = Array.isArray(data.records) ? data.records : [];
  return data;
}

function loadLocalState() {
  app.teamCode = localStorage.getItem(STORAGE.team) || '';
  app.data = normalizeState(readJson(STORAGE.state, null));
  app.session = readJson(STORAGE.session, null);
  app.dirty = readJson(STORAGE.dirty, false) === true;
  if (app.session?.expiresAt && Number(app.session.expiresAt) < Date.now()) {
    app.session = null;
    localStorage.removeItem(STORAGE.session);
  }
}

function saveLocalState({ dirty = app.dirty } = {}) {
  if (app.data) writeJson(STORAGE.state, app.data);
  if (app.session && resolveUser()) writeJson(STORAGE.session, app.session);
  else if (!app.session) localStorage.removeItem(STORAGE.session);
  writeJson(STORAGE.dirty, Boolean(dirty));
  app.dirty = Boolean(dirty);
}

function setTeamCode(teamCode, { persist = true } = {}) {
  app.teamCode = String(teamCode || '').trim().toUpperCase();
  if (persist && app.teamCode) localStorage.setItem(STORAGE.team, app.teamCode);
}

function resolveUser() {
  if (!app.session?.userId || !app.data) return null;
  return app.data.users.find((user) => user.id === app.session.userId && !user.deletedAt && user.status !== 'disabled') || null;
}

function activeUsers() {
  return (app.data?.users || []).filter((user) => !user.deletedAt && user.status !== 'disabled');
}

function roomById(id) {
  return (app.data?.rooms || DEFAULT_ROOMS).find((room) => Number(room.id) === Number(id)) || { id: Number(id), name: '未知直播间', channel: '视频号' };
}

function normalizeFields(list) {
  const base = jsonClone(DEFAULT_FIELDS);
  const map = new Map();
  const order = [];
  for (const field of list || []) {
    if (!field || !field.id || !field.key) continue;
    const key = String(field.key);
    const item = {
      id: String(field.id),
      key,
      name: visibleText(field.name, '未命名统计项'),
      type: ['date', 'time', 'duration', 'number', 'text', 'select', 'violation'].includes(field.type) ? field.type : 'text',
      required: Boolean(field.required),
      fixed: Boolean(field.fixed),
      options: Array.isArray(field.options) ? field.options.map(String).filter(Boolean) : []
    };
    if (!map.has(key)) { map.set(key, item); order.push(key); }
  }
  for (const field of base) if (!map.has(field.key)) map.set(field.key, field);
  const result = [];
  for (const field of base) if (map.has(field.key)) result.push(map.get(field.key));
  for (const key of order) if (!base.some((field) => field.key === key) && map.has(key)) result.push(map.get(key));
  return result;
}

function fieldByKey(key) {
  return (app.data?.fields || DEFAULT_FIELDS).find((field) => field.key === key) || null;
}

function fieldName(key, fallback) {
  return fieldByKey(key)?.name || fallback || key;
}

function customFields() {
  return (app.data?.fields || []).filter((field) => !field.fixed);
}

function metricLabel(metric) {
  if (metric === 'peak') return fieldName('peak', '高峰人数');
  if (metric === 'duration') return fieldName('duration', '直播时长');
  return '主持次数';
}

function userName(id) {
  return app.data?.users?.find((user) => user.id === id)?.name || '已删除主持人';
}

function userInitial(name) {
  return visibleText(name, '主').slice(-1);
}

function avatarText(user) {
  return (user && user.avatar) ? user.avatar : userInitial(user && user.name);
}

function avatarHtml(user, cls) {
  return '<span class="' + (cls || 'avatar') + '">' + escapeHtml(avatarText(user)) + '</span>';
}

function canManageUsers() {
  return resolveUser()?.role === 'admin';
}

function allowedRooms(user = resolveUser()) {
  if (!user) return [];
  if (user.role === 'admin') return app.data.rooms;
  return app.data.rooms.filter((room) => (user.roomIds || []).map(Number).includes(Number(room.id)));
}

function visibleRecords() {
  const user = resolveUser();
  if (!user) return [];
  return (app.data.records || []).filter((record) => {
    if (record.deletedAt) return false;
    if (user.role === 'admin' || user.viewAll) return true;
    return record.hostId === user.id;
  });
}

function canEditRecord(record) {
  const user = resolveUser();
  if (!user || !record) return false;
  if (user.role === 'admin') return true;
  return record.hostId === user.id && (user.roomIds || []).map(Number).includes(Number(record.roomId));
}

function recordsInMonth(key = app.month) {
  return visibleRecords().filter((record) => String(record.date || '').startsWith(key));
}

function recordSummary(records) {
  const count = records.length;
  const totalMinutes = records.reduce((sum, record) => sum + (Number(record.duration) || 0), 0);
  const peakValues = records.map((record) => Number(record.peak) || 0).filter((value) => value >= 0);
  const peakSum = peakValues.reduce((sum, value) => sum + value, 0);
  return {
    count,
    totalMinutes,
    totalHours: totalMinutes / 60,
    averagePeak: count ? peakSum / count : 0,
    maxPeak: peakValues.length ? Math.max(...peakValues) : 0
  };
}

function markChanged(target, userId) {
  const now = new Date().toISOString();
  if (target && typeof target === 'object') target.updatedAt = now;
  if (app.data) {
    app.data.meta.revision = (Number(app.data.meta.revision) || 0) + 1;
    app.data.meta.updatedAt = now;
    app.data.meta.updatedBy = userId || resolveUser()?.id || 'system';
  }
}

async function commitChange(mutator) {
  if (!app.data) return;
  mutator(app.data);
  markChanged(app.data.meta, resolveUser()?.id);
  saveLocalState({ dirty: true });
  render();
  await publishState();
}

function mergeEntityArray(localList = [], remoteList = []) {
  const map = new Map();
  for (const item of remoteList || []) if (item?.id) map.set(item.id, item);
  for (const item of localList || []) {
    if (!item?.id) continue;
    const remote = map.get(item.id);
    if (!remote) {
      map.set(item.id, item);
      continue;
    }
    const localTime = Date.parse(item.updatedAt || 0) || 0;
    const remoteTime = Date.parse(remote.updatedAt || 0) || 0;
    if (localTime > remoteTime) map.set(item.id, item);
  }
  return Array.from(map.values());
}

function mergeStates(local, remote) {
  if (!local) return { data: normalizeState(remote), merged: true };
  if (!remote) return { data: local, merged: false };
  local = normalizeState(local);
  remote = normalizeState(remote);
  const users = mergeEntityArray(local.users, remote.users);
  const records = mergeEntityArray(local.records, remote.records);
  const usersChanged = JSON.stringify(users) !== JSON.stringify(remote.users);
  const recordsChanged = JSON.stringify(records) !== JSON.stringify(remote.records);
  const localMetaNewer = Date.parse(local.meta.updatedAt || 0) > Date.parse(remote.meta.updatedAt || 0);
  const merged = jsonClone(remote);
  merged.users = users;
  merged.records = records;
  if (localMetaNewer) {
    merged.rooms = local.rooms;
    merged.fields = local.fields;
    if (local.meta.teamName) merged.meta.teamName = local.meta.teamName;
  }
  const changed = usersChanged || recordsChanged || localMetaNewer;
  if (changed) {
    merged.meta.revision = Math.max(Number(local.meta.revision) || 0, Number(remote.meta.revision) || 0) + 1;
    merged.meta.updatedAt = new Date().toISOString();
    merged.meta.updatedBy = resolveUser()?.id || local.meta.updatedBy || 'system';
  } else {
    merged.meta.revision = Math.max(Number(local.meta.revision) || 0, Number(remote.meta.revision) || 0);
  }
  const equalsLocal = JSON.stringify(merged) === JSON.stringify(local);
  return { data: merged, merged: changed || !equalsLocal };
}

function setSyncStatus(status, message) {
  app.syncStatus = status;
  app.syncMessage = message;
  const pill = $('#sync-pill');
  if (pill) {
    pill.className = 'sync-pill ' + (status === 'synced' ? '' : status);
    pill.innerHTML = '<span class="sync-dot"></span><span>' + escapeHtml(message) + '</span>';
  }
  const profileStatus = $('#profile-sync-status');
  if (profileStatus) profileStatus.textContent = message;
}

async function publishState() {
  if (!app.mqttClient?.connected || !app.stateKey || !app.data) return false;
  try {
    const encrypted = await encryptState(app.data, app.stateKey);
    const envelope = {
      version: 1,
      sentAt: new Date().toISOString(),
      writer: resolveUser()?.id || 'device',
      data: encrypted
    };
    await new Promise((resolve, reject) => {
      app.mqttClient.publish(app.syncTopic, JSON.stringify(envelope), { qos: 1, retain: true }, (error) => error ? reject(error) : resolve());
    });
    saveLocalState({ dirty: false });
    setSyncStatus('synced', '已同步');
    return true;
  } catch (error) {
    console.error('同步发布失败', error);
    saveLocalState({ dirty: true });
    setSyncStatus('error', '同步失败，稍后重试');
    return false;
  }
}

async function applyRemoteEnvelope(envelope) {
  if (!envelope?.data?.iv || !envelope?.data?.ciphertext) return;
  try {
    const remote = await decryptState(envelope.data, app.stateKey);
    app.remoteSeen = true;
    const result = mergeStates(app.data, remote);
    const old = JSON.stringify(app.data);
    app.data = result.data;
    const changed = old !== JSON.stringify(app.data);
    if (changed || app.dirty) {
      saveLocalState({ dirty: result.merged || app.dirty });
      render();
    }
    if (result.merged || app.dirty) {
      setSyncStatus('syncing', '正在合并数据…');
      await publishState();
    } else {
      saveLocalState({ dirty: false });
      setSyncStatus('synced', '已同步 · ' + new Date().toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' }));
    }
  } catch (error) {
    console.warn('远端数据无法解密或格式错误', error);
    setSyncStatus('error', '团队码不匹配或数据损坏');
  }
}

async function initSync() {
  if (!app.teamCode) return;
  try {
    app.syncTopic = await syncTopicFor(app.teamCode);
    app.stateKey = await stateKeyFor(app.teamCode, app.syncTopic);
  } catch (error) {
    console.error(error);
    setSyncStatus('error', '初始化同步失败');
    return;
  }
  if (app.mqttClient) {
    app.mqttClient.end(true);
    app.mqttClient = null;
  }
  if (typeof mqtt === 'undefined') {
    setSyncStatus('error', '同步组件未加载');
    return;
  }
  setSyncStatus(navigator.onLine ? 'connecting' : 'offline', navigator.onLine ? '正在连接云同步…' : '离线使用');
  const clientId = 'lsp_web_' + uid('').replace(/[^a-zA-Z0-9]/g, '').slice(0, 22);
  const client = mqtt.connect(MQTT_URL, {
    clientId,
    clean: true,
    keepalive: 30,
    reconnectPeriod: 3500,
    connectTimeout: 12000
  });
  app.mqttClient = client;
  client.on('connect', () => {
    setSyncStatus('connecting', '正在读取团队数据…');
    client.subscribe(app.syncTopic, { qos: 1 }, (error) => {
      if (error) {
        setSyncStatus('error', '订阅同步失败');
        return;
      }
      setTimeout(() => {
        if (app.dirty || !app.data) publishState(); else setSyncStatus('synced', '已同步');
      }, 900);
    });
  });
  client.on('message', (_topic, payload) => {
    try {
      const envelope = JSON.parse(payload.toString());
      applyRemoteEnvelope(envelope);
    } catch (error) {
      console.warn('消息内容无效', error);
    }
  });
  client.on('reconnect', () => setSyncStatus('connecting', '正在重新连接…'));
  client.on('close', () => setSyncStatus(navigator.onLine ? 'offline' : 'offline', navigator.onLine ? '连接中断，正在重试' : '离线使用'));
  client.on('offline', () => setSyncStatus('offline', '离线使用'));
  client.on('error', (error) => {
    console.warn('MQTT error', error);
    setSyncStatus('error', '云同步暂不可用');
  });
}

function exportData() {
  if (!app.data) return;
  const blob = new Blob([JSON.stringify(app.data, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = '直播数据备份-' + localDate() + '.json';
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 3000);
}

async function importDataFile(file) {
  if (!file) return;
  try {
    const value = JSON.parse(await file.text());
    const normalized = normalizeState(value);
    if (!normalized?.meta?.teamName || !Array.isArray(normalized.users) || !Array.isArray(normalized.records)) {
      throw new Error('文件格式不正确');
    }
    app.data = normalized;
    markChanged(app.data.meta, resolveUser()?.id || 'import');
    saveLocalState({ dirty: true });
    render();
    await publishState();
    toast('备份数据已导入并开始同步', 'success');
  } catch (error) {
    toast('导入失败：' + error.message, 'error');
  }
}


function render() {
  const root = $('#app');
  if (!root) return;
  if (!app.initialized) {
    root.innerHTML = '<div class="wellcome"><div class="sync-wait"><div class="spinner"></div><div class="section-title">正在启动…</div></div></div>';
    return;
  }
  if (!app.teamCode) {
    root.innerHTML = renderWelcome();
    return;
  }
  if (!app.data) {
    root.innerHTML = renderSyncWait();
    return;
  }
  if (!resolveUser()) {
    app.session = null;
    root.innerHTML = renderLogin();
    return;
  }
  root.innerHTML = renderMain();
  afterRender();
}

function afterRender() {
  bindWheels();
  if (app.tab === 'dashboard') {
    requestAnimationFrame(() => {
      const chart = $('#trend-chart');
      if (chart && app.month === monthKey()) chart.scrollLeft = chart.scrollWidth;
    });
  }
}

function renderSyncBadge() {
  const statusClass = app.syncStatus === 'synced' ? '' : app.syncStatus;
  return '<span id="sync-pill" class="sync-pill ' + statusClass + '"><span class="sync-dot"></span><span>' + escapeHtml(app.syncMessage) + '</span></span>';
}

function renderWelcome() {
  const creating = app.authMode === 'create';
  return '<main class="wellcome">' +
    '<div class="brand">' +
      '<div class="brand-icon">▥</div>' +
      '<h1>直播数据统计</h1>' +
      '<p>主持人每日录入，管理员按月汇总分析</p>' +
    '</div>' +
    '<div class="auth-card">' +
      '<div class="auth-switch">' +
        '<button class="' + (creating ? 'active' : '') + '" data-action="auth-switch" data-mode="create">创建新团队</button>' +
        '<button class="' + (!creating ? 'active' : '') + '" data-action="auth-switch" data-mode="join">加入已有团队</button>' +
      '</div>' +
      (creating ? renderCreateTeamForm() : renderJoinTeamForm()) +
    '</div>' +
    '<p class="safe-note">数据采用端到端加密后同步到云端。登录后长期保持登录状态，换设备时可扫码或输入团队码恢复。</p>' +
  '</main>';
}

function renderCreateTeamForm() {
  return '<div>' +
    '<div class="form-group"><label class="form-label">团队/公司名称</label><input id="setup-team-name" class="input" maxlength="30" placeholder="例如：文博直播团队" /></div>' +
    '<div class="form-group"><label class="form-label">管理员姓名</label><input id="setup-admin-name" class="input" maxlength="20" placeholder="请输入姓名" /></div>' +
    '<div class="form-group"><label class="form-label">管理员手机号（固定）</label><input id="setup-admin-phone" class="input" inputmode="numeric" maxlength="11" value="13957116161" readonly /></div>' +
    '<div class="form-group"><label class="form-label">管理员密码</label><input id="setup-admin-password" class="input" type="password" maxlength="32" placeholder="留空则使用手机号后 6 位" /><div class="form-hint">首次登录后可在“我的”中修改密码。</div></div>' +
    '<button class="btn btn-primary btn-block" data-action="create-team">创建团队并进入</button>' +
  '</div>' +
  '<div class="info-banner" style="margin-top:16px">创建成功后，在人员管理页生成邀请二维码，主持人扫码即可加入。</div>';
}

function renderJoinTeamForm() {
  return '<div>' +
    '<div class="form-group"><label class="form-label">团队码</label><input id="join-team-code" class="input" value="' + escapeHtml(app.joinCode) + '" maxlength="40" placeholder="LSP-XXXX-XXXX-XXXX-XXXX" autocapitalize="characters" /><div class="form-hint">扫描管理员二维码通常会直接带入团队码。</div></div>' +
    '<button class="btn btn-primary btn-block" data-action="join-team">加入并同步数据</button>' +
  '</div>' +
  '<div class="info-banner warning" style="margin-top:16px">团队码相当于数据保险箱钥匙，请不要发给无关人员。</div>';
}

function renderSyncWait() {
  return '<main class="wellcome"><div class="sync-wait">' +
    '<div class="spinner"></div>' +
    '<div class="section-title">正在读取团队数据</div>' +
    '<p class="section-desc" style="margin:9px 0 4px">请确认网络正常，并等待管理员设备同步。</p>' +
    '<p class="muted" style="font-size:12px">团队码：' + escapeHtml(app.teamCode) + '</p>' +
    '<div style="margin-top:22px">' + renderSyncBadge() + '</div>' +
    '<div class="btn-row" style="margin-top:24px">' +
      '<button class="btn btn-soft" data-action="retry-sync">重试同步</button>' +
      '<button class="btn btn-ghost" data-action="leave-team">退出团队</button>' +
    '</div>' +
  '</div></main>';
}

function renderLogin() {
  return '<main class="wellcome">' +
    '<div class="brand"><div class="brand-icon">▥</div><h1>直播数据统计</h1><p>' + escapeHtml(app.data.meta.teamName) + '</p></div>' +
    '<div class="auth-card">' +
      '<div class="form-group"><label class="form-label">手机号</label><input id="login-phone" class="input" inputmode="numeric" maxlength="11" placeholder="请输入手机号" autocomplete="tel" /></div>' +
      '<div class="form-group"><label class="form-label">密码</label><input id="login-password" class="input" type="password" maxlength="32" placeholder="请输入密码" autocomplete="current-password" /></div>' +
      '<button class="btn btn-primary btn-block" data-action="login">登录</button>' +
      '<div class="sync-badge-wrap" style="text-align:center;margin-top:16px">' + renderSyncBadge() + '</div>' +
      '<p class="safe-note">初始密码为手机号后 6 位。登录状态会长期保留，无需每天重复输入。</p>' +
      '<button class="link-btn" style="display:block;margin:10px auto 0" data-action="leave-team">切换团队</button>' +
    '</div>' +
  '</main>';
}

function mainTitle() {
  if (app.tab === 'home') return ['打卡', '每日直播数据填写'];
  if (app.tab === 'stats') return ['统计', '记录与数据分析'];
  if (app.tab === 'staff') return ['人员与权限', '管理员功能'];
  return ['我的', '账号与数据安全'];
}

function renderMain() {
  const [title, subtitle] = mainTitle();
  const user = resolveUser();
  return '<div class="app-shell">' +
    '<header class="topbar">' +
      '<button class="avatar-button" data-action="tab" data-tab="profile">' + escapeHtml(avatarText(user)) + '</button>' +
      '<div style="flex:1;min-width:0"><div class="topbar-title">' + escapeHtml(title) + '</div><div class="topbar-subtitle">' + escapeHtml(subtitle) + '</div></div>' +
      '<button class="icon-btn" data-action="sync-now" title="立即同步">↻</button>' +
    '</header>' +
    '<main class="page">' + renderTab() + '</main>' +
    renderBottomNav() +
  '</div>';
}

function renderTab() {
  if (app.tab === 'home') return renderHome();
  if (app.tab === 'stats') return renderStats();
  if (app.tab === 'staff' && canManageUsers()) return renderStaff();
  if (app.tab === 'profile') return renderProfile();
  return renderHome();
}

function renderBottomNav() {
  const user = resolveUser();
  return '<nav class="bottom-nav">' +
    '<button class="nav-item ' + (app.tab === 'home' ? 'active' : '') + '" data-action="tab" data-tab="home"><i class="nav-icon">✎</i><span>打卡</span></button>' +
    '<button class="nav-item ' + (app.tab === 'stats' ? 'active' : '') + '" data-action="tab" data-tab="stats"><i class="nav-icon">▦</i><span>统计</span></button>' +
    (user.role === 'admin' ? '<button class="nav-item ' + (app.tab === 'staff' ? 'active' : '') + '" data-action="tab" data-tab="staff"><i class="nav-icon">♙</i><span>人员</span></button>' : '') +
    '<button class="nav-item ' + (app.tab === 'profile' ? 'active' : '') + '" data-action="tab" data-tab="profile"><i class="nav-icon">◉</i><span>我的</span></button>' +
  '</nav>';
}

function renderStats() {
  const records = statsRecords(app.range);
  const summary = recordSummary(records);
  return '<section>' +
    renderStatsHeader() +
    '<div class="kpi-grid" style="margin-top:14px">' +
      kpiCard(fieldName('duration', '直播时长') + '合计', (summary.totalHours ? summary.totalHours.toFixed(summary.totalHours >= 10 ? 0 : 1) : '0'), '小时', '所选范围', '') +
      kpiCard('平均' + fieldName('peak', '高峰人数'), summary.averagePeak.toFixed(summary.averagePeak >= 100 ? 0 : 1), '人', '每条直播', 'success') +
      kpiCard('最高' + fieldName('peak', '高峰人数'), formatNumber(summary.maxPeak), '人', '峰值', 'warning') +
      kpiCard('直播次数', formatNumber(summary.count), '次', records.length + ' 条记录', '') +
    '</div>' +
    renderRoomChart(records) +
    renderUserRoomStats(records) +
    renderTrendCard(records) +
    renderRecordsList(records) +
  '</section>';
}

function statsRecords(range) {
  const now = new Date();
  const today = localDate(now);
  const yesterday = addDays(today, -1);
  const recs = visibleRecords();
  if (range === 'today') return recs.filter((r) => r.date === today);
  if (range === 'yesterday') return recs.filter((r) => r.date === yesterday);
  if (range === 'year') return recs.filter((r) => String(r.date || '').startsWith(String(app.year)));
  return recs.filter((r) => String(r.date || '').startsWith(app.month));
}

function renderStatsHeader() {
  const range = app.range;
  let nav = '';
  if (range === 'month') {
    nav = '<div class="month-switch"><button class="month-arrow" data-action="month-prev">‹</button><button class="month-current" data-action="month-picker">' + escapeHtml(monthLabel(app.month)) + '</button><button class="month-arrow" data-action="month-next">›</button></div>';
  } else if (range === 'year') {
    nav = '<div class="month-switch"><button class="month-arrow" data-action="year-prev">‹</button><span class="month-current">' + app.year + '年</span><button class="month-arrow" data-action="year-next">›</button></div>';
  } else {
    nav = '<div class="muted" style="font-size:13px;font-weight:700">' + (range === 'today' ? '今日' : '昨日') + '</div>';
  }
  return '<div class="range-bar">' +
    '<div class="segmented">' + TIME_RANGES.map((r) => '<button class="' + (range === r.key ? 'active' : '') + '" data-action="range" data-value="' + r.key + '">' + r.label + '</button>').join('') + '</div>' +
    nav +
  '</div>';
}

function renderRoomChart(records) {
  const rooms = app.data.rooms;
  const maxPeak = Math.max(1, ...rooms.map((room) => {
    const rs = records.filter((r) => Number(r.roomId) === Number(room.id));
    return rs.length ? Math.max(...rs.map((r) => Number(r.peak) || 0)) : 0;
  }));
  const bars = rooms.map((room) => {
    const rs = records.filter((r) => Number(r.roomId) === Number(room.id));
    const count = rs.length;
    const avgPeak = count ? rs.reduce((sum, r) => sum + (Number(r.peak) || 0), 0) / count : 0;
    const height = avgPeak > 0 ? Math.max(6, (avgPeak / maxPeak) * 130) : 4;
    return '<div class="bar-col" title="' + escapeHtml(room.name) + '">' +
      '<div class="bar-value">' + (avgPeak ? avgPeak.toFixed(avgPeak >= 100 ? 0 : 1) : '') + '</div>' +
      '<div class="bar-track"><div class="bar-fill success" style="height:' + height + 'px"></div></div>' +
      '<div class="bar-label">' + escapeHtml(room.name) + '</div>' +
      '<div class="bar-sub">' + count + '次</div>' +
    '</div>';
  }).join('');
  return '<div class="section-head"><div><div class="section-title">各直播间高峰人数</div><div class="section-desc">柱高=平均' + escapeHtml(fieldName('peak', '高峰人数')) + '，下方为直播次数</div></div></div>' +
    '<div class="card chart-card">' + (records.length ? '<div class="chart-scroll"><div class="chart-inner">' + bars + '</div></div>' : '<div class="chart-empty">暂无数据</div>') + '</div>';
}

function renderUserRoomStats(records) {
  const users = activeUsers().filter((u) => records.some((r) => r.hostId === u.id));
  if (!users.length) return '';
  const rows = users.map((u) => {
    const ur = records.filter((r) => r.hostId === u.id);
    const roomCells = app.data.rooms.map((room) => {
      const rs = ur.filter((r) => Number(r.roomId) === Number(room.id));
      const count = rs.length;
      const avgPeak = count ? rs.reduce((sum, r) => sum + (Number(r.peak) || 0), 0) / count : 0;
      return '<div class="user-room-cell"><div class="room-name">' + escapeHtml(room.name) + '</div><div class="room-count">' + count + ' 次</div><div class="room-avg">均峰 ' + (avgPeak ? avgPeak.toFixed(avgPeak >= 100 ? 0 : 1) : '0') + '</div></div>';
    }).join('');
    const totalCount = ur.length;
    const totalAvg = totalCount ? ur.reduce((sum, r) => sum + (Number(r.peak) || 0), 0) / totalCount : 0;
    return '<div class="user-room-card">' +
      '<div class="user-room-head">' + avatarHtml(u, 'avatar-md') + '<div class="user-room-name">' + escapeHtml(u.name) + '</div><div class="user-room-total">' + totalCount + ' 次 · 均峰 ' + totalAvg.toFixed(totalAvg >= 100 ? 0 : 1) + '</div></div>' +
      '<div class="user-room-grid">' + roomCells + '</div>' +
    '</div>';
  }).join('');
  return '<div class="section-head"><div><div class="section-title">按主持人统计</div><div class="section-desc">各直播间直播次数与平均' + escapeHtml(fieldName('peak', '高峰人数')) + '</div></div></div>' +
    '<div class="card">' + rows + '</div>';
}

function renderTrendCard(records) {
  if (app.range === 'today' || app.range === 'yesterday') return '';
  const metric = app.metric;
  const aggregates = [];
  if (app.range === 'year') {
    for (let m = 1; m <= 12; m++) {
      const key = String(app.year) + '-' + String(m).padStart(2, '0');
      const list = records.filter((r) => String(r.date || '').startsWith(key));
      const peakValues = list.map((r) => Number(r.peak) || 0);
      aggregates.push({ key, label: m + '月', count: list.length, duration: list.reduce((s, r) => s + (Number(r.duration) || 0), 0) / 60, peak: peakValues.length ? peakValues.reduce((s, v) => s + v, 0) / peakValues.length : 0 });
    }
  } else {
    const days = daysInMonth(app.month);
    for (let day = 1; day <= days; day++) {
      const date = app.month + '-' + String(day).padStart(2, '0');
      const list = records.filter((r) => r.date === date);
      const peakValues = list.map((r) => Number(r.peak) || 0);
      aggregates.push({ key: date, label: day + '日', count: list.length, duration: list.reduce((s, r) => s + (Number(r.duration) || 0), 0) / 60, peak: peakValues.length ? peakValues.reduce((s, v) => s + v, 0) / peakValues.length : 0 });
    }
  }
  const values = aggregates.map((i) => metric === 'peak' ? i.peak : metric === 'duration' ? i.duration : i.count);
  const maxValue = Math.max(...values, 1);
  const bars = aggregates.map((i) => {
    const value = metric === 'peak' ? i.peak : metric === 'duration' ? i.duration : i.count;
    const height = value > 0 ? Math.max(5, (value / maxValue) * 132) : 4;
    const display = metric === 'duration' ? (value ? value.toFixed(value >= 10 ? 0 : 1) : '') : (value ? formatNumber(value, value % 1 ? 1 : 0) : '');
    return '<div class="bar-col" title="' + escapeHtml(i.key) + '">' +
      '<div class="bar-value">' + escapeHtml(display) + '</div>' +
      '<div class="bar-track"><div class="bar-fill ' + (metric === 'peak' ? 'success' : metric === 'duration' ? 'warning' : '') + '" style="height:' + height + 'px"></div></div>' +
      '<div class="bar-label">' + escapeHtml(i.label) + '</div>' +
    '</div>';
  }).join('');
  return '<div class="section-head"><div><div class="section-title">趋势分析</div><div class="section-desc">' + (app.range === 'year' ? app.year + '年按月' : monthLabel(app.month) + '按日') + '柱状趋势</div></div></div>' +
    '<div class="card chart-card">' +
      '<div class="chart-head"><div class="section-title" style="font-size:14px">' + metricLabel(metric) + '</div><div class="segmented">' +
        Object.keys(METRICS).map((key) => '<button class="' + (metric === key ? 'active' : '') + '" data-action="metric" data-metric="' + key + '">' + metricLabel(key) + '</button>').join('') +
      '</div></div>' +
      (records.length ? '<div class="chart-scroll"><div class="chart-inner">' + bars + '</div></div>' : '<div class="chart-empty">暂无数据</div>') +
    '</div>';
}

function renderRecordsList(records) {
  const list = records.slice().sort((a, b) => String(b.date).localeCompare(String(a.date)) || Number(b.startMinutes) - Number(a.startMinutes));
  return '<div class="section-head"><div><div class="section-title">直播记录</div><div class="section-desc">共 ' + list.length + ' 条</div></div></div>' +
    (list.length ? '<div class="record-list">' + list.map(renderRecordCard).join('') + '</div>' : '<div class="empty"><div class="empty-icon">▤</div><div class="empty-title">暂无记录</div><div class="empty-desc">到“打卡”页填写第一条直播数据。</div></div>');
}

function kpiCard(label, value, unit, sub, tone) {
  return '<div class="kpi ' + tone + '"><div class="kpi-label">' + escapeHtml(label) + '</div><div class="kpi-value">' + escapeHtml(value) + '<small>' + escapeHtml(unit) + '</small></div><div class="kpi-sub">' + escapeHtml(sub) + '</div></div>';
}

function monthlyHostStats(records) {
  const map = new Map();
  for (const record of records) {
    if (!map.has(record.hostId)) map.set(record.hostId, []);
    map.get(record.hostId).push(record);
  }
  return Array.from(map.entries()).map(([hostId, list]) => {
    const summary = recordSummary(list);
    return { hostId, ...summary };
  }).sort((a, b) => b.count - a.count || b.averagePeak - a.averagePeak);
}

function renderRecordCard(record) {
  const date = parseLocalDate(record.date);
  const room = roomById(record.roomId);
  const editable = canEditRecord(record);
  const host = app.data.users.find((u) => u.id === record.hostId);
  const custom = customFields().map((field) => {
    const value = record.fields?.[field.key];
    if (value === undefined || value === null || value === '') return null;
    return '<span class="room-tag r2">' + escapeHtml(field.name) + '：' + escapeHtml(value) + '</span>';
  }).filter(Boolean).join('');
  const violationTag = record.violation === '有' ? '<span class="room-tag r3">违规：' + escapeHtml(record.violationReason || '') + (record.violationResult ? ' · ' + escapeHtml(record.violationResult) : '') + '</span>' : '';
  return '<article class="record-card">' +
    '<div class="record-date"><div class="record-day">' + date.getDate() + '</div><div class="record-month">' + (date.getMonth() + 1) + '月</div></div>' +
    '<div class="record-main">' +
      '<div class="record-title">' + avatarHtml(host, 'avatar-xs') + escapeHtml(userName(record.hostId)) + '<span class="room-tag r' + Number(record.roomId) + '">' + escapeHtml(room.name) + '</span></div>' +
      '<div class="record-meta">' + minutesToTime(record.startMinutes) + ' 开播 · ' + durationText(record.duration) + (violationTag ? '<br>' + violationTag : '') + (record.note ? '<br>' + escapeHtml(record.note) : '') + (custom ? '<br>' + custom : '') + '</div>' +
    '</div>' +
    '<div class="record-peak"><b>' + formatNumber(record.peak) + '</b><span>' + escapeHtml(fieldName('peak', '高峰人数')) + '</span></div>' +
    (editable ? '<button class="icon-btn" data-action="edit-record" data-id="' + record.id + '">✎</button>' : '') +
  '</article>';
}

function renderStaff() {
  const users = activeUsers().sort((a, b) => (a.role === 'admin' ? -1 : 1) - (b.role === 'admin' ? -1 : 1) || String(a.name).localeCompare(String(b.name), 'zh-CN'));
  return '<section>' +
    '<div class="hero" style="padding:19px">' +
      '<div class="hero-row"><div><div class="hero-label">团队邀请码</div><div style="font-size:20px;font-weight:850;letter-spacing:1.2px">' + escapeHtml(app.teamCode) + '</div><div class="hero-note">主持人扫码加入后，用手机号登录</div></div><button class="btn" style="background:rgba(255,255,255,.17);color:#fff;min-height:42px;padding:0 13px;font-size:12px" data-action="invite">生成二维码</button></div>' +
    '</div>' +
    '<div class="section-head"><div><div class="section-title">直播间</div><div class="section-desc">名称可自定义</div></div><button class="link-btn" data-action="add-room">＋ 新增</button></div>' +
    '<div class="record-list">' + app.data.rooms.map((room) => '<article class="card card-tight staff-card">' +
      '<div class="staff-avatar">' + escapeHtml(String(room.name || '').slice(0, 1)) + '</div>' +
      '<div class="staff-main"><div class="staff-name">' + escapeHtml(room.name) + '</div><div class="staff-phone">' + escapeHtml(room.channel || '视频号') + '</div></div>' +
      '<button class="icon-btn" data-action="edit-room" data-id="' + room.id + '">✎</button>' +
    '</article>').join('') + '</div>' +
    '<div class="section-head" style="margin-top:18px"><div><div class="section-title">主持人账号</div><div class="section-desc">设置登录账号和可使用的直播间范围</div></div><button class="link-btn" data-action="add-user">＋ 新增</button></div>' +
    '<div class="record-list">' + users.map(renderStaffCard).join('') + '</div>' +
    '<div class="section-head" style="margin-top:18px"><div><div class="section-title">统计项</div><div class="section-desc">自定义每条直播记录要填写的数据项</div></div><button class="link-btn" data-action="manage-fields">管理</button></div>' +
    '<button class="btn btn-soft btn-block" style="margin-bottom:10px" data-action="edit-violation-reasons">编辑“违规原因”选项</button>' +
  '</section>';
}

function renderStaffCard(user) {
  const scope = user.role === 'admin' ? ['全部权限'] : (user.roomIds || []).map((id) => roomById(id).name);
  const disabled = user.status === 'disabled';
  return '<article class="card card-tight staff-card">' +
    '<div class="staff-avatar">' + escapeHtml(userInitial(user.name)) + '</div>' +
    '<div class="staff-main">' +
      '<div class="staff-name">' + escapeHtml(user.name) + (user.role === 'admin' ? '<span class="room-tag">管理员</span>' : '') + (disabled ? '<span class="room-tag r3">已停用</span>' : '') + '</div>' +
      '<div class="staff-phone">' + escapeHtml(user.phone) + ' · ' + (user.viewAll || user.role === 'admin' ? '可查看全员数据' : '仅查看自己的数据') + '</div>' +
      '<div class="staff-scope">' + scope.map((name) => '<span class="scope-tag on">' + escapeHtml(name) + '</span>').join('') + '</div>' +
    '</div>' +
    '<button class="icon-btn" data-action="edit-user" data-id="' + user.id + '">✎</button>' +
  '</article>';
}

function renderProfile() {
  const user = resolveUser();
  const rooms = user.role === 'admin' ? ['全部直播间'] : allowedRooms(user).map((room) => room.name);
  return '<section>' +
    '<div class="card">' +
      '<div class="profile-head">' +
        '<div class="profile-avatar">' + escapeHtml(avatarText(user)) + '</div>' +
        '<div style="flex:1;min-width:0"><div class="profile-name">' + escapeHtml(user.name) + '</div><div class="profile-meta">' + escapeHtml(user.phone) + ' · ' + (user.role === 'admin' ? '管理员' : '主持人') + '</div><div class="staff-scope">' + rooms.map((name) => '<span class="scope-tag on">' + escapeHtml(name) + '</span>').join('') + '</div></div>' +
        '<button class="btn btn-soft" data-action="edit-profile">编辑资料</button>' +
      '</div>' +
      '<div class="stat-row"><span class="stat-row-label">云端同步</span><span id="profile-sync-status" class="stat-row-value text-primary">' + escapeHtml(app.syncMessage) + '</span></div>' +
      '<div class="stat-row"><span class="stat-row-label">团队名称</span><span class="stat-row-value">' + escapeHtml(app.data.meta.teamName) + '</span></div>' +
      '<div class="stat-row"><span class="stat-row-label">数据版本</span><span class="stat-row-value">v' + Number(app.data.meta.revision || 1) + '</span></div>' +
    '</div>' +
    '<div class="section-head"><div class="section-title">账号安全</div></div>' +
    '<div class="card card-tight"><button class="btn btn-ghost btn-block" data-action="change-password">修改登录密码</button></div>' +
    '<div class="section-head"><div class="section-title">数据管理</div></div>' +
    '<div class="card card-tight">' +
      '<div class="btn-row"><button class="btn btn-soft" data-action="sync-now">立即同步</button><button class="btn btn-soft" data-action="export-data">导出备份</button><button class="btn btn-soft" data-action="import-data">导入备份</button></div>' +
      '<input id="import-file" type="file" accept="application/json,.json" style="display:none" />' +
      (user.role === 'admin' ? '<button class="btn btn-ghost btn-block" style="margin-top:10px" data-action="invite">邀请二维码</button>' : '') +
      '<button class="btn btn-danger btn-block" style="margin-top:10px" data-action="logout">退出登录</button>' +
    '</div>' +
    '<p class="safe-note">直播数据统计 v' + APP_VERSION + '<br>数据经加密后保存，请妥善保管团队码。</p>' +
  '</section>';
}


function openSheet(title, body, options = {}) {
  const root = $('#sheet-root');
  root.innerHTML = '<div class="sheet-backdrop" data-action="close-sheet"></div><section class="sheet"><div class="sheet-handle"></div><div class="sheet-head"><div class="sheet-title">' + escapeHtml(title) + '</div><button class="sheet-close" data-action="close-sheet">×</button></div><div class="sheet-body">' + body + '</div></section>';
  requestAnimationFrame(() => $$('.sheet-backdrop,.sheet').forEach((el) => el.classList.add('show')));
  if (options.onMount) requestAnimationFrame(() => options.onMount(root));
}

function closeSheet() {
  const root = $('#sheet-root');
  if (!root.children.length) return;
  $$('.sheet-backdrop,.sheet').forEach((el) => el.classList.remove('show'));
  setTimeout(() => { root.innerHTML = ''; }, 230);
}

function openModal({ title, text, confirmText = '确定', cancelText = '取消', danger = false, onConfirm }) {
  const root = $('#modal-root');
  root.innerHTML = '<div class="modal-backdrop" data-action="close-modal"></div><section class="modal"><div class="modal-title">' + escapeHtml(title) + '</div><div class="modal-text">' + text + '</div><div class="btn-row"><button class="btn btn-ghost" data-action="close-modal">' + escapeHtml(cancelText) + '</button><button class="btn ' + (danger ? 'btn-danger' : 'btn-primary') + '" id="modal-confirm">' + escapeHtml(confirmText) + '</button></div></section>';
  requestAnimationFrame(() => $$('.modal-backdrop,.modal').forEach((el) => el.classList.add('show')));
  $('#modal-confirm').onclick = async () => { closeModal(); if (onConfirm) await onConfirm(); };
}

function closeModal() {
  const root = $('#modal-root');
  if (!root.children.length) return;
  $$('.modal-backdrop,.modal').forEach((el) => el.classList.remove('show'));
  setTimeout(() => { root.innerHTML = ''; }, 210);
}

function wheelHtml(name, label, items, value, compact = false) {
  return '<div class="picker-block">' +
    '<div class="picker-label"><span>' + escapeHtml(label) + '</span><small data-wheel-label="' + name + '"></small></div>' +
    '<div class="wheel-shell"><div class="wheel" data-wheel="' + name + '" data-value="' + escapeHtml(value) + '">' +
      items.map((item) => '<button type="button" class="wheel-item ' + (compact ? 'compact' : '') + '" data-value="' + escapeHtml(item.value) + '">' + escapeHtml(item.label) + '</button>').join('') +
    '</div></div>' +
  '</div>';
}

function bindWheels(root = document) {
  $$('.wheel', root).forEach((wheel) => {
    if (wheel.dataset.bound) return;
    wheel.dataset.bound = '1';
    const update = () => {
      const center = wheel.scrollLeft + wheel.clientWidth / 2;
      let closest = null;
      let distance = Infinity;
      $$('.wheel-item', wheel).forEach((item) => {
        const itemCenter = item.offsetLeft + item.offsetWidth / 2;
        const current = Math.abs(itemCenter - center);
        if (current < distance) { distance = current; closest = item; }
      });
      if (!closest) return;
      $$('.wheel-item', wheel).forEach((item) => item.classList.toggle('active', item === closest));
      wheel.dataset.value = closest.dataset.value;
      const label = $('[data-wheel-label="' + wheel.dataset.wheel + '"]', root);
      if (label) label.textContent = closest.textContent.trim();
    };
    let timer = null;
    wheel.addEventListener('scroll', () => {
      clearTimeout(timer);
      timer = setTimeout(update, 90);
    }, { passive: true });
    wheel.addEventListener('click', (event) => {
      const item = event.target.closest('.wheel-item');
      if (!item) return;
      item.scrollIntoView({ behavior: 'smooth', inline: 'center', block: 'nearest' });
      setTimeout(update, 250);
    });
    setWheelValue(wheel.dataset.wheel, wheel.dataset.value, root);
  });
}

function setWheelValue(name, value, root = document) {
  const wheel = $('[data-wheel="' + name + '"]', root);
  if (!wheel) return;
  let item = $$('.wheel-item', wheel).find((node) => String(node.dataset.value) === String(value));
  if (!item) item = $('.wheel-item', wheel);
  if (!item) return;
  setTimeout(() => {
    const left = item.offsetLeft - (wheel.clientWidth - item.offsetWidth) / 2;
    wheel.scrollTo({ left: Math.max(0, left), behavior: 'auto' });
    $$('.wheel-item', wheel).forEach((node) => node.classList.toggle('active', node === item));
    wheel.dataset.value = item.dataset.value;
    const label = $('[data-wheel-label="' + name + '"]', root);
    if (label) label.textContent = item.textContent.trim();
  }, 30);
}

function getWheelValue(name) {
  return $('[data-wheel="' + name + '"]')?.dataset.value || '';
}

function roundToHalfHour(date = new Date()) {
  const minutes = date.getHours() * 60 + date.getMinutes();
  return Math.max(0, Math.min(1410, Math.round(minutes / 30) * 30));
}

function recordFormHtml(existing, inline) {
  const user = resolveUser();
  if (!app.data || !user) return '';
  const editableHosts = user.role === 'admin' ? activeUsers() : [user];
  const initialHost = existing?.hostId || user.id;
  const initialRoom = existing?.roomId || allowedRooms(user)[0]?.id || app.data.rooms[0]?.id || 1;
  const initialDate = existing?.date || localDate();
  const initialStart = Number.isFinite(Number(existing?.startMinutes)) ? Number(existing.startMinutes) : roundToHalfHour();
  const initialDuration = Number(existing?.duration) || 60;
  const initialPeak = existing?.peak ?? '';
  const initialNote = existing?.note || '';
  const initialViolation = existing?.violation || '无';
  const initialViolationReason = existing?.violationReason || '';
  const initialViolationResult = existing?.violationResult || '';
  const fields = app.data.fields || DEFAULT_FIELDS;

  const dateItems = [];
  for (let offset = -90; offset <= 90; offset++) {
    const value = addDays(localDate(), offset);
    const d = parseLocalDate(value);
    const weekday = ['日', '一', '二', '三', '四', '五', '六'][d.getDay()];
    dateItems.push({ value, label: (d.getMonth() + 1) + '月' + d.getDate() + '日 周' + weekday });
  }
  const timeItems = [];
  for (let minute = 0; minute < 1440; minute += 30) timeItems.push({ value: minute, label: minutesToTime(minute) });
  const durationItems = [];
  for (let minute = 30; minute <= 480; minute += 30) durationItems.push({ value: minute, label: durationText(minute) });
  const roomItems = allowedRooms(user).map((room) => ({ value: room.id, label: room.name }));
  const hostItems = editableHosts.map((host) => ({ value: host.id, label: host.name }));

  const valueOf = (field) => {
    if (field.key === 'date') return initialDate;
    if (field.key === 'start') return initialStart;
    if (field.key === 'duration') return initialDuration;
    if (field.key === 'peak') return initialPeak;
    if (field.key === 'note') return initialNote;
    return existing?.fields?.[field.key] ?? '';
  };

  const violationOptions = ['无', '有'].map((v) => '<button type="button" class="option ' + (initialViolation === v ? 'active' : '') + '" data-action="violation-toggle" data-value="' + v + '">' + v + '</button>').join('');
  const reasonOptions = (app.data.violationReasons || DEFAULT_VIOLATION_REASONS).map((r) => '<button type="button" class="option ' + (initialViolationReason === r ? 'active' : '') + '" data-action="violation-reason" data-value="' + escapeHtml(r) + '">' + escapeHtml(r) + '</button>').join('');
  const violationHtml = '<div class="form-group"><label class="form-label">有无违规</label><div class="option-grid" id="violation-options">' + violationOptions + '</div></div>' +
    '<div id="violation-detail" style="' + (initialViolation === '有' ? '' : 'display:none') + '">' +
      '<div class="form-group"><label class="form-label">违规原因</label><div class="option-grid" id="violation-reason-options">' + reasonOptions + '</div></div>' +
      '<div class="form-group"><label class="form-label">处罚结果</label><textarea id="violation-result" class="input" rows="2" maxlength="120" placeholder="请输入处罚结果">' + escapeHtml(initialViolationResult) + '</textarea></div>' +
    '</div>';

  const fieldHtml = fields.map((field) => {
    const name = escapeHtml(field.name);
    if (field.key === 'date') {
      return wheelHtml('record-date', field.name, dateItems, initialDate) +
        '<button class="btn btn-soft btn-block" style="min-height:42px;margin:-8px 0 17px" data-action="date-today">跳到今天</button>';
    }
    if (field.key === 'start') return wheelHtml('record-start', field.name, timeItems, initialStart, true);
    if (field.key === 'duration') return wheelHtml('record-duration', field.name, durationItems, initialDuration);
    if (field.key === 'violation') return violationHtml;
    if (field.type === 'number') {
      const step = field.key === 'peak' ? 10 : 1;
      return '<div class="picker-block"><div class="picker-label"><span>' + name + '</span><small>手工填写</small></div><div class="peak-row">' +
        '<button class="peak-step" data-action="num-step" data-key="' + field.key + '" data-step="-' + step + '">−</button>' +
        '<input id="field-' + field.key + '" class="input" type="number" min="0" step="1" inputmode="numeric" value="' + escapeHtml(valueOf(field)) + '" placeholder="请输入" />' +
        '<button class="peak-step" data-action="num-step" data-key="' + field.key + '" data-step="' + step + '">＋</button>' +
        '</div></div>';
    }
    if (field.type === 'select') {
      const current = valueOf(field);
      const options = (field.options || []).map((option) =>
        '<button type="button" class="option ' + (String(current) === String(option) ? 'active' : '') + '" data-action="field-option" data-key="' + field.key + '" data-value="' + escapeHtml(option) + '">' + escapeHtml(option) + '</button>'
      ).join('');
      return '<div class="form-group"><label class="form-label">' + name + '</label><div class="option-grid">' + options + '</div></div>';
    }
    if (field.key === 'note') {
      return '<div class="form-group"><label class="form-label">' + name + '</label><textarea id="field-note" class="input" rows="2" maxlength="120" placeholder="例如：节日场、活动场、异常情况">' + escapeHtml(initialNote) + '</textarea></div>';
    }
    return '<div class="form-group"><label class="form-label">' + name + '</label><input id="field-' + field.key + '" class="input" maxlength="120" value="' + escapeHtml(valueOf(field)) + '" placeholder="请输入" /></div>';
  }).join('');

  const hostHtml = user.role === 'admin'
    ? wheelHtml('record-host', '主持人', hostItems, initialHost, true)
    : '<div class="form-group"><label class="form-label">主持人</label><div class="input" style="display:flex;align-items:center;justify-content:space-between"><span>' + escapeHtml(user.name) + '</span><span class="muted" style="font-size:12px">当前账号</span></div></div>';

  const buttons = inline
    ? '<button class="btn btn-primary btn-block" style="min-height:50px;font-size:16px" data-action="save-record" data-id="">提交打卡</button>'
    : '<div class="record-form-actions"><button class="btn btn-ghost" data-action="close-sheet">取消</button><button class="btn btn-primary" data-action="save-record" data-id="' + (existing?.id || '') + '">' + (existing ? '保存修改' : '保存记录') + '</button></div>' + (existing ? '<button class="btn btn-danger btn-block" style="margin-top:10px" data-action="delete-record" data-id="' + existing.id + '">删除这条记录</button>' : '');

  return '<div>' + hostHtml + wheelHtml('record-room', '直播间', roomItems, initialRoom, true) + fieldHtml + buttons + '</div>';
}

function openRecordEditor(recordId) {
  const user = resolveUser();
  if (!app.data || !user) return;
  const existing = recordId ? app.data.records.find((item) => item.id === recordId && !item.deletedAt) : null;
  if (existing && !canEditRecord(existing)) {
    toast('你没有编辑这条记录的权限', 'error');
    return;
  }
  openSheet(existing ? '编辑直播记录' : '新增直播记录', recordFormHtml(existing, false), { onMount: bindWheels });
}

function renderHome() {
  const user = resolveUser();
  return '<section>' +
    '<div class="hero"><div class="hero-row"><div><div class="hero-label">' + escapeHtml(dateLabel(localDate())) + ' 打卡</div><div class="hero-value">直播数据</div><div class="hero-note">' + escapeHtml(user.name) + ' · 填写完成后点击“提交打卡”</div></div>' + renderSyncBadge() + '</div></div>' +
    '<div class="card" style="margin-top:14px;padding:18px 16px">' + recordFormHtml(null, true) + '</div>' +
  '</section>';
}

async function saveRecord(id) {
  const user = resolveUser();
  const fromHome = app.tab === 'home';
  const hostId = user.role === 'admin' ? getWheelValue('record-host') : user.id;
  const roomId = Number(getWheelValue('record-room'));
  const date = getWheelValue('record-date');
  const startMinutes = Number(getWheelValue('record-start'));
  const duration = Number(getWheelValue('record-duration'));
  const peakText = String($('#field-peak')?.value || '').trim();
  const peak = Number(peakText);
  const note = String($('#field-note')?.value || '').trim();
  const violation = $('[data-action="violation-toggle"].active')?.dataset.value || '无';
  const violationReason = violation === '有' ? String($('[data-action="violation-reason"].active')?.dataset.value || '').trim() : '';
  const violationResult = violation === '有' ? String($('#violation-result')?.value || '').trim() : '';
  if (!hostId || !roomId || !date) { toast('请选择主持人和直播间', 'error'); return; }
  if (!peakText || !Number.isFinite(peak) || peak < 0) { toast('请手工填写' + fieldName('peak', '在线高峰人数'), 'error'); return; }
  if (violation === '有' && !violationReason) { toast('请选择违规原因', 'error'); return; }
  if (user.role !== 'admin') {
    const host = app.data.users.find((item) => item.id === user.id);
    if (!host || !(host.roomIds || []).map(Number).includes(roomId)) { toast('你没有该直播间的使用权限', 'error'); return; }
  }
  const customValues = {};
  for (const field of customFields()) {
    let value = '';
    if (field.type === 'select') {
      value = $('[data-action="field-option"].active[data-key="' + field.key + '"]')?.dataset.value || '';
    } else {
      value = String($('#field-' + field.key)?.value || '').trim();
    }
    if (field.type === 'number') {
      value = value === '' ? '' : (Number.isFinite(Number(value)) ? Number(value) : '');
    }
    customValues[field.key] = value;
  }
  await commitChange((data) => {
    const now = new Date().toISOString();
    let record = id ? data.records.find((item) => item.id === id && !item.deletedAt) : null;
    if (record) {
      if (!canEditRecord(record)) throw new Error('没有编辑权限');
      Object.assign(record, { hostId, roomId, date, startMinutes, duration, peak, note, violation, violationReason, violationResult, fields: customValues, updatedAt: now });
    } else {
      record = { id: uid('rec'), hostId, roomId, date, startMinutes, duration, peak, note, violation, violationReason, violationResult, fields: customValues, createdAt: now, updatedAt: now, createdBy: user.id };
      data.records.push(record);
    }
  });
  if (fromHome) {
    toast('打卡成功', 'success');
    render();
  } else {
    closeSheet();
    toast('直播记录已保存', 'success');
    app.tab = 'stats';
    app.month = monthKey(date);
    render();
  }
}

function deleteRecord(id) {
  const record = app.data.records.find((item) => item.id === id && !item.deletedAt);
  if (!record || !canEditRecord(record)) return;
  openModal({
    title: '删除直播记录',
    text: '确定删除 ' + escapeHtml(userName(record.hostId)) + ' 在 ' + escapeHtml(record.date) + ' 的记录吗？删除后月度统计会同步更新。',
    confirmText: '删除',
    danger: true,
    onConfirm: async () => {
      await commitChange((data) => {
        const target = data.records.find((item) => item.id === id);
        if (target) {
          target.deletedAt = new Date().toISOString();
          target.updatedAt = target.deletedAt;
        }
      });
      closeSheet();
      toast('记录已删除');
    }
  });
}

function openMonthPicker() {
  const currentYear = Number(app.month.slice(0, 4));
  const currentMonth = Number(app.month.slice(5, 7));
  const nowYear = new Date().getFullYear();
  const years = [];
  for (let year = Math.min(2023, currentYear); year <= Math.max(nowYear + 3, currentYear + 2); year++) years.push({ value: year, label: year + '年' });
  const months = Array.from({ length: 12 }, (_, index) => ({ value: index + 1, label: (index + 1) + '月' }));
  openSheet('选择统计月份', '<div>' + wheelHtml('month-year', '年份', years, currentYear, true) + wheelHtml('month-number', '月份', months, currentMonth, true) + '<button class="btn btn-primary btn-block" data-action="confirm-month">确定</button></div>', { onMount: bindWheels });
}

function confirmMonth() {
  const year = Number(getWheelValue('month-year'));
  const month = Number(getWheelValue('month-number'));
  if (!year || !month) return;
  app.month = year + '-' + String(month).padStart(2, '0');
  app.range = 'month';
  closeSheet();
  render();
}

function openUserEditor(userId) {
  if (!canManageUsers()) return;
  const editing = userId ? app.data.users.find((user) => user.id === userId && !user.deletedAt) : null;
  const isSelf = editing?.id === resolveUser()?.id;
  const name = editing?.name || '';
  const phone = editing?.phone || '';
  const role = editing?.role || 'host';
  const roomIds = editing?.roomIds ? editing.roomIds.map(Number) : app.data.rooms.map((room) => Number(room.id));
  const viewAll = Boolean(editing?.viewAll);
  const disabled = editing?.status === 'disabled';
  const roomOptions = app.data.rooms.map((room) => '<button type="button" class="option ' + (roomIds.includes(Number(room.id)) ? 'active' : '') + '" data-action="toggle-room-option" data-room="' + room.id + '">' + escapeHtml(room.name) + '</button>').join('');
  const body = '<div>' +
    '<div class="form-group"><label class="form-label">姓名</label><input id="user-name" class="input" maxlength="20" value="' + escapeHtml(name) + '" placeholder="主持人姓名" /></div>' +
    '<div class="form-group"><label class="form-label">登录手机号</label><input id="user-phone" class="input" inputmode="numeric" maxlength="11" value="' + escapeHtml(phone) + '" placeholder="11 位手机号" /></div>' +
    '<div class="form-group"><label class="form-label">账号角色</label><div class="input" style="display:flex;align-items:center">' + (role === 'admin' ? '管理员（团队唯一）' : '主持人') + '</div></div>' +
    '<div class="form-group"><label class="form-label">可使用直播间</label><div class="option-grid" id="user-room-options">' + roomOptions + '</div><div class="form-hint">管理员默认拥有全部权限；主持人只能录入和修改被勾选直播间的数据。</div></div>' +
    '<div class="form-group"><label class="form-label">数据查看权限</label><div class="option-grid" id="user-scope-options"><button type="button" class="option ' + (!viewAll ? 'active' : '') + '" data-action="user-scope" data-value="self">只能查看自己数据</button><button type="button" class="option ' + (viewAll ? 'active' : '') + '" data-action="user-scope" data-value="all">可查看全部数据</button></div><div class="form-hint">“只能查看自己数据”指只能看到自己添加的统计记录。</div></div>' +
    (editing ? '<div class="card card-tight" style="margin-bottom:15px"><button type="button" class="check-row" style="width:100%;text-align:left" data-action="toggle-user-status"' + (isSelf ? ' disabled' : '') + '><span id="user-status-box" class="check-box ' + (disabled ? '' : 'checked') + '">✓</span><span class="check-label">账号启用</span></button></div>' : '') +
    '<div class="info-banner">' + (editing ? '如需将密码重置为手机号后 6 位，请点击下方按钮。' : '新账号默认密码为手机号后 6 位。') + '</div>' +
    '<div class="record-form-actions"><button class="btn btn-ghost" data-action="close-sheet">取消</button><button class="btn btn-primary" data-action="save-user" data-id="' + (editing?.id || '') + '">保存</button></div>' +
    (editing ? '<button class="btn btn-soft btn-block" style="margin-top:10px" data-action="reset-password" data-id="' + editing.id + '">重置密码为手机号后 6 位</button>' : '') +
    (editing && !isSelf ? '<button class="btn btn-danger btn-block" style="margin-top:10px" data-action="delete-user" data-id="' + editing.id + '">删除账号</button>' : '') +
  '</div>';
  openSheet(editing ? '编辑人员与权限' : '新增主持人', body);
}

async function saveUser(id) {
  if (!canManageUsers()) return;
  const editor = resolveUser();
  const name = String($('#user-name')?.value || '').trim();
  const phone = String($('#user-phone')?.value || '').trim();
  const role = (id ? app.data.users.find((user) => user.id === id && !user.deletedAt) : null)?.role === 'admin' ? 'admin' : 'host';
  const roomIds = $$('.option.active[data-action="toggle-room-option"]').map((el) => Number(el.dataset.room));
  const viewAll = $('[data-action="user-scope"].active')?.dataset.value === 'all';
  const enabled = $('#user-status-box') ? $('#user-status-box').classList.contains('checked') : true;
  if (!name) { toast('请输入姓名', 'error'); return; }
  if (!/^1\d{10}$/.test(phone)) { toast('请输入正确的 11 位手机号', 'error'); return; }
  const duplicate = app.data.users.find((user) => !user.deletedAt && user.phone === phone && user.id !== id);
  if (duplicate) { toast('该手机号已经存在', 'error'); return; }
  if (role === 'host' && !roomIds.length) { toast('请至少选择一个可用直播间', 'error'); return; }
  const editing = id ? app.data.users.find((user) => user.id === id && !user.deletedAt) : null;
  if (editing?.role === 'admin' && role !== 'admin' && activeUsers().filter((user) => user.role === 'admin').length <= 1) { toast('团队至少需要保留一名管理员', 'error'); return; }
  let passwordData = null;
  if (!editing) passwordData = await passwordRecord(phone.slice(-6));
  await commitChange((data) => {
    const now = new Date().toISOString();
    if (editing) {
      const target = data.users.find((user) => user.id === id);
      Object.assign(target, { name, phone, role, roomIds, viewAll: role === 'admin' ? true : viewAll, status: enabled ? 'active' : 'disabled', updatedAt: now });
    } else {
      data.users.push({
        id: uid('usr'), name, phone, role,
        roomIds: role === 'admin' ? data.rooms.map((room) => Number(room.id)) : roomIds,
        viewAll: role === 'admin' ? true : Boolean(viewAll),
        status: 'active',
        password: passwordData,
        createdAt: now,
        updatedAt: now,
        createdBy: editor.id
      });
    }
  });
  closeSheet();
  toast(editing ? '人员信息已更新' : '主持人已新增，初始密码为手机号后 6 位', 'success');
}

function resetUserPassword(id) {
  const target = app.data.users.find((user) => user.id === id && !user.deletedAt);
  if (!target || !canManageUsers()) return;
  openModal({
    title: '重置密码',
    text: '将 ' + escapeHtml(target.name) + ' 的密码重置为手机号后 6 位：<b>' + escapeHtml(target.phone.slice(-6)) + '</b>',
    confirmText: '确认重置',
    onConfirm: async () => {
      const record = await passwordRecord(target.phone.slice(-6));
      await commitChange((data) => {
        const user = data.users.find((item) => item.id === id);
        user.password = record;
        user.passwordUpdatedAt = new Date().toISOString();
        user.updatedAt = user.passwordUpdatedAt;
      });
      closeSheet();
      toast('密码已重置', 'success');
    }
  });
}

function deleteUser(id) {
  if (!canManageUsers()) return;
  const target = app.data.users.find((user) => user.id === id && !user.deletedAt);
  if (!target) return;
  if (target.id === resolveUser()?.id) { toast('不能删除当前登录的管理员账号', 'error'); return; }
  openModal({
    title: '删除账号',
    text: '确定删除主持人 <b>' + escapeHtml(target.name) + '</b> 吗？历史直播记录会保留，账号将无法再登录。',
    confirmText: '删除账号',
    danger: true,
    onConfirm: async () => {
      await commitChange((data) => {
        const user = data.users.find((item) => item.id === id);
        user.deletedAt = new Date().toISOString();
        user.status = 'disabled';
        user.updatedAt = user.deletedAt;
      });
      closeSheet();
      toast('账号已删除');
    }
  });
}

function manageFields() {
  if (!canManageUsers()) return;
  const fields = app.data.fields || DEFAULT_FIELDS;
  const typeLabel = { date: '日期', time: '时间', duration: '时长', number: '数字', text: '文本', select: '选项', violation: '违规' };
  const body = '<div>' +
    fields.map((field) =>
      '<div class="card card-tight" style="display:flex;align-items:center;justify-content:space-between;margin-bottom:10px">' +
        '<div style="min-width:0;flex:1"><div class="staff-name" style="font-size:15px">' + escapeHtml(field.name) + '</div><div class="staff-phone" style="font-size:12px">' + escapeHtml(typeLabel[field.type] || field.type) + (field.type === 'select' ? '（' + (field.options || []).length + ' 个选项）' : '') + (field.fixed ? ' · 基础项' : ' · 自定义项') + '</div></div>' +
        '<div style="display:flex;gap:6px"><button class="icon-btn" data-action="edit-field" data-id="' + field.id + '">✎</button>' + (!field.fixed ? '<button class="icon-btn" data-action="delete-field" data-id="' + field.id + '">✕</button>' : '') + '</div>' +
      '</div>'
    ).join('') +
    '<button class="btn btn-soft btn-block" style="margin-top:6px" data-action="add-field">＋ 新增统计项</button>' +
    '<div class="info-banner" style="margin-top:12px">基础项（日期、开播时间、直播时长、在线高峰人数、备注）不可删除，但可修改显示名称；自定义项可自由新增、编辑和删除。</div>' +
  '</div>';
  openSheet('统计项管理', body);
}

function openFieldEditor(fieldId) {
  if (!canManageUsers()) return;
  const existing = fieldId ? (app.data.fields || []).find((item) => item.id === fieldId) : null;
  const field = existing ? jsonClone(existing) : { id: uid('fld'), key: 'custom_' + uid('').replace(/[^a-zA-Z0-9]/g, '').slice(0, 8), name: '', type: 'text', required: false, fixed: false, options: [] };
  app.editingFieldId = fieldId || '';
  app.fieldDraft = field;
  const typeLabels = { number: '数字', text: '文本', select: '选项' };
  const typeOptions = ['number', 'text', 'select'].map((type) => '<button type="button" class="option ' + (field.type === type ? 'active' : '') + '" data-action="field-type" data-type="' + type + '">' + typeLabels[type] + '</button>').join('');
  const body = '<div>' +
    '<div class="form-group"><label class="form-label">统计项名称</label><input id="field-name" class="input" maxlength="20" value="' + escapeHtml(field.name) + '" placeholder="例如：点赞数" /></div>' +
    (field.fixed
      ? '<div class="info-banner">这是基础统计项，只能修改显示名称。</div>'
      : '<div class="form-group"><label class="form-label">内容类型</label><div class="option-grid" id="field-type-options">' + typeOptions + '</div></div>' +
        '<div class="form-group" id="field-options-wrap" style="' + (field.type === 'select' ? '' : 'display:none') + '"><label class="form-label">选项（每行一个）</label><textarea id="field-options" class="input" rows="5" placeholder="好评&#10;一般&#10;差评">' + escapeHtml((field.options || []).join('\n')) + '</textarea></div>') +
    '<div class="record-form-actions"><button class="btn btn-ghost" data-action="close-sheet">取消</button><button class="btn btn-primary" data-action="save-field">保存</button></div>' +
  '</div>';
  openSheet(field.fixed ? '编辑基础项名称' : (existing ? '编辑统计项' : '新增统计项'), body);
}

async function saveField() {
  if (!canManageUsers()) return;
  const field = app.fieldDraft;
  if (!field) return;
  field.name = String($('#field-name')?.value || '').trim();
  if (!field.name) { toast('请输入统计项名称', 'error'); return; }
  if (!field.fixed) {
    field.type = $('[data-action="field-type"].active')?.dataset.type || field.type || 'text';
    if (field.type === 'select') {
      field.options = String($('#field-options')?.value || '').split('\n').map((s) => s.trim()).filter(Boolean);
      if (!field.options.length) { toast('请至少填写一个选项', 'error'); return; }
    } else {
      field.options = [];
    }
  }
  await commitChange((data) => {
    data.fields = data.fields || jsonClone(DEFAULT_FIELDS);
    const idx = data.fields.findIndex((item) => item.id === field.id);
    if (idx >= 0) data.fields[idx] = jsonClone(field);
    else data.fields.push(jsonClone(field));
  });
  app.fieldDraft = null;
  app.editingFieldId = '';
  toast('统计项已保存', 'success');
  manageFields();
}

function deleteField(fieldId) {
  if (!canManageUsers()) return;
  const field = (app.data.fields || []).find((item) => item.id === fieldId);
  if (!field || field.fixed) return;
  openModal({
    title: '删除统计项',
    text: '确定删除统计项 <b>' + escapeHtml(field.name) + '</b> 吗？已填写该统计项的历史记录中，该数据将不再显示。',
    confirmText: '删除',
    danger: true,
    onConfirm: async () => {
      await commitChange((data) => {
        data.fields = (data.fields || []).filter((item) => item.id !== fieldId);
      });
      closeSheet();
      toast('统计项已删除');
      manageFields();
    }
  });
}

function openRoomEditor(roomId) {
  if (!canManageUsers()) return;
  const room = roomId ? app.data.rooms.find((r) => String(r.id) === String(roomId)) : { id: '', name: '', channel: '视频号' };
  app.editingRoomId = roomId || '';
  const body = '<div>' +
    '<div class="form-group"><label class="form-label">直播间名称</label><input id="room-name" class="input" maxlength="20" value="' + escapeHtml(room.name) + '" placeholder="例如：一号直播间" /></div>' +
    '<div class="record-form-actions"><button class="btn btn-ghost" data-action="close-sheet">取消</button><button class="btn btn-primary" data-action="save-room">保存</button></div>' +
  '</div>';
  openSheet(roomId ? '编辑直播间' : '新增直播间', body);
}

async function saveRoom() {
  if (!canManageUsers()) return;
  const name = String($('#room-name')?.value || '').trim();
  if (!name) { toast('请输入直播间名称', 'error'); return; }
  await commitChange((data) => {
    const id = app.editingRoomId;
    if (id) {
      const room = data.rooms.find((r) => String(r.id) === String(id));
      if (room) room.name = name;
    } else {
      const newId = Math.max(0, ...data.rooms.map((r) => Number(r.id))) + 1;
      data.rooms.push({ id: newId, name, channel: '视频号' });
    }
  });
  app.editingRoomId = '';
  closeSheet();
  toast('直播间已保存', 'success');
  render();
}

function openProfileEditor() {
  const user = resolveUser();
  if (!user) return;
  app.profileAvatar = user.avatar || '';
  const body = '<div>' +
    '<div class="form-group"><label class="form-label">选择头像</label><div class="avatar-grid">' + AVATARS.map((a) => '<button type="button" class="avatar-option ' + (app.profileAvatar === a ? 'active' : '') + '" data-action="avatar" data-value="' + a + '">' + a + '</button>').join('') + '</div></div>' +
    '<div class="form-group"><label class="form-label">名称</label><input id="profile-name" class="input" maxlength="20" value="' + escapeHtml(user.name) + '" placeholder="请输入名称" /></div>' +
    '<div class="record-form-actions"><button class="btn btn-ghost" data-action="close-sheet">取消</button><button class="btn btn-primary" data-action="save-profile">保存</button></div>' +
  '</div>';
  openSheet('编辑我的资料', body);
}

async function saveProfile() {
  const name = String($('#profile-name')?.value || '').trim();
  if (!name) { toast('请输入名称', 'error'); return; }
  const avatar = app.profileAvatar || '';
  await commitChange((data) => {
    const u = data.users.find((x) => x.id === resolveUser().id);
    if (u) { u.name = name; u.avatar = avatar; }
  });
  closeSheet();
  toast('资料已保存', 'success');
}

function openViolationReasons() {
  if (!canManageUsers()) return;
  const body = '<div>' +
    '<div class="form-group"><label class="form-label">违规原因选项（每行一个）</label><textarea id="violation-reasons-input" class="input" rows="7" placeholder="低俗内容&#10;违规广告&#10;虚假宣传">' + escapeHtml((app.data.violationReasons || []).join('\n')) + '</textarea></div>' +
    '<div class="record-form-actions"><button class="btn btn-ghost" data-action="close-sheet">取消</button><button class="btn btn-primary" data-action="save-violation-reasons">保存</button></div>' +
  '</div>';
  openSheet('编辑违规原因选项', body);
}

async function saveViolationReasons() {
  if (!canManageUsers()) return;
  const list = String($('#violation-reasons-input')?.value || '').split('\n').map((x) => x.trim()).filter(Boolean);
  if (!list.length) { toast('请至少填写一个选项', 'error'); return; }
  await commitChange((data) => { data.violationReasons = list; });
  closeSheet();
  toast('违规原因已保存', 'success');
}

function openChangePassword() {
  const body = '<div>' +
    '<div class="form-group"><label class="form-label">当前密码</label><input id="old-password" class="input" type="password" maxlength="32" autocomplete="current-password" /></div>' +
    '<div class="form-group"><label class="form-label">新密码</label><input id="new-password" class="input" type="password" maxlength="32" autocomplete="new-password" placeholder="至少 6 位" /></div>' +
    '<div class="form-group"><label class="form-label">确认新密码</label><input id="confirm-password" class="input" type="password" maxlength="32" autocomplete="new-password" /></div>' +
    '<button class="btn btn-primary btn-block" data-action="submit-change-password">确认修改</button>' +
  '</div>';
  openSheet('修改登录密码', body);
}

async function submitChangePassword() {
  const user = resolveUser();
  const oldPassword = String($('#old-password')?.value || '');
  const newPassword = String($('#new-password')?.value || '');
  const confirmPassword = String($('#confirm-password')?.value || '');
  if (!oldPassword || !newPassword) { toast('请完整填写密码', 'error'); return; }
  if (newPassword.length < 6) { toast('新密码不能少于 6 位', 'error'); return; }
  if (newPassword !== confirmPassword) { toast('两次输入的新密码不一致', 'error'); return; }
  if (!(await verifyPassword(oldPassword, user.password))) { toast('当前密码不正确', 'error'); return; }
  const password = await passwordRecord(newPassword);
  await commitChange((data) => {
    const target = data.users.find((item) => item.id === user.id);
    target.password = password;
    target.passwordUpdatedAt = new Date().toISOString();
    target.updatedAt = target.passwordUpdatedAt;
  });
  closeSheet();
  toast('密码修改成功，请妥善保管', 'success');
}

function inviteUrl() {
  const url = new URL('.', location.href);
  url.hash = 'join=' + encodeURIComponent(app.teamCode);
  return url.toString();
}

function openInvite() {
  if (!app.teamCode) return;
  const body = '<div>' +
    '<div id="invite-qr" class="invite-qr"></div>' +
    '<div class="invite-code">' + escapeHtml(app.teamCode) + '</div>' +
    '<div class="info-banner">让主持人在手机浏览器中扫描上面的二维码，应用会自动填入团队码。加入后使用管理员设置的手机号和初始密码登录。</div>' +
    '<div class="btn-row" style="margin-top:14px"><button class="btn btn-soft" data-action="copy-invite">复制邀请链接</button><button class="btn btn-primary" data-action="share-invite">分享</button></div>' +
    
  '</div>';
  openSheet('邀请主持人加入', body, {
    onMount: () => {
      const target = $('#invite-qr');
      if (target && typeof QRCode !== 'undefined') {
        target.innerHTML = '';
        new QRCode(target, { text: inviteUrl(), width: 164, height: 164, colorDark: '#20233a', colorLight: '#ffffff', correctLevel: QRCode.CorrectLevel.M });
      } else if (target) {
        target.innerHTML = '<span class="muted" style="font-size:12px">二维码组件未加载</span>';
      }
    }
  });
}

async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    toast('已复制', 'success');
  } catch {
    const input = document.createElement('textarea');
    input.value = text;
    document.body.appendChild(input);
    input.select();
    document.execCommand('copy');
    input.remove();
    toast('已复制', 'success');
  }
}

async function installApp() {
  if (app.deferredPrompt) {
    app.deferredPrompt.prompt();
    const result = await app.deferredPrompt.userChoice;
    if (result.outcome === 'accepted') toast('正在安装到桌面', 'success');
    app.deferredPrompt = null;
    return;
  }
  openModal({
    title: '安装到安卓桌面',
    text: '<b>Chrome 浏览器：</b><br>1. 打开本应用网页；<br>2. 点击右上角“⋮”；<br>3. 选择“添加到主屏幕”或“安装应用”；<br>4. 确认后在桌面会出现独立图标。<br><br>如果已经安装过，可直接从桌面图标打开。',
    confirmText: '我知道了',
    cancelText: '关闭'
  });
}

function openInstallHelp() {
  return installApp();
}

async function createTeam() {
  const teamName = String($('#setup-team-name')?.value || '').trim();
  const adminName = String($('#setup-admin-name')?.value || '').trim();
  const phone = ADMIN_PHONE;
  let password = String($('#setup-admin-password')?.value || '');
  if (!teamName) { toast('请输入团队名称', 'error'); return; }
  if (!adminName) { toast('请输入管理员姓名', 'error'); return; }
  if (!/^1\d{10}$/.test(phone)) { toast('请输入正确的 11 位手机号', 'error'); return; }
  if (!password) password = phone.slice(-6);
  if (password.length < 6) { toast('密码不能少于 6 位', 'error'); return; }
  const passwordData = await passwordRecord(password);
  const adminId = uid('usr');
  const admin = {
    id: adminId,
    name: adminName,
    phone,
    role: 'admin',
    roomIds: DEFAULT_ROOMS.map((room) => room.id),
    viewAll: true,
    status: 'active',
    password: passwordData,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString()
  };
  const teamCode = generateTeamCode();
  setTeamCode(teamCode);
  app.data = createInitialState(teamName, admin);
  app.session = { userId: adminId, expiresAt: Date.now() + 10 * 365 * 24 * 60 * 60 * 1000, createdAt: Date.now() };
  saveLocalState({ dirty: true });
  app.tab = 'staff';
  render();
  await initSync();
  setTimeout(() => publishState(), 1000);
  toast('团队创建成功，邀请码已生成', 'success');
}

async function joinTeam() {
  const teamCode = String($('#join-team-code')?.value || app.joinCode || '').trim().toUpperCase();
  if (!/^LSP-[A-Z0-9-]{15,}$/.test(teamCode)) { toast('团队码格式不正确', 'error'); return; }
  setTeamCode(teamCode);
  app.data = null;
  app.session = null;
  app.dirty = false;
  localStorage.removeItem(STORAGE.state);
  localStorage.removeItem(STORAGE.session);
  writeJson(STORAGE.dirty, false);
  render();
  await initSync();
}

async function login() {
  const phone = String($('#login-phone')?.value || '').trim();
  const password = String($('#login-password')?.value || '');
  if (!/^1\d{10}$/.test(phone) || !password) { toast('请输入手机号和密码', 'error'); return; }
  const user = app.data.users.find((item) => !item.deletedAt && item.phone === phone);
  if (!user) { toast('该手机号未加入团队，请联系管理员', 'error'); return; }
  if (user.status === 'disabled') { toast('该账号已停用，请联系管理员', 'error'); return; }
  if (!(await verifyPassword(password, user.password))) { toast('密码错误', 'error'); return; }
  app.session = { userId: user.id, expiresAt: Date.now() + 10 * 365 * 24 * 60 * 60 * 1000, createdAt: Date.now() };
  saveLocalState({ dirty: app.dirty });
  app.tab = user.role === 'admin' ? 'dashboard' : 'records';
  render();
  toast('登录成功，已长期保持登录', 'success');
}

function logout() {
  openModal({
    title: '退出登录',
    text: '退出后会清除当前设备上的登录状态，但不会删除云端数据和本地缓存。',
    confirmText: '退出',
    danger: true,
    onConfirm: async () => {
      app.session = null;
      localStorage.removeItem(STORAGE.session);
      render();
    }
  });
}

async function leaveTeam() {
  openModal({
    title: '切换团队',
    text: '将清除本机当前团队的登录状态和本地缓存。云端数据不会删除，重新输入团队码还可以恢复。',
    confirmText: '退出团队',
    danger: true,
    onConfirm: async () => {
      if (app.mqttClient) app.mqttClient.end(true);
      app.mqttClient = null;
      app.teamCode = '';
      app.data = null;
      app.session = null;
      app.dirty = false;
      localStorage.removeItem(STORAGE.team);
      localStorage.removeItem(STORAGE.state);
      localStorage.removeItem(STORAGE.session);
      writeJson(STORAGE.dirty, false);
      app.authMode = 'create';
      app.tab = 'dashboard';
      render();
    }
  });
}


let pendingAddRecord = false;

document.addEventListener('click', async (event) => {
  const target = event.target.closest('[data-action]');
  if (!target) return;
  const action = target.dataset.action;
  try {
    if (action === 'close-sheet') { closeSheet(); return; }
    if (action === 'close-modal') { closeModal(); return; }
    if (action === 'auth-switch') {
      app.authMode = target.dataset.mode || 'create';
      render();
      return;
    }
    if (action === 'create-team') { await createTeam(); return; }
    if (action === 'join-team') { await joinTeam(); return; }
    if (action === 'retry-sync') { await initSync(); return; }
    if (action === 'leave-team') { await leaveTeam(); return; }
    if (action === 'login') { await login(); return; }
    if (action === 'tab') {
      const tab = target.dataset.tab;
      if (tab === 'staff' && !canManageUsers()) return;
      app.tab = tab;
      render();
      return;
    }
    if (action === 'sync-now') {
      if (app.mqttClient?.connected) {
        if (app.dirty) await publishState(); else toast('当前数据已是最新', 'success');
      } else {
        await initSync();
        toast('正在重新连接云同步');
      }
      checkAppUpdateAndReload();
      return;
    }
    if (action === 'month-prev') { app.month = addMonths(app.month, -1); render(); return; }
    if (action === 'month-next') { app.month = addMonths(app.month, 1); render(); return; }
    if (action === 'month-picker') { openMonthPicker(); return; }
    if (action === 'confirm-month') { confirmMonth(); return; }
    if (action === 'metric') { app.metric = target.dataset.metric || 'peak'; render(); return; }
    if (action === 'record-room') { app.recordRoom = target.dataset.value || 'all'; render(); return; }
    if (action === 'record-host') { app.recordHost = target.dataset.value || 'all'; render(); return; }
    if (action === 'add-record') { openRecordEditor(); return; }
    if (action === 'edit-record') { openRecordEditor(target.dataset.id); return; }
    if (action === 'date-today') { setWheelValue('record-date', localDate()); return; }
    if (action === 'num-step') {
      const input = $('#field-' + target.dataset.key);
      if (!input) return;
      const step = Number(target.dataset.step || 1);
      input.value = String(Math.max(0, (Number(input.value) || 0) + step));
      return;
    }
    if (action === 'manage-fields') { manageFields(); return; }
    if (action === 'add-field') { openFieldEditor(''); return; }
    if (action === 'edit-field') { openFieldEditor(target.dataset.id); return; }
    if (action === 'save-field') { await saveField(); return; }
    if (action === 'delete-field') { deleteField(target.dataset.id); return; }
    if (action === 'field-type') {
      $$('[data-action="field-type"]').forEach((el) => el.classList.toggle('active', el === target));
      if (app.fieldDraft) app.fieldDraft.type = target.dataset.type || 'text';
      const wrap = $('#field-options-wrap');
      if (wrap) wrap.style.display = target.dataset.type === 'select' ? '' : 'none';
      return;
    }
    if (action === 'field-option') {
      $$('[data-action="field-option"][data-key="' + target.dataset.key + '"]').forEach((el) => el.classList.toggle('active', el === target));
      return;
    }
    if (action === 'range') { app.range = target.dataset.value || 'month'; render(); return; }
    if (action === 'year-prev') { app.year -= 1; render(); return; }
    if (action === 'year-next') { app.year += 1; render(); return; }
    if (action === 'violation-toggle') {
      $$('[data-action="violation-toggle"]').forEach((el) => el.classList.toggle('active', el === target));
      const detail = $('#violation-detail');
      if (detail) detail.style.display = target.dataset.value === '有' ? '' : 'none';
      return;
    }
    if (action === 'violation-reason') {
      $$('[data-action="violation-reason"]').forEach((el) => el.classList.toggle('active', el === target));
      return;
    }
    if (action === 'add-room') { openRoomEditor(''); return; }
    if (action === 'edit-room') { openRoomEditor(target.dataset.id); return; }
    if (action === 'save-room') { await saveRoom(); return; }
    if (action === 'edit-profile') { openProfileEditor(); return; }
    if (action === 'save-profile') { await saveProfile(); return; }
    if (action === 'avatar') {
      app.profileAvatar = target.dataset.value || '';
      $$('[data-action="avatar"]').forEach((el) => el.classList.toggle('active', el === target));
      return;
    }
    if (action === 'user-scope') {
      $$('[data-action="user-scope"]').forEach((el) => el.classList.toggle('active', el === target));
      return;
    }
    if (action === 'edit-violation-reasons') { openViolationReasons(); return; }
    if (action === 'save-violation-reasons') { await saveViolationReasons(); return; }
    if (action === 'save-record') { await saveRecord(target.dataset.id || ''); return; }
    if (action === 'delete-record') { deleteRecord(target.dataset.id); return; }
    if (action === 'add-user') { openUserEditor(); return; }
    if (action === 'edit-user') { openUserEditor(target.dataset.id); return; }
    if (action === 'user-role') {
      $$('[data-action="user-role"]').forEach((el) => el.classList.toggle('active', el === target));
      if (target.dataset.role === 'admin') {
        $$('[data-action="toggle-room-option"]').forEach((el) => el.classList.add('active'));
        $('#view-all-box')?.classList.add('checked');
      }
      return;
    }
    if (action === 'toggle-room-option') { target.classList.toggle('active'); return; }
    if (action === 'toggle-view-all') { $('#view-all-box')?.classList.toggle('checked'); return; }
    if (action === 'toggle-user-status') { $('#user-status-box')?.classList.toggle('checked'); return; }
    if (action === 'save-user') { await saveUser(target.dataset.id || ''); return; }
    if (action === 'reset-password') { resetUserPassword(target.dataset.id); return; }
    if (action === 'delete-user') { deleteUser(target.dataset.id); return; }
    if (action === 'change-password') { openChangePassword(); return; }
    if (action === 'submit-change-password') { await submitChangePassword(); return; }
    if (action === 'invite') { openInvite(); return; }
    if (action === 'copy-invite') { await copyText(inviteUrl()); return; }
    if (action === 'share-invite') {
      if (navigator.share) {
        try { await navigator.share({ title: '加入直播数据统计', text: '团队码：' + app.teamCode, url: inviteUrl() }); } catch {}
      } else await copyText(inviteUrl());
      return;
    }
    if (action === 'install') { await installApp(); return; }
    if (action === 'export-data') { exportData(); return; }
    if (action === 'import-data') { $('#import-file')?.click(); return; }
    if (action === 'logout') { logout(); return; }
  } catch (error) {
    console.error('操作失败', action, error);
    toast(error.message || '操作失败，请重试', 'error');
  }
});

document.addEventListener('change', async (event) => {
  if (event.target.id === 'import-file') {
    await importDataFile(event.target.files?.[0]);
    event.target.value = '';
  }
});

window.addEventListener('beforeinstallprompt', (event) => {
  event.preventDefault();
  app.deferredPrompt = event;
});

window.addEventListener('appinstalled', () => {
  app.deferredPrompt = null;
  toast('已安装到桌面', 'success');
});

window.addEventListener('online', () => {
  setSyncStatus('connecting', '网络已恢复，正在同步…');
  initSync();
});

window.addEventListener('offline', () => {
  setSyncStatus('offline', '离线使用，数据已保存在本机');
});

async function registerPwa() {
  if ('serviceWorker' in navigator) {
    try {
      await navigator.serviceWorker.register('./sw.js', { scope: './' });
    } catch (error) {
      console.warn('Service Worker 注册失败', error);
    }
  }
  if (navigator.storage?.persist) {
    try { await navigator.storage.persist(); } catch {}
  }
}


async function checkAppUpdateAndReload() {
  try {
    if ('serviceWorker' in navigator) {
      const reg = await navigator.serviceWorker.getRegistration();
      if (reg) await reg.update();
    }
  } catch (e) {}
  toast('数据已同步，正在刷新到最新版本…', 'success');
  setTimeout(() => { location.reload(); }, 900);
}

async function boot() {
  app.initialized = false;
  render();
  loadLocalState();
  const query = new URLSearchParams(location.search);
  pendingAddRecord = query.get('action') === 'add';
  const hash = location.hash.startsWith('#') ? location.hash.slice(1) : location.hash;
  const hashParams = new URLSearchParams(hash);
  const joinCode = hashParams.get('join');
  if (joinCode) {
    const normalized = joinCode.trim().toUpperCase();
    if (app.teamCode !== normalized) {
      app.teamCode = normalized;
      localStorage.setItem(STORAGE.team, normalized);
      app.data = null;
      app.session = null;
      app.dirty = false;
      localStorage.removeItem(STORAGE.state);
      localStorage.removeItem(STORAGE.session);
      writeJson(STORAGE.dirty, false);
    }
    history.replaceState(null, '', location.pathname + (location.search || ''));
  }
  app.initialized = true;
  render();
  await registerPwa();
  if (app.teamCode) await initSync();
  if (pendingAddRecord && resolveUser()) {
    app.tab = 'home';
    render();
  }
}

window.__handleBack = function() {
  try {
    const sheet = $('#sheet-root');
    const modal = $('#modal-root');
    if (modal && modal.children.length > 0) { closeModal(); return 'true'; }
    if (sheet && sheet.children.length > 0) { closeSheet(); return 'true'; }
    if (app.tab !== 'home') { app.tab = 'home'; render(); return 'true'; }
  } catch (e) {}
  return 'false';
};

window.addEventListener('DOMContentLoaded', boot);
