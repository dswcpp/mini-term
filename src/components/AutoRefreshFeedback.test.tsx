import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { AutoRefreshFeedbackBadge, AutoRefreshFeedbackBar } from './AutoRefreshFeedback';

describe('AutoRefreshFeedback', () => {
  it('renders nothing when feedback is null', () => {
    const { container } = render(<AutoRefreshFeedbackBar feedback={null} />);
    expect(container.textContent).toBe('');
  });

  it('renders badge and bar with the provided message', () => {
    render(
      <div>
        <AutoRefreshFeedbackBadge
          feedback={{ tone: 'refresh-success', message: '已自动刷新' }}
          testId="feedback-badge"
        />
        <AutoRefreshFeedbackBar
          feedback={{ tone: 'refresh-error', message: '自动刷新失败' }}
          testId="feedback-bar"
        />
      </div>,
    );

    expect(screen.getByTestId('feedback-badge').textContent).toContain('已自动刷新');
    expect(screen.getByTestId('feedback-bar').textContent).toContain('自动刷新失败');
  });
});
