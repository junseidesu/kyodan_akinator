// 推測エンジン（仕様書 §5）。ブラウザでも Node でも動く。
(function (global) {
  "use strict";

  const DEFAULTS = {
    epsilon: 0.1,        // 回答ミスへの保険
    pYes: 0.95,          // データ上「はい」の人が「はい」と答える確率
    pNo: 0.05,
    pUnknown: 0.5,
    guessTop: 0.95,      // 1位がこの確率以上なら推測
    guessRatio: 10,      // または 1位が2位のこの倍以上（かつ guessRatioMin 以上）
    guessRatioMin: 0.8,
    guessAfter: 20,      // この問数に達したら推測
    maxGuesses: 3,
    maxQuestions: 40,
    randomTopK: 3,       // 情報利得の上位K問からランダムに選ぶ
    customTopN: 5,       // 個別の質問は上位N人に「はい」の人がいるときだけ出す
    random: Math.random,
  };

  function entropy(ws) {
    let h = 0;
    for (const w of ws) if (w > 0) h -= w * Math.log2(w);
    return h;
  }

  class Engine {
    constructor(data, opts = {}) {
      this.opts = Object.assign({}, DEFAULTS, opts);
      this.members = data.members;
      this.questions = data.questions;
      // P[i][q] = 団員 i が質問 q に「はい」と答える確率
      this.P = this.members.map((m) => {
        const row = {};
        for (const q of this.questions) {
          const a = m.answers[q.id];
          // 1/0 はアンケートで確定、小数は「はい」の確率の見積もり（個別の質問）
          row[q.id] = a === 1 ? this.opts.pYes : a === 0 ? this.opts.pNo
            : typeof a === "number" ? a : this.opts.pUnknown;
        }
        return row;
      });
      this.reset();
    }

    reset() {
      const n = this.members.length;
      this.w = new Array(n).fill(1 / n);
      this.asked = [];        // [{qid, u}]
      this.rejected = new Set();
      this.confirmed = new Set(); // 決め手の質問を済ませた団員
      this.history = [];      // undo 用スナップショット
      this.sinceGuess = 0;
    }

    _snapshot() {
      return { w: this.w.slice(), asked: this.asked.slice(), rejected: new Set(this.rejected),
        confirmed: new Set(this.confirmed), sinceGuess: this.sinceGuess };
    }

    _normalize() {
      const s = this.w.reduce((a, b) => a + b, 0);
      if (s > 0) this.w = this.w.map((x) => x / s);
    }

    likelihood(i, qid, u) {
      const p = this.P[i][qid];
      const e = this.opts.epsilon;
      return e * 0.5 + (1 - e) * (u * p + (1 - u) * (1 - p));
    }

    /** u: 1 / 0.75 / null(わからない) / 0.25 / 0 */
    answer(qid, u) {
      this.history.push(this._snapshot());
      this.asked.push({ qid, u });
      this.sinceGuess++;
      if (u === null || u === undefined) return;
      this.w = this.w.map((w, i) => w * this.likelihood(i, qid, u));
      this._normalize();
    }

    canUndo() { return this.history.length > 0; }

    undo() {
      const s = this.history.pop();
      if (!s) return null;
      const last = this.asked[this.asked.length - 1];
      Object.assign(this, s);
      return last;
    }

    infoGain(qid) {
      let pYes = 0;
      const yes = [], no = [];
      for (let i = 0; i < this.w.length; i++) {
        const p = this.P[i][qid];
        pYes += this.w[i] * p;
        yes.push(this.w[i] * p);
        no.push(this.w[i] * (1 - p));
      }
      if (pYes <= 0 || pYes >= 1) return 0;
      const hYes = entropy(yes.map((x) => x / pYes));
      const hNo = entropy(no.map((x) => x / (1 - pYes)));
      return entropy(this.w) - (pYes * hYes + (1 - pYes) * hNo);
    }

    /** 個別の質問は、上位の候補に「はい」の人がいるときだけ出す（仕様書 §4.2） */
    _customAllowed(q, top) {
      return top.some((i) => this.P[i][q.id] >= this.opts.pYes);
    }

    nextQuestion() {
      const askedIds = new Set(this.asked.map((a) => a.qid));
      const top = this.ranking().slice(0, this.opts.customTopN).filter((r) => r.p > 0).map((r) => r.index);
      const scored = this.questions
        .filter((q) => !askedIds.has(q.id))
        .filter((q) => !q.custom || this._customAllowed(q, top))
        .map((q) => ({ q, g: this.infoGain(q.id) }))
        .filter((x) => x.g > 1e-3)
        .sort((a, b) => b.g - a.g);
      if (!scored.length) return null;
      const k = Math.min(this.opts.randomTopK, scored.length);
      // 上位ほど選ばれやすい重み付きランダム
      const weights = scored.slice(0, k).map((x) => x.g);
      let r = this.opts.random() * weights.reduce((a, b) => a + b, 0);
      for (let j = 0; j < k; j++) {
        r -= weights[j];
        if (r <= 0) return scored[j].q;
      }
      return scored[0].q;
    }

    ranking() {
      return this.w
        .map((w, i) => ({ member: this.members[i], index: i, p: w }))
        .sort((a, b) => b.p - a.p);
    }

    shouldGuess() {
      const [a, b] = this.ranking();
      if (!a || a.p === 0) return false;
      if (a.p >= this.opts.guessTop) return true;
      if (a.p >= this.opts.guessRatioMin && (!b || a.p >= this.opts.guessRatio * b.p)) return true;
      if (this.sinceGuess >= this.opts.guessAfter) return true;
      return this.nextQuestion() === null;
    }

    bestGuess() { return this.ranking()[0].member; }

    /** 推測の直前に、1位の人の個別の質問で「決め手」を確かめる（1人につき1回） */
    confirmQuestion() {
      const top = this.ranking()[0];
      if (!top || this.confirmed.has(top.member.id)) return null;
      this.confirmed.add(top.member.id);
      const askedIds = new Set(this.asked.map((a) => a.qid));
      const cands = this.questions.filter((q) => q.custom && !askedIds.has(q.id)
        && this.P[top.index][q.id] >= this.opts.pYes);
      return cands.length ? cands[Math.floor(this.opts.random() * cands.length)] : null;
    }

    /** 次にすること: {type:"question", q, confirm?} | {type:"guess", member} | {type:"over"} */
    decide() {
      if (this.isGameOver()) return { type: "over" };
      if (this.shouldGuess()) {
        const q = this.confirmQuestion();
        if (q) return { type: "question", q, confirm: true };
        return { type: "guess", member: this.bestGuess() };
      }
      const q = this.nextQuestion();
      return q ? { type: "question", q } : { type: "guess", member: this.bestGuess() };
    }

    /** 推測が外れた */
    reject(member) {
      this.history = []; // 推測より前には戻れない
      const i = this.members.indexOf(member);
      this.rejected.add(member.id);
      this.w[i] = 0;
      this.sinceGuess = 0;
      this._normalize();
    }

    get questionCount() { return this.asked.length; }

    isGameOver() {
      return this.rejected.size >= this.opts.maxGuesses || this.asked.length >= this.opts.maxQuestions
        || this.w.every((x) => x === 0);
    }
  }

  global.AkinatorEngine = Engine;
  if (typeof module !== "undefined") module.exports = Engine;
})(typeof window !== "undefined" ? window : globalThis);
