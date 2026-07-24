import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import type { Logger } from "pino";
import { z } from "zod";
import type {
  ProviderUsage,
  ProviderUsageBalance,
  ProviderUsageDetail,
  ProviderUsageWindow,
} from "../../../server/messages.js";
import type { ProviderApiFetch, ProviderUsageFetcher } from "../provider.js";
import {
  ApiNullableNumberSchema,
  toneFromUsedPct,
  usedPctOf,
  fetchProviderApi,
  toIsoStringOrNull,
  unavailableUsage,
  windowFromUsedPct,
} from "../usage.js";

const execFileAsync = promisify(execFile);
const CURSOR_SQLITE_TIMEOUT_MS = 2_000;

const CursorBillingCycleTimestampSchema = z.preprocess(
  (value) => (typeof value === "string" || typeof value === "number" ? value : null),
  z.union([z.string(), z.number()]).nullable(),
);

const CursorPlanUsageSchema = z.object({
  // Dollar fields are retail API-cost estimates in cents. Quota gating uses the
  // percent fields; totalSpend = includedSpend + bonusSpend and must not be the
  // "used" side of the plan-limit bar.
  totalSpend: ApiNullableNumberSchema,
  includedSpend: ApiNullableNumberSchema,
  bonusSpend: ApiNullableNumberSchema,
  remaining: ApiNullableNumberSchema,
  limit: ApiNullableNumberSchema,
  autoPercentUsed: ApiNullableNumberSchema.optional(),
  apiPercentUsed: ApiNullableNumberSchema.optional(),
  totalPercentUsed: ApiNullableNumberSchema.optional(),
});

const CursorUsageResponseSchema = z.object({
  planUsage: CursorPlanUsageSchema.nullish(),
  billingCycleStart: CursorBillingCycleTimestampSchema,
  billingCycleEnd: CursorBillingCycleTimestampSchema,
});

const CursorAuthStatusSchema = z.object({
  accessToken: z.string().optional(),
});

const CursorAuthJsonSchema = z.object({
  accessToken: z.string().min(1),
});

type CursorPlanUsage = z.infer<typeof CursorPlanUsageSchema>;
type CursorUsageResponse = z.infer<typeof CursorUsageResponseSchema>;

interface CursorQuotaProviderOptions {
  logger: Logger;
  fetch?: ProviderApiFetch;
  /** Test seam for token discovery. */
  resolveAccessToken?: () => Promise<string | null>;
}

function parseCursorBillingCycleTimestamp(
  value: CursorUsageResponse["billingCycleStart"],
): string | null {
  if (value === null) return null;

  const raw = String(value).trim();
  if (!raw) return null;

  const numeric = Number(raw);
  if (Number.isFinite(numeric)) {
    const timestampMs = Math.abs(numeric) < 10_000_000_000 ? numeric * 1000 : numeric;
    return toIsoStringOrNull(timestampMs);
  }

  return toIsoStringOrNull(new Date(raw).getTime());
}

function centsToDollars(value: number | null): number | null {
  return value === null ? null : value / 100;
}

function formatUsdDetail(cents: number): string {
  return `$${centsToDollars(cents)!.toFixed(2)}`;
}

/**
 * Map Cursor planUsage onto Paseo balances/windows.
 * Plan bar uses includedSpend vs limit (not totalSpend, which includes free bonus).
 */
export function normalizeCursorPlanUsage(
  planUsage: CursorPlanUsage,
  billingCycleEnd: string | null,
): {
  balances: ProviderUsageBalance[];
  windows: ProviderUsageWindow[];
  details: ProviderUsageDetail[];
} {
  const includedSpend = centsToDollars(planUsage.includedSpend);
  const limit = centsToDollars(planUsage.limit);
  const remainingFromApi = centsToDollars(planUsage.remaining);
  const remaining =
    remainingFromApi ??
    (includedSpend != null && limit != null ? Math.max(0, limit - includedSpend) : null);
  const usedPct = usedPctOf(includedSpend, limit);

  const balances: ProviderUsageBalance[] = [];
  if (includedSpend != null || limit != null || remaining != null) {
    balances.push({
      id: "plan_usage",
      label: "Plan usage",
      used: includedSpend,
      remaining,
      limit,
      unit: "usd",
      resetsAt: billingCycleEnd,
      tone: toneFromUsedPct(usedPct),
    });
  }

  const windows: ProviderUsageWindow[] = [];
  const percentWindows: Array<{
    id: string;
    label: string;
    value: number | null | undefined;
  }> = [
    { id: "total_usage", label: "Total", value: planUsage.totalPercentUsed },
    { id: "api_usage", label: "API", value: planUsage.apiPercentUsed },
    { id: "auto_usage", label: "Auto", value: planUsage.autoPercentUsed },
  ];
  for (const window of percentWindows) {
    if (typeof window.value !== "number" || !Number.isFinite(window.value)) continue;
    windows.push(
      windowFromUsedPct({
        id: window.id,
        label: window.label,
        utilizationPct: window.value,
        resetsAt: billingCycleEnd,
        tone: toneFromUsedPct(window.value),
      }),
    );
  }

  const details: ProviderUsageDetail[] = [];
  if (typeof planUsage.bonusSpend === "number" && planUsage.bonusSpend > 0) {
    details.push({
      id: "bonus_spend",
      label: "Bonus usage",
      value: formatUsdDetail(planUsage.bonusSpend),
    });
  }

  return { balances, windows, details };
}

async function readCursorTokenFromSqlite(): Promise<string | null> {
  const dbPaths: string[] = [];
  if (process.env["APPDATA"]) {
    dbPaths.push(join(process.env["APPDATA"], "Cursor", "User", "globalStorage", "state.vscdb"));
  }
  dbPaths.push(
    join(
      homedir(),
      "Library",
      "Application Support",
      "Cursor",
      "User",
      "globalStorage",
      "state.vscdb",
    ),
  );
  dbPaths.push(join(homedir(), ".config", "Cursor", "User", "globalStorage", "state.vscdb"));

  for (const path of dbPaths) {
    if (!existsSync(path)) continue;
    try {
      const { stdout } = await execFileAsync(
        "sqlite3",
        [path, "SELECT value FROM ItemTable WHERE key = 'cursorAuthStatus'"],
        { timeout: CURSOR_SQLITE_TIMEOUT_MS },
      );
      if (stdout) {
        const parsed = CursorAuthStatusSchema.parse(JSON.parse(stdout.trim()));
        if (parsed.accessToken) return parsed.accessToken;
      }
    } catch {
      continue;
    }
  }
  return null;
}

/** Cursor Agent CLI stores session tokens at `~/.config/cursor/auth.json`. */
export async function readCursorTokenFromAuthJson(
  home: string = homedir(),
): Promise<string | null> {
  const path = join(home, ".config", "cursor", "auth.json");
  if (!existsSync(path)) return null;
  try {
    const parsed = CursorAuthJsonSchema.parse(JSON.parse(await readFile(path, "utf8")));
    return parsed.accessToken;
  } catch {
    return null;
  }
}

export async function resolveCursorAccessToken(): Promise<string | null> {
  return (
    process.env["CURSOR_ACCESS_TOKEN"] ||
    process.env["CURSOR_TOKEN"] ||
    (await readCursorTokenFromSqlite()) ||
    (await readCursorTokenFromAuthJson())
  );
}

export class CursorQuotaProvider implements ProviderUsageFetcher {
  readonly providerId = "cursor";
  readonly displayName = "Cursor";

  private readonly logger: Logger;
  private readonly fetchApi: ProviderApiFetch;
  private readonly resolveAccessToken: () => Promise<string | null>;

  constructor(options: CursorQuotaProviderOptions) {
    this.logger = options.logger;
    this.fetchApi = options.fetch ?? fetch;
    this.resolveAccessToken = options.resolveAccessToken ?? resolveCursorAccessToken;
  }

  async fetchUsage(): Promise<ProviderUsage> {
    const token = await this.resolveAccessToken();

    if (!token) return unavailableUsage(this);

    const res = await fetchProviderApi(
      this.fetchApi,
      "https://api2.cursor.sh/aiserver.v1.DashboardService/GetCurrentPeriodUsage",
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
          "Connect-Protocol-Version": "1",
        },
        body: JSON.stringify({}),
      },
    );

    if (!res.ok) {
      this.logger.debug({ status: res.status }, "Cursor usage fetch failed");
      return unavailableUsage(this);
    }

    const resp = CursorUsageResponseSchema.parse(await res.json());
    const billingCycleEnd = parseCursorBillingCycleTimestamp(resp.billingCycleEnd);
    if (!resp.planUsage) {
      return {
        providerId: this.providerId,
        displayName: this.displayName,
        status: "available",
        planLabel: null,
        windows: [],
        balances: [],
        details: [],
        error: null,
      };
    }

    const { balances, windows, details } = normalizeCursorPlanUsage(
      resp.planUsage,
      billingCycleEnd,
    );

    return {
      providerId: this.providerId,
      displayName: this.displayName,
      status: "available",
      planLabel: null,
      windows,
      balances,
      details,
      error: null,
    };
  }
}
