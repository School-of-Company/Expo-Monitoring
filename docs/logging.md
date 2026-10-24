# 로그 표준

모든 Expo 서비스(Spring·NestJS)는 같은 형식으로 로그를 남기고, Alloy는 그 키만 읽어 Loki 라벨을 만듭니다. 서비스 쪽 구현 규칙은 각 서비스의 `AGENTS.md` "Logging" 절(첫 적용: Expo-Attendance-Server#222)에 있습니다.

## 필수 키

stdout에 **JSON 객체 한 줄**을 씁니다. 배너·평문 경고 등 다른 출력은 섞지 않습니다.

| 키 | 값 | Loki |
|---|---|---|
| `@timestamp` | ISO-8601/RFC3339 (`2026-10-23T16:02:29.074+09:00`) | 항목 시각 |
| `level` | 대문자 `TRACE`/`DEBUG`/`INFO`/`WARN`/`ERROR` | 라벨 |
| `service` | Eureka 앱 이름 소문자(`expo-attention-server`) = Prometheus의 `service` | 라벨 |
| `module` | 로거 이름/클래스 컨텍스트에서 자동 파생(호출부에서 넣지 않음) | structured metadata |
| `message` | 로그 메시지 | 줄 본문 |

그 밖의 키(`requestId`, `logger_name`, `stack_trace`, `traceId` 등)는 자유입니다. 줄 전체가 Loki에 저장되므로 `| json`으로 꺼낼 수 있습니다.

- `module` 파생: Spring은 Logback `ModuleNameConverter`(`team.startup.expo.{domain|global}.<x>` → `<x>`, 그 밖은 로거 이름의 바로 위 패키지), Nest는 `nestjs-pino`의 `renameContext: 'module'`(클래스별 Logger 컨텍스트 재사용).
- `module`을 라벨로 두지 않는 이유: 값 종류가 서비스마다 수십 개라 `service × level × module` 스트림 수가 커집니다. structured metadata는 `{service="..."} | module="outbox"`로 그대로 거를 수 있습니다.

## 파이프라인에 fallback을 넣지 않습니다

`alloy/config.alloy`는 위 키만 읽습니다. 파일명에서 서비스를 추측하거나, 줄에서 레벨 단어를 찾거나, 소문자 레벨을 바꾸는 등 서비스별 보정은 하지 않습니다. 어떤 서비스의 로그가 안 보이거나 필드가 다르면 **서비스의 로그 출력을 고칩니다**.

표준을 어긴 줄도 버리지 않습니다. `job="expo"` 라벨만 달고 들어오므로 아래로 찾고, `filename`(structured metadata)으로 어느 파일인지 확인합니다.

```logql
{job="expo", service=""}
```

## 수집 위치

Alloy는 `LOG_DIR`(호스트)을 `/var/log/expo`에 읽기 전용으로 마운트해 `**/*.log`를 모두 읽습니다. 두 경우 모두 같은 단계를 거칩니다.

| 환경 | 서비스 출력 | `LOG_DIR` |
|---|---|---|
| 운영(PM2) | stdout만. PM2가 `<name>-out.log`(stdout), `<name>-error.log`(stderr)로 남김. 서비스에 로그 파일 설정을 두지 않음 | PM2 로그 디렉터리(기본 `~/.pm2/logs`, 서버에서 확인) |
| 로컬 | stdout + `local` 프로필에서 `${EXPO_LOG_DIR:-~/.expo/logs}/<service>/app.log` 미러 | 서비스의 `EXPO_LOG_DIR`(예: `~/.expo/logs`) |

PM2 `-error.log`에는 크래시 스택 등 JSON이 아닌 stderr가 남을 수 있습니다. 이런 줄은 위의 `{job="expo", service=""}`로 보입니다.

## 운영 배포 (미검증)

`deploy.yml`은 `prometheus grafana loki alloy`를 묶어 올립니다. 서버는 Docker 없이 바이너리/pm2로 실행하므로 서버의 `deploy.sh`(이 저장소 밖)가 다음을 해야 합니다. 이 저장소에서는 확인하지 못했습니다.

- Loki(3.3.x)·Alloy(1.5.x) 바이너리 실행과 데이터 디렉터리(Loki `/loki`, Alloy `--storage.path`) 보존
- `alloy/config.alloy`의 `/var/log/expo/**/*.log`를 실제 PM2 로그 경로로, `http://loki:3100`을 서버 주소로 치환
- Grafana Loki 데이터소스 `http://loki:3100` 치환, Loki listener는 loopback
- 디스크: `LOKI_RETENTION_PERIOD`(기본 7일)와 PM2 로그 로테이션(`pm2-logrotate`)을 함께 정합니다. Alloy는 회전된 파일을 이어 읽습니다.

## 로그 대시보드

로그 전용 Grafana 대시보드(전체 로그량, 서비스별 ERROR, 레벨 분포, 실시간 로그 + `service`/`level` 변수)는 모든 서비스가 이 표준을 따른 뒤 `grafana/dashboards/logs.json`으로 추가합니다.
