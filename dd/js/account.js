/*
 * DD 계정 — 이용 기간 계산, 계정별 저장 공간, 이 PC와 클라우드(users/{uid}) 맞추기.
 *  - 이 PC의 저장(localStorage)도 계정마다 따로: dealer-director:u:{uid}:events, dealer-director:u:{uid}:event:{id}
 *    → 같은 PC에서 다른 계정으로 로그인해도 서로의 이벤트가 섞이지 않는다
 *  - 클라우드: users/{uid}/events/{id} = 목록에 보일 것 + rev, users/{uid}/states/{id} = 상태 전체(JSON 글자 하나)
 *    (Firebase는 빈 배열·null을 저장하지 않아 상태 모양이 바뀌므로 글자로 통째로 넣는다)
 *  - rev = 이벤트를 고칠 때마다 1씩 오르는 번호, cloudRev = 클라우드에 마지막으로 올린(받은) 번호
 *    rev > cloudRev 이면 아직 못 올린 변경이 있다
 * 모두 순수 함수 (시간 now 주입) — app.js가 화면·통신을 맡는다.
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.DealerAccount = api;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const DAY = 24 * 60 * 60 * 1000;
  const pad = n => String(n).padStart(2, '0');

  // ---------- 이용 기간 ----------

  // 'YYYY-MM-DD' → 그날 23:59:59.999 (이 PC 시간대)
  function endOfDay(dateStr) {
    const m = String(dateStr || '').match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
    if (!m) return null;
    return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]), 23, 59, 59, 999).getTime();
  }

  const dateStr = t => {
    const d = new Date(t);
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  };

  // n개월 뒤 같은 날 (1/31 + 1개월 = 2/28처럼 그 달의 마지막 날로)
  function addMonths(t, n) {
    const d = new Date(t);
    const day = d.getDate();
    const x = new Date(d.getFullYear(), d.getMonth() + n, 1, 23, 59, 59, 999);
    const last = new Date(x.getFullYear(), x.getMonth() + 1, 0).getDate();
    x.setDate(Math.min(day, last));
    return x.getTime();
  }

  // 기간 연장: 아직 남아 있으면 끝나는 날부터, 끝났거나 정지였으면 오늘부터 n개월
  const extend = (until, months, now) => addMonths(until > now ? until : now, months);

  // 계정 상태: none(등록 안 됨) · off(정지) · expired(기간 끝) · ok
  function license(acc, now) {
    if (!acc || typeof acc.until !== 'number') return { state: 'none', until: null, daysLeft: 0 };
    if (acc.until <= 0) return { state: 'off', until: null, daysLeft: 0 };
    if (acc.until <= now) return { state: 'expired', until: acc.until, daysLeft: 0 };
    return { state: 'ok', until: acc.until, daysLeft: Math.ceil((acc.until - now) / DAY) };
  }

  // 판매자에게 보여 줄 말
  function licenseText(acc, now) {
    const l = license(acc, now);
    if (l.state === 'none') return '등록 안 됨';
    if (l.state === 'off') return '정지';
    if (l.state === 'expired') return `${dateStr(l.until)} 만료`;
    return `${dateStr(l.until)}까지 (${l.daysLeft}일 남음)`;
  }

  // 고객에게 줄 임시 비밀번호 (헷갈리는 글자 뺌)
  function makePassword(len) {
    const chars = 'abcdefghjkmnpqrstuvwxyzABCDEFGHJKMNPQRSTUVWXYZ23456789';
    const bytes = new Uint8Array(len || 10);
    globalThis.crypto.getRandomValues(bytes);
    return Array.from(bytes, b => chars[b % chars.length]).join('');
  }

  // ---------- 계정별 저장 공간 ----------

  // localStorage처럼 쓰되 키 앞에 계정을 붙인다 ('dealer-director:events' → 'dealer-director:u:{uid}:events')
  function scoped(storage, uid) {
    const prefix = `dealer-director:u:${uid}:`;
    const key = k => prefix + String(k).replace(/^dealer-director:/, '');
    return {
      prefix,
      key,
      getItem: k => storage.getItem(key(k)),
      setItem: (k, v) => storage.setItem(key(k), v),
      removeItem: k => storage.removeItem(key(k)),
    };
  }

  // 이 PC에서 그 계정의 저장분을 모두 지운다 (로그아웃)
  function clearScoped(storage, uid) {
    const prefix = `dealer-director:u:${uid}:`;
    const keys = [];
    for (let i = 0; i < storage.length; i++) {
      const k = storage.key(i);
      if (k && k.startsWith(prefix)) keys.push(k);
    }
    keys.forEach(k => storage.removeItem(k));
    return keys.length;
  }

  // ---------- 클라우드와 맞추기 ----------

  const dirty = ev => (ev.rev || 0) > (ev.cloudRev == null ? -1 : ev.cloudRev);

  // 클라우드 목록에 올릴 것 (rev 포함, 상태는 따로). sum = 목록 화면에 보일 요약
  function cloudMeta(ev, sum) {
    return {
      id: ev.id,
      name: ev.name,
      createdAt: ev.createdAt || 0,
      room: ev.room || null,
      shareOff: !!ev.shareOff,
      share: ev.share || null, // 같이 쓰기 참가 코드 (다른 PC에서 로그인해도 이어서 쓰게)
      guest: !!ev.guest,       // 코드로 들어온 이벤트 (내 것이 아님)
      rev: ev.rev || 0,
      sum: sum || null,
    };
  }

  // 클라우드에서 받은 목록 항목 → 이 PC의 목록 항목 (상태는 열 때 받아 온다)
  const fromCloud = c => ({
    id: c.id,
    name: c.name,
    createdAt: c.createdAt || 0,
    room: c.room || null,
    shareOff: !!c.shareOff,
    share: c.share || null,
    guest: !!c.guest,
    sum: c.sum || null,
    rev: c.rev || 0,
    cloudRev: c.rev || 0,
  });

  // 이 PC의 목록(local)과 클라우드 목록(cloud = {id: meta})을 맞춘다
  //  - 클라우드가 더 새것(다른 PC에서 고침) → 클라우드 것으로, 이 PC의 상태는 버리고 다시 받는다(fetch)
  //  - 이 PC에만 고친 것이 있고 클라우드는 그대로 → 올린다(push)
  //  - 클라우드에서 지워진 것(다른 PC에서 삭제) → 이 PC에서도 지운다(drop)
  //  - 한 번도 안 올린 것(인터넷 없이 만든 이벤트) → 올린다
  // 한 번에 한 PC만 로그인하므로, 다른 PC가 고쳤다면 그쪽이 나중 → 클라우드 것을 따른다
  function reconcile(local, cloud) {
    const c = cloud && typeof cloud === 'object' ? cloud : {};
    const out = [];
    const push = [];
    const fetch = [];
    const drop = [];
    const seen = new Set();
    for (const l of local) {
      seen.add(l.id);
      const r = c[l.id];
      const base = l.cloudRev == null ? -1 : l.cloudRev;
      if (!r) {
        if (l.cloudRev == null) {
          out.push(l);
          push.push(l.id);
        } else {
          drop.push(l.id);
        }
      } else if ((r.rev || 0) > base) {
        out.push(fromCloud(Object.assign({ id: l.id }, r)));
        fetch.push(l.id);
      } else {
        out.push(l);
        if (dirty(l)) push.push(l.id);
      }
    }
    for (const [id, r] of Object.entries(c)) {
      if (seen.has(id) || !r) continue;
      out.push(fromCloud(Object.assign({ id }, r)));
      fetch.push(id);
    }
    out.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
    return { list: out, push, fetch, drop };
  }

  return {
    DAY, endOfDay, dateStr, addMonths, extend, license, licenseText, makePassword,
    scoped, clearScoped, dirty, cloudMeta, fromCloud, reconcile,
  };
});
