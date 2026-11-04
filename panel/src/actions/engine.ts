import { z } from "zod";
import { fetchContainers, type DockerClient, type DockerContainer } from "../collectors/docker";

export interface RegistryAuth {
  username: string;
  password: string;
  serveraddress: string;
}

export interface ImageInfo {
  id: string;
  repoTags: string[];
  repoDigests: string[];
}

export interface DockerEngine {
  containers(): Promise<DockerContainer[]>;
  inspectImage(ref: string): Promise<ImageInfo | null>;
  pullImage(image: string, tag: string, auth: RegistryAuth | null, timeoutMs: number): Promise<void>;
  tagImage(source: string, repo: string, tag: string): Promise<void>;
}

const imageSchema = z.object({
  Id: z.string(),
  RepoTags: z.array(z.string()).nullable().optional(),
  RepoDigests: z.array(z.string()).nullable().optional(),
});

const progressSchema = z.object({ error: z.string().optional(), errorDetail: z.object({ message: z.string().optional() }).optional() });

export const encodeRegistryAuth = (auth: RegistryAuth): string =>
  Buffer.from(JSON.stringify(auth)).toString("base64").replace(/\+/g, "-").replace(/\//g, "_");

async function dockerFailure(res: Response, what: string): Promise<Error> {
  let detail = "";
  try {
    const body = (await res.json()) as { message?: unknown };
    if (typeof body.message === "string") detail = `: ${body.message.slice(0, 200)}`;
  } catch {
    await res.body?.cancel().catch(() => {});
  }
  return new Error(`docker ${what}: HTTP ${res.status}${detail}`);
}

export const DOCKER_REQUEST_TIMEOUT_MS = 10_000;

export class SocketEngine implements DockerEngine {
  constructor(
    private client: DockerClient,
    private requestTimeoutMs = DOCKER_REQUEST_TIMEOUT_MS,
  ) {}

  containers(): Promise<DockerContainer[]> {
    return fetchContainers(this.client, AbortSignal.timeout(this.requestTimeoutMs));
  }

  async inspectImage(ref: string): Promise<ImageInfo | null> {
    const res = await this.client.request("GET", `/images/${ref}/json`, { signal: AbortSignal.timeout(this.requestTimeoutMs) });
    if (res.status === 404) {
      await res.body?.cancel();
      return null;
    }
    if (!res.ok) throw await dockerFailure(res, `inspect ${ref}`);
    const img = imageSchema.parse(await res.json());
    return { id: img.Id, repoTags: img.RepoTags ?? [], repoDigests: img.RepoDigests ?? [] };
  }

  async pullImage(image: string, tag: string, auth: RegistryAuth | null, timeoutMs: number): Promise<void> {
    const query = new URLSearchParams({ fromImage: image, tag });
    const res = await this.client.request("POST", `/images/create?${query}`, {
      headers: auth ? { "x-registry-auth": encodeRegistryAuth(auth) } : {},
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) throw await dockerFailure(res, `pull ${image}:${tag}`);
    for (const line of (await res.text()).split("\n")) {
      if (!line.trim()) continue;
      let parsed: z.infer<typeof progressSchema>;
      try {
        parsed = progressSchema.parse(JSON.parse(line));
      } catch {
        continue;
      }
      const message = parsed.error ?? parsed.errorDetail?.message;
      if (message) throw new Error(`pull of ${image}:${tag} failed: ${message.slice(0, 200)}`);
    }
  }

  async tagImage(source: string, repo: string, tag: string): Promise<void> {
    const query = new URLSearchParams({ repo, tag });
    const res = await this.client.request("POST", `/images/${source}/tag?${query}`, { signal: AbortSignal.timeout(this.requestTimeoutMs) });
    if (res.status !== 201) throw await dockerFailure(res, `tag ${source} as ${repo}:${tag}`);
    await res.body?.cancel();
  }
}
