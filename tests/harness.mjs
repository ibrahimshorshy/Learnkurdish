/** A tiny pass/fail counter shared by the test files. */
let passed = 0;
let failed = 0;

export function check(name, condition, detail) {
  if (condition) {
    passed++;
    console.log(`PASS  ${name}`);
  } else {
    failed++;
    console.log(`FAIL  ${name}${detail ? `  ${detail}` : ""}`);
  }
}

export function near(a, b, tolerance) {
  return Math.abs(a - b) <= tolerance;
}

export function done(label) {
  console.log(`\n${label}: ${passed} passed, ${failed} failed\n`);
  if (failed) process.exit(1);
}
