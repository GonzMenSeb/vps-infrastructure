import { z } from "zod";
import type { SourceOptions, Store } from "../store";

const mount = z.object({ Type: z.string(), Name: z.string().optional() });

const listItem = z.object({
  Id: z.string(),
  Names: z.array(z.string()),
  Image: z.string(),
  ImageID: z.string(),
  State: z.string(),
  Status: z.string(),
  Labels: z.record(z.string(), z.string()).nullable().optional(),
  Mounts: z.array(mount).nullable().optional(),
});

const dfSchema = z.object({
  Containers: z
    .array(
      z.object({
        Id: z.string(),
        Names: z.array(z.string()),
        SizeRw: z.number().nullable().optional(),
        SizeRootFs: z.number().nullable().optional(),
        Mounts: z.array(mount).nullable().optional(),
      }),
    )
    .nullable(),
  Volumes: z
    .array(
      z.object({
        Name: z.string(),
        UsageData: z.object({ RefCount: z.number(), Size: z.number() }).nullable().optional(),
      }),
    )
    .nullable(),
});

export type Health = "healthy" | "unhealthy" | "starting" | "none";

export interface DockerContainer {
  id: string;
  name: string;
  image: string;
  imageId: string;
  state: string;
  status: string;
  health: Health;
  composeProject: string | null;
  composeService: string | null;
  composeDir: string | null;
  revision: string | null;
  traefik: Record<string, string>;
  volumes: string[];
}

export interface VolumeUsage {
  name: string;
  sizeBytes: number | null;
  refCount: number | null;
}

export interface ContainerDisk {
  name: string;
  sizeRw: number;
  sizeRootFs: number | null;
  volumes: string[];
}

export interface DiskUsage {
  containers: ContainerDisk[];
  volumes: VolumeUsage[];
}

export class DockerClient {
  constructor(private socketPath: string) {}

  async get(path: string, signal?: AbortSignal): Promise<unknown> {
    const res = await fetch(`http://docker${path}`, { unix: this.socketPath, signal });
    if (!res.ok) throw new Error(`docker ${path}: HTTP ${res.status}`);
    return res.json();
  }

  request(method: string, path: string, init: { headers?: Record<string, string>; signal?: AbortSignal } = {}): Promise<Response> {
    return fetch(`http://docker${path}`, { method, unix: this.socketPath, ...init });
  }
}

export function parseHealth(status: string): Health {
  if (status.includes("(unhealthy)")) return "unhealthy";
  if (status.includes("(healthy)")) return "healthy";
  if (status.includes("(health: starting)")) return "starting";
  return "none";
}

const containerName = (names: string[], id: string) => (names[0] ?? id).replace(/^\//, "");

const volumeNames = (mounts: z.infer<typeof mount>[] | null | undefined): string[] =>
  (mounts ?? []).flatMap((m) => (m.Type === "volume" && m.Name ? [m.Name] : []));

export async function fetchContainers(client: DockerClient, signal?: AbortSignal): Promise<DockerContainer[]> {
  const items = z.array(listItem).parse(await client.get("/containers/json?all=true", signal));
  return items
    .map((c) => {
      const labels = c.Labels ?? {};
      return {
        id: c.Id,
        name: containerName(c.Names, c.Id),
        image: c.Image,
        imageId: c.ImageID,
        state: c.State,
        status: c.Status,
        health: parseHealth(c.Status),
        composeProject: labels["com.docker.compose.project"] ?? null,
        composeService: labels["com.docker.compose.service"] ?? null,
        composeDir: labels["com.docker.compose.project.working_dir"] ?? null,
        revision: labels["org.opencontainers.image.revision"] || null,
        traefik: Object.fromEntries(Object.entries(labels).filter(([k]) => k.startsWith("traefik."))),
        volumes: volumeNames(c.Mounts),
      };
    })
    .sort((a, b) => a.name.localeCompare(b.name));
}

export async function fetchDiskUsage(client: DockerClient, signal?: AbortSignal): Promise<DiskUsage> {
  const df = dfSchema.parse(await client.get("/system/df", signal));
  return {
    containers: (df.Containers ?? [])
      .map((c) => ({
        name: containerName(c.Names, c.Id),
        sizeRw: c.SizeRw ?? 0,
        sizeRootFs: c.SizeRootFs ?? null,
        volumes: volumeNames(c.Mounts),
      }))
      .sort((a, b) => a.name.localeCompare(b.name)),
    volumes: (df.Volumes ?? [])
      .map((v) => ({
        name: v.Name,
        sizeBytes: v.UsageData && v.UsageData.Size >= 0 ? v.UsageData.Size : null,
        refCount: v.UsageData && v.UsageData.RefCount >= 0 ? v.UsageData.RefCount : null,
      }))
      .sort((a, b) => a.name.localeCompare(b.name)),
  };
}

export const DOCKER_SOURCES = { containers: "docker:containers", df: "docker:df" } as const;

export const DOCKER_TTL = { containersMs: 5_000, dfMs: 5 * 60_000, dfTimeoutMs: 30_000 } as const;

export function registerDockerSources(store: Store, client: DockerClient, base: Omit<SourceOptions, "ttlMs">): void {
  store.register(DOCKER_SOURCES.containers, (signal) => fetchContainers(client, signal), {
    ...base,
    ttlMs: DOCKER_TTL.containersMs,
  });
  store.register(DOCKER_SOURCES.df, (signal) => fetchDiskUsage(client, signal), {
    ...base,
    ttlMs: DOCKER_TTL.dfMs,
    timeoutMs: Math.max(base.timeoutMs, DOCKER_TTL.dfTimeoutMs),
  });
}
