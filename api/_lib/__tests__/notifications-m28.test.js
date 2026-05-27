// Tests for api/_lib/notifications/ (the M28 lib added in P2-3).
//
// Uses an in-memory mock supabase similar to the approvals-lifecycle test.

import { describe, it, expect } from "vitest";
import { enqueue, markRead, drainPendingEmails, NotificationsError } from "../notifications/index.js";

const ENTITY = "00000000-0000-0000-0000-000000000001";
const USER_A = "00000000-0000-0000-0000-0000000000a1";
const USER_B = "00000000-0000-0000-0000-0000000000a2";
const USER_C = "00000000-0000-0000-0000-0000000000a3";

function buildClient(state) {
  return {
    from(table) {
      const tableState = state[table] || (state[table] = []);
      return new Chain(table, tableState, state);
    },
  };
}

class Chain {
  constructor(table, rows, allTables) {
    this.table = table;
    this.rows = rows;
    this.allTables = allTables;
    this.filters = [];
    this.selectCols = null;
    this.insertRows = null;
    this.updateData = null;
    this.deleteFlag = false;
    this.limitN = null;
    this.singleFlag = false;
    this.maybeSingleFlag = false;
    this.orderBy = null;
  }
  select(cols) { this.selectCols = cols; return this; }
  eq(col, val) { this.filters.push((r) => r[col] === val); return this; }
  in(col, vals) { this.filters.push((r) => vals.includes(r[col])); return this; }
  order(col, opts = {}) { this.orderBy = { col, asc: opts.ascending !== false }; return this; }
  limit(n) { this.limitN = n; return this; }
  insert(rows) {
    this.insertRows = Array.isArray(rows) ? rows : [rows];
    return this;
  }
  update(data) { this.updateData = data; return this; }
  delete() { this.deleteFlag = true; return this; }
  single() { this.singleFlag = true; return this._run(); }
  maybeSingle() { this.maybeSingleFlag = true; return this._run(); }
  then(resolve, reject) { return this._run().then(resolve, reject); }

  async _run() {
    if (this.insertRows) {
      const out = [];
      for (const r of this.insertRows) {
        const row = { id: `id-${this.allTables.__seq = (this.allTables.__seq || 0) + 1}`, ...r };
        this.rows.push(row);
        out.push(row);
      }
      if (this.singleFlag) return { data: out[0], error: null };
      return { data: out, error: null };
    }
    if (this.updateData) {
      const matched = this.rows.filter((r) => this.filters.every((f) => f(r)));
      for (const r of matched) Object.assign(r, this.updateData);
      if (this.singleFlag) return { data: matched[0] || null, error: null };
      return { data: matched, error: null };
    }
    if (this.deleteFlag) {
      const survivors = this.rows.filter((r) => !this.filters.every((f) => f(r)));
      this.rows.length = 0;
      for (const r of survivors) this.rows.push(r);
      return { data: null, error: null };
    }
    let filtered = this.rows.filter((r) => this.filters.every((f) => f(r)));
    if (this.orderBy) {
      const { col, asc } = this.orderBy;
      filtered = [...filtered].sort((a, b) => {
        const av = a[col]; const bv = b[col];
        if (av < bv) return asc ? -1 : 1;
        if (av > bv) return asc ? 1 : -1;
        return 0;
      });
    }
    if (this.limitN != null) filtered = filtered.slice(0, this.limitN);
    if (this.singleFlag) {
      if (filtered.length === 0) return { data: null, error: { message: "not found" } };
      return { data: filtered[0], error: null };
    }
    if (this.maybeSingleFlag) return { data: filtered[0] || null, error: null };
    return { data: filtered, error: null };
  }
}

function seed() {
  const state = {
    notification_events: [],
    notification_dispatches: [],
    notification_preferences: [],
    entity_users: [
      { id: "eu-admin", auth_id: USER_A, entity_id: ENTITY, role: "admin" },
      { id: "eu-staff", auth_id: USER_B, entity_id: ENTITY, role: "staff" },
      { id: "eu-acct", auth_id: USER_C, entity_id: ENTITY, role: "accountant" },
    ],
  };
  return { state, sb: buildClient(state) };
}

describe("enqueue", () => {
  it("rejects missing required fields", async () => {
    const { sb } = seed();
    await expect(enqueue(sb, {})).rejects.toThrow(NotificationsError);
    await expect(enqueue(sb, { entity_id: ENTITY })).rejects.toThrow(/kind/);
    await expect(enqueue(sb, { entity_id: ENTITY, kind: "k" })).rejects.toThrow(/subject/);
    await expect(enqueue(sb, { entity_id: ENTITY, kind: "k", subject: "s" })).rejects.toThrow(/body/);
  });

  it("rejects invalid severity", async () => {
    const { sb } = seed();
    await expect(enqueue(sb, {
      entity_id: ENTITY, kind: "k", subject: "s", body: "b", severity: "URGENT",
      recipients: [USER_A],
    })).rejects.toThrow(/severity/);
  });

  it("records event + fans out to explicit recipients on both channels", async () => {
    const { state, sb } = seed();
    const out = await enqueue(sb, {
      entity_id: ENTITY, kind: "je_posted", subject: "JE posted", body: "...",
      recipients: [USER_A, USER_B],
    });
    expect(out.event_id).toBeTruthy();
    expect(out.dispatch_count).toBe(4); // 2 recipients × 2 channels
    expect(state.notification_events).toHaveLength(1);
    expect(state.notification_dispatches).toHaveLength(4);
    // in_app dispatches should be 'sent' synchronously
    const inApp = state.notification_dispatches.filter((d) => d.channel === "in_app");
    expect(inApp.every((d) => d.status === "sent")).toBe(true);
    expect(inApp.every((d) => d.sent_at)).toBe(true);
    // email dispatches should be 'pending'
    const email = state.notification_dispatches.filter((d) => d.channel === "email");
    expect(email.every((d) => d.status === "pending")).toBe(true);
    expect(email.every((d) => d.sent_at == null)).toBe(true);
  });

  it("expands recipient_roles via entity_users", async () => {
    const { state, sb } = seed();
    const out = await enqueue(sb, {
      entity_id: ENTITY, kind: "approval_requested", subject: "s", body: "b",
      recipient_roles: ["admin", "accountant"],
    });
    // 2 users × 2 channels = 4 dispatches; USER_B (staff) excluded
    expect(out.dispatch_count).toBe(4);
    const recipients = new Set(state.notification_dispatches.map((d) => d.recipient_user_id));
    expect(recipients.has(USER_A)).toBe(true);
    expect(recipients.has(USER_C)).toBe(true);
    expect(recipients.has(USER_B)).toBe(false);
  });

  it("dedupes recipients across explicit + roles", async () => {
    const { state, sb } = seed();
    const out = await enqueue(sb, {
      entity_id: ENTITY, kind: "k", subject: "s", body: "b",
      recipients: [USER_A], recipient_roles: ["admin"],
    });
    // USER_A appears in both; should be 1 user × 2 channels = 2 dispatches
    expect(out.dispatch_count).toBe(2);
    const recipients = new Set(state.notification_dispatches.map((d) => d.recipient_user_id));
    expect(recipients.size).toBe(1);
  });

  it("respects opt-out preferences", async () => {
    const { state, sb } = seed();
    state.notification_preferences.push({
      user_id: USER_A, kind: "je_posted", channel: "email", enabled: false,
    });
    const out = await enqueue(sb, {
      entity_id: ENTITY, kind: "je_posted", subject: "s", body: "b",
      recipients: [USER_A],
    });
    // USER_A opted out of email → 1 dispatch only (in_app)
    expect(out.dispatch_count).toBe(1);
    expect(state.notification_dispatches[0].channel).toBe("in_app");
  });

  it("restricts to specified channels", async () => {
    const { state, sb } = seed();
    const out = await enqueue(sb, {
      entity_id: ENTITY, kind: "k", subject: "s", body: "b",
      recipients: [USER_A], channels: ["email"],
    });
    expect(out.dispatch_count).toBe(1);
    expect(state.notification_dispatches[0].channel).toBe("email");
  });

  it("records event even with zero recipients", async () => {
    const { state, sb } = seed();
    const out = await enqueue(sb, {
      entity_id: ENTITY, kind: "k", subject: "s", body: "b",
    });
    expect(out.dispatch_count).toBe(0);
    expect(state.notification_events).toHaveLength(1);
  });

  it("stores payload + context on the event", async () => {
    const { state, sb } = seed();
    await enqueue(sb, {
      entity_id: ENTITY, kind: "k", subject: "s", body: "b",
      recipients: [USER_A],
      context_table: "journal_entries", context_id: "abc",
      payload: { je_id: "abc", amount: 100 },
    });
    const ev = state.notification_events[0];
    expect(ev.context_table).toBe("journal_entries");
    expect(ev.context_id).toBe("abc");
    expect(ev.payload).toEqual({ je_id: "abc", amount: 100 });
  });
});

describe("markRead", () => {
  it("flips in_app dispatch to read", async () => {
    const { state, sb } = seed();
    await enqueue(sb, {
      entity_id: ENTITY, kind: "k", subject: "s", body: "b",
      recipients: [USER_A], channels: ["in_app"],
    });
    const disp = state.notification_dispatches[0];
    const out = await markRead(sb, { dispatch_id: disp.id, user_id: USER_A });
    expect(out.dispatch.status).toBe("read");
    expect(out.dispatch.read_at).toBeTruthy();
  });

  it("rejects when user doesn't own the dispatch", async () => {
    const { state, sb } = seed();
    await enqueue(sb, {
      entity_id: ENTITY, kind: "k", subject: "s", body: "b",
      recipients: [USER_A], channels: ["in_app"],
    });
    const disp = state.notification_dispatches[0];
    await expect(markRead(sb, { dispatch_id: disp.id, user_id: USER_B })).rejects.toThrow();
  });
});

describe("drainPendingEmails", () => {
  it("sends pending email rows and updates status", async () => {
    const { state, sb } = seed();
    await enqueue(sb, {
      entity_id: ENTITY, kind: "k", subject: "Hello", body: "World",
      recipients: [USER_A], channels: ["email"],
    });
    const sentCalls = [];
    const out = await drainPendingEmails(sb, {
      send: async (row) => { sentCalls.push(row); },
    });
    expect(out.processed).toBe(1);
    expect(out.sent).toBe(1);
    expect(out.failed).toBe(0);
    expect(state.notification_dispatches[0].status).toBe("sent");
    expect(sentCalls).toHaveLength(1);
  });

  it("marks failed on send rejection", async () => {
    const { state, sb } = seed();
    await enqueue(sb, {
      entity_id: ENTITY, kind: "k", subject: "s", body: "b",
      recipients: [USER_A], channels: ["email"],
    });
    const out = await drainPendingEmails(sb, {
      send: async () => { throw new Error("smtp 4xx"); },
    });
    expect(out.failed).toBe(1);
    expect(state.notification_dispatches[0].status).toBe("failed");
    expect(state.notification_dispatches[0].error_message).toMatch(/smtp/);
  });

  it("requires send function", async () => {
    const { sb } = seed();
    await expect(drainPendingEmails(sb)).rejects.toThrow(/send/);
  });
});
