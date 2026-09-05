/** Keep endpoint annotations readable when providers finish at similar balances. */
export function spreadRunwayLabels<T extends { y: number }>(labels: T[], top: number, bottom: number, gap = 32): T[] {
  const placed = labels
    .map((label) => ({ ...label, y: Math.max(top, Math.min(bottom, label.y)) }))
    .sort((a, b) => a.y - b.y);
  for (let index = 1; index < placed.length; index += 1) {
    placed[index].y = Math.max(placed[index].y, placed[index - 1].y + gap);
  }
  if (placed.length && placed.at(-1)!.y > bottom) {
    placed.at(-1)!.y = bottom;
    for (let index = placed.length - 2; index >= 0; index -= 1) {
      placed[index].y = Math.min(placed[index].y, placed[index + 1].y - gap);
    }
  }
  return placed;
}
