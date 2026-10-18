module.exports = require('@backstage/cli/config/eslint-factory')(__dirname, {
  rules: {
    // Rendering and mapping code branches explicitly on several states (unavailable /
    // stale / ok …); nested conditional expressions are used deliberately for that.
    'no-nested-ternary': 'off',
  },
});
