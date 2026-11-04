import { describe, expect, test } from "bun:test";
import { FAVICON } from "../src/views/layout";
import { OverviewPage } from "../src/views/overview";
import { buildOverview } from "../src/views/model";
import { LoginPage } from "../src/views/pages";
import { chrome, input, render } from "./views-fixtures";

describe("brand mark", () => {
  test("the SVG is the V with the accent tip", async () => {
    const svg = await Bun.file("public/favicon.svg").text();
    expect(svg).toContain('viewBox="0 0 32 32"');
    expect(svg).toContain("#3B9CFF");
    expect(svg).toContain("#F4F4F5");
    expect(svg).toContain("M8 6.7h4.53L16 14.35");
  });

  test("authenticated pages link the favicon and show the mark in the rail", async () => {
    const html = await render(<OverviewPage chrome={chrome} vm={buildOverview(input())} />);
    expect(html).toContain(`rel="icon" href="${FAVICON}" type="image/svg+xml"`);
    expect(html).toContain(`src="${FAVICON}"`);
    expect(html).toContain('class="brand"');
    expect(html).not.toContain('href="data:,"');
  });

  test("the sign-in card shows the mark", async () => {
    const html = await render(<LoginPage />);
    expect(html).toContain(`rel="icon" href="${FAVICON}" type="image/svg+xml"`);
    expect(html).toContain('class="markrow"');
    expect(html).toContain('alt="Vespiridion"');
  });
});
