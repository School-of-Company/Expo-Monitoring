# 로그와 추적

서비스는 운영 서버의 PM2 프로세스이므로 컨테이너 로그가 아니라 **로그 파일**을 읽습니다. 로그는 Loki, 추적은 Tempo에 저장되고 Grafana에서 서로 연결됩니다.

```
서비스(PM2) -- 로그 파일 --> Alloy --> Loki --+
            -- OTLP(127.0.0.1:4318) --> Tempo +--> Grafana (로그 <-> 트레이스)
```

## 로그 수집

- `LOG_DIR`에 서버의 로그 디렉터리를 지정하면 Alloy가 읽기 전용으로 마운트하고 하위 경로까지 `*.log`를 모두 수집합니다. 미설정이면 `./logs`(비어 있음)를 마운트합니다. PM2 기본 위치는 `~/.pm2/logs`이지만 실제 경로는 서버에서 확인해 정합니다.
- `service` 라벨은 파일 이름에서 뽑습니다. `expo-form-server-out.log`, `expo-form-server-error.log`, `expo-form-server.log` 모두 `expo-form-server`입니다(`-out`/`-error`/`-숫자` 접미사 제거, 소문자). **Prometheus의 `service`(Eureka 앱 이름 소문자)와 같게 파일 이름을 맞추세요.**
- 라벨은 `service`와 `level`(줄에서 찾은 TRACE/DEBUG/INFO/WARN/ERROR/FATAL, 없으면 `unknown`) 둘뿐입니다. 전화번호·토큰·요청 ID·trace id를 라벨로 만들지 않습니다(카디널리티와 개인정보).
- Loki가 자동으로 붙이는 `service_name`, `detected_level`은 꺼 두었습니다.
- 줄 단위 로그를 전제로 합니다. 여러 줄 스택 트레이스는 줄마다 별개 항목이 됩니다. 필요하면 서비스가 JSON 한 줄로 남기세요.

## trace id 규약

로그 줄에 `trace=<32자 소문자 hex>`를 남기면 Grafana Explore의 Loki 로그에 "Open trace" 링크가 생겨 Tempo 트레이스로 이동합니다(`derivedFields`, 정규식 `trace=([0-9a-f]{32})`). 반대로 Tempo 트레이스에서 "Logs"를 누르면 같은 서비스의 로그를 시간 ±5분 범위로 `trace=<id>` 필터와 함께 엽니다. 이때 OTLP 리소스 속성 `service.name`이 위 `service` 라벨과 같아야 합니다.

## 추적 보내기

- OTLP HTTP `http://127.0.0.1:4318`(`/v1/traces`), gRPC `127.0.0.1:4317`. 서비스가 같은 호스트의 PM2에서 돌기 때문에 **호스트 loopback에만** publish하며 외부에서는 접근할 수 없습니다. 다른 호스트의 서비스를 붙이려면 SSH 터널 등을 쓰고 포트를 열지 마세요.
- NestJS 예: `OTEL_EXPORTER_OTLP_ENDPOINT=http://127.0.0.1:4318`, `OTEL_SERVICE_NAME=expo-form-server`.
- span 속성·이벤트에도 전화번호·토큰·본문을 넣지 마세요. 추적에는 마스킹 단계가 없습니다.
- span metrics(Prometheus remote_write)는 설정하지 않았습니다. 후속 과제입니다.

## 마스킹

Alloy 파이프라인(`alloy/config.alloy`)이 Loki로 보내기 전에 줄을 치환합니다.

| 대상 | 치환 |
|---|---|
| JWT 모양(`eyJ...`.`...`.`...`) | `<jwt>` |
| `Bearer <토큰>` | `Bearer <token>` |
| 영숫자·`_`·`-` 40자 이상 연속 | `<token>` |
| 휴대전화 `01x` 10~11자리(하이픈 있거나 없음) | `<phone>` |

32자 trace id는 40자 규칙보다 짧아 그대로 남습니다. 이 규칙은 안전망이지 보증이 아닙니다. 이름·이메일·주소 등은 마스킹하지 않으므로 **서비스가 애초에 개인정보와 비밀을 로그에 남기지 않는 것**이 원칙입니다. 새 패턴이 필요하면 `stage.replace`를 추가합니다.

## 보존

- Loki: `LOKI_RETENTION_PERIOD`(기본 `168h` = 7일), Tempo: `TEMPO_RETENTION_PERIOD`(기본 `168h`). 값은 Go duration(`72h`, `336h`)입니다. 컴팩터가 지난 데이터를 지우므로 Loki는 보존 기간이 지나도 최대 약 2시간 더 남을 수 있습니다.
- 디스크는 볼륨 `loki-data`, `tempo-data`, `alloy-data`(읽은 위치)에 쌓입니다. 서버 디스크 용량과 로그량을 본 뒤 기간을 정하세요.
- `down -v`는 이 볼륨을 모두 지웁니다.

## 로컬 확인

데모는 가짜 서비스가 `expo-form-server.log`, `expo-application-server.log`에 전화번호·토큰이 섞인 줄을 쓰고 Alloy가 읽습니다. `dev/verify-demo.mjs`가 Loki 라벨·마스킹과 OTLP→Tempo 조회를 검사합니다. 수동 확인:

```bash
# 로그: Grafana 프록시 경유 (admin 계정)
curl -su admin:$GRAFANA_ADMIN_PASSWORD -G http://127.0.0.1:3001/api/datasources/proxy/uid/loki/loki/api/v1/query_range --data-urlencode 'query={service="expo-form-server"}'
# 추적: 샘플 span 전송 후 Grafana Explore > Tempo
curl -X POST http://127.0.0.1:4318/v1/traces -H 'Content-Type: application/json' -d @span.json
```

Grafana 11.3의 Tempo 데이터소스는 `/api/datasources/uid/tempo/health`를 지원하지 않습니다(404). Tempo 상태는 `/ready`(컨테이너 내부 3200)나 위 트레이스 조회로 확인합니다.
