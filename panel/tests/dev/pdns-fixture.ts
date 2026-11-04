import { isIPv4, isIPv6 } from "node:net";

export interface FakePdnsComment {
  content: string;
  account: string;
  modified_at: number;
}

export interface FakePdnsRrset {
  name: string;
  type: string;
  ttl: number;
  records: { content: string; disabled: boolean }[];
  comments: FakePdnsComment[];
}

export interface FakePdnsOptions {
  apiKey?: string;
  zone?: string;
  now?: () => number;
}

export interface FakePdns {
  url: string;
  apiKey: string;
  zoneId: string;
  rrsets: FakePdnsRrset[];
  requests: { method: string; path: string; body?: unknown }[];
  setDown: (down: boolean) => void;
  ignorePatches: (on: boolean) => void;
  stop: () => Promise<void>;
}

const PANEL = (at: number): FakePdnsComment => ({ content: "managed-by: panel", account: "panel", modified_at: at });

const HOSTS = ["zot", "judicabot", "decabot", "vault", "prometheus", "dns", "categorizer", "traefik", "prom-push", "loki-push", "metabase", "miplata", "grafana", "brujula", "huella", "panel"];

const err = (status: number, message: string) => Response.json({ error: message }, { status });

export function startFakePdns(opts: FakePdnsOptions = {}): FakePdns {
  const apiKey = opts.apiKey ?? "dev-api-key";
  const zoneName = `${opts.zone ?? "web.example.test"}.`;
  const now = opts.now ?? (() => Date.now());
  const at = Math.floor(now() / 1000);
  const rrsets: FakePdnsRrset[] = [
    ...HOSTS.map((h) => ({ name: `${h}.${zoneName}`, type: "A", ttl: 3600, records: [{ content: "192.0.2.10", disabled: false }], comments: [] })),
    { name: `jenkins.${zoneName}`, type: "A", ttl: 3600, records: [{ content: "192.0.2.20", disabled: false }], comments: [] },
    { name: `traefik-ci.${zoneName}`, type: "A", ttl: 3600, records: [{ content: "192.0.2.20", disabled: false }], comments: [] },
    { name: `scratch.${zoneName}`, type: "A", ttl: 300, records: [{ content: "192.0.2.10", disabled: false }], comments: [PANEL(at - 7200)] },
    { name: `_acme-challenge.test.${zoneName}`, type: "TXT", ttl: 60, records: [{ content: '"x7Qp-fixture-token"', disabled: false }], comments: [PANEL(at - 3600)] },
    {
      name: `demo.${zoneName}`,
      type: "A",
      ttl: 300,
      records: [{ content: "198.51.100.7", disabled: false }, { content: "198.51.100.8", disabled: true }],
      comments: [PANEL(at - 600)],
    },
    { name: zoneName, type: "SOA", ttl: 3600, records: [{ content: "ns1.example.test. hostmaster.example.test. 0 10800 3600 604800 3600", disabled: false }], comments: [] },
    { name: zoneName, type: "NS", ttl: 3600, records: [{ content: "ns1.example.test.", disabled: false }], comments: [] },
  ];

  let down = false;
  let ignore = false;
  const requests: FakePdns["requests"] = [];
  const startedAt = now();

  const validate = (r: Record<string, any>): string | null => {
    const name = String(r.name ?? "");
    const type = String(r.type ?? "");
    if (!name.endsWith(".")) return `DNS Name '${name}' is not canonical`;
    if (name !== zoneName && !name.endsWith(`.${zoneName}`)) return `RRset ${name} IN ${type}: Name is out of zone`;
    if (r.changetype === "DELETE") return null;
    for (const rec of r.records as { content: string }[]) {
      const c = rec.content;
      const where = `Record ${name}/${type} '${c}'`;
      if (type === "A" && !isIPv4(c)) return `${where}: Parsing record content (try 'pdnsutil check-zone'): while parsing IP address, expected digits at position 0 in '${c}'`;
      if (type === "AAAA" && !isIPv6(c)) return `${where}: Parsing record content (try 'pdnsutil check-zone'): Unable to convert '${c}' to IPv6`;
      if (type === "CNAME" && !c.endsWith(".")) return `${where}: Not in expected format (parsed as '${c}.')`;
      if (type === "MX" && !/^\d+ \S+\.$/.test(c)) return `${where}: Not in expected format`;
      if (type === "TXT" && !c.startsWith('"')) return `${where}: Parsing record content (try 'pdnsutil check-zone'): Data field in DNS should start with quote (") at position 0 of '${c}'`;
    }
    return null;
  };

  const apply = (body: { rrsets?: Record<string, any>[] }): Response => {
    const staged = structuredClone(rrsets);
    for (const r of body.rrsets ?? []) {
      const bad = validate(r);
      if (bad) return err(422, bad);
      const i = staged.findIndex((x) => x.name === r.name && x.type === r.type);
      if (r.changetype === "DELETE") {
        if (i >= 0) staged.splice(i, 1);
        continue;
      }
      if (r.type === "CNAME" && staged.some((x) => x.name === r.name && x.type !== "CNAME")) return err(422, `RRset ${r.name} IN CNAME: Conflicts with pre-existing RRset`);
      if (r.type !== "CNAME" && staged.some((x) => x.name === r.name && x.type === "CNAME")) return err(422, `RRset ${r.name} IN ${r.type}: Conflicts with pre-existing RRset`);
      const comments = Array.isArray(r.comments)
        ? (r.comments as { content: string; account?: string }[]).map((c) => ({ content: c.content, account: c.account ?? "", modified_at: Math.floor(now() / 1000) }))
        : i >= 0
          ? staged[i]!.comments
          : [];
      const next: FakePdnsRrset = { name: r.name, type: r.type, ttl: r.ttl, records: (r.records as { content: string; disabled?: boolean }[]).map((x) => ({ content: x.content, disabled: x.disabled === true })), comments };
      if (i >= 0) staged[i] = next;
      else staged.unshift(next);
    }
    if (!ignore) {
      rrsets.length = 0;
      rrsets.push(...staged);
    }
    return new Response(null, { status: 204 });
  };

  const stats = () => {
    const secs = Math.floor((now() - startedAt) / 1000) + 43_930;
    const item = (name: string, value: number) => ({ name, type: "StatisticItem", value: String(value) });
    return [
      item("backend-latency", 547),
      item("backend-queries", 3273 + requests.length),
      item("cache-latency", 20),
      item("latency", 666),
      item("qsize-q", 0),
      item("servfail-packets", 0),
      item("timedout-packets", 0),
      item("udp-queries", 8610),
      item("uptime", secs),
    ];
  };

  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(req) {
      const u = new URL(req.url);
      let body: unknown;
      if (req.method === "PATCH") body = await req.json().catch(() => undefined);
      requests.push({ method: req.method, path: u.pathname + u.search, ...(body !== undefined ? { body } : {}) });
      if (down) return new Response("fixture is down", { status: 503 });
      if (req.headers.get("x-api-key") !== apiKey) return new Response("Unauthorized", { status: 401 });
      const base = "/api/v1/servers/localhost";
      if (req.method === "GET" && u.pathname === `${base}/zones`) {
        return Response.json([{ id: zoneName, name: zoneName, kind: "Native", serial: 0, url: `${base}/zones/${zoneName}` }]);
      }
      if (req.method === "GET" && u.pathname === `${base}/statistics`) return Response.json(stats());
      const z = /^\/api\/v1\/servers\/localhost\/zones\/(.+)$/.exec(u.pathname);
      if (z && decodeURIComponent(z[1]!) !== zoneName) return err(404, "Could not find domain");
      if (z && req.method === "GET") {
        const rn = u.searchParams.get("rrset_name");
        const rt = u.searchParams.get("rrset_type");
        const sets = rn
          ? rrsets
              .filter((r) => r.name === rn && (!rt || r.type === rt))
              .map((r) => ({ ...r, records: r.records.filter((x) => !x.disabled) }))
              .filter((r) => r.records.length > 0)
          : rrsets;
        return Response.json({ id: zoneName, name: zoneName, kind: "Native", serial: 0, rrsets: sets });
      }
      if (z && req.method === "PATCH") return apply((body ?? {}) as { rrsets?: Record<string, any>[] });
      return err(404, "Not Found");
    },
  });

  return {
    url: `http://127.0.0.1:${server.port}`,
    apiKey,
    zoneId: zoneName,
    rrsets,
    requests,
    setDown: (d) => {
      down = d;
    },
    ignorePatches: (on) => {
      ignore = on;
    },
    stop: async () => {
      await server.stop(true);
    },
  };
}
