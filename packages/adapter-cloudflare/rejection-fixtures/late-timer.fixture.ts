import { it } from 'vitest';

// The file's last test leaves a rejection due on the next turn, after its own afterEach.
it('leaves a rejection due on the next turn', () => {
  setTimeout(() => void Promise.reject(new Error('late-timer: raised after the last test')), 0);
});
