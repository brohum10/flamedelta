import { writeFileSync } from 'node:fs';
import { compareProfiles } from '../src/profile.js';

const functions = [
  ['renderCards', 'demo://catalog/render.js', 42],
  ['sortRows', 'demo://catalog/sort.js', 18],
  ['parsePayload', 'demo://catalog/data.js', 31],
  ['formatPrice', 'demo://catalog/format.js', 9],
  ['commitView', 'demo://catalog/view.js', 57],
  ['(idle)', '', 0],
];

function makeProfile(counts) {
  const nodes = [{ id: 1, callFrame: { functionName: '(root)', url: '', lineNumber: -1, columnNumber: -1 }, children: functions.map((_, i) => i + 2) }];
  functions.forEach(([functionName, url, lineNumber], i) => {
    nodes.push({ id: i + 2, callFrame: { functionName, url, lineNumber, columnNumber: 0 } });
  });
  // Interleave samples, rather than clustering a whole function's samples together.
  const remaining = counts.slice();
  const samples = [];
  while (remaining.some(Boolean)) {
    for (let i = 0; i < remaining.length; i += 1) {
      if (remaining[i] > 0) { samples.push(i + 2); remaining[i] -= 1; }
    }
  }
  return { nodes, startTime: 0, endTime: samples.length * 5_000, samples, timeDeltas: samples.map(() => 5_000) };
}

const baseline = makeProfile([40, 35, 35, 30, 40, 20]);
const candidate = makeProfile([68, 28, 25, 20, 35, 24]);
const result = compareProfiles(baseline, candidate);
const save = (path, value) => writeFileSync(new URL(path, import.meta.url), `${JSON.stringify(value, null, 2)}\n`);
save('../examples/baseline.cpuprofile', baseline);
save('../examples/candidate.cpuprofile', candidate);
save('../examples/demo-evidence.json', {
  notice: 'Constructed demonstration data, not a measured product regression.',
  baselineSamples: result.baseline.sampleCount,
  candidateSamples: result.candidate.sampleCount,
  baselineFunctionMs: result.baseline.functionUs / 1000,
  candidateFunctionMs: result.candidate.functionUs / 1000,
  rows: result.rows.map(({ name, baselineMs, candidateMs, baselineShare, candidateShare, deltaPp }) => ({
    name, baselineMs, candidateMs, baselineShare, candidateShare, deltaPp: Math.round(deltaPp * 1000) / 1000,
  })),
});
console.log('Regenerated synthetic profiles and comparison evidence.');
