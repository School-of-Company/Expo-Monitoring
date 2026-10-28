// Expo / Kafka 이벤트 소비: consumers of expo.expo.changed (lag, DLT/DLQ, committed offsets). The metrics come
// from Alloy's prometheus.exporter.kafka (job "integrations/kafka"; the lag is kafka_consumergroup_uncommitted_offsets), not from the services, so Node
// and Spring consumers look the same. Groups and topics appear only after a service enables
// KAFKA_EXPO_PROJECTION_ENABLED; until then the panels are empty. Panel ids 2, 4 and 6 are the images of the
// Grafana alerts (grafana/provisioning/alerting/rules.yml): keep their order.
import { dashboard, datasourceVariable, row, stat, timeseries } from './panels.mjs';

const TOPIC = 'topic="expo.expo.changed"';
// Notification uses .dlq, the others .dlt. [.] instead of \. keeps the regex readable in JSON.
const DEAD_LETTER = 'topic=~"expo[.]expo[.]changed[.](dlt|dlq)"';

const lag = `sum by (consumergroup) (kafka_consumergroup_uncommitted_offsets{${TOPIC}})`;
const committed = `sum by (consumergroup) (kafka_consumergroup_current_offset{${TOPIC}})`;
const offsetChanges = `sum by (consumergroup) (changes(kafka_consumergroup_current_offset{${TOPIC}}[5m]))`;

const RED_ABOVE_ZERO = { mode: 'absolute', steps: [{ color: 'green', value: null }, { color: 'red', value: 1 }] };

export function kafkaDashboard() {
  return dashboard({
    uid: 'expo-kafka',
    title: 'Expo / Kafka 이벤트 소비',
    description: '박람회 변경 이벤트(expo.expo.changed)를 소비하는 서비스별 lag, DLT/DLQ 유입, 커밋 오프셋. 지표는 Alloy의 Kafka exporter가 모읍니다.',
    tags: ['expo', 'kafka'],
    links: [{ title: 'Expo / Overview', uid: 'expo-overview' }],
    variables: [datasourceVariable('prometheus', { name: 'Prometheus', uid: 'prometheus' })],
    panels: [
      row('박람회 변경 이벤트 소비 (expo.expo.changed)'),
      timeseries('컨슈머 그룹별 lag', [[lag, '{{consumergroup}}']], {
        w: 16,
        min: 0,
        description: '그룹(expo-<서비스>-server.expo-changed)별로 아직 소비하지 않은 메시지 수. 이벤트가 드물어 평소에는 0이어야 합니다. 2분 넘게 0보다 크면 ExpoChangedConsumerLag가 발화합니다.',
      }),
      stat('현재 lag', [[lag, '{{consumergroup}}']], {
        w: 8,
        h: 9,
        description: '그룹별 현재 lag. 0이 아니면 빨강입니다.',
        thresholds: RED_ABOVE_ZERO,
        colorMode: 'background',
        textMode: 'value_and_name',
      }),
      timeseries('DLT/DLQ 끝 오프셋 (누적 건수)', [[`sum by (topic) (kafka_topic_partition_current_offset{${DEAD_LETTER}})`, '{{topic}}']], {
        w: 16,
        description: '반영에 실패해 넘어간 메시지의 누적 수(파티션 끝 오프셋 합). Notification은 .dlq, 나머지는 .dlt입니다. 늘어나면 ExpoChangedDeadLetter가 발화합니다.',
      }),
      stat('최근 10분 DLT/DLQ 유입', [[`sum by (topic) (increase(kafka_topic_partition_current_offset{${DEAD_LETTER}}[10m]))`, '{{topic}}']], {
        w: 8,
        h: 9,
        decimals: 0,
        description: '최근 10분 동안 늘어난 DLT/DLQ 메시지 수.',
        thresholds: RED_ABOVE_ZERO,
        colorMode: 'background',
        textMode: 'value_and_name',
      }),
      timeseries('커밋 오프셋과 토픽 끝 오프셋', [
        [committed, '{{consumergroup}}'],
        [`sum(kafka_topic_partition_current_offset{${TOPIC}})`, '토픽 끝'],
      ], {
        w: 16,
        description: '그룹이 커밋한 오프셋(파티션 합)과 토픽 끝 오프셋. 그래프가 마지막으로 올라간 지점이 마지막 커밋 시각입니다. 토픽 끝보다 아래에서 평평하면 소비가 멈춘 것입니다.',
      }),
      stat('최근 5분 커밋 오프셋 변화 횟수', [[offsetChanges, '{{consumergroup}}']], {
        w: 8,
        h: 10,
        decimals: 0,
        description: '최근 5분 동안 커밋 오프셋이 바뀐 횟수. lag이 0보다 큰데 0이면 소비 정지 의심(ExpoChangedConsumerStalled)입니다. lag이 0이면 0이 정상입니다.',
        textMode: 'value_and_name',
      }),
      row('전체 컨슈머 그룹'),
      timeseries('토픽·그룹별 lag (전체)', [['sum by (consumergroup, topic) (kafka_consumergroup_uncommitted_offsets)', '{{consumergroup}} / {{topic}}']], {
        w: 16,
        min: 0,
        description: '브로커의 모든 컨슈머 그룹(SMS·설문 결과 등 박람회 변경 외 토픽 포함)의 lag. 알림은 expo.expo.changed만 봅니다.',
      }),
      stat('그룹별 멤버 수', [['sum by (consumergroup) (kafka_consumergroup_members)', '{{consumergroup}}']], {
        w: 8,
        h: 10,
        decimals: 0,
        description: '그룹에 붙어 있는 컨슈머 수. 0이면 그 그룹을 소비하는 프로세스가 없습니다(서비스 중지·리스너 정지).',
        thresholds: { mode: 'absolute', steps: [{ color: 'red', value: null }, { color: 'green', value: 1 }] },
        textMode: 'value_and_name',
      }),
    ],
  });
}
