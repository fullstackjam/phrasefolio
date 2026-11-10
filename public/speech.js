export function spokenExpression(expression) {
  let depth = 0;
  let text = '';
  for (const character of expression) {
    if (character === '(' || character === '（') depth += 1;
    else if ((character === ')' || character === '）') && depth > 0) depth -= 1;
    else if (depth === 0) text += character;
  }
  return text.replace(/ \/ /g, ', ')
    .replace(/["“”«»「」『』]/g, '')
    .replace(/(^|[^\p{L}\p{N}])['‘’]|['‘’](?![\p{L}\p{N}])/gu, '$1')
    .replace(/\s+([,.])/g, '$1')
    .replace(/\s+/g, ' ')
    .trim();
}

export function speakExpression(expression) {
  if (!globalThis.speechSynthesis || !globalThis.SpeechSynthesisUtterance) return;
  const text = spokenExpression(expression);
  if (!text) return;
  const utterance = new SpeechSynthesisUtterance(text);
  utterance.lang = 'en-US';
  const voice = speechSynthesis.getVoices().find(({ lang }) => lang.toLowerCase() === 'en-us');
  if (voice) utterance.voice = voice;
  speechSynthesis.cancel();
  speechSynthesis.speak(utterance);
}
