(() => {
  "use strict";

  const STORAGE_KEY = "dersSaati.v1";
  const DEFAULTS = {
    study: 25,
    break: 5,
    longBreak: 15,
    rounds: 4,
    goal: 120,
    autoBreak: true,
    autoStudy: false,
    sound: true,
    notify: false,
    theme: null
  };

  const THEMES = {
    midnight: { name: "Gece", accent: "#8b7cff", accent2: "#4fd1c5", bg: "#0b0e1a", card: "#171c30" },
    ocean: { name: "Okyanus", accent: "#38bdf8", accent2: "#2dd4bf", bg: "#061824", card: "#0c2634" },
    forest: { name: "Orman", accent: "#4ade80", accent2: "#a3e635", bg: "#08170f", card: "#12261b" },
    sunset: { name: "Gün Batımı", accent: "#fb7185", accent2: "#fbbf24", bg: "#190b14", card: "#2a1420" },
    lavender: { name: "Lavanta", accent: "#c084fc", accent2: "#f0abfc", bg: "#120b20", card: "#1e1533" },
    neon: { name: "Neon", accent: "#22d3ee", accent2: "#a3e635", bg: "#050912", card: "#0c1526" }
  };

  const PATTERNS = [
    { id: "none", name: "Düz" },
    { id: "dots", name: "Noktalar" },
    { id: "grid", name: "Izgara" },
    { id: "diagonal", name: "Çapraz" },
    { id: "waves", name: "Dalgalar" },
    { id: "stars", name: "Yıldızlar" }
  ];

  const HEX_RE = /^#[0-9a-f]{6}$/i;
  const RING_C = 2 * Math.PI * 116;
  const SCORE_C = 2 * Math.PI * 52;
  const $ = (id) => document.getElementById(id);

  let db;
  let timer;
  let renderedDayKey = dayKey(new Date());
  let hiddenMark = null;
  let tickCount = 0;
  let toastTimer = null;
  let audioCtx = null;
  let lastFinishKey = 0;
  let activeTab = "focus";
  let planFilter = "all";
  let calendarYear = new Date().getFullYear();
  let calendarMonth = new Date().getMonth();
  let calendarSelected = dayKey(new Date());

  /* ---------------- helpers ---------------- */

  function clamp(n, min, max) {
    return Math.min(max, Math.max(min, n));
  }

  function pad(n) {
    return String(n).padStart(2, "0");
  }

  function dayKey(d) {
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  }

  function uid() {
    if (window.crypto && crypto.randomUUID) return crypto.randomUUID();
    return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
  }

  function fmtClock(totalSec, withHours) {
    const sec = Math.max(0, Math.ceil(totalSec));
    const h = Math.floor(sec / 3600);
    const m = Math.floor((sec % 3600) / 60);
    const s = sec % 60;
    if (withHours || h > 0) return `${h}:${pad(m)}:${pad(s)}`;
    return `${pad(m)}:${pad(s)}`;
  }

  function fmtMin(sec) {
    return `${Math.round(sec / 60)} dk`;
  }

  function pct(ratio) {
    return `${Math.round(clamp(ratio, 0, 1) * 100)}%`;
  }

  function defaultTheme() {
    return {
      preset: "midnight",
      accent: THEMES.midnight.accent,
      accent2: THEMES.midnight.accent2,
      bg: THEMES.midnight.bg,
      card: THEMES.midnight.card,
      pattern: "none"
    };
  }

  function normalizeTheme(raw) {
    const base = defaultTheme();
    if (!raw || typeof raw !== "object") return base;

    const pattern = PATTERNS.some((p) => p.id === raw.pattern) ? raw.pattern : "none";
    if (raw.preset && THEMES[raw.preset]) {
      const p = THEMES[raw.preset];
      return { preset: raw.preset, accent: p.accent, accent2: p.accent2, bg: p.bg, card: p.card, pattern };
    }

    return {
      preset: "custom",
      accent: HEX_RE.test(raw.accent) ? raw.accent : base.accent,
      accent2: HEX_RE.test(raw.accent2) ? raw.accent2 : base.accent2,
      bg: HEX_RE.test(raw.bg) ? raw.bg : base.bg,
      card: HEX_RE.test(raw.card) ? raw.card : base.card,
      pattern
    };
  }

  function hexToRgba(hex, alpha) {
    const value = hex.replace("#", "");
    const num = parseInt(value, 16);
    const r = (num >> 16) & 255;
    const g = (num >> 8) & 255;
    const b = num & 255;
    return `rgba(${r}, ${g}, ${b}, ${alpha})`;
  }

  function luminance(hex) {
    const num = parseInt(hex.replace("#", ""), 16);
    const channels = [(num >> 16) & 255, (num >> 8) & 255, num & 255].map((v) => {
      const c = v / 255;
      return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
    });
    return 0.2126 * channels[0] + 0.7152 * channels[1] + 0.0722 * channels[2];
  }

  /* ---------------- storage ---------------- */

  function freshDB() {
    return {
      version: 1,
      settings: { ...DEFAULTS, theme: defaultTheme() },
      days: {},
      timer: null
    };
  }

  function loadDB() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return freshDB();
      const parsed = JSON.parse(raw);
      if (!parsed || typeof parsed !== "object") return freshDB();
      const data = freshDB();
      if (parsed.settings) {
        for (const key of Object.keys(DEFAULTS)) {
          if (typeof parsed.settings[key] === typeof DEFAULTS[key]) {
            data.settings[key] = parsed.settings[key];
          }
        }
      }
      data.settings.theme = normalizeTheme(parsed.settings ? parsed.settings.theme : null);
      if (parsed.days && typeof parsed.days === "object") data.days = parsed.days;
      if (parsed.timer && typeof parsed.timer === "object") data.timer = parsed.timer;
      return data;
    } catch (err) {
      return freshDB();
    }
  }

  function save() {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(db));
    } catch (err) {
      /* storage full or blocked */
    }
  }

  function getDay(date = new Date()) {
    const key = dayKey(date);
    let day = db.days[key];
    if (!day || typeof day !== "object") {
      day = {
        plan: [],
        studyMin: 0,
        breakMin: 0,
        sessions: 0,
        breaksTaken: 0,
        distractionSec: 0,
        goal: db.settings.goal,
        log: []
      };
      db.days[key] = day;
    }
    if (!Array.isArray(day.plan)) day.plan = [];
    if (!Array.isArray(day.log)) day.log = [];
    for (const field of ["studyMin", "breakMin", "sessions", "breaksTaken", "distractionSec", "goal"]) {
      if (typeof day[field] !== "number" || !isFinite(day[field])) {
        day[field] = field === "goal" ? db.settings.goal : 0;
      }
    }
    day.plan = day.plan
      .filter((t) => t && typeof t === "object")
      .map((t) => ({
        id: typeof t.id === "string" && t.id ? t.id : uid(),
        text: String(t.text || "Görev"),
        subject: String(t.subject || ""),
        minutes: clamp(Number(t.minutes) || 30, 5, 480),
        spent: Math.max(0, Number(t.spent) || 0),
        done: !!t.done
      }));
    return day;
  }

  /* ---------------- timer ---------------- */

  function makeTimer(mode = "study") {
    const minutes = phaseMinutes(mode, false);
    return {
      mode,
      totalMs: minutes * 60000,
      remainingMs: minutes * 60000,
      endAt: 0,
      running: false,
      startedAt: 0,
      nextLong: false,
      activeTaskId: null,
      sessionDistraction: 0
    };
  }

  function phaseMinutes(mode, nextLong) {
    if (mode === "study") return db.settings.study;
    return nextLong ? db.settings.longBreak : db.settings.break;
  }

  function resetPhase(mode, nextLong) {
    const minutes = phaseMinutes(mode, nextLong);
    timer.mode = mode;
    timer.nextLong = !!nextLong;
    timer.totalMs = minutes * 60000;
    timer.remainingMs = minutes * 60000;
    timer.endAt = 0;
    timer.running = false;
    timer.startedAt = 0;
    timer.sessionDistraction = 0;
  }

  function startTimer() {
    if (timer.running) return;
    if (timer.remainingMs <= 0) {
      timer.totalMs = phaseMinutes(timer.mode, timer.nextLong) * 60000;
      timer.remainingMs = timer.totalMs;
    }
    ensureAudio();
    timer.endAt = Date.now() + timer.remainingMs;
    if (!timer.startedAt) timer.startedAt = Date.now();
    timer.running = true;
    save();
    renderAll();
  }

  function pauseTimer() {
    if (!timer.running) return;
    timer.remainingMs = Math.max(0, timer.endAt - Date.now());
    timer.endAt = 0;
    timer.running = false;
    save();
    renderAll();
  }

  function toggleTimer() {
    if (timer.running) pauseTimer();
    else startTimer();
  }

  function resetTimer(silent) {
    resetPhase(timer.mode, timer.mode === "break" ? timer.nextLong : false);
    save();
    renderAll();
    if (!silent) showToast("Sayaç sıfırlandı.");
  }

  function switchPhase(mode, autostart) {
    resetPhase(mode, mode === "break" ? timer.nextLong : false);
    if (autostart) startTimer();
    save();
    renderAll();
  }

  function usePreset(study, brk, long) {
    db.settings.study = study;
    db.settings.break = brk;
    db.settings.longBreak = long;
    const day = getDay();
    day.goal = db.settings.goal;
    if (!timer.running) {
      const nextLong = timer.mode === "break" ? timer.nextLong : false;
      resetPhase(timer.mode, nextLong);
    }
    save();
    renderAll();
    showToast(`${study} dk ders / ${brk} dk mola seçildi.`);
  }

  function tick() {
    tickCount++;
    if (tickCount % 8 === 0) checkDayChange();
    if (!timer.running) return;

    syncHidden(Date.now());

    const remaining = timer.endAt - Date.now();
    if (remaining <= 0) {
      timer.remainingMs = 0;
      finishPhase();
    } else {
      timer.remainingMs = remaining;
      renderClock();
    }
  }

  function finishPhase() {
    const now = Date.now();
    if (now - lastFinishKey < 800) return;
    lastFinishKey = now;

    syncHidden(now);
    timer.running = false;
    timer.endAt = 0;

    const finishedMode = timer.mode;
    const minutes = Math.max(1, Math.round(timer.totalMs / 60000));
    const day = getDay();
    let message;
    let title;
    let body;

    if (finishedMode === "study") {
      day.studyMin += minutes;
      day.sessions += 1;
      day.log.push({
        at: now,
        minutes,
        distraction: Math.round(timer.sessionDistraction || 0)
      });
      const task = day.plan.find((t) => t.id === timer.activeTaskId);
      if (task) {
        task.spent = (task.spent || 0) + minutes;
        if (task.spent >= task.minutes) task.done = true;
      }
      timer.sessionDistraction = 0;

      const isLong = day.sessions % db.settings.rounds === 0;
      timer.nextLong = isLong;
      const breakMinutes = isLong ? db.settings.longBreak : db.settings.break;
      message = `Ders tamamlandı: ${minutes} dk. ${isLong ? "Uzun mola" : "Mola"} ${breakMinutes} dk.`;
      title = "Ders tamamlandı 🎉";
      body = `${minutes} dakika çalıştın. ${isLong ? "Uzun mola" : "Mola"} zamanı: ${breakMinutes} dk.`;
      chime("study");
      notify(title, body);
      switchPhase("break", db.settings.autoBreak);
    } else {
      day.breakMin += minutes;
      day.breaksTaken += 1;
      timer.nextLong = false;
      message = `Mola bitti. Ders için ${db.settings.study} dk hazır!`;
      title = "Mola bitti ☕";
      body = "Enerjini topladın. Yeni ders oturumuna başlayabilirsin.";
      chime("break");
      notify(title, body);
      switchPhase("study", db.settings.autoStudy);
    }

    save();
    renderAll();
    showToast(message);
  }

  function skipPhase() {
    const finishedMode = timer.mode;
    timer.running = false;
    timer.endAt = 0;
    const next = finishedMode === "study" ? "break" : "study";
    if (next === "break") {
      const day = getDay();
      timer.nextLong = day.sessions > 0 && day.sessions % db.settings.rounds === 0;
    } else {
      timer.nextLong = false;
    }
    resetPhase(next, timer.nextLong);
    save();
    renderAll();
    showToast("Aşama atlandı. Bu süre kaydedilmedi.");
  }

  /* ---------------- distraction tracking ---------------- */

  function syncHidden(now) {
    if (hiddenMark === null) return;
    const delta = Math.min(now - hiddenMark, 120000) / 1000;
    hiddenMark = now;
    if (!timer.running || timer.mode !== "study") return;

    const day = getDay();
    day.distractionSec += delta;
    timer.sessionDistraction = (timer.sessionDistraction || 0) + delta;
  }

  /* ---------------- audio & notifications ---------------- */

  function ensureAudio() {
    if (!db.settings.sound) return;
    if (!audioCtx) {
      const Ctx = window.AudioContext || window.webkitAudioContext;
      if (!Ctx) return;
      try {
        audioCtx = new Ctx();
      } catch (err) {
        return;
      }
    }
    if (audioCtx.state === "suspended") audioCtx.resume().catch(() => {});
  }

  function chime(kind) {
    if (!db.settings.sound) return;
    ensureAudio();
    if (!audioCtx) return;
    const notes = kind === "study" ? [523.25, 659.25, 783.99, 1046.5] : [783.99, 659.25, 523.25];
    const start = audioCtx.currentTime + 0.03;
    notes.forEach((freq, i) => {
      const at = start + i * 0.16;
      const osc = audioCtx.createOscillator();
      const gain = audioCtx.createGain();
      osc.type = "sine";
      osc.frequency.value = freq;
      gain.gain.setValueAtTime(0.0001, at);
      gain.gain.exponentialRampToValueAtTime(0.16, at + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.0001, at + 0.48);
      osc.connect(gain).connect(audioCtx.destination);
      osc.start(at);
      osc.stop(at + 0.5);
    });
  }

  function notify(title, body) {
    if (!db.settings.notify) return;
    if (!("Notification" in window) || Notification.permission !== "granted") return;
    try {
      new Notification(title, { body });
    } catch (err) {
      /* ignore */
    }
  }

  /* ---------------- toast ---------------- */

  function showToast(text) {
    const toast = $("toast");
    toast.textContent = text;
    toast.classList.add("show");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => toast.classList.remove("show"), 3200);
  }

  /* ---------------- plan ---------------- */

  function addTask(text, subject, minutes) {
    const day = getDay();
    const id = uid();
    const task = {
      id,
      text,
      subject,
      minutes: clamp(Math.round(minutes), 5, 480),
      spent: 0,
      done: false
    };
    day.plan.push(task);
    if (!timer.activeTaskId) timer.activeTaskId = id;
    save();
    renderAll();
    showToast("Görev eklendi. Sayaç bitince süre bu göreve işlenir.");
  }

  function toggleTask(id) {
    const day = getDay();
    const task = day.plan.find((t) => t.id === id);
    if (!task) return;
    task.done = !task.done;
    save();
    renderAll();
  }

  function removeTask(id) {
    const day = getDay();
    day.plan = day.plan.filter((t) => t.id !== id);
    if (timer.activeTaskId === id) {
      timer.activeTaskId = day.plan[0] ? day.plan[0].id : null;
    }
    save();
    renderAll();
  }

  function selectTask(id) {
    timer.activeTaskId = timer.activeTaskId === id ? null : id;
    save();
    renderAll();
    const day = getDay();
    const task = day.plan.find((t) => t.id === id);
    if (timer.activeTaskId && task) {
      showToast(`Odak görevi: ${task.text}`);
    }
  }

  /* ---------------- stats ---------------- */

  function computeStats(day = getDay()) {
    const plan = Array.isArray(day.plan) ? day.plan : [];
    const studyMin = Number(day.studyMin) || 0;
    const breakMin = Number(day.breakMin) || 0;
    const distractionSec = Number(day.distractionSec) || 0;
    const sessions = Number(day.sessions) || 0;
    const goal = day.goal || db.settings.goal;

    const studySec = studyMin * 60;
    const focusQuality = studySec > 0 ? clamp(studySec / (studySec + distractionSec), 0, 1) : 0;
    const goalRatio = clamp(studyMin / goal, 0, 1);

    const planned = plan.reduce((sum, t) => sum + (t.minutes || 0), 0);
    const plannedDone = plan.reduce((sum, t) => sum + (t.done ? t.minutes || 0 : 0), 0);
    const hasPlan = planned > 0;
    const planRatio = hasPlan ? clamp(plannedDone / planned, 0, 1) : 0;

    const rounds = Math.max(2, db.settings.rounds);
    const longBreaks = Math.floor(sessions / rounds);
    const allowedBreak =
      Math.max(sessions, 1) * db.settings.break +
      longBreaks * Math.max(0, db.settings.longBreak - db.settings.break);
    let breakDiscipline = 0;
    if (studyMin > 0) {
      breakDiscipline = breakMin <= allowedBreak
        ? 1
        : clamp(allowedBreak / Math.max(breakMin, 1), 0, 1);
    }

    const effectivePlan = hasPlan ? planRatio : goalRatio;
    const score = Math.round(
      100 * (0.4 * goalRatio + 0.3 * focusQuality + 0.2 * effectivePlan + 0.1 * breakDiscipline)
    );

    return {
      day,
      goal,
      goalRatio,
      focusQuality,
      hasPlan,
      planRatio,
      breakDiscipline,
      score: clamp(score, 0, 100)
    };
  }

  function scoreLabel(score, studyMin) {
    if (studyMin <= 0) {
      return { badge: "Başlamadı", label: "Henüz başlamadın", hint: "Ders çalışmaya başlayınca puanın oluşur." };
    }
    if (score >= 85) return { badge: "Mükemmel", label: "Mükemmel gidiyorsun", hint: "Bu tempoyu koru, hedefin çok yakın." };
    if (score >= 70) return { badge: "Çok iyi", label: "Çok iyi", hint: "Küçük bir odak artışıyla mükemmel olur." };
    if (score >= 50) return { badge: "İyi", label: "İyi gidiyorsun", hint: "Molaları kısaltıp hedefe biraz daha yaklaş." };
    if (score >= 30) return { badge: "Orta", label: "Toparlanabilirsin", hint: "Sekmeyi değiştirmeden 25 dk odaklanmayı dene." };
    return { badge: "Düşük", label: "Zor bir gün", hint: "10 dakikalık küçük bir başlangıç iyi gelir." };
  }

  function calcStreak() {
    const hit = (rec) => rec && rec.studyMin >= Math.max(10, (rec.goal || db.settings.goal) * 0.5);
    const cursor = new Date();
    let streak = 0;
    if (!hit(db.days[dayKey(cursor)])) cursor.setDate(cursor.getDate() - 1);
    for (let i = 0; i < 365; i++) {
      if (hit(db.days[dayKey(cursor)])) {
        streak++;
        cursor.setDate(cursor.getDate() - 1);
      } else {
        break;
      }
    }
    return streak;
  }

  /* ---------------- rendering ---------------- */

  function renderAll() {
    document.body.dataset.mode = timer.mode;
    renderDate();
    renderClock();
    renderMode();
    renderPresets();
    renderPlan();
    renderStats();
    if (activeTab === "calendar") {
      renderCalendar();
      renderDayDetail();
    }
  }

  function renderDate() {
    const now = new Date();
    const label = now.toLocaleDateString("tr-TR", {
      weekday: "long",
      day: "numeric",
      month: "long",
      year: "numeric"
    });
    $("todayLabel").textContent = label;
  }

  function renderClock() {
    const totalMs = Math.max(timer.totalMs, 1);
    const remainingMs = timer.running
      ? Math.max(0, timer.endAt - Date.now())
      : Math.max(0, timer.remainingMs);
    const remainSec = remainingMs / 1000;
    const totalSec = totalMs / 1000;

    $("timeText").textContent = fmtClock(remainSec, totalSec >= 3600);
    document.title = `${fmtClock(remainSec, totalSec >= 3600)} · ${timer.mode === "study" ? "Ders" : "Mola"} — Ders Saati`;

    const progress = clamp(1 - remainingMs / totalMs, 0, 1);
    $("ringFg").style.strokeDashoffset = String(RING_C * progress);

    const hint = $("hint");
    if (timer.mode === "study" && timer.sessionDistraction >= 5) {
      hint.textContent = `⚠️ Bu oturumda ${Math.round(timer.sessionDistraction)} sn odak dışı kaldın. Sekmeye geri dön!`;
      hint.classList.add("alert");
    } else if (timer.mode === "study" && timer.running) {
      hint.textContent = "Odaklan: sekmeyi değiştirme, telefonu uzağa koy. Süre bitince mola otomatik başlar.";
      hint.classList.remove("alert");
    } else if (timer.mode === "break") {
      hint.textContent = "Mola zamanı: gözlerini dinlendir, su iç. Molayı uzatma, derse dönmek için hazır ol.";
      hint.classList.remove("alert");
    } else {
      hint.textContent = "İpucu: Görev seç, sonra Başlat’a bas. Ders bitince süre seçili göreve işlenir.";
      hint.classList.remove("alert");
    }
  }

  function renderMode() {
    document.querySelectorAll(".mode-btn").forEach((btn) => {
      btn.classList.toggle("active", btn.dataset.mode === timer.mode);
    });

    const startBtn = $("startBtn");
    startBtn.classList.toggle("running", timer.running);
    $("startIcon").textContent = timer.running ? "⏸" : "▶";
    $("startText").textContent = timer.running ? "Duraklat" : "Başlat";

    if (timer.mode === "study") {
      $("modeLabel").textContent = "Ders zamanı";
    } else {
      $("modeLabel").textContent = timer.nextLong ? "Uzun mola" : "Mola zamanı";
    }

    const day = getDay();
    const rounds = Math.max(2, db.settings.rounds);
    let filled = day.sessions % rounds;
    if (day.sessions > 0 && filled === 0) {
      filled = timer.mode === "break" && timer.nextLong ? rounds : 0;
    }

    const dots = $("sessionDots");
    dots.innerHTML = "";
    for (let i = 0; i < rounds; i++) {
      const dot = document.createElement("i");
      if (i < filled) dot.classList.add("on");
      dots.appendChild(dot);
    }

    const active = day.plan.find((t) => t.id === timer.activeTaskId);
    const label = $("activeTaskLabel");
    if (active) {
      label.textContent = `📚 ${active.text}`;
      label.classList.add("has-task");
    } else {
      label.textContent = "Görev seçilmedi";
      label.classList.remove("has-task");
    }
  }

  function renderPresets() {
    document.querySelectorAll("#presets button").forEach((btn) => {
      const s = Number(btn.dataset.study);
      const b = Number(btn.dataset.break);
      const l = Number(btn.dataset.long);
      btn.classList.toggle(
        "active",
        db.settings.study === s && db.settings.break === b && db.settings.longBreak === l
      );
    });
  }

  function buildTaskItem(task) {
    const li = document.createElement("li");
    li.className = "task";
    if (task.done) li.classList.add("done");
    if (task.id === timer.activeTaskId) li.classList.add("selected");

    const check = document.createElement("button");
    check.className = "check";
    check.type = "button";
    check.textContent = "✓";
    check.title = task.done ? "Geri al" : "Tamamlandı";
    check.addEventListener("click", (e) => {
      e.stopPropagation();
      toggleTask(task.id);
    });

    const body = document.createElement("div");
    body.className = "task-body";

    const title = document.createElement("div");
    title.className = "task-title";
    title.textContent = task.text;

    const meta = document.createElement("div");
    meta.className = "task-meta";

    if (task.subject) {
      const subj = document.createElement("span");
      subj.className = "subject";
      subj.textContent = task.subject;
      meta.appendChild(subj);
    }

    const mins = document.createElement("span");
    mins.textContent = `${task.spent || 0}/${task.minutes} dk`;
    meta.appendChild(mins);

    if (task.id === timer.activeTaskId) {
      const tag = document.createElement("span");
      tag.className = "focus-tag";
      tag.textContent = "· odakta";
      meta.appendChild(tag);
    }

    body.appendChild(title);
    body.appendChild(meta);

    const del = document.createElement("button");
    del.className = "task-del";
    del.type = "button";
    del.textContent = "✕";
    del.title = "Görevi sil";
    del.addEventListener("click", (e) => {
      e.stopPropagation();
      removeTask(task.id);
    });

    li.appendChild(check);
    li.appendChild(body);
    li.appendChild(del);
    li.addEventListener("click", () => selectTask(task.id));
    return li;
  }

  function buildMiniItem(task) {
    const li = document.createElement("li");
    li.className = "mini-item";
    if (task.done) li.classList.add("done");
    if (task.id === timer.activeTaskId) li.classList.add("selected");

    const check = document.createElement("button");
    check.className = "check sm";
    check.type = "button";
    check.textContent = "✓";
    check.title = task.done ? "Geri al" : "Tamamlandı";
    check.addEventListener("click", (e) => {
      e.stopPropagation();
      toggleTask(task.id);
    });

    const title = document.createElement("span");
    title.className = "mini-title";
    title.textContent = task.text;

    const mins = document.createElement("span");
    mins.className = "mini-mins";
    mins.textContent = `${task.spent || 0}/${task.minutes} dk`;

    li.appendChild(check);
    li.appendChild(title);
    li.appendChild(mins);
    li.title = `${task.text} — ${task.spent || 0}/${task.minutes} dk`;
    li.addEventListener("click", () => selectTask(task.id));
    return li;
  }

  function renderPlan() {
    const day = getDay();
    const tasks = day.plan;

    const planned = tasks.reduce((sum, t) => sum + (t.minutes || 0), 0);
    const doneMinutes = tasks.reduce((sum, t) => sum + (t.done ? t.minutes || 0 : 0), 0);
    const doneCount = tasks.filter((t) => t.done).length;
    $("planSummary").textContent = `${doneMinutes}/${planned} dk`;

    const pending = tasks.length - doneCount;
    const countBadge = $("tabPlanCount");
    countBadge.textContent = String(pending);
    countBadge.hidden = pending === 0;

    const filtered = tasks.filter((t) =>
      planFilter === "done" ? t.done : planFilter === "open" ? !t.done : true
    );
    const list = $("taskList");
    list.innerHTML = "";
    for (const task of filtered) list.appendChild(buildTaskItem(task));

    const empty = $("planEmpty");
    empty.hidden = filtered.length > 0;
    if (!filtered.length) {
      empty.textContent = tasks.length
        ? "Bu filtrede görev yok. Filtreyi değiştir."
        : "Bugün için plan yok. Yukarıdan ilk görevini ekle.";
    }

    renderMiniPlan(tasks, doneCount);
    renderPlanAside(tasks, doneCount, planned);
  }

  function renderMiniPlan(tasks, doneCount) {
    const list = $("miniTaskList");
    list.innerHTML = "";
    for (const task of tasks.slice(0, 5)) list.appendChild(buildMiniItem(task));
    $("miniEmpty").hidden = tasks.length > 0;
    $("miniProgress").textContent = `${doneCount}/${tasks.length}`;
    $("miniBar").style.width = `${tasks.length ? Math.round((doneCount / tasks.length) * 100) : 0}%`;
  }

  function renderPlanAside(tasks, doneCount, planned) {
    const spent = tasks.reduce((sum, t) => sum + (t.spent || 0), 0);
    const active = tasks.find((t) => t.id === timer.activeTaskId);

    $("planStatTasks").textContent = `${doneCount}/${tasks.length}`;
    $("planStatPlanned").textContent = `${planned} dk`;
    $("planStatSpent").textContent = `${Math.round(spent)} dk`;
    $("planStatActive").textContent = active ? active.text : "—";
    $("planStatActive").title = active ? active.text : "";

    const taskRatio = tasks.length ? doneCount / tasks.length : 0;
    const timeRatio = planned > 0 ? clamp(spent / planned, 0, 1) : 0;
    $("taskProgressText").textContent = pct(taskRatio);
    $("timeProgressText").textContent = pct(timeRatio);
    $("taskProgressBar").style.width = pct(taskRatio);
    $("timeProgressBar").style.width = pct(timeRatio);

    $("focusActiveBtn").disabled = tasks.length === 0;

    let tip;
    if (!tasks.length) {
      tip = "İlk görevini ekle: ders adı, görev ve tahmini süre yeterli.";
    } else if (doneCount === tasks.length) {
      tip = "Bugünkü tüm görevler tamam! İstersen yeni bir hedef ekleyip seriyi büyüt.";
    } else if (active) {
      tip = `"${active.text}" odak görevi seçili. Odak sekmesinden sayacı başlat, süre otomatik işlenir.`;
    } else {
      tip = "Bir göreve dokunarak onu odak görevi seç. Sayaç bitince çalıştığın dakika göreve eklenir.";
    }
    $("planTip").textContent = tip;
  }

  function renderStats() {
    const s = computeStats();
    const day = s.day;

    $("goalPill").textContent = `🎯 ${Math.round(day.studyMin)} / ${s.goal} dk`;
    $("streakPill").textContent = `🔥 ${calcStreak()}`;

    const meta = scoreLabel(s.score, day.studyMin);
    $("scoreValue").textContent = String(s.score);
    $("scoreBadge").textContent = meta.badge;
    $("scoreLabel").textContent = meta.label;
    $("scoreHint").textContent = meta.hint;

    let scoreColor = "#ff6b6b";
    if (s.score >= 80) scoreColor = db.settings.theme.accent2;
    else if (s.score >= 55) scoreColor = db.settings.theme.accent;
    else if (s.score >= 30) scoreColor = "#f6ad55";
    const scoreFg = $("scoreFg");
    scoreFg.style.strokeDashoffset = String(SCORE_C * (1 - s.score / 100));
    scoreFg.style.stroke = scoreColor;
    scoreFg.style.strokeLinecap = s.score > 0 ? "round" : "butt";

    setBar("goalMetric", "goalBar", pct(s.goalRatio), s.goalRatio);
    setBar("focusMetric", "focusBar", day.studyMin > 0 ? pct(s.focusQuality) : "—", s.focusQuality);
    setBar("planMetric", "planBar", s.hasPlan ? pct(s.planRatio) : "—", s.hasPlan ? s.planRatio : 0);
    setBar("breakMetric", "breakBar", day.studyMin > 0 ? pct(s.breakDiscipline) : "—", s.breakDiscipline);

    $("studyStat").textContent = `${Math.round(day.studyMin)} dk`;
    $("breakStat").textContent = `${Math.round(day.breakMin)} dk`;
    $("sessionStat").textContent = String(day.sessions);
    $("distractStat").textContent = `${Math.round(day.distractionSec / 60)} dk`;

    renderWeek();
  }

  function setBar(metricId, barId, text, ratio) {
    $(metricId).textContent = text;
    const bar = $(barId);
    bar.style.width = `${Math.round(clamp(ratio, 0, 1) * 100)}%`;
    bar.classList.remove("warn", "bad");
    if (ratio < 0.35) bar.classList.add("bad");
    else if (ratio < 0.65) bar.classList.add("warn");
  }

  function renderWeek() {
    const chart = $("weekChart");
    chart.innerHTML = "";

    const today = new Date();
    const entries = [];
    for (let i = 6; i >= 0; i--) {
      const d = new Date(today);
      d.setDate(today.getDate() - i);
      const rec = db.days[dayKey(d)];
      entries.push({
        date: d,
        minutes: rec ? rec.studyMin : 0,
        goal: rec ? rec.goal || db.settings.goal : db.settings.goal,
        isToday: i === 0
      });
    }

    const max = Math.max(db.settings.goal, ...entries.map((e) => e.minutes), 30);
    const total = entries.reduce((sum, e) => sum + e.minutes, 0);
    $("weekTotal").textContent = `${Math.round(total)} dk`;

    for (const entry of entries) {
      const col = document.createElement("div");
      col.className = "week-col";
      col.title = `${entry.date.toLocaleDateString("tr-TR", { day: "numeric", month: "long" })}: ${Math.round(entry.minutes)} dk`;

      const wrap = document.createElement("div");
      wrap.className = "week-bar-wrap";

      const bar = document.createElement("div");
      bar.className = "week-bar";
      if (entry.minutes >= entry.goal && entry.minutes > 0) bar.classList.add("hit");
      if (entry.isToday) bar.classList.add("today");
      if (entry.minutes > 0) {
        bar.style.height = `${Math.max(4, (entry.minutes / max) * 100)}%`;
        wrap.appendChild(bar);
      }

      const label = document.createElement("div");
      label.className = "week-day";
      if (entry.isToday) label.classList.add("today");
      label.textContent = entry.isToday
        ? "Bugün"
        : entry.date.toLocaleDateString("tr-TR", { weekday: "short" });

      col.appendChild(wrap);
      col.appendChild(label);
      chart.appendChild(col);
    }
  }

  /* ---------------- theme & tabs ---------------- */

  function applyTheme() {
    const t = db.settings.theme;
    const root = document.documentElement.style;
    root.setProperty("--accent", t.accent);
    root.setProperty("--accent-2", t.accent2);
    root.setProperty("--bg", t.bg);
    root.setProperty("--bg-glow", hexToRgba(t.accent, 0.16));
    root.setProperty("--card", hexToRgba(t.card, 0.86));
    root.setProperty("--accent-soft", hexToRgba(t.accent, 0.16));
    root.setProperty("--accent-2-soft", hexToRgba(t.accent2, 0.14));
    const avgLight = (luminance(t.accent) + luminance(t.accent2)) / 2;
    root.setProperty("--on-accent", avgLight > 0.5 ? "#0b1020" : "#ffffff");
    document.body.dataset.pattern = t.pattern;

    const meta = document.querySelector('meta[name="theme-color"]');
    if (meta) meta.setAttribute("content", t.bg);
  }

  function switchTab(tab) {
    activeTab = tab;
    document.querySelectorAll(".tab").forEach((btn) => {
      const on = btn.dataset.tab === tab;
      btn.classList.toggle("active", on);
      btn.setAttribute("aria-selected", String(on));
    });
    document.querySelectorAll(".panel").forEach((panel) => {
      panel.classList.toggle("active", panel.dataset.panel === tab);
    });
    if (tab === "theme") renderThemeTab();
    if (tab === "plan") renderPlan();
    if (tab === "calendar") {
      renderCalendar();
      renderDayDetail();
    }
    window.scrollTo({ top: 0, behavior: "smooth" });
  }

  function renderThemeTab() {
    const t = db.settings.theme;

    const presetWrap = $("themePresets");
    presetWrap.innerHTML = "";
    for (const [id, preset] of Object.entries(THEMES)) {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "theme-option" + (t.preset === id ? " active" : "");

      const swatches = document.createElement("div");
      swatches.className = "swatches";
      for (const color of [preset.accent, preset.accent2, preset.bg]) {
        const dot = document.createElement("span");
        dot.className = "swatch";
        dot.style.background = color;
        swatches.appendChild(dot);
      }

      const name = document.createElement("span");
      name.className = "name";
      name.textContent = preset.name;

      btn.appendChild(swatches);
      btn.appendChild(name);
      btn.addEventListener("click", () => applyPresetTheme(id));
      presetWrap.appendChild(btn);
    }

    $("colorAccent").value = t.accent;
    $("colorAccent2").value = t.accent2;
    $("colorBg").value = t.bg;
    $("colorCard").value = t.card;

    $("themeNameBadge").textContent = t.preset === "custom"
      ? "Özel"
      : THEMES[t.preset]
        ? THEMES[t.preset].name
        : "Özel";

    const patternWrap = $("patternGrid");
    patternWrap.innerHTML = "";
    for (const pattern of PATTERNS) {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "pattern-option" + (t.pattern === pattern.id ? " active" : "");

      const swatch = document.createElement("div");
      swatch.className = "pattern-swatch";
      swatch.dataset.pattern = pattern.id;

      const name = document.createElement("span");
      name.textContent = pattern.name;

      btn.appendChild(swatch);
      btn.appendChild(name);
      btn.addEventListener("click", () => setPattern(pattern.id));
      patternWrap.appendChild(btn);
    }
  }

  function markCustomTheme() {
    $("themeNameBadge").textContent = "Özel";
    document.querySelectorAll("#themePresets .theme-option").forEach((btn) => {
      btn.classList.remove("active");
    });
  }

  function applyPresetTheme(id) {
    const preset = THEMES[id];
    if (!preset) return;
    db.settings.theme = {
      preset: id,
      accent: preset.accent,
      accent2: preset.accent2,
      bg: preset.bg,
      card: preset.card,
      pattern: db.settings.theme.pattern
    };
    applyTheme();
    renderThemeTab();
    renderStats();
    save();
    showToast(`${preset.name} teması uygulandı.`);
  }

  function setPattern(id) {
    if (!PATTERNS.some((p) => p.id === id)) return;
    db.settings.theme.pattern = id;
    applyTheme();
    renderThemeTab();
    save();
    showToast("Arka plan deseni güncellendi.");
  }

  function resetTheme() {
    db.settings.theme = defaultTheme();
    applyTheme();
    renderThemeTab();
    renderStats();
    save();
    showToast("Tema varsayılana döndü.");
  }

  function bindThemeInputs() {
    const fields = [
      ["colorAccent", "accent"],
      ["colorAccent2", "accent2"],
      ["colorBg", "bg"],
      ["colorCard", "card"]
    ];

    for (const [id, key] of fields) {
      $(id).addEventListener("input", () => {
        const value = $(id).value;
        if (!HEX_RE.test(value)) return;
        db.settings.theme[key] = value;
        db.settings.theme.preset = "custom";
        applyTheme();
        markCustomTheme();
        renderStats();
        save();
      });
    }

    $("themeResetBtn").addEventListener("click", resetTheme);
  }

  /* ---------------- calendar ---------------- */

  function parseDayKey(key) {
    const parts = key.split("-").map(Number);
    return new Date(parts[0], parts[1] - 1, parts[2]);
  }

  function capitalize(text) {
    return text.charAt(0).toLocaleUpperCase("tr-TR") + text.slice(1);
  }

  function renderCalendar() {
    const monthDate = new Date(calendarYear, calendarMonth, 1);
    $("calendarTitle").textContent = capitalize(
      monthDate.toLocaleDateString("tr-TR", { month: "long", year: "numeric" })
    );

    const weekdays = ["Pzt", "Sal", "Çar", "Per", "Cum", "Cmt", "Paz"];
    const weekdayWrap = $("calendarWeekdays");
    weekdayWrap.innerHTML = "";
    for (const label of weekdays) {
      const span = document.createElement("span");
      span.textContent = label;
      weekdayWrap.appendChild(span);
    }

    const daysInMonth = new Date(calendarYear, calendarMonth + 1, 0).getDate();
    const firstDay = new Date(calendarYear, calendarMonth, 1);
    const startOffset = (firstDay.getDay() + 6) % 7;
    const cellCount = Math.ceil((startOffset + daysInMonth) / 7) * 7;
    const todayKey = dayKey(new Date());

    let monthTotal = 0;
    let studiedDays = 0;
    for (let day = 1; day <= daysInMonth; day++) {
      const rec = db.days[dayKey(new Date(calendarYear, calendarMonth, day))];
      if (rec && rec.studyMin > 0) {
        monthTotal += rec.studyMin;
        studiedDays++;
      }
    }
    $("calendarSub").textContent = monthTotal > 0
      ? `${studiedDays} gün · ${Math.round(monthTotal)} dk çalışıldı`
      : "Çalışma geçmişin ve planların";

    const grid = $("calendarGrid");
    grid.innerHTML = "";

    for (let i = 0; i < cellCount; i++) {
      const dayNumber = i - startOffset + 1;
      if (dayNumber < 1 || dayNumber > daysInMonth) {
        const empty = document.createElement("div");
        empty.className = "cal-day empty";
        grid.appendChild(empty);
        continue;
      }

      const date = new Date(calendarYear, calendarMonth, dayNumber);
      const key = dayKey(date);
      const rec = db.days[key];
      const minutes = rec ? Number(rec.studyMin) || 0 : 0;
      const goal = rec ? rec.goal || db.settings.goal : db.settings.goal;
      const plan = rec && Array.isArray(rec.plan) ? rec.plan : [];
      const planned = plan.reduce((sum, t) => sum + (t.minutes || 0), 0);
      const pending = plan.filter((t) => !t.done).length;

      const cell = document.createElement("button");
      cell.type = "button";
      cell.className = "cal-day";
      if (key === todayKey) cell.classList.add("today");
      if (key === calendarSelected) cell.classList.add("selected");
      if (minutes > 0) cell.classList.add(minutes >= goal ? "hit" : "partial");

      const num = document.createElement("span");
      num.className = "cal-num";
      num.textContent = String(dayNumber);
      cell.appendChild(num);

      if (minutes > 0 || planned > 0) {
        const info = document.createElement("span");
        info.className = "cal-mins";
        info.textContent = minutes > 0
          ? `${Math.round(minutes)} dk`
          : `${planned} dk plan`;
        cell.appendChild(info);
      }

      if (plan.length) {
        const marks = document.createElement("span");
        marks.className = "cal-marks";
        const dot = document.createElement("i");
        dot.className = "cal-dot";
        if (!pending) dot.classList.add("done");
        dot.title = pending ? `${pending} bekleyen görev` : "Tüm görevler tamam";
        marks.appendChild(dot);
        cell.appendChild(marks);
      }

      if (minutes > 0) {
        const bar = document.createElement("span");
        bar.className = "cal-bar";
        const fill = document.createElement("i");
        fill.style.width = `${Math.round(clamp(minutes / goal, 0, 1) * 100)}%`;
        bar.appendChild(fill);
        cell.appendChild(bar);
      }

      cell.title = `${date.toLocaleDateString("tr-TR", { day: "numeric", month: "long" })}${
        minutes > 0 ? ` · ${Math.round(minutes)} dk ders` : ""
      }${plan.length ? ` · ${plan.length} görev` : ""}`;
      cell.addEventListener("click", () => {
        calendarSelected = key;
        renderCalendar();
        renderDayDetail();
      });
      grid.appendChild(cell);
    }
  }

  function renderDayDetail() {
    const key = calendarSelected;
    const date = parseDayKey(key);
    const rec = db.days[key];
    const todayKey = dayKey(new Date());
    const isToday = key === todayKey;
    const isPast = key < todayKey;
    const plan = rec && Array.isArray(rec.plan) ? rec.plan : [];
    const doneCount = plan.filter((t) => t.done).length;
    const studyMin = rec ? Number(rec.studyMin) || 0 : 0;
    const goal = rec ? rec.goal || db.settings.goal : db.settings.goal;
    const stats = computeStats(rec || { plan: [] });

    $("dayDetailTitle").textContent = isToday
      ? "Bugün"
      : capitalize(date.toLocaleDateString("tr-TR", { weekday: "long" }));
    $("dayDetailDate").textContent = date.toLocaleDateString("tr-TR", {
      day: "numeric",
      month: "long",
      year: "numeric"
    });
    $("dayDetailBadge").textContent = `${Math.round(studyMin)} dk`;

    $("dayStudy").textContent = `${Math.round(studyMin)} dk`;
    $("dayBreak").textContent = `${Math.round(rec ? Number(rec.breakMin) || 0 : 0)} dk`;
    $("daySessions").textContent = String(rec ? Number(rec.sessions) || 0 : 0);
    $("dayScore").textContent = String(stats.score);

    $("dayGoalText").textContent = `${Math.round(studyMin)} / ${goal} dk`;
    $("dayGoalBar").style.width = pct(clamp(studyMin / goal, 0, 1));

    $("dayTaskCount").textContent = `${doneCount}/${plan.length}`;
    const taskList = $("dayTaskList");
    taskList.innerHTML = "";
    for (const task of plan) taskList.appendChild(buildDayTaskItem(task, key));
    $("dayTaskEmpty").hidden = plan.length > 0;

    const form = $("dayTaskForm");
    form.style.display = isPast ? "none" : "flex";
    if (isPast) {
      $("dayTaskNote").textContent = "Geçmiş günlere yeni görev eklenemez.";
    } else if (isToday) {
      $("dayTaskNote").textContent = "Buraya eklediğin görevler Yapılacaklar sekmesinde de görünür.";
    } else {
      $("dayTaskNote").textContent = "Görev seçtiğin güne planlanır; o gün geldiğinde sayaçta görünür.";
    }
  }

  function buildDayTaskItem(task, key) {
    const isToday = key === dayKey(new Date());
    const li = document.createElement("li");
    li.className = "mini-item";
    if (task.done) li.classList.add("done");
    if (isToday && task.id === timer.activeTaskId) li.classList.add("selected");

    const check = document.createElement("button");
    check.className = "check sm";
    check.type = "button";
    check.textContent = "✓";
    check.title = task.done ? "Geri al" : "Tamamlandı";
    check.addEventListener("click", (e) => {
      e.stopPropagation();
      toggleCalendarTask(key, task.id);
    });

    const title = document.createElement("span");
    title.className = "mini-title";
    title.textContent = task.text;
    title.title = task.text;

    const mins = document.createElement("span");
    mins.className = "mini-mins";
    mins.textContent = `${task.spent || 0}/${task.minutes} dk`;

    const del = document.createElement("button");
    del.className = "task-del";
    del.type = "button";
    del.textContent = "✕";
    del.title = "Görevi sil";
    del.addEventListener("click", (e) => {
      e.stopPropagation();
      removeCalendarTask(key, task.id);
    });

    li.appendChild(check);
    li.appendChild(title);
    li.appendChild(mins);
    li.appendChild(del);

    if (isToday) {
      li.addEventListener("click", () => {
        timer.activeTaskId = task.id;
        save();
        renderAll();
      });
    }
    return li;
  }

  function toggleCalendarTask(key, id) {
    const rec = db.days[key];
    if (!rec || !Array.isArray(rec.plan)) return;
    const task = rec.plan.find((t) => t.id === id);
    if (!task) return;
    task.done = !task.done;
    save();
    if (key === dayKey(new Date())) {
      renderAll();
    } else {
      renderCalendar();
      renderDayDetail();
    }
  }

  function removeCalendarTask(key, id) {
    const rec = db.days[key];
    if (!rec || !Array.isArray(rec.plan)) return;
    rec.plan = rec.plan.filter((t) => t.id !== id);
    if (key === dayKey(new Date()) && timer.activeTaskId === id) {
      timer.activeTaskId = null;
    }
    save();
    if (key === dayKey(new Date())) {
      renderAll();
    } else {
      renderCalendar();
      renderDayDetail();
    }
    showToast("Görev silindi.");
  }

  function shiftCalendarMonth(delta) {
    const target = new Date(calendarYear, calendarMonth + delta, 1);
    calendarYear = target.getFullYear();
    calendarMonth = target.getMonth();
    const now = new Date();
    calendarSelected = calendarYear === now.getFullYear() && calendarMonth === now.getMonth()
      ? dayKey(now)
      : dayKey(new Date(calendarYear, calendarMonth, 1));
    renderCalendar();
    renderDayDetail();
  }

  function goToToday() {
    const now = new Date();
    calendarYear = now.getFullYear();
    calendarMonth = now.getMonth();
    calendarSelected = dayKey(now);
    renderCalendar();
    renderDayDetail();
  }

  /* ---------------- day rollover ---------------- */

  function checkDayChange() {
    const key = dayKey(new Date());
    if (key === renderedDayKey) return;
    const oldKey = renderedDayKey;
    renderedDayKey = key;
    if (calendarSelected === oldKey) calendarSelected = key;
    const day = getDay();
    if (timer.activeTaskId && !day.plan.some((t) => t.id === timer.activeTaskId)) {
      timer.activeTaskId = null;
    }
    save();
    renderAll();
    showToast("Yeni gün, yeni plan! ☀️");
  }

  /* ---------------- settings ---------------- */

  function openSettings() {
    $("setStudy").value = String(db.settings.study);
    $("setBreak").value = String(db.settings.break);
    $("setLong").value = String(db.settings.longBreak);
    $("setRounds").value = String(db.settings.rounds);
    $("setGoal").value = String(db.settings.goal);
    $("setAutoBreak").checked = !!db.settings.autoBreak;
    $("setAutoStudy").checked = !!db.settings.autoStudy;
    $("setSound").checked = !!db.settings.sound;
    $("setNotify").checked = !!db.settings.notify;
    const dialog = $("settingsDialog");
    dialog.returnValue = "";
    if (typeof dialog.showModal === "function") dialog.showModal();
    else dialog.setAttribute("open", "");
  }

  function applySettings() {
    const study = clamp(Number($("setStudy").value) || DEFAULTS.study, 1, 180);
    const brk = clamp(Number($("setBreak").value) || DEFAULTS.break, 1, 60);
    const long = clamp(Number($("setLong").value) || DEFAULTS.longBreak, 1, 90);
    const rounds = clamp(Number($("setRounds").value) || DEFAULTS.rounds, 2, 10);
    const goal = clamp(Number($("setGoal").value) || DEFAULTS.goal, 10, 960);

    db.settings.study = study;
    db.settings.break = brk;
    db.settings.longBreak = long;
    db.settings.rounds = rounds;
    db.settings.goal = goal;
    db.settings.autoBreak = $("setAutoBreak").checked;
    db.settings.autoStudy = $("setAutoStudy").checked;
    db.settings.sound = $("setSound").checked;

    const wantNotify = $("setNotify").checked;
    if (wantNotify && "Notification" in window && Notification.permission === "default") {
      Notification.requestPermission().then((perm) => {
        db.settings.notify = perm === "granted";
        save();
        renderAll();
        if (perm !== "granted") showToast("Bildirim izni verilmedi.");
      }).catch(() => {
        db.settings.notify = false;
        save();
      });
    } else if (wantNotify && (!("Notification" in window) || Notification.permission === "denied")) {
      db.settings.notify = false;
      showToast("Tarayıcı bildirimlerine izin verilmiyor.");
    } else {
      db.settings.notify = wantNotify;
    }

    const day = getDay();
    day.goal = goal;

    if (!timer.running) {
      const nextLong = timer.mode === "break" ? timer.nextLong : false;
      resetPhase(timer.mode, nextLong);
    }

    save();
    renderAll();
    showToast("Ayarlar kaydedildi.");
  }

  function resetToday() {
    if (!window.confirm("Bugünün planı, süreleri ve verimlilik puanı silinsin mi?")) return;
    delete db.days[dayKey(new Date())];
    timer.activeTaskId = null;
    resetPhase("study", false);
    save();
    renderAll();
    showToast("Bugünün verileri sıfırlandı.");
  }

  function wipeAll() {
    if (!window.confirm("Tüm günler, planlar ve ayarlar silinsin mi? Bu işlem geri alınamaz.")) return;
    db = freshDB();
    timer = makeTimer("study");
    localStorage.removeItem(STORAGE_KEY);
    applyTheme();
    save();
    const dialog = $("settingsDialog");
    if (dialog.open) dialog.close();
    renderAll();
    showToast("Tüm veriler silindi.");
  }

  /* ---------------- events ---------------- */

  function bindEvents() {
    $("startBtn").addEventListener("click", toggleTimer);
    $("resetBtn").addEventListener("click", () => resetTimer(false));
    $("skipBtn").addEventListener("click", skipPhase);
    $("settingsBtn").addEventListener("click", openSettings);

    document.querySelectorAll(".tab").forEach((btn) => {
      btn.addEventListener("click", () => switchTab(btn.dataset.tab));
    });
    $("openPlanBtn").addEventListener("click", () => switchTab("plan"));

    document.querySelectorAll("#planFilters .filter-chip").forEach((btn) => {
      btn.addEventListener("click", () => {
        planFilter = btn.dataset.filter;
        document.querySelectorAll("#planFilters .filter-chip").forEach((chip) => {
          chip.classList.toggle("active", chip === btn);
        });
        renderPlan();
      });
    });

    $("focusActiveBtn").addEventListener("click", () => {
      const day = getDay();
      if (!day.plan.some((t) => t.id === timer.activeTaskId)) {
        const next = day.plan.find((t) => !t.done) || day.plan[0];
        if (next) timer.activeTaskId = next.id;
      }
      save();
      renderAll();
      switchTab("focus");
    });

    bindThemeInputs();

    $("calPrev").addEventListener("click", () => shiftCalendarMonth(-1));
    $("calNext").addEventListener("click", () => shiftCalendarMonth(1));
    $("calToday").addEventListener("click", goToToday);

    $("dayTaskForm").addEventListener("submit", (e) => {
      e.preventDefault();
      const text = $("dayTaskText").value.trim();
      if (!text) return;
      const todayKey = dayKey(new Date());
      if (calendarSelected < todayKey) {
        showToast("Geçmiş güne yeni görev eklenemez.");
        return;
      }

      const subject = $("dayTaskSubject").value.trim();
      const minutes = clamp(Number($("dayTaskMinutes").value) || 30, 5, 480);
      const day = getDay(parseDayKey(calendarSelected));
      const id = uid();
      day.plan.push({ id, text, subject, minutes, spent: 0, done: false });
      if (calendarSelected === todayKey && !timer.activeTaskId) timer.activeTaskId = id;

      $("dayTaskText").value = "";
      $("dayTaskSubject").value = "";
      $("dayTaskMinutes").value = "30";
      save();

      if (calendarSelected === todayKey) {
        renderAll();
        showToast("Görev eklendi. Yapılacaklar sekmesinde de görünür.");
      } else {
        renderCalendar();
        renderDayDetail();
        showToast("Görev seçtiğin güne eklendi.");
      }
    });

    document.querySelectorAll(".mode-btn").forEach((btn) => {
      btn.addEventListener("click", () => {
        const mode = btn.dataset.mode;
        if (mode === timer.mode) return;
        if (timer.running) {
          timer.running = false;
          timer.endAt = 0;
          timer.remainingMs = timer.totalMs;
          timer.sessionDistraction = 0;
          showToast("Mod değişti, sayaç sıfırlandı.");
        }
        resetPhase(mode, mode === "break" ? timer.nextLong : false);
        save();
        renderAll();
      });
    });

    document.querySelectorAll("#presets button").forEach((btn) => {
      btn.addEventListener("click", () => {
        usePreset(Number(btn.dataset.study), Number(btn.dataset.break), Number(btn.dataset.long));
      });
    });

    $("taskForm").addEventListener("submit", (e) => {
      e.preventDefault();
      const text = $("taskText").value.trim();
      if (!text) return;
      const subject = $("taskSubject").value.trim();
      const minutes = clamp(Number($("taskMinutes").value) || 30, 5, 480);
      planFilter = "all";
      document.querySelectorAll("#planFilters .filter-chip").forEach((chip) => {
        chip.classList.toggle("active", chip.dataset.filter === "all");
      });
      addTask(text, subject, minutes);
      $("taskText").value = "";
      $("taskSubject").value = "";
      $("taskMinutes").value = "30";
      $("taskText").focus();
    });

    $("settingsDialog").addEventListener("close", () => {
      if ($("settingsDialog").returnValue === "save") applySettings();
    });

    $("resetTodayBtn").addEventListener("click", resetToday);
    $("wipeBtn").addEventListener("click", wipeAll);

    document.addEventListener("visibilitychange", () => {
      if (document.hidden) {
        hiddenMark = Date.now();
        save();
        return;
      }
      if (hiddenMark !== null) {
        syncHidden(Date.now());
        hiddenMark = null;
        save();
      }
      if (timer.running) tick();
      renderAll();
      if (timer.running && timer.mode === "study" && timer.sessionDistraction >= 5) {
        showToast("Sekme değişikliği odak kaliteni düşürdü. Geri dön ve devam et!");
      }
    });

    document.addEventListener("keydown", (e) => {
      const tag = (e.target.tagName || "").toLowerCase();
      if (tag === "input" || tag === "textarea" || tag === "select") return;
      if ($("settingsDialog").open) return;
      if (e.code === "Space") {
        e.preventDefault();
        toggleTimer();
      } else if (e.key === "r" || e.key === "R") {
        resetTimer(false);
      } else if (e.key === "s" || e.key === "S") {
        openSettings();
      }
    });

    window.addEventListener("beforeunload", () => {
      save();
    });
  }

  /* ---------------- init ---------------- */

  function init() {
    db = loadDB();
    timer = db.timer && typeof db.timer === "object" ? db.timer : null;

    const validTimer =
      timer &&
      (timer.mode === "study" || timer.mode === "break") &&
      typeof timer.totalMs === "number" &&
      typeof timer.remainingMs === "number";

    if (!validTimer) {
      timer = makeTimer("study");
    } else {
      timer.running = !!timer.running && !!timer.endAt;
      timer.sessionDistraction = Number(timer.sessionDistraction) || 0;
      timer.activeTaskId = timer.activeTaskId || null;
      if (typeof timer.nextLong !== "boolean") timer.nextLong = false;
      if (!timer.running && (timer.remainingMs > timer.totalMs || timer.remainingMs < 0)) {
        timer.remainingMs = timer.totalMs;
      }
    }
    db.timer = timer;

    getDay();
    if (timer.activeTaskId && !getDay().plan.some((t) => t.id === timer.activeTaskId)) {
      timer.activeTaskId = null;
    }

    const now = dayKey(new Date());
    renderedDayKey = now;

    applyTheme();
    bindEvents();
    renderAll();
    save();

    setInterval(tick, 250);
    setInterval(() => {
      checkDayChange();
      if (timer.running) save();
    }, 5000);
  }

  init();
})();
