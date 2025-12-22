#!/usr/bin/env node

import { createInterface } from 'readline';
import { readFileSync, writeFileSync } from 'fs';
import { execSync } from 'child_process';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const rl = createInterface({
  input: process.stdin,
  output: process.stdout,
});

const question = (prompt) => new Promise((resolve) => rl.question(prompt, resolve));

const packagePath = join(__dirname, 'package.json');

function readPackageJson() {
  return JSON.parse(readFileSync(packagePath, 'utf8'));
}

function writePackageJson(pkg) {
  writeFileSync(packagePath, JSON.stringify(pkg, null, 2) + '\n');
}

function parseVersion(version) {
  const [major, minor, patch] = version.split('.').map(Number);
  return { major, minor, patch };
}

function formatVersion({ major, minor, patch }) {
  return `${major}.${minor}.${patch}`;
}

function bumpVersion(version, type) {
  const v = parseVersion(version);
  switch (type) {
    case 'patch':
      return formatVersion({ ...v, patch: v.patch + 1 });
    case 'minor':
      return formatVersion({ ...v, minor: v.minor + 1, patch: 0 });
    case 'major':
      return formatVersion({ major: v.major + 1, minor: 0, patch: 0 });
    default:
      return version;
  }
}

function exec(cmd, options = {}) {
  try {
    return execSync(cmd, {
      encoding: 'utf8',
      stdio: options.silent ? 'pipe' : 'inherit',
      ...options,
    });
  } catch (_error) {
    if (!options.ignoreError) {
      console.error(`\n✗ Command failed: ${cmd}`);
      process.exit(1);
    }
    return null;
  }
}

async function main() {
  const pkg = readPackageJson();
  const currentVersion = pkg.version;

  console.log(`\nCurrent version: ${currentVersion}\n`);

  const patchVersion = bumpVersion(currentVersion, 'patch');
  const minorVersion = bumpVersion(currentVersion, 'minor');
  const majorVersion = bumpVersion(currentVersion, 'major');

  console.log('How do you want to bump the version?');
  console.log(`  1. patch (${patchVersion})`);
  console.log(`  2. minor (${minorVersion})`);
  console.log(`  3. major (${majorVersion})`);
  console.log('  4. custom\n');

  const choice = await question('Select [1-4]: ');

  let newVersion;
  switch (choice.trim()) {
    case '1':
      newVersion = patchVersion;
      break;
    case '2':
      newVersion = minorVersion;
      break;
    case '3':
      newVersion = majorVersion;
      break;
    case '4':
      newVersion = await question('Enter custom version (x.y.z): ');
      if (!/^\d+\.\d+\.\d+$/.test(newVersion.trim())) {
        console.error('✗ Invalid version format. Use x.y.z');
        rl.close();
        process.exit(1);
      }
      newVersion = newVersion.trim();
      break;
    default:
      console.error('✗ Invalid choice');
      rl.close();
      process.exit(1);
  }

  console.log(`\nNew version: ${newVersion}\n`);

  const defaultTitle = `Release v${newVersion}`;
  const titleInput = await question(`Commit title (Enter for "${defaultTitle}"): `);
  const title = titleInput.trim() || defaultTitle;

  const description = await question('Commit description (Enter to skip): ');

  // Update package.json
  pkg.version = newVersion;
  writePackageJson(pkg);
  console.log(`\n✓ Updated package.json to ${newVersion}`);

  // Publish to npm (--access=public required for scoped packages)
  console.log('\nPublishing to npm...');
  exec('npm publish --access=public');
  console.log('✓ Published to npm');

  // Git operations
  exec('git add package.json');

  const commitMessage = description.trim() ? `${title}\n\n${description.trim()}` : title;

  exec(`git commit -m "${commitMessage.replace(/"/g, '\\"')}"`);
  console.log(`✓ Created commit: ${title}`);

  exec(`git tag v${newVersion}`);
  console.log(`✓ Created tag: v${newVersion}`);

  exec('git push');
  exec('git push --tags');
  console.log('✓ Pushed to origin');

  console.log(`\n🎉 Released v${newVersion}\n`);

  rl.close();
}

main().catch((error) => {
  console.error('Release failed:', error.message);
  rl.close();
  process.exit(1);
});
