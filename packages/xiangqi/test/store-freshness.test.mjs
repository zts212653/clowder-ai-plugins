import assert from 'node:assert/strict';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import test from 'node:test';
import { analyzeGame, createGame, playGame, readCurrentAnalysis, undoGame } from '../src/store.mjs';

test('analysis cannot cross storage roots or survive a version, safety, or revision change', (t) => {
  const first = mkdtempSync(join(tmpdir(), 'xiangqi-analysis-a-'));
  const second = mkdtempSync(join(tmpdir(), 'xiangqi-analysis-b-'));
  t.after(() => {
    rmSync(first, { recursive: true, force: true });
    rmSync(second, { recursive: true, force: true });
  });
  for (const root of [first, second]) {
    createGame(root, 'same-game');
    playGame(root, 'same-game', 'b2e2', { actor: 'human', expectedRevision: 0, origin: 'board' });
  }
  const firstReport = analyzeGame(first, 'same-game', { timeMs: 30, maxDepth: 2 });
  const secondReports = join(second, 'same-game-analysis');
  mkdirSync(secondReports);
  copyFileSync(firstReport.analysisFile, join(secondReports, basename(firstReport.analysisFile)));
  assert.equal(readCurrentAnalysis(second, 'same-game', 1), null);
  assert.throws(
    () => playGame(second, 'same-game', firstReport.candidates[0].ucci, { actor: 'companion', expectedRevision: 1 }),
    /先 analyze/,
  );

  const ownReport = analyzeGame(second, 'same-game', { timeMs: 30, maxDepth: 2 });
  assert.equal(readCurrentAnalysis(second, 'same-game', 1)?.dataRoot, ownReport.dataRoot);
  const original = readFileSync(ownReport.analysisFile);
  const changed = JSON.parse(original.toString());
  changed.searchVersion = 'old-search';
  writeFileSync(ownReport.analysisFile, JSON.stringify(changed));
  assert.equal(readCurrentAnalysis(second, 'same-game', 1), null);
  changed.searchVersion = ownReport.searchVersion;
  changed.safetyComplete = false;
  writeFileSync(ownReport.analysisFile, JSON.stringify(changed));
  assert.equal(readCurrentAnalysis(second, 'same-game', 1), null);
  writeFileSync(ownReport.analysisFile, original);
  playGame(second, 'same-game', ownReport.candidates[0].ucci, { actor: 'companion', expectedRevision: 1 });
  assert.throws(() => readCurrentAnalysis(second, 'same-game', 1), /版本冲突/);
  undoGame(second, 'same-game', 2, 2);
  assert.equal(readCurrentAnalysis(second, 'same-game', 3), null);
});
