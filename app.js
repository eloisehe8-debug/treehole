(() => {
  const PAGE = 20;
  const MOODS = ["sad", "anxious", "angry", "tired", "lonely", "other"];
  const REASONS = ["harassment", "hate", "spam", "self_harm", "other"];
  const $ = id => document.getElementById(id);

  // ───────── Language ─────────
  let lang = "zh";
  try { lang = localStorage.getItem("lang") || (navigator.language.startsWith("zh") ? "zh" : "en"); } catch {}
  const t = (k, ...a) => { const v = window.I18N[lang][k]; return typeof v === "function" ? v(...a) : v; };

  function applyLang() {
    document.documentElement.lang = lang === "zh" ? "zh-CN" : "en";
    document.title = lang === "zh" ? "树洞 Treehole" : "Treehole 树洞";
    document.querySelectorAll("[data-i18n]").forEach(el => el.textContent = t(el.dataset.i18n));
    document.querySelectorAll("[data-i18n-ph]").forEach(el => el.placeholder = t(el.dataset.i18nPh));
    document.querySelectorAll("[data-i18n-aria]").forEach(el => el.setAttribute("aria-label", t(el.dataset.i18nAria)));
    $("lang-toggle").textContent = lang === "zh" ? "EN" : "中文";
    renderMoods();
    renderMe();
    if (cfgOk) { renderFeed(); renderReports(); } else showSetup();
  }
  $("lang-toggle").onclick = () => {
    lang = lang === "zh" ? "en" : "zh";
    try { localStorage.setItem("lang", lang); } catch {}
    applyLang();
  };

  // ───────── Helpers ─────────
  const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  function ago(iso) {
    const m = Math.floor((Date.now() - new Date(iso)) / 60000);
    if (m < 1) return t("justNow");
    if (m < 60) return t("minAgo", m);
    if (m < 1440) return t("hrAgo", Math.floor(m / 60));
    return t("dayAgo", Math.floor(m / 1440));
  }
  function errText(e) {
    const msg = e?.message || String(e);
    if (msg.includes("rate_limited")) return t("rateLimited");
    if (msg.includes("row-level security") && profile?.banned) return t("banned");
    return t("error") + msg;
  }
  function setStatus(el, text, isErr) { el.textContent = text || ""; el.classList.toggle("err", !!isErr); }

  // ───────── Supabase ─────────
  const cfg = window.TREEHOLE_CONFIG || {};
  const cfgOk = cfg.supabaseUrl && !cfg.supabaseUrl.startsWith("PASTE") && cfg.supabaseAnonKey && !cfg.supabaseAnonKey.startsWith("PASTE");
  const sb = cfgOk ? window.supabase.createClient(cfg.supabaseUrl, cfg.supabaseAnonKey) : null;

  let session = null, profile = null;
  let posts = [], offset = 0, hasMore = false;
  let repliesByPost = {}, summary = {}, comments = {}, myRatings = {};
  const openPosts = new Set();
  let mood = "other";
  let reports = [];

  const key = (type, id) => `${type}:${id}`;

  function showSetup() {
    const el = $("setup");
    el.hidden = false;
    el.innerHTML = `<h2>${esc(t("setupTitle"))}</h2><p>${esc(t("setupBody"))}</p>`;
  }

  // ───────── Auth ─────────
  async function onSession(s) {
    session = s;
    profile = null;
    if (session) {
      const { data } = await sb.from("profiles").select("nickname,is_admin,banned").eq("id", session.user.id).maybeSingle();
      profile = data;
    }
    $("auth").hidden = !!session;
    $("compose").hidden = !session;
    $("sign-out").hidden = !session;
    $("admin").hidden = !profile?.is_admin;
    renderMe();
    await loadFeed(true);
    if (profile?.is_admin) loadReports();
  }

  function renderMe() {
    const me = $("me");
    me.hidden = !profile;
    if (profile) me.textContent = t("yourNick") + profile.nickname;
  }

  $("auth-form").onsubmit = async e => {
    e.preventDefault();
    const btn = e.submitter; btn.disabled = true;
    const { error } = await sb.auth.signInWithOtp({
      email: $("auth-email").value.trim(),
      options: { emailRedirectTo: location.origin + location.pathname },
    });
    btn.disabled = false;
    setStatus($("auth-status"), error ? errText(error) : t("linkSent"), !!error);
  };
  $("sign-out").onclick = () => sb.auth.signOut();

  // ───────── Compose ─────────
  function renderMoods() {
    $("mood-picker").innerHTML = MOODS.map(m =>
      `<button type="button" role="radio" class="chip mood-${m}" aria-checked="${m === mood}" data-mood="${m}">${esc(t("moods")[m])}</button>`
    ).join("");
  }
  $("mood-picker").onclick = e => {
    const b = e.target.closest("[data-mood]"); if (!b) return;
    mood = b.dataset.mood; renderMoods();
  };
  $("post-body").oninput = e => $("post-count").textContent = `${e.target.value.length} / 2000`;
  $("post-form").onsubmit = async e => {
    e.preventDefault();
    const body = $("post-body").value.trim(); if (!body) return;
    const btn = e.submitter; btn.disabled = true;
    const { error } = await sb.from("posts").insert({ body, mood });
    btn.disabled = false;
    if (error) return setStatus($("post-status"), errText(error), true);
    $("post-body").value = ""; $("post-count").textContent = "0 / 2000";
    setStatus($("post-status"), t("posted"));
    loadFeed(true);
  };

  // ───────── Feed ─────────
  async function loadFeed(reset) {
    if (reset) { offset = 0; posts = []; repliesByPost = {}; summary = {}; comments = {}; }
    const { data, error } = await sb.from("feed_posts").select("*")
      .order("created_at", { ascending: false }).range(offset, offset + PAGE - 1);
    if (error) { $("feed").innerHTML = `<p class="status err">${esc(t("loadError"))}</p>`; return; }
    posts = posts.concat(data);
    offset += data.length;
    hasMore = data.length === PAGE;
    await loadExtras(data.map(p => p.id));
    renderFeed();
  }

  async function loadExtras(postIds) {
    if (!postIds.length) return;
    const { data: reps } = await sb.from("feed_replies").select("*").in("post_id", postIds).order("created_at");
    for (const id of postIds) repliesByPost[id] = [];
    (reps || []).forEach(r => repliesByPost[r.post_id].push(r));
    const replyIds = (reps || []).map(r => r.id);

    const sumQ = (type, ids) => ids.length ? sb.from("rating_summary").select("*").eq("target_type", type).in("target_id", ids) : { data: [] };
    const comQ = (type, ids) => ids.length ? sb.from("rating_comments").select("*").eq("target_type", type).in("target_id", ids).order("created_at", { ascending: false }) : { data: [] };
    const [s1, s2, c1, c2] = await Promise.all([sumQ("post", postIds), sumQ("reply", replyIds), comQ("post", postIds), comQ("reply", replyIds)]);
    [...(s1.data || []), ...(s2.data || [])].forEach(s => summary[key(s.target_type, s.target_id)] = s);
    [...(c1.data || []), ...(c2.data || [])].forEach(c => (comments[key(c.target_type, c.target_id)] ||= []).push(c));

    if (session) {
      const { data: mine } = await sb.from("ratings").select("target_type,target_id,helpful,comment");
      myRatings = {};
      (mine || []).forEach(r => myRatings[key(r.target_type, r.target_id)] = r);
    }
  }

  function itemFooter(type, item) {
    const k = key(type, item.id), s = summary[k], mineR = myRatings[k];
    const com = comments[k] || [];
    return `
      <div class="actions">
        <span class="score" title="${esc(t("helpful"))} / ${esc(t("unhelpful"))}">
          <span class="up${mineR?.helpful === true ? " on" : ""}">▲ ${s?.helpful_count || 0}</span>
          <span class="down${mineR?.helpful === false ? " on" : ""}">▼ ${s?.unhelpful_count || 0}</span>
        </span>
        ${item.mine ? "" : `<button type="button" class="link" data-act="rate" data-type="${type}" data-id="${item.id}">${esc(t("rate"))}</button>`}
        ${item.mine ? "" : `<button type="button" class="link" data-act="report" data-type="${type}" data-id="${item.id}">${esc(t("report"))}</button>`}
        ${item.mine ? `<button type="button" class="link" data-act="delete" data-type="${type}" data-id="${item.id}">${esc(t("del"))}</button>` : ""}
      </div>
      ${com.length ? `<details class="reviews"><summary>${esc(t("comments", com.length))}</summary>
        <ul>${com.map(c => `<li><span class="${c.helpful ? "up" : "down"}">${c.helpful ? "▲" : "▼"}</span> ${esc(c.comment)}</li>`).join("")}</ul></details>` : ""}`;
  }

  function renderFeed() {
    const feed = $("feed");
    if (!cfgOk) { feed.innerHTML = ""; return; }
    $("more").hidden = !hasMore;
    if (!posts.length) { feed.innerHTML = `<p class="empty">${esc(t("empty"))}</p>`; return; }
    feed.innerHTML = posts.map(p => {
      const reps = repliesByPost[p.id] || [];
      const open = openPosts.has(p.id);
      return `<article class="post${p.hidden ? " is-hidden" : ""}">
        <div class="meta">
          <span class="chip mood-${p.mood}">${esc(t("moods")[p.mood])}</span>
          <span class="nick">${esc(p.nickname)}${p.mine ? ` <em>(${esc(t("you"))})</em>` : ""}</span>
          <time datetime="${esc(p.created_at)}">${esc(ago(p.created_at))}</time>
          ${p.hidden ? `<span class="flag">${esc(t("hidden"))}</span>` : ""}
        </div>
        <p class="body">${esc(p.body)}</p>
        ${itemFooter("post", p)}
        <button type="button" class="toggle" data-act="toggle" data-id="${p.id}" aria-expanded="${open}">
          ${esc(open ? t("hideReplies") : (reps.length ? t("replies", reps.length) : t("reply")))}
        </button>
        ${open ? `<div class="replies">
          ${reps.map(r => `<div class="reply${r.hidden ? " is-hidden" : ""}">
            <div class="meta"><span class="nick">${esc(r.nickname)}${r.mine ? ` <em>(${esc(t("you"))})</em>` : ""}</span>
              <time datetime="${esc(r.created_at)}">${esc(ago(r.created_at))}</time>
              ${r.hidden ? `<span class="flag">${esc(t("hidden"))}</span>` : ""}</div>
            <p class="body">${esc(r.body)}</p>
            ${itemFooter("reply", r)}
          </div>`).join("")}
          ${session ? `<form class="reply-form" data-post="${p.id}">
            <label class="sr" for="reply-${p.id}">${esc(t("reply"))}</label>
            <textarea id="reply-${p.id}" maxlength="1000" rows="2" required placeholder="${esc(t("replyPh"))}"></textarea>
            <div class="row between"><p class="status" role="status"></p><button type="submit" class="primary small">${esc(t("send"))}</button></div>
          </form>` : `<p class="muted small">${esc(t("signInToAct"))}</p>`}
        </div>` : ""}
      </article>`;
    }).join("");
  }

  $("more").onclick = () => loadFeed(false);

  $("feed").onclick = e => {
    const b = e.target.closest("[data-act]"); if (!b) return;
    const id = Number(b.dataset.id), type = b.dataset.type;
    if (b.dataset.act === "toggle") { openPosts.has(id) ? openPosts.delete(id) : openPosts.add(id); renderFeed(); return; }
    if (!session) { alertDialog(t("signInToAct")); return; }
    if (b.dataset.act === "rate") rateDialog(type, id);
    if (b.dataset.act === "report") reportDialog(type, id);
    if (b.dataset.act === "delete") confirmDialog(t("confirmDel"), async () => {
      const { error } = await sb.from(type === "post" ? "posts" : "replies").delete().eq("id", id);
      if (error) return alertDialog(errText(error));
      loadFeed(true);
    });
  };

  $("feed").onsubmit = async e => {
    const f = e.target.closest(".reply-form"); if (!f) return;
    e.preventDefault();
    const ta = f.querySelector("textarea"), st = f.querySelector(".status"), btn = e.submitter;
    const body = ta.value.trim(); if (!body) return;
    btn.disabled = true;
    const { error } = await sb.from("replies").insert({ post_id: Number(f.dataset.post), body });
    btn.disabled = false;
    if (error) return setStatus(st, errText(error), true);
    await reloadPost(Number(f.dataset.post));
  };

  async function reloadPost(postId) {
    await loadExtras(posts.map(p => p.id));
    openPosts.add(postId);
    renderFeed();
  }

  // ───────── Dialogs ─────────
  let lastFocus = null;
  function openDialog(title, html) {
    lastFocus = document.activeElement;
    $("dialog-title").textContent = title;
    $("dialog-body").innerHTML = html;
    $("dialog").hidden = false;
    ($("dialog-body").querySelector("textarea, input, button") || $("dialog")).focus();
  }
  function closeDialog() { $("dialog").hidden = true; lastFocus?.focus(); }
  $("dialog").onclick = e => { if (e.target === $("dialog") || e.target.closest("[data-close]")) closeDialog(); };
  document.addEventListener("keydown", e => { if (e.key === "Escape" && !$("dialog").hidden) closeDialog(); });

  function alertDialog(msg) {
    openDialog(t("brand"), `<p>${esc(msg)}</p><div class="row end"><button type="button" class="primary" data-close>OK</button></div>`);
  }
  function confirmDialog(msg, onYes) {
    openDialog(t("del"), `<p>${esc(msg)}</p><div class="row end">
      <button type="button" class="ghost" data-close>${esc(t("cancel"))}</button>
      <button type="button" class="danger" id="dlg-yes">${esc(t("yes"))}</button></div>`);
    $("dlg-yes").onclick = async () => { closeDialog(); await onYes(); };
  }

  function rateDialog(type, id) {
    const prev = myRatings[key(type, id)];
    let helpful = prev ? prev.helpful : null;
    openDialog(t("rateTitle"), `<p class="muted">${esc(t("rateHint"))}</p>
      <div class="row" role="radiogroup" aria-label="${esc(t("rateTitle"))}">
        <button type="button" class="chip big" role="radio" data-h="1" aria-checked="${helpful === true}">▲ ${esc(t("helpful"))}</button>
        <button type="button" class="chip big" role="radio" data-h="0" aria-checked="${helpful === false}">▼ ${esc(t("unhelpful"))}</button>
      </div>
      <label class="sr" for="rate-comment">${esc(t("rateCommentPh"))}</label>
      <input id="rate-comment" maxlength="200" placeholder="${esc(t("rateCommentPh"))}" value="${esc(prev?.comment || "")}">
      <p class="status" id="rate-status" role="status"></p>
      <div class="row end"><button type="button" class="ghost" data-close>${esc(t("cancel"))}</button>
      <button type="button" class="primary" id="rate-save" ${helpful === null ? "disabled" : ""}>${esc(t("rateSave"))}</button></div>`);
    $("dialog-body").querySelectorAll("[data-h]").forEach(b => b.onclick = () => {
      helpful = b.dataset.h === "1";
      $("dialog-body").querySelectorAll("[data-h]").forEach(x => x.setAttribute("aria-checked", String(x === b)));
      $("rate-save").disabled = false;
    });
    $("rate-save").onclick = async () => {
      const comment = $("rate-comment").value.trim() || null;
      const { error } = await sb.from("ratings").upsert(
        { target_type: type, target_id: id, helpful, comment, rater_id: session.user.id },
        { onConflict: "rater_id,target_type,target_id" });
      if (error) return setStatus($("rate-status"), errText(error), true);
      closeDialog();
      await loadExtras(posts.map(p => p.id));
      renderFeed();
    };
  }

  function reportDialog(type, id) {
    openDialog(t("reportTitle"), `<p class="muted">${esc(t("reportHint"))}</p>
      <fieldset class="reasons"><legend class="sr">${esc(t("reportTitle"))}</legend>
        ${REASONS.map((r, i) => `<label><input type="radio" name="reason" value="${r}" ${i === 0 ? "checked" : ""}> ${esc(t("reasons")[r])}</label>`).join("")}
      </fieldset>
      <label class="sr" for="report-note">${esc(t("reportNotePh"))}</label>
      <textarea id="report-note" maxlength="300" rows="2" placeholder="${esc(t("reportNotePh"))}"></textarea>
      <p class="status" id="report-status" role="status"></p>
      <div class="row end"><button type="button" class="ghost" data-close>${esc(t("cancel"))}</button>
      <button type="button" class="primary" id="report-send">${esc(t("reportSend"))}</button></div>`);
    $("report-send").onclick = async () => {
      const reason = $("dialog-body").querySelector("input[name=reason]:checked").value;
      const note = $("report-note").value.trim() || null;
      const { error } = await sb.from("reports").insert({ target_type: type, target_id: id, reason, note });
      if (error && error.code !== "23505") return setStatus($("report-status"), errText(error), true);
      alertDialog(reason === "self_harm" ? t("reportSent") + " " + t("selfHarmNote") : t("reportSent"));
    };
  }

  // ───────── Admin ─────────
  async function loadReports() {
    const { data, error } = await sb.from("reports").select("*").eq("resolved", false).order("created_at", { ascending: false });
    if (error) { reports = []; renderReports(); return; }
    const postIds = data.filter(r => r.target_type === "post").map(r => r.target_id);
    const replyIds = data.filter(r => r.target_type === "reply").map(r => r.target_id);
    const [p, r] = await Promise.all([
      postIds.length ? sb.from("posts").select("id,body,hidden,author_id").in("id", postIds) : { data: [] },
      replyIds.length ? sb.from("replies").select("id,body,hidden,author_id").in("id", replyIds) : { data: [] },
    ]);
    const content = {};
    (p.data || []).forEach(x => content[key("post", x.id)] = x);
    (r.data || []).forEach(x => content[key("reply", x.id)] = x);
    reports = data.map(rep => ({ ...rep, content: content[key(rep.target_type, rep.target_id)] }));
    renderReports();
  }

  function renderReports() {
    const el = $("report-list");
    if (!profile?.is_admin) { el.innerHTML = ""; return; }
    if (!reports.length) { el.innerHTML = `<p class="muted">${esc(t("noReports"))}</p>`; return; }
    el.innerHTML = reports.map(r => `<div class="report">
      <div class="meta"><span class="chip">${esc(t("target")[r.target_type])}</span>
        <strong>${esc(t("reasons")[r.reason])}</strong><time>${esc(ago(r.created_at))}</time>
        ${r.content?.hidden ? `<span class="flag">${esc(t("hidden"))}</span>` : ""}</div>
      <p class="body">${r.content ? esc(r.content.body) : esc(t("deleted"))}</p>
      ${r.note ? `<p class="muted small">“${esc(r.note)}”</p>` : ""}
      <div class="row">
        ${r.content ? `<button type="button" class="ghost small" data-admin="hide" data-rid="${r.id}">${esc(r.content.hidden ? t("unhide") : t("hide"))}</button>
        <button type="button" class="danger small" data-admin="ban" data-rid="${r.id}">${esc(t("ban"))}</button>` : ""}
        <button type="button" class="primary small" data-admin="resolve" data-rid="${r.id}">${esc(t("resolve"))}</button>
      </div></div>`).join("");
  }

  $("report-list").onclick = async e => {
    const b = e.target.closest("[data-admin]"); if (!b) return;
    const rep = reports.find(r => r.id === Number(b.dataset.rid)); if (!rep) return;
    const table = rep.target_type === "post" ? "posts" : "replies";
    let res;
    if (b.dataset.admin === "hide") res = await sb.from(table).update({ hidden: !rep.content.hidden }).eq("id", rep.target_id);
    if (b.dataset.admin === "ban") res = await sb.from("profiles").update({ banned: true }).eq("id", rep.content.author_id);
    if (b.dataset.admin === "resolve") res = await sb.from("reports").update({ resolved: true }).eq("id", rep.id);
    if (res?.error) return alertDialog(errText(res.error));
    await loadReports();
    loadFeed(true);
  };

  // ───────── Start ─────────
  applyLang();
  if (cfgOk) {
    // Fires INITIAL_SESSION once on load, then again whenever someone signs in or out.
    sb.auth.onAuthStateChange((evt, s) => {
      if (evt === "INITIAL_SESSION" || (s?.user.id || null) !== (session?.user.id || null)) setTimeout(() => onSession(s), 0);
    });
  }
})();
