const API_BASE = "/api";

const Api = {
  token: localStorage.getItem("tm_token") || null,

  setToken(t) {
    this.token = t;
    if (t) localStorage.setItem("tm_token", t);
    else localStorage.removeItem("tm_token");
  },

  async request(method, path, body) {
    const headers = { "Content-Type": "application/json" };
    if (this.token) headers["Authorization"] = "Bearer " + this.token;
    let res;
    try {
      res = await fetch(API_BASE + path, {
        method,
        headers,
        body: body !== undefined ? JSON.stringify(body) : undefined,
      });
    } catch (e) {
      throw { offline: true, error: "Can't reach the server. Check your connection." };
    }
    let data = {};
    try { data = await res.json(); } catch (e) { /* empty body */ }
    if (!res.ok) {
      throw { status: res.status, error: data.error || "Something went wrong" };
    }
    return data;
  },

  get(path) { return this.request("GET", path); },
  post(path, body) { return this.request("POST", path, body); },
  patch(path, body) { return this.request("PATCH", path, body); },

  // Auth
  register(data) { return this.post("/auth/register", data); },
  login(data) { return this.post("/auth/login", data); },
  me() { return this.get("/auth/me"); },

  // Trips
  listTrips() { return this.get("/trips"); },
  createTrip(data) { return this.post("/trips", data); },
  joinTrip(code) { return this.post("/trips/join", { code }); },
  getTrip(id) { return this.get(`/trips/${id}`); },
  listMembers(id) { return this.get(`/trips/${id}/members`); },
  updateLocation(id, data) { return this.post(`/trips/${id}/location`, data); },

  // Budget
  getBudget(id) { return this.get(`/trips/${id}/budget`); },
  addExpense(id, data) { return this.post(`/trips/${id}/budget`, data); },

  // Checklist
  getChecklist(id) { return this.get(`/trips/${id}/checklist`); },
  addChecklistItem(id, text) { return this.post(`/trips/${id}/checklist`, { text }); },
  toggleChecklistItem(itemId) { return this.patch(`/checklist/${itemId}/toggle`); },

  // Itinerary
  getItinerary(id) { return this.get(`/trips/${id}/itinerary`); },
  addItineraryItem(id, data) { return this.post(`/trips/${id}/itinerary`, data); },

  // Chat
  getMessages(id, afterId) { return this.get(`/trips/${id}/messages?after_id=${afterId || 0}`); },
  sendMessage(id, text) { return this.post(`/trips/${id}/messages`, { text }); },

  // Safety
  getSafety(id) { return this.get(`/trips/${id}/safety`); },
  setRadius(id, radius) { return this.post(`/trips/${id}/safety/radius`, { radius }); },
  resolveSafetyAlert(alertId) { return this.patch(`/safety/${alertId}/resolve`); },

  // SOS
  getSos(id) { return this.get(`/trips/${id}/sos`); },
  triggerSos(id, data) { return this.post(`/trips/${id}/sos`, data); },
  resolveSos(alertId) { return this.patch(`/sos/${alertId}/resolve`); },

  // Notifications
  getNotifications() { return this.get("/notifications"); },
  readNotification(id) { return this.patch(`/notifications/${id}/read`); },

  // AI
  askAi(tripId, message) { return this.post(`/trips/${tripId}/ai`, { message }); },
};
