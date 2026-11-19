import type Database from 'better-sqlite3';

export function refreshAnchorMetrics(db: Database.Database): void {
  const cutoff = Date.now() - 30 * 86_400_000;
  const rows30d = db
    .prepare('SELECT candidates_json, consumed_json, timestamp FROM recall_events WHERE timestamp >= ?')
    .all(cutoff) as Array<{ candidates_json: string; consumed_json: string; timestamp: number }>;

  const anchors30d = new Map<string, { exposed: number; consumed: number }>();
  for (const row of rows30d) {
    const candidates = JSON.parse(row.candidates_json) as Array<{ anchor: string }>;
    const consumed = JSON.parse(row.consumed_json) as Array<{ anchor: string }>;
    const consumedSet = new Set(consumed.map((c) => c.anchor));
    for (const cand of candidates) {
      const entry = anchors30d.get(cand.anchor) ?? { exposed: 0, consumed: 0 };
      entry.exposed++;
      if (consumedSet.has(cand.anchor)) entry.consumed++;
      anchors30d.set(cand.anchor, entry);
    }
  }

  const allTimeRows = db
    .prepare("SELECT consumed_json, timestamp FROM recall_events WHERE consumed_json != '[]'")
    .all() as Array<{ consumed_json: string; timestamp: number }>;

  const lastConsumedAllTime = new Map<string, number>();
  for (const row of allTimeRows) {
    const consumed = JSON.parse(row.consumed_json) as Array<{ anchor: string }>;
    for (const c of consumed) {
      const prev = lastConsumedAllTime.get(c.anchor);
      if (!prev || row.timestamp > prev) lastConsumedAllTime.set(c.anchor, row.timestamp);
    }
  }

  const allAnchors = new Set([...anchors30d.keys(), ...lastConsumedAllTime.keys()]);

  const upsert = db.prepare(`
    INSERT INTO anchor_recall_metrics (anchor, consumed_count_30d, exposure_count_30d, last_consumed_at, dormancy_days, updated_at)
    VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(anchor) DO UPDATE SET
      consumed_count_30d = excluded.consumed_count_30d,
      exposure_count_30d = excluded.exposure_count_30d,
      last_consumed_at = excluded.last_consumed_at,
      dormancy_days = excluded.dormancy_days,
      updated_at = excluded.updated_at
  `);

  const now = Date.now();
  const tx = db.transaction(() => {
    db.exec('DELETE FROM anchor_recall_metrics');
    for (const anchor of allAnchors) {
      const stats = anchors30d.get(anchor) ?? { exposed: 0, consumed: 0 };
      const lastConsumed = lastConsumedAllTime.get(anchor) ?? null;
      const lastAt = lastConsumed ? new Date(lastConsumed).toISOString() : null;
      const dormancy = lastConsumed !== null ? Math.floor((now - lastConsumed) / 86_400_000) : null;
      upsert.run(anchor, stats.consumed, stats.exposed, lastAt, dormancy, new Date().toISOString());
    }
  });
  tx();
}

export function refreshGlobalCtrBaseline(db: Database.Database): void {
  const rows = db
    .prepare(`
      SELECT ed.kind AS doc_kind,
             arm.consumed_count_30d AS consumed,
             arm.exposure_count_30d AS exposure
      FROM anchor_recall_metrics arm
      JOIN evidence_docs ed ON ed.anchor = arm.anchor
      WHERE arm.exposure_count_30d > 0
    `)
    .all() as Array<{ doc_kind: string; consumed: number; exposure: number }>;

  const byKind = new Map<string, { sum: number; count: number }>();
  for (const r of rows) {
    const entry = byKind.get(r.doc_kind) ?? { sum: 0, count: 0 };
    entry.sum += r.consumed / Math.max(r.exposure, 1);
    entry.count++;
    byKind.set(r.doc_kind, entry);
  }

  const upsert = db.prepare(`
    INSERT INTO global_ctr_baseline (doc_kind, mean_ctr, sample_count, updated_at)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(doc_kind) DO UPDATE SET mean_ctr = excluded.mean_ctr, sample_count = excluded.sample_count, updated_at = excluded.updated_at
  `);

  const now = Date.now();
  const tx = db.transaction(() => {
    for (const [kind, stats] of byKind) {
      upsert.run(kind, stats.sum / stats.count, stats.count, now);
    }
  });
  tx();
}
