/*
 * 이벤트(대회) 목록 — 이벤트마다 로테이션·출퇴근·기록·공지와 실시간 공유 방(딜러용 QR)을 따로 둔다.
 *  - 목록: dealer-director:events = [{id, name, createdAt, room, shareOff, share, guest, sharedRev, rev, cloudRev}]
 *    share = 같이 쓰기 참가 코드(있으면 내용은 shared/{코드}에 둔다), guest = 코드로 들어온 이벤트, sharedRev = 마지막으로 맞춘 번호
 *    rev·cloudRev = 클라우드와 맞추는 번호 (account.js)
 *  - 이벤트마다 상태: dealer-director:event:{id}
 *  - 로그인하면 storage는 그 계정 전용 공간(account.js의 scoped) — 계정마다 목록이 따로
 *  - 계정 기능 전(로그인 없이) 쓰던 데이터는 계정 없는 키에 남아 있다 → 로그인할 때 그 계정으로 옮긴다
 *    (그보다 전, 이벤트 기능 전의 데이터는 먼저 '기존 대회' 이벤트 하나로: migrateLegacy)
 * storage는 localStorage처럼 getItem/setItem/removeItem이 있는 것 (테스트에서는 가짜를 넣는다)
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.DealerEvents = api;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const LIST_KEY = 'dealer-director:events';
  const LEGACY_KEY = 'dealer-director:v1';
  const SYNC_KEY = 'dealer-director:sync'; // 계정 기능 전의 익명 파이어베이스 로그인 (옮긴 뒤 지운다)
  const stateKey = id => `dealer-director:event:${id}`;

  function read(storage, key) {
    try { return JSON.parse(storage.getItem(key)); } catch (e) { return null; }
  }
  function write(storage, key, value) {
    if (value == null) storage.removeItem(key);
    else storage.setItem(key, JSON.stringify(value));
  }

  function list(storage) {
    const v = read(storage, LIST_KEY);
    return Array.isArray(v) ? v : [];
  }
  const find = (l, id) => l.find(e => e.id === id) || null;

  const newId = now => 'e' + now.toString(36) + Math.random().toString(36).slice(2, 6);

  // 이름을 안 적으면 "10/6 이벤트", 같은 이름이 있으면 "10/6 이벤트 2"
  function defaultName(l, now) {
    const d = new Date(now);
    const base = `${d.getMonth() + 1}/${d.getDate()} 이벤트`;
    let name = base;
    for (let i = 2; l.some(e => e.name === name); i++) name = `${base} ${i}`;
    return name;
  }

  // extra로 id·share 같은 것을 정해 넣을 수 있다 (코드로 참가할 때)
  function create(storage, name, now, state, extra) {
    const l = list(storage);
    const ev = Object.assign({ id: newId(now), name: String(name || '').trim() || defaultName(l, now), createdAt: now,
      room: null, shareOff: false, share: null, guest: false, sharedRev: 0, rev: 1, cloudRev: null }, extra || {});
    write(storage, stateKey(ev.id), state);
    write(storage, LIST_KEY, [ev].concat(l));
    return ev;
  }

  // 바뀐 이벤트 정보를 돌려준다 (없는 이벤트면 null)
  function update(storage, id, patch) {
    let found = null;
    const l = list(storage).map(e => {
      if (e.id !== id) return e;
      found = Object.assign({}, e, patch);
      return found;
    });
    if (found) write(storage, LIST_KEY, l);
    return found;
  }

  const saveList = (storage, l) => write(storage, LIST_KEY, l);

  function remove(storage, id) {
    write(storage, LIST_KEY, list(storage).filter(e => e.id !== id));
    storage.removeItem(stateKey(id));
  }

  const loadState = (storage, id) => read(storage, stateKey(id));

  // 목록에 보일 요약
  function summary(s) {
    if (!s) return { tables: 0, dealers: 0, status: '시작 전' };
    const tables = (s.tables || []).filter(t => t.status === 'open').length;
    const dealers = (s.dealers || []).filter(d => d.status !== 'off' && d.status !== 'planned').length; // 출근해 있는 딜러 (출근 예정 제외)
    const c = s.clock || {};
    return { tables, dealers, status: !c.running ? '시작 전' : c.paused ? '일시정지' : '진행 중' };
  }

  // 이벤트 기능 전의 데이터(대회 하나 + 공유 방 하나)를 '기존 대회' 이벤트로. 이미 옮겼거나 옮길 것이 없으면 아무것도 안 함
  function migrateLegacy(storage, now) {
    if (read(storage, LIST_KEY)) return null;
    const old = read(storage, LEGACY_KEY);
    const sync = read(storage, SYNC_KEY);
    const room = sync && sync.room ? sync.room : null;
    const used = old && ((old.dealers && old.dealers.length) || (old.tables && old.tables.length));
    let ev = null;
    if (used || room) {
      ev = { id: newId(now), name: '기존 대회', createdAt: now, room, shareOff: false };
      write(storage, stateKey(ev.id), old);
    }
    if (ev) write(storage, LIST_KEY, [ev]); // 옮길 것이 없으면 아무것도 남기지 않는다 (계정 없는 자리는 비워 둔다)
    if (sync && 'room' in sync) {
      const account = Object.assign({}, sync);
      delete account.room; // 방은 이제 이벤트마다 — 계정(설정·로그인)만 남긴다
      write(storage, SYNC_KEY, account);
    }
    storage.removeItem(LEGACY_KEY);
    return ev;
  }

  // 백업 파일·계정 없이 쓰던 데이터에서 꺼낸 이벤트들을 넣는다. 같은 id면 덮어쓰고, 없으면 추가
  // 넣은 것은 모두 '아직 클라우드에 안 올림' (rev가 cloudRev보다 큼) → 올린다
  function importEvents(storage, events) {
    let l = list(storage);
    const added = []; // 새로 들어온 이벤트는 백업의 순서 그대로 목록 위에
    for (const x of events) {
      const prev = find(l, x.id);
      const ev = {
        id: x.id, name: x.name, createdAt: x.createdAt, room: x.room || null, shareOff: !!x.shareOff,
        share: x.share || null, guest: !!x.guest, sharedRev: x.sharedRev || 0,
        rev: (prev ? prev.rev || 0 : 0) + 1, cloudRev: prev ? prev.cloudRev : null,
      };
      write(storage, stateKey(ev.id), x.state || null);
      if (find(l, ev.id)) l = l.map(e => (e.id === ev.id ? ev : e));
      else added.push(ev);
    }
    write(storage, LIST_KEY, added.concat(l));
  }

  return { LIST_KEY, LEGACY_KEY, SYNC_KEY, stateKey, list, find, newId, defaultName, create, update, saveList, remove, loadState, summary, migrateLegacy, importEvents };
});
