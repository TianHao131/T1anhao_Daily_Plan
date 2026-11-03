(function(root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.DailySync = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function() {
  'use strict';
  const clone = x => x === undefined ? undefined : JSON.parse(JSON.stringify(x));
  // PostgreSQL JSONB may return object keys in a different order.
  const canonical = x => Array.isArray(x) ? x.map(canonical) : x && typeof x === 'object' ?
    Object.fromEntries(Object.keys(x).sort().map(k => [k, canonical(x[k])])) : x;
  const same = (a, b) => JSON.stringify(canonical(a)) === JSON.stringify(canonical(b));
  const object = x => x && typeof x === 'object' && !Array.isArray(x);
  const forbidden = new Set(['__proto__', 'constructor', 'prototype']);
  const safeKey = x => typeof x === 'string' && x.length > 0 && x.length <= 200 && !forbidden.has(x);
  const date = x => typeof x === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(x) &&
    Number.isFinite(Date.parse(x)) && new Date(x + 'T00:00:00Z').toISOString().slice(0, 10) === x;
  function empty() {
    return {tasks: [], records: {}, monthlyTasks: [], monthlyRecords: {}, plannedTasks: [], tags: [
      {name: '临时任务', color: '#8E44AD'}, {name: '作业', color: '#1E8449'}, {name: '补课', color: '#2980B9'},
      {name: '写作业', color: '#95A5A6'}, {name: '考试', color: '#C0392B'}
    ]};
  }
  function validate(data) {
    try {
      if (!object(data) || JSON.stringify(data).length > 4000000) return false;
      const walk = (x, depth = 0) => {
        if (depth > 10) return false;
        if (!x || typeof x !== 'object') return typeof x !== 'number' || Number.isFinite(x);
        return Object.keys(x).every(k => !forbidden.has(k) && walk(x[k], depth + 1));
      };
      if (!walk(data)) return false;
      for (const list of ['tasks', 'monthlyTasks', 'plannedTasks', 'tags']) {
        if (!Array.isArray(data[list]) || data[list].length > 20000) return false;
        const seen = new Set();
        for (const t of data[list]) {
          const id = list === 'tags' ? t?.name : t?.id;
          if (!object(t) || !safeKey(id) || seen.has(id) || typeof t.name !== 'string' || !t.name.trim() || t.name.length > 2000) return false;
          seen.add(id);
          if (list === 'tags' && !/^#[0-9a-f]{6}$/i.test(t.color)) return false;
          if (list !== 'tags' && ((t.createdAt !== undefined && !date(t.createdAt)) || (t.archivedAt !== undefined && !date(t.archivedAt)))) return false;
          if (list === 'monthlyTasks' && (!date(t.date) || t.monthKey !== t.date.slice(0, 7) ||
            (t.category !== undefined && typeof t.category !== 'string') || (t.deadline !== undefined && !date(t.deadline)))) return false;
          if (list === 'plannedTasks' && t.completed !== undefined && typeof t.completed !== 'boolean') return false;
        }
      }
      for (const field of ['records', 'monthlyRecords']) {
        if (!object(data[field])) return false;
        for (const [key, bucket] of Object.entries(data[field])) {
          if (!(field === 'records' ? date(key) : /^\d{4}-\d{2}$/.test(key)) || !object(bucket)) return false;
          if (!Object.entries(bucket).every(([id, done]) => safeKey(id) && typeof done === 'boolean')) return false;
        }
      }
      return true;
    } catch { return false; }
  }
  // Entity fields, completion records and list order are merged independently.
  // The common base identifies what each device actually changed.
  function merge(base, local, remote, preference) {
    const conflicts = [];
    function value(b, l, r, path) {
      if (same(l, r) || same(b, r)) return clone(l);
      if (same(b, l)) return clone(r);
      if (object(b) && object(l) && object(r)) {
        const out = {};
        for (const key of new Set([...Object.keys(b), ...Object.keys(l), ...Object.keys(r)])) {
          const result = value(b[key], l[key], r[key], path + ' / ' + key);
          if (result !== undefined) out[key] = result;
        }
        return out;
      }
      conflicts.push(path);
      return clone(preference === 'remote' ? r : l);
    }
    function order(b, l, r, ids, path) {
      const surviving = new Set(ids), inL = new Set(l), inR = new Set(r);
      const common = new Set(b.filter(id => surviving.has(id) && inL.has(id) && inR.has(id)));
      const bb = b.filter(id => common.has(id)), ll = l.filter(id => common.has(id)), rr = r.filter(id => common.has(id));
      let source = r;
      if (!same(bb, ll)) {
        if (!same(bb, rr) && !same(ll, rr)) {
          conflicts.push(path + ' / 优先顺序'); source = preference === 'remote' ? r : l;
        } else source = l;
      }
      const result = source.filter(id => surviving.has(id)), present = new Set(result);
      // Keep new tasks near their neighbours while retaining the chosen existing order.
      for (const other of [l, r, b, ids]) {
        let anchor = -1;
        for (const id of other) {
          if (!surviving.has(id)) continue;
          if (present.has(id)) { anchor = result.indexOf(id); continue; }
          result.splice(anchor + 1, 0, id); present.add(id); anchor++;
        }
      }
      return result;
    }
    function collection(b, l, r, path, key = 'id') {
      const maps = [b, l, r].map(list => new Map(list.map(t => [t[key], t])));
      const ids = [...new Set([...r, ...l, ...b].map(t => t[key]))], out = new Map();
      for (const id of ids) {
        const [bv, lv, rv] = maps.map(m => m.get(id));
        const item = value(bv, lv, rv, path + ' / ' + ((lv || rv || bv).name || id));
        if (item !== undefined) out.set(id, item);
      }
      return order(b.map(t => t[key]), l.map(t => t[key]), r.map(t => t[key]), [...out.keys()], path).map(id => out.get(id));
    }
    function records(b, l, r) {
      const out = {};
      for (const day of new Set([...Object.keys(b), ...Object.keys(l), ...Object.keys(r)])) {
        const buckets = [b[day] || {}, l[day] || {}, r[day] || {}], bucket = {};
        for (const id of new Set(buckets.flatMap(x => Object.keys(x)))) {
          const done = value(...buckets.map(x => x[id] === true ? true : undefined), '完成记录 / ' + day + ' / ' + id);
          if (done) bucket[id] = true;
        }
        if (Object.keys(bucket).length) out[day] = bucket;
      }
      return out;
    }
    const monthly = d => d.monthlyTasks.map(t => ({...t, _completed: d.monthlyRecords[t.monthKey]?.[t.id] === true}));
    const monthlyTasks = collection(...[base, local, remote].map(monthly), '每月任务'), monthlyRecords = {};
    for (const task of monthlyTasks) {
      task.monthKey = task.date.slice(0, 7);
      if (task._completed) (monthlyRecords[task.monthKey] ||= {})[task.id] = true;
      delete task._completed;
    }
    const data = {
      tasks: collection(base.tasks, local.tasks, remote.tasks, '每日习惯'),
      records: records(base.records, local.records, remote.records),
      monthlyTasks, monthlyRecords,
      plannedTasks: collection(base.plannedTasks, local.plannedTasks, remote.plannedTasks, '计划待办'),
      tags: collection(base.tags, local.tags, remote.tags, '标签', 'name')
    };
    return {data, conflicts};
  }
  class Engine {
    constructor({userId, remote, storage, onChange = () => {}, onStatus = () => {}, onConflict = () => {}}) {
      Object.assign(this, {userId, remote, storage, onChange, onStatus, onConflict});
      this.key = 'daily-checkin-cloud-v1:' + userId;
      this.state = {data: empty(), base: empty(), revision: null, dirty: false};
      this.ready = false; this.active = true; this.seq = 0; this.running = null; this.conflict = null;
      try {
        const cached = JSON.parse(storage.getItem(this.key) || 'null');
        if (cached && validate(cached.data) && validate(cached.base) &&
          (cached.revision === null || (Number.isSafeInteger(cached.revision) && cached.revision > 0)) && typeof cached.dirty === 'boolean') {
          this.state = cached; this.ready = true;
          if (cached.conflict && validate(cached.conflict.remote?.data) && validate(cached.conflict.base) &&
            validate(cached.conflict.local) && Array.isArray(cached.conflict.conflicts)) this.conflict = cached.conflict;
        }
      } catch { /* Invalid local data must never overwrite a valid cloud copy. */ }
    }
    emit() { if (this.active) this.onChange(clone(this.state.data)); }
    status(text, kind = '') { if (this.active) this.onStatus(text, kind); }
    persist(next) { this.storage.setItem(this.key, JSON.stringify(next)); this.state = next; }
    commit(data, viewBase = this.state.data) {
      if (!this.active || !this.ready || this.conflict || !validate(data)) {
        this.status(this.conflict ? '请先处理同步冲突。' : '暂时无法保存，请检查数据并导出备份。', 'error'); return false;
      }
      const merged = merge(viewBase, data, this.state.data);
      const conflict = merged.conflicts.length ? {
        base: clone(viewBase), local: clone(data), remote: {data: clone(this.state.data), revision: this.state.revision},
        resumeBase: clone(this.state.base), resumeRevision: this.state.revision, conflicts: merged.conflicts
      } : null;
      if (!validate(merged.data)) return false;
      try { this.persist({...this.state, data: merged.data, dirty: true, conflict}); }
      catch { this.status('本机保存失败，请立即导出备份。', 'error'); return false; }
      this.seq++;
      if (conflict) { this.conflict = conflict; this.status('编辑期间收到冲突修改，请选择。', 'conflict'); this.onConflict(conflict.conflicts); }
      else { this.status('已保存到本机，正在等待同步…', 'pending'); this.schedule(); }
      return true;
    }
    schedule() {
      clearTimeout(this.timer);
      if (this.active && !this.conflict) this.timer = setTimeout(() => this.sync(), 500);
    }
    async sync() {
      if (!this.active || this.conflict) return false;
      if (this.running) return this.running;
      this.running = this.run().finally(() => { this.running = null; });
      return this.running;
    }
    async run() {
      try {
        this.status('正在同步…', 'pending');
        for (let attempt = 0; attempt < 4 && this.active; attempt++) {
          const remote = await this.remote.read();
          if (!this.active || this.conflict) return false;
          if (!remote || !validate(remote.data) || !(remote.revision === null ||
            (Number.isSafeInteger(remote.revision) && remote.revision > 0))) throw Error('云端数据格式不正确，请保留备份。');
          if (!this.state.dirty) {
            // Recheck dirty after the await: an offline edit can arrive during a read.
            this.persist({data: clone(remote.data), base: clone(remote.data), revision: remote.revision, dirty: false});
            this.ready = true; this.emit(); this.status('已与云端同步'); return true;
          }
          const localAtSend = clone(this.state.data), seq = this.seq;
          const merged = merge(this.state.base, localAtSend, remote.data);
          if (merged.conflicts.length) {
            this.conflict = {remote: clone(remote), base: clone(this.state.base), local: localAtSend, conflicts: merged.conflicts};
            this.persist({...this.state, conflict: this.conflict});
            this.status('两台设备修改了相同内容，请处理冲突。', 'conflict'); this.onConflict(merged.conflicts); return false;
          }
          if (!validate(merged.data)) throw Error('合并后的数据不正确，本机修改已保留。');
          const sent = merged.data;
          const saved = same(sent, remote.data) ? remote : await this.remote.write(sent, remote.revision);
          if (!this.active || this.conflict) return false;
          if (!saved) continue;
          if (!validate(saved.data) || !(saved.revision === null || (Number.isSafeInteger(saved.revision) && saved.revision > 0)) || !same(saved.data, sent)) throw Error('云端保存结果未确认，本机修改已保留。');
          if (this.seq !== seq) {
            const follow = merge(localAtSend, this.state.data, sent);
            if (follow.conflicts.length) {
              this.conflict = {remote: clone(saved), base: localAtSend, local: clone(this.state.data), conflicts: follow.conflicts};
              this.persist({...this.state, conflict: this.conflict});
              this.status('同步期间出现修改冲突，请选择。', 'conflict'); this.onConflict(follow.conflicts); return false;
            }
            this.persist({...this.state, data: follow.data, base: clone(sent), revision: saved.revision, dirty: true});
            this.emit(); continue;
          }
          this.persist({data: clone(sent), base: clone(sent), revision: saved.revision, dirty: false});
          this.ready = true; this.emit(); this.status('已与云端同步'); return true;
        }
        this.status('其他设备仍在修改，稍后自动重试；本机内容已保留。', 'pending'); return false;
      } catch (error) {
        if (!this.active) return false;
        this.status(this.state.dirty ? '尚未同步，本机修改已保留，联网后自动重试。' :
          (error.message || '暂时无法连接云端。'), 'error'); return false;
      }
    }
    resolve(preference) {
      if (!this.conflict || !['local', 'remote'].includes(preference)) return false;
      const {remote, base, local, resumeBase, resumeRevision} = this.conflict;
      const merged = merge(base, local, remote.data, preference);
      if (!validate(merged.data)) return false;
      try { this.persist({data: merged.data, base: resumeBase || remote.data,
        revision: resumeBase ? resumeRevision : remote.revision, dirty: true}); }
      catch { this.status('本机保存失败，冲突仍保留，请导出备份。', 'error'); return false; }
      this.conflict = null; this.seq++; this.emit(); this.schedule(); return true;
    }
    stop() { this.active = false; clearTimeout(this.timer); }
  }
  return {Engine, merge, validate, empty, clone, same};
});
