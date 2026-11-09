'use strict';

const fs = require('node:fs');
const path = require('node:path');

const repositoryRoot = path.resolve(__dirname, '..');
const sourcePath = path.join(repositoryRoot, 'website', 'index.html');
const outputDirectory = path.join(repositoryRoot, '.vercel-static');
const outputPath = path.join(outputDirectory, 'index.html');

function buildStaticLandingPage() {
  const sourceStat = fs.lstatSync(sourcePath);
  if (!sourceStat.isFile() || sourceStat.isSymbolicLink()) {
    throw new Error('The ORIENT landing-page source must be a regular file.');
  }

  const source = fs.readFileSync(sourcePath);
  fs.rmSync(outputDirectory, { recursive: true, force: true });
  fs.mkdirSync(outputDirectory, { recursive: true });
  fs.writeFileSync(outputPath, source, { flag: 'wx' });

  const outputStat = fs.statSync(outputPath);
  const output = fs.readFileSync(outputPath);
  if (outputStat.size !== sourceStat.size || !source.equals(output)) {
    throw new Error('The generated ORIENT landing page does not match its source.');
  }

  process.stdout.write('Prepared ORIENT static landing page (' + outputStat.size + ' bytes).\\n');
}

buildStaticLandingPage();
