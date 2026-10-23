// 常駐程式自身的狀態：GET /api/agent 的 AgentInfo，以及 /api/status 附帶的 agent 摘要。
const LOGON_TTL_MS = 60_000;

/**
 * @param {{ agent: { pid, version, startedAt, port }, jobs, schedulerStatus: () => Promise<object> }} deps
 */
export function createAgentInfo({ agent, jobs, schedulerStatus }) {
  // 查登入工作要啟動 schtasks 與 PowerShell（約 0.5–1 秒），結果快取 1 分鐘
  let logon = { installed: false, state: null, launcher: null, lastRunAt: null };
  let logonAt = 0;
  let refreshing = null;

  function refreshLogon() {
    refreshing ??= schedulerStatus()
      .then((s) => {
        logon = s;
      })
      .catch(() => {})
      .finally(() => {
        logonAt = Date.now();
        refreshing = null;
      });
    return refreshing;
  }

  function probeSummary() {
    const probe = jobs.probe();
    return { ok: probe ? probe.ok : null, failed: probe ? probe.checks.filter((c) => !c.ok).map((c) => c.id) : [] };
  }

  return {
    /** AgentInfo（api.js）。paused 為布林值；實際暫停的自動化列在 pausedAutomations。 */
    async get() {
      if (Date.now() - logonAt > LOGON_TTL_MS) await refreshLogon();
      const paused = jobs.paused();
      return {
        pid: agent.pid,
        version: agent.version,
        startedAt: agent.startedAt,
        port: agent.port,
        claudeVersion: jobs.claudeVersion(),
        paused: paused.length > 0,
        pausedAutomations: paused,
        logonTask: logon,
        jobs: jobs.list(),
        probe: jobs.probe(),
      };
    },
    /** /api/status 的 agent 欄位：{ paused, probe: { ok, failed[] } } */
    statusSummary() {
      const paused = jobs.paused();
      return { paused: paused.length > 0, pausedAutomations: paused, probe: probeSummary() };
    },
  };
}
