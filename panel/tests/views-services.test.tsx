import { describe, expect, test } from "bun:test";
import { buildServices } from "../src/views/model";
import { ServicesFrame, ServicesPage } from "../src/views/services";
import { chrome, containers, emptySources, fullSources, hosts, input, render, snap, styleAttrs } from "./views-fixtures";

describe("services view", () => {
  test("one row per manifest service with state, image, resources and protection", async () => {
    const html = await render(<ServicesPage chrome={chrome} vm={buildServices(input())} />);
    expect((html.match(/class="rowlink"/g) ?? []).length).toBe(7);
    expect(html).toContain("judicabot/judicabot:latest");
    expect(html).not.toContain(">zot.web.example.test/judicabot");
    expect(html).toContain("from the manifest");
    expect(html).toContain("Failing");
    expect(html).toContain("No container");
    expect(html).toContain("Reporting");
    expect(html).toContain("Traefik basic-auth");
    expect(html).toContain("818 MB");
    expect(styleAttrs(html)).toEqual([]);
  });

  test("stale Prometheus data is badged next to the Docker note", async () => {
    const fresh = await render(<ServicesFrame vm={buildServices(input())} />);
    expect(fresh).not.toContain("Prometheus · stale");
    const err = { lastError: "prometheus /api/v1/query: HTTP 503", ageMs: 19_000 };
    const sources = { ...fullSources(), hosts: snap(hosts, err), containers: snap(containers, err) };
    const html = await render(<ServicesFrame vm={buildServices(input(sources))} />);
    expect(html).toContain("Prometheus · stale · 19 s old");
    expect(html).toContain("818 MB");
  });

  test("without data every state is unknown and the sources say why", async () => {

    const html = await render(<ServicesFrame vm={buildServices(input(emptySources()))} />);
    expect(html).toContain("Waiting for the first answer from Docker.");
    expect(html).toContain("Waiting for the first answer from Prometheus.");
    expect((html.match(/>Unknown</g) ?? []).length).toBeGreaterThanOrEqual(7);
  });
});
