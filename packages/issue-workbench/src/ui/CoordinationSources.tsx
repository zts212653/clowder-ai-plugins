import type { CoordinationHost, CoordinationSource, SourcePreference } from '../model/issue-coordination.js';
import { useState } from 'react';
import styles from './coordination.module.css';

export function CoordinationSources({
  sources,
  host,
  reload,
}: {
  sources: CoordinationSource[];
  host: CoordinationHost;
  reload: () => Promise<void>;
}) {
  return (
    <details className={styles.configuration}>
      <summary>管理来源</summary>
      <div className={styles.configurationPanel}>
        <p>管理已授权来源的名称和读取状态。添加新站点需先由宿主配置连接。</p>
        {sources.map((source) => (
          <SourceForm
            key={source.profile.id + ':' + source.preference.revision}
            source={source}
            host={host}
            reload={reload}
          />
        ))}
        {host.legacyUrl && (
          <a href={host.legacyUrl} target="_blank" rel="noreferrer">
            原单仓工作台与旧记录 ↗
          </a>
        )}
      </div>
    </details>
  );
}
function SourceForm({
  source,
  host,
  reload,
}: {
  source: CoordinationSource;
  host: CoordinationHost;
  reload: () => Promise<void>;
}) {
  const [value, setValue] = useState<SourcePreference>(source.preference.value);
  const [busy, setBusy] = useState(false),
    [error, setError] = useState('');
  return (
    <form
      className={styles.sourceForm}
      onSubmit={async (e) => {
        e.preventDefault();
        setBusy(true);
        setError('');
        try {
          await host.savePreference(source.profile.id, value, source.preference.revision);
          await reload();
        } catch (e) {
          setError((e as Error).message);
        } finally {
          setBusy(false);
        }
      }}
    >
      <label>
        <input
          type="checkbox"
          checked={value.enabled}
          onChange={(e) => setValue({ ...value, enabled: e.target.checked })}
        />{' '}
        {source.profile.repository}
        {source.profile.synthetic ? ' · 合成测试源' : ''}
      </label>
      <span className={styles.muted}>{source.profile.instance}</span>
      <div className={styles.fields}>
        {(['name'] as const).map((key) => (
          <label key={key}>
            显示名称
            <input value={value[key]} onChange={(e) => setValue({ ...value, [key]: e.target.value })} />
          </label>
        ))}
      </div>
      <button disabled={busy}>{busy ? '保存中…' : '保存来源配置'}</button>
      {error && <p role="alert">{error}</p>}
    </form>
  );
}

export function CoordinationSourceStatus({ source: s }: { source: CoordinationSource }) {
  return (
    <details className={styles.sourceStatus}>
      <summary>
        {s.preference.value.name} ·{' '}
        {s.profile.synthetic ? '合成测试' : s.profile.visibility === 'public' ? '公开' : '内部'}
        {s.error ? (
          <span className={styles.sourceError} role="status">
            {s.error}
          </span>
        ) : !s.preference.value.enabled ? (
          ' · 已暂停'
        ) : (
          ''
        )}
      </summary>
      <div className={styles.sourceStatusBody}>
        <span>
          {!s.preference.value.enabled
            ? '已暂停读取'
            : s.checkedAt
              ? `上次完整检查 ${new Date(s.checkedAt).toLocaleString()}`
              : '尚未完整检查'}
        </span>
        {s.retryAt && <span>可重试时间 {new Date(s.retryAt).toLocaleString()}</span>}
      </div>
    </details>
  );
}
