// Shared panel builders: every generated dashboard has a data source variable, Korean titles and a
// table legend with the last and max values, so they read the same way.

export const PROMETHEUS = { type: 'prometheus', uid: '${datasource}' };
export const LOKI = { type: 'loki', uid: '${datasource}' };

export function datasourceVariable(type, current) {
  return {
    name: 'datasource',
    label: '데이터 소스',
    type: 'datasource',
    query: type,
    current: { text: current.name, value: current.uid },
    hide: 0,
    refresh: 1,
  };
}

/** Assigns ids and places panels left to right on a 24-column grid, wrapping to new rows. */
export function layout(items) {
  let id = 1;
  let x = 0;
  let y = 0;
  let rowHeight = 0;
  return items.map((item) => {
    if (item.type === 'row') {
      if (x > 0) y += rowHeight;
      const row = { ...item, id: id++, gridPos: { h: 1, w: 24, x: 0, y } };
      y += 1;
      x = 0;
      rowHeight = 0;
      return row;
    }
    const { w, h } = item.size;
    if (x + w > 24) {
      y += rowHeight;
      x = 0;
      rowHeight = 0;
    }
    const { size, ...panel } = item;
    const placed = { ...panel, id: id++, gridPos: { h, w, x, y } };
    x += w;
    rowHeight = Math.max(rowHeight, h);
    return placed;
  });
}

export function row(title) {
  return { type: 'row', title, collapsed: false, panels: [] };
}

function target(ds, expr, legendFormat, extra = {}, refId = 'A') {
  return { refId, datasource: ds, expr, legendFormat, ...extra };
}

/** queries: [[expr, legend], ...] */
export function timeseries(title, queries, { unit = 'short', w = 12, h = 8, description, min, max, ds = PROMETHEUS } = {}) {
  return {
    type: 'timeseries',
    title,
    ...(description ? { description } : {}),
    datasource: ds,
    size: { w, h },
    targets: queries.map(([expr, legend], i) => target(ds, expr, legend, {}, String.fromCharCode(65 + i))),
    fieldConfig: {
      defaults: {
        unit,
        ...(min === undefined ? {} : { min }),
        ...(max === undefined ? {} : { max }),
        custom: { lineWidth: 1, fillOpacity: 10, showPoints: 'never', spanNulls: false },
      },
      overrides: [],
    },
    options: {
      legend: { displayMode: 'table', placement: 'bottom', calcs: ['lastNotNull', 'max'] },
      tooltip: { mode: 'multi', sort: 'desc' },
    },
  };
}

/** One tile per series. mappings/thresholds turn values into UP/DOWN or colored ratios. */
export function stat(title, queries, { unit = 'short', w = 6, h = 5, description, mappings = [], thresholds, colorMode = 'value', textMode = 'auto', ds = PROMETHEUS, decimals } = {}) {
  return {
    type: 'stat',
    title,
    ...(description ? { description } : {}),
    datasource: ds,
    size: { w, h },
    targets: queries.map(([expr, legend], i) => target(ds, expr, legend, { instant: true }, String.fromCharCode(65 + i))),
    fieldConfig: {
      defaults: {
        unit,
        ...(decimals === undefined ? {} : { decimals }),
        mappings,
        thresholds: thresholds ?? { mode: 'absolute', steps: [{ color: 'green', value: null }] },
        color: { mode: 'thresholds' },
      },
      overrides: [],
    },
    options: {
      reduceOptions: { calcs: ['lastNotNull'], fields: '', values: false },
      colorMode,
      graphMode: 'none',
      textMode,
      justifyMode: 'center',
      orientation: 'auto',
    },
  };
}

/** Instant query shown as a table, keeping only the listed labels (renamed to Korean headers). */
export function table(title, expr, columns, { w = 12, h = 8, description, ds = PROMETHEUS, unit } = {}) {
  const keep = Object.keys(columns);
  return {
    type: 'table',
    title,
    ...(description ? { description } : {}),
    datasource: ds,
    size: { w, h },
    targets: [target(ds, expr, '', { instant: true, format: 'table' })],
    fieldConfig: { defaults: { ...(unit ? { unit } : {}) }, overrides: [] },
    options: { showHeader: true, cellHeight: 'sm' },
    transformations: [
      {
        id: 'organize',
        options: {
          includeByName: Object.fromEntries(keep.map((name) => [name, true])),
          indexByName: Object.fromEntries(keep.map((name, i) => [name, i])),
          renameByName: columns,
        },
      },
    ],
  };
}

export const UP_DOWN = [
  {
    type: 'value',
    options: {
      0: { text: 'DOWN', color: 'red', index: 1 },
      1: { text: 'UP', color: 'green', index: 0 },
    },
  },
];

export const UP_THRESHOLDS = {
  mode: 'absolute',
  steps: [
    { color: 'red', value: null },
    { color: 'green', value: 1 },
  ],
};

/** Reference colors for hit ratios (not SLOs): red below 80%, yellow below 95%. */
export const RATIO_THRESHOLDS = {
  mode: 'absolute',
  steps: [
    { color: 'red', value: null },
    { color: 'yellow', value: 0.8 },
    { color: 'green', value: 0.95 },
  ],
};

export function dashboard({ uid, title, description, panels, variables, tags = ['expo'] }) {
  return {
    uid,
    title,
    description,
    tags,
    schemaVersion: 39,
    version: 1,
    editable: false,
    time: { from: 'now-1h', to: 'now' },
    refresh: '30s',
    templating: { list: variables },
    panels: layout(panels),
  };
}
