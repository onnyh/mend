// mend: one patch tool for every AI edit format.
//
// Reads a patch in one of four formats (unified diff, SEARCH/REPLACE blocks,
// V4A patches, JSON tool calls) and applies it to the tree in the working
// directory, all files or none. The behaviour is SPEC.md, version 1, in full:
// every sentence of that document is a requirement this file implements.
// Node 22, standard library only; run as `node main.ts [options] [PATCH]`.

import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';

/** A patch the reader cannot read: the single line it prints, exit 2. */
class ParseFail extends Error {
  line: string;
  constructor(line: string) {
    super(line);
    this.line = line;
  }
}

/** One edit that failed: its code and the path the failure concerns. */
class EditFail extends Error {
  code: string;
  path: string;
  constructor(code: string, path: string) {
    super(`${code} ${path}`);
    this.code = code;
    this.path = path;
  }
}

const FORMATS = ['auto', 'unified', 'search-replace', 'v4a', 'json'];

const isBlank = (s: string): boolean => s.trim() === '';
const stripTrail = (s: string): string => s.replace(/[ \t]+$/, '');
const stripBoth = (s: string): string => s.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');
const leadWs = (s: string): string => {
  const m = /^[ \t]*/.exec(s);
  return m === null ? '' : m[0];
};
const isOnlyWs = (s: string): boolean => /^[ \t]*$/.test(s);

/** A patch's lines: split at \n, one trailing \r removed, no empty piece after a final \n. */
function patchLines(text: string): string[] {
  if (text === '') return [];
  const parts = text.split('\n');
  if (text.endsWith('\n')) parts.pop();
  return parts.map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l));
}

/** A path is safe when it is not empty, does not start with /, holds no \,
 * and none of its /-separated segments is empty, . or ... */
function isSafe(p: string): boolean {
  if (p === '' || p.startsWith('/') || p.includes('\\')) return false;
  return p.split('/').every((s) => s !== '' && s !== '.' && s !== '..');
}

/** A file as lines: its line break, whether it ends with one, and its lines. */
interface Doc {
  lines: string[];
  br: string;
  fin: boolean;
}

function readDoc(text: string): Doc {
  if (text === '') return { lines: [], br: '\n', fin: false };
  const nl = text.indexOf('\n');
  const br = nl > 0 && text[nl - 1] === '\r' ? '\r\n' : '\n';
  const parts = text.split(br);
  const fin = text.endsWith(br);
  if (fin) parts.pop();
  return { lines: parts, br, fin };
}

function writeDoc(d: Doc): string {
  if (d.lines.length === 0) return '';
  return d.lines.join(d.br) + (d.fin ? d.br : '');
}

/** A file is CRLF when its first line feed follows a carriage return. */
function isCrlf(text: string): boolean {
  const nl = text.indexOf('\n');
  return nl > 0 && text[nl - 1] === '\r';
}

/** The tree as the edits leave it. `now` holds what changed (null: deleted);
 * anything else is read from disk the first time an edit looks at it. */
class Tree {
  orig = new Map<string, string | null>();
  cur = new Map<string, string | null>();

  original(p: string): string | null {
    if (!this.orig.has(p)) {
      let v: string | null = null;
      try {
        if (statSync(p).isFile()) v = readFileSync(p, 'utf8');
      } catch {
        v = null;
      }
      this.orig.set(p, v);
    }
    return this.orig.get(p) as string | null;
  }

  get(p: string): string | null {
    return this.cur.has(p) ? (this.cur.get(p) as string | null) : this.original(p);
  }

  set(p: string, v: string | null): void {
    this.cur.set(p, v);
  }

  snapshot(): Map<string, string | null> {
    return new Map(this.cur);
  }

  restore(s: Map<string, string | null>): void {
    this.cur.clear();
    for (const [k, v] of s) this.cur.set(k, v);
  }

  changed(): string[] {
    return [...this.cur.keys()];
  }
}

type EditFn = (tree: Tree) => void;

/* ------------------------------------------------------------------ */
/* Matching lines (SPEC.md section 5)                                  */
/* ------------------------------------------------------------------ */

function normLine(s: string, tier: number): string {
  if (tier === 0) return s;
  if (tier === 1) return stripTrail(s);
  return stripBoth(s);
}

/** Every 0-based position where O occurs in `lines` at this tier, from `from`. */
function occurrencesAt(o: string[], lines: string[], tier: number, from: number): number[] {
  const out: number[] = [];
  for (let i = from; i + o.length <= lines.length; i++) {
    let ok = true;
    for (let j = 0; j < o.length; j++) {
      if (normLine(o[j], tier) !== normLine(lines[i + j], tier)) {
        ok = false;
        break;
      }
    }
    if (ok) out.push(i);
  }
  return out;
}

/** The first tier (0, then 1, then 2; only 0 with --strict) at which O occurs
 * at or after `from`, with every occurrence there; null when it never does. */
function findTier(
  o: string[],
  lines: string[],
  from: number,
  strict: boolean,
): { tier: number; pos: number[] } | null {
  const top = strict ? 0 : 2;
  for (let t = 0; t <= top; t++) {
    const pos = occurrencesAt(o, lines, t, from);
    if (pos.length > 0) return { tier: t, pos };
  }
  return null;
}

/** Re-indent one new line at tier 2: the leading spaces and tabs P of the
 * old block's first line are replaced by F, those of the file's first matched
 * line. Empty and whitespace-only lines, and lines not starting with P, are
 * written as they are. At tiers 0 and 1 every line is written as it is. */
function reindent(line: string, p: string, f: string, tier: number): string {
  if (tier !== 2) return line;
  if (isOnlyWs(line)) return line;
  if (!line.startsWith(p)) return line;
  return f + line.slice(p.length);
}

/** One line of a hunk or chunk body. */
interface BodyLine {
  kind: 'ctx' | 'old' | 'new' | 'bs';
  text: string;
}

/** The old lines O of a body: its context and `-` lines, in body order. */
function oldOf(items: BodyLine[]): string[] {
  const out: string[] = [];
  for (const it of items) if (it.kind === 'ctx' || it.kind === 'old') out.push(it.text);
  return out;
}

/** The new lines N of a body against the file's lines at `pos` (matched at
 * `tier`): a context line is written as the file's own matched line, every
 * other line is re-indented at tier 2. With `pos` -1 there is no match and
 * the new lines are written as they are. */
function newOf(items: BodyLine[], doc: Doc, pos: number, tier: number): string[] {
  const o = oldOf(items);
  const p = o.length > 0 ? leadWs(o[0]) : '';
  const f = pos >= 0 ? leadWs(doc.lines[pos]) : '';
  const out: string[] = [];
  let oi = 0;
  for (const it of items) {
    if (it.kind === 'ctx') {
      out.push(doc.lines[pos + oi]);
      oi++;
    } else if (it.kind === 'old') {
      oi++;
    } else if (it.kind === 'new') {
      out.push(reindent(it.text, p, f, tier));
    }
  }
  return out;
}

/** Whether a `\` line follows the body's last context or `+` line. */
function noEol(items: BodyLine[]): boolean {
  let last = -1;
  for (let i = 0; i < items.length; i++) {
    if (items[i].kind === 'ctx' || items[i].kind === 'new') last = i;
  }
  if (last < 0) return false;
  return items[last + 1] !== undefined && items[last + 1].kind === 'bs';
}

/** Apply one hunk or chunk body to a document. `a` is the hunk's A number
 * (ignored for chunks, which pass 0 and a cursor instead); `d` is the
 * running length drift of the section's earlier hunks. Returns the new drift.
 * Throws EditFail('no-match', path) when the old lines are not found. */
function applyBody(
  doc: Doc,
  items: BodyLine[],
  a: number,
  d: number,
  at: number,
  strict: boolean,
  failPath: string,
  eofOnly: boolean,
): number {
  const o = oldOf(items);
  if (o.length === 0) {
    const nLines = newOf(items, doc, -1, 0);
    const idx = Math.min(Math.max(a + d, 0), doc.lines.length);
    const atEnd = idx === doc.lines.length;
    doc.lines.splice(idx, 0, ...nLines);
    if (atEnd) doc.fin = !noEol(items);
    return d + nLines.length;
  }
  const found = findTier(o, doc.lines, at, strict);
  if (found === null) throw new EditFail('no-match', failPath);
  let pos: number;
  if (eofOnly) {
    const ends = found.pos.filter((p) => p + o.length === doc.lines.length);
    if (ends.length === 0) throw new EditFail('no-match', failPath);
    pos = ends[0];
  } else {
    // A unified hunk takes the occurrence nearest to A - 1 + d, the earlier
    // of two equally near (A is 0 for an insertion-style hunk, which still
    // takes the nearest occurrence when its old lines are not empty).
    const target = a - 1 + d;
    pos = found.pos[0];
    let best = Math.abs(pos - target);
    for (const p of found.pos) {
      const dist = Math.abs(p - target);
      if (dist < best) {
        pos = p;
        best = dist;
      }
    }
  }
  const nLines = newOf(items, doc, pos, found.tier);
  const atEnd = pos + o.length === doc.lines.length;
  doc.lines.splice(pos, o.length, ...nLines);
  if (atEnd) doc.fin = !noEol(items);
  return d + (nLines.length - o.length);
}

/* ------------------------------------------------------------------ */
/* Format detection (section 4)                                        */
/* ------------------------------------------------------------------ */

function detect(lines: string[]): string | null {
  const first = lines.findIndex((l) => !isBlank(l));
  if (first < 0) return null;
  if (lines[first].trim() === '*** Begin Patch') return 'v4a';
  const c = lines[first].trimStart()[0];
  if (c === '[' || c === '{') return 'json';
  if (lines.some((l) => l.trimEnd() === '<<<<<<< SEARCH')) return 'search-replace';
  if (
    lines.some(
      (l, i) =>
        l.startsWith('diff --git ') ||
        (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')),
    )
  ) {
    return 'unified';
  }
  return null;
}

/* ------------------------------------------------------------------ */
/* Unified diffs (section 6)                                           */
/* ------------------------------------------------------------------ */

interface Hunk {
  a: number;
  items: BodyLine[];
}

interface RawSection {
  gitOld: string | null;
  gitNew: string | null;
  pairOld: string | null;
  pairNew: string | null;
  renFrom: string | null;
  renTo: string | null;
  newFile: boolean;
  delFile: boolean;
  hunks: Hunk[];
  hasHunk: boolean;
}

const HUNK_HEAD = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;
const DIFF_GIT = /^diff --git a\/([^ \t]+) b\/([^ \t]+)[ \t]*$/;

/** The path a `--- ` or `+++ ` line names: the text after the four
 * characters, up to the first tab, with surrounding spaces removed;
 * /dev/null means no file, and a leading a/ or b/ is removed. */
function headerPath(line: string): string | null {
  let p = line.slice(4).split('\t')[0].trim();
  if (p === '/dev/null') return null;
  if (p.startsWith('a/') || p.startsWith('b/')) p = p.slice(2);
  return p;
}

/** Collect a hunk body starting at `j`; returns the hunk and the index of
 * the first line after it. */
function collectHunk(lines: string[], j: number, a: number): { hunk: Hunk; next: number } {
  const items: BodyLine[] = [];
  let k = j;
  while (k < lines.length) {
    const l = lines[k];
    if (l.startsWith('diff --git ')) break;
    if (l.startsWith('--- ') && (lines[k + 1] ?? '').startsWith('+++ ')) break;
    if (l === '') items.push({ kind: 'ctx', text: '' });
    else if (l.startsWith(' ')) items.push({ kind: 'ctx', text: l.slice(1) });
    else if (l.startsWith('-')) items.push({ kind: 'old', text: l.slice(1) });
    else if (l.startsWith('+')) items.push({ kind: 'new', text: l.slice(1) });
    else if (l.startsWith('\\')) items.push({ kind: 'bs', text: '' });
    else break;
    k++;
  }
  while (items.length > 0 && items[items.length - 1].kind === 'ctx' && items[items.length - 1].text === '') {
    items.pop();
  }
  return { hunk: { a, items }, next: k };
}

function parseUnified(lines: string[], strict: boolean, moves: { old: string; nw: string }[]): EditFn[] {
  const sections: RawSection[] = [];
  let cur: RawSection | null = null;
  const startSection = (gitOld: string | null, gitNew: string | null): RawSection => {
    const s: RawSection = {
      gitOld,
      gitNew,
      pairOld: null,
      pairNew: null,
      renFrom: null,
      renTo: null,
      newFile: false,
      delFile: false,
      hunks: [],
      hasHunk: false,
    };
    sections.push(s);
    cur = s;
    return s;
  };

  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (line.startsWith('diff --git ')) {
      const m = DIFF_GIT.exec(line);
      if (m === null) throw new ParseFail(`error: parse ${i + 1}`);
      startSection(m[1], m[2]);
      i++;
      continue;
    }
    if (cur === null) {
      if (line.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) {
        const s = startSection(null, null);
        s.pairOld = headerPath(line);
        s.pairNew = headerPath(lines[i + 1]);
        i += 2;
        continue;
      }
      if (line.startsWith('@@')) throw new ParseFail(`error: parse ${i + 1}`);
      i++;
      continue;
    }
    if (!cur.hasHunk) {
      if (line.startsWith('--- ')) {
        if ((lines[i + 1] ?? '').startsWith('+++ ')) {
          if (cur.pairOld === null) {
            cur.pairOld = headerPath(line);
            cur.pairNew = headerPath(lines[i + 1]);
            i += 2;
          } else {
            const s = startSection(null, null);
            s.pairOld = headerPath(line);
            s.pairNew = headerPath(lines[i + 1]);
            i += 2;
          }
          continue;
        }
        throw new ParseFail(`error: parse ${i + 2}`);
      }
      if (line.startsWith('rename from ')) {
        if (cur.renFrom === null) cur.renFrom = line.slice('rename from '.length).trim();
        i++;
        continue;
      }
      if (line.startsWith('rename to ')) {
        if (cur.renTo === null) cur.renTo = line.slice('rename to '.length).trim();
        i++;
        continue;
      }
      if (line.startsWith('new file mode')) {
        cur.newFile = true;
        i++;
        continue;
      }
      if (line.startsWith('deleted file mode')) {
        cur.delFile = true;
        i++;
        continue;
      }
      if (line.startsWith('@@')) {
        const m = HUNK_HEAD.exec(line);
        if (m === null) throw new ParseFail(`error: parse ${i + 1}`);
        const { hunk, next } = collectHunk(lines, i + 1, Number(m[1]));
        cur.hunks.push(hunk);
        cur.hasHunk = true;
        i = next;
        continue;
      }
      i++;
      continue;
    }
    if (line.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) {
      const s = startSection(null, null);
      s.pairOld = headerPath(line);
      s.pairNew = headerPath(lines[i + 1]);
      i += 2;
      continue;
    }
    if (line.startsWith('@@')) {
      const m = HUNK_HEAD.exec(line);
      if (m === null) throw new ParseFail(`error: parse ${i + 1}`);
      const { hunk, next } = collectHunk(lines, i + 1, Number(m[1]));
      cur.hunks.push(hunk);
      i = next;
      continue;
    }
    i++;
  }

  if (sections.length === 0) throw new ParseFail('error: parse 1');
  const edits: EditFn[] = [];
  for (const s of sections) {
    const oldP = s.pairOld !== null ? s.pairOld : s.renFrom !== null ? s.renFrom : s.gitOld;
    const newP = s.pairNew !== null ? s.pairNew : s.renTo !== null ? s.renTo : s.gitNew;
    const kind = s.newFile || oldP === null ? 'create' : s.delFile || newP === null ? 'delete' : oldP !== newP ? 'move' : 'change';
    edits.push(unifiedEdit(oldP, newP, kind, s.hunks, strict, moves));
  }
  return edits;
}

function unifiedEdit(
  oldP: string | null,
  newP: string | null,
  kind: string,
  hunks: Hunk[],
  strict: boolean,
  moves: { old: string; nw: string }[],
): EditFn {
  return (tree) => {
    if (oldP !== null && !isSafe(oldP)) throw new EditFail('unsafe', oldP);
    if (newP !== null && !isSafe(newP)) throw new EditFail('unsafe', newP);
    if (kind === 'create') {
      const p = newP as string;
      if (tree.get(p) !== null) throw new EditFail('exists', p);
      const made: string[] = [];
      for (const h of hunks) for (const it of h.items) if (it.kind === 'new') made.push(it.text);
      let fin = true;
      if (made.length > 0) {
        let lastPlus = -1;
        let lastHunk: Hunk | null = null;
        for (const h of hunks) {
          for (let k = 0; k < h.items.length; k++) {
            if (h.items[k].kind === 'new') {
              lastPlus = k;
              lastHunk = h;
            }
          }
        }
        fin = !(lastHunk !== null && lastHunk.items[lastPlus + 1] !== undefined && lastHunk.items[lastPlus + 1].kind === 'bs');
      } else {
        fin = false;
      }
      tree.set(p, made.length === 0 ? '' : made.join('\n') + (fin ? '\n' : ''));
      return;
    }
    if (kind === 'delete') {
      const p = oldP as string;
      if (tree.get(p) === null) throw new EditFail('missing', p);
      tree.set(p, null);
      return;
    }
    if (kind === 'move') {
      const from = oldP as string;
      const to = newP as string;
      if (tree.get(from) === null) throw new EditFail('missing', from);
      if (tree.get(to) !== null) throw new EditFail('exists', to);
      const doc = readDoc(tree.get(from) as string);
      let d = 0;
      for (const h of hunks) d = applyBody(doc, h.items, h.a, d, 0, strict, from, false);
      tree.set(to, writeDoc(doc));
      tree.set(from, null);
      moves.push({ old: from, nw: to });
      return;
    }
    const p = oldP as string;
    const cur = tree.get(p);
    if (cur === null) throw new EditFail('missing', p);
    const doc = readDoc(cur);
    let d = 0;
    for (const h of hunks) d = applyBody(doc, h.items, h.a, d, 0, strict, p, false);
    tree.set(p, writeDoc(doc));
  };
}

/* ------------------------------------------------------------------ */
/* SEARCH/REPLACE blocks (section 7)                                   */
/* ------------------------------------------------------------------ */

function parseSearchReplace(lines: string[], strict: boolean): EditFn[] {
  const edits: EditFn[] = [];
  let prevEnd = 0;
  let prevPath: string | null = null;
  let i = 0;
  while (i < lines.length) {
    if (lines[i].trimEnd() !== '<<<<<<< SEARCH') {
      i++;
      continue;
    }
    const searchNo = i + 1;
    let path: string | null = null;
    for (let j = i - 1; j >= prevEnd; j--) {
      const t = lines[j].trim();
      if (t === '' || t.startsWith('```')) continue;
      path = t;
      break;
    }
    if (path === null) path = prevPath;
    if (path === null) throw new ParseFail(`error: parse ${searchNo}`);
    let sep = -1;
    for (let j = i + 1; j < lines.length; j++) {
      const t = lines[j].trimEnd();
      if (t === '=======') {
        sep = j;
        break;
      }
      if (t === '>>>>>>> REPLACE') break;
    }
    if (sep === -1) throw new ParseFail(`error: parse ${searchNo}`);
    let end = -1;
    for (let j = sep + 1; j < lines.length; j++) {
      if (lines[j].trimEnd() === '>>>>>>> REPLACE') {
        end = j;
        break;
      }
    }
    if (end === -1) throw new ParseFail(`error: parse ${searchNo}`);
    const oldLines = lines.slice(i + 1, sep);
    const newLines = lines.slice(sep + 1, end);
    edits.push(searchReplaceEdit(path, oldLines, newLines, strict));
    prevPath = path;
    prevEnd = end + 1;
    i = end + 1;
  }
  if (edits.length === 0) throw new ParseFail('error: parse 1');
  return edits;
}

function searchReplaceEdit(path: string, oldLines: string[], newLines: string[], strict: boolean): EditFn {
  return (tree) => {
    if (!isSafe(path)) throw new EditFail('unsafe', path);
    if (oldLines.length === 0) {
      if (tree.get(path) !== null) throw new EditFail('exists', path);
      tree.set(path, newLines.length === 0 ? '' : newLines.join('\n') + '\n');
      return;
    }
    const cur = tree.get(path);
    if (cur === null) throw new EditFail('missing', path);
    const doc = readDoc(cur);
    const found = findTier(oldLines, doc.lines, 0, strict);
    if (found === null) throw new EditFail('no-match', path);
    if (found.pos.length > 1) throw new EditFail('ambiguous', path);
    const pos = found.pos[0];
    const p = leadWs(oldLines[0]);
    const f = leadWs(doc.lines[pos]);
    const made = newLines.map((l) => reindent(l, p, f, found.tier));
    doc.lines.splice(pos, oldLines.length, ...made);
    tree.set(path, writeDoc(doc));
  };
}

/* ------------------------------------------------------------------ */
/* V4A patches (section 8)                                             */
/* ------------------------------------------------------------------ */

const V4A_SECTION = /^\*\*\* (Add File|Delete File|Update File): (.*)$/;

interface VChunk {
  anchor: string;
  items: BodyLine[];
  eof: boolean;
}

function toBodyLine(l: string): BodyLine {
  if (l === '') return { kind: 'ctx', text: '' };
  if (l.startsWith(' ')) return { kind: 'ctx', text: l.slice(1) };
  if (l.startsWith('-')) return { kind: 'old', text: l.slice(1) };
  return { kind: 'new', text: l.slice(1) };
}

function parseV4a(lines: string[], strict: boolean, moves: { old: string; nw: string }[]): EditFn[] {
  let first = -1;
  let last = -1;
  for (let i = 0; i < lines.length; i++) {
    if (!isBlank(lines[i])) {
      if (first < 0) first = i;
      last = i;
    }
  }
  if (first < 0) throw new ParseFail('error: parse 1');
  if (lines[first].trim() !== '*** Begin Patch') throw new ParseFail(`error: parse ${first + 1}`);
  if (lines[last].trim() !== '*** End Patch') throw new ParseFail(`error: parse ${lines.length + 1}`);
  const edits: EditFn[] = [];
  let i = first + 1;
  while (i < last) {
    const line = lines[i];
    if (isBlank(line)) {
      i++;
      continue;
    }
    const m = V4A_SECTION.exec(line);
    if (m === null) throw new ParseFail(`error: parse ${i + 1}`);
    const kind = m[1];
    const path = m[2].trim();
    let j = i + 1;
    while (j < last && V4A_SECTION.exec(lines[j]) === null) j++;
    let end = j;
    while (end > i + 1 && isBlank(lines[end - 1])) end--;
    if (kind === 'Add File') {
      const made: string[] = [];
      for (let k = i + 1; k < end; k++) {
        const l = lines[k];
        if (isBlank(l)) made.push('');
        else if (l.startsWith('+')) made.push(l.slice(1));
        else throw new ParseFail(`error: parse ${k + 1}`);
      }
      edits.push(v4aAddEdit(path, made));
    } else if (kind === 'Delete File') {
      for (let k = i + 1; k < end; k++) {
        if (!isBlank(lines[k])) throw new ParseFail(`error: parse ${k + 1}`);
      }
      edits.push(v4aDeleteEdit(path));
    } else {
      edits.push(v4aUpdateEdit(path, lines.slice(i + 1, end), i + 1, strict, moves));
    }
    i = j;
  }
  if (edits.length === 0) throw new ParseFail('error: parse 1');
  return edits;
}

function v4aAddEdit(path: string, made: string[]): EditFn {
  return (tree) => {
    if (!isSafe(path)) throw new EditFail('unsafe', path);
    if (tree.get(path) !== null) throw new EditFail('exists', path);
    tree.set(path, made.length === 0 ? '' : made.join('\n') + '\n');
  };
}

function v4aDeleteEdit(path: string): EditFn {
  return (tree) => {
    if (!isSafe(path)) throw new EditFail('unsafe', path);
    if (tree.get(path) === null) throw new EditFail('missing', path);
    tree.set(path, null);
  };
}

function v4aUpdateEdit(
  path: string,
  secLines: string[],
  start0: number,
  strict: boolean,
  moves: { old: string; nw: string }[],
): EditFn {
  let moveTo: string | null = null;
  let idx = 0;
  if (secLines.length > 0 && secLines[0].startsWith('*** Move to: ')) {
    moveTo = secLines[0].slice('*** Move to: '.length).trim();
    idx = 1;
  }
  const chunks: VChunk[] = [];
  let curChunk: VChunk | null = null;
  for (let k = idx; k < secLines.length; k++) {
    const l = secLines[k];
    if (l.startsWith('@@')) {
      curChunk = { anchor: l.slice(2).trim(), items: [], eof: false };
      chunks.push(curChunk);
      continue;
    }
    if (l.trim() === '*** End of File') {
      if (curChunk === null) {
        curChunk = { anchor: '', items: [], eof: true };
        chunks.push(curChunk);
      } else {
        curChunk.eof = true;
      }
      curChunk = null;
      continue;
    }
    if (l === '' || l.startsWith(' ') || l.startsWith('-') || l.startsWith('+')) {
      if (curChunk === null) {
        if (chunks.length > 0) throw new ParseFail(`error: parse ${start0 + k + 1}`);
        curChunk = { anchor: '', items: [], eof: false };
        chunks.push(curChunk);
      }
      curChunk.items.push(toBodyLine(l));
      continue;
    }
    throw new ParseFail(`error: parse ${start0 + k + 1}`);
  }
  if (chunks.length === 0 && moveTo === null) {
    throw new ParseFail(`error: parse ${start0}`);
  }
  return (tree) => {
    if (!isSafe(path)) throw new EditFail('unsafe', path);
    if (moveTo !== null && !isSafe(moveTo)) throw new EditFail('unsafe', moveTo);
    const cur = tree.get(path);
    if (cur === null) throw new EditFail('missing', path);
    if (moveTo !== null && tree.get(moveTo) !== null) throw new EditFail('exists', moveTo);
    const doc = readDoc(cur);
    let cursor = 0;
    for (const ch of chunks) {
      if (ch.anchor !== '') {
        const found = findTier([ch.anchor], doc.lines, cursor, strict);
        if (found === null) throw new EditFail('no-match', path);
        cursor = found.pos[0] + 1;
      }
      const o = oldOf(ch.items);
      if (o.length === 0) {
        const nLines = newOf(ch.items, doc, -1, 0);
        const at = ch.eof ? doc.lines.length : cursor;
        doc.lines.splice(at, 0, ...nLines);
        cursor = at + nLines.length;
        continue;
      }
      const found = findTier(o, doc.lines, cursor, strict);
      if (found === null) throw new EditFail('no-match', path);
      let pos: number;
      if (ch.eof) {
        const ends = found.pos.filter((p) => p + o.length === doc.lines.length);
        if (ends.length === 0) throw new EditFail('no-match', path);
        pos = ends[0];
      } else {
        pos = found.pos[0];
      }
      const nLines = newOf(ch.items, doc, pos, found.tier);
      doc.lines.splice(pos, o.length, ...nLines);
      cursor = pos + nLines.length;
    }
    const text = writeDoc(doc);
    if (moveTo !== null) {
      tree.set(moveTo, text);
      tree.set(path, null);
      moves.push({ old: path, nw: moveTo });
    } else {
      tree.set(path, text);
    }
  };
}

/* ------------------------------------------------------------------ */
/* JSON edits (section 9)                                              */
/* ------------------------------------------------------------------ */

function jsonEdit(v: unknown): EditFn | null {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  const p = o.path;
  if (typeof p !== 'string') return null;
  if (o.command === 'create') {
    if (typeof o.file_text !== 'string') return null;
    const text = o.file_text;
    return (tree) => {
      if (!isSafe(p)) throw new EditFail('unsafe', p);
      if (tree.get(p) !== null) throw new EditFail('exists', p);
      tree.set(p, text);
    };
  }
  if (o.command === 'str_replace') {
    if (typeof o.old_str !== 'string' || o.old_str === '') return null;
    if (o.new_str !== undefined && typeof o.new_str !== 'string') return null;
    const oldStr = o.old_str;
    const newStr = (o.new_str as string | undefined) ?? '';
    return (tree) => {
      if (!isSafe(p)) throw new EditFail('unsafe', p);
      const before = tree.get(p);
      if (before === null) throw new EditFail('missing', p);
      const crlf = isCrlf(before);
      const norm = (s: string): string => (crlf ? s.replaceAll('\r\n', '\n') : s);
      const t = norm(before);
      const old = norm(oldStr);
      let count = 0;
      for (let k = t.indexOf(old); k >= 0; k = t.indexOf(old, k + 1)) count++;
      if (count === 0) throw new EditFail('no-match', p);
      if (count > 1) throw new EditFail('ambiguous', p);
      const at = t.indexOf(old);
      const out = t.slice(0, at) + norm(newStr) + t.slice(at + old.length);
      tree.set(p, crlf ? out.replaceAll('\n', '\r\n') : out);
    };
  }
  if (o.command === 'insert') {
    if (typeof o.insert_line !== 'number' || !Number.isInteger(o.insert_line)) return null;
    if (typeof o.new_str !== 'string') return null;
    const lineNo = o.insert_line;
    const add = patchLines(o.new_str);
    return (tree) => {
      if (!isSafe(p)) throw new EditFail('unsafe', p);
      const before = tree.get(p);
      if (before === null) throw new EditFail('missing', p);
      const doc = readDoc(before);
      if (lineNo < 0 || lineNo > doc.lines.length) throw new EditFail('no-match', p);
      doc.lines.splice(lineNo, 0, ...add);
      tree.set(p, writeDoc(doc));
    };
  }
  return null;
}

function parseJson(text: string, lines: string[]): EditFn[] {
  const first = lines.findIndex((l) => !isBlank(l));
  if (first < 0) throw new ParseFail('error: parse 1');
  const edits: EditFn[] = [];
  if (lines[first].trimStart().startsWith('[')) {
    let v: unknown;
    try {
      v = JSON.parse(text);
    } catch {
      throw new ParseFail(`error: parse ${first + 1}`);
    }
    if (!Array.isArray(v)) throw new ParseFail(`error: parse ${first + 1}`);
    for (const x of v) {
      const e = jsonEdit(x);
      if (e === null) throw new ParseFail(`error: parse ${first + 1}`);
      edits.push(e);
    }
    if (edits.length === 0) throw new ParseFail('error: parse 1');
    return edits;
  }
  lines.forEach((l, idx) => {
    if (isBlank(l)) return;
    let e: EditFn | null = null;
    try {
      e = jsonEdit(JSON.parse(l));
    } catch {
      e = null;
    }
    if (e === null) throw new ParseFail(`error: parse ${idx + 1}`);
    edits.push(e);
  });
  if (edits.length === 0) throw new ParseFail('error: parse 1');
  return edits;
}

/* ------------------------------------------------------------------ */
/* Running the CLI (sections 1, 2, 10)                                 */
/* ------------------------------------------------------------------ */

interface RunOut {
  code: number;
  out: string[];
}

function run(args: string[]): RunOut {
  let format: string | null = null;
  let check = false;
  let strict = false;
  const pos: string[] = [];
  let ended = false;
  for (const a of args) {
    if (!ended && a === '--') {
      ended = true;
      continue;
    }
    if (!ended && a.startsWith('-') && a !== '-') {
      if (a.startsWith('--format=')) {
        if (format !== null) return { code: 2, out: ['error: usage'] };
        const v = a.slice('--format='.length);
        if (!FORMATS.includes(v)) return { code: 2, out: ['error: usage'] };
        format = v;
      } else if (a === '--check') {
        if (check) return { code: 2, out: ['error: usage'] };
        check = true;
      } else if (a === '--strict') {
        if (strict) return { code: 2, out: ['error: usage'] };
        strict = true;
      } else {
        return { code: 2, out: ['error: usage'] };
      }
      continue;
    }
    pos.push(a);
  }
  if (pos.length > 1) return { code: 2, out: ['error: usage'] };
  const patchArg = pos.length === 0 || pos[0] === '-' ? null : pos[0];
  let text = '';
  try {
    text = readFileSync(patchArg ?? 0, 'utf8');
  } catch {
    if (patchArg !== null) return { code: 2, out: ['error: no-patch'] };
  }
  const lines = patchLines(text);
  const kind = format === null || format === 'auto' ? detect(lines) : format;
  if (kind === null) return { code: 2, out: ['error: format'] };
  const moves: { old: string; nw: string }[] = [];
  let edits: EditFn[];
  try {
    if (kind === 'json') edits = parseJson(text, lines);
    else if (kind === 'unified') edits = parseUnified(lines, strict, moves);
    else if (kind === 'search-replace') edits = parseSearchReplace(lines, strict);
    else edits = parseV4a(lines, strict, moves);
  } catch (e) {
    if (e instanceof ParseFail) return { code: 2, out: [e.line] };
    throw e;
  }
  const tree = new Tree();
  const fails: EditFail[] = [];
  for (const edit of edits) {
    const snap = tree.snapshot();
    try {
      edit(tree);
    } catch (e) {
      if (!(e instanceof EditFail)) throw e;
      tree.restore(snap);
      fails.push(e);
    }
  }
  if (fails.length > 0) {
    return {
      code: 1,
      out: [...fails.map((f) => `error: ${f.code} ${f.path}`), `failed: ${fails.length} of ${edits.length} edits`],
    };
  }
  const rows = new Map<string, string>();
  for (const p of tree.changed()) {
    const was = tree.original(p);
    const now = tree.get(p);
    if (was === now) continue;
    rows.set(p, `${was === null ? 'A' : now === null ? 'D' : 'M'} ${p}`);
  }
  for (const mv of moves) {
    const wasOld = tree.original(mv.old);
    const nowOld = tree.get(mv.old);
    const wasNew = tree.original(mv.nw);
    const nowNew = tree.get(mv.nw);
    if (wasOld !== null && nowOld === null && wasNew === null && nowNew !== null) {
      rows.delete(mv.old);
      rows.delete(mv.nw);
      rows.set(mv.nw, `R ${mv.old} -> ${mv.nw}`);
    }
  }
  const keys = [...rows.keys()].sort((a, b) => Buffer.compare(Buffer.from(a, 'utf8'), Buffer.from(b, 'utf8')));
  const out = keys.map((k) => rows.get(k) as string);
  if (!check) {
    for (const p of tree.changed()) {
      const was = tree.original(p);
      const now = tree.get(p);
      if (was === now) continue;
      if (now === null) rmSync(p, { force: true });
      else {
        mkdirSync(dirname(p), { recursive: true });
        writeFileSync(p, now);
      }
    }
  }
  out.push(`ok: ${out.length} ${out.length === 1 ? 'file' : 'files'}`);
  return { code: 0, out };
}

const trialEnv = process.env.MAKEFUN_ENV_URL;
if (trialEnv !== undefined && trialEnv !== '') {
  // A trial: the kit's runner reads the checks from the env and runs this
  // file on each one, without this variable.
  const { runTrial } = await import('./runner.ts');
  await runTrial(trialEnv);
} else {
  const r = run(process.argv.slice(2));
  writeSync(1, r.out.map((l) => `${l}\n`).join(''));
  process.exitCode = r.code;
}
