/* 플로어 운영 로직: 토너먼트 클락(이벤트별 블라인드 구조) + 딜러 관리(dealer-director 앱을 iframe 으로 연결) */
const Floor = (() => {
  /* ---------- 블라인드 구조 / 클락 ---------- */
  const DEF = [[100,200,200],[200,300,300],[200,400,400],[300,600,600],[400,800,800],'B',[500,1000,1000],[600,1200,1200],[800,1600,1600],[1000,2000,2000],[1200,2400,2400],'B',[1500,3000,3000],[2000,4000,4000],[2500,5000,5000],[3000,6000,6000],[4000,8000,8000],'B',[5000,10000,10000],[6000,12000,12000],[8000,16000,16000],[10000,20000,20000],[15000,30000,30000],[20000,40000,40000],[25000,50000,50000],[30000,60000,60000]];
  const defaultLevels = () => DEF.map(l => l === 'B' ? { brk: true, min: 10 } : { sb: l[0], bb: l[1], ante: l[2], min: 20 });

  const levels = (ev) => (ev.levels && ev.levels.length) ? ev.levels : defaultLevels();
  /** 저장된 클락이 없으면 레벨 1 정지 상태 */
  const clockOf = (ev) => ev.clock || { idx: 0, running: false, remain: levels(ev)[0].min * 60000, anchor: null };
  /** 클락을 바꾸기 전에 호출: 이벤트에 levels/clock 필드를 실제로 만든다 */
  function ensure(ev) {
    if (!ev.levels || !ev.levels.length) ev.levels = defaultLevels();
    if (!ev.clock) ev.clock = clockOf(ev);
    return ev.clock;
  }
  const remain = (c) => c.running ? c.remain - (Date.now() - c.anchor) : c.remain;

  /** 브레이크를 뺀 레벨 번호 (브레이크 중이면 직전 레벨 번호) */
  function levelNo(ev, i) { const lv = levels(ev); let n = 0; for (let k = 0; k <= i && k < lv.length; k++) if (!lv[k].brk) n++; return n; }
  const levelLabel = (ev, i) => levels(ev)[i] && levels(ev)[i].brk ? '브레이크' : '레벨 ' + levelNo(ev, i);
  const fmt = (n) => (n || 0).toLocaleString('ko-KR');
  const blindText = (l) => !l ? '-' : l.brk ? '휴식 ' + l.min + '분' : `${fmt(l.sb)} / ${fmt(l.bb)}` + (l.ante ? ` (${fmt(l.ante)})` : '');
  function mmss(ms) {
    ms = Math.max(0, ms); const s = Math.ceil(ms / 1000);
    const hh = Math.floor(s / 3600), m = Math.floor(s % 3600 / 60), ss = s % 60, z = (n) => String(n).padStart(2, '0');
    return (hh ? hh + ':' + z(m) : z(m)) + ':' + z(ss);
  }
  /** 현재(또는 직전) 플레이 레벨의 빅블라인드 */
  function currentBB(ev) { const lv = levels(ev); for (let i = clockOf(ev).idx; i >= 0; i--) if (!lv[i].brk) return lv[i].bb; return 1; }
  /** 다음 브레이크까지 남은 ms (브레이크 중이거나 남은 브레이크가 없으면 null) */
  function breakIn(ev) {
    const lv = levels(ev), c = clockOf(ev);
    if (lv[c.idx] && lv[c.idx].brk) return null;
    let ms = remain(c);
    for (let i = c.idx + 1; i < lv.length; i++) { if (lv[i].brk) return ms; ms += lv[i].min * 60000; }
    return null;
  }
  /** 레이트 레지: lateRegLevel(레벨 번호) 이 끝날 때 마감. 0 이면 설정 안 함 */
  function lateRegOpen(ev) { if (!ev.lateRegLevel) return null; return levelNo(ev, clockOf(ev).idx) <= ev.lateRegLevel; }

  function start(ev) { const c = ensure(ev); if (c.running) return; c.running = true; c.anchor = Date.now(); }
  function pause(ev) { const c = ensure(ev); if (!c.running) return; c.remain = remain(c); c.running = false; c.anchor = null; }
  function setLevel(ev, idx) {
    const c = ensure(ev); idx = Math.max(0, Math.min(ev.levels.length - 1, idx));
    c.idx = idx; c.remain = ev.levels[idx].min * 60000; c.anchor = c.running ? Date.now() : null;
  }
  function addTime(ev, ms) { const c = ensure(ev); c.remain = Math.max(0, remain(c) + ms); if (c.running) c.anchor = Date.now(); }
  /** 시간이 다 된 레벨을 넘긴다. 레벨이 바뀌었으면 true */
  function advance(ev) {
    const c = ev.clock; if (!c || !c.running) return false;
    let r = remain(c), changed = false;
    while (r <= 0 && c.idx < ev.levels.length - 1) {
      const over = -r; c.idx++; c.remain = ev.levels[c.idx].min * 60000 - over; c.anchor = Date.now(); r = c.remain; changed = true;
    }
    if (r <= 0) { c.remain = 0; c.running = false; c.anchor = null; changed = true; }
    return changed;
  }

  /* ---------- 딜러: dealer-director(DD) 앱을 iframe(#ddFrame, dd/index.html)으로 통째로 띄우고 postMessage 로 잇는다 ----------
     TD 이벤트 하나 = DD 이벤트 하나 (id = ddEventId(ev)). 이벤트에 들어가면 DD 가 그 이벤트를 열고(없으면 만들고), 이름도 따라간다.
     TD → DD: {td:'dd', type:'event', id, name}  지금 이벤트 (바뀔 때)
              {td:'dd', type:'tables', event, open:[번호…]}  그 이벤트의 열린 테이블 번호 → DD 가 없는 번호는 열고(쉬는 딜러 자동 배치), 사라진 번호는 깬다
              {td:'dd', type:'deleteEvent', id} · {type:'logout'} · {type:'settings'} · {type:'share'}
     DD → TD: {dd:'td', type:'state', tables:[{no, dealer, since, feature}], staffing, clock, event, account, blocked}  그릴 때마다(바뀐 것만)
              {dd:'td', type:'page', page:'login'|'list'|'admin'|…, account, blocked, height}  이벤트가 열려 있지 않을 때 (login 이면 앱 전체를 막는다 → gate)
     account = {name, email, until, admin} — 홈의 계정 카드와 관리자 계정 발급(admin 일 때만)에 쓴다
     DD 상태는 DD 가 자기 저장소(dealer-director:…)에 들고 있다. 여기 live 는 화면 표시용 사본일 뿐 TD state 에 저장하지 않는다. */
  const live = { page: null, event: null, tables: [], staffing: null, clock: null, dealers: 0, room: null, account: null, blocked: null, at: 0 };
  const listeners = [];
  const frame = () => document.getElementById('ddFrame');
  const adminFrame = () => document.getElementById('ddAdminFrame');
  const ddOrigin = () => (/^https?:$/.test(location.protocol) ? location.origin : '*');
  function post(msg) { const f = frame(); if (!f || !f.contentWindow) return; try { f.contentWindow.postMessage(Object.assign({ td: 'dd' }, msg), ddOrigin()); } catch (e) { /* 아직 안 뜸 */ } }
  /** TD 이벤트 하나 = DD 이벤트 하나. DD 이벤트 id 는 TD 이벤트 id 로 만든다 (파이어베이스 경로에 쓰이므로 영숫자만) */
  const ddEventId = (ev) => 'td' + String(ev.id).replace(/[^A-Za-z0-9_-]/g, '');
  const selected = (s) => s.events.find(e => e.id === s.selectedEventId) || null;
  const openNumbers = (s, ev) => Array.from(new Set(s.tables.filter(t => t.eventId === ev.id && t.status === 'open').map(t => t.number))).sort((a, b) => a - b);
  let sentEvent = '', sentTables = '';
  /** 지금 이벤트(id·이름)와 그 이벤트의 열린 테이블 번호를 DD 에 보낸다. 바뀐 것만 보내므로 commit·patch 마다 불러도 된다. force = DD 가 새로 떴거나 어긋났을 때 */
  function sync(s, force) {
    const ev = selected(s);
    const evSig = ev ? ddEventId(ev) + '|' + ev.name : '';
    if (force || evSig !== sentEvent) { sentEvent = evSig; if (ev) post({ type: 'event', id: ddEventId(ev), name: ev.name }); }
    const open = ev ? openNumbers(s, ev) : [];
    const tSig = ev ? ddEventId(ev) + ':' + open.join(',') : '';
    if (force || tSig !== sentTables) { sentTables = tSig; if (ev) post({ type: 'tables', event: ddEventId(ev), open }); }
  }
  function onMessage(e) {
    const m = e.data; if (!m || m.dd !== 'td') return;
    if (ddOrigin() !== '*' && e.origin !== ddOrigin()) return;
    const af = adminFrame();
    if (af && e.source === af.contentWindow) { // 홈의 계정 관리 iframe: 높이만 맞춘다
      if (m.type === 'page' && m.height) af.style.height = Math.max(360, m.height + 8) + 'px';
      return;
    }
    if (m.type === 'ready' || m.type === 'hello') { if (typeof Store !== 'undefined') sync(Store.get(), true); return; }
    if (m.type === 'page') { Object.assign(live, { page: m.page, event: null, tables: [], staffing: null, clock: null, room: null, account: m.account || null, blocked: m.blocked || null, at: Date.now() }); }
    else if (m.type === 'state') {
      Object.assign(live, { page: m.page, event: m.event, tables: m.tables || [], staffing: m.staffing, clock: m.clock, dealers: m.dealers || 0, room: m.room, account: m.account || null, blocked: m.blocked || null, at: Date.now() });
      // DD 가 보여 주는 이벤트·테이블이 TD 와 다르면 다시 맞춘다 (TD 가 기준)
      if (typeof Store !== 'undefined') {
        const s = Store.get(), ev = selected(s);
        if (ev && (!m.event || m.event.id !== ddEventId(ev) || (m.tables || []).map(t => t.no).sort((a, b) => a - b).join(',') !== openNumbers(s, ev).join(','))) sync(s, true);
      }
    }
    else return;
    listeners.forEach(fn => fn(live));
  }
  if (typeof window !== 'undefined') window.addEventListener('message', onMessage);
  const onLive = (fn) => listeners.push(fn);
  /** TD 테이블(id)에 앉은 DD 딜러 {name, since} — DD 가 그 이벤트를 열고 있을 때만 */
  function dealerAt(s, tableId) {
    const t = s.tables.find(x => x.id === tableId); if (!t) return null;
    const ev = s.events.find(e => e.id === t.eventId);
    if (!ev || !live.event || live.event.id !== ddEventId(ev)) return null;
    const dt = live.tables.find(x => x.no === t.number);
    return dt && dt.dealer ? { name: dt.dealer, since: dt.since } : null;
  }
  const ddReady = () => live.page === 'event';
  /** 앱 문: 승인된 DD 계정으로 로그인해야 앱 전체를 쓸 수 있다 (2026-10-13 사용자 요청).
      'boot'(DD 가 아직 보고 전) · 'login'(로그인 화면) · 'blocked'(다른 PC 로그인·기간 만료·정지 — DD 가 자기 화면에 이유를 띄운다) · 'ok' */
  const gate = () => (!live.page ? 'boot' : live.page === 'login' ? 'login' : live.blocked ? 'blocked' : 'ok');
  const nextPushIn = () => (live.clock && live.clock.running && live.clock.nextPushAt != null) ? live.clock.nextPushAt - (Date.now() + (live.clock.offset || 0)) : null;
  const openSettings = () => post({ type: 'settings' });
  const openShare = () => post({ type: 'share' });
  /** TD 이벤트를 지울 때 DD 이벤트(딜러 기록)도 지운다. 전체 초기화도 이벤트마다 부른다 */
  const deleteEvent = (ev) => post({ type: 'deleteEvent', id: ddEventId(ev) });
  const logout = () => post({ type: 'logout' });
  /** DD 화면 주소. 어느 이벤트를 열지는 sync 가 'event' 메시지로 정한다 */
  const frameSrc = () => 'dd/index.html';
  const adminSrc = () => 'dd/index.html?admin';

  return { defaultLevels, levels, clockOf, ensure, remain, levelNo, levelLabel, blindText, mmss, currentBB, breakIn, lateRegOpen, start, pause, setLevel, addTime, advance,
    live, onLive, sync, dealerAt, ddEventId, ddReady, gate, nextPushIn, openSettings, openShare, deleteEvent, logout, frameSrc, adminSrc, post };
})();
