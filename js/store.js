/* 상태 저장소: localStorage 영속화 + 스냅샷 기반 되돌리기/다시실행 */
const Store = (() => {
  const KEY = 'holdem-td.v1';
  const MAX_HISTORY = 50;
  const listeners = [];
  let past = [], future = [];

  const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
  const clone = (o) => JSON.parse(JSON.stringify(o));

  function defaultTemplates() {
    return {
      confirm: {
        title: '참가 확인증', subtitle: '', logoText: '', paper: '80mm',
        showBuyIn: true, showPhone: false, showTime: true, showEntryNo: true,
        footer: '본 확인증을 딜러에게 제시해 주세요.'
      },
      voucher: {
        title: '상금 바우처', subtitle: '', logoText: '', paper: 'A5',
        showRank: true, showSerial: true, showSignature: true, showBuyIn: false,
        footer: '본 바우처는 발행일로부터 7일간 유효하며, 신분증과 함께 제시해야 합니다.'
      }
    };
  }

  /** 설정 탭 기본값 (현장 공통). 이벤트별 설정은 event 객체에 있다 */
  function defaultSettings() {
    return {
      // 레지
      autoPrintOnRegister: true, regPhone: 'show', regMemo: true, dupWarn: true, seatPickAllowed: true, seatMode: 'random',
      // 테이블
      defaultSeats: 9, autoOpenTable: true, balanceDiff: 2, breakHint: true, askKO: true, prizeSheet: true,
      // 클락
      levelBeep: true, warnBeforeMin: 0, boardAvg: true, boardPool: true, boardFirst: true, boardBreak: true,
      // 딜러
      pushBeep: true,
    };
  }

  function defaultState() {
    return {
      selectedEventId: null,
      events: [], players: [], tables: [], vouchers: [],
      settings: defaultSettings(),
      templates: defaultTemplates(),
    };
  }

  function load() {
    try {
      const raw = localStorage.getItem(KEY);
      if (!raw) return defaultState();
      const s = Object.assign(defaultState(), JSON.parse(raw));
      s.templates = Object.assign(defaultTemplates(), s.templates || {});
      s.templates.confirm = Object.assign(defaultTemplates().confirm, s.templates.confirm);
      s.templates.voucher = Object.assign(defaultTemplates().voucher, s.templates.voucher);
      return migrate(s);
    } catch (e) { console.warn('load fail', e); return defaultState(); }
  }

  /** 예전 데이터 보정: 새 설정 기본값 채우기, 없앤 '테이블 사용 설정'(disabledTables) 지우기 */
  function migrate(s) {
    s.settings = Object.assign(defaultSettings(), s.settings || {});
    (s.events || []).forEach(e => { delete e.disabledTables; });
    return s;
  }

  let state = load();

  function save() { try { localStorage.setItem(KEY, JSON.stringify(state)); } catch (e) { console.warn(e); } }
  function emit() { listeners.forEach(fn => fn(state)); }
  function subscribe(fn) { listeners.push(fn); }

  /** 변경은 반드시 commit 을 통해서. label 은 되돌리기 안내용 */
  function commit(label, fn) {
    const snap = clone(state);
    const result = fn(state);
    if (result === false) return false;         // 취소
    if (typeof Floor !== 'undefined') Floor.sync(state); // 열리고 닫힌 테이블을 딜러 엔진(DD)에 반영 → 딜러 자동 배치
    past.push({ label, snap });
    if (past.length > MAX_HISTORY) past.shift();
    future = [];
    save(); emit();
    return result === undefined ? true : result;
  }
  /** 히스토리에 남기지 않는 사소한 변경(설정, 템플릿 편집, 선택 이벤트) */
  function patch(fn) { fn(state); save(); emit(); }

  function undo() {
    const h = past.pop(); if (!h) return null;
    future.push({ label: h.label, snap: clone(state) });
    state = h.snap; save(); emit(); return h.label;
  }
  function redo() {
    const h = future.pop(); if (!h) return null;
    past.push({ label: h.label, snap: clone(state) });
    state = h.snap; save(); emit(); return h.label;
  }
  const canUndo = () => past.length > 0, canRedo = () => future.length > 0;
  const undoLabel = () => past.length ? past[past.length - 1].label : '';
  const redoLabel = () => future.length ? future[future.length - 1].label : '';

  function exportJSON() { return JSON.stringify(state, null, 2); }
  function importJSON(text) {
    const s = JSON.parse(text);
    if (!s || !Array.isArray(s.events)) throw new Error('형식이 올바르지 않습니다');
    past.push({ label: '데이터 가져오기', snap: clone(state) }); future = [];
    state = migrate(Object.assign(defaultState(), s)); save(); emit();
  }
  function reset() { past.push({ label: '전체 초기화', snap: clone(state) }); future = []; state = defaultState(); save(); emit(); }

  return { defaultSettings, get: () => state, commit, patch, undo, redo, canUndo, canRedo, undoLabel, redoLabel, subscribe, uid, clone, exportJSON, importJSON, reset };
})();
