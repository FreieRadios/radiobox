/**
 * The little markdown an episode's guide is written in, as HTML for the
 * operators' page.
 *
 * The scripts and topic notes come from eve, typed by people, and go into the
 * page with innerHTML — so everything is escaped first and only a fixed set of
 * tags is ever produced. What the guides use is covered: paragraphs, `###`
 * headings, `>` quotes (a question as it is asked), `-`/`1.` lists and
 * `**bold**` / `*italic*` (stage directions like `*Jingle*`). Links keep their
 * text only: nothing on the studio screen navigates away from it.
 */

const ESC: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
};

export function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ESC[c]);
}

/** One line of text, escaped, with the inline marks turned into tags. */
function inline(raw: string): string {
  return escapeHtml(raw)
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\*\*(?=\S)(.+?)\*\*/g, '<strong>$1</strong>')
    .replace(/__(?=\S)(.+?)__/g, '<strong>$1</strong>')
    .replace(/(^|[^*\w])\*(?=\S)([^*]+?)\*(?!\w)/g, '$1<em>$2</em>')
    .replace(/(^|[^_\w])_(?=\S)([^_]+?)_(?!\w)/g, '$1<em>$2</em>');
}

type Block = { kind: 'p' | 'h' | 'quote' | 'ul' | 'ol'; lines: string[] };

export function markdownToHtml(src: string | null | undefined): string {
  if (!src) return '';
  const blocks: Block[] = [];
  let cur = null as Block | null;
  const open = (kind: Block['kind']): Block => {
    if (!cur || cur.kind !== kind) {
      cur = { kind, lines: [] };
      blocks.push(cur);
    }
    return cur;
  };
  for (const line of src.replace(/\r\n?/g, '\n').split('\n')) {
    const t = line.trim();
    let m: RegExpExecArray | null;
    if (!t) {
      cur = null;
    } else if ((m = /^#{1,6}\s+(.*)$/.exec(t))) {
      blocks.push({ kind: 'h', lines: [m[1]] });
      cur = null;
    } else if ((m = /^>\s?(.*)$/.exec(t))) {
      open('quote').lines.push(m[1]);
    } else if ((m = /^[-*+]\s+(.*)$/.exec(t))) {
      open('ul').lines.push(m[1]);
    } else if ((m = /^\d+[.)]\s+(.*)$/.exec(t))) {
      open('ol').lines.push(m[1]);
    } else if (cur && (cur.kind === 'ul' || cur.kind === 'ol') && /^\s/.test(line)) {
      // An indented continuation belongs to the list item above it.
      cur.lines[cur.lines.length - 1] += ' ' + t;
    } else {
      open(cur?.kind === 'quote' ? 'quote' : 'p').lines.push(t);
    }
  }
  return blocks
    .map((b) => {
      const text = b.lines.map(inline);
      switch (b.kind) {
        case 'h':
          return `<h4>${text[0]}</h4>`;
        case 'quote':
          return `<blockquote>${text.join('<br>')}</blockquote>`;
        case 'ul':
        case 'ol':
          return `<${b.kind}>${text.map((l) => `<li>${l}</li>`).join('')}</${b.kind}>`;
        default:
          return `<p>${text.join('<br>')}</p>`;
      }
    })
    .join('');
}
