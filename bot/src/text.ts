export const MAX_SPOKEN_CHARS = 150;

/** Prefixes the message with its author's name. A message with nothing to read stays empty, so it is skipped. */
export function toUtterance(author: string, content: string): string {
  const body = toSpeech(content);
  const name = toSpeech(author);
  return body && name ? `${name}、${body}` : body;
}

/** Converts a message (with mentions already resolved) to speakable text. Empty means "skip". */
export function toSpeech(content: string): string {
  const text = content
    .replace(/```[\s\S]*?```/g, " コードブロック ")
    .replace(/\|\|[\s\S]*?\|\|/g, " 伏せ字 ")
    .replace(/<a?:\w+:\d+>/g, " ")
    .replace(/https?:\/\/\S+/g, " URL ")
    .replace(/[`*_~]+/g, "")
    .replace(/\s+/g, " ")
    .trim();

  const chars = [...text];
  return chars.length > MAX_SPOKEN_CHARS
    ? `${chars.slice(0, MAX_SPOKEN_CHARS).join("")} 以下略`
    : text;
}
