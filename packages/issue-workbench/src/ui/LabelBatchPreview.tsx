'use client';

import { useEffect, useRef } from 'react';
import styles from './workbench.module.css';
import { type makeBatch, sourceTime } from './workbench-model';

export function LabelBatchPreview({
  batch,
  stale,
  onClose,
  onDownload,
}: {
  batch: ReturnType<typeof makeBatch>;
  stale?: boolean;
  onClose: () => void;
  onDownload: () => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const element = dialog.current;
    element?.showModal();
    return () => element?.close();
  }, []);
  return (
    <dialog ref={dialog} aria-label="标签变更批次预览" className={styles.batch} onCancel={onClose}>
      <div className={styles.header}>
        <div>
          <div className={styles.eyebrow}>READ / PREVIEW ONLY</div>
          <h2>标签变更批次预览</h2>
        </div>
        <button type="button" onClick={onClose}>
          关闭预览
        </button>
      </div>
      <p>这一版包含 {batch.items.length} 个问题，仅准备已有标签的增删。由具备权限的维护者复核后执行。</p>
      <p className={styles.hint}>
        目标：{batch.repo} · 基线：{sourceTime(batch.sourceFetchedAt)} ·
        此文件不是可执行批次。正式执行前须重拉线上数据检查冲突。
      </p>
      {stale && (
        <p role="status" className={styles.callout}>
          来源或本地草稿已变化，需关闭后重新预览。本批基线保持原样。
        </p>
      )}
      <div className={styles.batchItems}>
        {batch.items.map((item) => (
          <article key={item.number}>
            <b>
              #{item.number} · 本地版本 {item.localRevision}
            </b>
            <p>{item.title}</p>
            <div className={styles.row}>
              {item.add.map((label) => (
                <span className={styles.pill} key={label}>
                  + {label}
                </span>
              ))}
              {item.remove.map((label) => (
                <span className={styles.sourceTag} key={label}>
                  − {label}
                </span>
              ))}
            </div>
            <p className={styles.hint}>{item.reason}</p>
          </article>
        ))}
      </div>
      <div className={styles.row}>
        <button className={styles.primary} type="button" onClick={onDownload}>
          导出本批预览 JSON
        </button>
        <button type="button" disabled>
          同步到 GitHub · 需要写权限
        </button>
      </div>
    </dialog>
  );
}
