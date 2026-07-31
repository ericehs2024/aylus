#!/usr/bin/env node

const { execSync } = require('child_process');
const archiverLib = require('archiver');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const backendDir = path.join(root, 'backend');
const frontendDist = path.join(__dirname, 'dist');
const backendDist = path.join(backendDir, 'dist');
const zipPath = path.join(root, 'deploy.zip');

// Step 1: Build frontend
console.log('[build] Building frontend...');
execSync('vite build', { stdio: 'inherit' });

// Step 2: Copy frontend dist to backend dist
console.log('[build] Copying frontend dist to backend/dist...');
if (!fs.existsSync(backendDist)) fs.mkdirSync(backendDist, { recursive: true });

function copyDirSync(src, dest) {
  if (!fs.existsSync(src)) return;
  if (!fs.existsSync(dest)) fs.mkdirSync(dest, { recursive: true });
  fs.readdirSync(src).forEach(file => {
    const srcPath = path.join(src, file);
    const destPath = path.join(dest, file);
    if (fs.statSync(srcPath).isDirectory()) {
      copyDirSync(srcPath, destPath);
    } else {
      fs.copyFileSync(srcPath, destPath);
    }
  });
}

copyDirSync(frontendDist, backendDist);

// Step 3: Create deploy.zip
console.log('[build] Creating deploy.zip...');
const out = fs.createWriteStream(zipPath);
const a = new archiverLib.ZipArchive();

out.on('close', () => {
  console.log(`[build] deploy.zip created: ${a.pointer()} bytes`);
});

a.on('error', (err) => {
  console.error('[build] Zip error:', err);
});

a.pipe(out);
a.glob('**/*', { cwd: backendDir, ignore: ['node_modules/**', 'test-playwright.js', '**/*.map'], dot: true });

// Add .env template if it exists
const envPath = path.join(backendDir, '.env');
if (fs.existsSync(envPath)) {
  a.file('.env', { src: fs.createReadStream(envPath) });
} else {
  console.log('[build] No .env found, skipping');
}

a.finalize();
