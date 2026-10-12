import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';

console.log(new Date().toISOString());
const listeners = execFileSync('ss', ['-ltn'], { encoding: 'utf8' }).split('\n');
for (const line of listeners) {
  if (/:(2611[1-9]|2612[0-9])\s/.test(line)) console.log(line);
}

function assertLoopback(port) {
  const addresses = listeners.map((line) => line.trim().split(/\s+/)[3]).filter((address) => address?.endsWith(`:${port}`));
  assert(addresses.length > 0, `No listener on ${port}`);
  assert(addresses.every((address) => /^(127\.0\.0\.1:|\[::1\]:|\[::ffff:127\.0\.0\.1\]:)/.test(address)), `Non-loopback listener on ${port}`);
}

let prometheusFound = false;
let grafanaFound = false;
let gatewayUp = false;
for (let port = 26111; port <= 26129; port++) {
  for (const endpoint of ['/api/v1/targets', '/api/health']) {
    let payload;
    try {
      const response = await fetch(`http://127.0.0.1:${port}${endpoint}`, { signal: AbortSignal.timeout(2000), redirect: 'error' });
      if (!response.ok) continue;
      payload = await response.json();
    } catch (error) {
      if (error instanceof TypeError || error instanceof SyntaxError || error.name === 'TimeoutError') continue;
      throw error;
    }
    if (endpoint === '/api/health' && payload?.database === 'ok') {
      assertLoopback(port);
      grafanaFound = true;
      console.log(`Grafana port=${port} database=ok`);
    }
    if (endpoint === '/api/v1/targets' && payload?.status === 'success' && Array.isArray(payload.data?.activeTargets)) {
      assertLoopback(port);
      prometheusFound = true;
      console.log(`Prometheus port=${port} targets=${payload.data.activeTargets.length}`);
      for (const target of payload.data.activeTargets) {
        const service = target.labels.service ?? '';
        const destination = new URL(target.scrapeUrl);
        console.log(JSON.stringify({ service, instance: target.labels.instance, health: target.health, metricsHost: destination.hostname, metricsPort: destination.port }));
        assert.equal(target.health, 'up', `Unhealthy target: ${service}`);
        assert.equal(destination.hostname, '127.0.0.1', `Non-loopback metrics host: ${service}`);
        assertLoopback(destination.port || (destination.protocol === 'https:' ? 443 : 80));
        gatewayUp ||= service === 'expo-gateway' && target.health === 'up';
      }
    }
  }
}
assert(prometheusFound && grafanaFound && gatewayUp, `Incomplete: prometheus=${prometheusFound}, grafana=${grafanaFound}, gatewayUp=${gatewayUp}`);
console.log('PASS live Prometheus/Grafana, healthy targets including Gateway, loopback-only UIs and metrics');
