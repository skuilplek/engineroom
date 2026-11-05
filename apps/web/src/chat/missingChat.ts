export function isMissingChat(error: string): boolean {
  const text = error.toLowerCase();
  if (text.includes("chat not found")) return true;
  // Only the chat metadata file counts as a missing chat. A random ENOENT from
  // another command must not send the user home.
  return text.includes("enoent") && text.includes(".engineroom/chats/");
}
