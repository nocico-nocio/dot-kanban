export const taskImageMaxBytes = 1024 * 1024;
export const taskImageMaxDimension = 2048;

export function taskImages(description: string) {
  return [...description.matchAll(/!\[([^\]\n]*)\]\((\/api\/task-images\/([0-9a-f-]{36}))\)/g)].map(
    (match) => ({
      alt: match[1],
      url: match[2],
      id: match[3],
      start: match.index,
      end: match.index + match[0].length,
    }),
  );
}
