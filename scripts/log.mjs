const forceColor = process.env.FORCE_COLOR && process.env.FORCE_COLOR !== '0';
const enabled = process.env.NO_COLOR === undefined && (Boolean(forceColor) || process.stdout.isTTY);

const paint = (code, value) => enabled ? `\u001b[${code}m${value}\u001b[0m` : value;

export const log = {
  success: (message) => console.log(paint('32', `✓ ${message}`)),
  info: (message) => console.log(paint('36', message)),
  warning: (message) => console.log(paint('33', `⚠ ${message}`)),
  error: (message) => console.error(paint('31', `✖ ${message}`)),
  muted: (message) => console.log(paint('90', message)),
};
