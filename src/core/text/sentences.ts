const SENTENCE_END_RE = /[.!?]["'’”)\]]*$/;

export function endsSentence(text: string): boolean {
  return SENTENCE_END_RE.test(text);
}
