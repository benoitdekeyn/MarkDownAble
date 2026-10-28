const forceColor = process.env.FORCE_COLOR && process.env.FORCE_COLOR !== '0';
const enabled = process.env.NO_COLOR === undefined && (Boolean(forceColor) || process.stdout.isTTY);

const paint = (code, value) => enabled ? `\u001b[${code}m${value}\u001b[0m` : value;

async function withSpinner(message, task) {
  if (!process.stdout.isTTY) return task();

  const frames = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
  let frame = 0;
  const render = () => {
    const width = Math.max(1, (process.stdout.columns || 80) - 4);
    const label = [...message].slice(0, width).join('');
    process.stdout.write(`\r\u001b[2K${paint('36', frames[frame++ % frames.length])} ${label}`);
  };

  render();
  const timer = setInterval(render, 100);
  try {
    return await task();
  } finally {
    clearInterval(timer);
    process.stdout.write('\r\u001b[2K');
  }
}

export const log = {
  success: (message) => console.log(paint('32', `✓ ${message}`)),
  info: (message) => console.log(paint('36', message)),
  warning: (message) => console.log(paint('33', `⚠ ${message}`)),
  error: (message) => console.error(paint('31', `✖ ${message}`)),
  muted: (message) => console.log(paint('90', message)),
  withSpinner,
};
