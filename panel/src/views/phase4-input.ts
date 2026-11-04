import type { DbMetrics } from "../collectors/databases";
import type { DnsSnapshot, PdnsStats } from "../collectors/pdns";
import type { RegistrySnapshot } from "../collectors/zot";
import type { Snapshot } from "../store";

export interface RegistryView {
  configured: boolean;
  snapshot: Snapshot<RegistrySnapshot> | null;
  actions: boolean;
  host: string | null;
  gc: { delay: string; interval: string };
  ttlMs: number;
  now?: number;
}

export interface DnsView {
  configured: boolean;
  snapshot: Snapshot<DnsSnapshot> | null;
  actions: boolean;
  host: string | null;
  ttlMs: number;
}

export interface DatabasesView {
  prom: Snapshot<DbMetrics> | null;
  promTtlMs: number;
  pdnsConfigured: boolean;
  pdnsStats: Snapshot<PdnsStats> | null;
  pdnsTtlMs: number;
  zones: Snapshot<DnsSnapshot> | null;
  pdnsDbContainer: string;
}
