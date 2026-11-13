import { compareProfiles } from './profile.js';

const $ = (id) => document.getElementById(id);
const state = { baseline: null, candidate: null, names: ['', ''], demo: true, result: null };
const MAX_FILE_BYTES = 15 * 1024 * 1024;

function text(id, value) { $(id).textContent = value; }
function element(tag, className, content) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (content !== undefined) node.textContent = content;
  return node;
}
function formatMs(us) { return `${(us / 1000).toFixed(0)} ms`; }
function formatShare(value) { return `${(value * 100).toFixed(1)}%`; }
function formatDelta(value) { return `${value > 0 ? '+' : ''}${value.toFixed(1)} pp`; }
function source(frame) {
  const location = frame.url || 'No source URL';
  return frame.line >= 0 ? `${location}:${frame.line + 1}${frame.column >= 0 ? `:${frame.column + 1}` : ''}` : location;
}
function setStatus(message, error = false) {
  text('status', message);
  $('status').classList.toggle('error', error);
}

function renderChart(rows) {
  const chart = $('bar-chart');
  chart.replaceChildren();
  const top = rows.filter((row) => row.deltaPp > 0).slice(0, 6);
  const shown = top.length ? top : rows.slice(0, 6);
  const maxShare = Math.max(0.01, ...shown.flatMap((row) => [row.baselineShare, row.candidateShare]));
  for (const row of shown) {
    const entry = element('div', 'chart-row');
    const label = element('div', 'chart-label');
    label.append(element('strong', '', row.name), element('small', '', source(row)));
    const barSide = element('div', 'chart-bars');
    for (const [kind, share] of [['base', row.baselineShare], ['next', row.candidateShare]]) {
      const line = element('div', 'bar-line');
      const bar = element('span', `bar ${kind}`);
      bar.style.width = `${Math.max(share > 0 ? 1 : 0, share / maxShare * 100)}%`;
      line.append(bar, element('span', 'bar-value', formatShare(share)));
      barSide.append(line);
    }
    entry.append(label, barSide, element('strong', row.deltaPp > 0 ? 'delta up' : 'delta down', formatDelta(row.deltaPp)));
    chart.append(entry);
  }
}

function renderTable(rows) {
  const query = $('filter').value.trim().toLowerCase();
  const filtered = rows.filter((row) => `${row.name} ${row.url}`.toLowerCase().includes(query));
  const body = $('rows');
  body.replaceChildren();
  for (const row of filtered) {
    const tr = element('tr');
    const name = element('td');
    name.append(element('strong', '', row.name), element('span', 'source-path', source(row)));
    tr.append(name, element('td', 'mono', formatShare(row.baselineShare)), element('td', 'mono', formatShare(row.candidateShare)));
    tr.append(element('td', row.deltaPp > 0 ? 'mono delta-up' : 'mono delta-down', formatDelta(row.deltaPp)));
    body.append(tr);
  }
  if (!filtered.length) {
    const tr = element('tr');
    const cell = element('td', 'empty-state', 'No functions match this filter.');
    cell.colSpan = 4;
    tr.append(cell);
    body.append(tr);
  }
  text('row-count', `Showing ${filtered.length} of ${rows.length} source locations · ranked by increase in function-time share.`);
}

function render() {
  if (!state.baseline || !state.candidate) return;
  const result = compareProfiles(state.baseline, state.candidate);
  state.result = result;
  text('baseline-name', state.names[0]);
  text('candidate-name', state.names[1]);
  text('data-tag', state.demo ? 'SYNTHETIC EXAMPLE' : 'LOCAL PROFILE COMPARISON');
  text('baseline-time', formatMs(result.baseline.functionUs));
  text('candidate-time', formatMs(result.candidate.functionUs));
  text('baseline-count', `${result.baseline.sampleCount.toLocaleString()} samples · ${result.baseline.nodeCount.toLocaleString()} nodes`);
  text('candidate-count', `${result.candidate.sampleCount.toLocaleString()} samples · ${result.candidate.nodeCount.toLocaleString()} nodes`);
  text('excluded-share', `${formatShare(result.baseline.excludedUs / result.baseline.sampledUs)} → ${formatShare(result.candidate.excludedUs / result.candidate.sampledUs)}`);
  const top = result.rows.find((row) => row.deltaPp > 0);
  text('top-function', top?.name ?? 'No increase');
  text('top-delta', top ? `${formatDelta(top.deltaPp)} of sampled function time` : 'All matched frames stayed level or decreased');
  text('interpretation', state.demo
    ? 'Constructed example: renderCards takes a larger share in the candidate. These profiles are deliberately generated to show the workflow; they are not a measured performance regression.'
    : 'A larger share is a lead for investigation, not proof of a slower release. Check that both profiles used comparable workloads and repeat the measurement.');
  renderChart(result.rows);
  renderTable(result.rows);
  $('results').hidden = false;
  setStatus(state.demo ? 'Showing the built-in synthetic example. Your files stay in this browser.' : 'Comparison ready. Both files were processed in this browser.');
}

async function loadDemo() {
  try {
    const files = await Promise.all(['baseline', 'candidate'].map(async (side) => {
      const response = await fetch(`./examples/${side}.cpuprofile`);
      if (!response.ok) throw new Error('Could not load the built-in example');
      return response.json();
    }));
    compareProfiles(files[0], files[1]);
    [state.baseline, state.candidate] = files;
    state.names = ['Synthetic catalog · baseline', 'Synthetic catalog · candidate'];
    state.demo = true;
    $('filter').value = '';
    $('baseline-file').value = '';
    $('candidate-file').value = '';
    render();
  } catch (error) {
    setStatus(`Demo unavailable: ${error.message}. Serve this directory over HTTP to load its example files.`, true);
  }
}

async function loadFile(side, file) {
  if (!file) return;
  try {
    if (file.size > MAX_FILE_BYTES) throw new Error('File is over the 15 MB browser limit');
    const parsed = JSON.parse(await file.text());
    // Validate the replacement before changing either displayed profile.
    const other = side === 'baseline' ? state.candidate : state.baseline;
    if (other) compareProfiles(side === 'baseline' ? parsed : other, side === 'candidate' ? parsed : other);
    const next = { ...state, [side]: parsed, demo: false };
    state.baseline = next.baseline;
    state.candidate = next.candidate;
    state.demo = false;
    state.names[side === 'baseline' ? 0 : 1] = file.name;
    render();
  } catch (error) {
    setStatus(`Could not read ${file.name}: ${error.message}`, true);
  }
}

function csvCell(value) {
  if (typeof value === 'number') return String(value);
  const safe = String(value).replace(/^([\s]*[=+@-])/, "'$1");
  return `"${safe.replaceAll('"', '""')}"`;
}
function downloadCsv() {
  if (!state.result) return;
  const header = ['function', 'source', 'baseline_self_ms', 'candidate_self_ms', 'baseline_share', 'candidate_share', 'change_percentage_points'];
  const lines = [header.map(csvCell).join(',')];
  for (const row of state.result.rows) {
    lines.push([row.name, source(row), row.baselineMs, row.candidateMs, row.baselineShare, row.candidateShare, row.deltaPp].map(csvCell).join(','));
  }
  const blob = new Blob([`${lines.join('\n')}\n`], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = 'flamedelta-comparison.csv';
  anchor.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

$('baseline-file').addEventListener('change', (event) => loadFile('baseline', event.target.files?.[0]));
$('candidate-file').addEventListener('change', (event) => loadFile('candidate', event.target.files?.[0]));
$('reset').addEventListener('click', loadDemo);
$('filter').addEventListener('input', () => { if (state.result) renderTable(state.result.rows); });
$('download').addEventListener('click', downloadCsv);
loadDemo();
