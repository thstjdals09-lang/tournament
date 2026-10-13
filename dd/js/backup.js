/*
 * 백업 파일 — 계정의 모든 이벤트를 파일 하나로 보관한다 (이벤트는 계정에 저장되므로 PC를 바꿀 때는 로그인만 하면 된다).
 *  - 모든 이벤트 (이벤트마다 테이블·딜러·출퇴근·공지·기록, 딜러용 링크·QR의 방)
 *  - 로그인 정보는 넣지 않는다 (예전 백업에 들어 있던 익명 로그인 정보도 버린다)
 * 예전 백업(이벤트 기능 전, 대회 하나)도 읽어서 이벤트 하나로 바꾼다. 예전 백업의 딜러 DB(연락처·계좌)는 버린다.
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.DealerBackup = api;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const KIND = 'dealer-director-backup';
  const pad = n => String(n).padStart(2, '0');

  const pick = e => ({ id: e.id, name: e.name, createdAt: e.createdAt, room: e.room || null, shareOff: !!e.shareOff, state: e.state || null });

  // events: [{id, name, createdAt, room, shareOff, state}]
  function makeBackup(events, now) {
    return {
      kind: KIND,
      version: 3,
      exportedAt: now,
      events: (events || []).map(pick),
    };
  }

  // newId: 예전 백업을 이벤트로 바꿀 때 쓸 id 만들기
  function readBackup(text, newId) {
    let data;
    try {
      data = JSON.parse(String(text || '').replace(/^﻿/, ''));
    } catch (e) {
      throw new Error('백업 파일을 읽을 수 없습니다 (형식이 맞지 않음)');
    }
    if (!data || data.kind !== KIND) throw new Error('딜러 디렉터 백업 파일이 아닙니다');
    let events = Array.isArray(data.events) ? data.events.filter(e => e && e.id).map(pick) : [];
    if (!data.version || data.version < 2) {
      // 이벤트 기능 전: 대회 하나 + 공유 방 하나 → '불러온 대회' 이벤트
      const room = data.sync && data.sync.room ? data.sync.room : null;
      events = data.state || room
        ? [{ id: newId(), name: '불러온 대회', createdAt: data.exportedAt || null, room, shareOff: false, state: data.state || null }]
        : [];
    }
    return { events, exportedAt: data.exportedAt || null };
  }

  function fileName(now) {
    const d = new Date(now);
    return `dealer-director-backup-${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}.json`;
  }

  return { KIND, makeBackup, readBackup, fileName };
});
