const MAX_NODES = 100_000;
const MAX_SAMPLES = 1_000_000;
const INTERNAL_FRAME = /^(?:\(root\)|\(idle\)|\(program\)|\(garbage collector\)|<root>|<idle>|<program>)$/i;

function fail(message) {
  throw new Error(message);
}

function frameFor(node) {
  const frame = node.callFrame;
  if (!frame || typeof frame !== 'object') fail(`Node ${node.id} has no callFrame`);
  const name = typeof frame.functionName === 'string' && frame.functionName.trim()
    ? frame.functionName.trim() : '(anonymous)';
  const url = typeof frame.url === 'string' ? frame.url : '';
  const line = Number.isInteger(frame.lineNumber) ? frame.lineNumber : -1;
  const column = Number.isInteger(frame.columnNumber) ? frame.columnNumber : -1;
  return { name, url, line, column, key: JSON.stringify([name, url, line, column]) };
}

/** Turn one Chrome/Node .cpuprofile into estimated, exclusive sampled time per source location. */
export function summarizeProfile(profile) {
  if (!profile || typeof profile !== 'object' || Array.isArray(profile)) fail('Expected a CPU profile JSON object');
  const { nodes, samples, timeDeltas } = profile;
  if (!Array.isArray(nodes) || !nodes.length || nodes.length > MAX_NODES) fail('Profile needs 1–100,000 nodes');
  if (!Array.isArray(samples) || !samples.length || samples.length > MAX_SAMPLES) fail('Profile needs 1–1,000,000 samples');
  if (!Array.isArray(timeDeltas) || timeDeltas.length !== samples.length) {
    fail('samples and timeDeltas must be arrays of equal length');
  }

  const byId = new Map();
  for (const node of nodes) {
    if (!node || !Number.isInteger(node.id) || byId.has(node.id)) fail('Node IDs must be unique integers');
    if (node.children !== undefined && !Array.isArray(node.children)) fail(`Node ${node.id} has invalid children`);
    byId.set(node.id, { node, frame: frameFor(node), children: node.children ?? [] });
  }

  const parents = new Map();
  for (const [id, entry] of byId) {
    for (const child of entry.children) {
      if (!Number.isInteger(child) || !byId.has(child)) fail(`Node ${id} refers to an unknown child`);
      if (parents.has(child)) fail(`Node ${child} has multiple parents`);
      parents.set(child, id);
    }
  }
  const root = nodes[0].id;
  if (parents.has(root)) fail('The first node must be the root');
  // Memoized parent walks catch cycles and disconnected subtrees in linear time.
  const connected = new Set([root]);
  for (const id of byId.keys()) {
    const path = [];
    const seen = new Set();
    let cursor = id;
    while (!connected.has(cursor)) {
      if (seen.has(cursor)) fail('Profile node graph contains a cycle');
      seen.add(cursor);
      path.push(cursor);
      cursor = parents.get(cursor);
      if (cursor === undefined) fail(`Node ${id} is disconnected from the root`);
    }
    for (const entry of path) connected.add(entry);
  }

  const frames = new Map();
  let sampledUs = 0;
  let functionUs = 0;
  let excludedUs = 0;
  for (let i = 0; i < samples.length; i += 1) {
    const delta = timeDeltas[i];
    if (!Number.isSafeInteger(delta) || delta < 0) fail(`Invalid time delta at sample ${i}`);
    const entry = byId.get(samples[i]);
    if (!entry) fail(`Sample ${i} refers to an unknown node`);
    sampledUs += delta;
    if (!Number.isSafeInteger(sampledUs)) fail('Sampled duration is too large');
    if (INTERNAL_FRAME.test(entry.frame.name)) {
      excludedUs += delta;
      continue;
    }
    functionUs += delta;
    const existing = frames.get(entry.frame.key) ?? { ...entry.frame, selfUs: 0, sampleCount: 0 };
    existing.selfUs += delta;
    existing.sampleCount += 1;
    frames.set(entry.frame.key, existing);
  }
  if (sampledUs === 0 || functionUs === 0) fail('Profile has no usable function samples');
  return {
    sampledUs, functionUs, excludedUs, sampleCount: samples.length,
    nodeCount: nodes.length,
    frames,
  };
}

/** Compare active function-time shares, so unequal recording lengths do not dominate the ranking. */
export function compareProfiles(baseline, candidate) {
  const left = summarizeProfile(baseline);
  const right = summarizeProfile(candidate);
  const keys = new Set([...left.frames.keys(), ...right.frames.keys()]);
  const rows = [...keys].map((key) => {
    const before = left.frames.get(key);
    const after = right.frames.get(key);
    const frame = after ?? before;
    const baselineShare = (before?.selfUs ?? 0) / left.functionUs;
    const candidateShare = (after?.selfUs ?? 0) / right.functionUs;
    return {
      key, name: frame.name, url: frame.url, line: frame.line, column: frame.column,
      baselineMs: (before?.selfUs ?? 0) / 1000,
      candidateMs: (after?.selfUs ?? 0) / 1000,
      baselineShare, candidateShare,
      deltaPp: (candidateShare - baselineShare) * 100,
      baselineSamples: before?.sampleCount ?? 0,
      candidateSamples: after?.sampleCount ?? 0,
    };
  });
  rows.sort((a, b) => b.deltaPp - a.deltaPp || a.name.localeCompare(b.name) || a.key.localeCompare(b.key));
  return { baseline: left, candidate: right, rows };
}
