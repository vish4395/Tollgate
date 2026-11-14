// Cached reads from Meridian: model list, subscription quota, health and telemetry.

export function createUpstream(cfg) {
  const auth = () => ({ "x-api-key": cfg.internalKey });
  const get = async (path, timeout = 5000) => {
    const r = await fetch(cfg.upstream + path, {
      headers: auth(),
      signal: AbortSignal.timeout(timeout),
    });
    if (!r.ok) throw new Error(`${path} returned ${r.status}`);
    return r.json();
  };

  let models = { at: 0, list: [] };
  let quota = { at: 0, data: null, error: null };

  async function listModels(force = false) {
    if (!force && Date.now() - models.at < 10 * 60_000)
      return models.list;
    try {
      const d = await get("/v1/models");
      models = {
        at: Date.now(),
        list: (d.data ?? []).map((m) => ({
          id: m.id,
          name: m.display_name ?? m.id,
          contextWindow: m.context_window ?? null,
          createdAt: m.created ?? null,
        })),
      };
    } catch {
      // Keep the last good list, and don't ask again for a minute.
      models.at = Date.now() - 9 * 60_000;
    }
    return models.list;
  }

  async function getQuota(force = false) {
    if (!force && quota.data && Date.now() - quota.at < 60_000) return quota;
    try {
      const d = await get("/v1/usage/quota");
      quota = { at: Date.now(), data: d, error: null };
    } catch (e) {
      quota = { ...quota, at: Date.now(), error: e.message };
    }
    return quota;
  }

  /** 0–100 for the five-hour window, or null when unknown. */
  async function fiveHourPct() {
    const q = await getQuota();
    const b = q.data?.buckets?.find((x) => x.type === "five_hour");
    return b ? Math.round(b.utilization * 100) : null;
  }

  async function health() {
    try {
      const r = await fetch(cfg.upstream + "/health", {
        signal: AbortSignal.timeout(3000),
      });
      const h = await r.json();
      return {
        ok: r.ok && h.status === "healthy",
        status: h.status,
        version: h.version,
        mode: h.mode,
        loggedIn: h.auth?.loggedIn ?? null,
        plan: h.auth?.planLabel ?? null,
        tier: h.auth?.rateLimitTier ?? null,
        daysUntilRenewal: h.auth?.daysUntilRenewal ?? null,
        upstreamState: h.upstream?.claude?.state ?? null,
        lastError: h.upstream?.claude?.lastErrorKind ?? null,
        cli: h.claudeExecutable?.path ?? null,
      };
    } catch (e) {
      return { ok: false, status: "unreachable", error: e.message };
    }
  }

  async function telemetry() {
    try {
      const s = await get("/telemetry/summary");
      return {
        windowMs: s.windowMs,
        requests: s.totalRequests,
        errors: s.errorCount,
        rpm: s.requestsPerMinute,
        ttfb: s.ttfb,
        total: s.totalDuration,
        cacheHitRate: s.tokenUsage?.avgCacheHitRate ?? null,
      };
    } catch {
      return null;
    }
  }

  /** Every account (profile) with its sign-in state, or null when the backend can't be read. */
  async function profiles() {
    try {
      return await get("/profiles/list");
    } catch {
      return null;
    }
  }

  /** Quota windows for every account, or null. */
  async function quotaAll() {
    try {
      return await get("/v1/usage/quota/all", 10_000);
    } catch {
      return null;
    }
  }

  return { listModels, getQuota, fiveHourPct, health, telemetry, profiles, quotaAll };
}
