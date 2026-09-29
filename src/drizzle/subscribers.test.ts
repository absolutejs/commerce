import { describe, expect, test } from "bun:test";
import { drizzle } from "drizzle-orm/pg-proxy";
import { isSubscribed, subscribe, unsubscribe } from "./queries";

const recorder = () => {
  const calls: { sql: string; params: unknown[] }[] = [];
  const db = drizzle(async (sql, params) => {
    calls.push({ params, sql });

    return { rows: [] };
  });

  return { calls, db };
};

describe("marketing consent", () => {
  test("subscribing again clears an earlier opt-out", async () => {
    const { calls, db } = recorder();
    await subscribe(db, "  Pat@Example.com ", { source: "checkout" });
    const [call] = calls;
    expect(call?.sql).toContain("on conflict");
    expect(call?.sql).toContain('"unsubscribed_at" = ');
    expect(call?.params).toContain("pat@example.com");
    expect(call?.params).toContain("checkout");
  });

  test("an opt-out is kept as a row, not deleted", async () => {
    const { calls, db } = recorder();
    await unsubscribe(db, "pat@example.com");
    expect(calls[0]?.sql.startsWith("insert into")).toBe(true);
    expect(calls[0]?.sql).toContain("on conflict");
  });

  test("isSubscribed honours unsubscribed_at", () => {
    const base = {
      consented_at: new Date(),
      created_at: new Date(),
      email: "pat@example.com",
      source: "newsletter",
      unsubscribed_at: null,
    };
    expect(isSubscribed(base)).toBe(true);
    expect(isSubscribed({ ...base, unsubscribed_at: new Date() })).toBe(false);
    expect(isSubscribed(null)).toBe(false);
  });
});
