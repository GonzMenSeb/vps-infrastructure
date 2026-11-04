import { describe, expect, test } from "bun:test";
import { buildService } from "../src/views/model";
import { ServiceFrame, ServicePage } from "../src/views/service";
import { SECRET_HASH, SECRET_TOKEN, chrome, emptySources, input, render, styleAttrs } from "./views-fixtures";

const page = (id: string, tab?: string, sources = input()) => render(<ServicePage chrome={chrome} vm={buildService(sources, id, tab)!} />);

describe("service view", () => {
  test("summary shows image, containers and resources", async () => {
    const html = await page("judicabot");
    expect(html).toContain("zot.web.example.test/judicabot/judicabot:latest");
    expect(html).toContain("sha256:0123456789ab…");
    expect(html).toContain("Not collected yet");
    expect(html).toContain("Up · healthy");
    expect(html).toContain("47 MB of 8 GB host");
    expect(html).toContain("2 MB");
    expect(html).toContain("Phase 5");
    expect(html).toContain('aria-current="page">Summary</a>');
    expect(styleAttrs(html)).toEqual([]);
  });

  test("configuration shows Ansible, Traefik and protection without secrets", async () => {
    const html = await page("traefik", "config");
    expect(html).toContain("ansible-playbook playbook.yml --tags traefik");
    expect(html).toContain("roles/traefik");
    expect(html).toContain("dashboard@docker");
    expect(html).toContain("Host(`traefik.web.example.test`)");
    expect(html).toContain("dashboard-auth (basicauth)");
    expect(html).toContain("<b>Traefik basic-auth</b>");
    expect(html).toContain("traefik.http.middlewares.dashboard-auth.basicauth.users");
    expect(html).toContain('<span class="muted nowrap">hidden</span>');
    expect(html).not.toContain(SECRET_HASH);
    expect(html).not.toContain("apr1");
    expect(html).toContain("part of the base layer");
    expect(html).toContain("expiry not collected yet");
    expect(styleAttrs(html)).toEqual([]);
  });

  test("plugin tokens in labels are never rendered", async () => {
    const html = await page("monitoring", "config");
    expect(html).toContain("tokens[0]");
    expect(html).not.toContain(SECRET_TOKEN);
  });

  test("manifest secrets are names only", async () => {
    const html = await page("miplata", "config");
    expect(html).toContain("vault_miplata_db_password");
    expect(html).toContain("POSTGRES_PASSWORD");
    expect(html).toContain("No container of Miplata exists");
  });

  test("jenkins host services are read-only", async () => {
    const html = await page("jenkins", "config");
    expect(html).toContain("this page is read-only");
    expect(html).toContain("Docker labels, so its router is not shown");
    expect(html).toContain("This role has no tag");
    expect(html).toContain("ansible-playbook jenkins-playbook.yml<");
  });

  test("later-phase tabs are labeled placeholders", async () => {
    expect(await page("judicabot", "auth")).toContain("Phase 6");
    expect(await page("judicabot", "builds")).toContain("Jenkins is not configured, so runs of judicabot-deploy cannot be shown.");
    const db = await page("miplata", "db");
    expect(db).not.toContain("Phase 4");
    expect(db).toContain("miplata-postgres");
    expect(db).toContain(">Missing<");
  });

  test("failing and empty states", async () => {
    const failing = await page("llm_inference");
    expect(failing).toContain("Restarting");
    const empty = await render(<ServiceFrame vm={buildService(input(emptySources()), "judicabot")!} />);
    expect(empty).toContain("Waiting for the first answer from Prometheus.");
    expect(empty).toContain(">Unknown<");
  });
});
