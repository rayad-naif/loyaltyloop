'use strict';

/**
 * Storage layer. One tiny async interface, two drivers:
 *   - Upstash Redis (REST)  -> production / serverless (Vercel, Render, AWS)
 *   - In-memory (+ JSON file when not on a serverless host) -> local dev & tests
 *
 * Every key is namespaced per location (ll:<locationId>:...), so each
 * sub-account's data is isolated. Balances live in a sorted set so
 * adjustments are atomic and the leaderboard is a single range query.
 */

const fs = require('fs');
const path = require('path');
const axios = require('axios');
const config = require('./config');

// ---------------------------------------------------------------- memory driver
function createMemoryDriver({ persistPath } = {}) {
  let s = { kv: {}, hash: {}, zset: {}, list: {}, set: {}, exp: {} };
  if (persistPath && fs.existsSync(persistPath)) {
    try {
      s = { ...s, ...JSON.parse(fs.readFileSync(persistPath, 'utf8')) };
    } catch {
      /* start fresh */
    }
  }
  let timer = null;
  const persist = () => {
    if (!persistPath) return;
    clearTimeout(timer);
    timer = setTimeout(() => {
      try {
        fs.mkdirSync(path.dirname(persistPath), { recursive: true });
        fs.writeFileSync(persistPath, JSON.stringify(s));
      } catch {
        /* best effort */
      }
    }, 50);
    if (timer.unref) timer.unref();
  };
  const alive = (k) => {
    if (s.exp[k] && s.exp[k] < Date.now()) {
      delete s.kv[k];
      delete s.exp[k];
      return false;
    }
    return true;
  };

  return {
    name: persistPath ? 'file' : 'memory',
    async get(k) {
      return alive(k) && k in s.kv ? s.kv[k] : null;
    },
    async set(k, v, { ex, nx } = {}) {
      if (nx && alive(k) && k in s.kv) return false;
      s.kv[k] = String(v);
      if (ex) s.exp[k] = Date.now() + ex * 1000;
      else delete s.exp[k];
      persist();
      return true;
    },
    async del(...keys) {
      for (const k of keys) {
        delete s.kv[k];
        delete s.hash[k];
        delete s.zset[k];
        delete s.list[k];
        delete s.set[k];
        delete s.exp[k];
      }
      persist();
    },
    async hget(k, f) {
      return s.hash[k]?.[f] ?? null;
    },
    async hset(k, f, v) {
      (s.hash[k] ||= {})[f] = String(v);
      persist();
    },
    async hsetnx(k, f, v) {
      const h = (s.hash[k] ||= {});
      if (f in h) return false;
      h[f] = String(v);
      persist();
      return true;
    },
    async hincrby(k, f, n) {
      const h = (s.hash[k] ||= {});
      h[f] = String((parseInt(h[f], 10) || 0) + n);
      persist();
      return parseInt(h[f], 10);
    },
    async hgetall(k) {
      return { ...(s.hash[k] || {}) };
    },
    async hdel(k, f) {
      if (s.hash[k]) delete s.hash[k][f];
      persist();
    },
    // Atomic balance change. strict: refuse if it would go below zero; otherwise clamp at zero.
    async adjust(k, member, delta, strict) {
      const z = (s.zset[k] ||= {});
      const cur = z[member] ?? 0;
      let applied = delta;
      if (cur + delta < 0) {
        if (strict) return { ok: false, balance: cur, applied: 0 };
        applied = -cur;
      }
      z[member] = cur + applied;
      persist();
      return { ok: true, balance: z[member], applied };
    },
    async zscore(k, member) {
      const v = s.zset[k]?.[member];
      return v === undefined ? null : v;
    },
    async zrevrange(k, limit) {
      return Object.entries(s.zset[k] || {})
        .map(([member, score]) => ({ member, score }))
        .sort((a, b) => b.score - a.score)
        .slice(0, limit);
    },
    async zcard(k) {
      return Object.keys(s.zset[k] || {}).length;
    },
    async lpushTrim(k, v, max) {
      const l = (s.list[k] ||= []);
      l.unshift(String(v));
      if (l.length > max) l.length = max;
      persist();
    },
    async lrange(k, start, stop) {
      return (s.list[k] || []).slice(start, stop + 1);
    },
    async sadd(k, m) {
      (s.set[k] ||= []);
      if (!s.set[k].includes(m)) s.set[k].push(m);
      persist();
    },
    async srem(k, m) {
      if (s.set[k]) s.set[k] = s.set[k].filter((x) => x !== m);
      persist();
    },
    async smembers(k) {
      return [...(s.set[k] || [])];
    }
  };
}

// ---------------------------------------------------------------- upstash driver
const ADJUST_LUA = `
local cur = tonumber(redis.call('ZSCORE', KEYS[1], ARGV[1]))
if not cur then cur = 0 end
local delta = tonumber(ARGV[2])
local strict = ARGV[3] == '1'
if cur + delta < 0 then
  if strict then return {0, tostring(cur), '0'} end
  delta = -cur
end
local new = redis.call('ZINCRBY', KEYS[1], delta, ARGV[1])
return {1, tostring(new), tostring(delta)}
`;

function createUpstashDriver({ url, token }) {
  const cmd = async (...args) => {
    const res = await axios.post(url, args.map((a) => (typeof a === 'number' ? String(a) : a)), {
      headers: { Authorization: `Bearer ${token}` },
      timeout: 8000
    });
    if (res.data && res.data.error) throw new Error('Upstash: ' + res.data.error);
    return res.data.result;
  };
  const pairs = (flat) => {
    const o = {};
    for (let i = 0; i < (flat || []).length; i += 2) o[flat[i]] = flat[i + 1];
    return o;
  };

  return {
    name: 'upstash',
    get: (k) => cmd('GET', k),
    async set(k, v, { ex, nx } = {}) {
      const a = ['SET', k, String(v)];
      if (ex) a.push('EX', ex);
      if (nx) a.push('NX');
      return (await cmd(...a)) === 'OK';
    },
    async del(...keys) {
      if (keys.length) await cmd('DEL', ...keys);
    },
    hget: (k, f) => cmd('HGET', k, f),
    async hset(k, f, v) {
      await cmd('HSET', k, f, String(v));
    },
    async hsetnx(k, f, v) {
      return (await cmd('HSETNX', k, f, String(v))) === 1;
    },
    hincrby: (k, f, n) => cmd('HINCRBY', k, f, n),
    async hgetall(k) {
      return pairs(await cmd('HGETALL', k));
    },
    async hdel(k, f) {
      await cmd('HDEL', k, f);
    },
    async adjust(k, member, delta, strict) {
      const r = await cmd('EVAL', ADJUST_LUA, 1, k, member, String(delta), strict ? '1' : '0');
      return { ok: Number(r[0]) === 1, balance: Number(r[1]), applied: Number(r[2]) };
    },
    async zscore(k, member) {
      const v = await cmd('ZSCORE', k, member);
      return v === null ? null : Number(v);
    },
    async zrevrange(k, limit) {
      const flat = await cmd('ZREVRANGE', k, 0, limit - 1, 'WITHSCORES');
      const out = [];
      for (let i = 0; i < (flat || []).length; i += 2) out.push({ member: flat[i], score: Number(flat[i + 1]) });
      return out;
    },
    zcard: (k) => cmd('ZCARD', k),
    async lpushTrim(k, v, max) {
      await cmd('LPUSH', k, String(v));
      await cmd('LTRIM', k, 0, max - 1);
    },
    async lrange(k, start, stop) {
      return (await cmd('LRANGE', k, start, stop)) || [];
    },
    async sadd(k, m) {
      await cmd('SADD', k, m);
    },
    async srem(k, m) {
      await cmd('SREM', k, m);
    },
    async smembers(k) {
      return (await cmd('SMEMBERS', k)) || [];
    }
  };
}

// ---------------------------------------------------------------- facade
function pickDriver() {
  const { upstashUrl, upstashToken, dataDir } = config.storage;
  if (upstashUrl && upstashToken) return createUpstashDriver({ url: upstashUrl, token: upstashToken });
  // Serverless hosts have no persistent disk -> memory only (a loud warning is shown at startup).
  if (process.env.VERCEL) return createMemoryDriver();
  return createMemoryDriver({ persistPath: path.resolve(dataDir, 'store.json') });
}

let driver = pickDriver();

const K = {
  install: (loc) => `ll:install:${loc}`,
  company: (cid) => `ll:company:${cid}`,
  locations: () => 'll:locations',
  rules: (loc) => `ll:${loc}:rules`,
  settings: (loc) => `ll:${loc}:settings`,
  balances: (loc) => `ll:${loc}:bal`,
  activity: (loc) => `ll:${loc}:activity`,
  stats: (loc) => `ll:${loc}:stats`,
  awards: (loc) => `ll:${loc}:awards`,
  names: (loc) => `ll:${loc}:names`,
  dirty: (loc) => `ll:${loc}:dirty`,
  event: (loc, id) => `ll:evt:${loc}:${id}`,
  lock: (name) => `ll:lock:${name}`,
  webhookKeyIndex: (key) => `ll:wk:${key}`
};

const json = {
  async get(key) {
    const v = await driver.get(key);
    if (!v) return null;
    try {
      return JSON.parse(v);
    } catch {
      return null;
    }
  },
  set: (key, obj, opts) => driver.set(key, JSON.stringify(obj), opts)
};

module.exports = {
  K,
  json,
  get driver() {
    return driver;
  },
  // Test hook: swap in a fresh in-memory store.
  _useMemory() {
    driver = createMemoryDriver();
    return driver;
  },
  isPersistent: () => driver.name === 'upstash' || driver.name === 'file',
  // Delegates (so callers never touch the driver directly)
  get: (...a) => driver.get(...a),
  set: (...a) => driver.set(...a),
  del: (...a) => driver.del(...a),
  hget: (...a) => driver.hget(...a),
  hset: (...a) => driver.hset(...a),
  hsetnx: (...a) => driver.hsetnx(...a),
  hincrby: (...a) => driver.hincrby(...a),
  hgetall: (...a) => driver.hgetall(...a),
  hdel: (...a) => driver.hdel(...a),
  adjust: (...a) => driver.adjust(...a),
  zscore: (...a) => driver.zscore(...a),
  zrevrange: (...a) => driver.zrevrange(...a),
  zcard: (...a) => driver.zcard(...a),
  lpushTrim: (...a) => driver.lpushTrim(...a),
  lrange: (...a) => driver.lrange(...a),
  sadd: (...a) => driver.sadd(...a),
  srem: (...a) => driver.srem(...a),
  smembers: (...a) => driver.smembers(...a)
};
