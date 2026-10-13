/* 플로어 운영 로직: 토너먼트 클락(이벤트별 블라인드 구조) + 딜러 관리(현장 공통, dealer-director 엔진 연결) */
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

  /* ---------- 딜러: dealer-director(DD) 엔진에 맡긴다 (현장 공통 state.dd) ----------
     DD 테이블 id 는 't'+번호. Holdem TD 의 열린 테이블 번호와 DD 의 열린 테이블을 sync 로 맞추면
     DD 가 공석 테이블에 쉬는 딜러를 자동으로 앉히고(fillVacancies), 깨진 테이블 딜러는 휴식으로 돌린다. */
  const DE = (typeof DealerEngine !== 'undefined') ? DealerEngine : null;
  const dd = (s) => { if (!s.dd) s.dd = DE.createState(); return s.dd; };
  const ddTableId = (no) => 't' + no;
  /** TD 의 열린 테이블 번호 ↔ DD 열린 테이블을 맞춘다. Store.commit 마다 호출 */
  function sync(s, now) {
    if (!DE) return;
    now = now || Date.now();
    const tdOpen = Array.from(new Set(s.tables.filter(t => t.status === 'open').map(t => t.number))).sort((a, b) => a - b);
    let d = dd(s);
    const ddOpen = DE.activeTables(d).map(t => t.no);
    ddOpen.filter(no => !tdOpen.includes(no)).forEach(no => { d = DE.closeTable(d, ddTableId(no), now); });
    const toOpen = tdOpen.filter(no => !ddOpen.includes(no));
    if (toOpen.length) d = DE.openTable(d, toOpen, now);
    s.dd = d;
  }
  /** TD 테이블(id)에 앉은 DD 딜러 */
  function dealerAt(s, tableId) {
    const t = s.tables.find(x => x.id === tableId); if (!t || !s.dd) return null;
    const dt = DE.tableOf(s.dd, ddTableId(t.number));
    return dt && dt.status === 'open' && dt.dealerId ? DE.dealerOf(s.dd, dt.dealerId) : null;
  }
  const dealers = (s) => (s.dd ? s.dd.dealers : []);
  const run = (s, fn) => { s.dd = fn(dd(s), Date.now()); };
  /** 이름(쉼표·줄바꿈 구분)으로 출근. 퇴근했던 사람은 복귀 */
  const attend = (s, text) => run(s, (d, now) => String(text).split(/[,\n\t]+/).map(x => x.trim()).filter(Boolean).reduce((acc, name) => DE.attend(acc, name, now, true), d));
  const sendHome = (s, id) => run(s, (d, now) => DE.sendHome(d, id, now));
  const checkBack = (s, id) => run(s, (d, now) => DE.checkBack(d, id, now));
  const toggleHold = (s, id) => run(s, (d, now) => DE.toggleHold(d, id, now));
  const assign = (s, tableNo, id) => run(s, (d, now) => DE.assignDealer(d, ddTableId(tableNo), id, now));
  const relieve = (s, tableNo) => run(s, (d, now) => DE.relieveTable(d, ddTableId(tableNo), now));
  function rotate(s) { // 시작 전이면 로테이션 시작, 진행 중이면 지금 교대
    const d = dd(s), now = Date.now();
    if (!d.clock.running) { s.dd = DE.startClock(d, now); return null; }
    const r = DE.executePush(d, now); s.dd = r.state; return r.plan;
  }
  const togglePause = (s) => run(s, (d, now) => d.clock.paused ? DE.resumeClock(d, now) : DE.pauseClock(d, now));
  const setPushMinutes = (s, m) => run(s, (d, now) => DE.updateSettings(d, { pushMinutes: m }, now));
  const nextPushIn = (s) => s.dd ? DE.msToPush(s.dd, Date.now()) : null;
  /** 자동 교대 시각이 됐나 */
  const pushDue = (s) => { const d = s.dd; return !!(d && d.clock.running && !d.clock.paused && d.settings.autoPush && DE.msToPush(d, Date.now()) <= 0); };
  const planNext = (s) => s.dd && s.dd.clock.running ? DE.planPush(s.dd, Date.now()) : null;
  const seatedMin = (s, d) => Math.max(0, Math.floor((DE.clockNow(s.dd, Date.now()) - d.since) / 60000));

  return { defaultLevels, levels, clockOf, ensure, remain, levelNo, levelLabel, blindText, mmss, currentBB, breakIn, lateRegOpen, start, pause, setLevel, addTime, advance,
    DE, dd, sync, dealerAt, dealers, attend, sendHome, checkBack, toggleHold, assign, relieve, rotate, togglePause, setPushMinutes, nextPushIn, pushDue, planNext, seatedMin };
})();
