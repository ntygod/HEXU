import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  moveDraftSelection,
  savedDraftRange,
  type DraftSelectionKey,
  type DraftTextSelection,
} from '../apps/web/src/draft-selection.js';
import { selectedDraftText } from '../packages/contracts/src/ai-drafts.js';
const caret = (position: number): DraftTextSelection => ({
  start: position,
  end: position,
  direction: 'none',
});
const key = (key: string, extra: Partial<DraftSelectionKey> = {}): DraftSelectionKey => ({
  key,
  shiftKey: false,
  ctrlKey: false,
  metaKey: false,
  altKey: false,
  isComposing: false,
  ...extra,
});

test('只读草稿左右移动和 Shift 扩展选区，不越过正文首尾', () => {
  let selection = caret(0);
  const text = '采用第一段';
  assert.deepEqual(moveDraftSelection(text, selection, key('ArrowLeft')), caret(0));
  for (let i = 1; i <= text.length; i++) {
    selection = moveDraftSelection(text, selection, key('ArrowRight', { shiftKey: true }))!;
    assert.deepEqual(selection, { start: 0, end: i, direction: 'forward' });
  }
  assert.deepEqual(
    moveDraftSelection(text, selection, key('ArrowRight', { shiftKey: true })),
    selection,
  );
  assert.deepEqual(moveDraftSelection(text, selection, key('ArrowLeft')), caret(0));
  assert.deepEqual(moveDraftSelection(text, selection, key('ArrowRight')), caret(text.length));
});

test('反向选区保留锚点，缩小后越过锚点能够继续向另一侧选择', () => {
  let selection = caret(2);
  selection = moveDraftSelection('一二三四', selection, key('ArrowLeft', { shiftKey: true }))!;
  assert.deepEqual(selection, { start: 1, end: 2, direction: 'backward' });
  selection = moveDraftSelection('一二三四', selection, key('ArrowRight', { shiftKey: true }))!;
  assert.deepEqual(selection, { start: 2, end: 2, direction: 'forward' });
  selection = moveDraftSelection('一二三四', selection, key('ArrowRight', { shiftKey: true }))!;
  assert.deepEqual(selection, { start: 2, end: 3, direction: 'forward' });
});

test('行首尾和全文首尾明确定位，带 Shift 保留原始锚点', () => {
  const text = '一二\n三四\n五六';
  assert.deepEqual(moveDraftSelection(text, caret(4), key('Home')), caret(3));
  assert.deepEqual(moveDraftSelection(text, caret(4), key('End')), caret(5));
  assert.deepEqual(moveDraftSelection(text, caret(0), key('Home')), caret(0));
  assert.deepEqual(
    moveDraftSelection(text, caret(4), key('Home', { ctrlKey: true, shiftKey: true })),
    { start: 0, end: 4, direction: 'backward' },
  );
  assert.deepEqual(
    moveDraftSelection(text, caret(4), key('End', { metaKey: true, shiftKey: true })),
    { start: 4, end: 8, direction: 'forward' },
  );
  assert.deepEqual(moveDraftSelection('', caret(0), key('End')), caret(0));
});

test('键盘选区按完整文字簇移动，不拆开表情、肤色、组合字符或家庭表情', () => {
  const parts = ['中', '🙂', '👍🏽', 'e\u0301', '👨‍👩‍👧‍👦', '\n', '文'];
  const text = parts.join('');
  let selection = caret(0),
    offset = 0;
  for (const part of parts) {
    selection = moveDraftSelection(text, selection, key('ArrowRight', { shiftKey: true }))!;
    offset += part.length;
    assert.equal(selection.end, offset);
    assert.equal(
      selectedDraftText(text, [{ start: selection.start, end: selection.end }]),
      text.slice(0, offset),
    );
  }
  for (const part of [...parts].reverse()) {
    selection = moveDraftSelection(text, selection, key('ArrowLeft', { shiftKey: true }))!;
    offset -= part.length;
    assert.equal(selection.end, offset);
  }
});

test('复制、全选、Tab、Escape、输入法和未接管的系统组合键保持浏览器行为', () => {
  for (const input of [
    key('c', { ctrlKey: true }),
    key('a', { metaKey: true }),
    key('Tab'),
    key('Escape'),
    key('ArrowUp'),
    key('ArrowRight', { ctrlKey: true }),
    key('ArrowLeft', { altKey: true }),
    key('Home', { isComposing: true }),
  ])
    assert.equal(moveDraftSelection('原文', caret(1), input), null);
});

test('浏览器 LF 选区映射回保存的 CRLF/CR 修订，跨行和表情片段不偏移也不改写原文', () => {
  const text = '首行\r\n🙂采用\r\n保留\r末行';
  const normalized = text.replace(/\r\n?/g, '\n');
  const start = normalized.indexOf('🙂'),
    end = normalized.indexOf('\n保留');
  assert.deepEqual(savedDraftRange(text, start, end), { start: 4, end: 8 });
  assert.equal(selectedDraftText(text, [savedDraftRange(text, start, end)]), '🙂采用');
  assert.deepEqual(savedDraftRange(text, 0, normalized.length), { start: 0, end: text.length });
  assert.equal(selectedDraftText(text, [savedDraftRange(text, 0, normalized.length)]), text);
  assert.deepEqual(savedDraftRange('原文\n未变', 3, 5), { start: 3, end: 5 });
});
