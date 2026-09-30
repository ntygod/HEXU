import test from 'node:test';
import assert from 'node:assert/strict';
import {
  compareTextLines,
  LINE_DIFFERENCE_LIMITS,
  type DifferenceLine,
} from '../packages/domain/src/line-difference.js';
const ending = { LF: '\n', CRLF: '\r\n', CR: '\r', none: '' };
function verify(a: string, b: string) {
  const d = compareTextLines(a, b);
  assert.equal(d.kind, 'diff');
  if (d.kind !== 'diff') throw new Error('expected complete comparison');
  for (const [side, expected] of [
    ['before', a],
    ['after', b],
  ] as const) {
    const rows: DifferenceLine[] = d.rows.filter((r) => r[side] !== null);
    assert.equal(rows.map((r) => r.text + ending[r.ending]).join(''), expected);
    assert.deepEqual(
      rows.map((r) => r[side]),
      rows.map((_, i) => i + 1),
    );
  }
  assert.equal(d.added, d.rows.filter((r) => r.kind === 'addition').length);
  assert.equal(d.removed, d.rows.filter((r) => r.kind === 'deletion').length);
  assert.deepEqual(compareTextLines(a, b), d);
  return d;
}
test('显示比较完整重建两侧与行号，空文件没有虚构行', () => {
  for (const [a, b] of [
    ['', ''],
    ['', '新文件\n'],
    ['旧文件\n', ''],
    ['a\nb\nc\n', 'a\nB\nc\n'],
    ['a\na\nb\n', 'a\nb\na\n'],
  ])
    verify(a!, b!);
  assert.deepEqual(verify('', '').rows, []);
  const rows = verify('same\nold\nend', 'same\nnew\nend').rows;
  assert.deepEqual(
    rows.map((r) => r.kind),
    ['context', 'deletion', 'addition', 'context'],
  );
});
test('保留空白、Unicode、空行和所有原换行，不静默归一化末尾换行', () => {
  for (const [a, b] of [
    ['a', 'a\n'],
    ['\n', ''],
    ['a\r\nb\r', 'a\nb\n'],
    ['\t中文🙂 \n\n', ' 中文🙂\n\n'],
    ['a\n', 'a\n\n'],
  ])
    verify(a!, b!);
  assert.equal(verify('x', 'x\n').removed, 1);
  assert.equal(verify('x', 'x\n').added, 1);
  assert.deepEqual(
    verify('x\r\n', 'x\n').rows.map((r) => r.ending),
    ['CRLF', 'LF'],
  );
});
test('固定工作量/字符/行数上限回退完整正文，不给截断的成功差异', () => {
  assert.deepEqual(compareTextLines('a'.repeat(LINE_DIFFERENCE_LIMITS.characters + 1), ''), {
    kind: 'fallback',
    reason: 'size',
  });
  assert.deepEqual(compareTextLines('\n'.repeat(LINE_DIFFERENCE_LIMITS.lines + 1), ''), {
    kind: 'fallback',
    reason: 'size',
  });
  assert.deepEqual(compareTextLines('a\n'.repeat(600), 'b\n'.repeat(600)), {
    kind: 'fallback',
    reason: 'complexity',
  });
  const a = 'same\n'.repeat(800);
  assert.equal(verify(a + 'old\n', a + 'new\n').added, 1);
});
test('确定性生成的重复行与混合换行均完整重建，不遗漏或重复任一侧', () => {
  let seed = 127;
  const next = () => (seed = (seed * 16807) % 2147483647);
  const values = ['a\n', 'b\r\n', ' \r', '中文\n', '\n'];
  for (let n = 0; n < 300; n++) {
    const create = () =>
      Array.from({ length: next() % 18 }, () => values[next() % values.length]!).join('') +
      (next() % 2 ? 'tail' : '');
    verify(create(), create());
  }
});
