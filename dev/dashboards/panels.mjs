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
  // Loki tells instant and range queries apart by queryType; Prometheus by `instant`.
  const loki = ds.type === 'loki' ? { queryType: extra.instant ? 'instant' : 'range' } : {};
  return { refId, datasource: ds, expr, legendFormat, ...loki, ...extra };
}

/** queries: [[expr, legend], ...] */
export function timeseries(title, queries, { unit = 'short', w = 12, h = 8, description, min, max, ds = PROMETHEUS, stacking, levelColors = false } = {}) {
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
        custom: {
          lineWidth: 1,
          fillOpacity: stacking ? 60 : 10,
          showPoints: 'never',
          spanNulls: false,
          ...(stacking ? { stacking: { mode: stacking, group: 'A' } } : {}),
        },
      },
      overrides: levelColors ? levelOverrides() : [],
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

/** Multi-select variable from a Loki label (All = any value). */
export function lokiLabelVariable(name, label, stream) {
  return {
    name,
    label,
    type: 'query',
    datasource: LOKI,
    definition: `label_values(${stream}, ${name})`,
    query: { qryType: 1, label: name, stream, refId: `LokiVariableQueryEditor-${name}` },
    refresh: 2,
    includeAll: true,
    multi: true,
    allValue: '.+',
    current: { selected: true, text: ['All'], value: ['$__all'] },
    sort: 1,
  };
}

export function textboxVariable(name, label) {
  return { name, label, type: 'textbox', query: '', current: { text: '', value: '' }, hide: 0 };
}

/** Level colors used by every log panel: same meaning everywhere. */
export const LEVEL_COLORS = { ERROR: 'red', WARN: 'yellow', INFO: 'green', DEBUG: 'blue', TRACE: 'purple' };

function levelOverrides() {
  return Object.entries(LEVEL_COLORS).map(([level, color]) => ({
    matcher: { id: 'byName', options: level },
    properties: [{ id: 'color', value: { mode: 'fixed', fixedColor: color } }],
  }));
}

/**
 * Share of each series over the selected range. The queries are range queries of non-overlapping
 * windows (e.g. count_over_time(...[$__interval])) summed per series: a Loki instant query comes back
 * as one merged field and would draw a single slice.
 */
export function piechart(title, queries, { w = 8, h = 8, description, ds = PROMETHEUS, levelColors = false } = {}) {
  return {
    type: 'piechart',
    title,
    ...(description ? { description } : {}),
    datasource: ds,
    size: { w, h },
    targets: queries.map(([expr, legend], i) => target(ds, expr, legend, {}, String.fromCharCode(65 + i))),
    fieldConfig: { defaults: { unit: 'short' }, overrides: levelColors ? levelOverrides() : [] },
    options: {
      reduceOptions: { calcs: ['sum'], fields: '', values: false },
      pieType: 'donut',
      legend: { displayMode: 'table', placement: 'right', values: ['value', 'percent'] },
      tooltip: { mode: 'single' },
    },
  };
}

/** Log lines, newest first, with details (all JSON keys) on click. */
export function logs(title, expr, { w = 24, h = 16, description, ds = LOKI } = {}) {
  return {
    type: 'logs',
    title,
    ...(description ? { description } : {}),
    datasource: ds,
    size: { w, h },
    targets: [target(ds, expr, '', { queryType: 'range' })],
    options: {
      showTime: true,
      showLabels: false,
      showCommonLabels: false,
      wrapLogMessage: true,
      prettifyLogMessage: false,
      enableLogDetails: true,
      sortOrder: 'Descending',
      dedupStrategy: 'none',
    },
  };
}

/** A single ratio (0..1) as a dial, e.g. heap used against its limit. */
export function gauge(title, expr, { w = 6, h = 5, description, thresholds, ds = PROMETHEUS } = {}) {
  return {
    type: 'gauge',
    title,
    ...(description ? { description } : {}),
    datasource: ds,
    size: { w, h },
    targets: [target(ds, expr, '', { instant: true })],
    fieldConfig: {
      defaults: {
        unit: 'percentunit',
        min: 0,
        max: 1,
        decimals: 1,
        thresholds: thresholds ?? {
          mode: 'absolute',
          steps: [
            { color: 'green', value: null },
            { color: 'yellow', value: 0.7 },
            { color: 'red', value: 0.85 },
          ],
        },
        color: { mode: 'thresholds' },
      },
      overrides: [],
    },
    options: { reduceOptions: { calcs: ['lastNotNull'], fields: '', values: false }, showThresholdMarkers: true },
  };
}

/** Instant query shown as a table, keeping only the listed labels (renamed to Korean headers). */
export function table(title, expr, columns, { w = 12, h = 8, description, ds = PROMETHEUS, unit } = {}) {
  // The value column is "Value" for Prometheus and "Value #A" for Loki instant tables.
  if ('Value' in columns) columns = { ...columns, 'Value #A': columns.Value };
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

/** links: [{ title, uid, query? }] to other dashboards, keeping the time range; query presets their variables. */
export function dashboard({ uid, title, description, panels, variables, tags = ['expo'], links = [] }) {
  return {
    uid,
    title,
    description,
    tags,
    links: links.map((link) => ({
      title: link.title,
      type: 'link',
      url: `/d/${link.uid}${link.query ? `?${link.query}` : ''}`,
      keepTime: true,
      includeVars: false,
      targetBlank: false,
      icon: 'dashboard',
    })),
    schemaVersion: 39,
    version: 1,
    editable: false,
    time: { from: 'now-1h', to: 'now' },
    refresh: '30s',
    templating: { list: variables },
    panels: layout(panels),
  };
}
