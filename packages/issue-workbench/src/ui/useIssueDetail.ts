'use client';
import type { IssueDetailResult, IssueSourceFact } from '../model/issue-source.js';
import { useCallback, useEffect, useRef, useState } from 'react';
import { refreshRequest, useSourceClient } from './source-client';

type Page = IssueDetailResult & { nextOffset: number | null };
export function useIssueDetail(number: number | undefined, active: boolean) {
  const { sourceQuery: SOURCE_QUERY, fetch: sourceFetch } = useSourceClient();
  const [detail, setDetail] = useState<IssueSourceFact | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [loaded, setLoaded] = useState(false);
  const generation = useRef(0);
  const requestOrder = useRef(0);
  const flight = useRef<Promise<void> | null>(null);
  const current = useRef<IssueSourceFact | null>(null);
  const retryAt = useRef(0);
  const lastAttempt = useRef(0);
  const apply = useCallback((page: Page, epoch: number) => {
    if (epoch !== generation.current) return;
    if (page.detail) {
      current.current = page.detail;
      setDetail(page.detail);
    }
    retryAt.current = Date.parse(page.retryAt ?? '') || 0;
    setError(
      page.failures.map((f) => f.message).join(' ') +
        (page.retryAt ? ` 可重试时间 ${new Date(page.retryAt).toLocaleString()}` : ''),
    );
  }, []);
  const refresh = useCallback((): Promise<void> => {
    if (!active || !number || Date.now() < retryAt.current) return Promise.resolve();
    if (flight.current) return flight.current;
    const epoch = generation.current;
    const order = ++requestOrder.current;
    lastAttempt.current = Date.now();
    setBusy(true);
    const run = (async () => {
      try {
        const response = await sourceFetch(
          `/api/issue-source/issues/${number}/refresh?${SOURCE_QUERY}`,
          refreshRequest,
        );
        if (!response.ok) throw new Error('source unavailable');
        const page: Page = await response.json();
        if (order === requestOrder.current) apply(page, epoch);
      } catch {
        if (epoch === generation.current) setError('讨论核对失败；上次内容和未保存输入仍保留。');
      } finally {
        if (epoch === generation.current) {
          setBusy(false);
          setLoaded(true);
          flight.current = null;
        }
      }
    })();
    flight.current = run;
    return run;
  }, [number, active, apply, SOURCE_QUERY, sourceFetch]);
  useEffect(() => {
    generation.current++;
    const epoch = generation.current;
    const order = ++requestOrder.current;
    current.current = null;
    flight.current = null;
    retryAt.current = 0;
    lastAttempt.current = 0;
    setDetail(null);
    setLoaded(false);
    setError('');
    setBusy(false);
    if (!number || !active) return;
    void (async () => {
      try {
        const response = await sourceFetch(`/api/issue-source/issues/${number}?${SOURCE_QUERY}`);
        if (!response.ok) throw new Error('unavailable');
        const page: Page = await response.json();
        if (epoch !== generation.current || order !== requestOrder.current) return;
        apply(page, epoch);
        setLoaded(true);
        if (!page.detail || Date.now() - Date.parse(page.detail.fetchedAt ?? '') > 5 * 60_000) void refresh();
      } catch {
        if (epoch === generation.current && order === requestOrder.current) {
          setLoaded(true);
          setError('此问题内容暂不可用；未下载的内容无法离线读取。');
        }
      }
    })();
    const check = () => {
      if (
        document.visibilityState !== 'hidden' &&
        Date.now() - Math.max(lastAttempt.current, Date.parse(current.current?.fetchedAt ?? '') || 0) > 5 * 60_000
      )
        void refresh();
    };
    const timer = window.setInterval(check, 60_000);
    document.addEventListener('visibilitychange', check);
    return () => {
      generation.current++;
      window.clearInterval(timer);
      document.removeEventListener('visibilitychange', check);
    };
  }, [number, active, refresh, apply, SOURCE_QUERY, sourceFetch]);
  const loadVersion = useCallback(
    async (version: string, offset = 0) => {
      const response = await sourceFetch(
        `/api/issue-source/issues/${number}?${SOURCE_QUERY}&version=${version}&offset=${offset}`,
      );
      if (!response.ok) throw new Error('来源档案暂不可用');
      const page: Page = await response.json();
      if (!page.detail || page.detail.detailVersion !== version) throw new Error('来源档案暂不可用');
      return page.detail;
    },
    [number, SOURCE_QUERY, sourceFetch],
  );
  return { detail: detail?.number === number ? detail : null, busy, error, loaded, refresh, loadVersion };
}
