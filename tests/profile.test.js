import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { compareProfiles, summarizeProfile } from '../src/profile.js';

const frame = (functionName, url = 'file:///app.js') => ({ functionName, url, lineNumber: 0, columnNumber: 0 });
function profile(ids = [2, 3], deltas = [1000, 3000]) {
  return {
    nodes: [
      { id: 1, callFrame: frame('(root)', ''), children: [2, 3] },
      { id: 2, callFrame: frame('fast') },
      { id: 3, callFrame: frame('slow') },
    ],
    samples: ids,
    timeDeltas: deltas,
  };
}

test('attributes weighted microseconds to the sampled leaf frame', () => {
  const result = summarizeProfile(profile());
  assert.equal(result.sampledUs, 4000);
  assert.equal(result.functionUs, 4000);
  assert.equal([...result.frames.values()].find((f) => f.name === 'slow').selfUs, 3000);
});

test('excludes idle samples from function-share denominator but reports them', () => {
  const input = profile([2, 3], [1000, 3000]);
  input.nodes[2].callFrame.functionName = '(idle)';
  const result = summarizeProfile(input);
  assert.equal(result.functionUs, 1000);
  assert.equal(result.excludedUs, 3000);
  assert.equal(result.frames.size, 1);
});

test('compares shares when recording lengths differ', () => {
  const before = profile([2, 3], [1000, 3000]);
  const after = profile([2, 2, 3], [1000, 3000, 4000]);
  const rows = compareProfiles(before, after).rows;
  const fast = rows.find((row) => row.name === 'fast');
  assert.equal(fast.baselineShare, 0.25);
  assert.equal(fast.candidateShare, 0.5);
  assert.equal(fast.deltaPp, 25);
  assert.equal(rows[0].name, 'fast');
});

test('matches functions by source location, not just by name', () => {
  const before = profile([2], [1000]);
  const after = profile([2], [1000]);
  after.nodes[1].callFrame.url = 'file:///other.js';
  assert.equal(compareProfiles(before, after).rows.length, 2);
});

test('rejects missing, mismatched, and unknown samples', () => {
  const missing = profile();
  delete missing.samples;
  assert.throws(() => summarizeProfile(missing), /samples/);
  assert.throws(() => summarizeProfile(profile([2], [1000, 2000])), /equal length/);
  assert.throws(() => summarizeProfile(profile([42], [1000])), /unknown node/);
});

test('rejects negative and unsafe sample intervals', () => {
  assert.throws(() => summarizeProfile(profile([2], [-1])), /time delta/);
  assert.throws(() => summarizeProfile(profile([2], [Number.MAX_SAFE_INTEGER + 1])), /time delta/);
});

test('rejects malformed profile trees', () => {
  const duplicate = profile();
  duplicate.nodes[2].id = 2;
  assert.throws(() => summarizeProfile(duplicate), /unique integers/);
  const unknown = profile();
  unknown.nodes[0].children = [2, 99];
  assert.throws(() => summarizeProfile(unknown), /unknown child/);
  const disconnected = profile();
  disconnected.nodes[0].children = [2];
  assert.throws(() => summarizeProfile(disconnected), /disconnected/);
  const cycle = profile();
  cycle.nodes[2].children = [1];
  assert.throws(() => summarizeProfile(cycle), /root/);
});

test('rejects a profile containing only internal frames', () => {
  assert.throws(() => summarizeProfile(profile([1, 1], [1000, 1000])), /no usable/);
});

test('checked-in demo profiles reproduce the evidence', () => {
  const read = (name) => JSON.parse(readFileSync(new URL(`../examples/${name}`, import.meta.url), 'utf8'));
  const result = compareProfiles(read('baseline.cpuprofile'), read('candidate.cpuprofile'));
  const evidence = read('demo-evidence.json');
  assert.equal(result.baseline.sampleCount, evidence.baselineSamples);
  assert.equal(result.candidate.sampleCount, evidence.candidateSamples);
  const render = result.rows.find((row) => row.name === 'renderCards');
  assert.equal(Math.round(render.deltaPp * 1000) / 1000, evidence.rows.find((row) => row.name === 'renderCards').deltaPp);
});
