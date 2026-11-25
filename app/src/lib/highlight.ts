export function splitByHotwords(
  text: string,
  hotwords: readonly string[],
): Array<{ text: string; hit: boolean }> {
  const words = [...new Set(hotwords.filter((word) => word.trim().length > 0))]
    .sort((a, b) => b.length - a.length);
  if (!text || words.length === 0) return [{ text, hit: false }];

  const pattern = new RegExp(words.map((word) => word.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|"), "g");
  const parts: Array<{ text: string; hit: boolean }> = [];
  let end = 0;
  for (const match of text.matchAll(pattern)) {
    if (match.index > end) parts.push({ text: text.slice(end, match.index), hit: false });
    parts.push({ text: match[0], hit: true });
    end = match.index + match[0].length;
  }
  if (end < text.length) parts.push({ text: text.slice(end), hit: false });
  return parts;
}
