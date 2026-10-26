// Expo / Logs: log volume, errors per service, level mix and a filtered log stream, from Loki only
// (no metric panels; those live in Overview and the per-service dashboards). It relies on the log
// standard (docs/logging.md): labels job/service/level with uppercase levels, module as structured metadata.
import {
  LOKI,
  dashboard,
  datasourceVariable,
  logs,
  lokiLabelVariable,
  piechart,
  row,
  stat,
  table,
  textboxVariable,
  timeseries,
} from './panels.mjs';

const STREAM = '{job="expo"}';
const selected = '{job="expo", service=~"$service", level=~"$level"}';
const errors = '{job="expo", service=~"$service", level="ERROR"}';
// Lines that do not follow the standard arrive without service/level (docs/logging.md).
const nonStandard = '{job="expo", service=""}';

/** Loki `line_format` 템플릿: 표준 JSON 줄은 한 줄 요약, 그 밖의 줄은 원문. */
const READABLE_LINE = '{{ if .level }}{{ .level }}  {{ .service | replace "expo-" "" | replace "-server" "" }}  [{{ .module }}]  {{ .message }}{{ else }}{{ __line__ }}{{ end }}';

export function logsDashboard() {
  return dashboard({
    uid: 'expo-logs',
    title: 'Expo / Logs',
    description: '전 서비스 로그(Loki)의 양·서비스별 ERROR·레벨 비중과 서비스·레벨·검색어로 거른 로그. 메트릭 대시보드와 분리했습니다.',
    tags: ['expo', 'logs'],
    links: [{ title: 'Expo / Overview', uid: 'expo-overview' }],
    variables: [
      datasourceVariable('loki', { name: 'Loki', uid: 'loki' }),
      lokiLabelVariable('service', '서비스', STREAM),
      lokiLabelVariable('level', '로그 레벨', STREAM),
      textboxVariable('search', '검색어'),
    ],
    panels: [
      row('전체 현황'),
      timeseries('전체 로그량 추이 (초당)', [[`sum(rate(${selected} |= "$search" [1m]))`, '전체']], {
        ds: LOKI,
        unit: 'short',
        w: 16,
        description: '선택한 서비스·레벨의 초당 로그 줄 수 합계. 평소보다 갑자기 튀면 로그 폭주(재시도 루프, 오류 반복)를 의심합니다.',
      }),
      stat('표준을 따르지 않은 로그 줄 (5분)', [[`sum(count_over_time(${nonStandard} [5m])) or vector(0)`, '']], {
        ds: LOKI,
        w: 8,
        h: 8,
        description: 'JSON이 아니거나 service/level이 없는 줄(PM2 stderr의 크래시 스택 등). 0이 아니면 Explore에서 {job="expo", service=""}로 찾아 filename을 보고 그 서비스의 로그 출력을 고칩니다(수집기에 fallback을 넣지 않습니다).',
        thresholds: { mode: 'absolute', steps: [{ color: 'green', value: null }, { color: 'yellow', value: 1 }] },
      }),
      timeseries('서비스별 초당 ERROR 로그 수', [[`sum by (service) (rate(${errors} |= "$search" [1m]))`, '{{service}}']], {
        ds: LOKI,
        unit: 'short',
        description: 'level="ERROR" 로그를 서비스별로 묶었습니다. 어느 서비스에서 오류가 몰리는지 봅니다.',
      }),
      piechart('로그 레벨 분포 (선택 기간)', [[`sum by (level) (count_over_time(${selected} |= "$search" [$__interval]))`, '{{level}}']], {
        ds: LOKI,
        w: 12,
        levelColors: true,
        description: '선택한 시간 범위 전체의 레벨별 줄 수.',
      }),
      timeseries('레벨 비중 추이 (%)', [[
        `sum by (level) (rate(${selected} |= "$search" [5m])) / ignoring(level) group_left sum(rate(${selected} |= "$search" [5m]))`,
        '{{level}}',
      ]], {
        ds: LOKI,
        unit: 'percentunit',
        min: 0,
        max: 1,
        stacking: 'normal',
        levelColors: true,
        description: '5분 창의 레벨별 비율. 평소보다 WARN·ERROR 비중이 늘었는지 봅니다.',
      }),
      table(
        'ERROR가 많은 모듈 상위 10 (선택 기간)',
        `topk(10, sum by (service, module) (count_over_time(${errors} |= "$search" [$__range])))`,
        { service: '서비스', module: '모듈', Value: 'ERROR 줄 수' },
        { ds: LOKI, description: 'module은 structured metadata(로거 이름·Nest 컨텍스트에서 자동 파생)입니다.' },
      ),
      row('실시간 로그'),
      // JSON 한 줄을 `LEVEL  서비스  [모듈]  메시지`로 줄여 보여 준다. JSON이 아닌 줄(표준 위반)은 원문 그대로 둔다.
      // 줄을 눌러 펼치면 원래 JSON의 모든 키(traceId·stack_trace 등)가 그대로 보인다.
      logs('로그', `${selected} |= "$search" | json | line_format \`${READABLE_LINE}\``, {
        h: 30,
        description: '선택한 서비스·레벨·검색어의 로그(최신순). 읽기 쉽게 `레벨 서비스(expo-·-server 생략) [모듈] 메시지`로 줄여 보여 줍니다. 줄을 누르면 module·requestId·traceId·stack_trace 등 원래 JSON의 모든 키를 봅니다. 대시보드 새로고침 주기로 갱신되며, 끊김 없는 스트리밍은 Explore의 Live를 씁니다.',
      }),
    ],
  });
}
