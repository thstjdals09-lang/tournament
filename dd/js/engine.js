/*
 * 딜러 로테이션 엔진 — 순수 로직만 둔다 (DOM/저장소 의존 없음).
 * 모든 공개 함수는 state를 직접 바꾸지 않고 새 state를 돌려준다.
 * 시간은 항상 now(ms)로 주입받는다 → 테스트에서 시간을 마음대로 돌릴 수 있다.
 *
 * 로테이션 방식: 차례대로 교대 (2026-10-11 사용자 요청으로 누적 장부 방식에서 바꿈)
 *   - 들어갈 순서: 첫 출근자 → 지금 오래 쉰 사람 순 (보류였던 시간은 쉰 것으로 치지 않는다)
 *   - 나갈 순서: 최대 연속 근무를 넘긴 사람 → 지금 오래 앉아 있는 사람 순 → 테이블 번호 순
 *   - 쉬고 있는 사람 수만큼 바꾼다 → 한 번 쉰 사람은 다음 교대에 반드시 들어간다.
 *     '연속 두 번 휴식'은 쉬는 사람이 바꿀 수 있는 테이블보다 많을 때만 생긴다 (8테이블 20명 같은 경우)
 *   - 하루치를 되짚어 '총 휴식 시간'을 맞추지 않는다 — 그러면 늦게 출근한 사람이 계속 쉬게 된다
 *   - 다른 업무(칩 정리·등록 등) 중인 딜러는 테이블에 없지만 근무로 센다 (로테에 들어간 것과 같게) —
 *     업무 시간은 휴식이 아니고, 끝나면 테이블에서 막 나온 사람처럼 그때부터 쉰다
 *
 * 딜러 상태: planned(출근 예정·출근 전) → break(휴식) ⇄ working(테이블) ⇄ duty(다른 업무) → off(퇴근)
 *   → 모두 같은 시각에 시작하면 1·2번 → 3·4번 … 순서가 되고,
 *     출근 시각·테이블 오픈/깨짐이 섞여도 "쉬면 바로 다음 차례"가 지켜진다.
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.DealerEngine = api;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const MIN = 60000;
  const VERSION = 3;
  const PLAN_MAX = 40; // 표에서 직접 정해 둘 수 있는 교대 예약 수(= 앞으로 몇 번째 교대까지)

  const SETTINGS_REV = 2; // 기본값이 바뀌어 저장된 설정에도 적용해야 할 때 올린다

  const DEFAULT_SETTINGS = {
    pushMinutes: 20,      // 교대 간격
    maxWorkMinutes: 0,    // 최대 연속 근무(분). 0 = 제한 없음 — 딜러 수 = 테이블 수로 도는 날도 있으므로 기본은 없음.
                          // 정하면: 넘긴 딜러 우선 교대, 연장 경고, 권장 인원 계산 기준
    minRestMinutes: 15,   // 이보다 짧게 쉰 딜러는 교대에 넣지 않음
    shortSeatMinutes: 10, // 이보다 짧게 일한 딜러는 교대 대상 아님 (휴식 없이 재투입도 가능)
    warnBeforeMinutes: 2, // 교대 예고 알림
    autoPush: true,
    voice: true,
    openUse: false,       // 테이블을 열 때 바로 사용(딜러 투입)할지 — 끄면 '대기'로 열고 칸에서 [사용]을 체크할 때 투입
    autoArrive: false,    // 출근 체크 없이도 예정 시각에 자동 출근 — 기본은 꺼짐: 딜러가 출근 QR로 체크해야 투입 (사용자 요청)
  };

  function createState(settings) {
    return {
      version: VERSION,
      settingsRev: SETTINGS_REV,
      settings: Object.assign({}, DEFAULT_SETTINGS, settings),
      clock: { running: false, paused: false, nextPushAt: null, pausedAt: null, intervalPlan: null }, // intervalPlan: 교대 간격 예약 {at, minutes}
      tables: [],
      dealers: [],
        history: [],    // 교대 시점마다 {at, a: {딜러id: 테이블번호 | 0(휴식)}}
      notices: [],    // 공지 {id, at, text}
      roster: [],     // 출근자 명단 {name, grade} — 체크하면 출근, 풀면 퇴근
                      // 체크 상태는 따로 두지 않는다: 그 이름의 딜러가 출근해 있으면 체크된 것 (rosterView)
      eoCall: { open: false, id: null, at: null }, // 휴대폰으로 퇴근 희망 받기 (열려 있으면 모든 딜러 휴대폰에 버튼)
      button: null,   // 오늘 버튼 {no: 1~9, at} — 무작위로 뽑아 디렉터·딜러 휴대폰·TV에 보인다
      past: [],       // 작업 되돌리기용 — 작업 직전 모습 {at, label, snap | full}
      plans: [],      // 표에서 끌어다 놓은 교대 예약 — {n, type, a, b}. n = 앞으로 n번째 교대(1 = 다음 교대)
                      // type 'swap': a와 b의 자리를 맞바꾼다 / 'rest': a를 쉬게 / 'keep': a를 안 빼고 그대로
      log: [],
      seq: 0,
      turnSeq: 0,     // 줄 순번 계수기 — 자리에 앉거나 쉬러 갈 때마다 1씩 (딜러의 turn)
    };
  }

  function migrate(raw) {
    const base = createState();
    if (!raw || (raw.version !== VERSION && raw.version !== 2)) return base;
    const s = Object.assign(base, raw, {
      version: VERSION,
      settings: Object.assign({}, DEFAULT_SETTINGS, raw.settings),
      clock: Object.assign({}, base.clock, raw.clock),
      // Firebase는 빈 객체를 지우므로 딜러 없이 시작한 교대 기록은 a가 빠져서 온다
      history: (raw.history || []).map(h => Object.assign({ a: {} }, h)),
      notices: raw.notices || [],
      roster: rosterEntries(raw.roster),
      eoCall: Object.assign({}, base.eoCall, raw.eoCall),
      button: raw.button || null,
      past: raw.past || [],
      plans: planEntries(raw.plans),
    });
    s.dealers = s.dealers.map(({ dbId, ...d }) => Object.assign({ // dbId: 없앤 딜러 DB 연결 — 버린다
      totalRestMs: 0,
      hold: false,
      holdMs: 0,
      holdAt: null,
      totalHoldMs: 0,
      sessions: [{ in: d.checkInAt, out: d.checkOutAt }],
      earlyOut: false,
      eoAsk: null,
      eoStay: false,
      eoAt: null,
      planAt: null,    // 출근 예정 시각 (출근 전일 때만)
      task: null,      // 다른 업무 내용 (업무 중일 때만)
      totalDutyMs: 0,  // 다른 업무 한 시간
      inBase: null,    // 이번에 출근할 때의 누적 시간 {w, r, d} — '출근 시간 변경'으로 출근 전으로 되돌릴 때
      checkAt: null,   // 출근 체크한 시각 (출근 QR 또는 디렉터) — 예정 시각 전에 체크하면 예정 시각에 투입
      ciAt: null,      // 마지막으로 반영한 휴대폰 출근 체크의 서버 시각 (같은 체크를 두 번 반영하지 않게)
      leaveOnRest: false, // 퇴근 예약 — 쉬러 나오면(교대로 휴식이 되면) 퇴근
      turn: 0,         // 줄 순번 — 같은 교대에 앉은(쉬러 간) 사람끼리는 먼저 줄 선 사람이 먼저 (queueUp)
    }, d));
    const ip = s.clock.intervalPlan;
    if (ip && !(Number.isFinite(ip.at) && ip.at % GRID === 0 && ip.minutes >= 5 && ip.minutes <= 120)) s.clock.intervalPlan = null;
    if (s.clock.intervalPlan === undefined) s.clock.intervalPlan = null;
    s.tables = s.tables.map(t => {
      const x = Object.assign({ locked: false, use: true }, t); // 예전 테이블은 모두 사용 중
      if (x.sched && !(x.status === 'open' && x.sched && okN(x.sched.n) && SCHED_ACTS.includes(x.sched.act))) delete x.sched;
      return x;
    });
    if ((raw.settingsRev || 1) < 2) s.settings.maxWorkMinutes = 0; // 예전 기본값(80분)은 '제한 없음'으로
    s.settingsRev = SETTINGS_REV;
    return s;
  }

  // 교대 시각은 늘 5분 눈금에 맞춘다 — 표 머리가 항상 0분·5분으로 끝나게 (2026-10-11 사용자 요청).
  // 세계 어느 표준시도 UTC에서 15분 단위로 떨어지므로 epoch 기준으로 반올림해도 그 지역 시각의 분이 0·5로 끝난다.
  const GRID = 5 * MIN;
  const floorGrid = t => Math.floor(t / GRID) * GRID;
  // after를 주면 그 시각보다 반드시 뒤의 눈금으로 (교대가 과거로 잡히지 않게)
  function gridAt(t, after) {
    const g = Math.round(t / GRID) * GRID;
    if (after == null || g > after) return g;
    return floorGrid(after) + GRID;
  }

  // 최대 연속 근무 (없으면 Infinity)
  const maxWorkMs = s => (s.settings.maxWorkMinutes > 0 ? s.settings.maxWorkMinutes * MIN : Infinity);
  const hasWorkLimit = s => s.settings.maxWorkMinutes > 0;

  // ---------- 조회 ----------

  const byNo = (a, b) => a.no - b.no;
  const featureFirst = (a, b) => (b.feature - a.feature) || a.no - b.no;
  const toMin = ms => Math.round(ms / MIN); // 장부는 분 단위로 비교 (초 단위 차이는 무시)

  const dealerOf = (s, id) => s.dealers.find(d => d.id === id);
  const tableOf = (s, id) => s.tables.find(t => t.id === id);
  const activeTables = s => s.tables.filter(t => t.status === 'open').sort(byNo); // 열린 테이블 (대기 포함 — 화면용)
  // 딜러를 넣는 테이블: 열려 있고 '사용' 체크된 것. 대기 테이블은 공석 알림·교대·필요 인원에서 빠진다
  const usedTables = s => activeTables(s).filter(t => t.use !== false);
  const idleTables = s => activeTables(s).filter(t => t.use === false);
  const working = s => s.dealers.filter(d => d.status === 'working');
  const busy = d => d.status === 'working' || d.status === 'duty'; // 근무로 침 (테이블 또는 다른 업무)
  const present = d => busy(d) || d.status === 'break';            // 출근해 있음 (출근 예정·퇴근 제외)
  const onDuty = s => s.dealers.filter(present);
  const isFresh = d => d.totalWorkMs === 0 && !d.totalDutyMs; // 출근 후 아직 한 번도 안 앉음

  // 투입 보류 중(쉬는 중 + 보류) — 식사·다른 일을 하는 중이므로 '휴식'으로 치지 않는다
  const isHeld = d => d.status === 'break' && d.hold;

  // 이번 휴식 구간에서 실제로 쉰 시간 (보류였던 시간은 뺀다)
  function restedMs(d, now) {
    const held = (d.holdMs || 0) + (d.holdAt == null ? 0 : Math.max(0, now - d.holdAt));
    return Math.max(0, now - d.since - held);
  }

  // 일시정지 중에는 근무 시간이 멈춘 것으로 본다
  const clockNow = (s, now) => (s.clock.paused ? s.clock.pausedAt : now);

  function msToPush(s, now) {
    const c = s.clock;
    if (!c.running || c.nextPushAt == null) return null;
    return c.nextPushAt - clockNow(s, now);
  }

  // 휴식 없이 이어서 일한 시간 (지금 앉은 테이블·다른 업무 포함)
  function workedMs(s, d, now) {
    if (!busy(d)) return d.streakMs;
    return d.streakMs + Math.max(0, clockNow(s, now) - d.since);
  }

  // 지금 이 자리에 앉아 있은 시간. 자리를 옮기면 0부터 다시 센다.
  // 교대 순서('오래 앉은 사람부터')와 '방금 앉았으면 빼지 않는다' 판정은 이 값으로 한다 —
  // 연속 근무 누적(streakMs)을 쓰면, 새로 연 테이블에 방금 앉은 사람이 예전 근무까지 더해져
  // 제일 오래 일한 사람으로 보이고 12분 만에 다시 빠지는 일이 생긴다 (2026-10-11 제보)
  function seatedMs(s, d, now) {
    if (d.status !== 'working') return 0;
    return Math.max(0, clockNow(s, now) - d.since);
  }

  // 최소 휴식을 채웠거나, 애초에 아주 짧게만 일했으면 '쉰 딜러'
  function isRested(s, d, now) {
    if (d.status !== 'break') return false;
    return d.streakMs < s.settings.shortSeatMinutes * MIN || restedMs(d, now) >= s.settings.minRestMinutes * MIN;
  }

  // 지난 교대 때부터 계속 쉬고 있는 사람 — 이번에도 안 들어가면 연속 두 번 쉬게 된다
  function mustGoIn(s, d) {
    if (d.status !== 'break' || d.hold) return false;
    const last = s.history.length ? s.history[s.history.length - 1].at : null;
    return last != null && d.since <= last;
  }

  // 들어갈 순서: 첫 출근 → 지금 오래 쉰 사람 순 (보류였던 시간은 빼고)
  // 누적 장부로 줄 세우지 않는다 (사용자 요청): 하루치 휴식 시간을 맞추려 들면 늦게 온 사람이 계속 쉬게 된다
  // 같은 교대에 함께 쉬러 나와 쉰 시간이 똑같으면 먼저 줄 선 사람(turn이 작은 쪽)부터 — 나갈 순서와 짝을 이뤄
  // 딜러들이 한 줄로 돈다. 이게 없으면 동점이 늘 같은 쪽으로 풀려 같은 두 사람이 한 테이블에서만 주고받는다 (2026-10-24 제보)
  function inOrder(s, now) {
    return (a, b) => (isFresh(b) - isFresh(a)) || restedMs(b, now) - restedMs(a, now) || (a.turn || 0) - (b.turn || 0);
  }
  const breakPool = (s, now) => s.dealers.filter(d => d.status === 'break')
    .sort(now == null ? (a, b) => a.since - b.since : inOrder(s, now));

  // 한 딜러가 쉬지 않고 일할 수 있는 교대 횟수 k → 테이블 T개면 T + ceil(T/k) 명
  // 최대 근무가 정해져 있으면: 쉬지 않고 일할 수 있는 교대 횟수 k → 테이블 T개면 T + ceil(T/k) 명
  // 제한이 없으면: 테이블 수만큼만 있으면 된다 (남는 사람은 그만큼 교대가 돈다)
  function staffing(s) {
    const tables = usedTables(s).length;
    const limited = hasWorkLimit(s);
    const k = Math.max(1, Math.floor(s.settings.maxWorkMinutes / s.settings.pushMinutes));
    const duty = onDuty(s);
    const recommended = limited ? tables + Math.ceil(tables / k) : tables;
    return {
      tables,
      limited,
      active: duty.length,
      working: duty.filter(d => d.status === 'working').length,
      onBreak: duty.filter(d => d.status === 'break').length,
      onTask: duty.filter(d => d.status === 'duty').length,
      // 테이블에 넣을 수 있는 사람 (근무 + 휴식) — 다른 업무 중인 사람은 빼고 센다 (2026-10-24 검토)
      available: duty.filter(d => d.status !== 'duty').length,
      planned: s.dealers.filter(d => d.status === 'planned').length,
      recommended,
      diff: duty.filter(d => d.status !== 'duty').length - recommended,
      idle: idleTables(s).length,
    };
  }

  // 퇴근 희망자를 먼저 말한 순서대로 — 직접 표시한 것도 휴대폰 답도 같은 줄에 세운다.
  // 시각이 없는 예전 자료는 출근이 이른 사람부터 (적어도 순서가 흔들리지는 않게)
  const eoOrder = s => s.dealers.filter(d => present(d) && d.earlyOut)
    .sort((a, b) => (a.eoAt || a.checkInAt) - (b.eoAt || b.checkInAt) || a.checkInAt - b.checkInAt);

  // 지금 누가 어디 있는지: {딜러id: 테이블번호 | 0(휴식) | -2(다른 업무)} — 퇴근자·출근 전은 빠진다
  const DUTY = -2;
  function snapshot(s) {
    const a = {};
    for (const d of s.dealers) {
      if (d.status === 'working') a[d.id] = tableOf(s, d.tableId).no;
      else if (d.status === 'break') a[d.id] = 0;
      else if (d.status === 'duty') a[d.id] = DUTY;
    }
    return a;
  }

  // ---------- 내부 변경 헬퍼 (draft에만 사용) ----------

  const draft = s => JSON.parse(JSON.stringify(s));

  function addLog(s, now, type, msg) {
    s.log.unshift({ at: now, type, msg });
    if (s.log.length > 300) s.log.length = 300;
  }

  function record(s, now) {
    s.history.push({ at: now, a: snapshot(s) });
    if (s.history.length > 60) s.history.splice(0, s.history.length - 60);
  }

  // 줄 뒤에 선다 — 자리에 앉을 때와 쉬러 갈 때마다 새 순번 (교대에서는 나갈 순서·들어갈 순서대로 부른다)
  function queueUp(s, d) {
    s.turnSeq = (s.turnSeq || 0) + 1;
    d.turn = s.turnSeq;
  }

  function release(s, d, now) {
    const t = tableOf(s, d.tableId);
    queueUp(s, d);
    const worked = Math.max(0, clockNow(s, now) - d.since);
    d.streakMs += worked;
    d.totalWorkMs += worked;
    d.lastTableId = d.tableId;
    d.tableId = null;
    d.status = 'break';
    d.since = now;
    d.holdMs = 0;
    d.holdAt = d.hold ? now : null; // 보류인 채로 자리에서 빠지면 그 순간부터 보류 시간
    if (t && t.dealerId === d.id) t.dealerId = null;
  }

  // 보류를 끝낸다 — 보류였던 시간은 휴식이 아니므로 따로 모아 둔다
  function closeHold(d, now) {
    if (d.holdAt == null) return;
    const dt = Math.max(0, now - d.holdAt);
    d.holdMs = (d.holdMs || 0) + dt;
    d.totalHoldMs = (d.totalHoldMs || 0) + dt;
    d.holdAt = null;
  }

  function endBreak(s, d, now) {
    if (d.status !== 'break') return;
    closeHold(d, now);
    const rest = restedMs(d, now); // 보류였던 시간은 휴식으로 치지 않는다
    d.totalRestMs += rest;
    d.holdMs = 0;
    if (rest >= s.settings.minRestMinutes * MIN) d.streakMs = 0;
  }

  // 다른 업무 끝 → 휴식. 업무 시간은 연속 근무로 이어서 센다 (테이블에서 일한 것과 같게)
  function finishDuty(s, d, now) {
    if (d.status !== 'duty') return;
    const worked = Math.max(0, clockNow(s, now) - d.since);
    d.streakMs += worked;
    d.totalDutyMs = (d.totalDutyMs || 0) + worked;
    d.status = 'break';
    d.since = now;
    d.holdMs = 0;
    d.holdAt = null;
    d.task = null;
    queueUp(s, d);
  }

  // 이번에 출근할 때의 누적 시간 — '출근 시간 변경'으로 출근 전으로 되돌릴 때 이 값으로 돌린다
  const baseOf = d => ({ w: d.totalWorkMs, r: d.totalRestMs, d: d.totalDutyMs || 0, h: d.totalHoldMs || 0 });

  // '미투입' 되돌리기에 필요한 딜러 상태
  const UNDO_FIELDS = ['status', 'since', 'tableId', 'lastTableId', 'streakMs', 'totalWorkMs', 'totalRestMs', 'turn',
    'holdMs', 'holdAt', 'totalHoldMs'];
  function keep(d) {
    const o = {};
    UNDO_FIELDS.forEach(k => { o[k] = d[k]; });
    return o;
  }

  // 앉힐 때마다 테이블에 되돌리기 기록을 남긴다. out = 이 자리에서 방금 빠진 딜러 {id, before}
  function seat(s, d, t, now, out) {
    const inBefore = keep(d);
    endBreak(s, d, now);
    d.status = 'working';
    d.hold = false;   // 앉으면 보류는 풀린다 (근무 중인 사람은 '보류'일 수 없다)
    d.holdAt = null;
    d.tableId = t.id;
    d.since = clockNow(s, now);
    queueUp(s, d);
    t.dealerId = d.id;
    t.undo = {
      at: now,
      seatAt: d.since,
      inId: d.id,
      inBefore,
      outId: out ? out.id : null,
      outBefore: out ? out.before : null,
    };
  }

  // 자리에서 빼면서 되돌리기용 상태도 같이 돌려준다
  function releaseKeep(s, d, now) {
    const before = keep(d);
    release(s, d, now);
    return { id: d.id, before };
  }

  function pickFromPool(s, now, wantA) {
    const pool = breakPool(s, now).filter(d => !d.hold);
    const rested = pool.filter(d => isRested(s, d, now));
    const pick = list => (wantA && list.find(d => d.grade === 'A')) || list[0];
    if (rested.length) return { dealer: pick(rested), short: false };
    return pool.length ? { dealer: pick(pool), short: true } : null;
  }

  function seatMidInterval(s, d, t, now, short, out) {
    seat(s, d, t, now, out);
    addLog(s, now, short ? 'warn' : 'info', `${d.name} → ${t.no}번 투입${short ? ' (휴식 부족)' : ''}`);
  }

  function fillVacancies(s, now) {
    for (const t of usedTables(s).filter(t => !t.dealerId).sort(featureFirst)) {
      const pick = pickFromPool(s, now, t.feature);
      if (!pick) return;
      seatMidInterval(s, pick.dealer, t, now, pick.short);
    }
  }

  // ---------- 교대 계획 ----------

  // 낮을수록 좋은 배치
  function fitScore(t, d) {
    let sc = 0;
    if (t.feature && d.grade !== 'A') sc += 100; // 피처 테이블은 A등급
    if (d.lastTableId === t.id) sc += 10;        // 방금 나온 테이블로 바로 돌아가지 않게
    return sc;
  }

  // list는 들어갈 우선순위 순 → 점수가 같으면 앞사람
  function takeBest(t, list) {
    let bi = -1;
    let best = Infinity;
    list.forEach((d, i) => {
      const sc = fitScore(t, d);
      if (sc < best) { best = sc; bi = i; }
    });
    return bi >= 0 ? list.splice(bi, 1)[0] : null;
  }

  function move(t, from, to, kind) {
    return {
      tableId: t.id,
      tableNo: t.no,
      feature: !!t.feature,
      fromDealerId: from ? from.id : null,
      toDealerId: to ? to.id : null,
      kind: to ? kind : 'vacant',
    };
  }

  // ---------- 표에서 끌어다 놓은 교대 예약 ----------

  // 저장된 예약은 믿지 않고 모양을 맞춘다 (파이어베이스가 0·빈 값을 지우므로)
  function planEntries(raw) {
    if (!Array.isArray(raw)) return [];
    const pair = p => p.type === 'swap' || p.type === 'trade';
    return raw.filter(p => p && Number.isFinite(p.n) && p.n >= 1 && p.n <= PLAN_MAX && typeof p.a === 'string'
      && (pair(p) ? typeof p.b === 'string' && p.b !== p.a : p.type === 'rest' || p.type === 'keep'))
      .map(p => (pair(p) ? { n: p.n, type: p.type, a: p.a, b: p.b } : { n: p.n, type: p.type, a: p.a }))
      .slice(-PLAN_MAX);
  }

  // 이번 교대(n === 1)에 적용할 예약. 퇴근한 딜러가 낀 것은 버린다
  function pushPlan(s) {
    const live = id => { const d = dealerOf(s, id); return !!d && d.status !== 'off'; };
    const fix = { rest: new Set(), keep: new Set(), swap: [], trade: [] };
    for (const p of s.plans || []) {
      if (p.n !== 1) continue;
      if (p.type === 'swap') { if (live(p.a) && live(p.b)) fix.swap.push([p.a, p.b]); continue; }
      if (p.type === 'trade') { if (live(p.a) && live(p.b)) fix.trade.push([p.a, p.b]); continue; }
      if (!live(p.a)) continue;
      if (p.type === 'rest') fix.rest.add(p.a);
      else if (p.type === 'keep') fix.keep.add(p.a);
    }
    return fix;
  }

  /*
   * '맞바꿈' 예약 — 표에서 a의 휴식 칸을 b의 칸으로 끌어다 놓은 것.
   * 뜻은 "이 교대의 휴식을 a 대신 b가 가져간다"이다. 계획을 다시 짜지 않고 교대 뒤의 자리만 손본다.
   *
   * ※ 절대 규칙: 앉아 있던 딜러는 그 자리를 지키거나 휴식으로 나갈 뿐, 다른 테이블로 옮기지 않는다.
   *   (2026-10-11 제보 — 표에 8→15, 13→9, 7→12, 8→11이 떴다)
   *   그래서 a의 지금 상태에 따라 두 갈래로 나뉜다:
   *     · a가 지금 쉬는 중  → a가 b의 자리로 들어가고 b가 쉰다 (끌어다 놓은 그대로)
   *     · a가 지금 앉아 있다 (이번에 나갈 예정) → a는 자기 자리를 지키고 b가 대신 쉰다.
   *       a 자리에 들어오기로 했던 사람을 b가 비운 자리로 돌린다 → 아무도 테이블을 옮기지 않는다.
   *   b가 교대 뒤 앉아 있지 않거나(넘겨줄 자리가 없음), a가 이미 들어가기로 되어 있으면(바라던 대로 됨)
   *   건너뛰고 경고만 남긴다. 한 사람은 한 교대에 한 번만 손댄다.
   */
  function applySwaps(s, moves, swaps) {
    const cur = snapshot(s);
    for (const id in cur) if (cur[id] < 0) delete cur[id]; // 다른 업무 중인 딜러는 맞바꿈에 끼지 않는다
    const end = Object.assign({}, cur);
    for (const m of moves) if (m.fromDealerId) end[m.fromDealerId] = 0;
    for (const m of moves) if (m.toDealerId) end[m.toDealerId] = m.tableNo;
    const base = Object.assign({}, end); // 판정은 손대기 전 계획으로만 한다
    const used = new Set();
    const skipped = [];
    let swapped = false;
    const give = (a, b) => {
      if (!(a in base) || !(b in base) || used.has(a) || used.has(b)) return false;
      if (base[a] !== 0 || base[b] === 0) return false;
      if (cur[a] === 0) {            // a는 쉬는 중 → b의 자리로 들어간다
        end[a] = base[b];
      } else {                       // a는 앉아 있다 → 자리를 지키고, a 자리에 올 사람을 b 자리로 돌린다
        if (base[b] !== cur[a]) {
          const filler = Object.keys(base).find(id => id !== a && base[id] === cur[a]);
          if (!filler) return false; // 돌릴 사람이 없으면 b 자리가 공석이 되므로 손대지 않는다
          end[filler] = base[b];
          used.add(filler);
        }
        end[a] = cur[a];
      }
      end[b] = 0;
      used.add(a);
      used.add(b);
      return true;
    };
    for (const [a, b] of swaps) {
      if (give(a, b)) swapped = true;
      else skipped.push(`${nameOfId(s, a)} ↔ ${nameOfId(s, b)}`);
    }
    if (!swapped) return { moves: null, toBreak: null, skipped }; // 바뀐 게 없으면 원래 계획 그대로
    const kindOf = new Map(moves.filter(m => m.toDealerId).map(m => [m.toDealerId, m.kind]));
    const seatOf = {}; // 테이블 번호 → 교대 뒤 딜러
    for (const id in end) if (end[id]) seatOf[end[id]] = id;
    const out = [];
    for (const t of usedTables(s)) {
      const from = t.dealerId || null;
      const to = seatOf[t.no] || null;
      if (from === to && from !== null) continue; // 그대로 앉아 있는 테이블은 교대가 아니다
      out.push(move(t, from ? dealerOf(s, from) : null, to ? dealerOf(s, to) : null,
        to ? (kindOf.get(to) || 'in') : 'vacant')); // 아무도 못 앉으면 공석 (경고용으로 남긴다)
    }
    return { moves: out, toBreak: Object.keys(end).filter(id => cur[id] && !end[id]), skipped };
  }

  const nameOfId = (s, id) => (dealerOf(s, id) || {}).name || '?';

  /*
   * '테이블 맞바꿈' 예약 — 표의 예정 칸에서 테이블 칸을 같은 시각 다른 딜러의 테이블 칸에 끌어다 놓은 것 (2026-10-24 사용자 요청).
   * 그 교대 뒤 두 사람이 앉을 테이블을 서로 바꾼다. 둘 다 그 교대 뒤 앉아 있어야 한다 (한쪽이 쉬면 '맞바꿈'(휴식 넘기기)의 일).
   * ※ 자동 교대는 앉은 딜러를 다른 테이블로 옮기지 않는다 — 옮겨지는 건 디렉터가 이렇게 직접 정한 경우뿐이다
   *   (지정·바로잡기와 같은 '디렉터가 직접 한 이동'). 그 사이 상황이 달라져 한쪽이 앉지 않게 되면 건너뛰고 경고만 남긴다.
   */
  function applyTrades(s, moves, trades) {
    const cur = snapshot(s);
    for (const id in cur) if (cur[id] < 0) delete cur[id]; // 다른 업무 중인 딜러는 끼지 않는다
    const end = Object.assign({}, cur);
    for (const m of moves) if (m.fromDealerId) end[m.fromDealerId] = 0;
    for (const m of moves) if (m.toDealerId) end[m.toDealerId] = m.tableNo;
    const used = new Set();
    const traded = new Set();
    const skipped = [];
    for (const [a, b] of trades) {
      if (used.has(a) || used.has(b) || !(end[a] > 0) || !(end[b] > 0) || end[a] === end[b]) {
        skipped.push(`${nameOfId(s, a)} ↔ ${nameOfId(s, b)}`);
        continue;
      }
      [end[a], end[b]] = [end[b], end[a]];
      [a, b].forEach(id => { used.add(id); traded.add(id); });
    }
    if (!traded.size) return { moves: null, toBreak: null, skipped };
    const kindOf = new Map(moves.filter(m => m.toDealerId).map(m => [m.toDealerId, m.kind]));
    const seatOf = {}; // 테이블 번호 → 교대 뒤 딜러
    for (const id in end) if (end[id] > 0) seatOf[end[id]] = id;
    const out = [];
    for (const t of usedTables(s)) {
      const from = t.dealerId || null;
      const to = seatOf[t.no] || null;
      if (from === to && from !== null) continue;
      out.push(move(t, from ? dealerOf(s, from) : null, to ? dealerOf(s, to) : null,
        !to ? 'vacant' : traded.has(to) && cur[to] > 0 ? 'trade' : (kindOf.get(to) || 'in')));
    }
    return { moves: out, toBreak: Object.keys(end).filter(id => cur[id] > 0 && !(end[id] > 0)), skipped };
  }

  /*
   * 교대 규칙
   *  1. 공석 테이블부터 채운다 (쉰 딜러 → 없으면 덜 쉰 딜러, 경고)
   *  2. 나갈 후보: 지금 자리에 짧은 근무 기준 이상 앉아 있는 딜러를
   *       최대 연속 근무 초과 → 지금 자리에 오래 앉은 순 → 테이블 번호 순으로 줄 세움
   *     들어갈 후보: 쉰 딜러를 첫 출근 → 오래 쉰 순으로 줄 세움
   *  3. 앞에서부터 짝을 지어 쉬는 사람이 없어질 때까지 바꾼다 (장부 비교로 멈추지 않는다)
   *     → 한 번 쉰 사람은 다음 교대에 반드시 들어간다
   *  4. 피처 테이블의 A등급 딜러는 대신할 A등급이 있을 때만 교대 (최대 근무 초과면 예외)
   *  5. 디렉터가 고정한 테이블과 투입 보류한 딜러는 자동 교대에서 뺀다
   *  6. 나머지는 그대로. 최대 근무를 넘겼는데 못 바꾸면 연장 경고
   */
  // freed: 이번 교대의 테이블 예약(대기로·깨기)으로 방금 자리에서 나온 딜러 — 이번 교대에는 쉰다
  //  (다른 빈 테이블로 바로 채우면 자동 교대로 테이블을 옮기는 꼴이 된다)
  function planPush(s, now, freed) {
    const set = s.settings;
    const maxMs = maxWorkMs(s);
    const shortMs = set.shortSeatMinutes * MIN;
    const tables = usedTables(s);
    const fix = pushPlan(s); // 표에서 끌어다 놓은 예약 (이번 교대 몫)
    // 테이블 예약으로 방금 나온 딜러가 낀 맞바꿈은 건너뛴다 — 그 딜러는 이번 교대에 쉰다 (안 그러면 다른 테이블로 옮겨 앉는다)
    const freedSkip = [];
    if (freed && freed.size) {
      const keepPair = ([a, b]) => {
        if (!freed.has(a) && !freed.has(b)) return true;
        freedSkip.push(`${nameOfId(s, a)} ↔ ${nameOfId(s, b)}`);
        return false;
      };
      fix.swap = fix.swap.filter(keepPair);
      fix.trade = fix.trade.filter(keepPair);
    }
    const pool = breakPool(s, now).filter(d => !d.hold && !fix.rest.has(d.id) && !(freed && freed.has(d.id)));
    // 지난 교대부터 쉬고 있으면 최소 휴식을 덜 채웠어도 넣는다 ('연속 두 번 휴식 금지'가 우선, 대신 경고)
    const ready = d => isRested(s, d, now) || mustGoIn(s, d);
    const avail = pool.filter(ready);
    const tired = pool.filter(d => !ready(d));
    const moves = [];
    const shortRest = [];

    for (const t of tables.filter(t => !t.dealerId).sort(featureFirst)) {
      let d = takeBest(t, avail);
      let kind = 'in';
      if (!d) {
        d = takeBest(t, tired);
        kind = 'short-rest';
        if (d) shortRest.push(d);
      }
      moves.push(move(t, null, d, kind));
    }

    const occupied = tables.filter(t => t.dealerId).map(t => {
      const d = dealerOf(s, t.dealerId);
      const worked = workedMs(s, d, now);   // 연속 근무(최대 근무 판정용)
      const seated = seatedMs(s, d, now);   // 지금 이 자리에 앉아 있은 시간
      return { t, d, worked, seated, over: worked >= maxMs };
    });
    // 지금 자리에 오래 앉아 있는 사람부터 나간다 (방금 앉은 사람은 빼지 않는다).
    // 같은 교대에 앉아 앉은 시간이 똑같으면 먼저 줄 서서 앉은 사람(turn이 작은 쪽)부터 — 테이블 번호로만 풀면
    // 늘 번호가 작은 테이블만 바뀌어 같은 두 사람이 그 테이블에서만 주고받는다 (2026-10-24 제보)
    // 예약으로 '쉬게' 한 사람은 맨 앞에(짧게 앉았어도), '그대로'인 사람은 아예 빼지 않는다.
    // 들어올 사람이 없으면 짝이 안 지어져 그냥 일하게 되므로, 예약 때문에 공석이 생기지는 않는다
    const outQueue = occupied.filter(x => !x.t.locked && !fix.keep.has(x.d.id)
      && (fix.rest.has(x.d.id) || x.seated >= shortMs))
      .sort((a, b) => (fix.rest.has(b.d.id) - fix.rest.has(a.d.id))
        || (b.over - a.over) || b.seated - a.seated || (a.d.turn || 0) - (b.d.turn || 0) || a.t.no - b.t.no);

    const isA = d => d.grade === 'A';
    const left = avail.slice();
    const pairs = [];
    for (let i = 0; i < outQueue.length && left.length; i++) {
      const x = outQueue[i];
      let n;
      if (x.t.feature) {
        n = left.find(isA);
        if (!n) {
          if (isA(x.d) && !x.over) continue; // A등급 대신할 사람이 없으면 그대로
          n = left[0];
        }
      } else {
        // 뒤에 피처 테이블 교대가 남아 있으면 A등급은 그쪽 몫으로 아껴 둔다
        const featureLeft = outQueue.slice(i + 1).filter(y => y.t.feature).length;
        const reserveA = featureLeft > 0 && left.filter(isA).length <= featureLeft;
        n = (reserveA && left.find(d => !isA(d))) || left[0];
      }
      // 장부 비교로 멈추지 않는다 — 쉬는 사람이 남아 있으면 끝까지 바꾼다 (연속 두 번 휴식 금지)
      if (!isRested(s, n, now)) shortRest.push(n); // 최소 휴식을 덜 채우고 들어가는 경우는 알려 준다
      left.splice(left.indexOf(n), 1);
      pairs.push({ x, n });
    }
    // 피처 테이블은 짝지은 그대로, 나머지는 방금 나온 테이블을 피해서 배치.
    // 앞에서부터 고르면 뒤 테이블에 '방금 나온 사람'만 남을 수 있다 → 둘씩 자리를 바꿔 나아지면 바꾼다
    const incoming = pairs.filter(p => !p.x.t.feature).map(p => p.n);
    const placed = pairs.filter(p => !p.x.t.feature).map(p => ({ t: p.x.t, d: takeBest(p.x.t, incoming) }));
    for (let better = true; better;) {
      better = false;
      for (let i = 0; i < placed.length; i++) {
        for (let j = i + 1; j < placed.length; j++) {
          const a = placed[i];
          const b = placed[j];
          if (fitScore(a.t, b.d) + fitScore(b.t, a.d) < fitScore(a.t, a.d) + fitScore(b.t, b.d)) {
            [a.d, b.d] = [b.d, a.d];
            better = true;
          }
        }
      }
    }
    const seatFor = new Map(placed.map(x => [x.t.id, x.d]));
    for (const p of pairs) {
      moves.push(move(p.x.t, p.x.d, p.x.t.feature ? p.n : seatFor.get(p.x.t.id), 'in'));
    }
    const chosen = pairs.map(p => p.x);
    let out = moves;
    let toBreak = chosen.map(x => x.d.id);
    let skippedSwaps = [];
    if (fix.swap.length) {
      const sw = applySwaps(s, out, fix.swap);
      skippedSwaps = sw.skipped;
      if (sw.moves) { out = sw.moves; toBreak = sw.toBreak; }
    }
    let skippedTrades = [];
    if (fix.trade.length) { // 휴식 넘기기까지 정해진 뒤의 자리에서 테이블만 맞바꾼다
      const tr = applyTrades(s, out, fix.trade);
      skippedTrades = tr.skipped;
      if (tr.moves) { out = tr.moves; toBreak = tr.toBreak; }
    }

    const outOrder = new Map(chosen.map((x, i) => [x.d.id, i]));
    const ord = id => (outOrder.has(id) ? outOrder.get(id) : Infinity);
    toBreak = toBreak.slice().sort((a, b) => ord(a) - ord(b));
    const relieved = new Set(toBreak);
    const over = occupied.filter(x => !relieved.has(x.d.id) && x.over);
    const vacant = out.filter(m => !m.toDealerId);
    const warnings = [];
    if (shortRest.length) warnings.push(`휴식 부족 상태로 투입: ${shortRest.map(d => d.name).join(', ')}`);
    if (over.length) {
      warnings.push(`연장 근무: ${over.map(x => `${x.d.name}(${x.t.no}번 ${Math.floor(x.worked / MIN)}분)`).join(', ')}`);
    }
    if (vacant.length) warnings.push(`딜러 부족 — ${vacant.map(m => m.tableNo + '번').join(', ')} 공석`);
    if (skippedSwaps.length) warnings.push(`직접 정한 자리 맞바꿈 건너뜀 (그 사이 상황이 달라짐): ${skippedSwaps.join(', ')}`);
    if (skippedTrades.length) warnings.push(`직접 정한 테이블 맞바꿈 건너뜀 (그 교대에 한쪽이 앉지 않음): ${skippedTrades.join(', ')}`);
    if (freedSkip.length) warnings.push(`직접 정한 교대 건너뜀 (테이블 예약으로 그 교대에 쉬는 딜러): ${freedSkip.join(', ')}`);

    out.sort((a, b) => a.tableNo - b.tableNo);
    return {
      at: now,
      moves: out,
      toBreak,
      kept: occupied.length - out.filter(m => m.fromDealerId).length,
      warnings,
    };
  }

  // 지금 상태 그대로 간다고 가정하고 앞으로 count번의 교대를 미리 돌려본다.
  // 출근 예정 딜러는 (now 뒤 예정이면) 제시간에 출근 체크한다고 보고 예정 시각 뒤 가장 가까운 교대에 넣는다.
  // 예정 시각이 지났는데 체크 안 한 딜러는 언제 올지 모르므로 빼고 (now를 안 주면 모두 제시간으로)
  function project(s, count, now) {
    if (!s.clock.running) return [];
    let cur = s;
    if (s.clock.paused) {
      // 재개 시점을 지금으로 보고 계산 (일시정지 중엔 근무·장부 시간이 멈춰 있으므로)
      cur = Object.assign({}, s, {
        clock: Object.assign({}, s.clock, { paused: false, pausedAt: null }),
      });
    }
    // 교대 기록을 통째로 비우면 안 된다 — mustGoIn(지난 교대부터 계속 쉰 사람)이 거짓이 되어
    // 예정 표가 실제 교대와 어긋난다. 마지막 한 줄만 남겨 둔다 (2026-10-11)
    cur = Object.assign({}, cur, { log: [], history: cur.history.slice(-1), past: [] });
    const out = [];
    const assume = now == null ? -Infinity : now;
    for (let i = 0; i < count; i++) {
      // 첫 칸: 교대 시각이 이미 지났으면(자동 교대를 껐거나 늦게 누름) 지금 누르면 기록될 시각으로 — executePush와 같게.
      // 안 그러면 휴식·앉은 시간을 실제와 다른 시각으로 재서 예정 표가 실제와 어긋난다 (2026-10-24 검토)
      const late = i === 0 && now != null && !s.clock.paused && now > cur.clock.nextPushAt;
      const at = late ? pushTime(cur, now) : cur.clock.nextPushAt;
      // 출근 예정 딜러는 디렉터 PC의 1초 박자(arriveDue)처럼 각자 예정 시각에 출근시킨다 — 교대 사이에 와서
      // 빈 테이블에 바로 앉을 수 있으므로, 교대 시각에 한꺼번에 넣으면 앉은 시간이 달라져 실제 교대와 어긋난다 (2026-10-24 검토)
      const from = i === 0 ? assume : out[i - 1].at;
      const cutoff = late ? now : at;
      // 같은 순간에 오는 사람은 한꺼번에 (1초 박자도 한 번에 출근시키고 빈자리를 채운다)
      const due = cur.dealers.filter(d => isDue(cur, d, cutoff, assume));
      const times = [...new Set(due.map(d => Math.max(d.planAt, from)))].sort((a, b) => a - b);
      for (const t of times) cur = arrive(cur, due.filter(d => Math.max(d.planAt, from) === t).map(d => d.id), t, true);
      const res = executePush(cur, at);
      cur = res.state;
      out.push({ at, a: snapshot(cur), plan: res.plan });
      cur.log = [];
      cur.history = cur.history.slice(-1);
    }
    return out;
  }

  // ---------- 공개 동작 ----------

  // entries: 이름 문자열 또는 {name, grade, at}
  //  at이 지금보다 뒤면 '출근 예정'으로 (그 시각이 되면 자동 출근), 앞이면 그 시각에 출근한 것으로 기록
  function addDealers(s, entries, now, grade) {
    const n = draft(s);
    for (const raw of entries) {
      const e = typeof raw === 'object' && raw ? raw : { name: raw };
      const name = String(e.name || '').trim();
      if (!name) continue;
      const at = Number.isFinite(e.at) ? e.at : null;
      const planned = at != null && at > now;
      const inAt = at != null && !planned ? at : now;
      n.dealers.push({
        id: `d${++n.seq}`,
        name,
        grade: e.grade || grade || 'B',
        status: planned ? 'planned' : 'break',
        hold: false,
        holdMs: 0,       // 이번 휴식 구간에서 보류였던 시간
        holdAt: null,    // 보류 시작 시각 (보류 중이 아니면 null)
        sessions: planned ? [] : [{ in: inAt, out: null }],
        since: now,
        tableId: null,
        lastTableId: null,
        streakMs: 0,
        totalWorkMs: 0,
        totalRestMs: 0,
        totalHoldMs: 0,  // 오늘 보류였던 시간 (휴식 시간에 넣지 않는다)
        totalDutyMs: 0,
        checkInAt: planned ? null : inAt,
        checkOutAt: null,
        earlyOut: false, // 퇴근 희망
        eoAsk: null,     // 디렉터가 휴대폰으로 물어본 질문 id (답 오기 전까지)
        eoStay: false,   // 물어봤더니 '계속 일할게요'
        eoAt: null,      // 마지막으로 반영한 휴대폰 답의 서버 시각
        planAt: planned ? at : null,
        task: null,
        inBase: planned ? null : { w: 0, r: 0, d: 0 },
        checkAt: null,
        ciAt: null,
      });
      queueUp(n, n.dealers[n.dealers.length - 1]); // 같이 적은 사람끼리는 적은 순서대로 줄을 선다
      addLog(n, now, 'dealer', planned ? `${name} 출근 예정 ${clock(at)}` : `${name} 출근${at != null ? ` (${clock(at)})` : ''}`);
      // 직접 적어 출근시킨 사람도 명단에 올려 둔다 (명단 화면과 같은 목록을 보게)
      if (!n.roster.some(r => r.name === name)) n.roster.push({ name, grade: e.grade || grade || 'B' });
    }
    fillVacancies(n, now);
    return n;
  }

  // '1-10, 15' → [1..10, 15]. 띄어쓰기·물결(~)도 된다. 한 구간은 200개까지
  function parseNos(text) {
    const out = new Set();
    for (const part of String(text || '').replace(/\s*[-~]\s*/g, '-').split(/[,\s]+/)) {
      const m = part.match(/^(\d+)(?:-(\d+))?$/);
      if (!m) continue;
      const a = Math.min(+m[1], +(m[2] || m[1]));
      const b = Math.max(+m[1], +(m[2] || m[1]));
      for (let i = a; i <= b && i - a < 200; i++) if (i > 0) out.add(i);
    }
    return [...out].sort((x, y) => x - y);
  }

  // [1, 2, 3, 5, 7, 8] → '1-3, 5, 7-8' (기록·안내에 짧게)
  function rangeText(nos) {
    const xs = [...new Set(nos)].sort((x, y) => x - y);
    const out = [];
    for (let i = 0; i < xs.length; i++) {
      let j = i;
      while (j + 1 < xs.length && xs[j + 1] === xs[j] + 1) j++;
      out.push(j > i ? `${xs[i]}-${xs[j]}` : String(xs[i]));
      i = j;
    }
    return out.join(', ');
  }

  // opts.use === false면 '대기'로 연다 (테이블은 열려 있고 딜러는 안 넣음 — 칸에서 [사용]을 체크하면 투입).
  // 바로 사용으로 열 때 이미 대기로 열려 있던 번호는 사용으로 바꾼다 (구간으로 한꺼번에 사용)
  function openTable(s, nos, now, opts) {
    const feature = !!(opts && opts.feature);
    const use = !(opts && opts.use === false);
    const n = draft(s);
    const opened = [];
    const started = [];
    for (const no of nos) {
      let t = n.tables.find(x => x.no === no);
      if (t && t.status === 'open') {
        if (use && t.use === false) {
          t.use = true;
          started.push(t);
        }
        continue;
      }
      if (!t) {
        t = { id: `t${no}`, no, status: 'open', feature, use, dealerId: null, openedAt: now };
        n.tables.push(t);
      } else {
        Object.assign(t, { status: 'open', feature, use, dealerId: null, openedAt: now });
      }
      opened.push(t);
    }
    if (opened.length) addLog(n, now, 'table', `${rangeText(opened.map(t => t.no))}번 테이블 오픈${feature ? ' (피처)' : ''}${use ? '' : ' — 대기 (사용을 체크하면 딜러 투입)'}`);
    if (started.length) addLog(n, now, 'table', `${rangeText(started.map(t => t.no))}번 테이블 사용 — 딜러 투입`);
    n.tables.sort(byNo);
    fillVacancies(n, now);
    const empty = opened.concat(started).filter(t => t.use && !t.dealerId);
    if (empty.length) addLog(n, now, 'warn', `대기 딜러 없음 — ${empty.map(t => t.no + '번').join(', ')} 공석`);
    return n;
  }

  // 열린 테이블의 '사용' 체크. 켜면 다음 순서 딜러를 바로 넣고, 끄면 앉아 있던 딜러는 휴식 (테이블은 열린 채 대기)
  function setTableUse(s, tableIds, use, now) {
    const want = s.tables.filter(t => tableIds.includes(t.id) && t.status === 'open' && (t.use !== false) !== use);
    if (!want.length) return s;
    const n = draft(s);
    const nos = [];
    const rested = [];
    for (const t0 of want) {
      const t = tableOf(n, t0.id);
      if (!use && t.dealerId) {
        const d = dealerOf(n, t.dealerId);
        release(n, d, now);
        rested.push(d.name);
      }
      t.use = use;
      if (!use) t.dealerId = null;
      delete t.undo;
      delete t.sched; // 직접 바꿨으면 예약은 버린다
      nos.push(t.no);
    }
    const what = rangeText(nos);
    addLog(n, now, 'table', use
      ? `${what}번 테이블 사용 — 딜러 투입`
      : `${what}번 테이블 사용 안 함 (대기)${rested.length ? ` — ${rested.join(', ')} 휴식` : ''}`);
    fillVacancies(n, now);
    if (use) {
      const empty = want.map(t => tableOf(n, t.id)).filter(t => !t.dealerId);
      if (empty.length) addLog(n, now, 'warn', `대기 딜러 없음 — ${empty.map(t => t.no + '번').join(', ')} 공석`);
    }
    return n;
  }

  function closeTable(s, tableId, now) {
    const n = draft(s);
    const t = tableOf(n, tableId);
    if (!t || t.status !== 'open') return s;
    const d = t.dealerId ? dealerOf(n, t.dealerId) : null;
    if (d) release(n, d, now);
    Object.assign(t, { status: 'closed', dealerId: null });
    delete t.undo;
    delete t.sched;
    addLog(n, now, 'table', `${t.no}번 테이블 깨짐${d ? ` — ${d.name} 휴식` : ''}`);
    fillVacancies(n, now); // 공석 테이블이 있으면 바로 메움
    return n;
  }

  // ---------- 테이블 예약 (스케줄표에서 그 교대에) ----------
  // t.sched = {n, act} — 앞으로 n번째 교대에 act 를 한다 (n은 plans와 같이 '몇 번째 교대' — 일시정지로 시각이 밀려도 따라간다)
  //   'use'   대기 → 사용 시작: 그 교대의 계획 안에서 오래 쉰 딜러가 들어간다
  //   'idle'  사용 → 대기: 앉아 있던 딜러는 그 교대에 쉬러 간다 (테이블은 열린 채)
  //   'close' 깨기: 그 교대에 테이블을 깬다
  // 지금 바로 [사용]을 켜면 그 순간 쉬던 딜러가 들어가 로테가 꼬인다 — 1시에 열 테이블은 1시 교대에 같이 바꾼다 (2026-10-24 사용자 요청)
  const SCHED_ACTS = ['use', 'idle', 'close'];
  const SCHED_TEXT = { use: '사용 시작', idle: '대기로', close: '깨기' };

  function scheduleTable(s, tableId, n, act, now) {
    const t0 = tableOf(s, tableId);
    if (!s.clock.running || !okN(n) || !SCHED_ACTS.includes(act) || !t0 || t0.status !== 'open') return s;
    if (act === 'use' && t0.use !== false) return s;   // 이미 사용 중
    if (act === 'idle' && t0.use === false) return s;  // 이미 대기
    if (t0.sched && t0.sched.n === n && t0.sched.act === act) return s;
    const d = draft(s);
    const t = tableOf(d, tableId);
    t.sched = { n, act };
    addLog(d, now, 'table', `[예약] ${t.no}번 테이블 — ${n}번째 교대에 ${SCHED_TEXT[act]}`);
    return d;
  }

  function unscheduleTable(s, tableId, now) {
    const t0 = tableOf(s, tableId);
    if (!t0 || !t0.sched) return s;
    const d = draft(s);
    const t = tableOf(d, tableId);
    addLog(d, now, 'table', `[예약] ${t.no}번 테이블 ${SCHED_TEXT[t.sched.act]} 예약 취소`);
    delete t.sched;
    return d;
  }

  // 앞으로 n번째 교대 뒤 그 테이블이 쓰이는지 (0 = 지금). 표·메뉴용
  function tableUsedAt(t, n) {
    if (!t || t.status !== 'open') return false;
    if (t.sched && n >= t.sched.n) return t.sched.act === 'use';
    return t.use !== false;
  }
  const tableClosedAt = (t, n) => !t || t.status !== 'open' || !!(t.sched && t.sched.act === 'close' && n >= t.sched.n);

  // 이번 교대(n === 1) 몫 테이블 예약을 교대 계획 직전에 적용한다 (executePush — 미리보기도 같은 길)
  function applyTableSched(s, at, freed) {
    const due = s.tables.filter(t => t.status === 'open' && t.sched && t.sched.n === 1);
    if (!due.length) return s;
    const n = draft(s);
    for (const t0 of due) {
      const t = tableOf(n, t0.id);
      const act = t.sched.act;
      delete t.sched;
      if (act === 'use') {
        t.use = true;
        addLog(n, at, 'table', `${t.no}번 테이블 사용 시작 (예약) — 이번 교대에 딜러 투입`);
        continue;
      }
      const d = t.dealerId ? dealerOf(n, t.dealerId) : null;
      if (d) {
        release(n, d, at);
        freed.add(d.id);
      }
      t.dealerId = null;
      delete t.undo;
      if (act === 'idle') t.use = false;
      else t.status = 'closed';
      addLog(n, at, 'table', `${t.no}번 테이블 ${act === 'idle' ? '대기로' : '깨짐'} (예약)${d ? ` — ${d.name} 휴식` : ''}`);
    }
    return n;
  }

  // 교대 시간을 기다리지 않고 해당 테이블 딜러만 즉시 교체
  function relieveTable(s, tableId, now) {
    const n = draft(s);
    const t = tableOf(n, tableId);
    if (!t || t.status !== 'open' || t.use === false) return s;
    const pick = pickFromPool(n, now, t.feature);
    if (!pick) {
      addLog(n, now, 'warn', `${t.no}번 교체 불가 — 대기 딜러 없음`);
      return n;
    }
    const out = t.dealerId ? releaseKeep(n, dealerOf(n, t.dealerId), now) : null;
    seatMidInterval(n, pick.dealer, t, now, pick.short, out);
    return n;
  }

  // 퇴근 처리 (draft 안에서) — sendHome과 '쉬러 나오면 퇴근' 예약이 같이 쓴다
  function goHome(n, d, now, why) {
    if (d.status === 'working') release(n, d, now);
    finishDuty(n, d, now);
    endBreak(n, d, now);
    d.status = 'off';
    d.hold = false;
    d.holdMs = 0;
    d.holdAt = null;
    d.eoAsk = null;
    d.leaveOnRest = false;
    d.checkOutAt = now;
    const last = d.sessions[d.sessions.length - 1];
    if (last && last.out == null) last.out = now;
    addLog(n, now, 'dealer', `${d.name} 퇴근${why ? ` (${why})` : ''}`);
  }

  function sendHome(s, dealerId, now) {
    const n = draft(s);
    const d = dealerOf(n, dealerId);
    if (!d || !present(d)) return s;
    goHome(n, d, now);
    fillVacancies(n, now);
    return n;
  }

  // ---------- 쉬러 나오면 퇴근 (예약) ----------
  // d.leaveOnRest — 교대로 쉬러 나오는 순간(또는 업무가 끝나 휴식이 되는 순간) 퇴근 처리한다. 지금 쉬는 중이면 바로 퇴근.
  // (2026-10-24 사용자 요청 — 명령 '김민준이 로테에서 나와서 휴식이면 퇴근시켜줘'). 교대에서는 executePush가, 그 밖에는 1초 박자가
  // leaveRested로 처리한다. 미리보기도 같은 길이라 표·휴대폰에 그 교대부터 '퇴근'으로 보인다
  function setLeaveOnRest(s, dealerId, on, now) {
    const d0 = dealerOf(s, dealerId);
    if (!d0 || !present(d0) || !!d0.leaveOnRest === !!on) return s;
    const n = draft(s);
    const d = dealerOf(n, dealerId);
    d.leaveOnRest = !!on;
    addLog(n, now, 'dealer', on ? `[예약] ${d.name} — 쉬러 나오면 퇴근` : `[예약] ${d.name} 퇴근 예약 취소`);
    return on ? leaveRested(n, now) : n;
  }

  function leaveRested(s, now) {
    const due = s.dealers.filter(d => d.leaveOnRest && d.status === 'break');
    if (!due.length) return s;
    const n = draft(s);
    for (const d0 of due) goHome(n, dealerOf(n, d0.id), now, '쉬러 나와서 — 예약');
    fillVacancies(n, now);
    return n;
  }

  function checkBack(s, dealerId, now) {
    const n = draft(s);
    const d = dealerOf(n, dealerId);
    if (!d || d.status !== 'off') return s;
    Object.assign(d, { status: 'break', since: now, streakMs: 0, checkOutAt: null, earlyOut: false, eoAsk: null, eoStay: false, hold: false, holdMs: 0, holdAt: null, planAt: null, inBase: baseOf(d), leaveOnRest: false });
    d.sessions.push({ in: now, out: null });
    queueUp(n, d);
    addLog(n, now, 'dealer', `${d.name} 복귀`);
    fillVacancies(n, now);
    return n;
  }

  // ---------- 출근 예정 · 자동 출근 · 출근 시간 변경 ----------

  // 출근 예정 딜러를 출근시킨다. auto면 예정 시각에 출근한 것으로 기록 (자동 출근)
  // 처음 오는 사람이면 '첫 출근'이라 공석이 있으면 바로, 없으면 다음 교대에 첫 번째로 들어간다.
  // 퇴근했다 다시 오는 사람은 복귀(checkBack)와 같다 — 지금부터 쉬기 시작해 오래 쉰 순서대로
  function arrive(s, ids, now, auto) {
    const list = s.dealers.filter(d => ids.includes(d.id) && d.status === 'planned');
    if (!list.length) return s;
    const n = draft(s);
    for (const d0 of list.sort((a, b) => (a.planAt || 0) - (b.planAt || 0))) {
      const d = dealerOf(n, d0.id);
      const at = auto && d.planAt != null && d.planAt <= now ? d.planAt : now;
      Object.assign(d, {
        status: 'break', since: now, tableId: null, streakMs: 0, hold: false, holdMs: 0, holdAt: null,
        planAt: null, checkAt: null, checkOutAt: null, earlyOut: false, eoAsk: null, eoStay: false, inBase: baseOf(d),
      });
      d.sessions.push({ in: at, out: null });
      if (d.checkInAt == null) d.checkInAt = at;
      queueUp(n, d);
      addLog(n, now, 'dealer', auto ? `${d.name} 출근 (예정 ${clock(at)} — 자동)` : `${d.name} 출근`);
    }
    fillVacancies(n, now);
    return n;
  }

  // 예정 시각이 된 딜러 출근 — 출근 체크(QR·디렉터)를 한 딜러만 (체크 없이 자동 출근을 켜 두면 모두).
  // 체크 안 한 딜러는 그대로 출근 예정 → 알림에 [출근]. 늦게 체크하면 체크한 때 바로 출근
  // assumeAfter: 미리보기용 — 이 시각 뒤 예정인 딜러는 아직 체크 전이어도 제시간에 온다고 보고 넣는다
  const isDue = (s, d, now, assumeAfter) => d.status === 'planned' && d.planAt != null && d.planAt <= now &&
    (d.checkAt != null || s.settings.autoArrive === true || (assumeAfter != null && d.planAt > assumeAfter));
  function arriveDue(s, now, assumeAfter) {
    const due = s.dealers.filter(d => isDue(s, d, now, assumeAfter));
    return due.length ? arrive(s, due.map(d => d.id), now, true) : s;
  }

  // 출근 체크 (휴대폰 출근 QR 또는 디렉터의 [출근]): 예정 시각 전이면 체크만 해 두고 예정 시각에 투입, 아니면 지금 출근
  function checkInDealer(s, dealerId, at, now) {
    const d0 = dealerOf(s, dealerId);
    if (!d0 || d0.status !== 'planned') return s;
    if (d0.planAt == null || d0.planAt <= now) {
      const n = arrive(s, [dealerId], now);
      n.log[0].msg = `${d0.name} 출근 체크 — 출근`;
      return n;
    }
    if (d0.checkAt != null) return s;
    const n = draft(s);
    dealerOf(n, dealerId).checkAt = at;
    addLog(n, now, 'dealer', `${d0.name} 출근 체크 (${clock(at)}) — ${clock(d0.planAt)}부터 투입`);
    return n;
  }

  // 휴대폰에서 온 출근 체크 반영. inbox = {딜러id: {c, at}} — 출근 예정인 딜러의, 아직 반영 안 한 것(at)만
  function applyCheckIns(s, inbox, now) {
    let n = s;
    const done = [];
    for (const id of Object.keys(inbox || {})) {
      const m = inbox[id];
      const d = dealerOf(n, id);
      if (!d || d.status !== 'planned' || !m || typeof m.at !== 'number' || m.at === d.ciAt) continue;
      const at = Math.min(m.at, now);
      const next = checkInDealer(n, id, at, now);
      n = next === n ? draft(n) : next;
      dealerOf(n, id).ciAt = m.at;
      const a = dealerOf(n, id);
      done.push({ id, name: a.name, waitUntil: a.status === 'planned' ? a.planAt : null });
    }
    return { state: n, done };
  }

  // 출근 예정 시각 정하기·바꾸기 (null = 시각 없이 '출근 전'). 퇴근한 딜러도 다시 출근 예정으로
  function setPlanAt(s, dealerId, at, now) {
    const d0 = dealerOf(s, dealerId);
    if (!d0 || (d0.status !== 'planned' && d0.status !== 'off')) return s;
    const when = Number.isFinite(at) ? at : null;
    if (d0.status === 'planned' && d0.planAt === when) return s;
    const n = draft(s);
    const d = dealerOf(n, dealerId);
    Object.assign(d, { status: 'planned', planAt: when, since: now, hold: false, eoAsk: null, eoStay: false, earlyOut: false });
    if (d0.status === 'off') d.checkAt = null;
    addLog(n, now, 'dealer', when == null ? `${d.name} 출근 예정 시각 지움 (출근 전)` : `${d.name} 출근 예정 ${clock(when)}`);
    return n;
  }

  // 출근 예정 취소: 한 번도 출근 안 했으면 명단에서 지우고, 출근 기록이 있으면 퇴근 상태로
  function removePlanned(s, dealerId, now) {
    const d0 = dealerOf(s, dealerId);
    if (!d0 || d0.status !== 'planned') return s;
    const n = draft(s);
    if (!d0.sessions.length) n.dealers = n.dealers.filter(d => d.id !== dealerId);
    else Object.assign(dealerOf(n, dealerId), { status: 'off', planAt: null });
    addLog(n, now, 'dealer', `${d0.name} 출근 예정 취소`);
    return n;
  }

  // 출근 시간 변경: 출근 처리됐지만(자동 출근 등) 실제로는 늦게 오는 딜러 → 바꾼 시각에 출근하는 것으로 되돌린다.
  // 실제로 일한 기록을 지우지 않게: 출근 뒤 테이블·다른 업무를 한 적 없이 쉬는 중이거나,
  // 막 들어간 자리(그 교대 구간 안, '미투입'이 되는 때)에 앉아 있을 때만
  function canDelay(s, dealerId, now) {
    const d = dealerOf(s, dealerId);
    if (!d || !d.inBase || d.totalWorkMs !== d.inBase.w || (d.totalDutyMs || 0) !== d.inBase.d) return false;
    if (d.status === 'break') return true;
    if (d.status !== 'working') return false;
    const info = undoInfo(s, d.tableId, now);
    return !!(info && info.dealer.id === d.id);
  }

  // 출근을 없던 일로 (출근 예정으로): 막 들어간 자리면 원래 딜러가 계속 앉은 것으로, 출근 기록에서 빠진다
  function unArrive(s, dealerId, now) {
    let m = s;
    const d0 = dealerOf(s, dealerId);
    // 교대로 막 들어간 자리면 '미투입'과 같이: 원래 딜러가 계속 앉아 있던 것으로
    if (d0.status === 'working') {
      const info = undoInfo(s, d0.tableId, now);
      if (info && info.dealer.id === d0.id) m = undoSeat(s, d0.tableId, now, {});
    }
    const n = draft(m);
    const d = dealerOf(n, dealerId);
    if (d.status === 'working') release(n, d, now);
    const base = d.inBase;
    d.sessions.pop();
    Object.assign(d, {
      status: 'planned', planAt: null, since: now, tableId: null, streakMs: 0, hold: false, holdMs: 0, holdAt: null,
      totalWorkMs: base.w, totalRestMs: base.r, totalDutyMs: base.d, totalHoldMs: base.h || 0, inBase: null,
      earlyOut: false, eoAsk: null, eoStay: false,
      checkInAt: d.sessions.length ? d.sessions[0].in : null,
      checkOutAt: d.sessions.length ? d.sessions[d.sessions.length - 1].out : null,
    });
    fillVacancies(n, now);
    return n;
  }

  // 바꾼 시각(지금보다 뒤)에 출근 → 그 시각이 되면 자동 출근, 로테이션은 그 뒤 가장 가까운 교대부터
  function delayArrival(s, dealerId, at, now) {
    if (!Number.isFinite(at) || at <= now || !canDelay(s, dealerId, now)) return s;
    const n = unArrive(s, dealerId, now);
    const d = dealerOf(n, dealerId);
    d.planAt = at;
    d.checkAt = null;
    addLog(n, now, 'dealer', `${d.name} 출근 시간 변경 → ${clock(at)} (출근 체크하면 그 시각부터 투입)`);
    return n;
  }

  // ---------- 다른 업무 ----------
  // 칩 정리·등록 도움 등. 테이블에는 없지만 근무로 센다 (로테에 들어간 것과 같게) —
  // 업무 중인 시간은 휴식이 아니고(오래 쉰 순에 안 쌓임), 끝나면 테이블에서 막 나온 사람처럼 그때부터 쉰다

  function startDuty(s, dealerId, task, now) {
    const d0 = dealerOf(s, dealerId);
    if (!d0 || !present(d0)) return s;
    const what = String(task || '').trim().slice(0, 30) || '다른 업무';
    if (d0.status === 'duty' && d0.task === what) return s;
    const n = draft(s);
    const d = dealerOf(n, dealerId);
    if (d.status === 'duty') {
      d.task = what;
      addLog(n, now, 'manual', `[업무] ${d.name} — ${what}`);
      return n;
    }
    const from = d.status === 'working' ? tableOf(n, d.tableId).no : 0;
    if (d.status === 'working') release(n, d, now);
    endBreak(n, d, now);
    Object.assign(d, { status: 'duty', since: clockNow(n, now), task: what, hold: false, tableId: null });
    addLog(n, now, 'manual', `[업무] ${d.name} — ${what}${from ? ` (${from}번에서 나옴)` : ''}`);
    fillVacancies(n, now);
    return n;
  }

  function endDuty(s, dealerId, now) {
    const d0 = dealerOf(s, dealerId);
    if (!d0 || d0.status !== 'duty') return s;
    const n = draft(s);
    const d = dealerOf(n, dealerId);
    const mins = Math.round(workedMs(n, d, now) / MIN);
    const what = d.task;
    finishDuty(n, d, now);
    addLog(n, now, 'manual', `[업무] ${d.name} ${what} 끝 — 휴식 (연속 ${mins}분)`);
    fillVacancies(n, now);
    return n;
  }

  // ---------- 오늘 버튼 ----------
  // 1~9번 중 무작위 하나. r(0~1)은 밖에서 넣는다 (시험에서 정해 둘 수 있게)
  function drawButton(s, now, r) {
    const n = draft(s);
    const no = 1 + Math.min(8, Math.floor((r == null ? Math.random() : r) * 9));
    n.button = { no, at: now };
    addLog(n, now, 'manual', `[버튼] 오늘 버튼 ${no}번${s.button ? ` (다시 뽑음 — 전에는 ${s.button.no}번)` : ''}`);
    return n;
  }

  // ---------- 출퇴근 시각 직접 적기 ----------
  // 웹에서 누른 시각이 아니라 실제 출퇴근 시각으로 고친다 (근무시간 기록·근무시간 CSV용).
  // 로테이션 장부·딜링/휴식 시간은 실제로 앉고 쉰 시간이므로 그대로 둔다.

  // 기준 시각(base)과 가장 가까운 'HH:MM' — 자정을 넘기는 대회도 맞게 (23:50 → 00:10 이면 다음 날)
  function nearTime(base, text) {
    const m = String(text || '').match(/^(\d{1,2}):(\d{2})$/);
    if (!m || +m[1] > 23 || +m[2] > 59) return null;
    const d = new Date(base);
    d.setHours(+m[1], +m[2], 0, 0);
    let t = d.getTime();
    if (t - base > 12 * 60 * MIN) t -= 24 * 60 * MIN;
    else if (base - t > 12 * 60 * MIN) t += 24 * 60 * MIN;
    return t;
  }
  // 출근 예정 시각 'HH:MM' — 앞으로 올 시각 쪽으로 읽는다. 가장 가까운 날로만 읽으면 11시 반에 적은 '00:27'(오늘 밤)이
  // 11시간 전 시각이 되어 바로 출근 처리됐다 (2026-10-24 검토). 3시간 넘게 지난 시각이면 다음 날로 본다
  // (몇 시간 전 시각은 '그때 출근했다'는 뜻으로 그대로 — 늦게 적어 넣는 경우)
  function planTime(now, text) {
    const t = nearTime(now, text);
    return t != null && t < now - 3 * 60 * MIN ? t + 24 * 60 * MIN : t;
  }


  const clock = t => {
    const d = new Date(t);
    return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  };

  // list = 출근 구간마다 {in, out} (지금 근무 중인 마지막 구간의 out은 null 그대로). 돌려주는 값 {state, error}
  function editSessions(s, dealerId, list, now) {
    const d0 = dealerOf(s, dealerId);
    if (!d0 || !Array.isArray(list) || list.length !== d0.sessions.length) return { state: s, error: '딜러를 찾을 수 없습니다' };
    for (let i = 0; i < list.length; i++) {
      const x = list[i];
      const open = d0.sessions[i].out == null;
      if (!Number.isFinite(x.in)) return { state: s, error: '출근 시각을 확인하세요 (예: 18:00)' };
      if (x.in > now) return { state: s, error: `출근 ${clock(x.in)}이(가) 지금보다 뒤입니다` };
      if (!open) {
        if (!Number.isFinite(x.out)) return { state: s, error: '퇴근 시각을 확인하세요 (예: 23:30)' };
        if (x.out > now) return { state: s, error: `퇴근 ${clock(x.out)}이(가) 지금보다 뒤입니다` };
        if (x.out <= x.in) return { state: s, error: `퇴근 ${clock(x.out)}이(가) 출근 ${clock(x.in)}보다 앞입니다` };
      }
      const next = list[i + 1];
      if (next && (open || x.out > next.in)) return { state: s, error: '출퇴근 구간이 서로 겹칩니다' };
    }
    const n = draft(s);
    const d = dealerOf(n, dealerId);
    const changes = [];
    d.sessions.forEach((x, i) => {
      if (x.in !== list[i].in) changes.push(`출근 ${clock(x.in)} → ${clock(list[i].in)}`);
      if (x.out != null && x.out !== list[i].out) changes.push(`퇴근 ${clock(x.out)} → ${clock(list[i].out)}`);
      x.in = list[i].in;
      if (x.out != null) x.out = list[i].out;
    });
    if (!changes.length) return { state: s, error: null };
    d.checkInAt = d.sessions[0].in;
    if (d.status === 'off') d.checkOutAt = d.sessions[d.sessions.length - 1].out;
    addLog(n, now, 'manual', `[출퇴근] ${d.name} ${changes.join(', ')} (직접 적음)`);
    return { state: n, error: null };
  }

  // ---------- 디렉터 개입 ----------

  // 특정 딜러를 특정 테이블에 바로 넣는다.
  // 쉬던 딜러면 원래 있던 딜러가 휴식으로, 다른 테이블에서 일하던 딜러면 두 사람이 자리를 맞바꾼다.
  function assignDealer(s, tableId, dealerId, now) {
    const n = draft(s);
    const t = tableOf(n, tableId);
    const d = dealerOf(n, dealerId);
    if (!t || t.status !== 'open' || !d || !present(d) || d.tableId === t.id) return s;
    finishDuty(n, d, now); // 다른 업무 중이었으면 끝내고 넣는다
    const cur = t.dealerId ? dealerOf(n, t.dealerId) : null;
    const wasIdle = t.use === false;
    t.use = true; // 대기 테이블에 딜러를 넣으면 사용으로
    if (wasIdle) addLog(n, now, 'table', `${t.no}번 테이블 사용`);
    if (d.status === 'working') {
      const other = tableOf(n, d.tableId);
      release(n, d, now);
      if (cur) release(n, cur, now);
      seat(n, d, t, now);
      if (cur) seat(n, cur, other, now);
      delete t.undo; // 자리 교환은 '미투입' 대상이 아님
      delete other.undo;
      addLog(n, now, 'manual', cur
        ? `[지정] ${d.name} ↔ ${cur.name} 자리 교환 (${other.no}번 ↔ ${t.no}번)`
        : `[지정] ${d.name} ${other.no}번 → ${t.no}번 이동`);
    } else {
      const out = cur ? releaseKeep(n, cur, now) : null;
      d.hold = false;
      seat(n, d, t, now, out);
      addLog(n, now, 'manual', `[지정] ${d.name} → ${t.no}번${cur ? ` (${cur.name} 휴식)` : ''}`);
    }
    fillVacancies(n, now);
    return n;
  }

  // 방금 들어간 딜러를 '미투입'으로 되돌릴 수 있나 — 이번 교대 구간 안, 그 뒤로 자리가 안 바뀐 경우만
  function undoInfo(s, tableId, now) {
    const t = tableOf(s, tableId);
    const u = t && t.status === 'open' ? t.undo : null;
    if (!u || t.dealerId !== u.inId) return null;
    const d = dealerOf(s, u.inId);
    if (!d || d.status !== 'working' || d.since !== u.seatAt) return null;
    if (clockNow(s, now) - u.seatAt > s.settings.pushMinutes * MIN) return null;
    const out = u.outId ? dealerOf(s, u.outId) : null;
    const outBack = !!(out && out.status === 'break' && out.since === u.at);
    return { dealer: d, out: outBack ? out : null };
  }

  // 미투입: 들어가기로 한 딜러가 실제로 안 들어갔을 때.
  //  - 안 들어간 딜러: 처음부터 계속 쉰 것으로 되돌리고 투입 보류 (장부상 '더 쉼' → 나중에 더 일하게 됨)
  //  - 대신 계속 일한 원래 딜러: 그동안 일한 것으로 되돌림 (장부상 '더 일함' → 나중에 더 쉬게 됨)
  //    opts.replace면 쉰 딜러를 바로 넣고 원래 딜러는 지금 휴식, 아니면 계속 (다음 교대 때 우선 휴식)
  //  - 원래 딜러가 이미 다른 데로 갔으면 다음 순서 딜러가 들어간다
  function undoSeat(s, tableId, now, opts) {
    const info = undoInfo(s, tableId, now);
    if (!info) return s;
    const n = draft(s);
    const t = tableOf(n, tableId);
    const u = t.undo;
    const d = dealerOf(n, u.inId);
    const dt = Math.max(0, clockNow(n, now) - u.seatAt);
    // 되돌린 시점부터 보류 (그 전 구간은 실제로 쉰 것이므로)
    Object.assign(d, u.inBefore, { hold: true, holdAt: now });
    t.dealerId = null;
    delete t.undo;
    addLog(n, now, 'manual', `[미투입] ${d.name} 휴식으로 되돌림 (투입 보류)`);
    if (info.out) {
      const y = dealerOf(n, u.outId);
      Object.assign(y, u.outBefore);
      t.dealerId = y.id;
      const extra = `${y.name} ${Math.round(dt / MIN)}분 더 일함`;
      const pick = opts && opts.replace ? pickFromPool(n, now, t.feature) : null;
      if (pick && !pick.short) {
        addLog(n, now, 'manual', `[미투입] ${extra} → 지금 휴식`);
        seatMidInterval(n, pick.dealer, t, now, false, releaseKeep(n, y, now));
      } else {
        addLog(n, now, 'manual', `[미투입] ${extra} → ${t.no}번 계속${opts && opts.replace ? ' (쉰 딜러 없음)' : ''}, 다음 교대 때 우선 휴식`);
      }
    }
    fillVacancies(n, now);
    return n;
  }

  // 바로잡기: 이 테이블에 실제로 앉아 있는 사람이 화면과 다를 때 (교대 직후가 아니어도, 언제든)
  //  - 고른 딜러가 쉬던 사람: 화면상 딜러가 앉은 때(고른 딜러가 그보다 늦게 쉬기 시작했으면 그때)부터
  //    고른 딜러가 일하고 화면상 딜러는 쉰 것으로 고친다. 장부는 그 시간만큼 분당 1분씩 서로 바뀐다 (미투입과 같은 셈)
  //  - 고른 딜러가 다른 테이블에서 일하던 사람: 두 사람의 테이블만 맞바꾼다 (둘 다 계속 일했으므로 장부 그대로)
  //  마지막 교대 기록에도 반영해서 로테이션 표의 지난 칸이 실제와 맞게 된다
  function fixSeat(s, tableId, dealerId, now) {
    const t0 = tableOf(s, tableId);
    const q0 = dealerOf(s, dealerId);
    if (!t0 || t0.status !== 'open' || !t0.dealerId || !q0 || !(q0.status === 'working' || q0.status === 'break') || q0.id === t0.dealerId) return s;
    const n = draft(s);
    const t = tableOf(n, tableId);
    const p = dealerOf(n, t.dealerId);
    const q = dealerOf(n, dealerId);
    const last = n.history[n.history.length - 1];
    if (q.status === 'working') {
      const t2 = tableOf(n, q.tableId);
      p.tableId = t2.id;
      q.tableId = t.id;
      t.dealerId = q.id;
      t2.dealerId = p.id;
      delete t.undo;
      delete t2.undo;
      if (last && last.a[p.id] === t.no && last.a[q.id] === t2.no) {
        last.a[p.id] = t2.no;
        last.a[q.id] = t.no;
      }
      addLog(n, now, 'manual', `[바로잡기] ${p.name} ↔ ${q.name} 자리가 바뀌어 있었음 (${t.no}번 ↔ ${t2.no}번)`);
      return n;
    }
    const from = Math.max(p.since, q.since); // 이때부터 실제로는 q가 앉아 있었다
    const dt = Math.max(0, clockNow(n, now) - from); // 바꾼 구간 (기록에 적는다)
    // p: from까지 일하고 그때부터 휴식
    const worked = Math.max(0, from - p.since);
    p.streakMs += worked;
    p.totalWorkMs += worked;
    Object.assign(p, { lastTableId: t.id, tableId: null, status: 'break', since: from, holdMs: 0, holdAt: p.hold ? from : null });
    // q: from까지 쉬고 그때부터 이 테이블
    closeHold(q, from);
    const rested = restedMs(q, from); // 보류였던 시간은 휴식으로 치지 않는다
    q.totalRestMs += rested;
    if (rested >= n.settings.minRestMinutes * MIN) q.streakMs = 0;
    Object.assign(q, { status: 'working', tableId: t.id, since: from, hold: false, holdMs: 0, holdAt: null });
    t.dealerId = q.id;
    delete t.undo;
    if (last && from <= last.at && last.a[p.id] === t.no) {
      last.a[p.id] = 0;
      last.a[q.id] = t.no;
    }
    addLog(n, now, 'manual', `[바로잡기] ${t.no}번: ${p.name} 대신 ${q.name}이(가) 앉아 있었음 — ${Math.round(dt / MIN)}분을 ${q.name} 근무, ${p.name} 휴식으로`);
    return n;
  }

  // ---------- 교대 때 딜러가 다른 테이블로 잘못 갔을 때 (실제 앉은 대로 고치기) ----------
  // 2026-10-24 사용자 요청: 명령 '김민수가 5번을 잘못 바꿔줬어' → 로테를 실제대로 고친다. 마지막 교대 기록(표의 지난 칸)도.
  // 시간은 '지금'이 아니라 그 교대 시각 기준 — 앉은 시간·쉰 시간이 실제와 같게 (바로잡기 fixSeat는 테이블 하나씩이라 이 경우를 못 맞춘다)
  //  x가 그 교대에 M번(y 대신)에 들어가기로 했는데 실제로는 N번에 앉았다:
  //   'swap'  N번에도 같은 교대에 w가 새로 들어갔다 → 둘이 서로 바꿔 앉은 것: 테이블만 맞바꾼다 (둘 다 그 교대부터 근무 그대로)
  //   'wrong' N번은 z가 계속 앉기로 한 자리 → x가 z를 잘못 빼 줬다: x는 그 교대부터 N번, z는 그 교대에 쉬러 나간 것으로,
  //           y는 M번에 계속 앉아 있던 것으로(나간 적 없음 — 미투입과 같은 셈). y가 없었으면(공석이었으면) M번은 쉬는 딜러로 채운다
  //   'enter' x는 쉬기로 했는데 N번에 들어가 z를 빼 줬다 → x는 그 교대부터 N번, z는 그 교대부터 휴식
  function misSeatCheck(s, dealerId, tableId) {
    const x = dealerOf(s, dealerId);
    const tN = tableOf(s, tableId);
    if (!x || !tN) return { why: '딜러나 테이블을 찾지 못했습니다' };
    if (tN.status !== 'open' || tN.use === false) return { why: `${tN.no}번은 사용 중인 테이블이 아닙니다` };
    const last = s.history[s.history.length - 1];
    const z = tN.dealerId ? dealerOf(s, tN.dealerId) : null;
    if (x.status === 'working') {
      const tM = tableOf(s, x.tableId);
      if (tM.id === tN.id) return { why: `${x.name}은(는) 화면에도 ${tN.no}번입니다 — 실제로 앉은 테이블 번호를 적어 주세요` };
      const u = tM.undo;
      if (!u || u.inId !== x.id || x.since !== u.seatAt) return { why: `${x.name}이(가) 방금 교대로 들어간 자리가 아닙니다 — 테이블 칸의 [바로잡기]를 쓰세요` };
      if (z && tN.undo && tN.undo.inId === z.id && tN.undo.at === u.at && z.since === tN.undo.seatAt) return { kind: 'swap', x, z, tM, tN, u };
      const y = u.outId ? dealerOf(s, u.outId) : null;
      const yBack = !!(y && y.status === 'break' && y.since === u.at);
      return { kind: 'wrong', x, z, y: yBack ? y : null, tM, tN, u, last };
    }
    if (x.status === 'break' && last && x.since <= last.at && z && z.since <= last.at) return { kind: 'enter', x, z, tN, last };
    return { why: `${x.name}은(는) 지금 ${x.status === 'break' ? '휴식 중' : '근무 중이 아님'}이라 그렇게 고칠 수 없습니다 — 테이블 칸의 [바로잡기]를 쓰세요` };
  }

  function misSeat(s, dealerId, tableId, now) {
    const c = misSeatCheck(s, dealerId, tableId);
    if (!c.kind) return s;
    const n = draft(s);
    const x = dealerOf(n, c.x.id);
    const tN = tableOf(n, c.tN.id);
    const z = c.z ? dealerOf(n, c.z.id) : null;
    const last = n.history[n.history.length - 1];
    if (c.kind === 'swap') {
      const tM = tableOf(n, c.tM.id);
      x.tableId = tN.id;
      z.tableId = tM.id;
      tN.dealerId = x.id;
      tM.dealerId = z.id;
      // 들어간 사람 쪽 기록만 맞바꾼다 — 나간 사람은 그 테이블에서 나간 그대로 (미투입하면 그 테이블 딜러가 제자리로)
      const uM = tM.undo;
      const uN = tN.undo;
      tM.undo = Object.assign({}, uM, { inId: z.id, inBefore: uN.inBefore, seatAt: z.since });
      tN.undo = Object.assign({}, uN, { inId: x.id, inBefore: uM.inBefore, seatAt: x.since });
      if (last && last.at === c.u.at) { last.a[x.id] = tN.no; last.a[z.id] = tM.no; }
      addLog(n, now, 'manual', `[바로잡기] ${x.name} ↔ ${z.name} 서로 바꿔 앉음 (${tM.no}번 ↔ ${tN.no}번)`);
      return n;
    }
    if (c.kind === 'enter') {
      const at = c.last.at;
      const zBefore = keep(z);
      release(n, z, at);                     // z는 그 교대에 쉬러 나간 것으로 (그때까지 근무)
      const xBefore = keep(x);
      closeHold(x, at);
      const rested = restedMs(x, at);
      x.totalRestMs += rested;
      if (rested >= n.settings.minRestMinutes * MIN) x.streakMs = 0;
      Object.assign(x, { status: 'working', tableId: tN.id, since: at, hold: false, holdMs: 0, holdAt: null });
      queueUp(n, x);
      tN.dealerId = x.id;
      tN.undo = { at, seatAt: at, inId: x.id, inBefore: xBefore, outId: z.id, outBefore: zBefore };
      if (last && last.at === at) { last.a[x.id] = tN.no; last.a[z.id] = 0; }
      addLog(n, now, 'manual', `[바로잡기] ${x.name}이(가) ${tN.no}번에 잘못 들어감 — ${hhmmOf(at)} 교대부터 ${x.name} 근무, ${z.name} 휴식`);
      return n;
    }
    // 'wrong': x가 M번 대신 N번으로
    const tM = tableOf(n, c.tM.id);
    const u = c.u;
    const at = u.at;
    tM.dealerId = null;
    delete tM.undo;
    let y = null;
    if (c.y) {                                // y는 M번에 계속 앉아 있던 것으로
      y = dealerOf(n, c.y.id);
      Object.assign(y, u.outBefore);
      tM.dealerId = y.id;
    }
    let zBefore = null;
    if (z) {                                  // z는 그 교대에 쉬러 나간 것으로
      zBefore = keep(z);
      release(n, z, at);
    }
    x.tableId = tN.id;                        // x는 그 교대부터 N번 (앉은 시각 그대로)
    tN.dealerId = x.id;
    tN.undo = { at, seatAt: x.since, inId: x.id, inBefore: u.inBefore, outId: z ? z.id : null, outBefore: zBefore };
    if (last && last.at === at) {
      last.a[x.id] = tN.no;
      if (y) last.a[y.id] = tM.no;
      if (z) last.a[z.id] = 0;
    }
    addLog(n, now, 'manual', `[바로잡기] ${x.name} — ${tM.no}번이 아니라 ${tN.no}번에 들어감 (${hhmmOf(at)} 교대)${z ? ` · ${z.name} 휴식` : ''}${y ? ` · ${y.name} ${tM.no}번 계속` : ` · ${tM.no}번 공석`}`);
    if (!y) fillVacancies(n, now);
    return n;
  }

  // 고정한 테이블은 자동 교대에서 빠진다 (파이널 테이블 등)
  function toggleTableLock(s, tableId, now) {
    const n = draft(s);
    const t = tableOf(n, tableId);
    if (!t) return s;
    t.locked = !t.locked;
    addLog(n, now, 'manual', `[지정] ${t.no}번 테이블 ${t.locked ? '고정 (자동 교대 제외)' : '고정 해제'}`);
    return n;
  }

  // 투입 보류한 딜러는 쉬는 중이어도 자동으로 투입되지 않는다 (식사, 개인 사정 등)
  // 보류 중인 시간은 휴식으로도 근무로도 치지 않는다 — 장부가 멈추고, 보류가 풀리면 원래 순서로 돌아온다
  function toggleHold(s, dealerId, now) {
    const n = draft(s);
    const d = dealerOf(n, dealerId);
    if (!d || d.status !== 'break') return s;
    d.hold = !d.hold;
    if (d.hold) d.holdAt = now;
    else closeHold(d, now);
    addLog(n, now, 'manual', `[지정] ${d.name} ${d.hold ? '투입 보류' : '보류 해제'}`);
    if (!d.hold) fillVacancies(n, now);
    return n;
  }

  // ---------- 출근자 명단 ----------
  // 이벤트마다 "오늘 부를 사람" 명단을 두고, 체크하면 출근 / 체크를 풀면 퇴근 (2026-10-11 사용자 요청).
  // 체크 상태를 따로 저장하면 dealers와 어긋날 수 있으므로 저장하지 않는다 — 그 이름의 딜러가 출근해 있으면 체크된 것.
  // 이름이 열쇠다 (딜러 DB는 없앴으므로). 같은 이름이 둘이면 디렉터가 "김동현2"처럼 구분해서 적는다.

  const cleanName = v => String(v == null ? '' : v).trim();

  // 이름 문자열 또는 {name, grade} 목록 → [{name, grade}] (빈 이름 버리고 같은 이름은 한 번만)
  function rosterEntries(raw, grade) {
    const out = [];
    const seen = new Set();
    for (const x of Array.isArray(raw) ? raw : []) {
      const e = typeof x === 'object' && x ? x : { name: x };
      const name = cleanName(e.name);
      if (!name || seen.has(name)) continue;
      seen.add(name);
      out.push({ name, grade: e.grade || grade || 'B' });
    }
    return out;
  }

  // 명단에 추가 (이미 있는 이름은 건너뛴다)
  function addRoster(s, entries, now, grade) {
    const n = draft(s);
    const have = new Set(n.roster.map(e => e.name));
    const fresh = rosterEntries(entries, grade).filter(e => !have.has(e.name));
    if (!fresh.length) return s;
    n.roster = n.roster.concat(fresh);
    addLog(n, now, 'dealer', `[명단] ${fresh.map(e => e.name).join(', ')} 추가`);
    return n;
  }

  // 명단을 통째로 다시 적는다
  function setRoster(s, entries, now, grade) {
    const n = draft(s);
    n.roster = rosterEntries(entries, grade);
    addLog(n, now, 'dealer', `[명단] ${n.roster.length}명으로 다시 적음`);
    return n;
  }

  // 명단에서 뺀다 (출퇴근 기록·로테이션은 건드리지 않는다)
  function removeRoster(s, name, now) {
    const who = cleanName(name);
    const n = draft(s);
    n.roster = n.roster.filter(e => e.name !== who);
    if (n.roster.length === s.roster.length) return s;
    addLog(n, now, 'dealer', `[명단] ${who} 뺌`);
    return n;
  }

  // 그 이름으로 지금 출근해 있는 딜러 (없으면 퇴근한 딜러라도)
  const onByName = (s, who) => s.dealers.find(d => d.name === who && d.status !== 'off') || null;

  // 화면용: 명단 + 지금 상태
  //  state: 'in' 출근 중 · 'plan' 출근 예정(아직 출근 전) · 'off' 왔다가 퇴근함 · 'none' 아직 안 옴
  function rosterView(s) {
    return s.roster.map(e => {
      const on = onByName(s, e.name);
      const d = on || s.dealers.find(x => x.name === e.name) || null;
      return {
        name: e.name,
        grade: (d && d.grade) || e.grade,
        id: d ? d.id : null,
        state: on ? (on.status === 'planned' ? 'plan' : 'in') : d ? 'off' : 'none',
        planAt: on && on.status === 'planned' ? on.planAt : null,
        checked: !!(on && on.status === 'planned' && on.checkAt != null), // 출근 체크함 (예정 시각에 투입)
      };
    });
  }

  // 명단에서 체크/해제. 체크 = 출근(처음이면 새로, 왔다 간 사람이면 복귀) · 해제 = 퇴근
  //  출근 예정인 사람은 체크 = 출근 체크 (휴대폰 체크와 같다 — 예정 시각 전이면 그 시각에 투입), 해제 = 출근 예정 취소
  function attend(s, name, now, want) {
    const who = cleanName(name);
    if (!who) return s;
    const on = onByName(s, who);
    if (!want) return !on ? s : on.status === 'planned' ? removePlanned(s, on.id, now) : sendHome(s, on.id, now);
    if (on) return on.status === 'planned' ? checkInDealer(s, on.id, now, now) : s;
    const back = s.dealers.find(d => d.name === who);
    if (back) return checkBack(s, back.id, now);
    const e = s.roster.find(x => x.name === who);
    return addDealers(s, [{ name: who, grade: (e && e.grade) || 'B' }], now);
  }

  // ---------- 공지 ----------

  function addNotice(s, text, now) {
    const body = String(text || '').trim();
    if (!body) return s;
    const n = draft(s);
    n.notices.unshift({ id: `n${++n.seq}`, at: now, text: body });
    return n;
  }

  function removeNotice(s, id) {
    const n = draft(s);
    n.notices = n.notices.filter(x => x.id !== id);
    return n;
  }

  // ---------- 퇴근 희망 ----------
  // 디렉터가 '받기'를 열면 모든 딜러 휴대폰에, 한 딜러에게 '묻기'를 하면 그 휴대폰에만 버튼이 뜬다.
  // 휴대폰의 답은 {w: 퇴근 희망 여부, at: 서버 시각, k: 어느 받기/묻기에 대한 답인지}로 들어온다.

  // 디렉터가 직접 표시/취소 (딜러에게 말로 들었을 때)
  function toggleEarlyOut(s, dealerId, now) {
    const n = draft(s);
    const d = dealerOf(n, dealerId);
    if (!d) return s;
    // eoAt = 퇴근 희망을 말한 시각. 먼저 말한 사람부터 번호를 매기므로 직접 표시할 때도 남긴다.
    // 취소할 때는 지우지 않는다 — 지우면 휴대폰에서 온 예전 답이 다시 들어와 되살아난다
    const on = !d.earlyOut;
    Object.assign(d, { earlyOut: on, eoAsk: null, eoStay: false });
    if (on && now != null) d.eoAt = now;
    if (now != null) addLog(n, now, 'manual', `[지정] ${d.name} ${d.earlyOut ? '퇴근 희망' : '퇴근 희망 취소'}`);
    return n;
  }

  function openEoCall(s, now) {
    if (s.eoCall.open) return s;
    const n = draft(s);
    n.eoCall = { open: true, id: `c${now.toString(36)}`, at: now };
    addLog(n, now, 'dealer', '[퇴근 희망] 휴대폰으로 받기 시작');
    return n;
  }

  function closeEoCall(s, now) {
    if (!s.eoCall.open) return s;
    const n = draft(s);
    n.eoCall = { open: false, id: null, at: now };
    const names = onDuty(n).filter(d => d.earlyOut).map(d => d.name);
    addLog(n, now, 'dealer', `[퇴근 희망] 받기 마감 — ${names.length ? names.join(', ') : '희망자 없음'}`);
    return n;
  }

  // 한 딜러에게 묻기 → 그 휴대폰에 '퇴근할게요 / 계속 일할게요'
  function askEarlyOut(s, dealerId, now) {
    const n = draft(s);
    const d = dealerOf(n, dealerId);
    if (!d || !present(d)) return s;
    Object.assign(d, { eoAsk: `a${now.toString(36)}`, eoStay: false });
    addLog(n, now, 'dealer', `[퇴근 희망] ${d.name}에게 휴대폰으로 물어봄`);
    return n;
  }

  function cancelEoAsk(s, dealerId, now) {
    const n = draft(s);
    const d = dealerOf(n, dealerId);
    if (!d || !d.eoAsk) return s;
    d.eoAsk = null;
    addLog(n, now, 'dealer', `[퇴근 희망] ${d.name} 묻기 취소`);
    return n;
  }

  // 휴대폰에서 온 답 반영. inbox = {딜러id: {w, at, k}}
  // 지금 열린 받기나 그 딜러에게 한 묻기에 대한 답(k)만, 아직 반영 안 한 것(at)만 받는다
  // → 마감된 받기, 지난 대회(초기화 전 같은 id)의 답은 무시
  function applyEoReplies(s, inbox, now) {
    const callId = s.eoCall.open ? s.eoCall.id : null;
    const replies = [];
    let n = null;
    for (const id of Object.keys(inbox || {})) {
      const m = inbox[id];
      const cur = dealerOf(s, id);
      if (!cur || !present(cur) || !m || typeof m.w !== 'boolean' || !m.k || m.at === cur.eoAt) continue;
      const asked = m.k === cur.eoAsk;
      if (!asked && m.k !== callId) continue;
      n = n || draft(s);
      const d = dealerOf(n, id);
      Object.assign(d, { earlyOut: m.w, eoAt: m.at, eoAsk: null, eoStay: asked && !m.w });
      const what = asked ? (m.w ? '퇴근할게요' : '계속 일할게요') : m.w ? '퇴근 희망' : '퇴근 희망 취소';
      addLog(n, now, 'dealer', `[휴대폰] ${d.name} ${what}`);
      replies.push({ id, name: d.name, w: m.w, asked, text: `${d.name} ${what}` });
    }
    return { state: n || s, replies };
  }

  // ---------- 표에서 끌어다 놓기 (디렉터) ----------
  // 로테이션 표의 '휴식' 칸을 끌어다 놓으면 그 교대만 바꾸고, 뒤의 예정은 엔진이 다시 계산한다.

  const dropPlans = (plans, n, ids) => plans.filter(p => p.n !== n || !ids.some(id => p.a === id || p.b === id));
  const livingDealer = (s, id) => { const d = dealerOf(s, id); return d && d.status !== 'off' ? d : null; };
  const okN = n => Number.isFinite(n) && n >= 1 && n <= PLAN_MAX;

  // 같은 교대에 같은 두 사람으로 이미 정해 둔 예약이 있나 (순서는 상관없이) — 다시 끌어다 놓으면 그 예약을 지운다.
  // 거꾸로 다시 놓아 원래대로 돌리려는 것인데, 새 예약으로 받으면 판정이 어긋나 '건너뜀' 경고만 남았다 (2026-10-24 검토)
  const samePair = (s, n, type, a, b) => (s.plans || []).some(p => p.n === n && p.type === type
    && ((p.a === a && p.b === b) || (p.a === b && p.b === a)));
  function dropPair(s, n, a, b, now, msg) {
    const d = draft(s);
    d.plans = dropPlans(d.plans, n, [a, b]);
    addLog(d, now, 'manual', msg);
    return d;
  }

  // 같은 시각(n번째 교대)의 두 딜러 자리를 맞바꾼다 — 한쪽이 휴식이면 휴식이 넘어간다
  function planSwap(s, n, aId, bId, now) {
    if (!s.clock.running || !okN(n) || aId === bId) return s;
    const a = livingDealer(s, aId);
    const b = livingDealer(s, bId);
    if (!a || !b) return s;
    if (samePair(s, n, 'swap', aId, bId)) return dropPair(s, n, aId, bId, now, `${n}번째 교대: ${a.name} ↔ ${b.name} 휴식 넘기기 취소 (원래대로)`);
    const d = draft(s);
    d.plans = dropPlans(d.plans, n, [aId, bId]).concat([{ n, type: 'swap', a: aId, b: bId }]).slice(-PLAN_MAX);
    addLog(d, now, 'manual', `${n}번째 교대: ${a.name} ↔ ${b.name} 자리 맞바꿈`);
    return d;
  }

  // 같은 시각(n번째 교대)에 앉아 있을 두 딜러의 테이블을 맞바꾼다 (테이블 칸 ↔ 테이블 칸, 2026-10-24 사용자 요청)
  function planTrade(s, n, aId, bId, now) {
    if (!s.clock.running || !okN(n) || aId === bId) return s;
    const a = livingDealer(s, aId);
    const b = livingDealer(s, bId);
    if (!a || !b) return s;
    if (samePair(s, n, 'trade', aId, bId)) return dropPair(s, n, aId, bId, now, `${n}번째 교대: ${a.name} ↔ ${b.name} 테이블 맞바꿈 취소 (원래대로)`);
    const d = draft(s);
    d.plans = dropPlans(d.plans, n, [aId, bId]).concat([{ n, type: 'trade', a: aId, b: bId }]).slice(-PLAN_MAX);
    addLog(d, now, 'manual', `${n}번째 교대: ${a.name} ↔ ${b.name} 테이블 맞바꿈`);
    return d;
  }

  // 한 딜러의 휴식을 다른 교대로 옮긴다 — to번째에 쉬고, 그 사이는 자리를 지킨다.
  // 사이를 묶지 않으면 자리에 오래 앉은 탓에 중간에 저절로 쉬게 되어 연속 두 번 쉬는 꼴이 된다.
  function planMoveRest(s, from, to, dealerId, now) {
    if (!s.clock.running || !okN(from) || !okN(to) || from === to) return s;
    const who = livingDealer(s, dealerId);
    if (!who) return s;
    const lo = Math.min(from, to);
    const hi = Math.max(from, to);
    const d = draft(s);
    let plans = d.plans;
    const add = [];
    for (let n = lo; n <= hi; n++) {
      plans = dropPlans(plans, n, [dealerId]);
      add.push(n === to ? { n, type: 'rest', a: dealerId } : { n, type: 'keep', a: dealerId });
    }
    d.plans = plans.concat(add).slice(-PLAN_MAX);
    addLog(d, now, 'manual', `${who.name} 휴식을 ${from}번째 → ${to}번째 교대로 옮김`);
    return d;
  }

  function clearPlans(s, now) {
    if (!s.plans || !s.plans.length) return s;
    const d = draft(s);
    d.plans = [];
    addLog(d, now, 'manual', '직접 정한 교대 모두 취소');
    return d;
  }

  // n번째 교대에서 직접 정해 둔 딜러들 (표에 표시용)
  function plannedIds(s, n) {
    const ids = new Set();
    for (const p of s.plans || []) {
      if (p.n !== n) continue;
      ids.add(p.a);
      if (p.b) ids.add(p.b);
    }
    return ids;
  }

  // 디렉터가 끌어다 놓은 횟수 ('keep'은 'rest'와 한 쌍이므로 세지 않는다)
  const planCount = s => (s.plans || []).filter(p => p.type !== 'keep').length;

  // ---------- 작업 되돌리기 ----------
  // 디렉터 작업(깨기·퇴근·출근·지정 등) 직전의 테이블·딜러·시계를 쌓아 두고 한 단계씩 되돌린다.
  //  - 교대가 실행되면 딜러가 이미 움직였으므로 그 전 작업은 되돌리지 않는다 (쌓인 것을 비움)
  //  - 공지·설정·기록, 퇴근 희망(휴대폰 답 포함)은 되돌리지 않고 지금 것을 그대로 둔다
  const PAST_MAX = 20;
  const EO_FIELDS = ['earlyOut', 'eoAsk', 'eoStay', 'eoAt'];

  function remember(prev, next, label, now) {
    if (!next || next === prev) return next;
    const n = Object.assign({}, next);
    const snap = draft({ clock: prev.clock, tables: prev.tables, dealers: prev.dealers,
      plans: prev.plans || [], histLen: prev.history.length });
    // 마지막 교대 기록을 고친 작업(바로잡기)이면 그 기록도 담아 둔다
    const i = prev.history.length - 1;
    if (i >= 0 && next.history[i] && JSON.stringify(prev.history[i]) !== JSON.stringify(next.history[i])) snap.histLast = draft(prev.history[i]);
    n.past = (prev.past || []).concat([{ at: now, label, snap }]).slice(-PAST_MAX);
    return n;
  }

  // 전체 초기화도 되돌릴 수 있게 대회 전체를 한 번 담아 둔다
  function resetState(s, now) {
    const n = createState(s.settings);
    n.roster = rosterEntries(s.roster); // 명단은 남긴다 — 초기화 후 다시 체크해서 출근시키면 된다
    // 딜러 번호(d1, d2…)는 이어서 쓴다 — 처음부터 다시 쓰면 방에 남은 예전 휴대폰 출근 체크(ci/d1…)가
    // 같은 번호의 새 딜러에게 붙어 체크한 적 없는 사람이 출근 처리된다 (2026-10-24 검토)
    n.seq = s.seq || 0;
    n.past = [{ at: now, label: '전체 초기화', full: draft(Object.assign({}, s, { past: [] })) }];
    return n;
  }

  const lastStep = s => (s.past && s.past.length ? s.past[s.past.length - 1] : null);

  function revert(s, now) {
    const step = lastStep(s);
    if (!step) return s;
    let n;
    if (step.full) {
      n = migrate(draft(step.full));
    } else {
      n = draft(s);
      const snap = draft(step.snap);
      const cur = new Map(n.dealers.map(d => [d.id, d]));
      for (const d of snap.dealers) {
        const c = cur.get(d.id);
        if (c) EO_FIELDS.forEach(k => { d[k] = c[k]; });
      }
      Object.assign(n, { clock: snap.clock, tables: snap.tables, dealers: snap.dealers, plans: snap.plans || [] });
      n.history = n.history.slice(0, snap.histLen);
      if (snap.histLast) n.history[snap.histLen - 1] = snap.histLast;
    }
    n.past = s.past.slice(0, -1);
    addLog(n, now, 'manual', `[되돌리기] ${step.label}`);
    return n;
  }

  // 교대 간격을 바꾸면 다음 교대 시각도 '진행 중(마지막 교대)' 기준으로 바로 옮긴다 (2026-10-11 사용자 요청).
  // 안 그러면 이번 한 번만 옛 간격으로 가서 표의 시각이 들쭉날쭉해진다 (13:45 → 14:05 → 14:20 …).
  // 잡혀 있는 시각에서 옛 간격을 빼고 새 간격을 더하므로 일시정지로 밀린 만큼은 그대로 남는다.
  function updateSettings(s, patch, now) {
    const n = draft(s);
    const was = n.settings.pushMinutes;
    Object.assign(n.settings, patch);
    const every = n.settings.pushMinutes;
    if (every !== was && n.clock.running && n.clock.nextPushAt != null) {
      const at = n.clock.nextPushAt - was * MIN + every * MIN;
      n.clock.nextPushAt = gridAt(at, now == null ? null : clockNow(n, now)); // 이미 지난 시각이면 다음 눈금으로
      if (now != null) addLog(n, now, 'clock', `교대 간격 ${was}분 → ${every}분 (다음 교대 ${hhmmOf(n.clock.nextPushAt)})`);
    }
    return n;
  }

  // ---------- 교대 간격 예약 ('3시부터 15분 간격') ----------
  // clock.intervalPlan = {at, minutes}: at(5분 눈금)에 꼭 교대하고, 그 교대부터 minutes분마다 (2026-10-24 사용자 요청 — 명령 입력칸).
  // clock 안에 두어 되돌리기·저장·미리보기가 같이 따라온다. at이 지나면(그 교대에서) 설정의 교대 간격이 바뀐다
  function scheduleInterval(s, at, minutes, now) {
    const m = Math.round(Number(minutes));
    if (!s.clock.running || !Number.isFinite(at) || !(m >= 5 && m <= 120)) return s;
    const t = Math.round(at / GRID) * GRID;
    if (t <= clockNow(s, now)) return s;
    const n = draft(s);
    n.clock.intervalPlan = { at: t, minutes: m };
    // 다음 교대가 그 시각보다 뒤면 그 시각으로 당긴다 — 그 시각에 꼭 교대
    if (n.clock.nextPushAt != null && n.clock.nextPushAt > t) n.clock.nextPushAt = t;
    addLog(n, now, 'clock', `[예약] ${hhmmOf(t)}부터 교대 간격 ${m}분`);
    return n;
  }

  function cancelIntervalPlan(s, now) {
    if (!s.clock.intervalPlan) return s;
    const n = draft(s);
    addLog(n, now, 'clock', `[예약] ${hhmmOf(n.clock.intervalPlan.at)}부터 교대 간격 ${n.clock.intervalPlan.minutes}분 — 취소`);
    n.clock.intervalPlan = null;
    return n;
  }

  function startClock(s, now) {
    const at = floorGrid(now); // 시작 시각도 5분 눈금으로 내린다 — 표의 '진행 중' 칸까지 눈금에 맞게
    const n = draft(s);
    for (const d of onDuty(n)) { // 시작 전 시간은 근무·휴식으로 치지 않음
      d.since = at;
      d.streakMs = 0;
    }
    n.clock = { running: true, paused: false, pausedAt: null, nextPushAt: gridAt(at + n.settings.pushMinutes * MIN, at) };
    fillVacancies(n, at);
    record(n, at);
    addLog(n, at, 'clock', '로테이션 시작');
    return n;
  }

  // 시작 시각을 정해서 시작한다 (2026-10-11 사용자 요청).
  // 대회는 10시에 이미 시작했는데 앱은 12시 반에 켰다면 10시를 적는다 →
  // 그때부터 지금까지 교대를 차례로 돌려 두므로 로테이션 표가 처음부터 채워지고,
  // 다음 교대 시각도 10시 기준 격자(10:20, 10:40 …)에 맞는다.
  const MAX_BACKFILL_MS = 24 * 60 * MIN; // 하루보다 더 전으로는 못 돌린다
  const hhmmOf = t => {
    const d = new Date(t);
    return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  };

  function startClockAt(s, startAt, now) {
    if (s.clock.running) return s;
    if (!Number.isFinite(startAt) || startAt > now || now - startAt > MAX_BACKFILL_MS) return s;
    const from = floorGrid(startAt); // 교대 시각이 5분 눈금에 맞게
    const n0 = draft(s);
    // 지금 적어 넣은 딜러도 그 시각부터 있던 것으로 본다 (사람마다 다르면 출퇴근 탭에서 고친다)
    for (const d of n0.dealers) {
      if (d.status === 'off') continue;
      if (d.checkInAt > from) d.checkInAt = from;
      if (d.sessions.length && d.sessions[0].in > from) d.sessions[0].in = from;
    }
    let n = startClock(n0, from);
    let pushes = 0;
    while (n.clock.nextPushAt != null && n.clock.nextPushAt <= now) {
      n = executePush(n, n.clock.nextPushAt).state;
      pushes++;
    }
    if (pushes) addLog(n, now, 'clock', `${hhmmOf(from)}부터 지금까지 ${pushes}번 교대한 것으로 채움`);
    return n;
  }

  // 대회 브레이크(레벨 브레이크, 식사 등) — 교대 시계, 근무 시간, 장부가 멈춘다
  function pauseClock(s, now) {
    if (!s.clock.running || s.clock.paused) return s;
    const n = draft(s);
    n.clock.paused = true;
    n.clock.pausedAt = now;
    addLog(n, now, 'clock', '일시정지');
    return n;
  }

  function resumeClock(s, now) {
    if (!s.clock.running || !s.clock.paused) return s;
    const n = draft(s);
    const p = n.clock.pausedAt;
    n.clock.nextPushAt = gridAt(n.clock.nextPushAt + (now - p), now);
    const ip = n.clock.intervalPlan; // 간격 예약 시각이 아직 안 지났으면 그 시각에 꼭 교대
    if (ip && n.clock.nextPushAt > ip.at && ip.at > now) n.clock.nextPushAt = ip.at;
    for (const d of n.dealers.filter(busy)) d.since = now - Math.max(0, p - d.since);
    n.clock.paused = false;
    n.clock.pausedAt = null;
    addLog(n, now, 'clock', `재개 (${Math.round((now - p) / MIN)}분 정지)`);
    return n;
  }

  // 교대가 일어난 시각 — 늘 5분 눈금에 맞춘다 (표 머리가 0분·5분으로 끝나야 한다).
  // 직전 교대와 같은 눈금이면 다음 눈금으로 민다 — 한 눈금에 기록이 둘이면 표에 같은 열이 두 번 뜬다
  const pushTime = (s, now) => gridAt(now, s.history.length ? s.history[s.history.length - 1].at : null);

  function executePush(s, now) {
    const at = pushTime(s, now); // 손으로 당겨 교대해도 기록은 0분·5분에 남는다
    const freed = new Set();
    s = applyTableSched(s, at, freed); // 이번 교대 몫 테이블 예약(사용 시작·대기·깨기)을 먼저 — 그 교대의 계획 안에서 딜러가 들고 난다
    const plan = planPush(s, at, freed);
    const n = draft(s);
    const outs = {};
    // 줄 순번(turn)이 교대의 순서를 따르게: 나가는 사람은 나갈 순서대로, 들어오는 사람은 들어갈 순서대로 부른다
    // (표의 테이블 번호 순으로 부르면 다음 교대의 동점이 다시 테이블 번호로 풀린다)
    const outRank = new Map(plan.toBreak.map((id, i) => [id, i]));
    const inRank = new Map(breakPool(s, at).map((d, i) => [d.id, i]));
    const rank = (m, id) => (m.has(id) ? m.get(id) : Infinity);
    // 테이블 맞바꿈(디렉터가 표에서 직접 정함)으로 앉은 채 다른 테이블로 가는 사람 — 쉬러 가는 게 아니라 테이블만 바꾼다.
    // 앉은 시간·줄 순번·연속 근무를 그대로 둔다 (다시 앉은 것으로 치면 나갈 차례를 놓쳐 그만큼 더 일한다 — 2026-10-24 검토)
    const before = snapshot(s);
    const movers = new Set(plan.moves.filter(m => m.toDealerId && before[m.toDealerId] > 0).map(m => m.toDealerId));
    const leaving = plan.moves.filter(m => m.fromDealerId && !movers.has(m.fromDealerId))
      .sort((a, b) => rank(outRank, a.fromDealerId) - rank(outRank, b.fromDealerId));
    for (const m of leaving) outs[m.tableId] = releaseKeep(n, dealerOf(n, m.fromDealerId), at);
    const coming = plan.moves.filter(m => m.toDealerId).sort((a, b) => rank(inRank, a.toDealerId) - rank(inRank, b.toDealerId));
    for (const m of coming) {
      const d = dealerOf(n, m.toDealerId);
      const t = tableOf(n, m.tableId);
      if (movers.has(d.id)) {
        d.tableId = t.id;
        t.dealerId = d.id;
      } else {
        seat(n, d, t, at, outs[m.tableId]);
      }
    }
    // 맞바꿈에 낀 테이블은 '미투입'으로 되돌리지 않는다 (되돌리면 한 사람이 두 테이블에 앉게 된다 — assignDealer의 자리 교환과 같다)
    for (const m of plan.moves) {
      if (movers.has(m.toDealerId) || movers.has(m.fromDealerId)) delete tableOf(n, m.tableId).undo;
    }

    const c = n.clock;
    if (c.running) {
      const ip = c.intervalPlan;
      if (ip && at >= ip.at) { // 예약한 시각의 교대 — 이 교대부터 새 간격
        if (n.settings.pushMinutes !== ip.minutes) addLog(n, at, 'clock', `교대 간격 ${n.settings.pushMinutes}분 → ${ip.minutes}분 (예약)`);
        n.settings.pushMinutes = ip.minutes;
        c.intervalPlan = null;
      }
      const pushMs = n.settings.pushMinutes * MIN;
      const inTime = c.nextPushAt != null && at >= c.nextPushAt && at - c.nextPushAt < pushMs;
      let next = gridAt((inTime ? c.nextPushAt : at) + pushMs, at); // 정시 교대는 시간 격자 유지
      if (c.intervalPlan && next > c.intervalPlan.at) next = c.intervalPlan.at; // 예약한 시각에 꼭 교대
      c.nextPushAt = next;
    }
    for (const d of n.dealers) if (d.leaveOnRest && d.status === 'break') goHome(n, d, at, '쉬러 나와서 — 예약');
    record(n, at);
    n.past = []; // 딜러가 이미 움직였으므로 교대 전 작업은 되돌리지 않는다
    // 이번 교대 몫 예약은 쓰고 버리고, 나머지는 한 칸씩 당긴다
    n.plans = (s.plans || []).filter(p => p.n > 1).map(p => Object.assign({}, p, { n: p.n - 1 }));
    for (const t of n.tables) if (t.sched) t.sched.n -= 1; // 이번 몫은 위에서 써서 지웠다
    const changed = plan.moves.filter(m => m.toDealerId).length;
    addLog(n, at, 'push', `교대 — ${changed}테이블 교대, ${plan.kept}테이블 유지`);
    plan.warnings.forEach(w => addLog(n, at, 'warn', w));
    return { state: n, plan };
  }

  // ---------- 디렉터에게 줄 제안 ----------

  function suggestions(s, now) {
    const out = [];
    const maxMs = maxWorkMs(s); // 제한 없으면 Infinity → 연장 경고 없음
    const st = staffing(s);
    const hasRested = s.dealers.some(d => isRested(s, d, now));

    // 공석은 테이블마다 한 줄이 아니라 한 줄로 (테이블을 많이 열면 알림이 화면을 밀어내지 않게)
    const vacant = usedTables(s).filter(t => !t.dealerId).map(t => t.no);
    if (vacant.length) out.push({ level: 'danger', text: `공석 ${rangeText(vacant)}번 — 딜러 필요`, actions: [] });
    const due = s.dealers.filter(d => d.status === 'planned' && d.planAt != null && d.planAt <= now && d.checkAt == null);
    if (due.length) {
      out.push({
        level: 'warn',
        text: `출근 체크 안 함 — ${due.map(d => `${d.name}(${clock(d.planAt)})`).join(', ')}`,
        actions: due.map(d => ({ type: 'arrive', id: d.id, label: `${d.name} 출근` })),
      });
    }
    const idle = idleTables(s).filter(t => !(t.sched && t.sched.act === 'use')).map(t => t.no); // 사용 예약한 테이블은 알림에서 뺀다
    if (idle.length) {
      out.push({
        level: 'info',
        text: `대기 ${rangeText(idle)}번 — 딜러 없음`, // 칸에서 [사용]을 체크하면 투입
        actions: [{ type: 'use-all', id: '', label: idle.length > 1 ? '모두 사용' : '사용' }],
      });
    }
    for (const d of working(s)) {
      const w = workedMs(s, d, now);
      if (w < maxMs) continue;
      const t = tableOf(s, d.tableId);
      out.push({
        level: 'warn',
        text: `${d.name} (${t.no}번) ${Math.floor(w / MIN)}분 연속 근무 — 휴식 필요`,
        actions: hasRested ? [{ type: 'relieve', id: t.id, label: '지금 교체' }] : [],
      });
    }
    if (st.tables && st.available < st.tables) {
      out.push({ level: 'danger', text: `딜러 ${st.tables - st.available}명 부족 — 추가 호출 필요${st.onTask ? ` (다른 업무 ${st.onTask}명)` : ''}${st.planned ? ` (출근 예정 ${st.planned}명)` : ''}`, actions: [] });
    } else if (st.limited && st.tables && st.diff < 0) {
      out.push({ level: 'warn', text: `권장 인원(${st.recommended}명)보다 ${-st.diff}명 적음 — 연장 근무 발생 가능`, actions: [] });
    } else if (st.limited && st.tables && st.diff > 0) {
      // 근무 제한이 있을 때만 '남는 인원'을 따질 수 있다 (제한이 없으면 남는 만큼 교대가 더 돌 뿐)
      // 조기 퇴근(얼리아웃): 퇴근 희망자 먼저, 그다음 일찍 출근한 순
      // 희망자 먼저 (먼저 말한 순) → 그다음 일찍 출근한 순
      const cands = s.dealers.filter(d => d.status === 'break')
        .sort((a, b) => (b.earlyOut - a.earlyOut)
          || (a.earlyOut ? (a.eoAt || a.checkInAt) - (b.eoAt || b.checkInAt) : 0)
          || a.checkInAt - b.checkInAt)
        .slice(0, st.diff);
      if (cands.length) {
        out.push({
          level: 'info',
          text: `딜러 ${st.diff}명 여유 — 조기 퇴근 추천`,
          actions: cands.map(d => ({ type: 'home', id: d.id, label: `${d.name} 퇴근${d.earlyOut ? ' (희망)' : ''}` })),
        });
      }
    }
    return out;
  }

  return {
    MIN,
    DEFAULT_SETTINGS,
    createState,
    migrate,
    activeTables,
    usedTables,
    idleTables,
    breakPool,
    working,
    dealerOf,
    tableOf,
    isRested,
    mustGoIn,
    workedMs,
    maxWorkMs,
    hasWorkLimit,
    isHeld,
    restedMs,
    msToPush,
    clockNow,
    staffing,
    snapshot,
    DUTY,
    canDelay,
    planPush,
    project,
    planSwap,
    planTrade,
    planMoveRest,
    clearPlans,
    plannedIds,
    planCount,
    suggestions,
    addDealers,
    openTable,
    parseNos,
    rangeText,
    setTableUse,
    scheduleTable,
    unscheduleTable,
    tableUsedAt,
    tableClosedAt,
    closeTable,
    relieveTable,
    sendHome,
    setLeaveOnRest,
    leaveRested,
    checkBack,
    rosterEntries,
    addRoster,
    setRoster,
    removeRoster,
    rosterView,
    attend,
    arrive,
    arriveDue,
    checkInDealer,
    applyCheckIns,
    setPlanAt,
    removePlanned,
    delayArrival,
    startDuty,
    endDuty,
    drawButton,
    nearTime,
    planTime,
    editSessions,
    assignDealer,
    undoInfo,
    undoSeat,
    fixSeat,
    misSeat,
    misSeatCheck,
    toggleTableLock,
    toggleHold,
    addNotice,
    removeNotice,
    toggleEarlyOut,
    eoOrder,
    openEoCall,
    closeEoCall,
    askEarlyOut,
    cancelEoAsk,
    applyEoReplies,
    remember,
    resetState,
    lastStep,
    revert,
    updateSettings,
    scheduleInterval,
    cancelIntervalPlan,
    startClock,
    startClockAt,
    pauseClock,
    resumeClock,
    executePush,
  };
});
