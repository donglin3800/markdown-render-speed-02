// A fast, dependency-free Markdown renderer whose output is byte-identical
// to marked 18.1.3 with its default options (GFM on, breaks off, pedantic
// off, async off). Clean-room implementation: the grammars below reproduce
// marked's behaviour, the code around them is original, and the hot loops
// run on a cursor with sticky patterns instead of re-slicing the input.


// Small builder for composing big patterns from named pieces, mirroring
// how the reference grammars are assembled. `swap` replaces the first
// occurrence of a placeholder word with a piece's source, dropping any
// leading ^ the piece carries.
function reEdit(pattern, flags) {
  let src = typeof pattern === 'string' ? pattern : pattern.source;
  const api = {
    swap(word, piece) {
      let sub = typeof piece === 'string' ? piece : piece.source;
      sub = sub.replace(/(^|[^\[])\^/g, '$1');
      src = src.replace(word, sub);
      return api;
    },
    done() {
      return new RegExp(src, flags);
    }
  };
  return api;
}

// Build a sticky twin of a ^-anchored pattern: the sticky flag pins the
// match to the cursor, so the ^ anchors (start of pattern and after each
// top-level |) are dropped.
function stickyOf(re) {
  const src = re.source.replace(/^\^/, '').replace(/\|\^/g, '|');
  const flags = re.flags.replace('g', '') + 'y';
  return new RegExp(src, flags);
}

// Cache for indent-dependent patterns: the indent is clamped to 0..3.
function indentCache(make) {
  const slots = [];
  return n => {
    const k = Math.max(0, Math.min(3, n - 1));
    return slots[k] || (slots[k] = make(k));
  };
}

const BLANK_LINE = /^[ \t]*$/;
const CODE_INDENT = /^(?: {0,3}\t| {1,4})/gm;
const LINK_BRACKET_ESC = /\\([\[\]])/g;
const FENCE_INDENT = /^(\s+)(?:```)/;
const LEAD_SPACE = /^\s+/;
const END_HASH = /#$/;
const LEAD_SPACE_CHAR = /^ /;
const END_SPACE_CHAR = / $/;
const END_SPACE_TAB = /[ \t]$/;
const NON_SPACE = /[^ ]/;
const NEWLINE_G = /\n/g;
const TAB_G = /\t/g;
const LEAD_SPACE_TAB = /^[ \t]+/;
const MULTI_SPACE = /\s+/g;
const DOUBLE_BLANK = /\n[ \t]*\n[ \t]*$/;
const BQ_START = /^ {0,3}>/;
const BQ_SETEXT = /\n {0,3}((?:=+|-+)[ \t]*)(?=\n|$)/g;
const BQ_SETEXT_STRIP = /^ {0,3}>[ \t]?/gm;
const BQ_MARKER_WS = /^( {0,3}>)([ \t]+)/gm;
const LIST_IS_TASK = /^\[[ xX]\][ \t]+\S/;
const LIST_STRIP_TASK = /^\[[ xX]\][ \t]+/;
const LIST_TASK_BOX = /\[[ xX]\]/;
const ANY_LINE = /\n.*\n/;
const HREF_ANGLE = /^<(.*)>$/;
const TABLE_DELIM = /[:|]/;
const TABLE_EDGE = /^\||\| *$/g;
const TABLE_BODY_TAIL = /\n[ \t]*$/;
const ALIGN_RIGHT = /^ *-+: *$/;
const ALIGN_CENTER = /^ *:-+: *$/;
const ALIGN_LEFT = /^ *:-+ *$/;
const A_TAG_OPEN = /^<a /i;
const A_TAG_CLOSE = /^<\/a>/i;
const PRE_TAG_OPEN = /^<(pre|code|kbd|script)(\s|>)/i;
const PRE_TAG_CLOSE = /^<\/(pre|code|kbd|script)(\s|>)/i;
const ANGLE_OPEN = /^</;
const ANGLE_CLOSE = />$/;
const UNICODE_ALNUM = /[\p{L}\p{N}]/u;
const NOT_SPACE_START = /^\S*/;
const END_NEWLINE = /\n$/;
const CARRIAGE = /\r\n|\r/g;

// Block-level HTML tag names.
const BLOCK_TAGS = 'address|article|aside|base|basefont|blockquote|body|caption|center|col|colgroup|dd|details|dialog|dir|div|dl|dt|fieldset|figcaption|figure|footer|form|frame|frameset|h[1-6]|head|header|hr|html|iframe|legend|li|link|main|menu|menuitem|meta|nav|noframes|ol|optgroup|option|p|param|search|section|summary|table|tbody|td|tfoot|th|thead|title|tr|track|ul';
const HTML_COMMENT = /<!--(?:-?>|[\s\S]*?(?:-->|$))/;
const TAG_ATTR = / +[a-zA-Z:_][\w.:-]*(?: *= *"[^"\n]*"| *= *'[^'\n]*'| *= *[^\s"'=<>`]+)?/;


// ---- Block grammar (GFM) ----
// The four large patterns are assembled from small pieces, the same way
// the reference builds them; the rest are written out directly.

const HR_BODY = ' {0,3}((?:-[\\t ]*){3,}|(?:_[ \\t]*){3,}|(?:\\*[ \\t]*){3,})(?:\\n+|$)';
const HR_RE = new RegExp('^' + HR_BODY);
const BQ_PIECE = ' {0,3}>';
const HEAD_PIECE = ' {0,3}#{1,6}(?:\\s|$)';
const FENCES_PIECE = ' {0,3}(?:`{3,}|~{3,})';
const HTML_PIECE = ' {0,3}(?:</?(?:tag)(?: +|\\n|/?>)|<(?:(?:script|pre|style|textarea)(?:[\\s>]|$)|!--)|<\\?|<![A-Za-z]|<!\\[CDATA\\[)';
const FENCES_BLOCK_PIECE = ' {0,3}(?:`{3,}(?=[^`\\n]*(?:\\n|$))|~~~)[^\\n]*(?:\\n|$)';
const PARA_TEMPLATE = /^([^\n]+(?:\n(?!hr|heading|lheading|blockquote|fences|list|html|table|[ \t]+\n)[^\n]+)*)/;

function buildPara(listPiece) {
  return reEdit(PARA_TEMPLATE)
    .swap('hr', HR_BODY)
    .swap('heading', HEAD_PIECE)
    .swap('|lheading', '')
    .swap('|table', '')
    .swap('blockquote', BQ_PIECE)
    .swap('fences', FENCES_BLOCK_PIECE)
    .swap('list', listPiece)
    .swap('html', HTML_PIECE)
    .swap('tag', BLOCK_TAGS)
    .done();
}

const TABLE_RE = reEdit(/^ *([^\n ].*)\n {0,3}((?:\| *)?:?-+:? *(?:\| *:?-+:? *)*(?:\| *)?)(?:\n((?:(?! *\n|hr|heading|blockquote|code|fences|list|html).*(?:\n|$))*)\n*|$)/)
  .swap('hr', HR_BODY)
  .swap('heading', HEAD_PIECE)
  .swap('blockquote', BQ_PIECE)
  .swap('code', '(?: {4}| {0,3}\t)[^\\n]')
  .swap('fences', FENCES_BLOCK_PIECE)
  .swap('list', ' {0,3}(?:[*+-]|1[.)])[ \\t]')
  .swap('html', HTML_PIECE)
  .swap('tag', BLOCK_TAGS)
  .done();

const BLOCK = {
  newline: /^(?:[ \t]*(?:\n|$))+/,
  code: /^((?: {4}| {0,3}\t)[^\n]+(?:\n(?:[ \t]*(?:\n|$))*)?)+/,
  fences: /^ {0,3}(`{3,}(?=[^`\n]*(?:\n|$))|~{3,})([^\n]*)(?:\n|$)(?:|([\s\S]*?)(?:\n|$))(?: {0,3}(?:(?=`)\1`*|(?=~)\1~*) *(?=\n|$)|$)/,
  heading: /^ {0,3}(#{1,6})(?=\s|$)(.*)(?:\n+|$)/,
  hr: HR_RE,
  blockquote: reEdit(/^( {0,3}> ?(?:(?![ \t]*(?:\n|$))(paragraph)|[^\n]*)(?:\n|$))+/).swap('paragraph', buildPara(' {0,3}(?:[*+-]|\\d{1,9}[.)])(?:[ \\t]|\\n|$)')).done(),
  list: /^( {0,3}(?:[*+-]|\d{1,9}[.)]))([ \t][^\n]*?)?(?:\n|$)/,
  html: reEdit(/^ {0,3}(?:<(script|pre|style|textarea)[\s>][\s\S]*?(?:<\/\1>[^\n]*\n*|$)|comment[^\n]*(\n+|$)|<\?[\s\S]*?(?:\?>[^\n]*\n*|$)|<![A-Z][\s\S]*?(?:>[^\n]*\n*|$)|<!\[CDATA\[[\s\S]*?(?:\]\]>[^\n]*\n*|$)|<\/?(tag)(?:[ \t]+|\n|\/?>|$)[\s\S]*?(?:(?:\n[ \t]*)+\n|$)|<(?!(?:script|pre|style|textarea)(?![a-z0-9-]))([a-z][a-z0-9-]*)(?:attribute)*? *\/?>(?=[ \t]*(?:\n|$))[\s\S]*?(?:(?:\n[ \t]*)+\n|$)|<\/[a-z][a-z0-9-]*\s*>(?=[ \t]*(?:\n|$))[\s\S]*?(?:(?:\n[ \t]*)+\n|$))/, 'i')
    .swap('comment', HTML_COMMENT)
    .swap('tag', BLOCK_TAGS)
    .swap('attribute', TAG_ATTR)
    .done(),
  def: reEdit(/^ {0,3}\[(label)\]: *(?:\n[ \t]*)?([^<\s][^\s]*|<.*?>)(?:(?: +(?:\n[ \t]*)?| *\n[ \t]*)(title))? *(?:\n+|$)/)
    .swap('label', /(?!\s*\])(?:\\[\s\S]|[^\[\]\\\n]|\n(?![ \t]*\n))+/)
    .swap('title', /(?:"(?:\\[\s\S]|[^"\\])*"|'(?:\\[\s\S]|[^'\\\n]|\n(?!\n))*'|\((?:\\[\s\S]|[^()\\])*\))/)
    .done(),
  table: TABLE_RE,
  lheading: reEdit(/^(?!bull |blockCode|fences|blockquote|heading|html|table)((?:.|\n(?!\s*?\n|bull |fences|blockquote|heading|hr|html|table))+?)\n {0,3}(=+|-+)[ \t]*(?:\n+|$)/)
    .swap(/bull/g, / {0,3}(?:[*+-]|\d{1,9}[.)])/)
    .swap(/blockCode/g, /(?: {4}| {0,3}\t)/)
    .swap(/fences/g, / {0,3}(?:`{3,}|~{3,})/)
    .swap(/blockquote/g, / {0,3}>/)
    .swap(/heading/g, / {0,3}#{1,6}(?:\s|$)/)
    .swap(/hr/g, / {0,3}(?:(?:-[\t ]*){3,}|(?:_[ \t]*){3,}|(?:\*[ \t]*){3,})(?:\n+|$)/)
    .swap(/html/g, / {0,3}<[^\n>]+>\n/)
    .swap(/table/g, / {0,3}\|?(?:[:\- ]*\|)+[\:\- ]*\n/)
    .done(),
  paragraph: reEdit(PARA_TEMPLATE)
    .swap('hr', HR_BODY)
    .swap('heading', HEAD_PIECE)
    .swap('|lheading', '')
    .swap('table', TABLE_RE)
    .swap('blockquote', BQ_PIECE)
    .swap('fences', FENCES_BLOCK_PIECE)
    .swap('list', ' {0,3}(?:[*+-]|1[.)])[ \\t]+[^ \\t\\n]')
    .swap('html', HTML_PIECE)
    .swap('tag', BLOCK_TAGS)
    .done(),
  text: /^[^\n]+/
};

// Sticky twins for the cursor-driven block loop.
const BLOCK_S = {};
for (const k of Object.keys(BLOCK)) BLOCK_S[k] = stickyOf(BLOCK[k]);

// Indent-dependent patterns used inside lists (applied to single lines).
const listItemRe = bull => new RegExp(`^( {0,3}${bull})((?:[ \t][^\\n]*)?(?:\\n|$))`);
const nextBulletRe = indentCache(n => new RegExp(`^ {0,${n}}(?:[*+-]|\\d{1,9}[.)])((?:[ \t][^\\n]*)?(?:\\n|$))`));
const hrAtRe = indentCache(n => new RegExp(`^ {0,${n}}((?:-[ \t]*){3,}|(?:_[ \t]*){3,}|(?:\\*[ \t]*){3,})(?:\\n+|$)`));
const fencesAtRe = indentCache(n => new RegExp(`^ {0,${n}}(?:\`\`\`|~~~)`));
const headingAtRe = indentCache(n => new RegExp(`^ {0,${n}}#{1,6}(?:\\s|$)`));
const htmlAtRe = indentCache(n => new RegExp(`^ {0,${n}}(?:</?(?:${BLOCK_TAGS})(?: +|$|/?>)|<(?:(?:script|pre|style|textarea)(?:[\\s>]|$)|!--)|<\\?|<![A-Za-z]|<!\\[CDATA\\[)`, 'i'));
const bqAtRe = indentCache(n => new RegExp(`^ {0,${n}}>`));
// Combined break tests for list items: one exec instead of six (or four)
// separate tests per line. The alternation is the exact union of the
// individual patterns above, sharing the same `^ {0,n}` prefix; the 'i'
// flag only affects the HTML tag names, which are the one part that needs
// it, so the boolean result is identical to the OR of the six tests.
const listBreak6Re = indentCache(n => new RegExp(`^ {0,${n}}(?:(?:\`\`\`|~~~)|#{1,6}(?:\\s|$)|</?(?:${BLOCK_TAGS})(?: +|$|/?>)|<(?:(?:script|pre|style|textarea)(?:[\\s>]|$)|!--)|<\\?|<![A-Za-z]|<!\\[CDATA\\[|>|(?:[*+-]|\\d{1,9}[.)])((?:[ \\t][^\\n]*)?(?:\\n|$))|((?:-[ \\t]*){3,}|(?:_[ \\t]*){3,}|(?:\\*[ \\t]*){3,})(?:\\n+|$))`, 'i'));
const listBreak4Re = indentCache(n => new RegExp(`^ {0,${n}}(?:(?:\`\`\`|~~~)|#{1,6}(?:\\s|$)|</?(?:${BLOCK_TAGS})(?: +|$|/?>)|<(?:(?:script|pre|style|textarea)(?:[\\s>]|$)|!--)|<\\?|<![A-Za-z]|<!\\[CDATA\\[|((?:-[ \\t]*){3,}|(?:_[ \\t]*){3,}|(?:\\*[ \\t]*){3,})(?:\\n+|$))`, 'i'));



// ---- Inline grammar (GFM) ----

const BRACKETS_RE = /\[(?:\\[\s\S]|[^\[\]\\])*\]/;
const LABEL_TEXT_RE = reEdit(/(?:\[(?:brackets|\\[\s\S]|[^\[\]\\])*\]|\\[\s\S]|`+(?!`)[^`]*?`+(?!`)|``+(?=\])|[^\[\]\\`])*?/)
  .swap('brackets', BRACKETS_RE)
  .done();
const LONG_LABEL_RE = reEdit(/(?:[^\[\]\\`]*(?:\[(?:brackets|\\[\s\S]|[^\[\]\\])*\]|\\[\s\S]|`+(?!`)[^`]*?`+(?!`)|``+(?=\]))){0,999}?[^\[\]\\`]*?/)
  .swap('brackets', BRACKETS_RE)
  .done();
const REF_LABEL = /(?!\s*\])(?:\\[\s\S]|[^\[\]\\\n]|\n(?![ \t]*\n))+/;
const REF_SHORT = /(?!\s*\])(?:\\[\s\S]|[^\[\]\\]){1,999}/;
const LINK_HREF = /<(?:\\.|[^\n<>\\])+>|[^ \t\n\x00-\x1f]+|(?=\))/;
const LINK_TITLE = /"(?:\\[\s\S]|[^"\\])*"|'(?:\\[\s\S]|[^'\\])*'|\((?:\\[\s\S]|[^)\\])*\)/;

const LINK_RE = reEdit(/^!?\[(label)\]\([ \t\n]*(href)(?:(?:[ \t]+(?:\n[ \t]*)?|\n[ \t]*)(title))?[ \t\n]*\)/)
  .swap('label', LABEL_TEXT_RE)
  .swap('href', LINK_HREF)
  .swap('title', LINK_TITLE)
  .done();
const REFLINK_RE = reEdit(/^!?\[(label)\]\[(ref)\]/)
  .swap('label', LABEL_TEXT_RE)
  .swap('ref', REF_LABEL)
  .done();
const NOLINK_RE = reEdit(/^!?\[(ref)\](?:\[\])?/)
  .swap('ref', REF_LABEL)
  .done();
const REFLINK_SEARCH = reEdit(/reflink|nolink(?!\()/, 'g')
  .swap('reflink', reEdit(/^!?\[(label)\]\[(ref)\]/).swap('label', LONG_LABEL_RE).swap('ref', REF_SHORT).done())
  .swap('nolink', reEdit(/^!?\[(ref)\](?:\[\])?/).swap('ref', REF_SHORT).done())
  .done();

const INLINE = {
  escape: /^\\([!"#$%&'()*+,\-./:;<=>?@\[\]\\^_`{|}~])/,
  tag: /^<!--(?:-?>|[\s\S]*?-->)|^<\/[a-zA-Z][a-zA-Z0-9-]*\s*>|^<[a-zA-Z][a-zA-Z0-9-]*(?:\s+[a-zA-Z:_][\w.:-]*(?:\s*=\s*"[^"]*"|\s*=\s*'[^']*'|\s*=\s*[^\s"'=<>`]+)?)*?\s*\/?>|^<\?[\s\S]*?\?>|^<![a-zA-Z]+\s[\s\S]*?>|^<!\[CDATA\[[\s\S]*?\]\]>/,
  link: LINK_RE,
  reflink: REFLINK_RE,
  nolink: NOLINK_RE,
  emStrongLDelim: /^(?:\*+(?:((?!\*)(?!~)[\p{P}\p{S}])|([^\s*]))?)|^_+(?:((?!_)(?!~)[\p{P}\p{S}])|([^\s_]))?/u,
  emStrongRDelimAst: /^[^_*]*?__[^_*]*?\*[^_*]*?(?=__)|[^*]+(?=[^*])|(?!\*)(?!~)[\p{P}\p{S}](\*+)(?=[\s]|$)|(?:[^\s\p{P}\p{S}]|~)(\*+)(?!\*)(?=(?!~)[\s\p{P}\p{S}]|$)|(?!\*)(?!~)[\s\p{P}\p{S}](\*+)(?=(?:[^\s\p{P}\p{S}]|~))|[\s](\*+)(?!\*)(?=(?!~)[\p{P}\p{S}])|(?!\*)(?!~)[\p{P}\p{S}](\*+)(?!\*)(?=(?!~)[\p{P}\p{S}])|(?:[^\s\p{P}\p{S}]|~)(\*+)(?=(?:[^\s\p{P}\p{S}]|~))/gu,
  emStrongRDelimUnd: /^[^_*]*?\*\*[^_*]*?_[^_*]*?(?=\*\*)|[^_]+(?=[^_])|(?!_)[\p{P}\p{S}](_+)(?=[\s]|$)|[^\s\p{P}\p{S}](_+)(?!_)(?=[\s\p{P}\p{S}]|$)|(?!_)[\s\p{P}\p{S}](_+)(?=[^\s\p{P}\p{S}])|[\s](_+)(?!_)(?=[\p{P}\p{S}])|(?!_)[\p{P}\p{S}](_+)(?!_)(?=[\p{P}\p{S}])/gu,
  codespan: /^(`+)([^`]|[^`][\s\S]*?[^`])\1(?!`)/,
  br: /^( {2,}|\\)\n(?!\s*$)[ \t]*/,
  del: /^(~~?)(?=[^\s~])((?:\\[\s\S]|[^\\])*?(?:\\[\s\S]|[^\s~\\]))\1(?=[^~]|$)/,
  delLDelim: /^~~?(?:((?!~)[\p{P}\p{S}])|[^\s~])/u,
  delRDelim: /^[^~]+(?=[^~])|(?!~)[\p{P}\p{S}](~~?)(?=[\s]|$)|[^\s\p{P}\p{S}](~~?)(?!~)(?=[\s\p{P}\p{S}]|$)|(?!~)[\s\p{P}\p{S}](~~?)(?=[^\s\p{P}\p{S}])|[\s](~~?)(?!~)(?=[\p{P}\p{S}])|(?!~)[\p{P}\p{S}](~~?)(?!~)(?=[\p{P}\p{S}])|[^\s\p{P}\p{S}](~~?)(?=[^\s\p{P}\p{S}])/gu,
  autolink: /^<([a-zA-Z][a-zA-Z0-9+.-]{1,31}:[^\s\x00-\x1f<>]*|[a-zA-Z0-9.!#$%&'*+/=?_`{|}~-]+(@)[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(?:\.[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)+(?![-_]))>/,
  url: /^(?:mailto:[A-Za-z0-9._+-]+@[a-zA-Z0-9-_]+(?:\.[a-zA-Z0-9-_]*[a-zA-Z0-9])+(?![\w-])|xmpp:[A-Za-z0-9._+-]+@[a-zA-Z0-9-_]+(?:\.[a-zA-Z0-9-_]*[a-zA-Z0-9])+(?![\w-])(?:\/[A-Za-z0-9@.]+)?)|^((?:[hH][tT][tT][pP][sS]?|[fF][tT][pP]):\/\/|www\.)(?:[a-zA-Z0-9\-]+\.?)+[^\s<]*|^[A-Za-z0-9._+-]+(@)[a-zA-Z0-9-_]+(?:\.[a-zA-Z0-9-_]*[a-zA-Z0-9])+(?![\w-])/,
  text: /^(?:[^a-zA-Z0-9](?=(?:mailto|xmpp):)|(`+|~+|[^`~])(?:(?=[`~])|(?= {2,}\n)|(?=[a-zA-Z0-9.!#$%&'*+\/=?_`{\|}~-]+@)|[\s\S]*?(?:(?=[\\<!\[`*~_]|\b_|[hH][tT][tT][pP][sS]?|[fF][tT][pP]:\/\/|(?<![^\s*_~(])www\.|$)|[^ ](?= {2,}\n)|[^a-zA-Z0-9](?=(?:mailto|xmpp):)|[^a-zA-Z0-9.!#$%&'*+\/=?_`{\|}~-](?=[a-zA-Z0-9.!#$%&'*+\/=?_`{\|}~-]+@))))/,
  punctuation: /^((?![*_])[\s\p{P}\p{S}])/u,
  blockSkip: /\[(?:[^\[\]`]|(?<a>`+)[^`]+\k<a>(?!`))*?\]\((?:\\[\s\S]|[^\\\(\)]|\((?:\\[\s\S]|[^\\\(\)])*\))*\)|(?<!`)()(?<b>`+)[^`]+\k<b>(?!`)|<(?! )[^<>]*?>/g,
  reflinkSearch: REFLINK_SEARCH,
  anyPunctuation: /\\([\p{P}\p{S}])/gu,
  anyPunctuationOutsideCode: /(`+)(?:[^`]|[^`][\s\S]*?[^`])\1(?!`)|`+|\\([\p{P}\p{S}])/gu,
  _backpedal: /(?:[^?!.,:;*_'"~()&]+|\([^)]*\)|&(?![a-zA-Z0-9]+;$)|[?!.,:;*_'"~)]+(?!$))+/
};

// Sticky twins for the cursor-driven inline loop.
const INLINE_S = {};
for (const k of ['escape', 'tag', 'link', 'reflink', 'nolink', 'emStrongLDelim', 'codespan', 'br', 'delLDelim', 'autolink', 'url', 'text']) {
  INLINE_S[k] = stickyOf(INLINE[k]);
}



// ---- Other (non-grammar) patterns ----

const OTHER = {
  codeRemoveIndent: /^(?: {0,3}\t| {1,4})/gm,
  outputLinkReplace: /\\([\[\]])/g,
  indentCodeCompensation: /^(\s+)(?:```)/,
  beginningSpace: /^\s+/,
  endingHash: /#$/,
  startingSpaceChar: /^ /,
  endingSpaceChar: / $/,
  endingSpaceTabChar: /[ \t]$/,
  nonSpaceChar: /[^ ]/,
  newLineCharGlobal: /\n/g,
  tabCharGlobal: /\t/g,
  leadingSpaceTab: /^[ \t]+/,
  multipleSpaceGlobal: /\s+/g,
  blankLine: /^[ \t]*$/,
  doubleBlankLine: /\n[ \t]*\n[ \t]*$/,
  blockquoteStart: /^ {0,3}>/,
  blockquoteSetextReplace: /\n {0,3}((?:=+|-+)[ \t]*)(?=\n|$)/g,
  blockquoteSetextReplace2: /^ {0,3}>[ \t]?/gm,
  blockquoteMarkerWhitespace: /^( {0,3}>)([ \t]+)/gm,
  listReplaceNesting: /^ {1,4}(?=( {4})*[^ ])/g,
  listIsTask: /^\[[ xX]\][ \t]+\S/,
  listReplaceTask: /^\[[ xX]\][ \t]+/,
  listTaskCheckbox: /\[[ xX]\]/,
  anyLine: /\n.*\n/,
  hrefBrackets: /^<(.*)>$/,
  tableDelimiter: /[:|]/,
  tableAlignChars: /^\||\| *$/g,
  tableRowBlankLine: /\n[ \t]*$/,
  tableAlignRight: /^ *-+: *$/,
  tableAlignCenter: /^ *:-+: *$/,
  tableAlignLeft: /^ *:-+ *$/,
  startATag: /^<a /i,
  endATag: /^<\/a>/i,
  startPreScriptTag: /^<(pre|code|kbd|script)(\s|>)/i,
  endPreScriptTag: /^<\/(pre|code|kbd|script)(\s|>)/i,
  startAngleBracket: /^</,
  endAngleBracket: />$/,
  unicodeAlphaNumeric: /[\p{L}\p{N}]/u,
  numericCharacterReference: /&#(?:(\d{1,7})|[Xx]([A-Fa-f0-9]{1,6}));/,
  numericCharacterReferenceOrAmpersand: /&#(?:(\d{1,7})|[Xx]([A-Fa-f0-9]{1,6}));|&(?!(#\d{1,7}|#[Xx][a-fA-F0-9]{1,6}|\w+);)/g,
  escapeTest: /[&<>"']/,
  escapeReplace: /[&<>"']/g,
  escapeTestNoEncode: /[<>"']|&(?!(#\d{1,7}|#[Xx][a-fA-F0-9]{1,6}|\w+);)/,
  escapeReplaceNoEncode: /[<>"']|&(?!(#\d{1,7}|#[Xx][a-fA-F0-9]{1,6}|\w+);)/g,
  percentDecode: /%25/g,
  findPipe: /\|/g,
  splitPipe: / \|/,
  slashPipe: /\\\|/g,
  carriageReturn: /\r\n|\r/g,
  notSpaceStart: /^\S*/,
  endingNewline: /\n$/
};

// ---- Small helpers ----

const ENTITY_MAP = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
const entityFor = ch => ENTITY_MAP[ch];

function escText(s, encode) {
  if (encode) {
    if (OTHER.escapeTest.test(s)) return s.replace(OTHER.escapeReplace, entityFor);
  } else if (OTHER.escapeTestNoEncode.test(s)) {
    return s.replace(OTHER.escapeReplaceNoEncode, entityFor);
  }
  return s;
}

function unescEnt(s) {
  if (!OTHER.numericCharacterReference.test(s)) return s;
  return s.replace(OTHER.numericCharacterReferenceOrAmpersand, (whole, dec, hex) => {
    if (dec === undefined && hex === undefined) return '&amp;';
    const code = dec === undefined ? parseInt(hex, 16) : parseInt(dec, 10);
    if (code === 0 || code > 1114111 || (code >= 55296 && code <= 57343)) return '\uFFFD';
    if (code === 38) return '&amp;';
    return String.fromCodePoint(code);
  });
}

function cleanHref(href) {
  try {
    href = encodeURI(href).replace(OTHER.percentDecode, '%');
  } catch {
    return null;
  }
  return href;
}

// Split a table row on unescaped pipes, honouring leading/trailing edge pipes.
function splitRow(row, count) {
  const t = row.replace(OTHER.findPipe, (ch, off, str) => {
    let escaped = false, p = off;
    for (; --p >= 0 && str[p] === '\\';) escaped = !escaped;
    return escaped ? '|' : ' |';
  });
  const cells = t.split(OTHER.splitPipe);
  let i = 0;
  if (cells[0].trim() || cells.shift(), cells.length > 0 && !cells.at(-1)?.trim() && cells.pop(), count) {
    if (cells.length > count) cells.splice(count);
    else for (; cells.length < count;) cells.push('');
  }
  for (; i < cells.length; i++) cells[i] = cells[i].trim().replace(OTHER.slashPipe, '|');
  return cells;
}

// Trim trailing characters: when `invert` is falsy, trim `ch`; else trim chars != `ch`.
function trimEndChars(s, ch, invert) {
  const n = s.length;
  if (n === 0) return '';
  let cut = 0;
  for (; cut < n;) {
    const c = s.charAt(n - cut - 1);
    if (c === ch && !invert) cut++;
    else if (c !== ch && invert) cut++;
    else break;
  }
  return s.slice(0, n - cut);
}

// Drop trailing blank lines, keeping at most one trailing blank line worth.
function trimBlankTail(s) {
  const lines = s.split('\n');
  let last = lines.length - 1;
  for (; last >= 0 && OTHER.blankLine.test(lines[last]);) last--;
  return lines.length - last <= 2 ? s : lines.slice(0, last + 1).join('\n');
}

// Normalise a link-reference label for lookup.
function normRef(s) {
  return s.trim().replace(OTHER.multipleSpaceGlobal, ' ').toLowerCase().toUpperCase().toLowerCase();
}

// Find the index of the closing bracket matching the opener at the start of
// the paren/bracket walk; -2 means unclosed, -1 means no bracket at all.
function closeBracket(s, pair) {
  if (s.indexOf(pair[0]) === -1 && s.indexOf(pair[1]) === -1) return -1;
  let depth = 0;
  for (let i = 0; i < s.length; i++) {
    if (s[i] === '\\') { i++; continue; }
    if (s[i] === pair[0]) depth++;
    else if (s[i] === pair[1] && (depth--, depth < 0)) return i;
  }
  return depth > 0 ? -2 : -1;
}

function expandTabs(s, start = 0) {
  let col = start, out = '';
  for (const ch of s) {
    if (ch === '\t') {
      const w = 4 - col % 4;
      out += ' '.repeat(w);
      col += w;
    } else {
      out += ch;
      col++;
    }
  }
  return out;
}

// Remove the fence indentation from a fenced code block's text.
function fencesIndent(raw, text) {
  const m = raw.match(OTHER.indentCodeCompensation);
  if (m === null) return text;
  const width = m[1];
  return text.split('\n').map(line => {
    const lead = line.match(OTHER.beginningSpace);
    if (lead === null) return line;
    return line.slice(Math.min(lead[0].length, width.length));
  }).join('\n');
}

// True when the link label itself contains a link (which forbids the link).
function linkInText(src, label, offset, rules) {
  if (!label.includes('<')) return false;
  for (let i = 0; i < label.length; i++) {
    if (label[i] === '\\') { i++; continue; }
    if (label[i] === '`') {
      const m = rules.inline.codespan.exec(label.slice(i));
      if (m) { i += m[0].length - 1; continue; }
    }
    if (label[i] !== '<') continue;
    const rest = src.slice(offset + i);
    const m = rules.inline.tag.exec(rest) || rules.inline.autolink.exec(rest);
    if (m) {
      if (m[0].length > label.length - i) return true;
      i += m[0].length - 1;
    }
  }
  return false;
}

// Build a link/image token from a matched link, lexing its text inline.
function buildLink(match, ref, raw, lexer) {
  const href = ref.href;
  const title = ref.title || null;
  const text = match[1].replace(OTHER.outputLinkReplace, '$1');
  const isImage = match[0].charAt(0) === '!';
  const wasInLink = lexer.state.inLink;
  const wasEmitted = lexer.state.linkEmitted;
  const wasRawBlock = lexer.state.inRawBlock;
  lexer.state.inLink = true;
  lexer.state.linkEmitted = false;
  const tokens = lexer.inlineTokens(text);
  const emittedInside = lexer.state.linkEmitted;
  lexer.state.linkEmitted = wasEmitted;
  lexer.state.inLink = wasInLink;
  if (!isImage) {
    if (emittedInside) {
      lexer.state.inRawBlock = wasRawBlock;
      return undefined;
    }
    lexer.state.linkEmitted = true;
  }
  return { type: isImage ? 'image' : 'link', raw, href, title, text, tokens };
}

// ---- Emphasis/delimiter masking ----
// Records, for a masked inline source, the last index where each delimiter
// run could still close an emphasis or strikethrough span.

function maskDelimiters(src) {
  const closer = { '*': -1, _: -1 };
  let delCloser = -1;
  const n = src.length;
  for (let i = 0; i < n; i++) {
    const ch = src[i];
    if (ch !== '*' && ch !== '_' && ch !== '~') continue;
    const prev = i === 0 ? '\n' : src[i - 1];
    let j = i + 1;
    for (; j < n && src[j] === ch;) j++;
    if (prev !== ' ' && prev !== '\t' && prev !== '\n' && prev !== '\r' && prev !== '\f') {
      if (ch === '~') delCloser = i;
      else closer[ch] = i;
    }
    i = j - 1;
  }
  return { maskedSrc: src, lastPossibleEmStrongCloserIndex: closer, lastPossibleDelCloserIndex: delCloser };
}

function maskLastEmStrong(lexer, masked, delim) {
  return lexer.getDelimiters(masked).lastPossibleEmStrongCloserIndex[delim];
}

function maskLastDel(lexer, masked) {
  return lexer.getDelimiters(masked).lastPossibleDelCloserIndex;
}


// ---- Tokenizer (block level) ----
// Block methods take the full source plus a cursor position and return a
// token (or null). Simple rules run as sticky matches at the cursor; the
// two recursive rules (blockquote, list) work on the remaining slice.

// Set of characters/sequences that force the full inline tokenizer.
// Anything else is plain text: a single text token, no masking, no scan.
const PLAIN_CHECK = /[\\<\[!*_`~@]|:\/\/|www\.|  \n/;

function at(re, src, pos) {
  re.lastIndex = pos;
  return re.exec(src);
}

class Tokenizer {
  constructor() {
    this.rules = { other: OTHER, block: BLOCK, inline: INLINE };
    this.lexer = null;
  }

  space(src, pos) {
    const m = at(BLOCK_S.newline, src, pos);
    if (m && m[0].length > 0) return { type: 'space', raw: m[0] };
    return null;
  }

  code(src, pos) {
    const m = at(BLOCK_S.code, src, pos);
    if (!m) return null;
    const raw = trimBlankTail(m[0]);
    return { type: 'code', raw, codeBlockStyle: 'indented', text: raw.replace(OTHER.codeRemoveIndent, '') };
  }

  fences(src, pos) {
    const m = at(BLOCK_S.fences, src, pos);
    if (!m) return null;
    const raw = m[0];
    return {
      type: 'code',
      raw,
      lang: m[2] ? m[2].trim().replace(INLINE.anyPunctuation, '$1') : m[2],
      text: fencesIndent(raw, m[3] || '')
    };
  }

  heading(src, pos) {
    const m = at(BLOCK_S.heading, src, pos);
    if (!m) return null;
    let text = m[2].trim();
    if (OTHER.endingHash.test(text)) {
      const stripped = trimEndChars(text, '#');
      if (!stripped || OTHER.endingSpaceTabChar.test(stripped)) text = stripped.trim();
    }
    return { type: 'heading', raw: trimEndChars(m[0], '\n'), depth: m[1].length, text, tokens: this.lexer.inline(text) };
  }

  hr(src, pos) {
    const m = at(BLOCK_S.hr, src, pos);
    if (!m) return null;
    return { type: 'hr', raw: trimEndChars(m[0], '\n') };
  }

  blockquote(src, pos = 0) {
    const rest = src.slice(pos);
    const m = BLOCK.blockquote.exec(rest);
    if (!m) return null;
    const lines = trimEndChars(m[0], '\n').split('\n');
    let raw = '';
    let text = '';
    const tokens = [];
    for (; lines.length > 0;) {
      let started = false;
      const chunk = [];
      let p = 0;
      for (; p < lines.length; p++) {
        if (OTHER.blockquoteStart.test(lines[p])) { chunk.push(lines[p]); started = true; }
        else if (!started) chunk.push(lines[p]);
        else break;
      }
      lines.splice(0, p);
      const joined = chunk.join('\n');
      const stripped = joined
        .replace(OTHER.blockquoteMarkerWhitespace, (whole, mark, ws) => mark + expandTabs(ws, mark.length))
        .replace(OTHER.blockquoteSetextReplace, '\n    $1')
        .replace(OTHER.blockquoteSetextReplace2, '');
      raw = raw ? `${raw}\n${joined}` : joined;
      text = text ? `${text}\n${stripped}` : stripped;
      const savedTop = this.lexer.state.top;
      this.lexer.state.top = true;
      this.lexer.blockTokens(stripped, tokens, true);
      this.lexer.state.top = savedTop;
      if (lines.length === 0) break;
      const last = tokens.at(-1);
      if (last?.type === 'code' || last?.type === 'heading' || last?.type === 'hr' || last?.type === 'html' || last?.type === 'table') break;
      if (last?.type === 'blockquote') {
        const inner = last;
        const restText = lines.join('\n');
        const again = inner.raw + '\n' + restText.replace(OTHER.blockquoteSetextReplace2, '');
        const nested = this.blockquote(again);
        tokens[tokens.length - 1] = nested;
        const leftover = again.substring(nested.raw.length).replace(/^\n/, '');
        const extraLines = leftover ? leftover.split('\n').length : 0;
        const consumed = extraLines ? lines.slice(0, -extraLines) : lines;
        if (consumed.length > 0) raw = `${raw}\n${consumed.join('\n')}`;
        text = text.substring(0, text.length - inner.text.length) + nested.text;
        lines.splice(0, consumed.length);
        if (lines.length > 0 && OTHER.blockquoteStart.test(lines[0])) continue;
        break;
      } else if (last?.type === 'list') {
        const inner = last;
        const combined = inner.raw + '\n' + lines.join('\n');
        const relisted = this.list(combined);
        tokens[tokens.length - 1] = relisted;
        const extra = relisted.raw.length > inner.raw.length
          ? combined.slice(inner.raw.length + 1, relisted.raw.length).split('\n').length
          : 0;
        if (extra > 0) {
          const taken = lines.slice(0, extra).join('\n');
          raw = `${raw}\n${taken}`;
          text = `${text}\n${taken}`;
        }
        lines.splice(0, extra);
        continue;
      }
    }
    return { type: 'blockquote', raw, tokens, text };
  }

  list(src, pos = 0) {
    let e = src.slice(pos);
    const m0 = BLOCK.list.exec(e);
    if (!m0) return null;
    const whole = e;
    const used = () => whole.length - e.length;
    let bullet = m0[1].trim();
    const ordered = bullet.length > 1;
    const listTok = { type: 'list', raw: '', ordered, start: ordered ? +bullet.slice(0, -1) : '', loose: false, items: [] };
    bullet = ordered ? `\\d{1,9}\\${bullet.slice(-1)}` : `\\${bullet}`;
    const itemRe = listItemRe(bullet);
    let pendingLoose = false;
    for (; e;) {
      let blankItem = false;
      let itemText = '';
      const m = itemRe.exec(e);
      if (!m || BLOCK.hr.test(e)) break;
      const startAt = used();
      e = e.substring(m[0].length);
      const firstLine = m[2].split('\n', 1)[0];
      const bulletLen = m[1].length;
      let content = firstLine.replace(OTHER.leadingSpaceTab, v => expandTabs(v, bulletLen));
      const nextLine = e.split('\n', 1)[0];
      let isBlank = !content.trim();
      let indent = 0;
      if (isBlank) {
        indent = bulletLen + 1;
      } else {
        indent = content.search(OTHER.nonSpaceChar);
        indent = indent > 4 ? 1 : indent;
        itemText = content.slice(indent);
        indent += bulletLen;
      }
      if (isBlank && OTHER.blankLine.test(nextLine)) {
        e = e.substring(nextLine.length + 1);
        blankItem = true;
      }
      if (!blankItem) {
        const break6 = listBreak6Re(indent);
        const break4 = listBreak4Re(indent);
        for (; e;) {
          const line = e.split('\n', 1)[0];
          let expanded;
          if (expanded = line.replace(OTHER.leadingSpaceTab, v => expandTabs(v)),
            break6.test(line)) break;
          if (expanded.search(OTHER.nonSpaceChar) >= indent || !line.trim()) {
            itemText += '\n' + expanded.slice(indent);
          } else {
            if (isBlank || content.replace(OTHER.tabCharGlobal, '    ').search(OTHER.nonSpaceChar) >= 4 ||
              break4.test(content)) break;
            const asSetext = /^ {0,3}(?:=+|-+) *$/.test(line) && BLOCK.lheading.test(`${content}\n${line}`)
              ? `    ${expanded.replace(/^ {0,3}/, '')}`
              : line;
            itemText += '\n' + asSetext;
          }
          const wasBlank = !line.trim();
          e = e.substring(line.length + 1);
          content = expanded.slice(indent);
          isBlank = wasBlank;
        }
      }
      const itemRaw = whole.slice(startAt, used());
      if (!listTok.loose) {
        if (pendingLoose) listTok.loose = true;
        else if (OTHER.doubleBlankLine.test(itemRaw)) pendingLoose = true;
      }
      listTok.items.push({
        type: 'list_item',
        raw: itemRaw,
        task: !!OTHER.listIsTask.test(itemText),
        loose: false,
        text: itemText,
        tokens: []
      });
    }
    const lastItem = listTok.items.at(-1);
    if (!lastItem) return null;
    lastItem.raw = lastItem.raw.trimEnd();
    lastItem.text = lastItem.text.trimEnd();
    listTok.raw = whole.slice(0, used()).trimEnd();
    for (const item of listTok.items) {
      this.lexer.state.top = false;
      item.tokens = this.lexer.blockTokens(item.text, []);
      if (!listTok.loose) {
        const spaces = item.tokens.filter(t => t.type === 'space');
        if (spaces.length > 0 && spaces.some(t => OTHER.anyLine.test(t.raw))) listTok.loose = true;
      }
    }
    for (const item of listTok.items) {
      const first = item.tokens[0];
      if (item.task && (first?.type === 'text' || first?.type === 'paragraph')) {
        item.text = item.text.replace(OTHER.listReplaceTask, '');
        first.raw = first.raw.replace(OTHER.listReplaceTask, '');
        first.text = first.text.replace(OTHER.listReplaceTask, '');
        for (let g = this.lexer.inlineQueue.length - 1; g >= 0; g--) {
          if (OTHER.listIsTask.test(this.lexer.inlineQueue[g].src)) {
            this.lexer.inlineQueue[g].src = this.lexer.inlineQueue[g].src.replace(OTHER.listReplaceTask, '');
            break;
          }
        }
        const box = OTHER.listTaskCheckbox.exec(item.raw);
        if (box) {
          const check = { type: 'checkbox', raw: box[0] + ' ', checked: box[0] !== '[ ]' };
          item.checked = check.checked;
          if (listTok.loose) {
            if (listTok.items[0] && ['paragraph', 'text'].includes(item.tokens[0]?.type) && 'tokens' in item.tokens[0] && item.tokens[0].tokens) {
              item.tokens[0].raw = check.raw + item.tokens[0].raw;
              item.tokens[0].text = check.raw + item.tokens[0].text;
              item.tokens[0].tokens.unshift(check);
            } else {
              item.tokens.unshift({ type: 'paragraph', raw: check.raw, text: check.raw, tokens: [check] });
            }
          } else {
            item.tokens.unshift(check);
          }
        }
      } else if (item.task) {
        item.task = false;
      }
    }
    if (listTok.loose) {
      for (const item of listTok.items) {
        item.loose = true;
        for (const t of item.tokens) if (t.type === 'text') t.type = 'paragraph';
      }
    }
    return listTok;
  }

  html(src, pos) {
    const m = at(BLOCK_S.html, src, pos);
    if (!m) return null;
    const raw = trimBlankTail(m[0]);
    return { type: 'html', block: true, raw, pre: m[1] === 'pre' || m[1] === 'script' || m[1] === 'style', text: raw };
  }

  def(src, pos) {
    const m = at(BLOCK_S.def, src, pos);
    if (!m) return null;
    if (!OTHER.startAngleBracket.test(m[2]) && closeBracket(m[2], '()') !== -1) return null;
    const href = m[2] ? m[2].replace(OTHER.hrefBrackets, '$1').replace(INLINE.anyPunctuation, '$1') : '';
    const title = m[3] ? m[3].substring(1, m[3].length - 1).replace(INLINE.anyPunctuation, '$1') : m[3];
    return { type: 'def', tag: normRef(m[1]), raw: trimEndChars(m[0], '\n'), href, title };
  }

  table(src, pos) {
    const m = at(BLOCK_S.table, src, pos);
    if (!m || !OTHER.tableDelimiter.test(m[2])) return null;
    const header = splitRow(m[1]);
    const aligns = m[2].replace(OTHER.tableAlignChars, '').split('|');
    const bodyLines = m[3]?.trim() ? m[3].replace(OTHER.tableRowBlankLine, '').split('\n') : [];
    const tok = { type: 'table', raw: trimEndChars(m[0], '\n'), header: [], align: [], rows: [] };
    if (header.length !== aligns.length) return null;
    for (const a of aligns) {
      if (OTHER.tableAlignRight.test(a)) tok.align.push('right');
      else if (OTHER.tableAlignCenter.test(a)) tok.align.push('center');
      else if (OTHER.tableAlignLeft.test(a)) tok.align.push('left');
      else tok.align.push(null);
    }
    for (let i = 0; i < header.length; i++) {
      tok.header.push({ text: header[i], tokens: this.lexer.inline(header[i]), header: true, align: tok.align[i] });
    }
    for (const line of bodyLines) {
      tok.rows.push(splitRow(line, tok.header.length).map((cell, p) => ({ text: cell, tokens: this.lexer.inline(cell), header: false, align: tok.align[p] })));
    }
    return tok;
  }

  lheading(src, pos) {
    const m = at(BLOCK_S.lheading, src, pos);
    if (!m) return null;
    const text = m[1].trim();
    return { type: 'heading', raw: trimEndChars(m[0], '\n'), depth: m[2].charAt(0) === '=' ? 1 : 2, text, tokens: this.lexer.inline(text) };
  }

  paragraph(src, pos) {
    const m = at(BLOCK_S.paragraph, src, pos);
    if (!m) return null;
    const text = m[1].charAt(m[1].length - 1) === '\n' ? m[1].slice(0, -1) : m[1];
    return { type: 'paragraph', raw: m[0], text, tokens: this.lexer.inline(text) };
  }

  text(src, pos) {
    const m = at(BLOCK_S.text, src, pos);
    if (!m) return null;
    return { type: 'text', raw: m[0], text: m[0], tokens: this.lexer.inline(m[0]) };
  }

  // ---- Inline level ----

  escape(src, pos) {
    const m = at(INLINE_S.escape, src, pos);
    if (!m) return null;
    return { type: 'escape', raw: m[0], text: m[1] };
  }

  tag(src, pos) {
    const m = at(INLINE_S.tag, src, pos);
    if (!m) return null;
    const st = this.lexer.state;
    if (!st.inLink && OTHER.startATag.test(m[0])) st.inLink = true;
    else if (st.inLink && OTHER.endATag.test(m[0])) st.inLink = false;
    if (!st.inRawBlock && OTHER.startPreScriptTag.test(m[0])) st.inRawBlock = true;
    else if (st.inRawBlock && OTHER.endPreScriptTag.test(m[0])) st.inRawBlock = false;
    return { type: 'html', raw: m[0], inLink: st.inLink, inRawBlock: st.inRawBlock, block: false, text: m[0] };
  }

  link(src, pos) {
    if (this.lexer.state.linkParenPossible === false) return null;
    const m = at(INLINE_S.link, src, pos);
    if (!m) return null;
    const bang = m[0].charAt(0) === '!' ? 2 : 1;
    if (linkInText(src.slice(pos), m[1], bang, this.rules)) return null;
    let href = m[2].trim();
    if (OTHER.startAngleBracket.test(href)) {
      if (!OTHER.endAngleBracket.test(href)) return null;
      const kept = trimEndChars(href.slice(0, -1), '\\');
      if ((href.length - kept.length) % 2 === 0) return null;
    } else {
      const close = closeBracket(m[2], '()');
      if (close === -2) return null;
      if (close > -1) {
        const cut = (m[0].indexOf('!') === 0 ? 5 : 4) + m[1].length + close;
        m[2] = m[2].substring(0, close);
        m[0] = m[0].substring(0, cut).trim();
        m[3] = '';
      }
    }
    const keptRaw = trimEndChars(m[0].slice(0, -1), '\\');
    if ((m[0].length - keptRaw.length) % 2 === 0) return null;
    let dest = m[2];
    const title = m[3] ? m[3].slice(1, -1) : '';
    dest = dest.trim();
    if (OTHER.startAngleBracket.test(dest)) dest = dest.slice(1, -1);
    return buildLink(m, {
      href: dest && dest.replace(INLINE.anyPunctuation, '$1'),
      title: title && title.replace(INLINE.anyPunctuation, '$1')
    }, m[0], this.lexer);
  }

  reflink(src, pos) {
    const m = at(INLINE_S.reflink, src, pos) || at(INLINE_S.nolink, src, pos);
    if (!m) return null;
    const bang = m[0].charAt(0) === '!' ? 2 : 1;
    if (linkInText(src.slice(pos), m[1], bang, this.rules)) return null;
    const ref = this.lexer.tokens.links[normRef(m[2] || m[1])];
    if (!ref) {
      const ch = m[0].charAt(0);
      return { type: 'text', raw: ch, text: ch };
    }
    return buildLink(m, ref, m[0], this.lexer);
  }

  emStrong(src, pos, prev) {
    const m0 = at(INLINE_S.emStrongLDelim, src, pos);
    if (!m0 || (!m0[1] && !m0[2] && !m0[3] && !m0[4])) return null;
    const delim = m0[0][0];
    const isSame = prev === delim;
    const offset = pos;
    let look = offset;
    const masked = this.lexer.getMasked();
    for (; look > 0 && masked[look - 1] === delim;) look--;
    const before = [...masked.slice(Math.max(0, look - 2), look)].at(-1) ?? '';
    const beforeIsDelim = before === '*' || before === '_' || !!INLINE.punctuation.exec(before);
    if (look < offset) prev = before;
    const prevIsPunct = look < offset ? beforeIsDelim : !!INLINE.punctuation.exec(prev);
    if (m0[4] && prev.match(OTHER.unicodeAlphaNumeric)) return null;
    const punct = m0[1] || m0[3] || '';
    if (!punct || !prev || prevIsPunct) {
      const openLen = [...m0[0]].length - 1;
      let runLen;
      let total = openLen;
      let extra = 0;
      const y = offset - look + openLen;
      const canOpen = !!before.trim() && (!!punct || (delim === '*' && !beforeIsDelim));
      if (delim !== '*' && delim !== '_') return null;
      const closerRe = delim === '*' ? INLINE.emStrongRDelimAst : INLINE.emStrongRDelimUnd;
      const lastCloser = maskLastEmStrong(this.lexer, masked, delim);
      const firstAfter = offset + openLen;
      if (lastCloser < firstAfter) return null;
      const scan = masked.slice(pos + openLen);
      const maxIndex = lastCloser - firstAfter;
      let m;
      for (closerRe.lastIndex = 0; (m = closerRe.exec(scan)) !== null && !(m.index > maxIndex);) {
        const g = m[1] || m[2] || m[3] || m[4] || m[5] || m[6];
        if (!g) continue;
        runLen = [...g].length;
        if (m[3] || m[4]) { total += runLen; continue; }
        if (m[5] || m[6] || canOpen) {
          if (isSame && (m[5] || m[6])) break;
          if (y % 3 && !((y + runLen) % 3)) { extra += runLen; continue; }
        }
        if (total -= runLen, total > 0) continue;
        runLen = Math.min(runLen, runLen + total + extra);
        const firstCharLen = [...m[0]][0].length;
        const raw = src.slice(pos, pos + openLen + m.index + firstCharLen + runLen);
        if (Math.min(openLen, runLen) % 2) {
          const inner = raw.slice(1, -1);
          return { type: 'em', raw, text: inner, tokens: this.lexer.inlineTokens(inner) };
        }
        const inner = raw.slice(2, -2);
        return { type: 'strong', raw, text: inner, tokens: this.lexer.inlineTokens(inner) };
      }
    }
    return null;
  }

  codespan(src, pos) {
    const m = at(INLINE_S.codespan, src, pos);
    if (!m) return null;
    let text = m[2].replace(OTHER.newLineCharGlobal, ' ');
    const hasNonSpace = OTHER.nonSpaceChar.test(text);
    const padded = OTHER.startingSpaceChar.test(text) && OTHER.endingSpaceChar.test(text);
    if (hasNonSpace && padded) text = text.substring(1, text.length - 1);
    return { type: 'codespan', raw: m[0], text };
  }

  br(src, pos) {
    const m = at(INLINE_S.br, src, pos);
    if (!m) return null;
    return { type: 'br', raw: m[0] };
  }

  del(src, pos, prev) {
    const m0 = at(INLINE_S.delLDelim, src, pos);
    if (!m0) return null;
    if (!(m0[1] || '') || !prev || INLINE.punctuation.exec(prev)) {
      const openLen = [...m0[0]].length - 1;
      let pending = openLen;
      const masked = this.lexer.getMasked();
      const lastCloser = maskLastDel(this.lexer, masked);
      const firstAfter = pos + openLen;
      if (lastCloser < firstAfter) return null;
      const scan = masked.slice(pos + openLen);
      const maxIndex = lastCloser - firstAfter;
      let m;
      for (INLINE.delRDelim.lastIndex = 0; (m = INLINE.delRDelim.exec(scan)) !== null && !(m.index > maxIndex);) {
        const g = m[1] || m[2] || m[3] || m[4] || m[5] || m[6];
        if (!g) continue;
        let runLen = [...g].length;
        if (runLen !== openLen) continue;
        if (m[3] || m[4]) { pending += runLen; continue; }
        if (pending -= runLen, pending > 0) continue;
        runLen = Math.min(runLen, runLen + pending);
        const firstCharLen = [...m[0]][0].length;
        const raw = src.slice(pos, pos + openLen + m.index + firstCharLen + runLen);
        const inner = raw.slice(openLen, -openLen);
        return { type: 'del', raw, text: inner, tokens: this.lexer.inlineTokens(inner) };
      }
    }
    return null;
  }

  autolink(src, pos) {
    const m = at(INLINE_S.autolink, src, pos);
    if (!m) return null;
    let text;
    let href;
    if (m[2] === '@') {
      text = m[1];
      href = 'mailto:' + text;
    } else {
      text = m[1];
      href = text;
    }
    return { type: 'link', raw: m[0], text, href, autolink: true, tokens: [{ type: 'text', raw: text, text }] };
  }

  url(src, pos) {
    const m = at(INLINE_S.url, src, pos);
    if (!m) return null;
    let text;
    let href;
    if (m[2] === '@') {
      text = m[0];
      href = 'mailto:' + text;
    } else {
      let prev;
      do {
        prev = m[0];
        m[0] = INLINE._backpedal.exec(m[0])?.[0] ?? '';
      } while (prev !== m[0]);
      text = m[0];
      href = m[1] === 'www.' ? 'http://' + m[0] : m[0];
    }
    return { type: 'link', raw: m[0], text, href, autolink: true, tokens: [{ type: 'text', raw: text, text }] };
  }

  inlineText(src, pos) {
    const m = at(INLINE_S.text, src, pos);
    if (!m) return null;
    const inRaw = this.lexer.state.inRawBlock;
    return { type: 'text', raw: m[0], text: inRaw ? m[0] : unescEnt(m[0]), escaped: inRaw };
  }
}




// ---- Lexer ----

class Lexer {
  constructor() {
    this.tokens = [];
    this.tokens.links = Object.create(null);
    this.tokenizer = new Tokenizer();
    this.tokenizer.lexer = this;
    this.inlineQueue = [];
    this.state = { inLink: false, inRawBlock: false, linkEmitted: false, linkParenPossible: true, top: true };
    this.maskStack = [];
  }

  lex(src) {
    src = src.replace(OTHER.carriageReturn, '\n');
    this.blockTokens(src, this.tokens);
    for (let i = 0; i < this.inlineQueue.length; i++) {
      const entry = this.inlineQueue[i];
      this.state.inRawBlock = false;
      this.inlineTokens(entry.src, entry.tokens);
    }
    this.inlineQueue = [];
    return this.tokens;
  }

  blockTokens(src, tokens, nested = false) {
    this.tokenizer.lexer = this;
    const T = this.tokenizer;
    const n = src.length;
    let pos = 0;
    let prevLen = Infinity;
    while (pos < n) {
      const remaining = n - pos;
      if (remaining >= prevLen) { this.infiniteLoopError(src.charCodeAt(pos)); break; }
      prevLen = remaining;
      let tok;
      if (tok = T.space(src, pos)) {
        pos += tok.raw.length;
        const prev = tokens.at(-1);
        if (tok.raw.length === 1 && prev !== undefined) prev.raw += '\n';
        else tokens.push(tok);
        continue;
      }
      if (tok = T.code(src, pos)) {
        pos += tok.raw.length;
        const prev = tokens.at(-1);
        if (prev?.type === 'paragraph' || prev?.type === 'text') {
          prev.raw += (prev.raw.endsWith('\n') ? '' : '\n') + tok.raw;
          prev.text += '\n' + tok.text;
          this.inlineQueue.at(-1).src = prev.text;
        } else tokens.push(tok);
        continue;
      }
      if (tok = T.fences(src, pos)) { pos += tok.raw.length; tokens.push(tok); continue; }
      if (tok = T.heading(src, pos)) { pos += tok.raw.length; tokens.push(tok); continue; }
      if (tok = T.hr(src, pos)) { pos += tok.raw.length; tokens.push(tok); continue; }
      if (tok = T.blockquote(src, pos)) { pos += tok.raw.length; tokens.push(tok); continue; }
      if (tok = T.list(src, pos)) { pos += tok.raw.length; tokens.push(tok); continue; }
      if (tok = T.html(src, pos)) { pos += tok.raw.length; tokens.push(tok); continue; }
      if (tok = T.def(src, pos)) {
        pos += tok.raw.length;
        const prev = tokens.at(-1);
        if (prev?.type === 'paragraph' || prev?.type === 'text') {
          prev.raw += (prev.raw.endsWith('\n') ? '' : '\n') + tok.raw;
          prev.text += '\n' + tok.raw;
          this.inlineQueue.at(-1).src = prev.text;
        } else {
          this.tokens.links[tok.tag] || (this.tokens.links[tok.tag] = { href: tok.href, title: tok.title });
          tokens.push(tok);
        }
        continue;
      }
      if (tok = T.table(src, pos)) { pos += tok.raw.length; tokens.push(tok); continue; }
      if (tok = T.lheading(src, pos)) { pos += tok.raw.length; tokens.push(tok); continue; }
      if (this.state.top && (tok = T.paragraph(src, pos))) {
        pos += tok.raw.length;
        const prev = tokens.at(-1);
        if (nested && prev?.type === 'paragraph') {
          prev.raw += (prev.raw.endsWith('\n') ? '' : '\n') + tok.raw;
          prev.text += '\n' + tok.text;
          this.inlineQueue.pop();
          this.inlineQueue.at(-1).src = prev.text;
        } else tokens.push(tok);
        nested = false;
        continue;
      }
      if (tok = T.text(src, pos)) {
        pos += tok.raw.length;
        const prev = tokens.at(-1);
        if (prev?.type === 'text') {
          prev.raw += (prev.raw.endsWith('\n') ? '' : '\n') + tok.raw;
          prev.text += '\n' + tok.text;
          this.inlineQueue.pop();
          this.inlineQueue.at(-1).src = prev.text;
        } else tokens.push(tok);
        continue;
      }
      if (pos < n) { this.infiniteLoopError(src.charCodeAt(pos)); break; }
    }
    this.state.top = true;
    return tokens;
  }

  inline(src) {
    this.inlineQueue.push({ src, tokens: [] });
    return this.inlineQueue[this.inlineQueue.length - 1].tokens;
  }

  linkInText(src) {
    if (!src.includes('[')) return false;
    for (const m of src.matchAll(INLINE.blockSkip)) {
      if (INLINE.link.test(m[0]) && src.charAt(m.index - 1) !== '!') return true;
    }
    for (const m of src.matchAll(INLINE.reflinkSearch)) {
      const whole = m[0];
      const open = whole.lastIndexOf('[');
      if (!(whole.charAt(0) === '!' || !Object.hasOwn(this.tokens.links, normRef(whole.slice(open + 1, -1)))) &&
        !(open > 1 && this.linkInText(whole.slice(1, open - 1)))) return true;
    }
    return false;
  }

  inlineTokens(src, tokens = []) {
    this.tokenizer.lexer = this;
    // Plain-text fast path: no inline construct can start in this string,
    // so the whole thing is one text token. (The check also rules out
    // autolinked URLs/emails and hard breaks from two spaces + newline.)
    if (!PLAIN_CHECK.test(src)) {
      const inRaw = this.state.inRawBlock;
      tokens.push({ type: 'text', raw: src, text: inRaw ? src : unescEnt(src), escaped: inRaw });
      return tokens;
    }
    const saved = this.state.linkParenPossible;
    this.state.linkParenPossible = saved && src.includes(')');
    try {
      return this.inlineLoop(src, tokens);
    } finally {
      this.state.linkParenPossible = saved;
    }
  }

  inlineLoop(src, tokens) {
    // The masked source and its delimiter index are computed lazily, only
    // when an emphasis/strikethrough opener is actually attempted; most
    // inline strings never need them.
    this.maskStack.push({ src, masked: null, delimiters: null });
    try {
      return this.inlineScan(src, tokens);
    } finally {
      this.maskStack.pop();
    }
  }

  // Masked inline source for the current inlineTokens call (computed once).
  getMasked() {
    const ctx = this.maskStack.at(-1);
    if (ctx.masked === null) ctx.masked = this.mask(ctx.src);
    return ctx.masked;
  }

  getDelimiters(masked) {
    const ctx = this.maskStack.at(-1);
    if (ctx.delimiters === null) ctx.delimiters = maskDelimiters(masked);
    return ctx.delimiters;
  }

  // Produce the masked inline source used for emphasis/delimiter scanning:
  // link-like spans and code spans are neutralised so their delimiters
  // cannot open or close emphasis. Each replacement is skipped outright
  // when the characters it could match are absent.
  mask(src) {
    let out = src;
    if (this.tokens.links && src.includes('[')) {
      const search = INLINE.reflinkSearch;
      const replaceOne = whole => {
        const open = whole.lastIndexOf('[');
        if (!Object.hasOwn(this.tokens.links, normRef(whole.slice(open + 1, -1)))) return whole;
        if (open > 1 && whole.charAt(0) !== '!') {
          const inner = whole.slice(1, open - 1);
          if (this.linkInText(inner)) return '[' + inner.replace(search, replaceOne) + '][' + 'a'.repeat(whole.length - open - 2) + ']';
        }
        return '[' + 'a'.repeat(whole.length - 2) + ']';
      };
      out = out.replace(search, replaceOne);
    }
    if (src.includes('`') || src.includes('\\')) {
      out = out.replace(INLINE.anyPunctuationOutsideCode, (whole, ticks, punct) => {
        if (punct) return '+'.repeat(whole.length);
        if (ticks) return ticks + whole.slice(ticks.length, -ticks.length).replace(/`/g, '+') + ticks;
        return whole;
      });
    }
    if (src.includes('[') || src.includes('`') || src.includes('<')) {
      out = out.replace(INLINE.blockSkip, (whole, ticks, empty) => {
        const lead = empty ? empty.length : 0;
        return whole.slice(0, lead) + '[' + 'a'.repeat(whole.length - lead - 2) + ']';
      });
    }
    return out;
  }

  inlineScan(src, tokens) {
    const T = this.tokenizer;
    const n = src.length;
    let pos = 0;
    let prevLen = Infinity;
    let prevWasText = false;
    let prevChar = '';
    while (pos < n) {
      const remaining = n - pos;
      if (remaining >= prevLen) { this.infiniteLoopError(src.charCodeAt(pos)); break; }
      prevLen = remaining;
      if (!prevWasText) prevChar = '';
      prevWasText = false;
      // Dispatch on the first character: only the tokenizers whose
      // pattern can start with this character are tried, in marked's
      // order. Anything else falls through to plain text.
      const ch = src[pos];
      let tok = null;
      if (ch === '\\') {
        tok = T.escape(src, pos) || T.br(src, pos);
      } else if (ch === '<') {
        tok = T.tag(src, pos) || T.autolink(src, pos);
      } else if (ch === '[' || ch === '!') {
        tok = T.link(src, pos) || T.reflink(src, pos);
      } else if (ch === '*' || ch === '_') {
        tok = T.emStrong(src, pos, prevChar);
      } else if (ch === '`') {
        tok = T.codespan(src, pos);
      } else if (ch === '~') {
        tok = T.del(src, pos, prevChar);
      } else if (ch === ' ') {
        tok = T.br(src, pos);
      } else if (!this.state.inLink && ((ch >= 'a' && ch <= 'z') || (ch >= 'A' && ch <= 'Z') || (ch >= '0' && ch <= '9') || ch === '.' || ch === '_' || ch === '+' || ch === '-')) {
        tok = T.url(src, pos);
      }
      if (tok) {
        pos += tok.raw.length;
        const prev = tokens.at(-1);
        if (tok.type === 'text' && prev?.type === 'text') { prev.raw += tok.raw; prev.text += tok.text; }
        else tokens.push(tok);
        continue;
      }
      if (tok = T.inlineText(src, pos)) {
        pos += tok.raw.length;
        if (tok.raw.slice(-1) !== '_') prevChar = tok.raw.slice(-1);
        prevWasText = true;
        const prev = tokens.at(-1);
        if (prev?.type === 'text') { prev.raw += tok.raw; prev.text += tok.text; }
        else tokens.push(tok);
        continue;
      }
      if (pos < n) { this.infiniteLoopError(src.charCodeAt(pos)); break; }
    }
    return tokens;
  }

  infiniteLoopError(byte) {
    throw new Error('Infinite loop on byte: ' + byte);
  }
}


// ---- Renderer ----

class Renderer {
  constructor() {
    this.parser = null;
  }

  space() { return ''; }

  code({ text, lang, escaped }) {
    const first = (lang || '').match(OTHER.notSpaceStart)?.[0];
    const body = text ? text.replace(OTHER.endingNewline, '') + '\n' : '';
    const inner = escaped ? body : escText(body, true);
    return first
      ? '<pre><code class="language-' + escText(first) + '">' + inner + '</code></pre>\n'
      : '<pre><code>' + inner + '</code></pre>\n';
  }

  blockquote({ tokens }) {
    return `<blockquote>\n${this.parser.parse(tokens)}</blockquote>\n`;
  }

  html({ text }) { return text; }

  def() { return ''; }

  heading({ tokens, depth }) {
    return `<h${depth}>${this.parser.parseInline(tokens)}</h${depth}>\n`;
  }

  hr() { return '<hr>\n'; }

  list({ ordered, start, items }) {
    let body = '';
    for (const item of items) body += this.listitem(item);
    const tag = ordered ? 'ol' : 'ul';
    const startAttr = ordered && start !== 1 ? ' start="' + start + '"' : '';
    return '<' + tag + startAttr + '>\n' + body + '</' + tag + '>\n';
  }

  listitem(token) {
    return `<li>${this.parser.parse(token.tokens)}</li>\n`;
  }

  checkbox({ checked }) {
    return '<input ' + (checked ? 'checked="" ' : '') + 'disabled="" type="checkbox"> ';
  }

  paragraph({ tokens }) {
    return `<p>${this.parser.parseInline(tokens)}</p>\n`;
  }

  table(token) {
    let headCells = '';
    for (const cell of token.header) headCells += this.tablecell(cell);
    const headRow = this.tablerow({ text: headCells });
    let body = '';
    for (const row of token.rows) {
      let cells = '';
      for (const cell of row) cells += this.tablecell(cell);
      body += this.tablerow({ text: cells });
    }
    if (body) body = `<tbody>${body}</tbody>`;
    return `<table>\n<thead>\n` + headRow + `</thead>\n` + body + `</table>\n`;
  }

  tablerow({ text }) {
    return `<tr>\n${text}</tr>\n`;
  }

  tablecell(token) {
    const inner = this.parser.parseInline(token.tokens);
    const tag = token.header ? 'th' : 'td';
    return (token.align ? `<${tag} align="${token.align}">` : `<${tag}>`) + inner + `</${tag}>\n`;
  }

  strong({ tokens }) {
    return `<strong>${this.parser.parseInline(tokens)}</strong>`;
  }

  em({ tokens }) {
    return `<em>${this.parser.parseInline(tokens)}</em>`;
  }

  codespan({ text }) {
    return `<code>${escText(text, true)}</code>`;
  }

  br() { return '<br>'; }

  del({ tokens }) {
    return `<del>${this.parser.parseInline(tokens)}</del>`;
  }

  link({ href, title, text, tokens, autolink }) {
    const inner = autolink ? escText(text, true) : this.parser.parseInline(tokens);
    const cleaned = cleanHref(href);
    if (cleaned === null) return inner;
    const safeHref = escText(cleaned, autolink);
    let out = '<a href="' + safeHref + '"';
    if (title) out += ' title="' + escText(title) + '"';
    return out + '>' + inner + '</a>';
  }

  image({ href, title, text, tokens }) {
    if (tokens) text = this.parser.parseInline(tokens, this.parser.textRenderer);
    const cleaned = cleanHref(href);
    if (cleaned === null) return escText(text);
    const safeHref = escText(cleaned);
    let out = `<img src="${safeHref}" alt="${escText(text)}"`;
    if (title) out += ` title="${escText(title)}"`;
    return out + '>';
  }

  text(token) {
    if ('tokens' in token && token.tokens) return this.parser.parseInline(token.tokens);
    if ('escaped' in token && token.escaped) return token.text;
    return escText(token.text);
  }
}

// Plain-text renderer used for image alt text: inline markup is flattened.
class TextRenderer {
  constructor() {
    this.parser = null;
  }

  strong({ text, tokens }) {
    return tokens ? this.parser.parseInline(tokens, this) : text;
  }

  em({ text, tokens }) {
    return tokens ? this.parser.parseInline(tokens, this) : text;
  }

  codespan({ text }) { return text; }

  del({ text, tokens }) {
    return tokens ? this.parser.parseInline(tokens, this) : text;
  }

  html({ text }) { return text; }

  text({ text }) { return text; }

  link({ text, tokens }) {
    return tokens ? this.parser.parseInline(tokens, this) : text;
  }

  image({ text, tokens }) {
    return tokens ? this.parser.parseInline(tokens, this) : text;
  }

  br() { return ''; }

  checkbox({ raw }) { return raw; }
}

// ---- Parser ----

class Parser {
  constructor() {
    this.renderer = new Renderer();
    this.renderer.parser = this;
    this.textRenderer = new TextRenderer();
    this.textRenderer.parser = this;
  }

  parse(tokens) {
    let out = '';
    for (const token of tokens) {
      switch (token.type) {
        case 'space': out += this.renderer.space(token); break;
        case 'hr': out += this.renderer.hr(token); break;
        case 'heading': out += this.renderer.heading(token); break;
        case 'code': out += this.renderer.code(token); break;
        case 'table': out += this.renderer.table(token); break;
        case 'blockquote': out += this.renderer.blockquote(token); break;
        case 'list': out += this.renderer.list(token); break;
        case 'checkbox': out += this.renderer.checkbox(token); break;
        case 'html': out += this.renderer.html(token); break;
        case 'def': out += this.renderer.def(token); break;
        case 'paragraph': out += this.renderer.paragraph(token); break;
        case 'text': out += this.renderer.text(token); break;
        default: throw new Error('Token with "' + token.type + '" type was not found.');
      }
    }
    return out;
  }

  parseInline(tokens, renderer = this.renderer) {
    let out = '';
    for (const token of tokens) {
      switch (token.type) {
        case 'escape': out += renderer.text(token); break;
        case 'html': out += renderer.html(token); break;
        case 'link': out += renderer.link(token); break;
        case 'image': out += renderer.image(token); break;
        case 'checkbox': out += renderer.checkbox(token); break;
        case 'strong': out += renderer.strong(token); break;
        case 'em': out += renderer.em(token); break;
        case 'codespan': out += renderer.codespan(token); break;
        case 'br': out += renderer.br(token); break;
        case 'del': out += renderer.del(token); break;
        case 'text': out += renderer.text(token); break;
        default: throw new Error('Token with "' + token.type + '" type was not found.');
      }
    }
    return out;
  }
}

// ---- Entry point ----
// Fresh lexer and parser per call: nothing is carried between cases.

export const parse = markdown => {
  const lexer = new Lexer();
  const tokens = lexer.lex(markdown);
  const parser = new Parser();
  return parser.parse(tokens);
};

