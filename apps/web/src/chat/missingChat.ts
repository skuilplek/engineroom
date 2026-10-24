export function isMissingChat(error: string): boolean {
  const text = error.toLowerCase();
  return text.includes("chat not found") || text.includes("enoent");
}
