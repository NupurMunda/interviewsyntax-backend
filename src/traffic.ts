// Anonymous traffic data points for the usage dashboard (Cloudflare Analytics Engine).
//
// Every point has the same column layout, so one dataset answers every dashboard question:
//   blob1  event: 'request' (every call that reaches the server) or 'track' (a usage ping from the browser)
//   blob2  request: route pattern, e.g. /v1/companies/:slug   | track: kind (view, query, error)
//   blob3  request: HTTP method                                | track: page
//   blob4  track: company slug
//   blob5  track: category (dsa, hld, ai, behavioral)
//   blob6  track: daily visitor hash (never an address)
//   double1  HTTP status (for a track error: the status the browser saw, otherwise 0)
//   double2  request: milliseconds
// No IP, key, query text or other personal data is ever written.

export interface TrafficPoint {
  indexes: [string];
  blobs: string[];
  doubles: number[];
}

export interface TrafficSink {
  write(point: TrafficPoint): void;
}

export interface AnalyticsBinding {
  writeDataPoint(point: TrafficPoint): void;
}

// A failure to record traffic must never affect the response.
export function analyticsSink(binding: AnalyticsBinding): TrafficSink {
  return {
    write(point) {
      try {
        binding.writeDataPoint(point);
      } catch (error) {
        console.error('traffic point not written', error);
      }
    },
  };
}

export const requestPoint = (route: string, method: string, status: number, ms: number): TrafficPoint => ({
  indexes: [route.slice(0, 90)],
  blobs: ['request', route, method, '', '', ''],
  doubles: [status, ms],
});

export interface TrackFields {
  kind: string;
  page?: string;
  company?: string;
  category?: string;
  status?: number;
}

export const trackPoint = (event: TrackFields, visitor: string): TrafficPoint => ({
  indexes: [event.kind],
  blobs: ['track', event.kind, event.page ?? '', event.company ?? '', event.category ?? '', visitor],
  doubles: [event.status ?? 0, 0],
});
