# Attendance monitoring (#8)

## 공급자 계약

2026-10-12 Attendance develop [`f53815f`](https://github.com/School-of-Company/Expo-Attendance-Server/tree/f53815ff0f4a468749fd4a6221fa12e0e404011c) 기준입니다. [#101](https://github.com/School-of-Company/Expo-Attendance-Server/issues/101), [#102](https://github.com/School-of-Company/Expo-Attendance-Server/issues/102)는 CLOSED, [#110](https://github.com/School-of-Company/Expo-Attendance-Server/pull/110), [#112](https://github.com/School-of-Company/Expo-Attendance-Server/pull/112), [#113](https://github.com/School-of-Company/Expo-Attendance-Server/pull/113)은 MERGED입니다. v0.2.6 [#115](https://github.com/School-of-Company/Expo-Attendance-Server/pull/115)는 조사 시점 OPEN이며 develop 계약 확인은 운영 배포 확인이 아닙니다.

- [application.yaml](https://github.com/School-of-Company/Expo-Attendance-Server/blob/f53815ff0f4a468749fd4a6221fa12e0e404011c/src/main/resources/application.yaml): Eureka 앱은 `expo-attention-server`입니다. opt-in=true, 경로 `/actuator/prometheus`, 포트 `METRICS_PORT` 또는 서비스 포트(기본8080), HTTP histogram 활성화입니다.
- 입구는 [AttendanceController](https://github.com/School-of-Company/Expo-Attendance-Server/blob/f53815ff0f4a468749fd4a6221fa12e0e404011c/src/main/kotlin/team/startup/expo/domain/attendance/presentation/AttendanceController.kt)의 `PATCH /attendance/{expoId}`와 [QrAttendanceController](https://github.com/School-of-Company/Expo-Attendance-Server/blob/f53815ff0f4a468749fd4a6221fa12e0e404011c/src/main/kotlin/team/startup/expo/domain/qr/presentation/QrAttendanceController.kt)의 `PATCH /attendance/qr/{expoId}`입니다. Spring URI 템플릿을 정확히 선택하고 경로별로 집계합니다. 프로그램 출석(`/attendance/standard/{programId}`, `/attendance/training/{programId}`), GET, 내부 취소·관리·문서 API는 제외합니다.
- [AttendanceMetrics](https://github.com/School-of-Company/Expo-Attendance-Server/blob/f53815ff0f4a468749fd4a6221fa12e0e404011c/src/main/kotlin/team/startup/expo/global/metrics/AttendanceMetrics.kt): downstream 타이머는 `service=user|expo|application`, `outcome=success|not_found|conflict|circuit_open|failure`, guard 타이머는 `kind=scan|cancel`입니다. histogram을 공급하며 실패한 락 획득도 대기에 포함합니다.
- Prometheus 기본 `honor_labels=false`를 명시적으로 유지합니다. 미터의 `service`는 Eureka SD 라벨과 충돌해 `exported_service`로 보존되고 `service`는 `expo-attention-server`입니다. 실제 로컬 Prometheus v2.55.1에서 이 두 라벨과 3대상 × 5결과 = 15시계열을 확인했습니다. 공통 RED/Gateway의 `service` 의미는 유지됩니다.
- [회로 게이지](https://github.com/School-of-Company/Expo-Attendance-Server/blob/f53815ff0f4a468749fd4a6221fa12e0e404011c/src/main/kotlin/team/startup/expo/global/config/CircuitBreakerMetricsConfiguration.kt)의 `name=user|expo|application`, state=0 닫힘/1 열림/2 반열림/3 기타입니다. failure/slow rate는 %이고 호출 부족은 -1로 대시보드에서 제외합니다.
- [PendingQrEntryMetrics](https://github.com/School-of-Company/Expo-Attendance-Server/blob/f53815ff0f4a468749fd4a6221fa12e0e404011c/src/main/kotlin/team/startup/expo/global/metrics/PendingQrEntryMetrics.kt)는 DB 전체 pending을 세고 조회 실패는 NaN입니다. 인스턴스가 공유하는 DB backlog는 sum 대신 max로 봅니다. NaN/시계열 누락을 0으로 바꾸지 않습니다.

## 초기 임계값: 운영 합의 전 제안

모두 warning이고 Prometheus UI Alerts 탭에만 표시됩니다. Alertmanager/Slack/메일은 없습니다. 비율·p95·downstream rate 창은 5분, 비교는 엄격한 `>`이며 경계값 자체는 알리지 않습니다.

| 알림 | 조건 / 지속 | 근거와 한계 |
|---|---|---|
| AttendanceCircuitBreakerOpen | state==1, instance/name별 1분 | #8 예시. 공급자 기본 열림10초를 넘는 지속 열림. 반열림/닫힘 반복은 지속 타이머를 초기화하고 15초 scrape가 짧은 열림을 놓칠 수 있으므로 스캔 오류도 확인 |
| AttendanceScanHigh5xxRate | 입구 uri별 5xx >5%, >0.1 req/s, 5분 | 공통 알림 기준 재사용. #112 풀 포화 503 포함, 중복·거절4xx 제외 |
| AttendanceScanHighLatency | 입구 uri별 p95 >2초, >0.1 req/s, 5분 | #8 예시와 #102 결과: 빠른 downstream 입장 p95 45~76ms, 느린 downstream/풀30/50스캐너 1.114초, 100스캐너 2.508초. 초기 혼잡 감지값이며 SLO 아님 |
| AttendanceDownstreamFailures | 대상별 failure >0.1건/초, 2분 | 분당6건 초과의 지속 실패를 포착하는 제안. 합의된 실패 예산 없음. circuit_open/404/409를 합치지 않음. 낮은 호출량 장애는 미달할 수 있음 |
| AttendanceGuardLockContention | instance/kind별 p95 >0.5초, >0.1획득/초, 5분 | #102 mixed acquire p95 36ms, scan 전체 p95 94ms와 락 상한5초 참고. guard 타이머 자체 p95 자료가 없어 0.5초는 직접 측정/합의값 아님. 커넥션 획득 전 대기를 직접 재는 지표도 아님 |
| AttendanceQrPendingLong | DB pending max >0, 15분 | 기본 재확인 주기5분의 3회 동안 backlog 지속. 개별 QR 나이 지표가 없어 같은 QR이15분 지났다는 뜻은 아님. backlog가 교체돼도 알림 |

[#102 부하 원문](https://github.com/School-of-Company/Expo-Attendance-Server/blob/f53815ff0f4a468749fd4a6221fa12e0e404011c/load-test/README.md)은 개발 노트북에서 앱·스텁·DB·JMeter를 함께 돌린 측정입니다. 풀30, 커넥션 대기3초, 트랜잭션15초로 변경했고 Feign 연결2초/읽기3초, 락5초입니다. 행사장 스캐너 수·피크, 운영 DB 연결 한도·인스턴스 수는 미정입니다. 운영과 같은 환경에서 재측정 후 수치와 traffic floor를 조정해야 합니다. 저트래픽 p95/오류 알림은 억제합니다. 누락 histogram은 알림을 만들지 않습니다. 공통 ServiceDown은 scrape 실패를 다루지만 개별 지표 공급 중단은 별도 탐지하지 않습니다.

## 검증

`bash dev/validate-prometheus.sh`는 기존 공통/Gateway와 Attendance 파일을 함께 검사합니다. Attendance 테스트는 두 입구 경로 발생, 임계값 경계, 지속 시간, 무요청, 5xx 누락, 전체 missing-series, 저트래픽, 다른 서비스/GET/프로그램 제외, name/outcome/kind 분리, pending 중복 인스턴스/초기화/NaN, -1 제외를 검사합니다.

기존 fake-services와 verifier, 자동 provisioning/CI를 재사용합니다. 데모는 대상5개, 제외3개, 대시보드3개, 룰19개, 실제 수집 라벨, 두 입구 경로 기록, GET/프로그램503 제외, 전용 알림 inactive와 모든 Attendance 패널 쿼리의 유한 값을 검사합니다. 기존 인스턴스 제거/복구와 동시 실패 AggregateError 보존, Gateway 런타임 필터 검사는 유지합니다.

로컬에서는 독립 project `expo-monitoring-issue8`, 별도 loopback 포트 Prometheus19090/Grafana13001을 사용했습니다. 프로필/네트워크 전환은 해당 project의 `down` 후 `up`이고 `-v`는 사용하지 않습니다. 다른 컨테이너와 볼륨은 변경하지 않습니다.

### 이번 작업의 로컬 QA 결과

| 확인 | 결과 / 증거 |
|---|---|
| 설정·룰 및 회귀 | PASS: `bash dev/validate-prometheus.sh`, 기존 공통/Gateway 테스트와 Attendance 10개 시나리오 |
| 실제 데모 | PASS: 독립 Compose에서 `node /app/verify-demo.mjs`, 대상5/제외3/룰19/대시보드3, 라벨 충돌과 두 입구 범위 검증 |
| Grafana provisioning / 쿼리 | PASS: Grafana11.3.0 API에서 전용8패널/9쿼리의 데이터 확인, 기존 두 대시보드 및 Gateway 필터 회귀 통과 |
| 데스크톱 배치·단위·명암 | PASS: 1440×900, 1920×1080 각각 light/dark, 상단·끝 캡처. 비율 축0~100%, 회로 축0~3, 지연 초 단위 확인 |
| 모바일 전체 패널 | PASS: CSS390×844, DPR3/touch5 각각 light/dark, 상단·끝 및 중간 패널 캡처. 한 열 배치, 패널 제목·축·범례 확인. 많은 범례는 Grafana의 패널 내부 스크롤 사용 |
| 자체 변경 검토 | PASS: 전용 룰의 필터/라벨/지속 시간, NaN/-1 처리, fixture·verifier·문서 소비자 및 기존 실패 보존 코드를 diff와 함께 검토 |

시각 증거는 작업 머신의 `/tmp/expo-monitoring-8-visual/`에 PNG22개와 `evidence.json`으로 보관했습니다. 임시 브라우저 프로필은 종료 후 제거했습니다. 초기 캡처의 viewport 재설정과 레이아웃 전환 중 프레임은 폐기하고, 실제 viewport/DPR 및 패널 위치·렌더링을 검사한 뒤 다시 캡처했습니다. 캡처 스크립트·이미지는 제품 소스에 추가하지 않습니다. Grafana 자체의 전체 접근성/애니메이션 감사를 수행한 결과는 아닙니다.

## 운영 수집: 이번 작업에서는 미검증

새 서버의 실제 Attendance 배포 SHA, Eureka metadata/광고 IP/포트, scrape health, 새 histogram/downstream 라벨, 룰·대시보드 설치는 확인하지 못했습니다. [과거 운영 기록](deployment-environment.md)은 이번 변경의 증거가 아닙니다. 기존 로컬 SSH는 호스트키 불일치 기록이 있고 안전한 제한 조회 접근이 제공되지 않아 운영 접속을 시도하지 않았습니다. 기능 브랜치 코드를 운영 배포 SSH 키로 실행하는 inspect job을 복원하거나 repository secrets를 읽지 않았습니다. 로컬 데모는 운영 확인을 대체하지 않습니다.

운영 담당자는 승인된 읽기 전용 접근으로 `/api/v1/targets`의 `service=expo-attention-server`, 메트릭 포트/경로, health/lastError와 downstream `service`/`exported_service`, 입구 URI 템플릿/histogram을 확인해야 합니다. 시각·배포 SHA·대상·결과만 기록합니다. 이 PR은 develop 대상이며 main 머지·운영 배포는 수행하지 않습니다.
