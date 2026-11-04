export interface TreemapInput {
  v: number;
}

export type TreemapRect<T extends TreemapInput> = T & { a: number; x: number; y: number; w: number; h: number };

type Weighted = { a: number };

export function wr(row: readonly Weighted[], s: number): number {
  let sum = 0;
  let mx = -Infinity;
  let mn = Infinity;
  for (const i of row) {
    sum += i.a;
    if (i.a > mx) mx = i.a;
    if (i.a < mn) mn = i.a;
  }
  return Math.max((s * s * mx) / (sum * sum), (sum * sum) / (s * s * mn));
}

export function squarify<T extends TreemapInput>(
  items: readonly T[],
  x: number,
  y: number,
  w: number,
  h: number,
): TreemapRect<T>[] {
  const valid = items.filter((i) => Number.isFinite(i.v) && i.v > 0).sort((p, q) => q.v - p.v);
  if (valid.length === 0 || !(w > 0) || !(h > 0)) return [];
  const total = valid.reduce((s, i) => s + i.v, 0);
  const out: TreemapRect<T>[] = [];
  let rest = valid.map((i) => ({ ...i, a: (i.v * w * h) / total }));
  while (rest.length) {
    const short = Math.min(w, h);
    let row = [rest[0]!];
    let worst = wr(row, short);
    for (let k = 1; k < rest.length; k++) {
      const tr = row.concat(rest[k]!);
      const wt = wr(tr, short);
      if (wt <= worst) {
        row = tr;
        worst = wt;
      } else break;
    }
    const sum = row.reduce((s, i) => s + i.a, 0);
    if (w >= h) {
      const rw = sum / h;
      let yy = y;
      for (const i of row) {
        const ih = i.a / rw;
        out.push({ ...i, x, y: yy, w: rw, h: ih });
        yy += ih;
      }
      x += rw;
      w -= rw;
    } else {
      const rh = sum / w;
      let xx = x;
      for (const i of row) {
        const iw = i.a / rh;
        out.push({ ...i, x: xx, y, w: iw, h: rh });
        xx += iw;
      }
      y += rh;
      h -= rh;
    }
    rest = rest.slice(row.length);
  }
  return out;
}
