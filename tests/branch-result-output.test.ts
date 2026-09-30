import test from 'node:test';
import assert from 'node:assert/strict';
import { boundedBranchOutput } from '../packages/domain/src/work-branch-result-source.js';

test('成果输出保留原始空白和事件顺序，不做trim或补造省略号', () => {
  const value = boundedBranchOutput([' first \n', '第二段']);
  assert.equal(value.text, ' first \n\n\n第二段');
  assert.equal(value.totalBytes, Buffer.byteLength(value.text));
  assert.equal(value.retainedBytes, value.totalBytes);
  assert.equal(value.truncated, false);
});
test('成果输出按UTF-8字节截取，中文与emoji不被切成替换字符', () => {
  const cases = [
    [0, ''],
    [1, 'A'],
    [3, 'A'],
    [4, 'A中'],
    [7, 'A中'],
    [8, 'A中😀'],
  ] as const;
  for (const [budget, expected] of cases) {
    const value = boundedBranchOutput(['A中😀B'], budget);
    assert.equal(value.text, expected);
    assert.equal(value.retainedBytes, Buffer.byteLength(expected));
    assert.equal(value.totalBytes, 9);
    assert.equal(value.truncated, true);
    assert(!value.text.includes('\uFFFD'));
  }
});
test('成果输出精确边界不标截取，事件分隔符计入字节预算', () => {
  const full = boundedBranchOutput(['a', 'b'], 4);
  assert.equal(full.text, 'a\n\nb');
  assert.equal(full.truncated, false);
  const prefix = boundedBranchOutput(['a', 'b'], 2);
  assert.equal(prefix.text, 'a\n');
  assert.equal(prefix.totalBytes, 4);
  assert.equal(prefix.retainedBytes, 2);
  assert.equal(prefix.truncated, true);
});
test('空输出不会补造内容或标记截取', () => {
  assert.deepEqual(boundedBranchOutput([]), {
    text: '',
    totalBytes: 0,
    retainedBytes: 0,
    truncated: false,
  });
});
test('成果输出计数覆盖被截掉的尾部，默认最多24 KiB', () => {
  const value = boundedBranchOutput(['中'.repeat(9000), 'tail']);
  assert.equal(value.retainedBytes, 24 * 1024);
  assert.equal(value.totalBytes, 27006);
  assert.equal(value.text, '中'.repeat(8192));
  assert.equal(value.truncated, true);
});
test('非法字节预算直接拒绝', () => {
  for (const limit of [-1, 0.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1])
    assert.throws(() => boundedBranchOutput(['content'], limit), RangeError);
});
