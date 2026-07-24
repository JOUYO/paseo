import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";

import { normalizeCursorPlanUsage, readCursorTokenFromAuthJson } from "./cursor.js";

describe("readCursorTokenFromAuthJson", () => {
  test("reads accessToken from cursor-agent auth.json", async () => {
    const home = await mkdtemp(join(tmpdir(), "paseo-cursor-auth-"));
    await mkdir(join(home, ".config", "cursor"), { recursive: true });
    await writeFile(
      join(home, ".config", "cursor", "auth.json"),
      JSON.stringify({ accessToken: "cursor_cli_token", refreshToken: "refresh" }),
    );

    await expect(readCursorTokenFromAuthJson(home)).resolves.toBe("cursor_cli_token");
  });

  test("returns null when auth.json is missing", async () => {
    const home = await mkdtemp(join(tmpdir(), "paseo-cursor-auth-missing-"));
    await expect(readCursorTokenFromAuthJson(home)).resolves.toBeNull();
  });

  test("returns null when accessToken is empty", async () => {
    const home = await mkdtemp(join(tmpdir(), "paseo-cursor-auth-empty-"));
    await mkdir(join(home, ".config", "cursor"), { recursive: true });
    await writeFile(
      join(home, ".config", "cursor", "auth.json"),
      JSON.stringify({ accessToken: "" }),
    );

    await expect(readCursorTokenFromAuthJson(home)).resolves.toBeNull();
  });
});

describe("normalizeCursorPlanUsage", () => {
  test("uses includedSpend against limit, not totalSpend with bonus", () => {
    const normalized = normalizeCursorPlanUsage(
      {
        totalSpend: 49317,
        includedSpend: 40000,
        bonusSpend: 9317,
        remaining: null,
        limit: 40000,
        autoPercentUsed: 14.8585,
        apiPercentUsed: 39.2,
        totalPercentUsed: 19.7268,
      },
      "2026-08-21T09:02:10.000Z",
    );

    expect(normalized.balances).toEqual([
      expect.objectContaining({
        id: "plan_usage",
        used: 400,
        remaining: 0,
        limit: 400,
        unit: "usd",
        tone: "danger",
        resetsAt: "2026-08-21T09:02:10.000Z",
      }),
    ]);
    expect(normalized.windows.map((window) => window.id)).toEqual([
      "total_usage",
      "api_usage",
      "auto_usage",
    ]);
    expect(normalized.windows[0]).toMatchObject({
      id: "total_usage",
      usedPct: 19.7268,
      remainingPct: expect.closeTo(80.2732, 5),
    });
    expect(normalized.details).toEqual([
      { id: "bonus_spend", label: "Bonus usage", value: "$93.17" },
    ]);
  });

  test("prefers API remaining when present", () => {
    const normalized = normalizeCursorPlanUsage(
      {
        totalSpend: 1500,
        includedSpend: 1000,
        bonusSpend: 500,
        remaining: 2500,
        limit: 4000,
      },
      null,
    );

    expect(normalized.balances[0]).toMatchObject({
      used: 10,
      remaining: 25,
      limit: 40,
      tone: "ok",
    });
    expect(normalized.details).toEqual([
      { id: "bonus_spend", label: "Bonus usage", value: "$5.00" },
    ]);
  });
});
