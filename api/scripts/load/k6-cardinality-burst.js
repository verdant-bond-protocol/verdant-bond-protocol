// Worst-case cardinality and burst-traffic scenario for Grafana k6 (issue #403).
//
// Usage:
//   BASE_URL=http://localhost:3000 k6 run scripts/load/k6-cardinality-burst.js
//
// The scenario ramps to a burst concurrency and fans every request across
// distinct tenant/region/id/limit combinations so telemetry and cache
// cardinality guards are exercised rather than one hot key.
import http from 'k6/http';
import { check } from 'k6';
import { Rate, Trend } from 'k6/metrics';

const baseUrl = __ENV.BASE_URL || 'http://localhost:3000';
const targetPath = __ENV.LOAD_PATH || '/health';

const errorRate = new Rate('cardinality_errors');
const latency = new Trend('cardinality_latency', true);

export const options = {
  scenarios: {
    cardinality_burst: {
      executor: 'ramping-arrival-rate',
      startRate: 50,
      timeUnit: '1s',
      preAllocatedVUs: 50,
      maxVUs: 200,
      stages: [
        { target: 200, duration: '15s' },
        { target: 500, duration: '15s' },
        { target: 0, duration: '10s' },
      ],
    },
  },
  thresholds: {
    http_req_failed: ['rate<0.01'],
    http_req_duration: ['p(95)<500', 'p(99)<1000'],
    cardinality_errors: ['rate<0.01'],
  },
};

const tenants = ['tenant-a', 'tenant-b', 'tenant-c', 'tenant-d', 'tenant-e'];
const regions = ['na', 'eu', 'apac', 'latam'];
const limits = [10, 25, 50, 100];

export default function () {
  const tenant = tenants[__ITER % tenants.length];
  const region = regions[__ITER % regions.length];
  const limit = limits[__ITER % limits.length];
  const id = `bond-${__VU}-${__ITER}`;

  const url = `${baseUrl}${targetPath}?tenant=${tenant}&region=${region}&id=${id}&limit=${limit}`;
  const res = http.get(url);

  latency.add(res.timings.duration);
  errorRate.add(res.status < 200 || res.status >= 400);

  check(res, {
    'status is 2xx/3xx': (r) => r.status >= 200 && r.status < 400,
  });
}
