/* dealer-director(DD) 로테이션 엔진 — thstjdals09-lang/dealer-director js/engine.js (28e9804) 를 그대로 복사.
   고칠 때는 DD 저장소에서 고치고 이 파일을 다시 복사한다. Holdem TD 쪽 연결은 js/floor.js 의 딜러 부분. */
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
  };

  function createState(settings) {
    return {
      version: VERSION,
      settingsRev: SETTINGS_REV,
      settings: Object.assign({}, DEFAULT_SETTINGS, settings),
      clock: { running: false, paused: false, nextPushAt: null, pausedAt: null },
      tables: [],
      dealers: [],
        history: [],    // 교대 시점마다 {at, a: {딜러id: 테이블번호 | 0(휴식)}}
      notices: [],    // 공지 {id, at, text}
      roster: [],     // 출근자 명단 {name, grade} — 체크하면 출근, 풀면 퇴근
                      // 체크 상태는 따로 두지 않는다: 그 이름의 딜러가 출근해 있으면 체크된 것 (rosterView)
      eoCall: { open: false, id: null, at: null }, // 휴대폰으로 퇴근 희망 받기 (열려 있으면 모든 딜러 휴대폰에 버튼)
      past: [],       // 작업 되돌리기용 — 작업 직전 모습 {at, label, snap | full}
      plans: [],      // 표에서 끌어다 놓은 교대 예약 — {n, type, a, b}. n = 앞으로 n번째 교대(1 = 다음 교대)
                      // type 'swap': a와 b의 자리를 맞바꾼다 / 'rest': a를 쉬게 / 'keep': a를 안 빼고 그대로
      log: [],
      seq: 0,
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
    }, d));
    s.tables = s.tables.map(t => Object.assign({ locked: false }, t));
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
  const activeTables = s => s.tables.filter(t => t.status === 'open').sort(byNo);
  const working = s => s.dealers.filter(d => d.status === 'working');
  const onDuty = s => s.dealers.filter(d => d.status !== 'off');
  const isFresh = d => d.totalWorkMs === 0; // 출근 후 아직 한 번도 안 앉음

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

  // 휴식 없이 이어서 일한 시간 (지금 앉은 테이블 포함) — 최대 연속 근무를 재는 값
  function workedMs(s, d, now) {
    if (d.status !== 'working') return d.streakMs;
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
  function inOrder(s, now) {
    return (a, b) => (isFresh(b) - isFresh(a)) || restedMs(b, now) - restedMs(a, now);
  }
  const breakPool = (s, now) => s.dealers.filter(d => d.status === 'break')
    .sort(now == null ? (a, b) => a.since - b.since : inOrder(s, now));

  // 한 딜러가 쉬지 않고 일할 수 있는 교대 횟수 k → 테이블 T개면 T + ceil(T/k) 명
  // 최대 근무가 정해져 있으면: 쉬지 않고 일할 수 있는 교대 횟수 k → 테이블 T개면 T + ceil(T/k) 명
  // 제한이 없으면: 테이블 수만큼만 있으면 된다 (남는 사람은 그만큼 교대가 돈다)
  function staffing(s) {
    const tables = activeTables(s).length;
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
      recommended,
      diff: duty.length - recommended,
    };
  }

  // 퇴근 희망자를 먼저 말한 순서대로 — 직접 표시한 것도 휴대폰 답도 같은 줄에 세운다.
  // 시각이 없는 예전 자료는 출근이 이른 사람부터 (적어도 순서가 흔들리지는 않게)
  const eoOrder = s => s.dealers.filter(d => d.status !== 'off' && d.earlyOut)
    .sort((a, b) => (a.eoAt || a.checkInAt) - (b.eoAt || b.checkInAt) || a.checkInAt - b.checkInAt);

  // 지금 누가 어디 있는지: {딜러id: 테이블번호 | 0(휴식)} — 퇴근자는 빠진다
  function snapshot(s) {
    const a = {};
    for (const d of s.dealers) {
      if (d.status === 'working') a[d.id] = tableOf(s, d.tableId).no;
      else if (d.status === 'break') a[d.id] = 0;
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

  function release(s, d, now) {
    const t = tableOf(s, d.tableId);
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

  // '미투입' 되돌리기에 필요한 딜러 상태
  const UNDO_FIELDS = ['status', 'since', 'tableId', 'lastTableId', 'streakMs', 'totalWorkMs', 'totalRestMs',
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
    for (const t of activeTables(s).filter(t => !t.dealerId).sort(featureFirst)) {
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
    return raw.filter(p => p && Number.isFinite(p.n) && p.n >= 1 && p.n <= PLAN_MAX && typeof p.a === 'string'
      && (p.type === 'swap' ? typeof p.b === 'string' && p.b !== p.a : p.type === 'rest' || p.type === 'keep'))
      .map(p => (p.type === 'swap' ? { n: p.n, type: 'swap', a: p.a, b: p.b } : { n: p.n, type: p.type, a: p.a }))
      .slice(-PLAN_MAX);
  }

  // 이번 교대(n === 1)에 적용할 예약. 퇴근한 딜러가 낀 것은 버린다
  function pushPlan(s) {
    const live = id => { const d = dealerOf(s, id); return !!d && d.status !== 'off'; };
    const fix = { rest: new Set(), keep: new Set(), swap: [] };
    for (const p of s.plans || []) {
      if (p.n !== 1) continue;
      if (p.type === 'swap') { if (live(p.a) && live(p.b)) fix.swap.push([p.a, p.b]); continue; }
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
    for (const t of activeTables(s)) {
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
  function planPush(s, now) {
    const set = s.settings;
    const maxMs = maxWorkMs(s);
    const shortMs = set.shortSeatMinutes * MIN;
    const tables = activeTables(s);
    const fix = pushPlan(s); // 표에서 끌어다 놓은 예약 (이번 교대 몫)
    const pool = breakPool(s, now).filter(d => !d.hold && !fix.rest.has(d.id));
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
    // 지금 자리에 오래 앉아 있는 사람부터 나간다 (방금 앉은 사람은 빼지 않는다)
    // 예약으로 '쉬게' 한 사람은 맨 앞에(짧게 앉았어도), '그대로'인 사람은 아예 빼지 않는다.
    // 들어올 사람이 없으면 짝이 안 지어져 그냥 일하게 되므로, 예약 때문에 공석이 생기지는 않는다
    const outQueue = occupied.filter(x => !x.t.locked && !fix.keep.has(x.d.id)
      && (fix.rest.has(x.d.id) || x.seated >= shortMs))
      .sort((a, b) => (fix.rest.has(b.d.id) - fix.rest.has(a.d.id))
        || (b.over - a.over) || b.seated - a.seated || a.t.no - b.t.no);

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
    // 피처 테이블은 짝지은 그대로, 나머지는 방금 나온 테이블을 피해서 배치
    const incoming = pairs.filter(p => !p.x.t.feature).map(p => p.n);
    for (const p of pairs) {
      moves.push(move(p.x.t, p.x.d, p.x.t.feature ? p.n : takeBest(p.x.t, incoming), 'in'));
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

    out.sort((a, b) => a.tableNo - b.tableNo);
    return {
      at: now,
      moves: out,
      toBreak,
      kept: occupied.length - out.filter(m => m.fromDealerId).length,
      warnings,
    };
  }

  // 지금 상태 그대로 간다고 가정하고 앞으로 count번의 교대를 미리 돌려본다
  function project(s, count) {
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
    for (let i = 0; i < count; i++) {
      const at = cur.clock.nextPushAt;
      const res = executePush(cur, at);
      cur = res.state;
      out.push({ at, a: snapshot(cur), plan: res.plan });
      cur.log = [];
      cur.history = cur.history.slice(-1);
    }
    return out;
  }

  // ---------- 공개 동작 ----------

  // entries: 이름 문자열 또는 {name, grade}
  function addDealers(s, entries, now, grade) {
    const n = draft(s);
    for (const raw of entries) {
      const e = typeof raw === 'object' && raw ? raw : { name: raw };
      const name = String(e.name || '').trim();
      if (!name) continue;
      n.dealers.push({
        id: `d${++n.seq}`,
        name,
        grade: e.grade || grade || 'B',
        status: 'break',
        hold: false,
        holdMs: 0,       // 이번 휴식 구간에서 보류였던 시간
        holdAt: null,    // 보류 시작 시각 (보류 중이 아니면 null)
        sessions: [{ in: now, out: null }],
        since: now,
        tableId: null,
        lastTableId: null,
        streakMs: 0,
        totalWorkMs: 0,
        totalRestMs: 0,
        totalHoldMs: 0,  // 오늘 보류였던 시간 (휴식 시간에 넣지 않는다)
        checkInAt: now,
        checkOutAt: null,
        earlyOut: false, // 퇴근 희망
        eoAsk: null,     // 디렉터가 휴대폰으로 물어본 질문 id (답 오기 전까지)
        eoStay: false,   // 물어봤더니 '계속 일할게요'
        eoAt: null,      // 마지막으로 반영한 휴대폰 답의 서버 시각
      });
      addLog(n, now, 'dealer', `${name} 출근`);
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

  function openTable(s, nos, now, opts) {
    const feature = !!(opts && opts.feature);
    const n = draft(s);
    const opened = [];
    for (const no of nos) {
      let t = n.tables.find(x => x.no === no);
      if (t && t.status === 'open') continue;
      if (!t) {
        t = { id: `t${no}`, no, status: 'open', feature, dealerId: null, openedAt: now };
        n.tables.push(t);
      } else {
        Object.assign(t, { status: 'open', feature, dealerId: null, openedAt: now });
      }
      opened.push(t);
    }
    if (opened.length) addLog(n, now, 'table', `${rangeText(opened.map(t => t.no))}번 테이블 오픈${feature ? ' (피처)' : ''}`);
    n.tables.sort(byNo);
    fillVacancies(n, now);
    const empty = opened.filter(t => !t.dealerId);
    if (empty.length) addLog(n, now, 'warn', `대기 딜러 없음 — ${empty.map(t => t.no + '번').join(', ')} 공석`);
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
    addLog(n, now, 'table', `${t.no}번 테이블 깨짐${d ? ` — ${d.name} 휴식` : ''}`);
    fillVacancies(n, now); // 공석 테이블이 있으면 바로 메움
    return n;
  }

  // 교대 시간을 기다리지 않고 해당 테이블 딜러만 즉시 교체
  function relieveTable(s, tableId, now) {
    const n = draft(s);
    const t = tableOf(n, tableId);
    if (!t || t.status !== 'open') return s;
    const pick = pickFromPool(n, now, t.feature);
    if (!pick) {
      addLog(n, now, 'warn', `${t.no}번 교체 불가 — 대기 딜러 없음`);
      return n;
    }
    const out = t.dealerId ? releaseKeep(n, dealerOf(n, t.dealerId), now) : null;
    seatMidInterval(n, pick.dealer, t, now, pick.short, out);
    return n;
  }

  function sendHome(s, dealerId, now) {
    const n = draft(s);
    const d = dealerOf(n, dealerId);
    if (!d || d.status === 'off') return s;
    if (d.status === 'working') release(n, d, now);
    endBreak(n, d, now);
    d.status = 'off';
    d.hold = false;
    d.holdMs = 0;
    d.holdAt = null;
    d.eoAsk = null;
    d.checkOutAt = now;
    const last = d.sessions[d.sessions.length - 1];
    if (last && last.out == null) last.out = now;
    addLog(n, now, 'dealer', `${d.name} 퇴근`);
    fillVacancies(n, now);
    return n;
  }

  function checkBack(s, dealerId, now) {
    const n = draft(s);
    const d = dealerOf(n, dealerId);
    if (!d || d.status !== 'off') return s;
    Object.assign(d, { status: 'break', since: now, streakMs: 0, checkOutAt: null, earlyOut: false, eoAsk: null, eoStay: false, hold: false, holdMs: 0, holdAt: null });
    d.sessions.push({ in: now, out: null });
    addLog(n, now, 'dealer', `${d.name} 복귀`);
    fillVacancies(n, now);
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
    if (!t || t.status !== 'open' || !d || d.status === 'off' || d.tableId === t.id) return s;
    const cur = t.dealerId ? dealerOf(n, t.dealerId) : null;
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
    if (!t0 || t0.status !== 'open' || !t0.dealerId || !q0 || q0.status === 'off' || q0.id === t0.dealerId) return s;
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
  //  state: 'in' 출근 중 · 'off' 왔다가 퇴근함 · 'none' 아직 안 옴
  function rosterView(s) {
    return s.roster.map(e => {
      const on = onByName(s, e.name);
      const d = on || s.dealers.find(x => x.name === e.name) || null;
      return {
        name: e.name,
        grade: (d && d.grade) || e.grade,
        id: d ? d.id : null,
        state: on ? 'in' : d ? 'off' : 'none',
      };
    });
  }

  // 명단에서 체크/해제. 체크 = 출근(처음이면 새로, 왔다 간 사람이면 복귀) · 해제 = 퇴근
  function attend(s, name, now, want) {
    const who = cleanName(name);
    if (!who) return s;
    const on = onByName(s, who);
    if (!want) return on ? sendHome(s, on.id, now) : s;
    if (on) return s;
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
    if (!d || d.status === 'off') return s;
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
      if (!cur || cur.status === 'off' || !m || typeof m.w !== 'boolean' || !m.k || m.at === cur.eoAt) continue;
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

  // 같은 시각(n번째 교대)의 두 딜러 자리를 맞바꾼다 — 한쪽이 휴식이면 휴식이 넘어간다
  function planSwap(s, n, aId, bId, now) {
    if (!s.clock.running || !okN(n) || aId === bId) return s;
    const a = livingDealer(s, aId);
    const b = livingDealer(s, bId);
    if (!a || !b) return s;
    const d = draft(s);
    d.plans = dropPlans(d.plans, n, [aId, bId]).concat([{ n, type: 'swap', a: aId, b: bId }]).slice(-PLAN_MAX);
    addLog(d, now, 'manual', `${n}번째 교대: ${a.name} ↔ ${b.name} 자리 맞바꿈`);
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
    for (const d of working(n)) d.since = now - Math.max(0, p - d.since);
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
    const plan = planPush(s, at);
    const n = draft(s);
    const outs = {};
    for (const m of plan.moves) {
      if (m.fromDealerId) outs[m.tableId] = releaseKeep(n, dealerOf(n, m.fromDealerId), at);
    }
    for (const m of plan.moves) {
      if (m.toDealerId) seat(n, dealerOf(n, m.toDealerId), tableOf(n, m.tableId), at, outs[m.tableId]);
    }

    const c = n.clock;
    if (c.running) {
      const pushMs = n.settings.pushMinutes * MIN;
      const inTime = c.nextPushAt != null && at >= c.nextPushAt && at - c.nextPushAt < pushMs;
      c.nextPushAt = gridAt((inTime ? c.nextPushAt : at) + pushMs, at); // 정시 교대는 시간 격자 유지
    }
    record(n, at);
    n.past = []; // 딜러가 이미 움직였으므로 교대 전 작업은 되돌리지 않는다
    // 이번 교대 몫 예약은 쓰고 버리고, 나머지는 한 칸씩 당긴다
    n.plans = (s.plans || []).filter(p => p.n > 1).map(p => Object.assign({}, p, { n: p.n - 1 }));
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
    const vacant = activeTables(s).filter(t => !t.dealerId).map(t => t.no);
    if (vacant.length) out.push({ level: 'danger', text: `공석 ${rangeText(vacant)}번 — 딜러 필요`, actions: [] });
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
    if (st.tables && st.active < st.tables) {
      out.push({ level: 'danger', text: `딜러 ${st.tables - st.active}명 부족 — 추가 호출 필요`, actions: [] });
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
    planPush,
    project,
    planSwap,
    planMoveRest,
    clearPlans,
    plannedIds,
    planCount,
    suggestions,
    addDealers,
    openTable,
    parseNos,
    rangeText,
    closeTable,
    relieveTable,
    sendHome,
    checkBack,
    rosterEntries,
    addRoster,
    setRoster,
    removeRoster,
    rosterView,
    attend,
    nearTime,
    editSessions,
    assignDealer,
    undoInfo,
    undoSeat,
    fixSeat,
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
    startClock,
    startClockAt,
    pauseClock,
    resumeClock,
    executePush,
  };
});
