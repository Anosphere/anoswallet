/** A number of minutes in words for a sentence (wallet spec 8.2, Account): "15 minutes", "1 hour and 30 minutes", "7 days and 10 minutes", "30 days". */
export function minutesWords(minutes: number): string {
  const days = Math.floor(minutes / 1440);
  const hours = Math.floor((minutes % 1440) / 60);
  const rest = minutes % 60;
  const parts: string[] = [];
  if (days !== 0) parts.push(days === 1 ? '1 day' : `${days} days`);
  if (hours !== 0) parts.push(hours === 1 ? '1 hour' : `${hours} hours`);
  if (rest !== 0) parts.push(rest === 1 ? '1 minute' : `${rest} minutes`);
  if (parts.length === 0) return '0 minutes';
  if (parts.length === 1) return parts[0];
  return `${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1]}`;
}
