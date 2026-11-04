import { describe, expect, test } from "bun:test";
import { chart, esc, hourLabels, niceMax } from "../src/lib/charts";

describe("niceMax", () => {
  test("rounds up to 4 x {1,2,2.5,5} x 10^p", () => {
    expect(niceMax(0.05)).toBeCloseTo(0.08, 12);
    expect(niceMax(3)).toBe(4);
    expect(niceMax(4)).toBe(4);
    expect(niceMax(4.01)).toBe(8);
    expect(niceMax(8.5)).toBe(10);
    expect(niceMax(10.5)).toBe(20);
    expect(niceMax(95)).toBe(100);
    expect(niceMax(101)).toBe(200);
    expect(niceMax(900)).toBe(1000);
  });

  test("zero, negative and non-finite inputs give the smallest step", () => {
    for (const v of [0, -5, NaN, -Infinity]) expect(niceMax(v)).toBeCloseTo(0.04, 12);
  });

  test("never returns less than the input", () => {
    for (const v of [0.001, 0.5, 7, 33, 120, 4999, 123456, 3e7]) expect(niceMax(v)).toBeGreaterThanOrEqual(v);
  });

  test("beyond the table returns the input", () => {
    expect(niceMax(1e12)).toBe(1e12);
  });
});

const base = {
  title: "CPU busy",
  series: [{ name: "CPU", c: "cpu", data: [10, 20, 30, 40] }],
  fmt: (v: number) => `${Math.round(v)}%`,
  xLabels: ["a", "b", "c", "d", "e"],
};

describe("chart", () => {
  test("renders svg, five y ticks, x labels, and a stats table", () => {
    const html = chart({ ...base, fixedMax: 100 });
    expect(html).toContain('viewBox="0 0 340 190"');
    expect(html.match(/class="grid"/g)).toHaveLength(4);
    expect(html.match(/class="base"/g)).toHaveLength(1);
    expect(html).toContain(">100%<");
    expect(html).toContain('text-anchor="start">a<');
    expect(html).toContain('text-anchor="end">e<');
    expect(html).toContain("<td>40%</td><td>25%</td><td>10%</td><td>40%</td>");
  });

  test("scales to niceMax of 1.05 x peak when no fixed max", () => {
    expect(chart(base)).toContain(`>${niceMax(40 * 1.05)}%<`);
  });

  test("legend only when requested", () => {
    expect(chart(base)).not.toContain('class="legend"');
    expect(chart({ ...base, legend: true })).toContain('class="legend"');
  });

  test("escapes title, names and color tokens", () => {
    const html = chart({ ...base, title: "<b>x</b>", series: [{ name: "a&b", c: 'x"y', data: [1, 2] }] });
    expect(html).not.toContain("<b>x</b>");
    expect(html).toContain("&lt;b&gt;x&lt;/b&gt;");
    expect(html).toContain("a&amp;b");
    expect(html).toContain("x&quot;y");
  });

  test("empty data renders a placeholder", () => {
    expect(chart({ ...base, series: [{ name: "x", c: "cpu", data: [] }] })).toContain("No data");
    expect(chart({ ...base, series: [] })).toContain("No data");
  });

  test("single point and all-zero data produce no NaN", () => {
    expect(chart({ ...base, series: [{ name: "x", c: "cpu", data: [5] }] })).not.toContain("NaN");
    expect(chart({ ...base, series: [{ name: "x", c: "cpu", data: [0, 0, 0] }] })).not.toContain("NaN");
    expect(chart({ ...base, series: [{ name: "x", c: "cpu", data: [1, NaN, 3] }] })).not.toContain("NaN");
  });

  test("only the first series gets an area fill", () => {
    const html = chart({
      ...base,
      series: [
        { name: "a", c: "rx", data: [1, 2] },
        { name: "b", c: "tx", data: [2, 1] },
      ],
    });
    expect(html.match(/opacity="\.13"/g)).toHaveLength(1);
    expect(html.match(/<circle/g)).toHaveLength(2);
  });
});

describe("helpers", () => {
  test("esc", () => expect(esc(`<&"'>`)).toBe("&lt;&amp;&quot;&#39;&gt;"));
  test("hourLabels spans the window in UTC", () => {
    const end = Date.UTC(2026, 0, 2, 19, 35);
    expect(hourLabels(end)).toEqual(["19:35", "01:35", "07:35", "13:35", "19:35"]);
  });
});

describe("chart lead", () => {
  test("points before `from` are not drawn and do not count in the numbers", () => {
    const data = [90, 90, 90, 10, 20, 30];
    const svg = chart({ title: "CPU", series: [{ name: "CPU", c: "cpu", data }], fmt: (v) => String(v), xLabels: [], from: 3 });
    const path = /<path d="(M[^"]+)" fill="none"/.exec(svg)![1]!;
    expect(path.split("L").length).toBe(3);
    expect(svg).toContain("<td>CPU</td><td>30</td><td>20</td><td>10</td><td>30</td>");
  });

  test("the legend carries its colour as a class, not an inline style", () => {
    const svg = chart({ title: "Net", series: [{ name: "rx", c: "rx", data: [1, 2] }], fmt: String, xLabels: [], legend: true });
    expect(svg).toContain('<span class="c-rx">');
    expect(svg).not.toContain("style=");
  });
});
