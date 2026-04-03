export function showPrompt(
  title: string,
  placeholder?: string,
  initialValue = '',
): Promise<string | null> {
  return new Promise((resolve) => {
    const overlay = document.createElement('div');
    overlay.className = 'prompt-overlay';

    const dialog = document.createElement('div');
    dialog.className = 'prompt-dialog';

    const header = document.createElement('div');
    header.className = 'prompt-header';

    const eyebrow = document.createElement('div');
    eyebrow.className = 'prompt-eyebrow';
    eyebrow.textContent = 'Quick Input';
    header.appendChild(eyebrow);

    const titleEl = document.createElement('div');
    titleEl.className = 'prompt-title';
    titleEl.textContent = title;
    header.appendChild(titleEl);

    const subtitle = document.createElement('div');
    subtitle.className = 'prompt-subtitle';
    subtitle.textContent = 'Enter 确认，Esc 取消';
    header.appendChild(subtitle);

    dialog.appendChild(header);

    const body = document.createElement('div');
    body.className = 'prompt-body';

    const input = document.createElement('input');
    input.className = 'prompt-input';
    input.placeholder = placeholder ?? '';
    input.value = initialValue;
    input.spellcheck = false;
    body.appendChild(input);

    const hint = document.createElement('div');
    hint.className = 'prompt-hint';
    hint.textContent = placeholder ?? '输入内容后按 Enter 提交';
    body.appendChild(hint);

    dialog.appendChild(body);

    const buttons = document.createElement('div');
    buttons.className = 'prompt-buttons';

    const cancelBtn = document.createElement('button');
    cancelBtn.className = 'prompt-btn prompt-btn-cancel';
    cancelBtn.textContent = '取消';

    const confirmBtn = document.createElement('button');
    confirmBtn.className = 'prompt-btn prompt-btn-confirm';
    confirmBtn.textContent = '确定';

    buttons.appendChild(cancelBtn);
    buttons.appendChild(confirmBtn);
    dialog.appendChild(buttons);
    overlay.appendChild(dialog);
    document.body.appendChild(overlay);

    input.focus();
    input.setSelectionRange(input.value.length, input.value.length);

    const cleanup = (value: string | null) => {
      overlay.remove();
      resolve(value);
    };

    confirmBtn.onclick = () => cleanup(input.value || null);
    cancelBtn.onclick = () => cleanup(null);
    overlay.onclick = (event) => {
      if (event.target === overlay) cleanup(null);
    };
    input.onkeydown = (event) => {
      if (event.key === 'Enter') cleanup(input.value || null);
      if (event.key === 'Escape') cleanup(null);
    };
  });
}
