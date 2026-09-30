import { markdownToHtml } from '../../src/listeners/markdown';

describe('markdownToHtml', () => {
  it('renders what the guides are written in', () => {
    const md = [
      '*Jingle: TU WAS DU WILLST*',
      '',
      'Willkommen **zurück**,',
      'heute auf Radio Z.',
      '',
      '### Wie funktioniert das System?',
      '',
      '> Wenn ich heute mit einem Kleidungsstück zu euch komme:',
      '> Was passiert dann?',
      '',
      '- Kann das gelingen?',
      '- Beutet Ihr Euch',
      '  selbst aus?',
      '',
      '1. eins',
      '2. zwei',
    ].join('\n');
    expect(markdownToHtml(md)).toBe(
      '<p><em>Jingle: TU WAS DU WILLST</em></p>' +
        '<p>Willkommen <strong>zurück</strong>,<br>heute auf Radio Z.</p>' +
        '<h4>Wie funktioniert das System?</h4>' +
        '<blockquote>Wenn ich heute mit einem Kleidungsstück zu euch komme:<br>Was passiert dann?</blockquote>' +
        '<ul><li>Kann das gelingen?</li><li>Beutet Ihr Euch selbst aus?</li></ul>' +
        '<ol><li>eins</li><li>zwei</li></ol>'
    );
  });

  it('escapes everything typed, so nothing but its own tags reaches the page', () => {
    const html = markdownToHtml('<img src=x onerror=alert(1)> & "zitat"\n\n<script>x</script>');
    expect(html).toBe(
      '<p>&lt;img src=x onerror=alert(1)&gt; &amp; &quot;zitat&quot;</p><p>&lt;script&gt;x&lt;/script&gt;</p>'
    );
  });

  it('keeps the text of a link and drops where it goes', () => {
    expect(markdownToHtml('Mail an [Anna](mailto:anna@example.org)!')).toBe('<p>Mail an Anna!</p>');
    expect(markdownToHtml('[x](javascript:alert(1))')).not.toContain('javascript');
  });

  it('leaves stars and underscores inside words alone', () => {
    expect(markdownToHtml('snake_case_name und 2*3*4')).toBe('<p>snake_case_name und 2*3*4</p>');
  });

  it('is empty for nothing', () => {
    expect(markdownToHtml('')).toBe('');
    expect(markdownToHtml(null)).toBe('');
  });
});
