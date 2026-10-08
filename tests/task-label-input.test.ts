import test from 'node:test';
import assert from 'node:assert/strict';
import { handleTaskLabelKeyDown } from '../apps/web/src/task-label-input.js';

function press(key: string, isComposing = false, keyCode = 13) {
  let prevented = 0;
  let added = 0;
  handleTaskLabelKeyDown(
    {
      key,
      nativeEvent: { isComposing, keyCode },
      preventDefault: () => prevented++,
    },
    () => added++,
  );
  return { prevented, added };
}

test('组合输入中的确认键交还输入法，不加入标签或阻止默认选词', () => {
  assert.deepEqual(press('Enter', true), { prevented: 0, added: 0 });
});

test('compositionend先到时仍识别229，不把选词确认当作加入草稿', () => {
  assert.deepEqual(press('Enter', false, 229), { prevented: 0, added: 0 });
});

test('普通Enter沿用加入一次草稿且阻止表单提交的行为', () => {
  assert.deepEqual(press('Enter'), { prevented: 1, added: 1 });
});

test('其他按键不触发加入，也不改变默认输入行为', () => {
  for (const key of ['a', 'Process', 'Escape', 'Tab', 'ArrowDown', ' ']) {
    assert.deepEqual(press(key, false, 0), { prevented: 0, added: 0 });
    assert.deepEqual(press(key, true, 229), { prevented: 0, added: 0 });
  }
});

test('选词结束后的下一次普通Enter仍可明确加入', () => {
  assert.deepEqual(press('Enter', true, 229), { prevented: 0, added: 0 });
  assert.deepEqual(press('Enter', false, 229), { prevented: 0, added: 0 });
  assert.deepEqual(press('Enter'), { prevented: 1, added: 1 });
});
