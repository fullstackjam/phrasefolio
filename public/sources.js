const sources = [
  ['C', 'Claude Code · Code review', /claude\.dev\/blog\/[^\s]*code-review|claude.*code review/i],
  ['T', 'Thorsten Ball · How I work with Agents', /thorsten\s*ball|how i work with agents/i],
  ['M', 'The Story of Mel', /the story of mel|story-of-mel/i],
  ['P', 'arXiv · Swapping the Judge', /2611\.04090|swapping the judge/i],
  ['CF', 'Cloudflare · eMudhra', /emudhra/i],
  ['AI', 'CSO Online · AI coding-assistant files', /4242707|ai coding[ -]assistant/i],
  ['MI', 'CSO Online · Machine identity playbooks', /4244632|(?:machine[ -]identity.*playbooks|playbooks.*machine[ -]identity)/i],
  ['AM', 'The Argument · Alpha School', /theargumentmag\.com\/p\/why-parents-love-a-school-with-bogus|the argument|alpha school/i],
  ['PI', 'The Pudding · Afterlife of Pi', /afterlife of pi|pudding\.cool\/\d+\/\d+\/pi\b/i],
  ['PQ', 'Cloudflare · Post-quantum privacy', /vole-mole|post-quantum future of web privacy/i],
  ['SH', 'sshhole', /sshhole/i],
  ['WS', 'Weight-space programming', /weight[ -]space[ -]programming/i],
  ['DV', 'The Verge · Mitch Glazier', /mitch[ -]glazier|the verge.*decoder|decoder.*the verge/i],
];

export const sourceOptions = sources.map(([code, title]) => ({ code, title }));

export function sourceCodes(source) {
  const parts = source.split(' | ');
  return sources
    .filter(([, , pattern]) => parts.some((part) => pattern.test(part)))
    .map(([code]) => code);
}
