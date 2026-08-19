// ============================================================
// State
// ============================================================
const state = {
  user: null,
  trips: [],
  currentTrip: null,
  members: [],
  view: "dashboard",
  lastMessageId: 0,
  selectedSosType: "general",
  peer: { pc: null, channel: null, role: null },
};

let pollTimer = null;

// ============================================================
// Utilities
// ============================================================
function $(sel) { return document.querySelector(sel); }
function $all(sel) { return document.querySelectorAll(sel); }
function el(tag, attrs = {}, children = []) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === "class") e.className = v;
    else if (k === "html") e.innerHTML = v;
    else if (k.startsWith("on")) e.addEventListener(k.slice(2), v);
    else e.setAttribute(k, v);
  }
  (Array.isArray(children) ? children : [children]).forEach((c) => {
    if (c === null || c === undefined) return;
    e.appendChild(typeof c === "string" ? document.createTextNode(c) : c);
  });
  return e;
}
function fmtMoney(n) { return "₹" + Number(n).toLocaleString("en-IN", { maximumFractionDigits: 0 }); }
function fmtTime(iso) {
  const d = new Date(iso + "Z");
  return d.toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
}
function initials(name) { return (name || "?").split(" ").map((w) => w[0]).slice(0, 2).join("").toUpperCase(); }

function toast(message, type = "info") {
  const t = el("div", { class: "toast" + (type === "error" ? " error" : type === "sos" ? " sos" : "") }, message);
  $("#toast-container").appendChild(t);
  setTimeout(() => t.remove(), 5000);
}

function escapeHtml(s) {
  const d = document.createElement("div");
  d.textContent = s;
  return d.innerHTML;
}

// ============================================================
// Online/offline indicator
// ============================================================
function updateConnBadge() {
  const badge = $("#conn-badge");
  const text = $("#conn-text");
  if (navigator.onLine) {
    badge.classList.remove("offline");
    text.textContent = "Online";
  } else {
    badge.classList.add("offline");
    text.textContent = "Offline — will sync on reconnect";
  }
}
window.addEventListener("online", updateConnBadge);
window.addEventListener("offline", updateConnBadge);

// ============================================================
// Auth screen
// ============================================================
function showAuthScreen() {
  $("#auth-screen").classList.remove("hidden");
  $("#app-shell").classList.add("hidden");
}
function showAppShell() {
  $("#auth-screen").classList.add("hidden");
  $("#app-shell").classList.remove("hidden");
}

$all(".tab-btn").forEach((btn) => {
  btn.addEventListener("click", () => {
    $all(".tab-btn").forEach((b) => b.classList.remove("active"));
    btn.classList.add("active");
    const tab = btn.dataset.tab;
    $("#login-form").classList.toggle("hidden", tab !== "login");
    $("#register-form").classList.toggle("hidden", tab !== "register");
  });
});

$("#login-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const errEl = $("#login-error");
  errEl.textContent = "";
  try {
    const data = await Api.login({
      email: $("#login-email").value.trim(),
      password: $("#login-password").value,
    });
    Api.setToken(data.token);
    state.user = data.user;
    await bootApp();
  } catch (err) {
    errEl.textContent = err.error || "Login failed";
  }
});

$("#register-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const errEl = $("#reg-error");
  errEl.textContent = "";
  try {
    const data = await Api.register({
      name: $("#reg-name").value.trim(),
      email: $("#reg-email").value.trim(),
      password: $("#reg-password").value,
    });
    Api.setToken(data.token);
    state.user = data.user;
    await bootApp();
  } catch (err) {
    errEl.textContent = err.error || "Registration failed";
  }
});

$("#logout-btn").addEventListener("click", () => {
  Api.setToken(null);
  state.user = null;
  state.currentTrip = null;
  resetPeerConnection();
  clearInterval(pollTimer);
  showAuthScreen();
});

// ============================================================
// Navigation
// ============================================================
const VIEW_TITLES = {
  dashboard: "Dashboard", "trip-room": "Trip Room", budget: "Budget",
  checklist: "Checklist", itinerary: "Itinerary", chat: "Chat",
  safety: "Safety", sos: "SOS", ai: "AI Assistant", notifications: "Notifications",
};

function goToView(view) {
  if (view !== "dashboard" && !state.currentTrip) {
    toast("Select a trip first", "error");
    view = "dashboard";
  }
  state.view = view;
  $all(".nav-item").forEach((b) => b.classList.toggle("active", b.dataset.view === view));
  $all(".view").forEach((v) => v.classList.add("hidden"));
  $(`#view-${view}`).classList.remove("hidden");
  $("#view-title").textContent = VIEW_TITLES[view];
  loadView(view);
}

$all(".nav-item").forEach((btn) => btn.addEventListener("click", () => goToView(btn.dataset.view)));

function loadView(view) {
  if (view === "dashboard") renderDashboard();
  if (view === "trip-room") renderTripRoom();
  if (view === "budget") renderBudget();
  if (view === "checklist") renderChecklist();
  if (view === "itinerary") renderItinerary();
  if (view === "chat") renderChat();
  if (view === "safety") renderSafety();
  if (view === "sos") renderSos();
  if (view === "ai") renderAiHistoryPlaceholder();
  if (view === "notifications") renderNotifications();
}

// ============================================================
// Modals
// ============================================================
function openModal(id) {
  $("#modal-backdrop").classList.remove("hidden");
  $all(".modal").forEach((m) => m.classList.add("hidden"));
  $("#" + id).classList.remove("hidden");
}
function closeModal() { $("#modal-backdrop").classList.add("hidden"); }
$all("[data-close-modal]").forEach((b) => b.addEventListener("click", closeModal));
$("#modal-backdrop").addEventListener("click", (e) => { if (e.target.id === "modal-backdrop") closeModal(); });

$("#open-create-trip").addEventListener("click", () => openModal("create-trip-modal"));
$("#open-join-trip").addEventListener("click", () => openModal("join-trip-modal"));

$("#create-trip-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  try {
    await Api.createTrip({
      name: $("#ct-name").value.trim(),
      destination: $("#ct-destination").value.trim(),
      start_date: $("#ct-start").value,
      end_date: $("#ct-end").value,
      safety_radius: parseInt($("#ct-radius").value) || 100,
    });
    closeModal();
    e.target.reset();
    toast("Trip created");
    await refreshTrips();
    renderDashboard();
  } catch (err) { toast(err.error, "error"); }
});

$("#join-trip-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  try {
    const data = await Api.joinTrip($("#jt-code").value.trim());
    closeModal();
    e.target.reset();
    toast(`Joined ${data.trip.name}`);
    await refreshTrips();
    selectTrip(data.trip.id);
  } catch (err) { toast(err.error, "error"); }
});

// ============================================================
// Trip switcher
// ============================================================
$("#trip-switcher-btn").addEventListener("click", () => goToView("dashboard"));

async function refreshTrips() {
  const data = await Api.listTrips();
  state.trips = data.trips;
}

function selectTrip(tripId) {
  const trip = state.trips.find((t) => t.id === tripId);
  if (!trip) return;
  if (state.currentTrip && state.currentTrip.id !== trip.id) resetPeerConnection();
  state.currentTrip = trip;
  state.lastMessageId = 0;
  $("#current-trip-name").textContent = trip.name;
  goToView("trip-room");
}

// ============================================================
// Dashboard
// ============================================================
function renderDashboard() {
  const grid = $("#trip-grid");
  grid.innerHTML = "";
  if (!state.trips.length) {
    grid.appendChild(el("div", { class: "empty-state" }, "No trips yet — create one or join with a code."));
    return;
  }
  state.trips.forEach((trip) => {
    const card = el("div", { class: "trip-card", onclick: () => selectTrip(trip.id) }, [
      el("h3", {}, trip.name),
      el("div", { class: "code" }, trip.code),
      el("div", { class: "meta" }, [
        el("span", {}, trip.destination || "—"),
        el("span", {}, `${trip.member_count} member${trip.member_count === 1 ? "" : "s"}`),
      ]),
    ]);
    grid.appendChild(card);
  });
}

// ============================================================
// Trip room
// ============================================================
async function renderTripRoom() {
  const trip = state.currentTrip;
  if (!trip) return;
  const info = $("#trip-room-info");
  info.innerHTML = "";
  info.appendChild(el("h2", { style: "font-family:var(--font-display); margin:0 0 6px" }, trip.name));
  info.appendChild(el("div", { class: "code", style: "font-size:14px; margin-bottom:8px" }, `Join code: ${trip.code}`));
  info.appendChild(el("div", { class: "muted" }, `${trip.destination || "No destination set"} · Safety radius ${trip.safety_radius}m · Your role: ${trip.my_role}`));

  const membersData = await Api.listMembers(trip.id);
  state.members = membersData.members;
  const list = $("#member-list");
  list.innerHTML = "";
  state.members.forEach((m) => {
    const row = el("div", { class: "member-row" }, [
      el("div", { class: "avatar", style: `background:${m.color}` }, initials(m.name)),
      el("div", {}, [
        el("div", { class: "member-name" }, m.name + (m.user_id === state.user.id ? " (you)" : "")),
        el("div", { class: "member-role" }, m.role.replace("_", "-")),
      ]),
      el("div", { class: "member-status status-" + m.status }, [
        el("span", { class: "status-dot" }),
        m.status === "connected" ? "Connected" : "Out of range",
      ]),
      el("div", { class: "battery-tag" }, m.battery !== null ? `🔋${m.battery}%` : ""),
    ]);
    list.appendChild(row);
  });
}

// ============================================================
// Budget
// ============================================================
$("#expense-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const amount = parseFloat($("#exp-amount").value);
  if (!amount || amount <= 0) return toast("Enter a valid amount", "error");
  try {
    await Api.addExpense(state.currentTrip.id, {
      description: $("#exp-desc").value.trim(),
      category: $("#exp-category").value,
      amount,
    });
    e.target.reset();
    toast("Expense added");
    renderBudget();
  } catch (err) { toast(err.error, "error"); }
});

async function renderBudget() {
  const trip = state.currentTrip;
  if (!trip) return;
  const data = await Api.getBudget(trip.id);

  const catBox = $("#category-breakdown");
  catBox.innerHTML = "";
  const total = Object.values(data.by_category).reduce((a, b) => a + b, 0) || 1;
  Object.entries(data.by_category).forEach(([cat, amt]) => {
    catBox.appendChild(el("div", { class: "cat-bar-row" }, [
      el("span", { style: "width:80px" }, cat),
      el("div", { class: "cat-bar-track" }, el("div", { class: "cat-bar-fill", style: `width:${(amt / total) * 100}%` })),
      el("span", { style: "font-family:var(--font-mono); font-size:12px" }, fmtMoney(amt)),
    ]));
  });
  if (!Object.keys(data.by_category).length) catBox.appendChild(el("div", { class: "muted" }, "No expenses yet"));

  const s = data.settlement;
  $("#settlement-summary").innerHTML = "";
  $("#settlement-summary").appendChild(el("div", { class: "balance-row" }, [el("b", {}, "Total spent"), fmtMoney(s.total)]));
  $("#settlement-summary").appendChild(el("div", { class: "balance-row" }, [el("b", {}, "Equal share / person"), fmtMoney(s.share_per_person)]));
  s.balances.forEach((b) => {
    $("#settlement-summary").appendChild(el("div", { class: "balance-row" }, [
      b.name + (b.user_id === state.user.id ? " (you)" : ""),
      el("span", { class: b.balance >= 0 ? "positive" : "negative" }, (b.balance >= 0 ? "+" : "") + fmtMoney(b.balance)),
    ]));
  });

  const setList = $("#settlement-list");
  setList.innerHTML = "";
  if (!s.settlements.length) setList.appendChild(el("div", { class: "muted" }, "Everyone's settled up."));
  s.settlements.forEach((st) => {
    setList.appendChild(el("div", { class: "settle-row" }, `${st.from_name} owes ${st.to_name} ${fmtMoney(st.amount)}`));
  });

  const expList = $("#expense-list");
  expList.innerHTML = "";
  if (!data.expenses.length) expList.appendChild(el("div", { class: "empty-state" }, "No expenses logged yet."));
  data.expenses.forEach((e) => {
    expList.appendChild(el("div", { class: "expense-row" }, [
      el("span", { class: "cat-tag" }, e.category),
      el("span", { class: "desc" }, e.description || "—"),
      el("span", { class: "who" }, e.user_name),
      el("span", { class: "amount" }, fmtMoney(e.amount)),
    ]));
  });
}

// ============================================================
// Checklist
// ============================================================
$("#checklist-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const text = $("#checklist-text").value.trim();
  if (!text) return;
  try {
    await Api.addChecklistItem(state.currentTrip.id, text);
    e.target.reset();
    renderChecklist();
  } catch (err) { toast(err.error, "error"); }
});

async function renderChecklist() {
  const trip = state.currentTrip;
  if (!trip) return;
  const data = await Api.getChecklist(trip.id);
  const list = $("#checklist-list");
  list.innerHTML = "";
  if (!data.items.length) list.appendChild(el("div", { class: "empty-state" }, "Nothing on the checklist yet."));
  data.items.forEach((item) => {
    const row = el("div", { class: "checklist-row" }, [
      el("div", { class: "check-left", onclick: async () => { await Api.toggleChecklistItem(item.id); renderChecklist(); } }, [
        el("div", { class: "checkbox" + (item.is_done ? " done" : "") }, item.is_done ? "✓" : ""),
        el("span", { class: "check-text" + (item.is_done ? " done" : "") }, item.text),
      ]),
    ]);
    list.appendChild(row);
  });
}

// ============================================================
// Itinerary
// ============================================================
$("#itinerary-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const title = $("#it-title").value.trim();
  if (!title) return;
  try {
    await Api.addItineraryItem(state.currentTrip.id, {
      day: parseInt($("#it-day").value) || 1,
      time: $("#it-time").value.trim(),
      title,
      location: $("#it-location").value.trim(),
      notes: $("#it-notes").value.trim(),
    });
    e.target.reset();
    $("#it-day").value = 1;
    toast("Added to itinerary");
    renderItinerary();
  } catch (err) { toast(err.error, "error"); }
});

async function renderItinerary() {
  const trip = state.currentTrip;
  if (!trip) return;
  const data = await Api.getItinerary(trip.id);
  const box = $("#itinerary-list");
  box.innerHTML = "";
  if (!data.items.length) { box.appendChild(el("div", { class: "empty-state" }, "No itinerary items yet.")); return; }
  let currentDay = null;
  data.items.forEach((item) => {
    if (item.day !== currentDay) {
      currentDay = item.day;
      box.appendChild(el("div", { class: "itinerary-day-label" }, `Day ${currentDay}`));
    }
    box.appendChild(el("div", { class: "itinerary-row" }, [
      item.time ? el("span", { class: "it-time" }, item.time) : null,
      el("span", { class: "it-title" }, item.title),
      item.location ? el("span", { class: "it-loc" }, item.location) : null,
    ]));
  });
}

// ============================================================
// Chat + offline WebRTC direct messaging
// ============================================================
const OFFLINE_CHAT_PREFIX = "travelmate.offline.chat.";

function offlineChatKey() {
  return OFFLINE_CHAT_PREFIX + (state.currentTrip ? state.currentTrip.id : "none");
}

function getOfflineMessages() {
  try { return JSON.parse(localStorage.getItem(offlineChatKey()) || "[]"); }
  catch (e) { return []; }
}

function saveOfflineMessage(message) {
  const list = getOfflineMessages();
  if (!list.some((m) => m.local_id === message.local_id)) {
    list.push(message);
    localStorage.setItem(offlineChatKey(), JSON.stringify(list.slice(-500)));
  }
}

function setPeerStatus(text, mode = "") {
  const node = $("#offline-peer-status");
  node.textContent = text;
  node.className = "peer-status" + (mode ? " " + mode : "");
}

function appendChatMessage(m) {
  const box = $("#chat-messages");
  const mine = m.user_id === state.user.id || m.user_id === "local-" + state.user.id;
  const node = el("div", { class: "chat-msg" + (mine ? " mine" : "") }, [
    el("div", { class: "who" }, mine ? "You" : (m.user_name || "Friend")),
    el("div", { class: "bubble" }, m.text),
  ]);
  box.appendChild(node);
  box.scrollTop = box.scrollHeight;
}

function renderOfflineHistory() {
  const list = getOfflineMessages();
  list.forEach(appendChatMessage);
}

function resetPeerConnection() {
  if (state.peer.channel) {
    try { state.peer.channel.close(); } catch (e) {}
  }
  if (state.peer.pc) {
    try { state.peer.pc.close(); } catch (e) {}
  }
  state.peer = { pc: null, channel: null, role: null };
  setPeerStatus("Not connected");
}

function waitForIceGathering(pc) {
  if (pc.iceGatheringState === "complete") return Promise.resolve();
  return new Promise((resolve) => {
    const done = () => {
      if (pc.iceGatheringState === "complete") {
        pc.removeEventListener("icegatheringstatechange", done);
        resolve();
      }
    };
    pc.addEventListener("icegatheringstatechange", done);
    setTimeout(() => { pc.removeEventListener("icegatheringstatechange", done); resolve(); }, 10000);
  });
}

function createPeer(role) {
  resetPeerConnection();
  const pc = new RTCPeerConnection({ iceServers: [] });
  state.peer.pc = pc;
  state.peer.role = role;
  setPeerStatus("Connecting…", "connecting");

  pc.onconnectionstatechange = () => {
    const s = pc.connectionState;
    if (s === "connected") setPeerStatus("Direct chat connected", "connected");
    else if (["failed", "disconnected", "closed"].includes(s)) setPeerStatus("Not connected");
  };
  pc.ondatachannel = (event) => setupDataChannel(event.channel);
  return pc;
}

function setupDataChannel(channel) {
  state.peer.channel = channel;
  channel.onopen = () => setPeerStatus("Direct chat connected", "connected");
  channel.onclose = () => setPeerStatus("Not connected");
  channel.onerror = () => toast("Offline chat connection error", "error");
  channel.onmessage = (event) => {
    try {
      const m = JSON.parse(event.data);
      if (!m || !m.text) return;
      const message = {
        local_id: m.local_id || crypto.randomUUID(),
        user_id: m.user_id || "peer",
        user_name: m.user_name || "Friend",
        text: String(m.text).slice(0, 2000),
        created_at: m.created_at || new Date().toISOString(),
        offline: true,
      };
      saveOfflineMessage(message);
      appendChatMessage(message);
    } catch (e) { /* ignore malformed direct messages */ }
  };
}

async function createOfflineOffer() {
  if (!window.RTCPeerConnection) return toast("This browser does not support direct offline chat", "error");
  const pc = createPeer("offerer");
  setupDataChannel(pc.createDataChannel("travelmate-chat", { ordered: true }));
  const offer = await pc.createOffer();
  await pc.setLocalDescription(offer);
  await waitForIceGathering(pc);
  $("#offer-code").value = JSON.stringify(pc.localDescription);
  $("#answer-code-input").value = "";
  $("#offline-pairing").classList.remove("hidden");
  $("#offer-step").classList.remove("hidden");
  $("#answer-step").classList.add("hidden");
  toast("Connection code created. Send it to your friend.");
}

async function createOfflineAnswer() {
  if (!window.RTCPeerConnection) return toast("This browser does not support direct offline chat", "error");
  let offer;
  try { offer = JSON.parse($("#offer-code-input").value.trim()); }
  catch (e) { return toast("Invalid connection code", "error"); }
  const pc = createPeer("answerer");
  try {
    await pc.setRemoteDescription(offer);
    const answer = await pc.createAnswer();
    await pc.setLocalDescription(answer);
    await waitForIceGathering(pc);
    $("#answer-code").value = JSON.stringify(pc.localDescription);
    $("#offline-pairing").classList.remove("hidden");
    $("#answer-step").classList.remove("hidden");
    $("#offer-step").classList.add("hidden");
    toast("Answer created. Send it back to the person who created the connection.");
  } catch (e) {
    resetPeerConnection();
    toast("Could not create the answer. Make sure the code is complete.", "error");
  }
}

async function applyOfflineAnswer() {
  if (!state.peer.pc || state.peer.role !== "offerer") return toast("Create a connection first", "error");
  let answer;
  try { answer = JSON.parse($("#answer-code-input").value.trim()); }
  catch (e) { return toast("Invalid answer code", "error"); }
  try {
    await state.peer.pc.setRemoteDescription(answer);
    setPeerStatus("Connecting…", "connecting");
    toast("Answer applied. Waiting for direct connection…");
  } catch (e) { toast("Could not apply the answer", "error"); }
}

async function copyText(id) {
  const value = $(id).value;
  try { await navigator.clipboard.writeText(value); toast("Copied to clipboard"); }
  catch (e) { $(id).select(); document.execCommand("copy"); toast("Copied to clipboard"); }
}

$("#create-offer-btn").addEventListener("click", createOfflineOffer);
$("#use-offer-btn").addEventListener("click", () => {
  $("#offline-pairing").classList.remove("hidden");
  $("#offer-step").classList.add("hidden");
  $("#answer-step").classList.remove("hidden");
  $("#offer-code-input").focus();
});
$("#apply-answer-btn").addEventListener("click", applyOfflineAnswer);
$("#create-answer-btn").addEventListener("click", createOfflineAnswer);
$("#copy-offer-btn").addEventListener("click", () => copyText("#offer-code"));
$("#copy-answer-btn").addEventListener("click", () => copyText("#answer-code"));
$("#disconnect-peer-btn").addEventListener("click", () => { resetPeerConnection(); toast("Direct chat disconnected"); });
$("#close-pairing-btn").addEventListener("click", () => $("#offline-pairing").classList.add("hidden"));

$("#chat-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const text = $("#chat-text").value.trim();
  if (!text || !state.currentTrip) return;
  $("#chat-text").value = "";

  if (state.peer.channel && state.peer.channel.readyState === "open") {
    const message = {
      local_id: crypto.randomUUID(),
      user_id: "local-" + state.user.id,
      user_name: state.user.name,
      text,
      created_at: new Date().toISOString(),
      offline: true,
    };
    saveOfflineMessage(message);
    appendChatMessage(message);
    state.peer.channel.send(JSON.stringify(message));
    return;
  }

  try {
    await Api.sendMessage(state.currentTrip.id, text);
    await pollChat();
  } catch (err) {
    const message = {
      local_id: crypto.randomUUID(), user_id: "local-" + state.user.id,
      user_name: state.user.name, text, created_at: new Date().toISOString(), offline: true,
    };
    saveOfflineMessage(message);
    appendChatMessage(message);
    toast("Saved on this phone. Pair with a friend for true device-to-device offline delivery.", "error");
  }
});

async function renderChat() {
  const trip = state.currentTrip;
  if (!trip) return;
  $("#chat-messages").innerHTML = "";
  state.lastMessageId = 0;
  renderOfflineHistory();
  if (navigator.onLine) await pollChat();
}

async function pollChat() {
  if (!state.currentTrip || state.view !== "chat" || !navigator.onLine) return;
  try {
    const data = await Api.getMessages(state.currentTrip.id, state.lastMessageId);
    data.messages.forEach((m) => {
      appendChatMessage(m);
      state.lastMessageId = m.id;
    });
  } catch (e) { /* offline/server unavailable */ }
}

// ============================================================
// Safety
// ============================================================
$("#save-radius").addEventListener("click", async () => {
  try {
    await Api.setRadius(state.currentTrip.id, parseInt($("#radius-input").value) || 100);
    toast("Safety radius updated");
    state.currentTrip.safety_radius = parseInt($("#radius-input").value);
  } catch (err) { toast(err.error, "error"); }
});

$("#use-geo-btn").addEventListener("click", () => {
  if (!navigator.geolocation) return toast("Geolocation not supported by this browser", "error");
  navigator.geolocation.getCurrentPosition(
    (pos) => {
      $("#manual-lat").value = pos.coords.latitude.toFixed(5);
      $("#manual-lng").value = pos.coords.longitude.toFixed(5);
      toast("Location captured — click Update status to save");
    },
    () => toast("Couldn't get your location — enter it manually", "error")
  );
});

$("#save-location").addEventListener("click", async () => {
  try {
    const lat = parseFloat($("#manual-lat").value);
    const lng = parseFloat($("#manual-lng").value);
    const battery = parseInt($("#manual-battery").value);
    const res = await Api.updateLocation(state.currentTrip.id, {
      lat: isNaN(lat) ? undefined : lat,
      lng: isNaN(lng) ? undefined : lng,
      battery: isNaN(battery) ? undefined : battery,
    });
    toast(res.status === "out_of_range" ? "Status updated — you're marked OUT OF RANGE" : "Status updated — connected");
    renderSafety();
  } catch (err) { toast(err.error, "error"); }
});

async function renderSafety() {
  const trip = state.currentTrip;
  if (!trip) return;
  $("#radius-input").value = trip.safety_radius;
  const data = await Api.getSafety(trip.id);
  const list = $("#safety-alert-list");
  list.innerHTML = "";
  if (!data.alerts.length) list.appendChild(el("div", { class: "empty-state" }, "No safety alerts."));
  data.alerts.forEach((a) => {
    list.appendChild(el("div", { class: "alert-row" }, [
      el("span", { class: "cat-tag", style: "background:var(--accent-dim); color:var(--accent)" }, a.type),
      el("span", { class: "desc" }, a.message),
      el("span", { class: "who" }, fmtTime(a.created_at)),
    ]));
  });
}

// ============================================================
// SOS
// ============================================================
$all(".sos-type-btn").forEach((btn) => {
  btn.addEventListener("click", () => {
    $all(".sos-type-btn").forEach((b) => b.classList.remove("selected"));
    btn.classList.add("selected");
    state.selectedSosType = btn.dataset.type;
  });
});
$(".sos-type-btn[data-type='general']")?.classList.add("selected");

$("#trigger-sos-btn").addEventListener("click", async () => {
  if (!confirm("Send an SOS alert to the whole group right now?")) return;
  const send = async (lat, lng) => {
    try {
      await Api.triggerSos(state.currentTrip.id, {
        type: state.selectedSosType,
        note: $("#sos-note").value.trim(),
        lat, lng,
      });
      toast("SOS sent to your group", "sos");
      $("#sos-note").value = "";
      renderSos();
    } catch (err) { toast(err.error || "Couldn't send SOS", "error"); }
  };
  if (navigator.geolocation) {
    navigator.geolocation.getCurrentPosition(
      (pos) => send(pos.coords.latitude, pos.coords.longitude),
      () => send(undefined, undefined)
    );
  } else {
    send(undefined, undefined);
  }
});

async function renderSos() {
  const trip = state.currentTrip;
  if (!trip) return;
  const data = await Api.getSos(trip.id);
  const list = $("#sos-list");
  list.innerHTML = "";
  if (!data.alerts.length) list.appendChild(el("div", { class: "empty-state" }, "No SOS alerts yet."));
  data.alerts.forEach((a) => {
    const row = el("div", { class: "sos-row" + (a.status === "active" ? " active" : "") }, [
      el("div", { style: "flex:1" }, [
        el("div", { class: "sos-type" }, a.type),
        el("div", { style: "font-size:13px; margin-top:2px" }, `${a.user_name}${a.note ? " — " + a.note : ""}`),
        el("div", { class: "who" }, fmtTime(a.created_at)),
      ]),
      el("span", { class: "status-pill " + a.status }, a.status),
    ]);
    if (a.status === "active") {
      row.appendChild(el("button", {
        class: "btn btn-secondary btn-small",
        onclick: async () => { await Api.resolveSos(a.id); renderSos(); },
      }, "Mark resolved"));
    }
    list.appendChild(row);
  });
}

// ============================================================
// AI Assistant
// ============================================================
function renderAiHistoryPlaceholder() {
  if (!$("#ai-messages").childElementCount) {
    $("#ai-messages").appendChild(el("div", { class: "chat-msg ai" }, [
      el("div", { class: "who" }, "TravelMate AI"),
      el("div", { class: "bubble" }, "Ask me about your trip budget, packing, itinerary pacing, or safety planning."),
    ]));
  }
}

$("#ai-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const text = $("#ai-text").value.trim();
  if (!text) return;
  $("#ai-text").value = "";
  const box = $("#ai-messages");
  box.appendChild(el("div", { class: "chat-msg mine" }, [el("div", { class: "who" }, "You"), el("div", { class: "bubble" }, text)]));
  box.scrollTop = box.scrollHeight;
  try {
    const data = await Api.askAi(state.currentTrip.id, text);
    box.appendChild(el("div", { class: "chat-msg ai" }, [el("div", { class: "who" }, "TravelMate AI"), el("div", { class: "bubble" }, data.reply)]));
    box.scrollTop = box.scrollHeight;
  } catch (err) { toast(err.error, "error"); }
});

// ============================================================
// Notifications
// ============================================================
async function renderNotifications() {
  const data = await Api.getNotifications();
  const list = $("#notif-list");
  list.innerHTML = "";
  if (!data.notifications.length) list.appendChild(el("div", { class: "empty-state" }, "No notifications yet."));
  data.notifications.forEach((n) => {
    const row = el("div", { class: "notif-row" + (n.is_read ? "" : " unread"), onclick: async () => {
      if (!n.is_read) { await Api.readNotification(n.id); n.is_read = 1; updateNotifBadge(); renderNotifications(); }
    }}, [
      el("div", { class: "n-msg" }, n.message),
      el("div", { class: "n-time" }, fmtTime(n.created_at)),
    ]);
    list.appendChild(row);
  });
}

async function updateNotifBadge() {
  try {
    const data = await Api.getNotifications();
    const unread = data.notifications.filter((n) => !n.is_read).length;
    const badge = $("#notif-badge");
    if (unread > 0) { badge.textContent = unread; badge.classList.remove("hidden"); }
    else badge.classList.add("hidden");
  } catch (e) { /* ignore */ }
}

// ============================================================
// Polling loop (chat + notifications) — replaces websockets
// ============================================================
function startPolling() {
  clearInterval(pollTimer);
  pollTimer = setInterval(() => {
    if (!navigator.onLine) return;
    if (state.view === "chat") pollChat();
    updateNotifBadge();
  }, 4000);
}

// ============================================================
// Boot
// ============================================================
async function bootApp() {
  $("#me-chip").innerHTML = "";
  $("#me-chip").appendChild(el("div", { class: "avatar", style: `background:${state.user.color}; width:26px;height:26px;font-size:11px` }, initials(state.user.name)));
  $("#me-chip").appendChild(el("span", {}, state.user.name));
  showAppShell();
  updateConnBadge();
  await refreshTrips();
  goToView("dashboard");
  updateNotifBadge();
  startPolling();
}

(async function init() {
  if (Api.token) {
    try {
      const data = await Api.me();
      state.user = data.user;
      await bootApp();
      return;
    } catch (e) {
      Api.setToken(null);
    }
  }
  showAuthScreen();
})();
