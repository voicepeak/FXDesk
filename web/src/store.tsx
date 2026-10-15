import React, { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { api } from './api';
import type { BalanceInfo, JobSummary, QueueSnapshot, Settings } from './types';

export type Route =
  | { name: 'jobs' }
  | { name: 'editor'; jobId: string }
  | { name: 'review'; jobId: string }
  | { name: 'library' }
  | { name: 'settings' };

export interface Toast {
  id: number;
  kind: 'info' | 'success' | 'error';
  message: string;
}

interface Store {
  route: Route;
  navigate(r: Route): void;
  settings: Settings | null;
  balance: BalanceInfo | null;
  balanceError: string | null;
  jobs: JobSummary[];
  queue: QueueSnapshot | null;
  libraryVersion: number;
  prepVersion: number;
  prepStage: { jobId: string; kind: string; stage: string } | null;
  toasts: Toast[];
  toast(message: string, kind?: Toast['kind']): void;
  dismissToast(id: number): void;
  refreshJobs(): Promise<void>;
  refreshSettings(): Promise<void>;
  refreshBalance(): Promise<void>;
  refreshQueue(): Promise<void>;
}

const Ctx = createContext<Store | null>(null);

export function useStore(): Store {
  const s = useContext(Ctx);
  if (!s) throw new Error('store not ready');
  return s;
}

function parseHash(): Route {
  const h = window.location.hash.replace(/^#\/?/, '');
  const parts = h.split('/').filter(Boolean);
  if (parts[0] === 'job' && parts[1]) {
    if (parts[2] === 'review') return { name: 'review', jobId: parts[1] };
    return { name: 'editor', jobId: parts[1] };
  }
  if (parts[0] === 'library') return { name: 'library' };
  if (parts[0] === 'settings') return { name: 'settings' };
  return { name: 'jobs' };
}

function routeToHash(r: Route): string {
  switch (r.name) {
    case 'editor':
      return `#/job/${r.jobId}`;
    case 'review':
      return `#/job/${r.jobId}/review`;
    case 'library':
      return '#/library';
    case 'settings':
      return '#/settings';
    default:
      return '#/jobs';
  }
}

let toastSeq = 1;

export function StoreProvider({ children }: { children: React.ReactNode }) {
  const [route, setRoute] = useState<Route>(parseHash);
  const [settings, setSettings] = useState<Settings | null>(null);
  const [balance, setBalance] = useState<BalanceInfo | null>(null);
  const [balanceError, setBalanceError] = useState<string | null>(null);
  const [jobs, setJobs] = useState<JobSummary[]>([]);
  const [queue, setQueue] = useState<QueueSnapshot | null>(null);
  const [libraryVersion, setLibraryVersion] = useState(0);
  const [prepVersion, setPrepVersion] = useState(0);
  const [prepStage, setPrepStage] = useState<{ jobId: string; kind: string; stage: string } | null>(null);
  const [toasts, setToasts] = useState<Toast[]>([]);
  const prevStatus = useRef<Map<string, string>>(new Map());
  const jobsTimer = useRef<number | null>(null);

  const toast = useCallback((message: string, kind: Toast['kind'] = 'info') => {
    const id = toastSeq++;
    setToasts((t) => [...t, { id, kind, message }]);
    window.setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), kind === 'error' ? 8000 : 4500);
  }, []);

  const dismissToast = useCallback((id: number) => setToasts((t) => t.filter((x) => x.id !== id)), []);

  const navigate = useCallback((r: Route) => {
    window.location.hash = routeToHash(r);
  }, []);

  useEffect(() => {
    const onHash = () => setRoute(parseHash());
    window.addEventListener('hashchange', onHash);
    if (!window.location.hash) window.location.hash = '#/jobs';
    return () => window.removeEventListener('hashchange', onHash);
  }, []);

  const refreshJobs = useCallback(async () => {
    try {
      const r = await api.jobs();
      setJobs(r.jobs);
    } catch {
      /* ignore */
    }
  }, []);

  const refreshSettings = useCallback(async () => {
    try {
      setSettings(await api.settings());
    } catch {
      /* ignore */
    }
  }, []);

  const refreshQueue = useCallback(async () => {
    try {
      setQueue(await api.queue());
    } catch {
      /* ignore */
    }
  }, []);

  const refreshBalance = useCallback(async () => {
    try {
      const b = await api.balance();
      setBalance(b);
      setBalanceError(null);
    } catch (e) {
      setBalance(null);
      setBalanceError(e instanceof Error ? e.message : String(e));
    }
  }, []);

  const scheduleJobsRefresh = useCallback(() => {
    if (jobsTimer.current) window.clearTimeout(jobsTimer.current);
    jobsTimer.current = window.setTimeout(() => {
      void refreshJobs();
      void refreshQueue();
    }, 400);
  }, [refreshJobs, refreshQueue]);

  useEffect(() => {
    void refreshJobs();
    void refreshSettings();
    void refreshQueue();
    void refreshBalance();

    const es = new EventSource('/api/events');
    es.addEventListener('snapshot', (e) => {
      try {
        const data = JSON.parse((e as MessageEvent).data) as { queue: QueueSnapshot };
        setQueue(data.queue);
      } catch {
        /* ignore */
      }
    });
    es.addEventListener('job_update', (e) => {
      try {
        const p = JSON.parse((e as MessageEvent).data) as {
          jobId: string;
          name: string;
          status: string;
          stage: string | null;
          elapsed: number | null;
          cost: number;
          error?: string | null;
        };
        const prev = prevStatus.current.get(p.jobId);
        if (prev !== undefined && prev !== p.status) {
          if (p.status === 'review') toast(`客单「${p.name}」已生成待审核`, 'success');
          else if (p.status === 'failed') toast(`客单「${p.name}」失败：${p.error ?? '未知错误'}`, 'error');
          else if (p.status === 'delivered') toast(`客单「${p.name}」已交付`, 'success');
        }
        prevStatus.current.set(p.jobId, p.status);
        if (p.stage === 'review' || p.stage === 'failed') void refreshBalance();
        scheduleJobsRefresh();
      } catch {
        /* ignore */
      }
    });
    es.addEventListener('run_progress', (e) => {
      try {
        const p = JSON.parse((e as MessageEvent).data) as { runId: string; jobId: string; stage: string; elapsedMs: number; attempt?: number; message?: string; retryAt?: number };
        setQueue((q) => {
          if (!q) return q;
          return {
            ...q,
            active: q.active.map((a) => (a.runId === p.runId ? { ...a, stage: p.stage, elapsed: p.elapsedMs, attempt: p.attempt, message: p.message, retryAt: p.retryAt } : a)),
          };
        });
      } catch {
        /* ignore */
      }
    });
    es.addEventListener('lib_update', () => setLibraryVersion((v) => v + 1));
    es.addEventListener('prep_update', (e) => {
      try {
        const p = JSON.parse((e as MessageEvent).data) as {
          jobId: string;
          kind: string;
          status: string;
          effectId?: string | null;
          error?: string | null;
          stage?: string | null;
        };
        setPrepVersion((v) => v + 1);
        if (p.stage && p.status === 'running') setPrepStage({ jobId: p.jobId, kind: p.kind, stage: p.stage });
        else if (p.status !== 'running') setPrepStage((cur) => (cur && cur.jobId === p.jobId && cur.kind === p.kind ? null : cur));
        if (p.kind === 'effect' && p.status === 'failed' && p.error) toast(`特效预演失败：${p.error}`, 'error');
        if (p.kind === 'analysis' && p.status === 'done') toast('角色识别完成，请在 AI 筹备中确认', 'success');
        if (p.kind === 'analysis' && p.status === 'failed' && p.error) toast(`识别失败：${p.error}`, 'error');
        if (p.kind === 'proposal' && p.status === 'done') toast('特效见解已生成，请查看并确认', 'success');
        if (p.kind === 'proposal' && p.status === 'failed' && p.error) toast(`特效见解失败：${p.error}`, 'error');
        scheduleJobsRefresh();
      } catch {
        /* ignore */
      }
    });
    es.onerror = () => {
      /* EventSource auto-reconnects */
    };

    const queueTimer = window.setInterval(() => void refreshQueue(), 30000);
    const balanceTimer = window.setInterval(() => void refreshBalance(), 10 * 60 * 1000);
    return () => {
      es.close();
      window.clearInterval(queueTimer);
      window.clearInterval(balanceTimer);
    };
  }, [refreshJobs, refreshQueue, refreshSettings, refreshBalance, scheduleJobsRefresh, toast]);

  useEffect(() => {
    const t = window.setInterval(() => {
      setQueue((q) => {
        if (!q || !q.active.length) return q;
        return { ...q, active: q.active.map((a) => ({ ...a, elapsed: Date.now() - a.startedAt })) };
      });
    }, 1000);
    return () => window.clearInterval(t);
  }, []);

  const value = useMemo<Store>(
    () => ({
      route,
      navigate,
      settings,
      balance,
      balanceError,
      jobs,
      queue,
      libraryVersion,
      prepVersion,
      prepStage,
      toasts,
      toast,
      dismissToast,
      refreshJobs,
      refreshSettings,
      refreshBalance,
      refreshQueue,
    }),
    [route, navigate, settings, balance, balanceError, jobs, queue, libraryVersion, prepVersion, prepStage, toasts, toast, dismissToast, refreshJobs, refreshSettings, refreshBalance, refreshQueue]
  );

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}
