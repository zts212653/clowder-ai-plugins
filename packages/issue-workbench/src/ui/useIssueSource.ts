'use client';

import type { IssueSourceSnapshot } from '../model/issue-source.js';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useSourceClient } from './source-client';

const freshness = 5 * 60_000;
export function useIssueSource(active: boolean, selected: number | null) {
  const { repo: ISSUE_REPO, fetch: sourceFetch } = useSourceClient();
const initial: IssueSourceSnapshot = {
  repo: ISSUE_REPO,
  issues: [],
  fetchedAt: '',
  revision: 0,
  failures: [],
  summary: { added: 0, changed: 0, closed: 0, reopened: 0 },
};

  const priority = useRef(selected);
  priority.current = selected;
  const [snapshot, setSnapshot] = useState(initial);
  const current = useRef(initial);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [loaded, setLoaded] = useState(false);
  const [receipt, setReceipt] = useState(false);
  const [now, setNow] = useState(Date.now);
  const flight = useRef(false);
  const alive = useRef(true);
  const lastAttempt = useRef(0);
  const refresh = useCallback(async () => {
    if (flight.current || Date.parse(current.current.retryAt ?? '') > Date.now()) return;
    flight.current = true;
    lastAttempt.current = Date.now();
    setBusy(true);
    setError('');
    try {
      // Same-origin keeps this read inside the Host / Workspace preview gateway.
      const response = await sourceFetch(
        `/api/issue-source/refresh?repo=${encodeURIComponent(ISSUE_REPO)}${priority.current ? `&priority=${priority.current}` : ''}`,
        {
          method: 'POST',
          headers: { 'x-issue-source-request': 'refresh' },
          signal: AbortSignal.timeout(300_000),
          cache: 'no-store',
        },
      );
      if (!response.ok) throw new Error('source unavailable');
      const { snapshot: next } = (await response.json()) as { snapshot: IssueSourceSnapshot };
      if (next.repo !== ISSUE_REPO || !Array.isArray(next.issues)) throw new Error('invalid source');
      if (alive.current && next.revision >= current.current.revision) {
        current.current = next;
        setSnapshot(next);
        setReceipt(true);
      }
    } catch {
      if (alive.current) setError('更新失败：来源服务或网络暂不可用，上次内容仍保留。');
    } finally {
      flight.current = false;
      if (alive.current) setBusy(false);
    }
  }, [ISSUE_REPO, sourceFetch]);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  useEffect(() => {
    if (!active) return;
    let cancelled = false;
    const check = () => {
      setNow(Date.now());
      if (document.visibilityState === 'hidden') return;
      if (
        Date.now() - Math.max(lastAttempt.current, Date.parse(current.current.lastCompleteAt ?? '') || 0) >=
        freshness
      )
        void refresh();
    };
    void (async () => {
      try {
        const response = await sourceFetch(`/api/issue-source?repo=${encodeURIComponent(ISSUE_REPO)}`, {
          cache: 'no-store',
          signal: AbortSignal.timeout(15_000),
        });
        if (!response.ok) throw new Error('unavailable');
        const { snapshot: stored } = (await response.json()) as { snapshot: IssueSourceSnapshot | null };
        if (cancelled) return;
        if (stored && stored.repo === ISSUE_REPO && stored.revision > current.current.revision && !flight.current) {
          current.current = stored;
          setSnapshot(stored);
        }
        setLoaded(true);
        check();
      } catch {
        if (!cancelled) {
          setLoaded(true);
          setError('来源服务暂不可用；已保存的本地工作仍保留，点击重试。');
        }
      }
    })();
    document.addEventListener('visibilitychange', check);
    const timer = window.setInterval(check, 60_000);
    return () => {
      cancelled = true;
      document.removeEventListener('visibilitychange', check);
      window.clearInterval(timer);
    };
  }, [active, refresh, ISSUE_REPO, sourceFetch]);
  return { snapshot, busy, error, receipt, loaded, refresh, cooling: Date.parse(snapshot.retryAt ?? '') > now };
}
