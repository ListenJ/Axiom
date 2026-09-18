/**
 * 各平台健康检查
 * 可使用 Bun Cron 定时执行，或手动运行：bun run scripts/health-check.ts
 */

interface HealthResult {
  platform: string;
  status: "UP" | "DOWN";
  latencyMs: number;
  error?: string;
}

async function checkEndpoint(url: string, headers: Record<string, string>): Promise<{ ok: boolean; latencyMs: number; error?: string }> {
  const start = performance.now();
  try {
    const res = await fetch(url, {
      headers,
      signal: AbortSignal.timeout(5000),
    });
    const latencyMs = Math.round(performance.now() - start);
    return { ok: res.ok, latencyMs };
  } catch (e: any) {
    return { ok: false, latencyMs: Math.round(performance.now() - start), error: e.message };
  }
}

async function healthCheckAll(): Promise<HealthResult[]> {
  const checks: Record<string, { url: string; headers: Record<string, string> }> = {
    siliconflow: {
      url: "https://api.siliconflow.cn/v1/models",
      headers: { Authorization: `Bearer ${process.env.SILICONFLOW_API_KEY || ""}` },
    },
    ofoxai: {
      url: "https://api.ofox.ai/v1/models",
      headers: { Authorization: `Bearer ${process.env.OFOXAI_API_KEY || ""}` },
    },
    openrouter: {
      url: "https://openrouter.ai/api/v1/models",
      headers: { Authorization: `Bearer ${process.env.OPENROUTER_API_KEY || ""}` },
    },
    deepseek: {
      url: "https://api.deepseek.com/v1/models",
      headers: { Authorization: `Bearer ${process.env.DEEPSEEK_API_KEY || ""}` },
    },
  };

  const results = await Promise.all(
    Object.entries(checks).map(async ([platform, config]) => {
      const result = await checkEndpoint(config.url, config.headers);
      return {
        platform,
        status: (result.ok ? "UP" : "DOWN") as "UP" | "DOWN",
        latencyMs: result.latencyMs,
        error: result.error,
      };
    })
  );

  return results;
}

// 主执行
async function main() {
  console.log("[健康检查] Running health checks...\n");
  const health = await healthCheckAll();

  let allUp = true;
  for (const h of health) {
    const icon = h.status === "UP" ? "[正常]" : "[异常]";
    console.log(`${icon} ${h.platform}: ${h.status} (${h.latencyMs}ms)${h.error ? ` — ${h.error}` : ""}`);
    if (h.status === "DOWN") allUp = false;
  }

  console.log("");
  if (allUp) {
    console.log("[完成] All platforms healthy");
    process.exit(0);
  } else {
    console.log("[错误] Some platforms are down");
    process.exit(1);
  }
}

// 若通过 Bun Cron 调度
if (typeof Bun !== "undefined" && Bun.cron) {
  Bun.cron("*/1 * * * *", async () => {
    const health = await healthCheckAll();
    for (const h of health) {
      console.log(`[Health] ${h.platform}: ${h.status} (${h.latencyMs}ms)`);
    }
  });
}

main().catch(console.error);
