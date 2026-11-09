// Builds the installer and publishes it to server/updates so every client can update in-app.
//   node scripts/publish-update.js [version] ["release notes"]
// - PelakaVoice 2.x clients read latest.yml (background download + silent install).
// - PelakaVoice 1.0.x clients read version.json through /api/check-update.
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const readline = require('readline');

const root = path.join(__dirname, '..');
const pkgPath = path.join(root, 'package.json');
const distDir = path.join(root, 'dist');
const updatesDir = path.join(root, 'server', 'updates');

function ask(question) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise(resolve => rl.question(question, answer => { rl.close(); resolve(answer.trim()); }));
}

(async () => {
  const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
  console.log(`\nPelakaVoice update publisher — current version ${pkg.version}\n`);

  let version = process.argv[2];
  let notes = process.argv[3];
  if (version === undefined) version = (await ask(`New version [Enter = keep ${pkg.version}]: `)) || pkg.version;
  if (notes === undefined) notes = await ask('Release notes: ');
  notes = notes || 'Improvements and bug fixes.';
  if (!/^\d+\.\d+\.\d+$/.test(version)) { console.error('Version must look like 2.0.1'); process.exit(1); }

  if (version !== pkg.version) {
    pkg.version = version;
    fs.writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + '\n');
  }

  console.log(`[1/3] Building installer ${version}...`);
  execSync('npm run build', { stdio: 'inherit', cwd: root });

  const exe = `PelakaVoice-Setup-${version}.exe`;
  for (const f of [exe, 'latest.yml']) {
    if (!fs.existsSync(path.join(distDir, f))) { console.error(`Build output missing: dist/${f}`); process.exit(1); }
  }

  console.log('[2/3] Copying files to server/updates...');
  fs.mkdirSync(updatesDir, { recursive: true });
  for (const f of fs.readdirSync(updatesDir)) {
    if (/\.(exe|blockmap|yml)$/i.test(f)) fs.rmSync(path.join(updatesDir, f)); // previous release payload
  }
  fs.copyFileSync(path.join(distDir, exe), path.join(updatesDir, exe));
  if (fs.existsSync(path.join(distDir, exe + '.blockmap'))) {
    fs.copyFileSync(path.join(distDir, exe + '.blockmap'), path.join(updatesDir, exe + '.blockmap'));
  }
  const yml = fs.readFileSync(path.join(distDir, 'latest.yml'), 'utf8').replace(/^releaseNotes:.*\n?/m, '').trimEnd();
  fs.writeFileSync(path.join(updatesDir, 'latest.yml'), `${yml}\nreleaseNotes: ${JSON.stringify(notes)}\n`);

  console.log('[3/3] Writing version.json (used by 1.0.x clients)...');
  fs.writeFileSync(path.join(updatesDir, 'version.json'), JSON.stringify({
    version, releaseNotes: notes, fileName: exe, updatedAt: new Date().toISOString()
  }, null, 2));

  // The server hosted from inside the app reads %APPDATA%\PelakaVoice\updates: keep it in sync
  if (process.env.APPDATA) {
    const appDir = path.join(process.env.APPDATA, 'PelakaVoice', 'updates');
    try {
      fs.mkdirSync(appDir, { recursive: true });
      for (const f of fs.readdirSync(appDir)) fs.rmSync(path.join(appDir, f), { force: true });
      for (const f of fs.readdirSync(updatesDir)) fs.copyFileSync(path.join(updatesDir, f), path.join(appDir, f));
      console.log('[OK] Also copied to ' + appDir + ' (used when you host from inside the app)');
    } catch (e) {
      console.warn('[WARN] Could not copy to ' + appDir + ': ' + e.message);
    }
  }

  const mb = (fs.statSync(path.join(updatesDir, exe)).size / 1048576).toFixed(1);
  console.log(`\nDone: PelakaVoice ${version} published (${mb} MB).`);
  console.log('Start AVVIA-SERVER-ONLINE.bat: everyone who connects will get the update.\n');
})().catch(err => { console.error(err.message); process.exit(1); });
