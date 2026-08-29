// 模型注册表: 内置 nuo1-5 + 用户新增(IndexedDB 持久化)
import { openDB, idbGetAll } from "./idb.js";

const DB_NAME = "nuo-mask-web";
const STORE = "models";

export class ModelStore {
  constructor(manifest) {
    this.defs = [];
    this.listeners = new Set();
    // 导出资产(.tdp.gz): 位置/姿态/颜色已按最终渲染数据烘焙,恒等变换
    for (const [name, info] of Object.entries(manifest.models ?? manifest)) {
      const url = info.url ?? `./models/${name}.tdp.gz`;
      this.defs.push({
        key: name,
        name,
        type: "builtin",
        url,
        count: info.count,
        baseScale: 1,
        baseTilt: 0,
      });
    }
  }

  async init() {
    try {
      this.db = await openDB(DB_NAME, STORE);
      const all = await idbGetAll(this.db, STORE);
      for (const rec of all) {
        this.defs.push({
          key: rec.key,
          name: rec.name,
          type: "user",
          blob: rec.blob,
          count: rec.count,
          baseScale: 2.6,
          baseTilt: 0,
        });
      }
    } catch (e) {
      console.warn("IndexedDB 不可用,新增模型仅本次会话有效", e);
    }
    this.emit();
  }

  async addUserModel(name, blob, count) {
    const key = "u_" + Date.now().toString(36) + "_" + Math.random().toString(36).slice(2, 6);
    const def = { key, name, type: "user", blob, count, baseScale: 2.6, baseTilt: 0 };
    this.defs.push(def);
    if (this.db) {
      try {
        const tx = this.db.transaction(STORE, "readwrite");
        tx.objectStore(STORE).put({ key, name, blob, count });
      } catch (e) { console.warn("持久化失败", e); }
    }
    this.emit();
    return def;
  }

  async removeUserModel(key) {
    const i = this.defs.findIndex((d) => d.key === key);
    if (i >= 0) { this.defs.splice(i, 1); }
    if (this.db) {
      try {
        const tx = this.db.transaction(STORE, "readwrite");
        tx.objectStore(STORE).delete(key);
      } catch {}
    }
    this.emit();
  }

  onChange(fn) { this.listeners.add(fn); }
  emit() { for (const fn of this.listeners) fn(this.defs); }
}
