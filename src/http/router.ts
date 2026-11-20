export interface RouteMatch {
  params: Record<string, string>;
  pattern: string;
}

interface Route<T> {
  method: string;
  pattern: string;
  segments: string[];
  value: T;
}

/** Minimal `{param}` router — no dependencies. */
export class Router<T> {
  private routes: Route<T>[] = [];

  add(method: string, pattern: string, value: T): void {
    this.routes.push({
      method: method.toUpperCase(),
      pattern,
      segments: pattern.split('/').filter(Boolean),
      value,
    });
  }

  match(method: string, path: string): { value: T; match: RouteMatch } | null {
    const segs = path.split('/').filter(Boolean);
    let pathMatched = false;
    for (const r of this.routes) {
      if (r.segments.length !== segs.length) continue;
      const params: Record<string, string> = {};
      let ok = true;
      for (let i = 0; i < segs.length; i++) {
        const rs = r.segments[i]!;
        const us = segs[i]!;
        if (rs.startsWith('{') && rs.endsWith('}')) {
          params[rs.slice(1, -1)] = decodeURIComponent(us);
        } else if (rs !== us) {
          ok = false;
          break;
        }
      }
      if (!ok) continue;
      if (r.method === method.toUpperCase()) {
        return { value: r.value, match: { params, pattern: r.pattern } };
      }
      pathMatched = true;
    }
    if (pathMatched) return { value: null as T, match: { params: {}, pattern: '' } };
    return null;
  }
}
