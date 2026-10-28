# 런북

알림의 `runbook_url`이 가리키는 문서입니다. 임계값은 제안이며 운영 합의 전입니다.

## ServiceHigh5xxRate

서비스의 5xx 비율이 5%를 넘고 요청률이 0.1 req/s 이상인 상태가 5분 지속.

1. 알림의 `service`와 패널(5xx ratio by service)에서 시작 시각과 인스턴스를 봅니다.
2. Grafana Explore의 Loki에서 `{service="<서비스>", level="ERROR"}`로 같은 시각의 오류를 보고, `trace=` 링크로 Tempo 트레이스를 엽니다.
3. 직전 배포·설정 변경 여부, 의존 서비스(DB, 다른 MSA)의 상태를 확인합니다.
4. 배포 직후라면 롤백을 먼저 검토합니다.

## FormOutboxStalled

`form_outbox_oldest_pending_age_seconds`가 300초를 넘은 상태가 2분 지속. 아웃박스 릴레이가 멈췄거나 브로커 발행이 실패하는 중입니다.

1. `form_outbox_relay_runs_total`, `form_outbox_publish_total`의 증가 여부로 릴레이가 도는지 봅니다.
2. Loki에서 `{service="expo-form-server"} |= "outbox"`로 발행 실패 원인을 찾습니다.
3. 브로커/하위 서비스 장애면 복구 후 backlog가 줄어드는지 `form_outbox_records{state="pending"}`로 확인합니다.
4. 줄지 않으면 프로세스(PM2)를 점검하고 재시작합니다.

## FormDbPoolExhausted

`form_db_pool_connections{state="waiting"}`가 0보다 큰 상태가 5분 지속. DB 연결 풀이 고갈된 것입니다.

1. 같은 시각의 지연(p95)과 5xx 상승 여부를 봅니다.
2. 느린 쿼리·장시간 트랜잭션·연결 누수를 로그에서 찾습니다.
3. DB 서버 연결 수 한도와 풀 크기 설정을 확인합니다. 풀을 키우기 전에 원인부터 확인하세요.

## FormHighLatency

Form 서비스 전체 HTTP p95가 1초를 넘은 상태가 5분 지속(요청률 0.1 req/s 이상).

1. 패널 `Latency p95`와 `Public survey latency p95`로 특정 경로만 느린지 봅니다.
2. 같은 시각의 DB 풀 대기(`form_db_pool_connections{state="waiting"}`), 외부 호출 p95(`FormDownstreamHighLatency`)를 확인합니다.
3. Tempo 트레이스로 느린 구간(DB, 박람회·유저 호출)을 찾습니다.

## FormPublicSurveyHigh5xxRate

공개 설문(`/surveys/public/:expoId`, `/surveys/answer/public/:expoId`)의 5xx가 5%를 넘은 상태가 5분 지속. 현장 방문객이 설문을 열거나 제출하지 못합니다.

1. 알림의 `uri`로 조회/제출 중 어느 쪽인지 확인합니다.
2. Loki `{service="expo-form-server", level="ERROR"}`로 같은 시각의 오류를 봅니다.
3. DB 풀 대기, 박람회 서비스 호출 실패(`FormDownstreamFailures`)가 원인인지 확인합니다.
4. 현장에서 즉시 영향이 크므로 직전 배포 롤백을 먼저 검토합니다.

## FormPublicSurveyHighLatency

공개 설문 경로 p95가 2초를 넘은 상태가 5분 지속. 현장 트래픽이 몰린 상황일 수 있습니다.

1. `Public survey request rate`로 트래픽 급증 여부를 봅니다.
2. DB 풀 대기와 박람회 서비스 호출 지연을 확인합니다.
3. 급증이라면 인스턴스 수·DB 풀 크기를 검토합니다.

## FormOutboxExhausted

아웃박스의 재시도 한도에 도달한 건(`state="exhausted"`)이 있는 상태가 5분 지속. 더 이상 자동 재시도되지 않으므로 사람이 처리해야 합니다. 건이 처리되기 전까지 알림이 해소되지 않고 1시간마다 반복됩니다.

1. 알림의 `outbox`(`answer`/`draw`)와 `Outbox records by state` 패널로 건수를 확인합니다.
2. Loki에서 `{service="expo-form-server"} |= "outbox"`로 마지막 실패 원인을 찾습니다(하위 서비스 장애, 데이터 문제).
3. 원인을 해소한 뒤 건을 재처리하거나 정리합니다(방법은 Form 서버 쪽 절차를 따릅니다). `exhausted`가 0이 되면 알림이 해소됩니다.

## FormResultConsumerSkipping

결과 컨슈머가 최근 10분 안에 메시지를 건너뛰었습니다(`reason`: `unparsable` 형식 오류, `unknown_status` 알 수 없는 상태). 건너뛴 메시지는 버려집니다.

1. 알림의 `reason`을 확인합니다.
2. 메시지를 만드는 서비스(결과를 보내는 쪽)의 최근 배포·스키마 변경을 확인합니다.
3. Loki에서 컨슈머의 skip 로그로 메시지 식별자를 찾아 영향 받은 건을 점검합니다.

## FormOutboxRelayFailing

아웃박스 릴레이 실행(`ok`+`error`)의 20% 넘게가 `error`인 상태가 10분 지속(`skipped`는 제외).

1. `Outbox relay runs` 패널과 `form_outbox_publish_total{result="error"}`로 발행 실패인지 봅니다.
2. Loki에서 outbox 오류 로그로 원인(브로커·DB)을 찾습니다.
3. 정체가 길어지면 `FormOutboxStalled`(Grafana)도 함께 발화합니다.

## FormDownstreamFailures

Form이 박람회(`expo`)·유저(`user`) 서비스를 호출하다 실패·타임아웃(`failure`, `timeout`)하는 비율이 초당 0.1을 넘은 상태가 2분 지속(`not_found`, `conflict`는 제외).

1. 알림의 `exported_service`와 `Downstream calls by outcome` 패널에서 어느 작업(`operation`)인지 봅니다.
2. 해당 서비스의 5xx/지연 알림과 Eureka 상태를 확인합니다.
3. 타임아웃 위주면 상대 서비스 지연, 실패 위주면 연결·5xx를 의심합니다.

## FormDownstreamCircuitOpen

Form이 박람회(`expo`)·유저(`user`) 서비스 호출 중 일부를 회로 차단기로 막아(`circuit_open`) 호출하지 않고 바로 503을 돌려주는 상태가 1분 지속. 최근 30초 동안 호출이 10번 이상이고 실패율이 50%를 넘으면 열리고 30초 뒤 다시 시도합니다. 회로가 열리면 `FormDownstreamFailures`(`failure`, `timeout`)는 오히려 잠잠해지므로, 이 알림이 장애의 신호입니다.

1. 알림의 `exported_service`로 어느 서비스가 죽었는지 확인하고 그 서비스의 5xx·지연 알림과 Eureka 상태를 봅니다.
2. 영향은 회로가 막은 호출입니다. `expo`는 폼·설문 생성과 폼 수정 예약, `user`는 참가자 설문 제출·세션 확인입니다.
3. 상대 서비스가 복구되면 30초 안에 자동으로 닫힙니다. 계속 열려 있으면 `Downstream calls by outcome` 패널에서 `failure`가 다시 늘어나는지 봅니다.
4. 폼 수정 예약 해제는 회로를 거치지 않으므로 이 상황에서도 예약이 남지 않습니다.

## FormDownstreamBulkheadFull

Form이 박람회·유저 서비스 호출을 동시 호출 상한(기본 20개 + 대기 10개)을 넘어 거절(`bulkhead_full`)하는 비율이 초당 0.05를 넘은 상태가 2분 지속. 상대 서비스가 느려져 호출이 쌓이거나, 정상 트래픽이 상한보다 큰 경우입니다.

1. `FormDownstreamHighLatency`가 함께 발화했는지 봅니다. 그렇다면 상대 서비스 지연이 원인입니다.
2. 지연이 없는데 거절만 있으면 트래픽이 상한보다 큰 것입니다. `DOWNSTREAM_BULKHEAD_MAX_CONCURRENT`, `DOWNSTREAM_BULKHEAD_MAX_QUEUE`를 올리는 것을 검토합니다.
3. 거절된 요청은 503으로 끝나므로 영향을 받은 경로(`operation`)를 확인합니다.

## FormDownstreamHighLatency

박람회·유저 서비스 호출의 p95가 2초를 넘은 상태가 5분 지속(초당 0.1회 이상).

1. 알림의 `exported_service`, `operation`을 확인하고 상대 서비스 대시보드를 봅니다.
2. 이 지연이 `FormHighLatency`, 공개 설문 지연으로 번지는지 확인합니다.

## 박람회 변경 이벤트 소비 (공통 복구 절차)

아래 세 알림(`ExpoChanged*`)은 `expo.expo.changed`를 소비하는 Form·User·Attendance·Notification·Application의 컨슈머 그룹(`expo-<서비스>-server.expo-changed`)을 봅니다. 소비가 멈추면 앱은 살아 있어도 로컬 프로젝션이 옛 박람회 값을 답합니다. 지표는 Alloy의 Kafka exporter가 모읍니다(`kafka_consumergroup_uncommitted_offsets`가 lag). 대시보드: **Expo / Kafka 이벤트 소비**(`expo-kafka`).

1. **원인 확인**
   - 브로커: `pm2 logs expo-kafka --lines 200`, `pm2 describe expo-kafka`. 브로커가 죽었으면 모든 그룹의 lag이 함께 오르고 대시보드 값도 끊깁니다.
   - 서비스 로그: Loki `{service="<알림의 서비스>"} |~ "(?i)kafka|consumer|rebalanc"` 또는 `pm2 logs <서비스>`. 연결 끊김, 역직렬화 실패, 반복 리밸런싱을 봅니다.
   - 리스너 상태: 대시보드의 `그룹별 멤버 수`가 0이면 그 그룹을 소비하는 프로세스가 없습니다. 서비스의 `KAFKA_EXPO_PROJECTION_ENABLED`가 켜져 있는지도 확인합니다.
2. **필요하면 소비자 서비스를 재시작**합니다: `pm2 restart <서비스>`. 재시작 후 멤버 수가 1 이상인지 봅니다.
3. **원인을 해소한 뒤 republish를 1회** 호출합니다. 서버에서 Expo로 직접 호출합니다(Gateway는 `/internal`을 404로 막습니다).

   ```bash
   curl -fsS -X POST http://127.0.0.1:26123/internal/expo-events/republish \
     -H "<내부 토큰 헤더>: <내부 토큰>"   # 헤더 이름과 값은 Expo 서버 설정을 따릅니다. 토큰을 기록·공유하지 않습니다.
   ```

   모든 박람회의 최신 상태가 다시 발행되므로 **DLT/DLQ 메시지를 따로 재처리하지 않습니다.** 여러 번 부를 필요도 없습니다.
4. **확인**: `컨슈머 그룹별 lag`이 0으로 돌아오고 `최근 10분 DLT/DLQ 유입`이 0으로 머무는지 봅니다. republish 직후 lag이 잠깐 오르는 것은 정상입니다.

## ExpoChangedConsumerLag

`expo.expo.changed`의 그룹별 lag(`sum by (consumergroup) (kafka_consumergroup_uncommitted_offsets)`)이 0보다 큰 상태가 2분 지속. 이벤트가 드물어 lag은 평소에 0입니다. 알림의 `service`는 컨슈머 그룹 이름입니다.

1. 한 그룹만이면 그 서비스, 모든 그룹이면 브로커를 의심합니다.
2. 커밋 오프셋이 움직이면 느리게라도 소비 중입니다. 움직이지 않으면 `ExpoChangedConsumerStalled`도 곧 발화합니다.
3. [공통 복구 절차](#박람회-변경-이벤트-소비-공통-복구-절차)를 따릅니다.

## ExpoChangedDeadLetter

`expo.expo.changed.dlt`(Notification은 `.dlq`)의 끝 오프셋이 최근 10분 안에 늘었습니다. 반영에 실패한 박람회는 다음 변경 전까지 그 서비스에서 옛 값에 머뭅니다. 10분이 지나면 알림이 저절로 해소되므로 해소됐다고 처리된 것은 아닙니다.

1. 알림의 `topic`으로 `.dlt`(Form·User·Attendance·Application) 또는 `.dlq`(Notification)인지 봅니다. `.dlt`는 여러 서비스가 함께 쓰므로 서비스 로그에서 실패 로그를 찾아 어느 서비스인지 확인합니다.
2. 실패 원인(스키마 변경, 프로젝션 DB 오류, 버그)을 해소합니다.
3. [공통 복구 절차](#박람회-변경-이벤트-소비-공통-복구-절차)의 republish로 복구합니다. DLT 메시지를 다시 넣지 않습니다.

토픽이 처음 생길 때(첫 DLT 메시지)는 이전 샘플이 없어 증가로 잡히지 않을 수 있습니다. 대시보드의 `DLT/DLQ 끝 오프셋`도 함께 봅니다.

## ExpoChangedConsumerStalled

`expo.expo.changed`의 lag이 0보다 큰데 그룹의 커밋 오프셋이 5분 동안 한 번도 바뀌지 않은 상태가 1분 지속(critical). 리스너 컨테이너 정지, 브로커 연결 끊김, 반복 리밸런싱으로 소비가 멈춘 것입니다.

1. `그룹별 멤버 수`가 0인지, 서비스 로그에 리밸런싱이 반복되는지 봅니다.
2. 대부분 서비스 재시작이 필요합니다. [공통 복구 절차](#박람회-변경-이벤트-소비-공통-복구-절차)를 따릅니다.
