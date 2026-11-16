(() => {
  const PAGE = 20;
  const KINDS = window.KINDS;
  const GROUPS = window.TOPIC_GROUPS;
  const REASONS = ["harassment", "hate", "spam", "self_harm", "other"];
  const $ = id => document.getElementById(id);
  const VIEWS = ["auth", "feed", "topics", "write", "messages", "chat", "admin"];

  // ───────── Language ─────────
  let lang = "zh";
  try { lang = localStorage.getItem("lang") || (navigator.language.startsWith("zh") ? "zh" : "en"); } catch {}
  const t = (k, ...a) => { const v = window.I18N[lang][k]; return typeof v === "function" ? v(...a) : v; };

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
    if (msg.includes("banned") || (msg.includes("row-level security") && profile?.banned)) return t("banned");
    if (msg.includes("self")) return t("dmSelf");
    return t("error") + msg;
  }
  function setStatus(el, text, isErr) { el.textContent = text || ""; el.classList.toggle("err", !!isErr); }
  const key = (type, id) => `${type}:${id}`;
  const topicChip = tp => `<a class="chip topic-${tp}" href="#/topic/${tp}">#${esc(t("topics")[tp])}</a>`;
  const kindChip = k => `<span class="chip kind">${esc(t("kinds")[k])}</span>`;

  // ───────── Supabase ─────────
  const cfg = window.TREEHOLE_CONFIG || {};
  const cfgOk = cfg.supabaseUrl && !cfg.supabaseUrl.startsWith("PASTE") && cfg.supabaseAnonKey && !cfg.supabaseAnonKey.startsWith("PASTE");
  const sb = cfgOk ? window.supabase.createClient(cfg.supabaseUrl, cfg.supabaseAnonKey) : null;

  let session = null, profile = null;
  let route = { name: "square" };

  // Feed state
  let feedKind = "all";
  let posts = [], offset = 0, hasMore = false, feedToken = 0;
  let repliesByPost = {}, summary = {}, reviews = {}, myRatings = {};
  const openPosts = new Set();

  // Write state
  let writeKind = "secret", writeTopic = "other";

  // Messages state
  let conversations = [], chat = null, chatMessages = [], chatTimer = null, inboxTimer = null;

  // Admin
  let reports = [];

  // ───────── Routing ─────────
  function parseHash() {
    const parts = location.hash.replace(/^#\/?/, "").split("/");
    const name = parts[0] || "square";
    if (name === "topic" && GROUPS.emotion.concat(GROUPS.life).includes(parts[1])) return { name: "topic", topic: parts[1] };
    if (name === "chat" && /^\d+$/.test(parts[1] || "")) return { name: "chat", id: Number(parts[1]) };
    if (["square", "topics", "write", "messages", "admin"].includes(name)) return { name };
    return { name: "square" };
  }

  function show(view) {
    VIEWS.forEach(v => $("view-" + v).hidden = v !== view);
  }

  async function go() {
    route = parseHash();
    clearInterval(chatTimer); chatTimer = null;
    if (!cfgOk) { show(null); showSetup(); return; }
    $("tabs").hidden = !session;
    if (!session) { show("auth"); return; }
    if (route.name === "admin" && !profile?.is_admin) route = { name: "square" };
    const tab = route.name === "topic" ? "topics" : route.name === "chat" ? "messages" : route.name;
    document.querySelectorAll("[data-tab]").forEach(a => a.classList.toggle("on", a.dataset.tab === tab));
    window.scrollTo(0, 0);

    if (route.name === "square" || route.name === "topic") { show("feed"); renderFeedHead(); loadFeed(true); }
    if (route.name === "topics") { show("topics"); loadTopics(); }
    if (route.name === "write") { show("write"); renderWrite(); }
    if (route.name === "messages") { show("messages"); loadConversations(); }
    if (route.name === "chat") { show("chat"); openChat(route.id); }
    if (route.name === "admin") { show("admin"); loadReports(); }
  }
  window.addEventListener("hashchange", go);

  function applyLang() {
    document.documentElement.lang = lang === "zh" ? "zh-CN" : "en";
    document.title = lang === "zh" ? "树洞 Treehole" : "Treehole 树洞";
    document.querySelectorAll("[data-i18n]").forEach(el => el.textContent = t(el.dataset.i18n));
    document.querySelectorAll("[data-i18n-ph]").forEach(el => el.placeholder = t(el.dataset.i18nPh));
    document.querySelectorAll("[data-i18n-aria]").forEach(el => el.setAttribute("aria-label", t(el.dataset.i18nAria)));
    $("lang-toggle").textContent = lang === "zh" ? "EN" : "中文";
    if (cfg.emailCode === false) {
      document.querySelector('[data-i18n="sendLink"]').textContent = t("sendLinkOnly");
      document.querySelector('[data-i18n="signInHint"]').textContent = t("signInHintLink");
    }
    renderMe();
  }
  $("lang-toggle").onclick = () => {
    lang = lang === "zh" ? "en" : "zh";
    try { localStorage.setItem("lang", lang); } catch {}
    applyLang();
    rerender();
  };
  function rerender() {
    if (!session) return;
    if (route.name === "square" || route.name === "topic") { renderFeedHead(); renderFeed(); }
    if (route.name === "topics") loadTopics();
    if (route.name === "write") renderWrite();
    if (route.name === "messages") renderConversations();
    if (route.name === "chat") renderChat();
    if (route.name === "admin") renderReports();
  }

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
    $("sign-out").hidden = !session;
    $("tab-admin").hidden = !profile?.is_admin;
    renderMe();
    clearInterval(inboxTimer);
    if (session) { refreshUnread(); inboxTimer = setInterval(refreshUnread, 20000); }
    go();
  }

  function renderMe() {
    const me = $("me");
    me.hidden = !profile;
    if (profile) me.textContent = profile.nickname;
    me.title = t("yourNick") + (profile?.nickname || "");
  }

  $("auth-form").onsubmit = async e => {
    e.preventDefault();
    const btn = e.submitter; btn.disabled = true;
    const { error } = await sb.auth.signInWithOtp({
      email: $("auth-email").value.trim(),
      options: { emailRedirectTo: location.origin + location.pathname },
    });
    btn.disabled = false;
    // The code box only makes sense once the Supabase email template includes {{ .Token }} (needs custom SMTP).
    setStatus($("auth-status"), error ? errText(error) : t(cfg.emailCode !== false ? "linkSent" : "linkOnlySent"), !!error);
    if (!error && cfg.emailCode !== false) { $("code-form").hidden = false; $("auth-code").focus(); }
  };
  $("code-form").onsubmit = async e => {
    e.preventDefault();
    const btn = e.submitter; btn.disabled = true;
    const { error } = await sb.auth.verifyOtp({
      email: $("auth-email").value.trim(),
      token: $("auth-code").value.trim(),
      type: "email",
    });
    btn.disabled = false;
    if (error) setStatus($("auth-status"), t("codeWrong"), true);
  };
  $("sign-out").onclick = async () => { await sb.auth.signOut(); location.hash = "#/square"; };

  // ───────── Feed (Square and single topic) ─────────
  function renderFeedHead() {
    const isTopic = route.name === "topic";
    $("feed-back").hidden = !isTopic;
    $("feed-title").textContent = isTopic ? "#" + t("topics")[route.topic] : t("squareTitle");
    $("feed-sub").textContent = isTopic ? "" : t("squareSub");
    $("kind-filter").innerHTML = ["all", ...KINDS].map(k =>
      `<button type="button" role="radio" class="chip filter" aria-checked="${k === feedKind}" data-kind="${k}">${esc(k === "all" ? t("all") : t("kinds")[k])}</button>`
    ).join("");
  }
  $("kind-filter").onclick = e => {
    const b = e.target.closest("[data-kind]"); if (!b) return;
    feedKind = b.dataset.kind; renderFeedHead(); loadFeed(true);
  };

  async function loadFeed(reset) {
    const token = ++feedToken;
    if (reset) { offset = 0; posts = []; repliesByPost = {}; summary = {}; reviews = {}; $("feed").innerHTML = `<p class="muted center">…</p>`; }
    let q = sb.from("feed_posts").select("*").order("created_at", { ascending: false }).range(offset, offset + PAGE - 1);
    if (feedKind !== "all") q = q.eq("kind", feedKind);
    if (route.name === "topic") q = q.eq("topic", route.topic);
    const { data, error } = await q;
    if (token !== feedToken) return;
    if (error) { $("feed").innerHTML = `<p class="status err">${esc(t("loadError"))}</p>`; return; }
    posts = posts.concat(data);
    offset += data.length;
    hasMore = data.length === PAGE;
    await loadExtras(posts.map(p => p.id));
    if (token !== feedToken) return;
    renderFeed();
  }

  async function loadExtras(postIds) {
    if (!postIds.length) return;
    const { data: reps } = await sb.from("feed_replies").select("*").in("post_id", postIds).order("created_at");
    repliesByPost = {};
    for (const id of postIds) repliesByPost[id] = [];
    (reps || []).forEach(r => (repliesByPost[r.post_id] ||= []).push(r));
    const replyIds = (reps || []).map(r => r.id);

    const sumQ = (type, ids) => ids.length ? sb.from("rating_summary").select("*").eq("target_type", type).in("target_id", ids) : { data: [] };
    const revQ = (type, ids) => ids.length ? sb.from("rating_comments").select("*").eq("target_type", type).in("target_id", ids).order("created_at", { ascending: false }) : { data: [] };
    const [s1, s2, c1, c2, mine] = await Promise.all([
      sumQ("post", postIds), sumQ("reply", replyIds), revQ("post", postIds), revQ("reply", replyIds),
      sb.from("ratings").select("target_type,target_id,helpful,comment"),
    ]);
    summary = {}; reviews = {}; myRatings = {};
    [...(s1.data || []), ...(s2.data || [])].forEach(s => summary[key(s.target_type, s.target_id)] = s);
    [...(c1.data || []), ...(c2.data || [])].forEach(c => (reviews[key(c.target_type, c.target_id)] ||= []).push(c));
    (mine.data || []).forEach(r => myRatings[key(r.target_type, r.target_id)] = r);
  }

  function itemActions(type, item) {
    const k = key(type, item.id), s = summary[k], mineR = myRatings[k];
    const rev = reviews[k] || [];
    const btn = (act, label) => `<button type="button" class="link" data-act="${act}" data-type="${type}" data-id="${item.id}">${esc(label)}</button>`;
    return `
      <div class="actions">
        <span class="score" title="${esc(t("helpful"))} / ${esc(t("unhelpful"))}">
          <span class="up${mineR?.helpful === true ? " on" : ""}">▲ ${s?.helpful_count || 0}</span>
          <span class="down${mineR?.helpful === false ? " on" : ""}">▼ ${s?.unhelpful_count || 0}</span>
        </span>
        ${item.mine ? btn("delete", t("del")) : btn("dm", t("dm")) + btn("rate", t("rate")) + btn("report", t("report"))}
      </div>
      ${rev.length ? `<details class="reviews"><summary>${esc(t("reviews", rev.length))}</summary>
        <ul>${rev.map(c => `<li><span class="${c.helpful ? "up" : "down"}">${c.helpful ? "▲" : "▼"}</span> ${esc(c.comment)}</li>`).join("")}</ul></details>` : ""}`;
  }

  function renderFeed() {
    $("more").hidden = !hasMore;
    if (!posts.length) {
      $("feed").innerHTML = `<p class="empty">${esc(feedKind === "all" && route.name === "square" ? t("empty") : t("emptyFilter"))}</p>`;
      return;
    }
    $("feed").innerHTML = posts.map(p => {
      const reps = repliesByPost[p.id] || [];
      const open = openPosts.has(p.id);
      return `<article class="post${p.hidden ? " is-hidden" : ""}">
        <div class="meta">
          ${kindChip(p.kind)} ${topicChip(p.topic)}
          <span class="nick">${esc(p.nickname)}${p.mine ? ` <em>(${esc(t("you"))})</em>` : ""}</span>
          <time datetime="${esc(p.created_at)}">${esc(ago(p.created_at))}</time>
          ${p.hidden ? `<span class="flag">${esc(t("hidden"))}</span>` : ""}
        </div>
        <p class="body">${esc(p.body)}</p>
        ${itemActions("post", p)}
        <button type="button" class="toggle" data-act="toggle" data-id="${p.id}" aria-expanded="${open}">
          ${esc(open ? t("hideComments") : (reps.length ? t("comments", reps.length) : t("comment")))}
        </button>
        ${open ? `<div class="replies">
          ${reps.map(r => `<div class="reply${r.hidden ? " is-hidden" : ""}">
            <div class="meta"><span class="nick">${esc(r.nickname)}${r.mine ? ` <em>(${esc(t("you"))})</em>` : ""}</span>
              <time datetime="${esc(r.created_at)}">${esc(ago(r.created_at))}</time>
              ${r.hidden ? `<span class="flag">${esc(t("hidden"))}</span>` : ""}</div>
            <p class="body">${esc(r.body)}</p>
            ${itemActions("reply", r)}
          </div>`).join("")}
          <form class="reply-form" data-post="${p.id}">
            <label class="sr" for="reply-${p.id}">${esc(t("comment"))}</label>
            <textarea id="reply-${p.id}" maxlength="1000" rows="2" required placeholder="${esc(t("commentPh"))}"></textarea>
            <div class="row between"><p class="status" role="status"></p><button type="submit" class="primary small">${esc(t("send"))}</button></div>
          </form>
        </div>` : ""}
      </article>`;
    }).join("");
  }

  $("more").onclick = () => loadFeed(false);

  $("feed").onclick = async e => {
    const b = e.target.closest("[data-act]"); if (!b) return;
    const id = Number(b.dataset.id), type = b.dataset.type;
    const act = b.dataset.act;
    if (act === "toggle") { openPosts.has(id) ? openPosts.delete(id) : openPosts.add(id); renderFeed(); return; }
    if (act === "rate") rateDialog(type, id);
    if (act === "report") reportDialog(type, id);
    if (act === "dm") {
      b.disabled = true;
      const { data, error } = await sb.rpc("start_conversation", { p_type: type, p_id: id });
      b.disabled = false;
      if (error) return alertDialog(errText(error));
      location.hash = "#/chat/" + data;
    }
    if (act === "delete") confirmDialog(t("del"), t("confirmDel"), async () => {
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
    await loadExtras(posts.map(p => p.id));
    renderFeed();
  };

  // ───────── Topics ─────────
  async function loadTopics() {
    const { data } = await sb.from("topic_counts").select("*");
    const counts = {};
    (data || []).forEach(r => counts[r.topic] = r.n);
    const group = (title, list) => `<h2 class="group-title">${esc(title)}</h2>
      <div class="topic-grid">${list.map(tp => `<a class="topic-card topic-${tp}" href="#/topic/${tp}">
        <span class="topic-name">#${esc(t("topics")[tp])}</span>
        <span class="topic-count">${esc(t("topicCount", counts[tp] || 0))}</span></a>`).join("")}</div>`;
    $("topic-groups").innerHTML = group(t("groupEmotion"), GROUPS.emotion) + group(t("groupLife"), GROUPS.life);
  }

  // ───────── Write ─────────
  function renderWrite() {
    $("write-kind").innerHTML = KINDS.map(k =>
      `<button type="button" role="radio" class="chip filter" aria-checked="${k === writeKind}" data-kind="${k}">${esc(t("kinds")[k])}</button>`).join("");
    $("write-topic").innerHTML = GROUPS.emotion.concat(GROUPS.life).map(tp =>
      `<button type="button" role="radio" class="chip filter topic-${tp}" aria-checked="${tp === writeTopic}" data-topic="${tp}">#${esc(t("topics")[tp])}</button>`).join("");
  }
  $("write-kind").onclick = e => { const b = e.target.closest("[data-kind]"); if (b) { writeKind = b.dataset.kind; renderWrite(); } };
  $("write-topic").onclick = e => { const b = e.target.closest("[data-topic]"); if (b) { writeTopic = b.dataset.topic; renderWrite(); } };
  $("post-body").oninput = e => $("post-count").textContent = `${e.target.value.length} / 2000`;
  $("post-form").onsubmit = async e => {
    e.preventDefault();
    const body = $("post-body").value.trim(); if (!body) return;
    const btn = e.submitter; btn.disabled = true;
    const { error } = await sb.from("posts").insert({ body, kind: writeKind, topic: writeTopic });
    btn.disabled = false;
    if (error) return setStatus($("post-status"), errText(error), true);
    $("post-body").value = ""; $("post-count").textContent = "0 / 2000";
    setStatus($("post-status"), "");
    feedKind = "all";
    location.hash = "#/square";
  };

  // ───────── Messages ─────────
  async function refreshUnread() {
    const { data } = await sb.from("my_conversations").select("id,unread");
    const n = (data || []).reduce((s, c) => s + Number(c.unread || 0), 0);
    $("unread-badge").hidden = !n;
    $("unread-badge").textContent = n > 99 ? "99+" : String(n);
  }

  async function loadConversations() {
    const { data, error } = await sb.from("my_conversations").select("*").order("last_message_at", { ascending: false });
    if (error) { $("conv-list").innerHTML = `<p class="status err">${esc(t("loadError"))}</p>`; return; }
    conversations = data;
    renderConversations();
    refreshUnread();
  }

  function renderConversations() {
    if (!conversations.length) { $("conv-list").innerHTML = `<p class="empty">${esc(t("noConversations"))}</p>`; return; }
    $("conv-list").innerHTML = `<ul class="conv-list">${conversations.map(c => `<li>
      <a class="conv${c.unread > 0 ? " unread" : ""}" href="#/chat/${c.id}">
        <span class="conv-top"><span class="nick">${esc(c.other_nickname)}</span><time>${esc(ago(c.last_message_at))}</time></span>
        <span class="conv-last">${c.blocked ? "🚫 " : ""}${esc(c.last_body || t("noMessagesYet"))}</span>
        ${c.unread > 0 ? `<span class="badge">${c.unread}</span>` : ""}
      </a></li>`).join("")}</ul>`;
  }

  async function openChat(id) {
    chat = null; chatMessages = [];
    $("chat-log").innerHTML = `<p class="muted center">…</p>`;
    const { data } = await sb.from("my_conversations").select("*").eq("id", id).maybeSingle();
    if (!data) { location.hash = "#/messages"; return; }
    chat = data;
    await loadMessages(true);
    chatTimer = setInterval(() => loadMessages(false), 4000);
  }

  async function loadMessages(scroll) {
    if (!chat) return;
    const id = chat.id;
    const [{ data: msgs }, { data: conv }] = await Promise.all([
      sb.from("messages").select("id,body,created_at,sender_id").eq("conversation_id", id).order("created_at"),
      sb.from("my_conversations").select("*").eq("id", id).maybeSingle(),
    ]);
    if (!chat || chat.id !== id) return;
    const changed = (msgs || []).length !== chatMessages.length || conv?.blocked !== chat.blocked;
    chatMessages = msgs || [];
    if (conv) chat = conv;
    if (changed || scroll) {
      const log = $("chat-log");
      const atBottom = log.scrollHeight - log.scrollTop - log.clientHeight < 60;
      renderChat();
      if (scroll || atBottom) log.scrollTop = log.scrollHeight;
    }
    if (chat.unread > 0) { await sb.rpc("mark_read", { conv: id }); refreshUnread(); }
  }

  function renderChat() {
    if (!chat) return;
    const me = session.user.id;
    $("chat-title").textContent = chat.other_nickname;
    $("chat-block").textContent = chat.blocked_by_me ? t("unblock") : t("block");
    $("chat-block").hidden = chat.blocked && !chat.blocked_by_me;
    $("chat-blocked").hidden = !chat.blocked;
    $("chat-blocked").textContent = chat.blocked_by_me ? t("blockedByMe") : t("blockedByOther");
    $("chat-form").hidden = chat.blocked;
    $("chat-log").innerHTML = chatMessages.length ? chatMessages.map(m => {
      const mine = m.sender_id === me;
      return `<div class="bubble-row${mine ? " mine" : ""}">
        <div class="bubble">${esc(m.body)}</div>
        <div class="bubble-meta"><time>${esc(ago(m.created_at))}</time>
          ${mine ? "" : `<button type="button" class="link" data-report-msg="${m.id}">${esc(t("report"))}</button>`}</div>
      </div>`;
    }).join("") : `<p class="empty">${esc(t("chatEmpty"))}</p>`;
  }

  $("chat-log").onclick = e => {
    const b = e.target.closest("[data-report-msg]");
    if (b) reportDialog("message", Number(b.dataset.reportMsg));
  };
  $("chat-block").onclick = () => {
    if (!chat) return;
    const on = !chat.blocked_by_me;
    const run = async () => {
      const { error } = await sb.rpc("set_block", { conv: chat.id, on_off: on });
      if (error) return alertDialog(errText(error));
      loadMessages(false);
    };
    on ? confirmDialog(t("block"), t("confirmBlock"), run) : run();
  };
  $("chat-input").addEventListener("keydown", e => {
    if (e.key === "Enter" && !e.shiftKey && !e.isComposing) { e.preventDefault(); $("chat-form").requestSubmit(); }
  });
  $("chat-form").onsubmit = async e => {
    e.preventDefault();
    if (!chat) return;
    const body = $("chat-input").value.trim(); if (!body) return;
    const btn = $("chat-form").querySelector("button"); btn.disabled = true;
    const { error } = await sb.from("messages").insert({ conversation_id: chat.id, body });
    btn.disabled = false;
    if (error) return setStatus($("chat-status"), errText(error), true);
    setStatus($("chat-status"), "");
    $("chat-input").value = "";
    loadMessages(true);
  };

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
  function confirmDialog(title, msg, onYes) {
    openDialog(title, `<p>${esc(msg)}</p><div class="row end">
      <button type="button" class="ghost" data-close>${esc(t("cancel"))}</button>
      <button type="button" class="danger" id="dlg-yes">${esc(t("yes"))}</button></div>`);
    $("dlg-yes").onclick = async () => { closeDialog(); await onYes(); };
  }

  function rateDialog(type, id) {
    const prev = myRatings[key(type, id)];
    let helpful = prev ? prev.helpful : null;
    openDialog(t("rateTitle"), `<p class="muted">${esc(t("rateHint"))}</p>
      <div class="row" role="radiogroup" aria-label="${esc(t("rateTitle"))}">
        <button type="button" class="chip filter big" role="radio" data-h="1" aria-checked="${helpful === true}">▲ ${esc(t("helpful"))}</button>
        <button type="button" class="chip filter big" role="radio" data-h="0" aria-checked="${helpful === false}">▼ ${esc(t("unhelpful"))}</button>
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
  const TABLE = { post: "posts", reply: "replies", message: "messages" };
  async function loadReports() {
    const { data, error } = await sb.from("reports").select("*").eq("resolved", false).order("created_at", { ascending: false });
    if (error) { reports = []; renderReports(); return; }
    const ids = type => data.filter(r => r.target_type === type).map(r => r.target_id);
    const fetchT = (type, cols) => ids(type).length ? sb.from(TABLE[type]).select(cols).in("id", ids(type)) : { data: [] };
    const [p, r, m] = await Promise.all([
      fetchT("post", "id,body,hidden,author_id"),
      fetchT("reply", "id,body,hidden,author_id"),
      fetchT("message", "id,body,sender_id"),
    ]);
    const content = {};
    (p.data || []).forEach(x => content[key("post", x.id)] = x);
    (r.data || []).forEach(x => content[key("reply", x.id)] = x);
    (m.data || []).forEach(x => content[key("message", x.id)] = { ...x, author_id: x.sender_id });
    reports = data.map(rep => ({ ...rep, content: content[key(rep.target_type, rep.target_id)] }));
    renderReports();
  }

  function renderReports() {
    const el = $("report-list");
    if (!reports.length) { el.innerHTML = `<p class="empty">${esc(t("noReports"))}</p>`; return; }
    el.innerHTML = reports.map(r => `<div class="panel report">
      <div class="meta"><span class="chip kind">${esc(t("target")[r.target_type])}</span>
        <strong>${esc(t("reasons")[r.reason])}</strong><time>${esc(ago(r.created_at))}</time>
        ${r.content?.hidden ? `<span class="flag">${esc(t("hidden"))}</span>` : ""}</div>
      <p class="body">${r.content ? esc(r.content.body) : esc(t("deleted"))}</p>
      ${r.note ? `<p class="muted small">“${esc(r.note)}”</p>` : ""}
      <div class="row">
        ${r.content && r.target_type !== "message" ? `<button type="button" class="ghost small" data-admin="hide" data-rid="${r.id}">${esc(r.content.hidden ? t("unhide") : t("hide"))}</button>` : ""}
        ${r.content ? `<button type="button" class="danger small" data-admin="ban" data-rid="${r.id}">${esc(t("ban"))}</button>` : ""}
        <button type="button" class="primary small" data-admin="resolve" data-rid="${r.id}">${esc(t("resolve"))}</button>
      </div></div>`).join("");
  }

  $("report-list").onclick = async e => {
    const b = e.target.closest("[data-admin]"); if (!b) return;
    const rep = reports.find(r => r.id === Number(b.dataset.rid)); if (!rep) return;
    let res;
    if (b.dataset.admin === "hide") res = await sb.from(TABLE[rep.target_type]).update({ hidden: !rep.content.hidden }).eq("id", rep.target_id);
    if (b.dataset.admin === "ban") res = await sb.from("profiles").update({ banned: true }).eq("id", rep.content.author_id);
    if (b.dataset.admin === "resolve") res = await sb.from("reports").update({ resolved: true }).eq("id", rep.id);
    if (res?.error) return alertDialog(errText(res.error));
    loadReports();
  };

  // ───────── Start ─────────
  applyLang();
  if (!cfgOk) { showSetup(); }
  else {
    // Fires INITIAL_SESSION once on load, then again whenever someone signs in or out.
    sb.auth.onAuthStateChange((evt, s) => {
      if (evt === "INITIAL_SESSION" || (s?.user.id || null) !== (session?.user.id || null)) setTimeout(() => onSession(s), 0);
    });
  }
})();
