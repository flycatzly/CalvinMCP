// web-rpa-mcp — 凭据加密存储（AES-256-GCM + 本机密钥文件）
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { DIRS, ensureDirs, readJson, writeJson, logger } from './core.mjs';

const L = logger('secrets');
const KEY_FILE = () => path.join(DIRS.work, 'key');
const STORE_FILE = () => path.join(DIRS.work, 'secrets.json');

function getKey() {
  ensureDirs();
  const f = KEY_FILE();
  if (!fs.existsSync(f)) {
    fs.writeFileSync(f, crypto.randomBytes(32).toString('hex'), { encoding: 'utf8', mode: 0o600 });
  }
  return Buffer.from(fs.readFileSync(f, 'utf8').trim(), 'hex');
}

function load() { return readJson(STORE_FILE(), {}) || {}; }
function save(o) { writeJson(STORE_FILE(), o); }

export function setSecret(name, value) {
  const key = getKey();
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', key, iv);
  const enc = Buffer.concat([c.update(String(value), 'utf8'), c.final()]);
  const store = load();
  store[name] = { iv: iv.toString('hex'), tag: c.getAuthTag().toString('hex'), data: enc.toString('hex'), updatedAt: new Date().toISOString() };
  save(store);
  L.info('已写入凭据（已加密）', { name });
  return true;
}

export function getSecret(name) {
  const rec = load()[name];
  if (!rec) return null;
  try {
    const key = getKey();
    const d = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(rec.iv, 'hex'));
    d.setAuthTag(Buffer.from(rec.tag, 'hex'));
    return Buffer.concat([d.update(Buffer.from(rec.data, 'hex')), d.final()]).toString('utf8');
  } catch (e) {
    L.error('凭据解密失败', { name, err: String(e?.message ?? e) });
    return null;
  }
}

export function listSecrets() {
  return Object.entries(load()).map(([name, r]) => ({ name, updatedAt: r.updatedAt }));
}

export function deleteSecret(name) {
  const store = load();
  if (!(name in store)) return false;
  delete store[name];
  save(store);
  return true;
}
