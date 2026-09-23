(function () {
  "use strict";

  const CFG = window.AKINATOR_CONFIG;
  const DATA = window.AKINATOR_DATA;
  const engine = new window.AkinatorEngine(DATA);

  const PART_ORDER = ["ソプラノ", "メソップ", "アルト", "トップ", "セカンド", "バリトン", "ベース"];
  const EPISODES_SHOWN = 3;

  const $ = (sel, root = document) => root.querySelector(sel);
  const panel = $("#panel");
  const bubble = $("#bubble");
  const maestro = $("#maestro");
  const qcount = $("#qcount");

  let current = null;   // 表示中の質問
  let guessed = null;   // 表示中の推測

  document.title = CFG.appName;
  $("#brand").textContent = CFG.appName;

  // ---------------------------------------------------------------- helpers

  function render(tplId) {
    panel.replaceChildren($(tplId).content.cloneNode(true));
    panel.classList.remove("enter");
    void panel.offsetWidth;
    panel.classList.add("enter");
    return panel;
  }

  function say(text, mood) {
    bubble.textContent = text || "";
    if (mood) maestro.dataset.mood = mood;
  }

  function fmt(s, vars) {
    return s.replace(/\{(\w+)\}/g, (_, k) => vars[k]);
  }

  function pick(arr) { return arr[Math.floor(Math.random() * arr.length)]; }

  function shuffle(arr) {
    const a = arr.slice();
    for (let i = a.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [a[i], a[j]] = [a[j], a[i]];
    }
    return a;
  }

  function setCount() {
    qcount.textContent = engine.questionCount ? `質問 ${engine.questionCount}` : "";
  }

  function subline(m) {
    return [m.part, m.yearLabel].filter(Boolean).join("・");
  }

  // ---------------------------------------------------------------- 画面

  function showTitle() {
    engine.reset();
    setCount();
    const p = render("#tpl-title");
    $("[data-tagline]", p).textContent = CFG.tagline;
    $("[data-count]", p).textContent = `団員 ${DATA.members.length} 人の中から当てます`;
    say(CFG.lines.start, "idle");
    $("[data-action=start]", p).onclick = next;
  }

  function next() {
    const d = engine.decide();
    if (d.type === "over") return showGiveup();
    if (d.type === "guess") return showGuess();
    current = d.q;
    showQuestion(d.confirm);
  }

  function showQuestion(confirm) {
    const p = render("#tpl-question");
    qcount.textContent = `質問 ${engine.asked.length + 1}`;
    $("[data-question]", p).textContent = current.text;
    $("[data-meter]", p).style.width = `${Math.round(engine.ranking()[0].p * 100)}%`;
    if (confirm) say(pick(CFG.lines.confirm), "idea");
    else say(engine.asked.length ? pick(CFG.lines.thinking) : CFG.lines.start, "think");
    p.querySelectorAll("[data-u]").forEach((b) => {
      b.onclick = () => {
        const raw = b.dataset.u;
        engine.answer(current.id, raw === "null" ? null : Number(raw));
        next();
      };
    });
    const undo = $("[data-action=undo]", p);
    undo.disabled = !engine.canUndo();
    undo.onclick = () => {
      const last = engine.undo();
      if (!last) return;
      current = DATA.questions.find((q) => q.id === last.qid);
      showQuestion();
    };
  }

  function showGuess() {
    guessed = engine.bestGuess();
    setCount();
    const p = render("#tpl-guess");
    $("[data-part]", p).textContent = guessed.part;
    $("[data-name]", p).textContent = guessed.name;
    $("[data-sub]", p).textContent = [guessed.yearLabel, guessed.facultyRaw].filter(Boolean).join("・");
    say(CFG.lines.guess, "idea");
    $("[data-action=correct]", p).onclick = () => showProfile(guessed, true);
    $("[data-action=wrong]", p).onclick = () => {
      engine.reject(guessed);
      if (engine.isGameOver()) return showGiveup();
      say(CFG.lines.wrong, "sad");
      setTimeout(next, 900);
    };
  }

  function showProfile(m, won) {
    setCount();
    const p = render("#tpl-profile");
    $("[data-part]", p).textContent = m.part;
    $("[data-name]", p).textContent = m.name;

    const facts = [
      ["回生", m.yearLabel],
      ["出身", m.prefRaw],
      ["学部", m.facultyRaw],
      ["好きな勉強", m.study],
      ["普段は", m.eyes],
      ["住まい", m.living],
      ["やるなら", m.ml === "M" ? "M会・専門職" : m.ml === "L" ? "L会" : ""],
    ].filter(([, v]) => v);
    const dl = $("[data-facts]", p);
    for (const [k, v] of facts) {
      const dt = document.createElement("dt"); dt.textContent = k;
      const dd = document.createElement("dd"); dd.textContent = v;
      dl.append(dt, dd);
    }

    const eps = shuffle(m.episodes);
    const ul = $("[data-episodes]", p);
    const more = $("[data-action=more]", p);
    const fill = (n) => {
      ul.replaceChildren(...eps.slice(0, n).map((e) => {
        const li = document.createElement("li"); li.textContent = e; return li;
      }));
      more.hidden = eps.length <= n;
    };
    fill(EPISODES_SHOWN);
    more.onclick = () => fill(eps.length);

    if (won) say(fmt(CFG.lines.correct, { n: engine.asked.length }), "proud");
    else say(fmt(CFG.lines.reveal, { name: m.name }), "sad");
    $("[data-action=restart]", p).onclick = showTitle;
  }

  function showGiveup() {
    setCount();
    const p = render("#tpl-giveup");
    say(CFG.lines.giveup, "sad");
    const roster = $("[data-roster]", p);
    const search = $("[data-search]", p);

    const draw = () => {
      const q = search.value.trim().toLowerCase();
      const groups = PART_ORDER.map((part) => ({
        part,
        list: DATA.members.filter((m) => m.part === part && (!q || m.name.toLowerCase().includes(q))),
      })).filter((g) => g.list.length);
      if (!groups.length) {
        roster.innerHTML = '<p class="empty">見つかりません</p>';
        return;
      }
      roster.replaceChildren(...groups.map((g) => {
        const sec = document.createElement("section");
        const h = document.createElement("h3"); h.textContent = g.part;
        const names = document.createElement("div"); names.className = "names";
        for (const m of g.list) {
          const b = document.createElement("button");
          b.className = "btn"; b.textContent = m.name;
          b.onclick = () => showProfile(m, false);
          names.append(b);
        }
        sec.append(h, names);
        return sec;
      }));
    };
    search.oninput = draw;
    draw();
    $("[data-action=restart]", p).onclick = showTitle;
  }

  showTitle();
})();
