# 런북

알림의 `runbook_url`이 가리키는 문서입니다. 임계값은 제안이며 운영 합의 전입니다.

## ServiceHigh5xxRate

서비스의 5xx 비율이 5%를 넘고 요청률이 0.1 req/s 이상인 상태가 5분 지속.

1. 알림의 `service`와 패널(5xx ratio by service)에서 시작 시각과 인스턴스를 봅니다.
2. Grafana Explore의 Loki에서 `{service="<서비스>", level="error"}`로 같은 시각의 오류를 보고, `trace=` 링크로 Tempo 트레이스를 엽니다.
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
