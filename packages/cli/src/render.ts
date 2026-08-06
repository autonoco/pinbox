// pinbox CLI — shared human-output rendering helpers.
// Human timestamps are relative ("2m ago"); JSON carries the stored ISO strings
// verbatim (transcripts, decision 8).

/**
 * Relative age for human output. Rounds at each unit so "2h54m" reads "3h ago",
 * matching the transcripts' ages.
 */
export function relativeAge(at: string): string {
  const seconds = Math.max(0, (Date.now() - Date.parse(at)) / 1000);
  const minutes = Math.round(seconds / 60);
  if (minutes === 0) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}
