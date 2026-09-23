/**
 * A round axis for a chart whose data peaks at `max`: steps of 1, 2, 2.5 or 5
 * times a power of ten, ending on the first step at or above the peak. Labels
 * then read £0 / £20 / £40 / £60 instead of quarters of an arbitrary maximum.
 */
export function niceScale(max: number, targetTicks = 4) {
  const peak = Number.isFinite(max) && max > 0 ? max : 1;
  const rough = peak / Math.max(1, targetTicks);
  const magnitude = 10 ** Math.floor(Math.log10(rough));
  const step = [1, 2, 2.5, 5, 10].map((factor) => factor * magnitude).find((candidate) => candidate >= rough)!;
  const top = Math.ceil(peak / step - 1e-9) * step;
  const ticks: number[] = [];
  for (let value = 0; value <= top + step / 2; value += step) ticks.push(Number(value.toPrecision(12)));
  return { max: top, step, ticks };
}
