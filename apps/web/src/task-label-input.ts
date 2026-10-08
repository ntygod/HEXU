interface LabelInputKeyEvent {
  key: string;
  nativeEvent: { isComposing: boolean; keyCode: number };
  preventDefault(): void;
}

/** Let the IME finish choosing text before Enter can add a label. */
export function handleTaskLabelKeyDown(event: LabelInputKeyEvent, add: () => void): void {
  // Composition can end before keydown; 229 still identifies that IME key.
  if (event.key !== 'Enter' || event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229)
    return;
  event.preventDefault();
  add();
}
