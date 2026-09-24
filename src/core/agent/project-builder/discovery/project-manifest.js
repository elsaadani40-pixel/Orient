const MANIFESTS = [
  ['package.json', 'node'],
  ['tsconfig.json', 'typescript'],
  ['requirements.txt', 'python'],
  ['pyproject.toml', 'python'],
  ['pom.xml', 'java'],
  ['build.gradle', 'android-or-gradle'],
  ['build.gradle.kts', 'android-or-gradle'],
  ['settings.gradle', 'android-or-gradle'],
  ['settings.gradle.kts', 'android-or-gradle'],
  ['AndroidManifest.xml', 'android']
];

function detectManifest(names) {
  const found =
    MANIFESTS.filter(
      ([file]) => names.includes(file)
    );

  const stack =
    [...new Set(
      found.map(([, type]) => type)
    )];

  return {
    files:
      found.map(([file]) => file),

    stack,

    primary:
      stack[0] || 'generic'
  };
}

module.exports = {
  MANIFESTS,
  detectManifest
};
